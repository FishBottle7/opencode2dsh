/**
 * IP-5 host-side tests: the settings namespace (schema defaults, value
 * mapping), the loopback-guarded bridge (status view, probe scopes, guard
 * semantics, envelopes) and the apply controller's live reconfigure path.
 * No real network, no global dispatcher install.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staticFreeModels } from '../src/adapter/catalog.ts'

import { IpPoolConfigSchema, resolveIpPoolSettings, resolveProbeModels, toIpPoolConfig, IP_POOL_NAMESPACE } from '../src/ip-pool-settings/namespace.ts'
import { buildStatusView, isTrustedBridgeRequest, makeBridgeHandlers, makeBridgeRoutes, IP_POOL_BRIDGE_PREFIX } from '../src/ip-pool-settings/bridge.ts'

// -- namespace ---------------------------------------------------------------

test('ip-pool settings are served under the Loader entry id', () => {
  // DSH 0.1.7 derives the namespace from the loader entry, so it is
  // 'opencode2dsh' — not a name the plugin registers for itself.
  assert.equal(String(IP_POOL_NAMESPACE), 'opencode2dsh')
})

test('schema fills every default from an empty section', () => {
  const value = IpPoolConfigSchema({}) as Record<string, unknown>
  assert.equal(value.enabled, false)
  assert.deepEqual(value.probeModels, [])
  assert.equal(value.maxConcurrentProbes, 3)
  assert.equal((value.free as Record<string, unknown>).enabled, true)
  assert.equal((value.free as Record<string, unknown>).targetSize, 20)
  assert.deepEqual((value.free as Record<string, unknown>).blockedCountries, ['CN'])
  assert.deepEqual(value.manual, [])
  assert.deepEqual((value.subscription as Record<string, unknown>).urls, [])
  // The built-in fetch UA is the airport allow-listed spelling, not 1.6.0 —
  // a real airport answers 502 Bad Gateway for the latter (docs 4.6).
  assert.equal((value.subscription as Record<string, unknown>).userAgent, 'clash-verge/v2.0')
  assert.equal((value.singbox as Record<string, unknown>).path, 'sing-box')
  assert.equal(value.pinnedExitId, '')
  assert.equal(value.pinnedStrict, false)
})

test('schema rejects out-of-range probe concurrency', () => {
  assert.throws(() => IpPoolConfigSchema({ maxConcurrentProbes: 9 }))
  assert.throws(() => IpPoolConfigSchema({ maxConcurrentProbes: 0 }))
})

test('a schema-resolved value keeps its nested subscription urls (legacy [] must not shadow them)', () => {
  // Regression (live 2026-10-12): the settings page saved a subscription URL,
  // the Host persisted it, and the pool still assembled with zero subscription
  // URLs — `/status` reported `subscriptions: null`, so no fetcher was ever
  // created and the card's subscription count stayed 0. `Schema.array()` hands
  // an absent array an implicit `[]`, so the resolved value ALWAYS carries the
  // legacy flat key, and `raw.subscriptions ?? raw.subscription?.urls` resolved
  // to that empty array. The value must be fed through the schema here: a raw
  // hand-written section (no flat key at all) cannot reproduce it.
  const resolved = IpPoolConfigSchema({
    subscription: { urls: ['https://sub.example.com/token'], refreshMs: 1800000 },
  } as never)
  assert.deepEqual((resolved as Record<string, unknown>).subscriptions, [], 'the flat key is present-but-empty in a served value')

  const settings = resolveIpPoolSettings(resolved as never)
  assert.deepEqual(settings.subscription.urls, ['https://sub.example.com/token'])
  assert.deepEqual(toIpPoolConfig(settings).subscriptions, ['https://sub.example.com/token'])
})

test('the legacy flat spelling still carries urls when the nested list is empty', () => {
  // Older compositions write the flat key only; it must keep working.
  const settings = resolveIpPoolSettings({ subscriptions: ['https://legacy.example.com/sub'] })
  assert.deepEqual(settings.subscription.urls, ['https://legacy.example.com/sub'])

  // And when the nested spelling has content it wins over a stale flat list.
  const both = resolveIpPoolSettings({
    subscriptions: ['https://stale.example.com/sub'],
    subscription: { urls: ['https://canonical.example.com/sub'], refreshMs: 60_000, userAgent: 'clash-verge/v2.0' },
  })
  assert.deepEqual(both.subscription.urls, ['https://canonical.example.com/sub'])
})

test('resolveProbeModels defaults to S3 first and dedupes user entries', () => {
  assert.deepEqual(resolveProbeModels([]), ['big-pickle'])
  assert.deepEqual(resolveProbeModels(['muse', 'muse']), ['muse'])
})

test('toIpPoolConfig maps the settings value onto the plugin config shape', () => {
  const mapped = toIpPoolConfig(IpPoolConfigSchema({
    enabled: true,
    manual: ['http://1.2.3.4:8080'],
    pinnedExitId: 'http://127.0.0.1:7897',
    pinnedStrict: true,
    maxConcurrentProbes: 7,
    subscription: { urls: ['https://sub.example.com/token'], refreshMs: 123_456, userAgent: 'mihomo/1.19.0' },
  }) as never)
  assert.equal(mapped.enabled, true)
  assert.deepEqual(mapped.manual, ['http://1.2.3.4:8080'])
  assert.equal(mapped.pinnedExitId, 'http://127.0.0.1:7897')
  assert.equal(mapped.pinnedStrict, true)
  assert.deepEqual(mapped.subscriptions, ['https://sub.example.com/token'])
  assert.deepEqual(mapped.probeModels, ['big-pickle'])
  assert.deepEqual(mapped.singbox, { path: 'sing-box' })
  // The runtime reads these two off the config shape (ip-pool.ts:
  // Prober construction + SubscriptionFetcher interval/UA), so dropping them
  // here would reset them to the default on every live commit.
  assert.equal(mapped.maxConcurrentProbes, 7)
  assert.deepEqual(mapped.subscription, { refreshMs: 123_456, userAgent: 'mihomo/1.19.0' })
})

// -- bridge: status view -------------------------------------------------------

/** Minimal fake runtime face buildStatusView/probe handlers consume. */
function fakeRuntime(overrides: Record<string, unknown> = {}): unknown {
  const pool = {
    snapshot: () => ({ state: 'warning', total: 2, bySource: { free: 1, manual: 1, subscription: 0, goproxy: 0 }, availableFree: 1, pinned: 'http://10.0.0.1:3128' }),
    targetSize: 20,
    list: () => [
      {
        id: 'http://10.0.0.1:3128', source: 'manual', protocol: 'http', pinned: true,
        exitIP: '10.0.0.1', exitLocation: 'US test', latencyMs: 120, quality: 'S',
        health: { state: 'ok', cooldownUntil: 0, consecutiveLimited: 0 },
        bans: [],
      },
      {
        id: '1.2.3.4:8080', source: 'free', protocol: 'http', pinned: false,
        exitIP: '1.2.3.4', exitLocation: 'SG test', latencyMs: 410, quality: 'S',
        health: { state: 'ok', cooldownUntil: Date.now() + 60_000, consecutiveLimited: 1 },
        bans: [{ model: 'muse-spark-1.2-contributor-free', ban: { state: 'banned', bannedAt: 123, consecutiveFailures: 2 } }],
      },
    ],
    has: (id: string) => id === 'http://10.0.0.1:3128',
    passiveStats: () => ({ ok: 12, limited: 2, refused: 0, dead: 1, transport: 0 }),
    rerouteSession: () => {},
  }
  return {
    pool,
    installer: { enabled: true, deferredReason: null, install() {}, disable() {}, dispose() {} },
    prober: { stats: { queued: 0, inFlight: 1, enqueued: 5, completed: 4 } },
    refill: { lastRound: { admitted: 2, rejected: 30, fetched: 1600, coarsePassed: 8, state: 'warning', at: 456 } },
    subscriptions: {
      urlCount: 2,
      state: { running: false, pendingConversion: [{}, {}], convertedAdmitted: 1, plaintextAdmitted: 0, lastFetch: 789, lastError: '' },
    },
    probeAll: async () => 2,
    probeExit: async () => 1,
    refillNow: async () => {},
    refreshSubscriptions: async () => {},
    reconfigure: async () => {},
    dispose: async () => {},
    ...overrides,
  }
}

