/**
 * ip-pool settings bridge (docs/ip-pool.md §5.3) — the loopback-only
 * webServer route pair the settings card needs beyond the official settings
 * transport: reading live pool runtime state (/status) and driving probe
 * actions (/probe). Settings reads/writes ride the official apiproxy
 * settings.describe/mutate RPCs (rc.2 serves every registered namespace —
 * no allowlist), so unlike dsh-llm-proxy this bridge carries NO settings
 * proxy surface.
 *
 * Trust model copied from dsh-llm-proxy settings.js (validated on this
 * host): loopback socket + canonical loopback Host header + same-origin
 * browser request. Everything else 403s.
 */

import type { IpPoolRuntime } from '../ip-pool.ts'
import type { PoolState, ExitSource } from '../pool/pool.ts'

/** Bridge route prefix (same-origin, loopback-only). */
export const IP_POOL_BRIDGE_PREFIX = '/api/opencode2dsh/ip-pool'

/** Cap on JSON request bodies (a probe trigger is tiny). */
const MAX_JSON_BODY_BYTES = 16 * 1024

// -- status view ---------------------------------------------------------------

export interface ExitRowView {
  id: string
  source: ExitSource
  protocol: string
  pinned: boolean
  exitIP: string
  exitLocation: string
  latencyMs: number
  quality: string
  state: 'unknown' | 'ok' | 'dead'
  cooling: boolean
  cooldownUntil: number
  consecutiveLimited: number
  bannedModels: Array<{ model: string; state: 'suspect' | 'banned'; bannedAt: number }>
  /** Passive-signal counters from real requests (docs §4.3, IP-6). */
  passive: { ok: number; limited: number; refused: number; dead: number; transport: number }
}

export interface ProberView {
  queued: number
  inFlight: number
  enqueued: number
  completed: number
}

export interface RefillView {
  admitted: number
  rejected: number
  fetched: number
  coarsePassed: number
  state: string
  at: number
  /** Live in-flight round progress (docs §5.3, 立即补充 feedback). */
  progress: { running: boolean; stage: 'fetch' | 'coarse' | 'admit' | 'idle'; sourcesDone: number; sourcesTotal: number; fetched: number; candidates: number; coarsePassed: number; coarseDone: number; admissions: number; admitted: number }
}

export interface SubscriptionView {
  /** URL count only — the URLs themselves never ride the bridge (§5.1 redaction). */
  urlCount: number
  pendingConversion: number
  convertedAdmitted: number
  plaintextAdmitted: number
  lastFetch: number
  lastError: string
}

export interface PoolStatusView {
  enabled: boolean
  /** Non-empty when the pool runs but the routing layer deferred to another
   *  dispatcher-level plugin (R1 coexistence policy). */
  deferredReason: string
  state: PoolState
  total: number
  bySource: Record<ExitSource, number>
  availableFree: number
  targetSize: number
  pinned: { id: string; strict: boolean } | null
  proxyHosts: string[]
  exits: ExitRowView[]
  prober: ProberView
  refill: RefillView | null
  subscription: SubscriptionView | null
  at: number
}

