import test from 'node:test'
import assert from 'node:assert/strict'
import { ANYTLS_SUBSCRIPTION } from './fixtures/anytls.ts'

import { buildOutbound, generateConfig, nodeKeyOf, SingBoxSupervisor } from '../src/pool/singbox.ts'
import { parseSubscription, type ParsedNode } from '../src/pool/subscription.ts'
import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { SubscriptionFetcher } from '../src/pool/subscription-fetcher.ts'

// -- outbound mapping matrix --------------------------------------------------

function vmessNode(overrides: Partial<ParsedNode> = {}): ParsedNode {
  return {
    name: 'vmess-node',
    type: 'vmess',
    server: 'v.example.com',
    port: 443,
    raw: {
      type: 'vmess', name: 'vmess-node', server: 'v.example.com', port: 443,
      uuid: 'uuid-1', alterId: 0, cipher: 'auto',
      tls: true, network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
    },
    ...overrides,
  }
}

test('buildOutbound: vmess maps uuid/security/TLS/ws transport', () => {
  const out = buildOutbound(vmessNode(), 'out-node-0')
  assert.deepEqual(out, {
    tag: 'out-node-0', type: 'vmess', server: 'v.example.com', server_port: 443,
    uuid: 'uuid-1', alter_id: 0, security: 'auto',
    tls: { enabled: true },
    transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } },
  })
})

test('buildOutbound: trojan/vless/hysteria2/tuic map their credentials', () => {
  const trojan = buildOutbound({
    name: 't', type: 'trojan', server: 't.example.com', port: 443,
    raw: { type: 'trojan', password: 'pw', sni: 't.example.com', 'skip-cert-verify': true },
  }, 'out-t')
  assert.equal(trojan?.type, 'trojan')
  assert.equal(trojan?.password, 'pw')
  assert.deepEqual(trojan?.tls, { enabled: true, server_name: 't.example.com', insecure: true })

  const vless = buildOutbound({
    name: 'v', type: 'vless', server: 'vl.example.com', port: 443,
    raw: { type: 'vless', uuid: 'u1', flow: 'xtls-rprx-vision', 'reality-opts': { 'public-key': 'pk', 'short-id': 'sid' } },
  }, 'out-v')
  assert.equal(vless?.flow, 'xtls-rprx-vision')
  assert.deepEqual(vless?.tls, {
    enabled: true,
    reality: { enabled: true, public_key: 'pk', short_id: 'sid' },
  })

  const hy2 = buildOutbound({
    name: 'h', type: 'hysteria2', server: 'h.example.com', port: 443,
    raw: { type: 'hysteria2', password: 'pw2' },
  }, 'out-h')
  assert.deepEqual(hy2, { tag: 'out-h', type: 'hysteria2', server: 'h.example.com', server_port: 443, password: 'pw2' })

  const tuic = buildOutbound({
    name: 'tu', type: 'tuic', server: 'q.example.com', port: 443,
    raw: { type: 'tuic', uuid: 'u', password: 'p' },
  }, 'out-tu')
  assert.equal(tuic?.congestion_control, 'bbr')
})

test('buildOutbound: anytls forces TLS on (GoProxy forceTLS)', () => {
  const out = buildOutbound({
    name: 'a', type: 'anytls', server: 'a.example.com', port: 18888,
    raw: { type: 'anytls', password: 'pw', sni: 'a.example.com' },
  }, 'out-a')
  assert.equal(out?.type, 'anytls')
  assert.deepEqual(out?.tls, { enabled: true, server_name: 'a.example.com' })
})

test('buildOutbound: unknown types return null (skipped)', () => {
  assert.equal(buildOutbound({
    name: 'x', type: 'wireguard', server: 'x', port: 1, raw: {},
  }, 'out-x'), null)
})

