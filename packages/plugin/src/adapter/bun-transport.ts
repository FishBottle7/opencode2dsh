import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'

type Fetch = typeof globalThis.fetch

export interface BunTransportConfig {
  enabled?: boolean
  /** Existing Bun executable; this feature never downloads a runtime. */
  bunPath?: string
  clientVersion?: string
}

export interface BunTransportOptions extends BunTransportConfig {
  /** Internal seams for lifecycle tests and the host's live proxy-pool state. */
  workerPath?: string
  isPoolEnabled?: () => boolean
  headerTimeoutMs?: number
  bodyIdleMs?: number
  responsesBodyIdleMs?: number
}

const paths = new Set([
  '/inference/v1/chat/completions', '/zen/v1/chat/completions',
  '/inference/openai/v1/chat/completions', '/inference/v1/responses',
  '/zen/v1/responses', '/inference/openai/v1/responses',
])

export function inferenceURL(input: string): URL | undefined {
  try {
    const url = new URL(input)
    if (url.origin !== 'https://opencode.ai' || url.username || url.password || url.search || url.hash || !paths.has(url.pathname)) return
    if (url.pathname === '/inference/v1/chat/completions' || url.pathname === '/zen/v1/chat/completions') {
      url.pathname = '/inference/openai/v1/chat/completions'
    }
    return url
  } catch { return }
}

/** Copy on the wire only: do not mutate the host's system, history, tools or choices. */
export function environmentPayload(body: string, platform = process.platform): string {
  const payload = JSON.parse(body) as Record<string, unknown>
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected a JSON request object')
  const environment = `<env>\n  Working directory: .\n  Platform: ${platform}\n</env>`
  if (Array.isArray(payload.messages)) {
    const messages = payload.messages as Array<{ role: string; content: unknown }>
    const system = messages.filter(message => message.role === 'system' || message.role === 'developer')
    const text = system.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    if (!/<env>[\s\S]*?<\/env>/.test(text)) {
      const existing = messages.find(message => message.role === 'system' && typeof message.content === 'string')
      if (existing) existing.content += `\n\nProtocol environment metadata; resolve relative paths using the host workspace instructions:\n${environment}`
      else messages.unshift({ role: 'system', content: environment })
    }
  } else if (Array.isArray(payload.input)) {
    if (payload.instructions !== undefined && typeof payload.instructions !== 'string') throw new Error('Expected text instructions')
    const instructions = payload.instructions as string | undefined
    if (!/<env>[\s\S]*?<\/env>/.test(instructions ?? '')) payload.instructions = `${instructions ? instructions + '\n\n' : ''}${environment}`
  } else throw new Error('Expected chat messages or Responses input')
  return JSON.stringify(payload)
}

// The shared pi-ai/OpenAI SDK has no per-provider fetch seam. Only SDK calls
// started inside wrapApi inherit this context; concurrent providers stay on
// the captured fetch. Reference-counted disposal restores it when possible.
const scoped = new AsyncLocalStorage<Fetch>()
let users = 0
let original: Fetch | undefined
let installed: Fetch | undefined

function acquireFetch(): () => void {
  if (users++ === 0) {
    const previous = globalThis.fetch
    original = previous
    installed = (input, init) => {
      const selected = scoped.getStore()
      const url = String(input instanceof Request ? input.url : input)
      return selected && inferenceURL(url) ? selected(input, init) : previous(input, init)
    }
    globalThis.fetch = installed
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--users === 0 && original && globalThis.fetch === installed) globalThis.fetch = original
  }
}

export class BunTransport {
  readonly #options: BunTransportOptions
  readonly #release: () => void
  readonly #active = new Map<ChildProcessWithoutNullStreams, (error: Error) => void>()
  #disposed = false

