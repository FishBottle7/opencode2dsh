/**
 * PoolRoutingDispatcher — the undici global-dispatcher layer for the exit
 * pool (docs/ip-pool.md section 2).
 *
 * Shape copied from dsh-llm-proxy's RoutingDispatcher (verified there
 * against the same host); selection logic differs: instead of a static
 * host set, every request consults ExitPool.pick() (pinned-first, session
 * stickiness, rotation over two-tier health).
 *
 * One routing decision per request, synchronous and IO-free (pick is pure).
 * Failures are NOT retried here — the 429/403 rotation loop (3.4) is the
 * pi-ai-callable layer's job; this dispatcher only routes. It implements
 * the undici Dispatcher subset `fetch` uses (dispatch/close/destroy),
 * same contract dsh-llm-proxy validated.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { Agent, ProxyAgent, type Dispatcher } from 'undici'

import type { ExitPool } from './pool.ts'

/** Structural seam over npm undici so tests can inject fakes. */
export interface UndiciSeam {
  Agent: typeof Agent
  ProxyAgent: typeof ProxyAgent
  setGlobalDispatcher(dispatcher: Dispatcher): unknown
  getGlobalDispatcher(): Dispatcher
}

export interface RoutingContext {
  /** Model id for the in-flight call (two-tier health needs it, 3.3). */
  model?: string
  /** Inbound session id (stickiness key, 3.3). */
  session?: string
}

/** Per-request routing context (docs/ip-pool.md 3.3): pi-ai builds the body
 *  and dispatches on separate layers with no model channel between them, so
 *  the adapter sets this at stream() entry and the dispatcher reads it. */
export const routingContext = new AsyncLocalStorage<RoutingContext>()

export interface PoolRoutingOptions {
  pool: ExitPool
  undici: UndiciSeam
  /** Hosts whose traffic goes through the pool; everything else is direct. */
  proxyHosts?: string[]
  /** Per-exit ProxyAgent cache LRU cap (connection setup is lazy). */
  agentLruCap?: number
  /** Log sink for routing decisions (diagnostics). */
  logger?: { warn(message: string): void }
}

const DEFAULT_PROXY_HOSTS = ['opencode.ai']
const PROXY_PROTOCOL_PREFIX = /^[a-z0-9+.-]+:\/\//i

/** 'host:port' -> 'host' (bracket-aware) for host matching. */
export function normalizeHost(host: string): string {
  if (!host) return ''
  let value = host.trim().toLowerCase()
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname
    } catch {
      /* fall through to the regex strip */
    }
  }
  return value.replace(/:\d+$/, '').replace(/^\[(.+)\]$/, '$1')
}

