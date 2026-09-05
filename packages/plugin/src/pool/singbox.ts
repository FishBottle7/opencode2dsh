/**
 * sing-box child-process supervision — the TS port of GoProxy
 * custom/singbox.go (docs/ip-pool.md 1.2.2). The one external binary this
 * plugin will ever spawn, and only when the user's subscriptions carry
 * encrypted nodes:
 *
 *   ParsedNode[] -> config JSON (one local SOCKS5 inbound per node, port
 *   30000+ ascending) -> `sing-box check` preflight -> `sing-box run` ->
 *   port-readiness wait. The converted nodes return as local http-address
 *   exits and join the pool through the trusted admission path.
 *
 * Process supervision: interrupt -> 5s grace -> kill (Windows: taskkill /T
 * since signals are not deliverable), exit-watch so crashes surface, and
 * the caller (subscription layer) drives Reload on every refresh — a new
 * node list regenerates the config and restarts the process, same as
 * GoProxy's Reload.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ParsedNode } from './subscription.ts'

export interface SingBoxOptions {
  /** sing-box binary: PATH name or absolute path. */
  binPath: string
  /** Directory for config + working dir. */
  dataDir: string
  /** First local SOCKS5 port (default 30000, ascending per node). */
  basePort?: number
  /** Port-readiness wait (default 10s). */
  readyTimeoutMs?: number
  logger?: { info(message: string): void; warn(message: string): void }
}

export interface ConvertedExit {
  /** Local dial address: 127.0.0.1:<port>. */
  address: string
  protocol: 'socks5'
  /** The source node this exit serves (diagnostics + dedupe key). */
  node: ParsedNode
}

// -- outbound mapping (GoProxy buildOutbound, verbatim semantics) ----------

const getStr = (raw: Record<string, unknown>, key: string): string => {
  const value = raw[key]
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}
const getStrDefault = (raw: Record<string, unknown>, key: string, fallback: string): string => {
  const value = getStr(raw, key)
  return value !== '' ? value : fallback
}
const getInt = (raw: Record<string, unknown>, key: string): number => {
  const value = Number(raw[key])
  return Number.isFinite(value) ? value : 0
}
const getBool = (raw: Record<string, unknown>, key: string): boolean => raw[key] === true

function applyTLS(raw: Record<string, unknown>, out: Record<string, unknown>): void {
  const hasTLS =
    getBool(raw, 'tls') ||
    getStr(raw, 'sni') !== '' ||
    getStr(raw, 'client-fingerprint') !== '' ||
    // reality implies TLS even without an explicit sni (vless reality nodes
    // sometimes carry only reality-opts)
    (raw['reality-opts'] !== undefined && typeof raw['reality-opts'] === 'object')
  if (!hasTLS) return
  const tls: Record<string, unknown> = { enabled: true }
  const sni = getStr(raw, 'sni') || getStr(raw, 'servername')
  if (sni !== '') tls.server_name = sni
  if (getBool(raw, 'skip-cert-verify')) tls.insecure = true
  const alpn = raw.alpn
  if (Array.isArray(alpn)) {
    const list = alpn.filter((entry): entry is string => typeof entry === 'string')
    if (list.length > 0) tls.alpn = list
  }
  const fingerprint = getStr(raw, 'client-fingerprint')
  if (fingerprint !== '') tls.utls = { enabled: true, fingerprint }
  const reality = raw['reality-opts']
  if (reality && typeof reality === 'object') {
    const opts = reality as Record<string, unknown>
    tls.reality = {
      enabled: true,
      public_key: getStr(opts, 'public-key'),
      short_id: getStr(opts, 'short-id'),
    }
  }
  out.tls = tls
}

function applyTransport(raw: Record<string, unknown>, out: Record<string, unknown>): void {
  const network = getStrDefault(raw, 'network', 'tcp')
  if (network === 'ws') {
    const transport: Record<string, unknown> = { type: 'ws' }
    const opts = raw['ws-opts']
    if (opts && typeof opts === 'object') {
      const ws = opts as Record<string, unknown>
      const path = getStr(ws, 'path')
      if (path !== '') transport.path = path
      const headers = ws.headers
      if (headers && typeof headers === 'object') transport.headers = headers
    }
    out.transport = transport
  } else if (network === 'grpc') {
    const transport: Record<string, unknown> = { type: 'grpc' }
    const opts = raw['grpc-opts']
    if (opts && typeof opts === 'object') {
      const sn = getStr(opts as Record<string, unknown>, 'grpc-service-name')
      if (sn !== '') transport.service_name = sn
    }
    out.transport = transport
  } else if (network === 'h2') {
    const transport: Record<string, unknown> = { type: 'http' }
    const opts = raw['h2-opts']
    if (opts && typeof opts === 'object') {
      const h2 = opts as Record<string, unknown>
      const path = getStr(h2, 'path')
      if (path !== '') transport.path = path
      const host = h2.host
      if (Array.isArray(host) && typeof host[0] === 'string') transport.host = [host[0]]
    }
    out.transport = transport
  } else if (network === 'httpupgrade') {
    const transport: Record<string, unknown> = { type: 'httpupgrade' }
    const opts = raw['ws-opts']
    if (opts && typeof opts === 'object') {
      const ws = opts as Record<string, unknown>
      const path = getStr(ws, 'path')
      if (path !== '') transport.path = path
      const headers = ws.headers
      if (headers && typeof headers === 'object') {
        const host = (headers as Record<string, unknown>).Host
        if (typeof host === 'string') transport.host = host
      }
    }
    out.transport = transport
  }
}