test('status view projects the four-state machine, exits, bans and prober progress', () => {
  const view = buildStatusView(fakeRuntime() as never, true, ['opencode.ai'])
  assert.equal(view.enabled, true)
  assert.equal(view.state, 'warning')
  assert.equal(view.total, 2)
  assert.equal(view.availableFree, 1)
  assert.equal(view.pinned?.id, 'http://10.0.0.1:3128')
  assert.equal(view.pinned?.strict, true)
  assert.equal(view.exits.length, 2)
  const cooling = view.exits.find((e) => e.id === '1.2.3.4:8080')
  assert.equal(cooling?.cooling, true)
  assert.deepEqual(cooling?.bannedModels, [{ model: 'muse-spark-1.2-contributor-free', state: 'banned', bannedAt: 123 }])
  assert.deepEqual(cooling?.passive, { ok: 12, limited: 2, refused: 0, dead: 1, transport: 0 })
  assert.deepEqual(view.prober, { queued: 0, inFlight: 1, enqueued: 5, completed: 4 })
  assert.equal(view.refill?.admitted, 2)
  // URL count only — subscription URLs never ride the bridge.
  assert.equal(view.subscription?.urlCount, 2)
  assert.equal(view.subscription?.pendingConversion, 2)
  assert.equal('urls' in (view.subscription ?? {}), false)
})

