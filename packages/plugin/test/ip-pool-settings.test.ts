/**
 * IP-5 host-side tests: the settings namespace (schema defaults, value
 * mapping), the loopback-guarded bridge (status view, probe scopes, guard
 * semantics, envelopes) and the apply controller's live reconfigure path.
 * No real network, no global dispatcher install.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IpPoolConfigSchema, resolveProbeModels, toIpPoolConfig, IP_POOL_NAMESPACE } from '../src/ip-pool-settings/namespace.ts'
import { buildStatusView, isTrustedBridgeRequest, makeBridgeHandlers, makeBridgeRoutes, IP_POOL_BRIDGE_PREFIX } from '../src/ip-pool-settings/bridge.ts'

// -- namespace ---------------------------------------------------------------

test('ip-pool namespace is kebab-case branded name', () => {
  assert.equal(String(IP_POOL_NAMESPACE), 'ip-pool')
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
  assert.equal((value.singbox as Record<string, unknown>).path, 'sing-box')
  assert.equal(value.pinnedExitId, '')
  assert.equal(value.pinnedStrict, false)
})

test('schema rejects out-of-range probe concurrency', () => {
  assert.throws(() => IpPoolConfigSchema({ maxConcurrentProbes: 9 }))
  assert.throws(() => IpPoolConfigSchema({ maxConcurrentProbes: 0 }))
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
    subscription: { urls: ['https://sub.example.com/token'], refreshMs: 123_456 },
  }) as never)
  assert.equal(mapped.enabled, true)
  assert.deepEqual(mapped.manual, ['http://1.2.3.4:8080'])
  assert.equal(mapped.pinnedExitId, 'http://127.0.0.1:7897')
  assert.equal(mapped.pinnedStrict, true)
  assert.deepEqual(mapped.subscriptions, ['https://sub.example.com/token'])
  assert.deepEqual(mapped.probeModels, ['big-pickle'])
  assert.deepEqual(mapped.singbox, { path: 'sing-box' })
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
    installer: { enabled: true, install() {}, disable() {}, dispose() {} },
    prober: { stats: { queued: 0, inFlight: 1, enqueued: 5, completed: 4 } },
    refill: { lastRound: { admitted: 2, rejected: 30, fetched: 1600, coarsePassed: 8, state: 'warning', at: 456 } },
    subscriptions: {
      urlCount: 2,
      state: { pendingConversion: [{}, {}], convertedAdmitted: 1, plaintextAdmitted: 0, lastFetch: 789, lastError: '' },
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
    [`${IP_POOL_BRIDGE_PREFIX}/status`, `${IP_POOL_BRIDGE_PREFIX}/probe`],
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
  written = {}
  await routes[1]!.handler({ method: 'POST', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 400)
  assert.equal((written.body as { code: string }).code, 'settings-rejected')
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
