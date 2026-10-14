import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { SubscriptionFetcher } from '../src/pool/subscription-fetcher.ts'

/** The seam's request behaviour, callable on its own so tests can wrap it. */
function seamRequest(url: string, init: { dispatcher: { uri: string } }): Promise<{ statusCode: number; body: { text(): Promise<string> } }> {
  const address = init.dispatcher.uri.replace(/^https?:\/\//, '')
  if (url.includes('ip-api')) {
    return Promise.resolve({
      statusCode: 200,
      body: { text: async () => JSON.stringify({ status: 'success', query: `8.8.${address.length}.1`, countryCode: 'US', city: 'c', country: 'c' }) },
    })
  }
  return Promise.resolve({ statusCode: 200, body: { text: async () => '{"ok":true}' } })
}

/** A fake undici seam: every admission request answers 200 (smoke passes). */
function seam() {
  return {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: seamRequest as never,
  }
}

/** A subscription body fixture: mixed airport content (anytls + plaintext). */
const SUB_BODY = [
  'proxies:',
  '  - name: "机场US"',
  '    type: anytls',
  '    server: us01.example.com',
  '    port: 18888',
  '    password: secret-pw',
  '  - name: "明文HTTP"',
  '    type: http',
  '    server: 1.2.3.4',
  '    port: 8080',
  '  - name: "明文SOCKS"',
  '    type: socks5',
  '    server: 5.6.7.8',
  '    port: 1080',
].join('\n')

function makeFetcher(
  fetchImpl: typeof fetch,
  logger?: { info(message: string): void; warn(message: string): void },
  options: { userAgent?: string } = {},
) {
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam() as never, fetchImpl },
    { logger: logger ?? { info: () => {}, warn: () => {} }, ...options },
  )
  return { pool, fetcher }
}

/** A fetch stub that records the User-Agent of every subscription pull. */
function uaRecorder(seen: Array<string | undefined>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.['user-agent'])
    return new Response('')
  }) as unknown as typeof fetch
}

test('subscription refresh: plaintext nodes smoke into the pool, encrypted park as pending', async () => {
  const { pool, fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  const state = await fetcher.refresh()
  // plaintext nodes admitted through the trusted smoke
  assert.equal(state.plaintextAdmitted, 2)
  assert.ok(pool.has('1.2.3.4:8080'))
  assert.ok(pool.has('5.6.7.8:1080'))
  assert.ok(pool.list().every((n) => n.source === 'subscription'))
  // the anytls node parked for IP-4 conversion, not in the pool
  assert.equal(state.pendingConversion.length, 1)
  assert.equal(state.pendingConversion[0]?.type, 'anytls')
  assert.ok(!pool.has('us01.example.com:18888'))
  assert.equal(state.lastError, '')
})

test('subscription refresh: onAdmitted fires when new nodes enter the pool', async () => {
  // Live regression (2026-10-16): a subscription-only pool (no free exits)
  // never engaged routing, because the free-source refill hook is the ONLY
  // path that installed the dispatcher. Real traffic stayed direct and no
  // subscription exit ever collected 真实流量 data. The fetcher needs its own
  // onAdmitted hook so the runtime can install routing when the first
  // subscription exit lands.
  const { fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  const fired: number[] = []
  fetcher.onAdmitted(() => { fired.push(1) })
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()
  // Two NEW plaintext nodes were admitted this round; the callback fires per
  // new admission (once each), not once per round.
  assert.equal(fired.length, 2, 'the onAdmitted hook fires once per new node admitted')
})

test('subscription refresh: onAdmitted does NOT fire for re-smoked existing nodes', async () => {
  // A refresh re-smokes STALE exits (RESMOKE_AFTER_MS) but they are not NEW
  // admissions — the routing hook must not re-fire (install() is idempotent
  // but noisy) for a node already in the table.
  const { fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  const fired: number[] = []
  fetcher.onAdmitted(() => { fired.push(1) })
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()
  assert.equal(fired.length, 2, 'first refresh admits the two plaintext nodes')

  // Second refresh: same nodes, none stale (fresh smoke), nothing new to admit.
  const before = fired.length
  await fetcher.refresh()
  assert.equal(fired.length, before, 'a re-refresh of fresh nodes does not re-fire onAdmitted')
})

test('subscription refresh: a plaintext node whose link is gone is marked dead, not left unprobed', async () => {
  // The live regression (2026-10-14): 703 of 726 subscription exits sat at
  // 'unknown' with zero facts after a full probe sweep. They had all been
  // probed — this path just never wrote anything on failure, so a
  // verified-dead link was indistinguishable from a never-probed node, both on
  // the settings card and in the rotation (isUsable treats 'unknown' as usable).
  const failing = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) { this.uri = opts.uri }
      uri: string
      close() { return Promise.resolve() }
    },
    // Every request through a candidate dies at the dial: transport class.
    request: (async () => { throw new Error('other side closed') }) as never,
  }
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: failing as never, fetchImpl: (async () => new Response(SUB_BODY)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()

  const rows = pool.list()
  assert.ok(rows.length >= 2, 'the plaintext nodes are still kept in the table')
  for (const row of rows) {
    assert.equal(row.health.state, 'dead', `${row.id} must be dead, not silently unprobed`)
    assert.equal(row.health.lastProbeFailure, 'transport')
  }
  // and therefore out of the rotation
  assert.equal(pool.isUsable(rows[0]!.id, 'space-bunny-free'), false)
})

test('subscription refresh: a refused probe keeps the exit alive instead of striking it dead', async () => {
  // 403 at the tunnel step: the exit works, this model is not served here
  // (§4.2). Striking it dead — what the old blanket failure handling did on
  // the probeAll path — would kill a working route.
  const refusing = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) { this.uri = opts.uri }
      uri: string
      close() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      if (url.includes('ip-api')) {
        // Distinct exit IP per candidate: two addresses sharing one exit IP are
        // one quota bucket and pool.add() correctly refuses the second (§3.1).
        const address = init.dispatcher.uri.replace(/^https?:\/\//, '')
        return { statusCode: 200, body: { text: async () => JSON.stringify({ status: 'success', query: `8.8.${address.length}.1`, countryCode: 'US', city: 'c', country: 'c' }) } }
      }
      return { statusCode: 403, body: { text: async () => '{}' } }
    }) as never,
  }
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: refusing as never, fetchImpl: (async () => new Response(SUB_BODY)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()

  const rows = pool.list()
  assert.ok(rows.length >= 2)
  for (const row of rows) {
    assert.notEqual(row.health.state, 'dead', `${row.id} answered — it must not be dead`)
    assert.equal(row.health.lastProbeFailure, 'refused')
    // one refusal is only 'suspect'; the exit stays usable for other models
    assert.equal(pool.isUsable(row.id, 'other-model'), true)
  }
})