  constructor(options: BunTransportOptions = {}) {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.clientVersion ?? '2.2.0')) throw new Error('Invalid bunTransport.clientVersion')
    this.#options = options
    this.#release = acquireFetch()
  }

  get activeRequests(): number { return this.#active.size }

  wrapApi<T extends object>(api: T): T {
    const wrapped = { ...api }
    for (const name of ['stream', 'streamSimple']) {
      const fn = Reflect.get(api, name) as unknown
      if (typeof fn === 'function') Reflect.set(wrapped, name, (...args: unknown[]) => scoped.run(this.fetch, () => Reflect.apply(fn, api, args)))
    }
    return wrapped
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const stop of [...this.#active.values()]) stop(new Error('OpenCode Bun transport disposed'))
    this.#release()
  }

  readonly fetch: Fetch = async (input, init) => {
    if (this.#disposed) throw new Error('OpenCode Bun transport is disposed')
    if (this.#options.isPoolEnabled?.()) throw new Error('bunTransport requires ipPool.enabled=false; Bun cannot use the Node proxy dispatcher')
    const request = new Request(input, init)
    const destination = inferenceURL(request.url)
    if (!destination || request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer public') {
      throw new Error('Bun transport accepts only anonymous OpenCode inference POSTs')
    }
    request.signal.throwIfAborted()
    const headers = new Headers(request.headers)
    headers.set('user-agent', `opencode/latest/${this.#options.clientVersion ?? '2.2.0'}/cli`)
    const names: string[] = []
    headers.forEach((_value, name) => names.push(name))
    for (const key of names) if (key.startsWith('x-stainless-') || ['cookie', 'host', 'content-length', 'connection'].includes(key)) headers.delete(key)
    const body = environmentPayload(await request.text())
    request.signal.throwIfAborted()
    if (this.#disposed) throw new Error('OpenCode Bun transport is disposed')
    const child = spawn(this.#options.bunPath?.trim() || 'bun', [this.#options.workerPath ?? fileURLToPath(new URL('./bun-worker.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    // No payload, credentials or child stderr is logged or persisted.
    child.stderr.resume()
    child.stdin.on('error', () => {})
    let terminal: unknown
    let cleaned = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      this.#active.delete(child)
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
    const stop = (error: unknown) => { terminal = error; cleanup() }
    const onAbort = () => stop(request.signal.reason)
    const arm = (ms: number, phase: string) => {
      if (cleaned) return
      clearTimeout(timer)
      timer = setTimeout(() => stop(new Error(`OpenCode Bun transport ${phase} timeout`)), ms)
      timer.unref()
    }
    const exited = new Promise<number | null>(resolve => {
      child.once('exit', code => resolve(code))
      child.once('error', () => resolve(-1))
    })
    this.#active.set(child, stop)
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    arm(this.#options.headerTimeoutMs ?? 30_000, 'response-header')
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      if (terminal) { child.kill(); throw terminal }
      const pairs: Array<[string, string]> = []
      headers.forEach((value, name) => pairs.push([name, value]))
      child.stdin.end(JSON.stringify({ url: destination.href, headers: pairs, body }))
      const iterator = child.stdout[Symbol.asyncIterator]()
      let pending = Buffer.alloc(0)
      let metadata: { status: number; statusText?: string; headers: [string, string][]; error?: string } | undefined
      while (!metadata) {
        const next = await iterator.next()
        if (terminal) throw terminal
        if (next.done) throw new Error(`Bun transport ended before response headers (exit ${await exited}); check bunTransport.bunPath`)
        pending = Buffer.concat([pending, next.value as Buffer])
        const newline = pending.indexOf(10)
        if (newline >= 0) {
          if (newline > 65_536) throw new Error('Bun transport response headers are too large')
          metadata = JSON.parse(pending.subarray(0, newline).toString('utf8')) as typeof metadata
          pending = pending.subarray(newline + 1)
        } else if (pending.length > 65_536) throw new Error('Invalid Bun transport response headers')
      }
      if (metadata.error) throw new Error(metadata.error)
      if (!Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 599) throw new Error('Invalid Bun transport response status')
      const idle = destination.pathname.endsWith('/responses') ? Math.max(this.#options.bodyIdleMs ?? 120_000, this.#options.responsesBodyIdleMs ?? 300_000) : this.#options.bodyIdleMs ?? 120_000
      arm(idle, 'body-idle')
      const stream = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            if (terminal) throw terminal
            if (pending.length) { controller.enqueue(new Uint8Array(pending)); pending = Buffer.alloc(0); arm(idle, 'body-idle'); return }
            const next = await iterator.next()
            if (terminal) throw terminal
            if (next.done) {
              const code = await exited
              if (code !== 0) throw new Error(`Bun transport ended unexpectedly (exit ${code})`)
              controller.close(); cleanup()
            } else { controller.enqueue(new Uint8Array(next.value)); arm(idle, 'body-idle') }
          } catch (error) { controller.error(error); cleanup() }
        },
        cancel: () => cleanup(),
      })
      return new Response(stream, { status: metadata.status, statusText: metadata.statusText, headers: metadata.headers })
    } catch (error) { cleanup(); throw error }
  }
}