/** One ParsedNode -> one sing-box outbound (GoProxy buildOutbound). */
export function buildOutbound(node: ParsedNode, tag: string): Record<string, unknown> | null {
  const raw = node.raw
  const out: Record<string, unknown> = {
    tag,
    server: node.server,
    server_port: node.port, // sing-box uses server_port, not port
  }
  switch (node.type) {
    case 'vmess':
      out.type = 'vmess'
      out.uuid = getStr(raw, 'uuid')
      out.alter_id = getInt(raw, 'alterId')
      out.security = getStrDefault(raw, 'cipher', 'auto')
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'vless':
      out.type = 'vless'
      out.uuid = getStr(raw, 'uuid')
      const flow = getStr(raw, 'flow')
      if (flow !== '') out.flow = flow
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'trojan':
      out.type = 'trojan'
      out.password = getStr(raw, 'password')
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'shadowsocks': {
      out.type = 'shadowsocks'
      out.method = getStr(raw, 'cipher') || getStr(raw, 'method')
      out.password = getStr(raw, 'password')
      const plugin = getStr(raw, 'plugin')
      if (plugin !== '') {
        out.plugin = plugin
        const opts = raw['plugin-opts']
        if (opts && typeof opts === 'object') {
          out.plugin_opts = Object.entries(opts as Record<string, unknown>)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(';')
        }
      }
      break
    }
    case 'hysteria2':
      out.type = 'hysteria2'
      out.password = getStr(raw, 'password')
      applyTLS(raw, out)
      break
    case 'tuic':
      out.type = 'tuic'
      out.uuid = getStr(raw, 'uuid')
      out.password = getStr(raw, 'password')
      out.congestion_control = getStrDefault(raw, 'congestion-controller', 'bbr')
      applyTLS(raw, out)
      break
    case 'anytls':
      out.type = 'anytls'
      out.password = getStr(raw, 'password')
      // anytls is TLS-mandatory (GoProxy forceTLS)
      applyTLS({ ...raw, tls: true }, out)
      break
    default:
      return null
  }
  return out
}

// -- config generation --------------------------------------------------------

export interface GeneratedConfig {
  config: Record<string, unknown>
  /** nodeKey -> local port. */
  portMap: Map<string, number>
}

/** nodeKey (GoProxy): type:server:port. */
export function nodeKeyOf(node: ParsedNode): string {
  return `${node.type}:${node.server}:${node.port}`
}

/** The full sing-box config for a node list (GoProxy generateConfig). */
export function generateConfig(nodes: ParsedNode[], basePort = 30_000): GeneratedConfig {
  const portMap = new Map<string, number>()
  const inbounds: Array<Record<string, unknown>> = []
  const outbounds: Array<Record<string, unknown>> = []
  const rules: Array<Record<string, unknown>> = []
  let port = basePort
  nodes.forEach((node, index) => {
    port += 1
    const tag = `node-${index}`
    portMap.set(nodeKeyOf(node), port)
    inbounds.push({
      type: 'socks',
      tag: `in-${tag}`,
      listen: '127.0.0.1',
      listen_port: port,
    })
    const outbound = buildOutbound(node, `out-${tag}`)
    if (outbound === null) {
      portMap.delete(nodeKeyOf(node))
      inbounds.pop()
      return
    }
    outbounds.push(outbound)
    rules.push({ inbound: [`in-${tag}`], outbound: `out-${tag}` })
  })
  outbounds.push({ type: 'direct', tag: 'direct' })
  return {
    config: {
      log: { level: 'warn' },
      inbounds,
      outbounds,
      route: { rules, final: 'direct' },
    },
    portMap,
  }
}

// -- process supervision -------------------------------------------------------

const STOP_GRACE_MS = 5_000

