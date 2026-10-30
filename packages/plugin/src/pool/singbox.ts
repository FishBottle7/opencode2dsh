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
  /** Process seam (tests inject fake children; default node:child_process).
   *  Only the sing-box invocations ride it — taskkill stays real. */
  spawnFn?: typeof spawn
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

/**
 * uTLS fingerprints sing-box accepts (verified against 1.14.2 by driving
 * `sing-box check` once per value). Anything outside this set is a
 * v2rayN/Clash spelling, and forwarding it aborted the WHOLE generated config:
 *
 *   FATAL[0000] initialize outbound[140]: unknown uTLS fingerprint: unsafe
 *
 * `unsafe` is the notable offender: in the v2ray vocabulary it means "do NOT
 * use uTLS", not a fingerprint name. Because every node shares one config and
 * one `sing-box check` preflight, two such nodes (measured live: 2 of 470)
 * kept EVERY encrypted node out of the pool — the settings card read
 * "470 待转换 · 0 已转换入池". Unknown values are dropped instead of
 * forwarded: with no `utls` block sing-box uses its own TLS stack, which is
 * what `unsafe` asked for in the source dialect.
 */
const KNOWN_UTLS_FINGERPRINTS = new Set([
  'chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized',
])

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
  const fingerprint = getStr(raw, 'client-fingerprint').toLowerCase()
  if (fingerprint !== '' && KNOWN_UTLS_FINGERPRINTS.has(fingerprint)) {
    tls.utls = { enabled: true, fingerprint }
  }
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

/** Watchdog restart backoff: first retry after 1s, doubling, capped at 60s. */
const WATCHDOG_BASE_BACKOFF_MS = 1_000
const WATCHDOG_MAX_BACKOFF_MS = 60_000
/** A run this long counts as stable: the next crash starts backoff from 1s. */
const WATCHDOG_STABLE_MS = 5 * 60_000

