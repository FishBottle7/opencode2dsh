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

import type { ExitPool, ExitProtocol } from './pool.ts'

/** Structural seam over npm undici so tests can inject fakes. */
export interface UndiciSeam {
  Agent: typeof Agent
  /**
   * Structural over `typeof ProxyAgent`: the real constructor takes
   * `proxyTls`, and https:// exits need it (see httpsProxyOptions) — but the
   * test fakes accept a single argument, so the wider real signature cannot
   * be required here without breaking every existing seam double.
   */
  ProxyAgent: new (options: { uri: string; clientFactory?: (origin: URL | string, options?: unknown) => unknown; proxyTls?: { rejectUnauthorized?: boolean } }) => Dispatcher
  setGlobalDispatcher(dispatcher: Dispatcher): unknown
  getGlobalDispatcher(): Dispatcher
  /**
   * The module's own fetch (honors THIS module's global-dispatcher state).
   * Live-observed 2026-09-09 (docs/ip-pool.md R2): Node's built-in fetch
   * reads a SEPARATE built-in undici instance's dispatcher slot —
   * setGlobalDispatcher on the npm module never reaches it, and the OpenAI
   * SDK inside pi-ai captures globalThis.fetch at call time, so without
   * this swap the pool's routing silently never applies to model traffic.
   * Typed loosely on purpose: npm undici's Request/Response element types
   * never structurally match Node's built-ins across versions.
   */
  fetch?: (input: unknown, init?: unknown) => Promise<unknown>
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
  /** Response-silence sentinel, window (a): dispatch -> first callback (docs §4.3; default 2s, test-injectable). */
  sentinelMs?: number
  /** Sentinel window (b): tunnel established -> response headers. The tunnel
   *  standing proves exit liveness; the rest of the wait is the LLM upstream
   *  composing the first token (measured 1.7-2.7s live), so this window is
   *  far looser than (a). Default 10s, test-injectable. */
  headersMs?: number
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

/**
 * Map an exit address to a ProxyAgent URI ('h:1' -> 'http://h:1').
 *
 * `https` MUST survive as its own scheme: undici only wraps CONNECT in TLS
 * when the proxy URI scheme is `https:` (proxy-agent.js, `forwardConnect =
 * this[kProxy].protocol === 'https:'`). Downgrading an `https://` proxy to a
 * plaintext `http://` URI sends a bare CONNECT to a TLS listener, which drops
 * the connection without ever sending a status line — undici surfaces exactly
 * that as `SocketError: other side closed` (client-h1.js, onHttpSocketEnd),
 * and the rule table then correctly but uselessly strikes a healthy exit dead.
 * Measured live 2026-10-15: 46 of 118 exits failed that way, all on ports
 * 443/9002/9443; every sampled one completed a TLS handshake and answered
 * CONNECT 200 once the request was wrapped (certs *.windscribe.com,
 * *.nodes.gen4.ninja).
 */
export function exitProxyUri(exitId: string, protocol: ExitProtocol): string {
  const scheme = protocol === 'socks5' ? 'socks5' : protocol === 'https' ? 'https' : 'http'
  return PROXY_PROTOCOL_PREFIX.test(exitId) ? exitId : `${scheme}://${exitId}`
}

/**
 * ProxyAgent options for an https:// exit, including the one setting that
 * decides whether it connects at all.
 *
 * Measured 2026-10-15 against live subscription exits: a bare
 * `new ProxyAgent({ uri: 'https://203.0.113.7:443' })` fails EVERY request
 * with `Secure Proxy Connection failed`. The cause is certificate
 * verification, not connectivity: these exits are addressed by IP literal, so
 * there is no hostname a certificate could be issued for, and undici falls
 * back to `rejectUnauthorized: true` — every handshake is then rejected.
 * Passing `proxyTls: { rejectUnauthorized: false }` made all sampled exits
 * serve `http://ip-api.com` with 200.
 *
 * Only the PROXY HOP is unverified. The tunneled request still runs through
 * undici's normal TLS path to the real target, so end-to-end confidentiality
 * to `opencode.ai` is unchanged; what is given up is authentication of the
 * proxy's own identity, for which an IP literal offers nothing to check
 * against anyway. This mirrors what sing-box does for the converted exits.
 */
export function httpsProxyOptions(): { proxyTls: { rejectUnauthorized: boolean } } {
  return { proxyTls: { rejectUnauthorized: false } }
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
  #sentinelMs: number
  #headersMs: number
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
    this.#sentinelMs = options.sentinelMs ?? 2_000
    this.#headersMs = options.headersMs ?? 10_000
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
        ...(exit.protocol === 'https' ? httpsProxyOptions() : {}),
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
    if (isLoopback(host) || !this.#proxyHosts.has(host)) {
      return this.#direct.dispatch(options, handler)
    }
    const context = routingContext.getStore() ?? {}
    const model = context.model ?? 'default'
    const session = context.session ?? 'default'
    const exitId = this.#pool.pick(session, model)
    if (exitId === null) {
      // Pool unusable (empty / all cooling): direct, never fail closed (3.3).
      return this.#direct.dispatch(options, handler)
    }
    const agent = this.#agentFor(exitId)
    if (!agent) {
      return this.#direct.dispatch(options, handler)
    }
    return agent.dispatch(options, this.#observe(exitId, model, session, handler))
  }

  /**
   * Wrap the downstream handler with the passive-signal observer
   * (docs/ip-pool.md §4.2 rule table, §4.3 被动): the real request's own
   * outcome feeds the two-tier health — free liveness data no probe spends
   * quota on. Body bytes stream through untouched; only the response start
   * line and terminal transport errors are read.
   *
   * Forwarding discipline (measured against undici 8.10 on this host): the
   * fetch handler's methods live on a prototype with private state, so a
   * spread would strip them and Object.create delegation would re-enter
   * them with the wrong `this`. The wrapper is a fresh plain object that
   * forwards every DispatchHandler callback to the original with the
   * original as `this` — the same shape undici's own wrappers use.
   *
   * Response-silence sentinel: undici's Pool fires NONE of the handler
   * callbacks (not even onResponseError) when a proxy CONNECT fails at the
   * connection stage — the failure surfaces only as a fetch rejection (and
   * an APIConnectionError/"Connection error." upstream). Without a fallback
   * the passive signal is blind exactly when a dead exit needs to be evicted
   * (live repro: 10.255.255.1:9999 blackhole, seen:[] callbacks). So the
   * wrapper arms a timer at dispatch time; any handler callback disarms it,
   * and silence past the deadline counts as a transport failure (dead strike
   * + session reroute). The sentinel never aborts the request itself — fetch
   * and pi-ai own their own timeouts.
   */
  #observe(exitId: string, model: string, session: string, handler: Dispatcher.DispatchHandler): Dispatcher.DispatchHandler {
    const pool = this.#pool
    const forward = (method: keyof Dispatcher.DispatchHandler, args: unknown[]): void => {
      const fn = handler[method]
      if (typeof fn === 'function') (fn as (...a: unknown[]) => void).apply(handler, args)
    }
    let classified = false
    const classify = (statusCode: number): void => {
      if (classified) return
      classified = true
      const verdict = pool.recordPassive(exitId, statusCode, model)
      // A degraded sticky exit must not keep the session pinned to it.
      if (verdict !== 'ok') pool.rerouteSession(session)
    }
    // The most recent controller the wrapper has seen (undici hands a fresh
    // one to each handler callback; abort must go to the live one).
    let liveController: { abort?(reason: Error): void } | null = null
    const classifyTransport = (): void => {
      if (classified) return
      classified = true
      pool.recordPassiveTransport(exitId)
      pool.rerouteSession(session)
      // Live-observed (2026-09-07, muse via 7897): after the tunnel stands a
      // dead-behind-the-tunnel exit answers NOTHING — no headers, no
      // onResponseError — and neither fetch nor pi-ai owns a body-silence
      // timeout, so the request hangs forever (the turn never finished; the
      // stop button's abort never reached it). The sentinel therefore does
      // more than bookkeeping: it tears the dispatch down BOTH ways — abort
      // the controller when we have one, and when the blackhole path never
      // handed us a single callback (no controller exists) synthesize the
      // response-error the handler owes, so fetch rejects at once, pi-ai
      // turns that into an error event, and the adapter's rotate loop gets
      // to move the session to a live exit.
      const reason = new Error('opencode2dsh: exit response silence')
      if (typeof handler.onResponseError === 'function') {
        ;(handler.onResponseError as (c: unknown, e: Error) => void).call(handler, liveController ?? ({} as never), reason)
      }
      liveController?.abort?.(reason)
    }
    // Silence deadline, in two windows: (a) dispatch -> first callback (dead
    // CONNECT fires NONE, undici 8.10 measured); (b) tunnel established ->
    // response headers (onRequestStart disarms window (a) only). Window (b)
    // must be MUCH looser than (a): the tunnel standing proves the exit is
    // alive, and the remaining wait is the LLM upstream composing the first
    // token — measured live 2026-09-09 (mihomo 7897 -> SJ exit -> zen):
    // headers landed 1.7-2.7s after onRequestStart, so a 2s window (b) kills
    // healthy streams (live repro: status 200 with TTFB 2.66s struck dead
    // at 2s). Body pacing stays uncovered (a live stream disarms at
    // onResponseStart); (a) keeps sitting under the host's 1-5s retry
    // cadence and the coarse-screen latency gate (3s).
    const armSentinel = (): void => {
      clearTimeout(sentinel)
      const window = sawRequestStart ? this.#headersMs : this.#sentinelMs
      sentinel = setTimeout(classifyTransport, window)
      sentinel.unref?.()
    }
    let sawRequestStart = false
    let sentinel: NodeJS.Timeout | undefined = undefined
    armSentinel()
    const disarm = (): void => {
      clearTimeout(sentinel)
    }
    return {
      onRequestStart: (controller, context) => {
        liveController = controller
        // window (a) ends; window (b) begins: headers must still arrive,
        // on the looser upstream-composition budget (see armSentinel)
        sawRequestStart = true
        armSentinel()
        forward('onRequestStart', [controller, context])
      },
      onRequestUpgrade: (controller, statusCode, headers, socket) => {
        liveController = controller
        disarm()
        forward('onRequestUpgrade', [controller, statusCode, headers, socket])
      },
      onResponseStart: (controller, statusCode, headers, statusMessage) => {
        liveController = controller
        disarm()
        classify(statusCode)
        forward('onResponseStart', [controller, statusCode, headers, statusMessage])
      },
      onResponseData: (controller, chunk) => {
        liveController = controller
        forward('onResponseData', [controller, chunk])
      },
      onResponseEnd: (controller, trailers) => {
        liveController = controller
        disarm()
        forward('onResponseEnd', [controller, trailers])
      },
      onResponseError: (controller, error) => {
        liveController = controller
        disarm()
        classifyTransport()
        forward('onResponseError', [controller, error])
      },
      onResponseStarted: () => {
        disarm()
        forward('onResponseStarted', [])
      },
      onBodySent: (chunk) => forward('onBodySent', [chunk]),
      onRequestSent: () => forward('onRequestSent', []),
    }
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