test('subscription fetch failures are reported, never thrown', async () => {
  const { fetcher } = makeFetcher((async () => { throw new Error('ETIMEDOUT') }) as unknown as typeof fetch)
  fetcher.setUrls(['https://dead.example.com/sub'])
  const state = await fetcher.refresh()
  assert.match(state.lastError, /ETIMEDOUT/)
  assert.equal(state.pendingConversion.length, 0)
})

test('a manual refresh joins an ongoing round and exposes running until completion', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requests = 0
  const { fetcher } = makeFetcher((async () => {
    requests++
    await gate
    return new Response('proxies:\n  - name: encrypted\n    type: anytls\n    server: example.test\n    port: 443\n    password: test')
  }) as typeof fetch)
  fetcher.setUrls(['https://example.test/sub'])
  const first = fetcher.refresh()
  let completed = false
  const second = fetcher.refreshNow().then((state) => { completed = true; return state })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(completed, false)
    assert.equal(fetcher.state.running, true)
    assert.equal(requests, 1)
  } finally { release() }
  const results = await Promise.all([first, second])
  assert.equal(fetcher.state.running, false)
  assert.ok(results.every((state) => !state.running && state.lastFetch > 0 && state.pendingConversion.length === 1))
  fetcher.stop()
})

test('subscription URLs are redacted in logs', async () => {
  const logs: string[] = []
  const { fetcher } = makeFetcher(
    (async () => new Response('')) as unknown as typeof fetch,
    { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  )
  fetcher.setUrls(['https://sub.example.com/VerySecretToken1234567890abcdef'])
  await fetcher.refresh()
  // nothing in the log carries the full credential
  assert.ok(logs.every((line) => !line.includes('VerySecretToken1234567890abcdef')))
  assert.ok(logs.some((line) => line.includes('…')))
})

test('stopping during a pull aborts it and prevents fetching later URLs', async () => {
  let calls = 0
  let release!: () => void
  const { pool, fetcher } = makeFetcher((async (_url: string, init: RequestInit) => {
    calls++
    const gate = new Promise<void>((resolve) => { release = resolve })
    await new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { release(); reject(new Error('aborted')) }, { once: true })
    })
    await gate
    return new Response(SUB_BODY)
  }) as typeof fetch)
  fetcher.setUrls(['https://example.test/a', 'https://example.test/b'])
  const round = fetcher.refresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  fetcher.stop()
  await round
  assert.equal(calls, 1)
  assert.equal(fetcher.state.running, false)
  assert.equal(fetcher.state.lastFetch, 0)
  assert.equal(pool.snapshot().total, 0, 'cancelled request does not enqueue pool changes')
  await fetcher.refreshNow()
  assert.equal(calls, 1, 'stopped fetcher cannot restart')
})