/** One readable line from a `sing-box check` run (its FATAL line is last). */
function summarizeCheck(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines[lines.length - 1] ?? ''
}

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
  readonly #spawn: typeof spawn
  #child: ChildProcess | null = null
  #running = false
  #configPath: string
  #dataDir: string
  #portMap = new Map<string, number>()
  #nodes: ParsedNode[] = []
  /** Pending watchdog restart timer (null when none scheduled). */
  #watchdog: NodeJS.Timeout | null = null
  /** Crashes since the last stable run; drives the backoff ladder. */
  #watchdogAttempt = 0
  /** True while a reload() is in flight, so the watchdog never spawns a
   *  second child alongside one (stale-child crashes are told apart by the
   *  `#child !== child` check in the exit handler, not by this flag). */
  #reloading = false
  /** Owner-intent latch: set by stop(), cleared by an explicit reload() and
   *  re-cleared only after a spawn actually happens. Without it, a dispose()
   *  that lands while a watchdog restart is mid-reload leaves the spawned
   *  child arming the watchdog forever — ghost restarts every ≤60s after the
   *  plugin is gone (the reload cannot be cancelled once it spawns, so the
   *  spawn itself re-checks the latch). */
  #ownerStopped = false
  /** Bumped by every stop(); a reload only re-clears the latch post-spawn
   *  when NO stop() landed inside its window (epoch unchanged) — a stop that
   *  races past the pre-spawn check must still win. */
  #stopEpoch = 0

  constructor(options: SingBoxOptions) {
    this.#options = options
    this.#spawn = options.spawnFn ?? spawn
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
      const child = this.#spawn(bin, ['version'], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })
    if (!probe) throw new Error(`sing-box not found on PATH ("${bin}"); install it or set singbox.path`)
    return bin
  }

  /**
   * Atomic write + `sing-box check` preflight. Returns the checker's output so
   * the caller can tell the user WHY a generated config was rejected (the old
   * path discarded it and surfaced a bare "config check failed").
   */
  async #writeAndCheck(
    binary: string,
    config: Record<string, unknown>,
    configPath: string,
  ): Promise<{ ok: boolean; output: string }> {
    const tmp = `${configPath}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await rm(configPath, { force: true })
    await rename(tmp, configPath)
    return await new Promise<{ ok: boolean; output: string }>((resolve) => {
      const child = this.#spawn(binary, ['check', '-c', configPath, '-D', this.#dataDir], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const collect = (chunk: Buffer): void => {
        // keep the tail: the fatal line is last, and a pathological config can
        // emit thousands of lines
        output = (output + chunk.toString('utf8')).slice(-2_000)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.once('error', (err) => resolve({ ok: false, output: err.message }))
      child.once('exit', (code) => resolve({ ok: code === 0, output }))
    })
  }

  /**
   * Find the node indices that make `sing-box check` fail, by bisecting the
   * node list. Returns an empty set when the failure is not node-attributable
   * (a binary/env problem), so the caller keeps the original error instead of
   * blaming nodes. Cost is O(k log n) checks for k bad nodes — with the
   * measured shape (a couple of bad nodes among hundreds) that is a handful of
   * preflights, all local and quota-free.
   */
  async #isolateBadNodes(binary: string, nodes: ParsedNode[]): Promise<Set<number>> {
    const probePath = `${this.#configPath}.probe`
    const fails = async (indices: number[]): Promise<boolean> => {
      if (indices.length === 0) return false
      const subset = indices.map((index) => nodes[index]!)
      const { config } = generateConfig(subset, this.#options.basePort ?? 30_000)
      const result = await this.#writeAndCheck(binary, config, probePath)
      return !result.ok
    }
    const bad = new Set<number>()
    const walk = async (indices: number[]): Promise<void> => {
      // A single node that fails alone is provably the offender.
      if (indices.length === 1) {
        if (await fails(indices)) bad.add(indices[0]!)
        return
      }
      if (!(await fails(indices))) return
      const mid = Math.floor(indices.length / 2)
      await walk(indices.slice(0, mid))
      await walk(indices.slice(mid))
    }
    await walk(nodes.map((_node, index) => index))
    await rm(probePath, { force: true })
    return bad
  }

  /**
   * Crash watchdog (issue #106): every converted exit is one local port of ONE
   * sing-box process, so a crash takes the whole encrypted-node pool down at
   * once — and until this existed, real traffic then struck each exit dead
   * individually (transport failures through dead local ports) while the only
   * thing that brought the process back was the next subscription refresh,
   * up to 30 minutes later. The exit verdicts recover through the prober's
   * starvation fast-path; this watchdog is what brings the tunnel itself back
   * in seconds. Backoff 1s -> 2s -> ... -> 60s; a stable run resets the ladder.
   */
  #scheduleWatchdog(): void {
    // One pending restart at a time. NOTE: scheduling must NOT be gated on
    // #reloading — a child can die inside reload()'s own port-readiness wait
    // (crash-during-startup), and that reload then throws without ever
    // clearing this timer; #watchdogRestart re-checks #reloading when the
    // timer fires, which is the only place the guard belongs. It IS gated on
    // the owner-intent latch: after stop()/dispose() the supervisor must stay
    // down, whatever exit events stale children still emit.
    if (this.#watchdog !== null) return
    if (this.#ownerStopped) return
    const backoff = Math.min(WATCHDOG_MAX_BACKOFF_MS, WATCHDOG_BASE_BACKOFF_MS * 2 ** this.#watchdogAttempt)
    this.#watchdogAttempt += 1
    this.#options.logger?.warn(
      `opencode2dsh: sing-box exited unexpectedly; watchdog restart #${this.#watchdogAttempt} in ${Math.round(backoff / 1000)}s (${this.#nodes.length} converted exit(s) down until then)`,
    )
    this.#watchdog = setTimeout(() => {
      this.#watchdog = null
      void this.#watchdogRestart()
    }, backoff)
    this.#watchdog.unref?.()
  }

  #clearWatchdog(): void {
    if (this.#watchdog === null) return
    clearTimeout(this.#watchdog)
    this.#watchdog = null
  }

  async #watchdogRestart(): Promise<void> {
    // A subscription refresh (or an earlier watchdog pass) already brought a
    // child back, or the pool was intentionally emptied — nothing to do.
    // NOTE: a reload in flight is NOT a reason to stand down — re-arm instead.
    // A large port table (hundreds of converted exits) makes the readiness
    // scan outlast the 1s base backoff, so the timer can fire while the reload
    // that will FAIL for the crashed child is still looping. Returning bare
    // there left nobody holding the recovery: the reload threw afterwards and
    // the tunnel stayed down until the next subscription refresh (the exact
    // shape issue #106 reported). #scheduleWatchdog's single-timer guard makes
    // this re-arm idempotent, and if the in-flight reload actually succeeds,
    // the next fire exits on the #running check below.
    if (this.#reloading) {
      this.#scheduleWatchdog()
      return
    }
    if (this.#nodes.length === 0) return
    if (this.#child !== null && this.#running) return
    try {
      await this.reload(this.#nodes)
    } catch (err) {
      // reload already logged the reason; climb the backoff ladder and try again.
      this.#options.logger?.warn(`opencode2dsh: sing-box watchdog restart failed (${err instanceof Error ? err.message : String(err)}); retrying with backoff`)
      this.#scheduleWatchdog()
    }
  }

  /** Full reload: regenerate the config for the node list and (re)start. */
  async reload(nodes: ParsedNode[]): Promise<ConvertedExit[]> {
    this.#clearWatchdog()
    // An explicit reload is the owner asking for a RUNNING tunnel again —
    // clear the stop latch (set by any earlier stop()/dispose()), and remember
    // the stop epoch so the post-spawn re-clear can tell whether a NEW stop
    // landed inside this reload's window.
    this.#ownerStopped = false
    const epochAtEntry = this.#stopEpoch
    this.#reloading = true
    try {
      return await this.#reloadInner(nodes, epochAtEntry)
    } finally {
      this.#reloading = false
    }
  }

  async #reloadInner(nodes: ParsedNode[], epochAtEntry: number): Promise<ConvertedExit[]> {
    // no tunnel nodes -> stop and clean (GoProxy Reload empty case)
    if (nodes.length === 0) {
      await this.stop()
      this.#nodes = []
      this.#portMap = new Map()
      return []
    }
    const binary = await this.#resolveBinary()
    await mkdir(this.#dataDir, { recursive: true })
    let usable = nodes
    let generated = generateConfig(usable, this.#options.basePort ?? 30_000)
    let checked = await this.#writeAndCheck(binary, generated.config, this.#configPath)

    // Preflight is per-CONFIG, not per-node: one malformed node aborts every
    // other node in the batch. Measured live (2026-10-13): a single
    // `client-fingerprint: unsafe` in 470 nodes yielded 0 converted exits, so
    // isolate and drop the offenders instead of surrendering the whole batch.
    if (!checked.ok) {
      const bad = await this.#isolateBadNodes(binary, usable)
      if (bad.size > 0) {
        usable = usable.filter((_node, index) => !bad.has(index))
        this.#options.logger?.warn(
          `opencode2dsh: sing-box rejected ${bad.size} node(s); converting the remaining ${usable.length} of ${nodes.length} (${summarizeCheck(checked.output)})`,
        )
        generated = generateConfig(usable, this.#options.basePort ?? 30_000)
        checked = await this.#writeAndCheck(binary, generated.config, this.#configPath)
      }
    }
    if (!checked.ok) {
      throw new Error(`sing-box config check failed: ${summarizeCheck(checked.output) || 'run `sing-box check` on the generated config for details'}`)
    }
    const { config, portMap } = generated

    // Internal restart — #killChild, NOT stop(): bumping the stop epoch here
    // would make the post-spawn epoch check fail on every reload and leave the
    // owner-stop latch stuck armed (watchdog permanently dead).
    await this.#killChild()
    // Cancellation point: a stop()/dispose() that landed while this reload was
    // resolving must not be followed by a fresh child. Spawn is the one step
    // that cannot be undone, so it is where the latch is re-checked.
    if (this.#ownerStopped) return []
    this.#child = this.#spawn(binary, ['run', '-c', this.#configPath, '-D', this.#dataDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const child = this.#child
    this.#running = true
    this.#nodes = usable
    this.#portMap = portMap
    // A live child is the owner's intent made real — the stop latch a reload's
    // own internal stop() set above is spent, but ONLY if no external stop()
    // landed inside this reload's window (epoch unchanged): one that slipped
    // past the pre-spawn check must still win and keep the watchdog disarmed.
    if (this.#stopEpoch === epochAtEntry) this.#ownerStopped = false
    // A run that survives the stability window forgives the crash history:
    // the next crash starts the backoff ladder from the bottom again. The
    // attempt guard keeps an old timer from erasing a NEWER crash's ladder.
    if (this.#watchdogAttempt > 0) {
      const attempt = this.#watchdogAttempt
      const stable = setTimeout(() => {
        if (this.#watchdogAttempt === attempt) this.#watchdogAttempt = 0
      }, WATCHDOG_STABLE_MS)
      stable.unref?.()
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text.length > 0) this.#options.logger?.info(`[sing-box] ${text}`)
    })
    // Unexpected loss of the child (not via stop()/reload(), which both clear
    // #child first): every converted exit just went dark — restart it.
    const onGone = (): void => {
      if (this.#child !== child) return
      this.#running = false
      this.#scheduleWatchdog()
    }
    child.once('exit', onGone)
    child.once('error', onGone)

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
    for (const node of usable) {
      const port = portMap.get(nodeKeyOf(node))
      if (port === undefined) continue
      exits.push({ address: `127.0.0.1:${port}`, protocol: 'socks5', node })
    }
    return exits
  }

  /** Graceful stop: interrupt -> grace -> kill (taskkill /T on Windows).
   *  External intent — arms the owner-stop latch and bumps its epoch. The
   *  kill mechanics live in #killChild(), which is what reload() runs before
   *  respawning (an internal restart must NOT bump the epoch, or every
   *  successful reload would leave the latch stuck and the watchdog dead). */
  async stop(): Promise<void> {
    this.#clearWatchdog()
    this.#ownerStopped = true
    this.#stopEpoch += 1
    await this.#killChild()
  }

  /** The kill part of stop(), shared with reload()'s internal restart. */
  async #killChild(): Promise<void> {
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