test('buildOutbound: only sing-box-valid uTLS fingerprints reach the config', () => {
  // Live regression (2026-10-13): 2 nodes carried `client-fingerprint: unsafe`
  // (v2ray's spelling for "no uTLS"), and because all 470 nodes shared one
  // config and one `sing-box check` preflight, the whole batch failed:
  //   FATAL[0000] initialize outbound[140]: unknown uTLS fingerprint: unsafe
  type TlsView = { enabled?: boolean; server_name?: string; utls?: { enabled: boolean; fingerprint: string } }
  const tlsOf = (out: Record<string, unknown> | null): TlsView => (out?.tls ?? {}) as TlsView

  const valid = ['chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized']
  for (const fingerprint of valid) {
    const out = buildOutbound({
      name: 'v', type: 'vless', server: 'v.example.com', port: 443,
      raw: { type: 'vless', uuid: 'u', sni: 'v.example.com', 'client-fingerprint': fingerprint },
    }, 'out-v')
    assert.deepEqual(tlsOf(out).utls, { enabled: true, fingerprint }, `${fingerprint} must survive`)
  }
  // 'unsafe' means "do not use uTLS": the block is dropped, TLS itself stays.
  const unsafe = buildOutbound({
    name: 'v', type: 'vless', server: 'v.example.com', port: 443,
    raw: { type: 'vless', uuid: 'u', sni: 'v.example.com', 'client-fingerprint': 'unsafe' },
  }, 'out-v')
  assert.equal(tlsOf(unsafe).utls, undefined, 'an unknown fingerprint must not reach sing-box')
  assert.equal(tlsOf(unsafe).enabled, true, 'dropping uTLS must not drop TLS')
  assert.equal(tlsOf(unsafe).server_name, 'v.example.com')
  // case-insensitive: real subscriptions are not consistent
  const upper = buildOutbound({
    name: 'v', type: 'vless', server: 'v.example.com', port: 443,
    raw: { type: 'vless', uuid: 'u', 'client-fingerprint': 'Chrome' },
  }, 'out-v')
  assert.deepEqual(tlsOf(upper).utls, { enabled: true, fingerprint: 'chrome' })
})

test('generateConfig: a batch mixing an unknown fingerprint stays generatable', () => {
  // The mapper is the first line of defence; the binary-level bisect in
  // SingBoxSupervisor is the second. Here we only pin that the mapper no longer
  // emits the value that aborted the shared preflight.
  const good = vmessNode()
  const bad = {
    name: 'bad', type: 'vless', server: 'b.example.com', port: 443,
    raw: { type: 'vless', uuid: 'u2', sni: 'b.example.com', 'client-fingerprint': 'unsafe' },
  } satisfies ParsedNode
  const { config, portMap } = generateConfig([good, bad], 30_000)
  const cfg = config as { outbounds: Array<{ tls?: { utls?: { fingerprint?: string } } }> }
  assert.equal(portMap.size, 2, 'both nodes keep a port')
  const fingerprints = cfg.outbounds.map((o) => o.tls?.utls?.fingerprint).filter(Boolean)
  assert.ok(!fingerprints.includes('unsafe'))
})

test('generateConfig: per-node inbound/outbound/rule with ascending ports + direct default', () => {
  const nodes = [vmessNode(), vmessNode({ name: 'second', server: 'v2.example.com', raw: { type: 'vmess', uuid: 'u2' } })]
  const { config, portMap } = generateConfig(nodes, 30_000)
  const cfg = config as {
    inbounds: Array<{ tag: string; listen: string; listen_port: number; type: string }>
    outbounds: Array<{ tag: string; type: string }>
    route: { rules: Array<{ inbound: string[]; outbound: string }>; final: string }
  }
  assert.deepEqual(cfg.inbounds.map((inbound) => inbound.listen_port), [30_001, 30_002])
  assert.ok(cfg.inbounds.every((inbound) => inbound.listen === '127.0.0.1' && inbound.type === 'socks'))
  // direct default outbound appended last
  assert.equal(cfg.outbounds[cfg.outbounds.length - 1]?.tag, 'direct')
  assert.equal(cfg.route.final, 'direct')
  // rules wire each inbound to its outbound
  assert.deepEqual(cfg.route.rules[0], { inbound: ['in-node-0'], outbound: 'out-node-0' })
  // portMap keys are GoProxy node keys
  assert.deepEqual([...portMap.values()], [30_001, 30_002])
  assert.equal(portMap.get(nodeKeyOf(nodes[0]!)), 30_001)
})