function canConnect(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export class SingBoxSupervisor {
  readonly #options: SingBoxOptions
  #child: ChildProcess | null = null
  #running = false
  #configPath: string
  #dataDir: string
  #portMap = new Map<string, number>()
  #nodes: ParsedNode[] = []

  constructor(options: SingBoxOptions) {
    this.#options = options
    this.#dataDir = options.dataDir
    this.#configPath = join(options.dataDir, 'singbox-config.json')
  }

  /** Live re-apply of the binary path (settings page, docs §5.1). The next
   *  reload() resolves through it; a running child keeps serving until then. */
  setBinPath(path: string): void {
    this.#options.binPath = path
  }

  get running(): boolean {
    return this.#running
  }

  get portMap(): Map<string, number> {
    return new Map(this.#portMap)
  }

  /** The binary location: absolute path as-is; bare name must exist on PATH
   *  (verified through `sing-box version` — LookPath equivalent). */
  async #resolveBinary(): Promise<string> {
    const bin = this.#options.binPath
    if (bin.includes('/') || bin.includes('\\') || bin.includes(':')) {
      if (existsSync(bin)) return bin
      throw new Error(`sing-box not found at ${bin}`)
    }
    // bare name: check via version output (LookPath semantics)
    const probe = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ['version'], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })
    if (!probe) throw new Error(`sing-box not found on PATH ("${bin}"); install it or set singbox.path`)
    return bin
  }

  /** Full reload: regenerate the config for the node list and (re)start. */
  async reload(nodes: ParsedNode[]): Promise<ConvertedExit[]> {
    // no tunnel nodes -> stop and clean (GoProxy Reload empty case)
    if (nodes.length === 0) {
      await this.stop()
      this.#nodes = []
      this.#portMap = new Map()
      return []
    }
    const binary = await this.#resolveBinary()
    const { config, portMap } = generateConfig(nodes, this.#options.basePort ?? 30_000)

    // atomic config write (tmp + rename)
    await mkdir(this.#dataDir, { recursive: true })
    const tmp = `${this.#configPath}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await rm(this.#configPath, { force: true })
    await rename(tmp, this.#configPath)

    // preflight: `sing-box check`
    const checkOk = await new Promise<boolean>((resolve) => {
      const child = spawn(binary, ['check', '-c', this.#configPath, '-D', this.#dataDir], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })
    if (!checkOk) {
      throw new Error('sing-box config check failed (run `sing-box check` on the generated config for details)')
    }

    await this.stop()
    this.#child = spawn(binary, ['run', '-c', this.#configPath, '-D', this.#dataDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const child = this.#child
    this.#running = true
    this.#nodes = nodes
    this.#portMap = portMap
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text.length > 0) this.#options.logger?.info(`[sing-box] ${text}`)
    })
    child.once('exit', () => {
      if (this.#child === child) this.#running = false
    })
    child.once('error', () => {
      if (this.#child === child) this.#running = false
    })

    // port readiness (GoProxy: 20 x 500ms over the first port)
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 10_000)
    const ports = [...portMap.values()]
    let ready = false
    while (Date.now() < deadline && !ready) {
      if (!this.#running) throw new Error('sing-box exited immediately after start (see logs)')
      await new Promise((resolve) => setTimeout(resolve, 500))
      for (const port of ports) {
        // eslint-disable-next-line no-await-in-loop
        if (await canConnect(port)) {
          ready = true
          break
        }
      }
    }
    if (!ready) this.#options.logger?.warn('opencode2dsh: sing-box ports not ready in time; some converted nodes may be unreachable')

    const exits: ConvertedExit[] = []
    for (const node of nodes) {
      const port = portMap.get(nodeKeyOf(node))
      if (port === undefined) continue
      exits.push({ address: `127.0.0.1:${port}`, protocol: 'socks5', node })
    }
    return exits
  }

  /** Graceful stop: interrupt -> grace -> kill (taskkill /T on Windows). */
  async stop(): Promise<void> {
    const child = this.#child
    if (child === null || child.exitCode !== null) {
      this.#running = false
      return
    }
    this.#child = null
    if (process.platform === 'win32' && child.pid) {
      // graceful attempt first, then /T /F
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        killer.once('exit', () => resolve())
        killer.once('error', () => resolve())
      })
    } else {
      child.kill('SIGINT')
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const grace = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), STOP_GRACE_MS))
    if ((await Promise.race([exited.then(() => 'exit' as const), grace])) === 'timeout') {
      if (process.platform === 'win32' && child.pid) {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
          killer.once('exit', () => resolve())
          killer.once('error', () => resolve())
        })
      } else {
        child.kill('SIGKILL')
      }
      await exited
    }
    this.#running = false
  }
}
