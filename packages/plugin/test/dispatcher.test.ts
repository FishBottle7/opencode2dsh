import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import * as realUndici from 'undici'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import {
  PoolRoutingDispatcher,
  exitProxyUri,
  isLoopback,
  normalizeHost,
  routingContext,
} from '../src/pool/dispatcher.ts'
import { RoutingInstaller } from '../src/pool/installer.ts'

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1',
    protocol: 'http',
    source: 'manual',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'US city',
    latencyMs: 300,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

test('normalizeHost strips scheme, port and brackets', () => {
  assert.equal(normalizeHost('https://opencode.ai/zen'), 'opencode.ai')
  assert.equal(normalizeHost('opencode.ai:443'), 'opencode.ai')
  assert.equal(normalizeHost('[2001:db8::1]:1080'), '2001:db8::1')
  assert.ok(isLoopback('127.0.0.1:8080'))
  assert.ok(isLoopback('localhost'))
  assert.ok(!isLoopback('opencode.ai'))
})

test('exitProxyUri maps exit ids to ProxyAgent URIs', () => {
  assert.equal(exitProxyUri('h:1', 'http'), 'http://h:1')
  assert.equal(exitProxyUri('h:1', 'socks5'), 'socks5://h:1')
  assert.equal(exitProxyUri('http://pre.formatted:3', 'http'), 'http://pre.formatted:3')
})

/** A recording fake undici seam: dispatch tags each hop. */
function fakeSeam() {
  const hops: string[] = []
  const makeAgent = (tag: string) => ({
    tag,
    dispatch(_opts: unknown, _handler: unknown): boolean {
      hops.push(tag)
      return true
    },
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  })
  const direct = makeAgent('direct')
  const proxyAgents = new Map<string, ReturnType<typeof makeAgent>>()
  const seam = {
    Agent: class {
      constructor(_options?: unknown) {
        return direct
      }
    },
    ProxyAgent: class {
      constructor(options: { uri: string }) {
        const existing = proxyAgents.get(options.uri)
        if (existing) return existing
        const agent = makeAgent(`proxy:${options.uri}`)
        proxyAgents.set(options.uri, agent)
        return agent
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => direct,
  }
  return { seam, hops, proxyAgents }
}

test('dispatcher: non-pool hosts and loopback go direct; pool hosts route to picked exits', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'p:1', exitIP: '1.1.1.1', latencyMs: 10 }))
  pool.add(node({ id: 'p:2', exitIP: '2.2.2.2', latencyMs: 20 }))
  pool.markOk('p:1')
  pool.markOk('p:2')

  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({
    pool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
  })

  router.dispatch({ origin: 'https://example.com/x' } as never, {} as never)
  assert.deepEqual(hops, ['direct'])

  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/zen/v1/chat/completions' } as never, {} as never)
  })
  assert.equal(hops.length, 2)
  assert.match(hops[1]!, /^proxy:/)
})

test('dispatcher: ALS context selects the exit by model (two-tier health routing)', () => {
  const pool = new ExitPool({ modelBanConfirmations: 2 })
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 10 }))
  pool.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 20 }))
  pool.markOk('a:1')
  pool.markOk('b:2')
  // ban a:1 for muse -> muse must route via b:2
  pool.markModelSignal('a:1', 'muse')
  pool.markModelSignal('a:1', 'muse')

  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })
  routingContext.run({ model: 'muse', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.match(hops[0]!, /b:2/)
  hops.length = 0
  // Same session stays sticky to b:2 even for another model (3.3): b:2 is
  // not banned for 'other', so the sticky exit keeps serving it.
  routingContext.run({ model: 'other', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.match(hops[0]!, /b:2/)
  // A fresh session picks a:1 for 'other' (a:1 is only banned for muse).
  hops.length = 0
  routingContext.run({ model: 'other', session: 's2' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.match(hops[0]!, /a:1/)
})

test('dispatcher: empty/unusable pool falls back to direct, never fails closed', () => {
  const pool = new ExitPool()
  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.deepEqual(hops, ['direct'])
})

test('installer: install/disable swaps the global dispatcher and restores the previous one', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'p:1' }))
  pool.markOk('p:1')
  pool.pin('p:1')

  const { seam } = fakeSeam()
  const installed: unknown[] = []
  const originalDispatcher = { tag: 'original' }
  let current: unknown = originalDispatcher
  const recordingSeam = {
    ...seam,
    setGlobalDispatcher: (dispatcher: unknown) => {
      installed.push(dispatcher)
      const previous = current
      current = dispatcher
      return previous
    },
  }
  const logs: string[] = []
  const installer = new RoutingInstaller({
    pool,
    undici: recordingSeam as never,
    logger: { info: (m) => logs.push(m), warn: () => {} },
  })

  installer.install()
  assert.ok(installer.enabled)
  assert.equal(installed.length, 1)
  assert.ok(installed[0] instanceof PoolRoutingDispatcher)
  assert.ok(logs.some((line) => line.includes('PoolRoutingDispatcher')))

  installer.disable()
  assert.ok(!installer.enabled)
  // second setGlobalDispatcher call restored the original
  assert.equal(installed[1], originalDispatcher)
})

test('end-to-end: builtin fetch routes through a real local proxy via the installer', async () => {
  // The load-bearing integration test (docs/ip-pool.md 2): npm undici's
  // setGlobalDispatcher + our PoolRoutingDispatcher drive the BUILTIN fetch.
  let proxied = 0
  let directHits = 0
  const server = http.createServer((req, res) => {
    // Absolute-URI request => the fetch went through the forward proxy;
    // origin-form => direct. (undici ProxyAgent sends absolute-URI GETs.)
    if (req.url?.startsWith('http://')) {
      proxied += 1
    } else {
      directHits += 1
    }
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as { port: number }
  const port = address.port

  const pool = new ExitPool()
  pool.add(node({ id: `127.0.0.1:${port}`, protocol: 'http', exitIP: '1.2.3.4', latencyMs: 10 }))
  pool.markOk(`127.0.0.1:${port}`)

  const previous = realUndici.getGlobalDispatcher()
  const installer = new RoutingInstaller({
    pool,
    undici: realUndici,
    proxyHosts: ['example.test'], // routes through the pool
    logger: { info: () => {}, warn: () => {} },
  })
  installer.install()
  try {
    // The pinned exit points at the same server, but through ProxyAgent the
    // request arrives with an absolute URI — the server can tell the two
    // paths apart even though they land on one port.
    const response = await fetch(`http://example.test:${port}/e2e`)
    assert.equal(response.status, 200)
    assert.ok(proxied >= 1, 'builtin fetch did not go through the proxy')
  } finally {
    installer.disable()
    realUndici.setGlobalDispatcher(previous)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // Direct path restored after teardown: loopback host bypasses the pool.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const reopenedPort = (server.address() as { port: number }).port
  // (server.close stops accepting but we reopened; fetch a fresh direct URL)
  const after = await fetch(`http://127.0.0.1:${reopenedPort}/after`)
  assert.equal(after.status, 200)
  assert.ok(directHits >= 1)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