export function isLoopback(host: string): boolean {
  const normalized = normalizeHost(host)
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

/** Map an exit address to a ProxyAgent URI ('h:1' -> 'http://h:1'). */
export function exitProxyUri(exitId: string, protocol: 'http' | 'socks5'): string {
  const scheme = protocol === 'socks5' ? 'socks5' : 'http'
  return PROXY_PROTOCOL_PREFIX.test(exitId) ? exitId : `${scheme}://${exitId}`
}

/**
 * The undici Dispatcher surface `fetch` actually calls (the subset
 * dsh-llm-proxy's RoutingDispatcher implements — full `Dispatcher` carries
 * 20+ stream helpers we never hit through fetch).
 */
export interface RoutingDispatcherSurface {
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean
  close(): Promise<void>
  destroy(): Promise<void>
}

export class PoolRoutingDispatcher implements RoutingDispatcherSurface {
  #pool: ExitPool
  #undici: UndiciSeam
  #proxyHosts: Set<string>
  #agentLruCap: number
  #logger?: { warn(message: string): void }
  /** Direct path for non-pool hosts and loopback. */
  #direct: Dispatcher
  /** LRU of per-exit ProxyAgents (docs/ip-pool.md 2, exit multi-instance). */
  #agents = new Map<string, Dispatcher>()
  #agentsOrder: string[] = []
  #closed = false

  constructor(options: PoolRoutingOptions) {
    this.#pool = options.pool
    this.#undici = options.undici
    this.#proxyHosts = new Set(
      (options.proxyHosts ?? DEFAULT_PROXY_HOSTS).map((host) => normalizeHost(host)),
    )
    this.#agentLruCap = options.agentLruCap ?? 16
    this.#logger = options.logger
    this.#direct = new options.undici.Agent()
  }

  /** Live re-apply of the proxied-host list (settings page, docs §5.1). */
  setProxyHosts(hosts: string[] | undefined): void {
    const next = hosts && hosts.length > 0
      ? new Set(hosts.map((host) => normalizeHost(host)))
      : new Set(DEFAULT_PROXY_HOSTS.map((host) => normalizeHost(host)))
    this.#proxyHosts = next
  }

  /** The proxied-host set as configured (diagnostics / status bridge). */
  get proxyHosts(): readonly string[] {
    return [...this.#proxyHosts]
  }

  /** The agent for one exit, LRU-capped (docs/ip-pool.md 2). */
  #agentFor(exitId: string): Dispatcher | null {
    const cached = this.#agents.get(exitId)
    if (cached) {
      const index = this.#agentsOrder.indexOf(exitId)
      if (index >= 0) this.#agentsOrder.splice(index, 1)
      this.#agentsOrder.push(exitId)
      return cached
    }
    const exit = this.#pool.get(exitId)
    if (!exit) return null
    try {
      // dsh-llm-proxy's measured keep-alive pitfall (routing-dispatcher.js):
      // the ProxyAgent's proxy-side pool reuses silently-dead CONNECT
      // tunnels; pipelining: 0 forces a fresh tunnel per request.
      const seam = this.#undici
      const agent = new seam.ProxyAgent({
        uri: exitProxyUri(exit.id, exit.protocol),
        clientFactory: (origin: URL | string, opts?: unknown) =>
          new seam.Agent({ ...(opts as object), pipelining: 0 }),
      })
      this.#agents.set(exitId, agent)
      this.#agentsOrder.push(exitId)
      if (this.#agentsOrder.length > this.#agentLruCap) {
        const evict = this.#agentsOrder.shift()
        if (evict !== undefined) {
          const old = this.#agents.get(evict)
          this.#agents.delete(evict)
          void old?.destroy().catch(() => {})
        }
      }
      return agent
    } catch (err) {
      this.#logger?.warn(`opencode2dsh: failed to build proxy agent for ${exitId}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (this.#closed) {
      handler.onResponseError?.({} as Dispatcher.DispatchController, new Error('opencode2dsh: routing dispatcher closed'))
      return false
    }
    const origin = String(options.origin ?? '')
    const host = normalizeHost(origin)
    let next: Dispatcher
    if (isLoopback(host) || !this.#proxyHosts.has(host)) {
      next = this.#direct
    } else {
      const context = routingContext.getStore() ?? {}
      const model = context.model ?? 'default'
      const session = context.session ?? 'default'
      const exitId = this.#pool.pick(session, model)
      if (exitId === null) {
        // Pool unusable (empty / all cooling): direct, never fail closed (3.3).
        next = this.#direct
      } else {
        const agent = this.#agentFor(exitId)
        next = agent ?? this.#direct
      }
    }
    return next.dispatch(options, handler)
  }

  close(): Promise<void> {
    this.#closed = true
    const jobs = [this.#direct.close(), ...[...this.#agents.values()].map((a) => a.close())]
    return Promise.all(jobs).then(() => undefined)
  }

  destroy(): Promise<void> {
    this.#closed = true
    const jobs = [this.#direct.destroy(), ...[...this.#agents.values()].map((a) => a.destroy())]
    this.#agents.clear()
    this.#agentsOrder = []
    return Promise.all(jobs).then(() => undefined)
  }
}