/** Build the /status view over the live runtime (or a disabled stub). */
export function buildStatusView(
  runtime: IpPoolRuntime | null,
  pinnedStrict: boolean,
  proxyHosts: string[],
): PoolStatusView {
  const snapshot = runtime
    ? runtime.pool.snapshot()
    : { state: 'healthy' as PoolState, total: 0, bySource: { free: 0, manual: 0, subscription: 0, goproxy: 0 } as Record<ExitSource, number>, availableFree: 0, pinned: '' }
  const now = Date.now()
  const exits: ExitRowView[] = runtime
    ? runtime.pool.list().map((entry) => ({
      id: entry.id,
      source: entry.source,
      protocol: entry.protocol,
      pinned: entry.pinned,
      exitIP: entry.exitIP,
      exitLocation: entry.exitLocation,
      latencyMs: entry.latencyMs,
      quality: entry.quality,
      state: entry.health.state,
      cooling: entry.health.cooldownUntil > now,
      cooldownUntil: entry.health.cooldownUntil,
      consecutiveLimited: entry.health.consecutiveLimited,
      bannedModels: entry.bans
        .filter((b) => b.ban.state !== 'ok')
        .map((b) => ({ model: b.model, state: b.ban.state as 'suspect' | 'banned', bannedAt: b.ban.bannedAt })),
      passive: runtime.pool.passiveStats(entry.id),
    }))
    : []
  return {
    enabled: runtime !== null && runtime.installer.enabled,
    deferredReason: runtime !== null && !runtime.installer.enabled
      ? (runtime.installer as unknown as { deferredReason?: string }).deferredReason ?? ''
      : '',
    state: snapshot.state,
    total: snapshot.total,
    bySource: snapshot.bySource,
    availableFree: snapshot.availableFree,
    targetSize: runtime ? runtime.pool.targetSize : 20,
    pinned: snapshot.pinned !== ''
      ? { id: snapshot.pinned, strict: pinnedStrict }
      : null,
    proxyHosts,
    exits,
    prober: runtime
      ? runtime.prober.stats
      : { queued: 0, inFlight: 0, enqueued: 0, completed: 0 },
    refill: runtime?.refill
      ? { ...runtime.refill.lastRound, progress: runtime.refill.progress }
      : null,
    subscription: runtime?.subscriptions
      ? {
        urlCount: runtime.subscriptions.urlCount,
        pendingConversion: runtime.subscriptions.state.pendingConversion.length,
        convertedAdmitted: runtime.subscriptions.state.convertedAdmitted,
        plaintextAdmitted: runtime.subscriptions.state.plaintextAdmitted,
        lastFetch: runtime.subscriptions.state.lastFetch,
        lastError: runtime.subscriptions.state.lastError,
      }
      : null,
    at: now,
  }
}

// -- request plumbing -----------------------------------------------------------

/** Whether a socket address is a literal loopback peer. */
function isLoopbackAddress(address: unknown): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether a normalized hostname is a literal loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Parse one bare Host authority; undefined for anything non-canonical. */
function parseAuthority(authority: string): { url: URL } | undefined {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL('http://' + authority)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return undefined
    return { url }
  } catch {
    return undefined
  }
}

/** Browser same-origin marker (loopback hosts are always same-origin here). */
function isSameOriginRequest(request: { headers: Record<string, string | string[] | undefined> }, hostUrl: URL): boolean {
  const headers = request.headers
  const site = headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(String(origin)).host === hostUrl.host
  } catch {
    return false
  }
}

/** Hot-path trust decision: loopback socket + canonical Host + same-origin. */
export function isTrustedBridgeRequest(request: {
  socket?: { remoteAddress?: unknown }
  headers: Record<string, string | string[] | undefined>
}): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.url.host.toLowerCase() !== host.toLowerCase()) return false
  if (!isSameOriginRequest(request, parsed.url)) return false
  return isLoopbackHostname(parsed.url.hostname)
}

// -- handlers + routes -----------------------------------------------------------

/** One JSON response. */
function writeJson(res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: AsyncIterable<Buffer> & { [Symbol.asyncIterator](): AsyncIterator<Buffer> }): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export type BridgeResult = { ok: true; value: unknown } | { ok: false; code: string; message: string }

/** deps over the live runtime + the current settings value (probe model etc.). */
export interface BridgeHandlers {
  status(): Promise<BridgeResult>
  probe(body: { scope?: unknown; exitId?: unknown }): Promise<BridgeResult>
  /** Selectable probe models (docs §5.2 探活模型 dropdown): S3 static list
   *  first, then the live Zen catalog entries the runtime resolved. */
  models(): Promise<BridgeResult>
}

/** Live-catalog seam for the models() dropdown rows (index.ts injects the
 *  plugin's ModelCatalog when one is running; undefined = static list only). */
export type ListLiveModels = () => string[]