test('generateConfig: unsupported nodes are skipped without burning a port', () => {
  const nodes = [
    { name: 'bad', type: 'wireguard', server: 'x', port: 1, raw: {} },
    vmessNode(),
  ] satisfies ParsedNode[]
  const { config, portMap } = generateConfig(nodes, 30_000)
  const cfg = config as { inbounds: unknown[]; outbounds: unknown[] }
  assert.equal(cfg.inbounds.length, 1)
  assert.equal(cfg.outbounds.length, 2) // vmess + direct
  assert.equal(portMap.size, 1)
})

// -- conversion pipeline (fetcher + supervisor seam) ---------------------------

test('subscription refresh with supervisor: encrypted nodes convert and smoke into the pool', async () => {
  const fixture = ANYTLS_SUBSCRIPTION
  const report = parseSubscription(fixture)
  assert.equal(report.nodes.length, 38)

  const pool = new ExitPool()
  const prober = new Prober({ pool })
  // A fake supervisor: converts every node to a local address without a
  // real binary (the SingBoxSupervisor's process paths are covered by the
  // config-generation tests; the fetcher only needs the seam contract).
  const converted: Array<{ address: string; protocol: 'socks5'; node: ParsedNode }> = []
  const supervisor = {
    async reload(nodes: ParsedNode[]) {
      for (const [index, node] of nodes.entries()) {
        converted.push({ address: `127.0.0.1:${31000 + index}`, protocol: 'socks5', node })
      }
      return converted
    },
    async stop() {},
    get running() {
      return true
    },
  }
  const seam = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      const address = init.dispatcher.uri.replace(/^[a-z0-9+.-]+:\/\//, '')
      if (url.includes('ip-api')) {
        // exit IP derived from the port so distinct local ports are
        // distinct quota buckets (the pool dedupes shared exit IPs, 3.1)
        const port = address.split(':')[1] ?? '0'
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: `7.7.${Number(port) % 250}.${(Number(port) / 250) | 0}`, countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam as never, supervisor, fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  const state = await fetcher.refresh()
  // all 38 anytls nodes converted and admitted (trusted smoke always passes here)
  assert.equal(state.convertedAdmitted, 38)
  assert.equal(state.pendingConversion.length, 0)
  assert.equal(pool.list().length, 38)
  assert.ok(pool.list().every((entry) => entry.source === 'subscription'))
  // addresses are the local converted ports
  assert.ok(pool.has('127.0.0.1:31000'))
  assert.ok(pool.has('127.0.0.1:31037'))
})

test('subscription refresh without supervisor: encrypted nodes park as pending', async () => {
  const fixture = ANYTLS_SUBSCRIPTION
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: {} as never, fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  const state = await fetcher.refresh()
  assert.equal(state.pendingConversion.length, 38)
  assert.equal(state.convertedAdmitted, 0)
  assert.equal(pool.list().length, 0)
})

test('supervisor: reload([]) stops cleanly; missing binary surfaces a clear error', async () => {
  const supervisor = new SingBoxSupervisor({
    binPath: 'definitely-not-on-path-sing-box',
    dataDir: 'test-tmp-singbox',
    logger: { info: () => {}, warn: () => {} },
  })
  // empty node list never touches the binary
  const exits = await supervisor.reload([])
  assert.deepEqual(exits, [])
  assert.ok(!supervisor.running)
  // a binary that cannot be resolved rejects with an actionable message
  await assert.rejects(() => supervisor.reload([vmessNode()]), /not found/i)
})

// Regression, issue #106: every converted exit is one local port of ONE
// sing-box process, but until the watchdog existed a crash was only ever
// repaired by the next subscription refresh (default 30min) — while real
// traffic struck every exit dead one by one through the dead local ports.
test('supervisor: an unexpected child exit is restarted by the watchdog; an intentional stop is not', async () => {
  interface FakeChild {
    pid: number
    exitCode: number | null
    stderr: { on(): void }
    once(event: string, cb: (arg?: unknown) => void): void
    kill(): boolean
    emit(event: string, code?: number): void
  }
  const runChildren: FakeChild[] = []
  const spawned: string[][] = []
  const fakeChild = (): FakeChild => {
    const listeners = new Map<string, Array<(arg?: unknown) => void>>()
    const child: FakeChild = {
      pid: 10_000 + runChildren.length,
      exitCode: null,
      stderr: { on() {} },
      once(event, cb) { listeners.set(event, [...(listeners.get(event) ?? []), cb]) },
      kill() { return true },
      emit(event, code) {
        if (event === 'exit') child.exitCode = code ?? 0
        for (const cb of listeners.get(event) ?? []) cb(code)
      },
    }
    return child
  }
  const spawnFn = ((_binary: string, args: string[]) => {
    spawned.push(args)
    const child = fakeChild()
    if (args[0] === 'version' || args[0] === 'check') {
      queueMicrotask(() => child.emit('exit', 0))
    } else if (args[0] === 'run') {
      runChildren.push(child)
    }
    return child as unknown as import('node:child_process').ChildProcess
  }) as typeof import('node:child_process').spawn

  const warns: string[] = []
  const supervisor = new SingBoxSupervisor({
    // a path that exists (resolveBinary's existsSync), never actually spawned
    binPath: process.execPath,
    dataDir: 'test-tmp-singbox-watchdog',
    basePort: 39_123,
    // > the 500ms readiness poll so a mid-startup crash is actually noticed
    // (the loop checks #running once per iteration, before its 500ms sleep)
    readyTimeoutMs: 1_500,
    spawnFn,
    logger: { info: () => {}, warn: (message) => { warns.push(message) } },
  })

  // First reload: the run child "crashes" while the readiness wait is still
  // polling (the crash-during-startup window) — reload must surface that AND
  // the watchdog must still be scheduled despite reload being in flight.
  // POLL for the run child instead of sleeping a fixed gap: reload does real
  // filesystem work (mkdir + config write) before spawning, and under AV/load
  // a fixed 50ms sometimes ran before the child existed (TypeError instead of
  // the crash being delivered — the flake this test shipped with).
  const first = supervisor.reload([vmessNode()])
  const spawnDeadline = Date.now() + 5_000
  while (runChildren.length === 0 && Date.now() < spawnDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(runChildren.length > 0, 'the run child spawned within the deadline')
  runChildren[0]!.emit('exit', 1)
  await assert.rejects(() => first, /exited immediately/i)
  assert.equal(supervisor.running, false)
  assert.ok(warns.some((message) => message.includes('watchdog restart #1')),
    'a crash inside the startup window still schedules the watchdog')

  // The watchdog fires on its own (base backoff 1s) and rebuilds the tunnel
  // with the SAME node list — no subscription refresh involved.
  const deadline = Date.now() + 5_000
  while (!supervisor.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(supervisor.running, true, 'the watchdog restart brought sing-box back')
  const runs = () => spawned.filter((args) => args[0] === 'run').length
  assert.equal(runs(), 2, 'exactly one watchdog restart, same nodes')
  assert.ok(supervisor.portMap.has(nodeKeyOf(vmessNode())), 'the restart rebuilt the port map')

  // An INTENTIONAL teardown must leave the watchdog disarmed: let the second
  // child exit (which arms the next backoff timer on its own), then stop() —
  // the pending restart must be cancelled, not fire.
  spawned.length = 0
  runChildren[1]!.emit('exit', 0) // exitCode set -> stop() takes the no-kill path
  await supervisor.stop()
  await new Promise((resolve) => setTimeout(resolve, 2_300))
  assert.equal(runs(), 0, 'stop() cancels the pending watchdog restart; a stopped pool stays stopped')
  assert.equal(supervisor.running, false)
})