test('status view reports the R1 deferral when routing is deferred', () => {
  const rt = fakeRuntime() as never
  ;(rt as { installer: { enabled: boolean; deferredReason: string | null; install(): void; disable(): void; dispose(): void } }).installer = {
    enabled: false,
    deferredReason: 'deferred: global dispatcher is owned by "RetryAgent" — install dsh-llm-proxy or the IP pool in one profile only, not both (R1)',
    install() {}, disable() {}, dispose() {},
  }
  const view = buildStatusView(rt, false, [])
  assert.equal(view.enabled, false)
  assert.match(view.deferredReason, /RetryAgent/)
})

test('status view degrades to a disabled stub without a runtime', () => {
  const view = buildStatusView(null, false, [])
  assert.equal(view.enabled, false)
  assert.equal(view.total, 0)
  assert.equal(view.pinned, null)
  assert.deepEqual(view.exits, [])
})

// -- bridge: handlers ------------------------------------------------------------

test('probe handlers: scope all/refill/exit dispatch and reject unknowns', async () => {
  const rt = fakeRuntime() as never
  const handlers = makeBridgeHandlers(() => rt, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const all = await handlers.probe({ scope: 'all' })
  assert.deepEqual(all, { ok: true, value: { queued: 2 } })
  const one = await handlers.probe({ scope: 'exit', exitId: 'http://10.0.0.1:3128' })
  assert.deepEqual(one, { ok: true, value: { queued: 1 } })
  const refill = await handlers.probe({ scope: 'refill' })
  assert.deepEqual(refill, { ok: true, value: { refilled: true } })
  const bad = await handlers.probe({ scope: 'nope' })
  assert.equal(bad.ok, false)
  assert.equal((bad as { code: string }).code, 'settings-rejected')
  const missing = await handlers.probe({ scope: 'exit', exitId: 'http://9.9.9.9:1' })
  assert.equal((missing as { code: string }).code, 'unknown-exit')
})

test('probe handlers: scope subscriptions drives the subscription refresh lane', async () => {
  // The card's 立即刷新 button used to send scope 'refill' — the free-source
  // lane — so it never refreshed subscriptions, and `refreshSubscriptions()`
  // was dead code with no bridge path at all.
  let refreshed = 0
  const rt = fakeRuntime({ refreshSubscriptions: async () => { refreshed += 1 } }) as never
  const handlers = makeBridgeHandlers(() => rt, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.probe({ scope: 'subscriptions' })
  assert.equal(refreshed, 1, 'refreshSubscriptions() is actually called')
  // The URL count may ride out; the URLs themselves never do (docs §5.1).
  assert.deepEqual(result, { ok: true, value: { refreshed: true, urlCount: 2 } })
  assert.equal(JSON.stringify(result).includes('http'), false, 'no URL leaks through the bridge')
})

test('probe handlers: scope subscriptions reports no-subscriptions instead of a silent success', async () => {
  // Without a fetcher there is nothing to refresh. Returning ok:true here would
  // reproduce the original "clicked, nothing happened, no feedback" report.
  const rt = fakeRuntime({ subscriptions: null }) as never
  const handlers = makeBridgeHandlers(() => rt, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.probe({ scope: 'subscriptions' })
  assert.equal(result.ok, false)
  assert.equal((result as { code: string }).code, 'no-subscriptions')
})

test('probe handlers: scope subscriptions refuses on a disabled pool, not a crash', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.probe({ scope: 'subscriptions' })
  assert.equal(result.ok, false)
  assert.equal((result as { code: string }).code, 'pool-disabled')
})

test('subscription refresh errors reach the action response', async () => {
  const rt = fakeRuntime({ subscriptions: { urlCount: 1, state: { lastError: 'subscription HTTP 502' } } }) as never
  const handlers = makeBridgeHandlers(() => rt, () => ({ pinnedStrict: false, proxyHosts: [] }))
  assert.deepEqual(await handlers.probe({ scope: 'subscriptions' }), {
    ok: false, code: 'subscription-refresh-failed', message: 'subscription HTTP 502',
  })
})

test('probe handlers: pool-disabled refusal when no runtime', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.probe({ scope: 'all' })
  assert.equal(result.ok, false)
  assert.equal((result as { code: string }).code, 'pool-disabled')
})

// -- bridge: guard + routes --------------------------------------------------------

function fakeRequest(overrides: Record<string, unknown> = {}): { socket: { remoteAddress: string }; headers: Record<string, string> } {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3928' },
    ...overrides,
  }
}