/** Build the bridge handlers over the runtime + current settings. */
export function makeBridgeHandlers(
  runtime: () => IpPoolRuntime | null,
  settings: () => { pinnedStrict: boolean; proxyHosts: string[] },
  deps: { listLiveModels?: ListLiveModels } = {},
): BridgeHandlers {
  return {
    async status() {
      return {
        ok: true,
        value: buildStatusView(runtime(), settings().pinnedStrict, settings().proxyHosts),
      }
    },
    async probe(body) {
      const rt = runtime()
      if (rt === null) return { ok: false, code: 'pool-disabled', message: 'ip pool is not running (enabled off)' }
      const scope = body.scope
      if (scope === 'all') {
        const queued = await rt.probeAll()
        return { ok: true, value: { queued } }
      }
      if (scope === 'refill') {
        await rt.refillNow()
        return { ok: true, value: { refilled: true } }
      }
      if (scope === 'exit') {
        const exitId = typeof body.exitId === 'string' ? body.exitId : ''
        if (!rt.pool.has(exitId)) return { ok: false, code: 'unknown-exit', message: `exit "${exitId}" is not in the pool` }
        const count = await rt.probeExit(exitId)
        return { ok: true, value: { queued: count } }
      }
      return { ok: false, code: 'settings-rejected', message: "probe scope must be 'all', 'exit' or 'refill'" }
    },
    async models() {
      const { staticFreeModels } = await import('../adapter/catalog.ts')
      const rows: Array<{ id: string; verified: boolean }> = staticFreeModels.map((id) => ({ id, verified: true }))
      const seen = new Set(staticFreeModels)
      for (const id of deps.listLiveModels?.() ?? []) {
        if (typeof id !== 'string' || id === '' || seen.has(id)) continue
        seen.add(id)
        rows.push({ id, verified: false })
      }
      return { ok: true, value: { models: rows } }
    },
  }
}

/** Bridge route registration input (exact paths for webServer.register). */
export interface BridgeRoute {
  kind: 'exact'
  path: string
  handler: (req: never, res: never) => void | Promise<void>
}

/** Build the loopback-guarded routes. The route bodies are host-shaped
 *  (node:http req/res); typed loosely because the plugin never touches the
 *  webServer service itself — index.ts does. */
export function makeBridgeRoutes(
  handlers: BridgeHandlers,
  deps: {
    guard?: (req: unknown) => boolean
  } = {},
): Array<{ kind: 'exact'; path: string; handler: (req: never, res: never) => void | Promise<void> }> {
  const guard = deps.guard ?? isTrustedBridgeRequest
  const check = (req: { method?: string } & Parameters<typeof isTrustedBridgeRequest>[0], res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }): boolean => {
    if (!guard(req)) {
      writeJson(res, 403, { error: 'forbidden' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed: ' + (req.method ?? '') })
      return false
    }
    return true
  }
  return [
    {
      kind: 'exact',
      path: `${IP_POOL_BRIDGE_PREFIX}/status`,
      handler: async (req, res) => {
        if (!check(req as never, res as never)) return
        const result = await handlers.status()
        writeJson(res as never, 200, result)
      },
    },
    {
      kind: 'exact',
      path: `${IP_POOL_BRIDGE_PREFIX}/models`,
      handler: async (req, res) => {
        if (!check(req as never, res as never)) return
        const result = await handlers.models()
        writeJson(res as never, 200, result)
      },
    },
    {
      kind: 'exact',
      path: `${IP_POOL_BRIDGE_PREFIX}/probe`,
      handler: async (req, res) => {
        if (!check(req as never, res as never)) return
        let body: unknown
        try {
          body = await readJsonBody(req as never)
        } catch {
          body = undefined
        }
        if (body === undefined || typeof body !== 'object' || body === null) {
          writeJson(res as never, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        const result = await handlers.probe(body as { scope?: unknown; exitId?: unknown })
        writeJson(res as never, 200, result)
      },
    },
  ]
}