test('subscription nodes never enter the pool twice (idempotent refresh)', async () => {
  const { pool, fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  await fetcher.refresh()
  const rows = pool.list().filter((n) => n.source === 'subscription')
  assert.equal(rows.length, 2) // still the same two plaintext nodes
})

// -- fetch User-Agent (airport allow-lists) -----------------------------------

test('subscription pulls send the default User-Agent, not the 502-ing 1.6.0', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen))
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()
  // One pull per URL; the admission smoke rides deps.undici, not fetchImpl.
  assert.deepEqual(seen, ['clash-verge/v2.0'])
  assert.equal(fetcher.userAgent, 'clash-verge/v2.0')
})

test('the fetch UA is configurable and live-updatable without a restart', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen), undefined, { userAgent: 'clash-verge/v2.0.3' })
  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  assert.deepEqual(seen, ['clash-verge/v2.0.3'])

  // A settings save calls setUserAgent and the NEXT refresh must carry it.
  fetcher.setUserAgent('mihomo/1.19.0')
  await fetcher.refresh()
  assert.equal(seen.at(-1), 'mihomo/1.19.0')
})

test('a blank UA falls back to the default instead of sending none', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen), undefined, { userAgent: '   ' })
  assert.equal(fetcher.userAgent, 'clash-verge/v2.0')

  fetcher.setUserAgent('clash-verge/v2.0')
  fetcher.setUserAgent('')
  assert.equal(fetcher.userAgent, 'clash-verge/v2.0')

  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  assert.deepEqual(seen, ['clash-verge/v2.0'])
})

test('a refresh re-smokes only NEW or STALE exits, never the whole table', async () => {
  // The live regression (2026-10-15): every refresh unconditionally re-smoked
  // every converted exit, so a table of a few hundred exits re-queued a few
  // hundred anonymous-lane smokes per round. Measured: `enqueued` climbed past
  // 2600 with only 400 exits present and a 6-hour refresh interval, because
  // each round buried the queue faster than the concurrency cap drained it.
  // Those smokes share the per-exit-IP quota with real traffic — which is how
  // exits showed `ok` while real requests still answered 429.
  //
  // Each node must answer with its OWN exit IP: `pool.add` refuses two
  // addresses sharing one exit IP (§3.1, they are one quota bucket), so a seam
  // that returns a constant IP silently collapses 40 nodes into one entry —
  // which then looks "new" forever and hides the very bug under test.
  let smokes = 0
  const perNodeSeam = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) { this.uri = opts.uri }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      smokes += 1
      const host = init.dispatcher.uri.replace(/^(?:https?|socks5):\/\//, '').split(':')[0] ?? ''
      const last = Number(host.split('.').pop() ?? '0')
      if (url.includes('ip-api')) {
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: `203.0.113.${last}`, countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
  const many = ['proxies:']
  for (let i = 1; i <= 40; i += 1) {
    many.push(`  - {name: "n${i}", type: http, server: 10.0.0.${i}, port: 8080}`)
  }

  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: perNodeSeam as never, fetchImpl: (async () => new Response(many.join('\n'))) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])

  await fetcher.refresh()
  const firstRound = smokes
  assert.ok(firstRound > 0, 'the first refresh probes the new exits')
  assert.equal(pool.list().length, 40, 'all 40 nodes enter the table with distinct exit IPs')

  // Refreshing again seconds later must do NO probe work: their verdicts are
  // fresh, so they are neither new nor stale. Before the fix this was another
  // full round of smokes — measured at 3 requests per exit.
  smokes = 0
  await fetcher.refresh()
  assert.equal(smokes, 0, 'a second refresh burns no anonymous-lane quota on fresh exits')
  assert.equal(pool.list().length, 40, 'the table is unchanged, not duplicated')
})