test('guard accepts loopback + canonical host + same-origin, rejects everything else', () => {
  assert.equal(isTrustedBridgeRequest(fakeRequest()), true)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ socket: { remoteAddress: '192.168.1.5' } })), false)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: 'evil.com' } })), false)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: '127.0.0.1.evil.com' } })), false)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: 'localhost:3928' } })), true)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: {} })), false)
  assert.equal(
    isTrustedBridgeRequest(fakeRequest({ headers: { host: '127.0.0.1:3928', origin: 'http://evil.com' } })),
    false,
  )
  assert.equal(
    isTrustedBridgeRequest(fakeRequest({ headers: { host: '127.0.0.1:3928', origin: 'http://127.0.0.1:3928' } })),
    true,
  )
})

test('routes carry the exact paths and POST-only method guard', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const routes = makeBridgeRoutes(handlers, { guard: () => true }) as unknown as Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }>
  assert.deepEqual(
    routes.map((r) => r.path),
    [`${IP_POOL_BRIDGE_PREFIX}/status`, `${IP_POOL_BRIDGE_PREFIX}/models`, `${IP_POOL_BRIDGE_PREFIX}/probe`],
  )
  assert.ok(routes.every((r) => r.kind === 'exact'))

  // method guard: a GET must 405 before any handler runs
  let written: { status?: number; body?: unknown } = {}
  const res = {
    writeHead(status: number) { written.status = status },
    end(body: string) { written.body = JSON.parse(body) },
  }
  await routes[0]!.handler({ method: 'GET', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 405)

  // status happy path via the injected guard
  written = {}
  await routes[0]!.handler({ method: 'POST', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 200)
  assert.equal((written.body as { ok: boolean }).ok, true)

  // probe with unreadable body -> 400 envelope, never a thrown route
  // (routes[2]: pick by path — the route order is part of what this test pins,
  //  but the probe handler itself must be found by name)
  const probeRoute = routes.find((r) => r.path === `${IP_POOL_BRIDGE_PREFIX}/probe`)!
  written = {}
  await probeRoute.handler({ method: 'POST', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 400)
  assert.equal((written.body as { code: string }).code, 'settings-rejected')
})

test('models handler lists S3 static rows plus live catalog through the seam', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }), {
    // 2026-10-16 adaptive probe: muse ids moved into staticFreeModels (verified
    // on the responses lane from this host), so the live-only example must not
    // be a muse id — any live id absent from S3 appends unverified.
    listLiveModels: () => ['jev-1.13-free', 'big-pickle', 'brand-new-model'],
  })
  const result = await handlers.models()
  assert.equal(result.ok, true)
  const value = (result as { value: { models: Array<{ id: string; verified: boolean }> } }).value
  // S3 static list first, all marked verified
  assert.deepEqual(value.models.slice(0, staticFreeModels.length).map((row) => row.verified), staticFreeModels.map(() => true))
  // big-pickle deduped (already static), live-only rows appended unverified
  const ids = value.models.map((row) => row.id)
  assert.equal(ids.indexOf('jev-1.13-free') >= staticFreeModels.length, true, 'live-only row appended after statics')
  assert.equal(ids.lastIndexOf('big-pickle'), ids.indexOf('big-pickle'), 'no duplicate big-pickle')
  assert.equal(value.models.find((row) => row.id === 'brand-new-model')?.verified, false)
})

test('models handler falls back to the static list without a live seam', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.models()
  assert.equal(result.ok, true)
  const value = (result as { value: { models: Array<{ id: string; verified: boolean }> } }).value
  assert.equal(value.models.length, staticFreeModels.length)
  assert.equal(value.models[0]!.id, 'big-pickle')
})

test('bridge routes include /models', () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const routes = makeBridgeRoutes(handlers, { guard: () => true }) as Array<{ path: string }>
  assert.ok(routes.some((r) => r.path === `${IP_POOL_BRIDGE_PREFIX}/models`))
})

test('guard-rejected requests get 403 and never reach the handler', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const routes = makeBridgeRoutes(handlers, { guard: () => false }) as unknown as Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> }>
  let written: { status?: number; body?: unknown } = {}
  const res = {
    writeHead(status: number) { written.status = status },
    end(body: string) { written.body = JSON.parse(body) },
  }
  await routes[0]!.handler({ method: 'POST', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 403)
  assert.deepEqual(written.body, { error: 'forbidden' })
})
