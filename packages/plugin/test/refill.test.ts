import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { RefillScheduler } from '../src/pool/refill.ts'
import type { FreeSource } from '../src/pool/sources.ts'

function freeNode(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1',
    protocol: 'http',
    source: 'free',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'US city',
    latencyMs: 100,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

/** Deterministic admission seam: admit 'good:*' addresses, reject the rest. */
function makeAdmission(good: Set<string>) {
  const attempts: string[] = []
  return {
    attempts,
    deps: {
      pool: new ExitPool(),
      undici: {} as never,
      // admitCandidate is imported inside refill; we intercept via the
      // fetchSourceImpl + a patched admit seam through the deps object by
      // giving refill a fake AdmissionDeps.undici whose ProxyAgent throws —
      // but the simplest seam: refill calls admitCandidate directly, so we
      // test through fetch + a stub undici that makes admission succeed for
      // good addresses via the echo script.
    },
  }
}

/** Build a full offline refill stack with a scripted network. */
function makeStack(options: {
  /** addresses each source returns */
  lists: Record<string, string[]>
  /** which admission candidates pass (by address) */
  admitOk: (address: string) => boolean
  /** smoke status per address (default 200; set 429 for the limited path) */
  smokeStatus?: (address: string) => number
  pool?: ExitPool
}) {
  const pool = options.pool ?? new ExitPool({ targetSize: 4 })
  const prober = new Prober({ pool, maxConcurrentProbes: 4 })
  const admissionAttempts: string[] = []
  const fetches: string[] = []

  // Scripted undici seam for admitCandidate: the echo endpoint answers per
  // candidate address (identified by the agent URI), models + smoke OK.
  const echoByAddress = new Map<string, { status: number; body: string }>()
  const transport = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      // the candidate address rides the dispatcher URI (http://addr)
      const address = init.dispatcher.uri.replace(/^https?:\/\//, '')
      if (url.includes('ip-api')) {
        if (!options.admitOk(address)) return { statusCode: 503, body: { text: async () => '' } }
        // distinct exit IPs per address: two addresses sharing one exit IP
        // are one quota bucket and the pool deduplicates them (3.1).
        const ip = `9.9.${address.length}.${address.charCodeAt(address.length - 1) % 250}`
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: ip, countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      if (url.includes('chat/completions')) {
        const status = options.smokeStatus?.(address) ?? 200
        if (status !== 200) return { statusCode: status, body: { text: async () => '' } }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }

  const scheduler = new RefillScheduler(pool, {
    pool,
    prober,
    undici: transport as never,
    zenBaseUrl: 'https://zen.test',
    ipEchoUrl: 'http://ip-api.test/json',
    fetchSourceImpl: (async (source: FreeSource) => {
      fetches.push(source.url)
      const addresses = options.lists[source.url] ?? []
      return { source, addresses: addresses.map((a) => ({ address: a, host: a.split(':')[0] ?? a, port: Number(a.split(':')[1] ?? 0) })) }
    }) as never,
  })
  return { pool, prober, scheduler, fetches, admissionAttempts, transport }
}

test('refill: emergency round fills the pool to quota through admission', async () => {
  const stack = makeStack({
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:1', 'good:2', 'good:3', 'good:4', 'good:5'] },
    admitOk: (a) => a.startsWith('good:'),
  })
  // pool starts empty -> emergency (0 usable of 4)
  assert.equal(stack.pool.state(), 'emergency')
  await stack.scheduler.tick()
  // all good candidates admitted up to the target
  assert.equal(stack.pool.freeCount(), 4)
  // 4/4 usable of target 4 -> healthy again
  assert.equal(stack.pool.state(), 'healthy')
})

test('refill: rejected candidates do not enter the pool; rejects are counted', async () => {
  const stack = makeStack({
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:1', 'bad:1', 'good:2'] },
    admitOk: (a) => a.startsWith('good:'),
  })
  await stack.scheduler.tick()
  assert.equal(stack.pool.freeCount(), 2)
  assert.ok(stack.pool.has('good:1'))
  assert.ok(stack.pool.has('good:2'))
  assert.ok(!stack.pool.has('bad:1'))
  assert.equal(stack.scheduler.lastRound.rejected, 1)
})

test('refill: already-present addresses are not re-admitted (dedupe against the pool)', async () => {
  const pool = new ExitPool({ targetSize: 4 })
  pool.add(freeNode({ id: 'good:1', exitIP: '9.9.9.9' }))
  pool.markOk('good:1')
  const stack = makeStack({
    pool,
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:1', 'good:2'] },
    admitOk: () => true,
  })
  await stack.scheduler.tick()
  assert.equal(stack.pool.freeCount(), 2) // good:1 kept, good:2 added
  assert.ok(stack.pool.has('good:1'))
})

test('refill: healthy pool does not fetch at all', async () => {
  const pool = new ExitPool({ targetSize: 2 })
  pool.add(freeNode({ id: 'a:1', exitIP: '1.1.1.1' }))
  pool.add(freeNode({ id: 'b:2', exitIP: '2.2.2.2' }))
  pool.markOk('a:1')
  pool.markOk('b:2')
  const stack = makeStack({
    pool,
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:1'] },
    admitOk: () => true,
  })
  await stack.scheduler.tick()
  assert.equal(stack.fetches.length, 0, 'healthy pool must not fetch')
  assert.equal(stack.pool.freeCount(), 2)
})

test('refill: source failures trip the breaker and are skipped next round', async () => {
  // One fast-tier source always fails; one slow-tier source serves good nodes.
  // Emergency (round 1) fetches everything -> good nodes fill the pool to
  // quota -> healthy: later rounds never fetch again, so the breaker sees
  // exactly one failure. (The full trip/skip cycle is covered by the breaker
  // unit tests in sources.test.ts.)
  const failingUrl = 'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt'
  const goodUrl = 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt'
  let failureCount = 0
  const stack = makeStack({
    lists: {},
    admitOk: () => true,
  })
  // rebuild with a target-2 pool so two good nodes fill it exactly
  const targetPool = new ExitPool({ targetSize: 2 })
  const prober = new Prober({ pool: targetPool })
  const scheduler = new RefillScheduler(targetPool, {
    pool: targetPool,
    prober,
    undici: stack.transport as never,
    zenBaseUrl: 'https://zen.test',
    ipEchoUrl: 'http://ip-api.test/json',
    fetchSourceImpl: (async (source: FreeSource) => {
      if (source.url === failingUrl) {
        failureCount += 1
        throw new Error('source down')
      }
      const addresses = source.url === goodUrl ? ['good:1', 'good:2'] : []
      return { source, addresses: addresses.map((a) => ({ address: a, host: a, port: 1 })) }
    }) as never,
  })
  await scheduler.tick()
  assert.equal(failureCount, 1)
  assert.ok(targetPool.has('good:1'))
  assert.ok(targetPool.has('good:2'))
  // 2/2 usable of target 2 -> healthy: no more fetches at all
  assert.equal(targetPool.state(), 'healthy')
  await scheduler.tick()
  await scheduler.tick()
  assert.equal(failureCount, 1)
  assert.equal(targetPool.freeCount(), 2)
})

test('refill: admission quota bounds the round; full pool evicts worst on replace', async () => {
  const pool = new ExitPool({ targetSize: 2 })
  // two mediocre nodes already in
  pool.add(freeNode({ id: 'old:1', exitIP: '8.8.8.8', quality: 'C', latencyMs: 3000 }))
  pool.add(freeNode({ id: 'old:2', exitIP: '7.7.7.7', quality: 'C', latencyMs: 2500 }))
  pool.markOk('old:1')
  pool.markOk('old:2')
  // healthy (2/2): no fetch happens at all
  const healthyStack = makeStack({
    pool,
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:1'] },
    admitOk: () => true,
  })
  await healthyStack.scheduler.tick()
  assert.equal(healthyStack.fetches.length, 0)
  // kill one -> quota opens 1 slot; a better candidate replaces flow applies
  pool.markLimited('old:1')
  const stack = makeStack({
    pool,
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:1'] },
    admitOk: () => true,
  })
  await stack.scheduler.tick()
  assert.ok(pool.has('good:1'))
  // replace flow: the pool was full, so the worst C-grade node was evicted
  // to make room for good:1 (S-grade). Count stays at target 2.
  assert.equal(pool.freeCount(), 2)
  assert.ok(!pool.has('old:1') || !pool.has('old:2'))
  // A second round while full and healthy fetches nothing: good:2 stays out.
  const stack2 = makeStack({
    pool,
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:2'] },
    admitOk: () => true,
  })
  await stack2.scheduler.tick()
  assert.equal(stack2.fetches.length, 0)
  assert.ok(!pool.has('good:2'))
})

test('refill: smoke-429 survivors are admitted cooling and do not satisfy the quota', async () => {
  // Live-observed semantics (docs 4.5, 2026-09-05): a candidate whose proxy
  // is alive and whose Zen tunnel works but hits 429 at smoke is a good exit
  // with its quota consumed elsewhere — admit it cooling, keep the state
  // machine hungry for truly-usable nodes, and let the periodic probe retry
  // when the cooldown expires.
  const stack = makeStack({
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['hot:1', 'good:1'] },
    admitOk: () => true,
    smokeStatus: (address) => (address === 'hot:1' ? 429 : 200),
  })
  await stack.scheduler.tick()
  // both admitted: hot:1 cooling, good:1 ok
  assert.ok(stack.pool.has('hot:1'))
  assert.ok(stack.pool.has('good:1'))
  assert.equal(stack.pool.freeCount(), 2)
  // the 429 node is unusable right now (cooling), the ok one is usable
  assert.ok(!stack.pool.isUsable('hot:1', 'big-pickle'))
  assert.ok(stack.pool.isUsable('good:1', 'big-pickle'))
  // availability quota counts only the usable one -> state stays below healthy
  assert.equal(stack.pool.availableFreeCount(), 1)
  assert.notEqual(stack.pool.state(), 'healthy')
})

test('refill: start/stop lifecycle drives one immediate round and the interval', async () => {
  const stack = makeStack({
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:1', 'good:2'] },
    admitOk: () => true,
  })
  stack.scheduler.start()
  // the immediate round ran (pool filled); stop prevents further ticks
  await new Promise((r) => setTimeout(r, 50))
  stack.scheduler.stop()
  const count = stack.fetches.length
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(stack.fetches.length, count)
  assert.equal(stack.pool.freeCount(), 2)
})

// -- live refill progress (docs §5.3 立即补充 feedback) --------------------------

test('coarseScreenBatch onProgress fires per completed screen with live survivor count', async () => {
  const stack = makeStack({ lists: {}, admitOk: (address) => address.startsWith('good:') })
  const samples: Array<[number, number]> = []
  const { coarseScreenBatch } = await import('../src/pool/admission.ts')
  await coarseScreenBatch(
    { undici: stack.transport as never, ipEchoUrl: 'http://ip-api.test/json', logger: { warn: () => {} } },
    [{ address: 'good:1', protocol: 'http' }, { address: 'bad:2', protocol: 'http' }, { address: 'good:3', protocol: 'http' }],
    { fanout: 2, onProgress: (done, passed) => samples.push([done, passed]) },
  )
  assert.equal(samples.length, 3, 'one callback per candidate')
  const dones = samples.map((s) => s[0]).sort((a, b) => a - b)
  assert.deepEqual(dones, [1, 2, 3], 'done counter monotonic')
  const survivors = [...new Set(samples.map((s) => s[1]))].sort((a, b) => a - b)
  assert.deepEqual(survivors, [0, 1, 2], 'survivor count grows with the passing candidates')
})

test('refill progress runs the fetch→coarse→admit stages and settles idle with counters', async () => {
  const stack = makeStack({
    lists: { 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt': ['good:1', 'good:2', 'bad:3', 'good:4'] },
    admitOk: (address) => address.startsWith('good:'),
  })
  const progress = () => stack.scheduler.progress
  // before any round: idle
  assert.equal(progress().running, false)
  assert.equal(progress().stage, 'idle')
  await stack.scheduler.tick()
  const final = progress()
  assert.equal(final.running, false, 'settled after the round')
  assert.equal(final.stage, 'idle')
  assert.ok(final.sourcesTotal > 0, 'source denominator seeded')
  assert.equal(final.sourcesDone, final.sourcesTotal, 'every source answered (ok or failed)')
  assert.ok(final.fetched > 0, 'fetched counter ran')
  assert.ok(final.candidates > 0, 'candidate counter ran')
  assert.ok(final.coarseDone > 0, 'coarse screens completed')
  assert.equal(final.admissions > 0, true, 'fine-screen tasks completed')
  assert.ok(final.admitted > 0, 'at least one good candidate admitted')
  stack.scheduler.stop()
})
