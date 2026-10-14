import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { PeriodicProber } from '../src/pool/periodic-prober.ts'

let clock = 5_000_000
const now = () => clock

function pool(options: ConstructorParameters<typeof ExitPool>[0] = {}) {
  return new ExitPool({ now, ...options })
}

function node(overrides: Partial<ExitNode> = {}): ExitNode {
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

// -- regression: never-measured latency must not outrank measured exits -------

test('pick: an unmeasured exit (latencyMs 0) sorts behind every measured exit', () => {
  const p = pool()
  // The live regression: 6 healthy free exits at 159-345ms vs never-probed
  // subscription nodes carrying latencyMs 0.
  for (let i = 0; i < 6; i += 1) {
    p.add(node({ id: `free-${i}`, source: 'free', exitIP: `10.0.0.${i}`, latencyMs: 160 + i * 30 }))
    p.markOk(`free-${i}`)
  }
  p.add(node({ id: 'unmeasured:1', source: 'subscription', exitIP: '10.9.0.1', latencyMs: 0 }))

  const picks = new Set<string>()
  for (let i = 0; i < 60; i += 1) picks.add(p.pick(`s${i}`, 'm')!)
  assert.ok(!picks.has('unmeasured:1'), 'a never-measured exit must not be picked over measured ones')
  // the measured exits are the only candidates, and the best of them leads
  assert.ok([...picks].every((id) => id.startsWith('free-')))
  assert.ok(picks.size >= 1)
})

test('pick: an unmeasured exit never wins even when it is the only non-cooling one', () => {
  const p = pool()
  p.add(node({ id: 'measured:1', source: 'free', exitIP: '1.1.1.1', latencyMs: 900 }))
  p.markOk('measured:1')
  p.add(node({ id: 'unmeasured:1', source: 'subscription', exitIP: '2.2.2.2', latencyMs: 0 }))
  p.add(node({ id: 'unmeasured:2', source: 'subscription', exitIP: '3.3.3.3', latencyMs: 0 }))
  // the measured exit is slow (900ms) but real; both unmeasured ones are
  // infinitely slower because they were never measured at all.
  assert.equal(p.pick('s1', 'm'), 'measured:1')
})

test('pick: an unmeasured exit is still usable once nothing measured remains (never fail closed)', () => {
  const p = pool()
  p.add(node({ id: 'unmeasured:1', source: 'subscription', exitIP: '10.9.0.1', latencyMs: 0 }))
  assert.equal(p.pick('s1', 'm'), 'unmeasured:1')
})

// -- regression: rotate must not re-pick the exit that just failed ------------

test('avoid: the exit that just failed is skipped by the next pick (§3.4 rotate)', () => {
  const p = pool()
  for (let i = 0; i < 4; i += 1) {
    p.add(node({ id: `sub-${i}`, source: 'subscription', exitIP: `10.1.0.${i}`, latencyMs: 100 + i }))
    p.markOk(`sub-${i}`)
  }
  const session = 'rotate-session'
  const picks: string[] = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const exit = p.pick(session, 'm')!
    picks.push(exit)
    // A first 403 is only 'suspect' (the ban needs a second sample) and a 5xx
    // deliberately does not strike the exit dead, so isUsable stays true.
    p.recordPassive(exit, 403, 'm')
    p.avoid(exit)
    p.rerouteSession(session)
  }
  assert.equal(new Set(picks).size, picks.length, `rotate re-picked an exit: ${picks.join(' -> ')}`)
})

test('avoid: an expired window returns the exit to rotation', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 100 }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 110 }))
  p.markOk('a:1')
  p.markOk('b:2')
  p.avoid('a:1')
  for (let i = 0; i < 20; i += 1) assert.notEqual(p.pick(`s${i}`, 'm'), 'a:1')
  clock += 31_000
  const after = new Set<string>()
  for (let i = 0; i < 40; i += 1) after.add(p.pick(`s${i}`, 'm')!)
  assert.ok(after.has('a:1'), 'the exit must return to rotation after the window')
})

test('avoid: an all-avoiding pool still answers instead of going direct', () => {
  const p = pool()
  p.add(node({ id: 'only:1', exitIP: '1.1.1.1', latencyMs: 100 }))
  p.markOk('only:1')
  p.avoid('only:1')
  assert.equal(p.pick('s', 'm'), 'only:1')
})

// -- regression: ban bookkeeping stays correct behind the per-exit index ------

test('per-exit ban index: isAvailable prefers the index but agrees with the ban map', () => {
  const p = pool({ targetSize: 10 })
  p.add(node({ id: 'f:1', source: 'free', exitIP: '1.1.1.1' }))
  p.add(node({ id: 'f:2', source: 'free', exitIP: '2.2.2.2' }))
  assert.equal(p.availableFreeCount(), 2)

  // one model banned but another healthy -> still available
  p.markModelBanned('f:1', 'm-a')
  p.markOk('f:1', 'm-b')
  assert.equal(p.availableFreeCount(), 2)

  // every model banned -> exhausted
  p.markModelBanned('f:1', 'm-b')
  assert.equal(p.availableFreeCount(), 1)
  assert.ok(p.list().find((e) => e.id === 'f:1')!.bans.length === 2)
})

test('remove: dropping a node clears its ban index and avoid window', () => {
  const p = pool()
  p.add(node({ id: 'f:1', source: 'free', exitIP: '1.1.1.1' }))
  p.markModelBanned('f:1', 'm')
  p.avoid('f:1')
  p.remove('f:1')
  assert.equal(p.has('f:1'), false)
  // re-adding the same id must not inherit stale bans
  p.add(node({ id: 'f:1', source: 'free', exitIP: '1.1.1.1' }))
  assert.equal(p.list().find((e) => e.id === 'f:1')!.bans.length, 0)
  assert.equal(p.isUsable('f:1', 'm'), true)
})

// -- periodic prober: the loop docs §4.3 promises ----------------------------

test('PeriodicProber.select: prioritizes dead, cooled, never-probed and suspect exits', () => {
  const p = pool()
  p.add(node({ id: 'dead:1', source: 'subscription', exitIP: '1.1.1.1', latencyMs: 0 }))
  p.markDead('dead:1')
  p.add(node({ id: 'cooled:1', source: 'free', exitIP: '2.2.2.2', latencyMs: 300 }))
  p.markOk('cooled:1')
  p.markLimited('cooled:1')
  p.add(node({ id: 'never:1', source: 'subscription', exitIP: '3.3.3.3', latencyMs: 0 }))
  p.add(node({ id: 'suspect:1', source: 'free', exitIP: '4.4.4.4', latencyMs: 200 }))
  p.markOk('suspect:1')
  p.markModelSignal('suspect:1', 'm')
  p.add(node({ id: 'healthy:1', source: 'free', exitIP: '5.5.5.5', latencyMs: 150 }))
  p.markOk('healthy:1')

  const prober = new PeriodicProber(p, async () => {}, { now })
  // still cooling -> not selected yet
  const during = new Set(prober.select().map((c) => c.id))
  assert.ok(during.has('dead:1'))
  assert.ok(during.has('never:1'))
  assert.ok(during.has('suspect:1'))
  assert.ok(!during.has('cooled:1'), 'a still-cooling exit wastes quota if probed')
  assert.ok(!during.has('healthy:1'), 'a healthy exit needs no probe')

  // cooldown expires -> it becomes a probe candidate
  clock += 61_000
  assert.ok(new Set(prober.select().map((c) => c.id)).has('cooled:1'))
})

test('PeriodicProber: skips exits whose probe is already in flight (per-exit serial)', () => {
  const p = pool()
  p.add(node({ id: 'busy:1', source: 'free', exitIP: '1.1.1.1', latencyMs: 0 }))
  p.add(node({ id: 'idle:1', source: 'free', exitIP: '2.2.2.2', latencyMs: 0 }))
  assert.equal(p.takeProbeLock('busy:1'), true)
  const prober = new PeriodicProber(p, async () => {}, { now })
  const ids = prober.select().map((c) => c.id)
  assert.deepEqual(ids, ['idle:1'])
})

test('PeriodicProber.tick: enqueues the selected exits and honors the per-round cap', async () => {
  const p = pool()
  for (let i = 0; i < 5; i += 1) p.add(node({ id: `n-${i}`, source: 'free', exitIP: `10.0.0.${i}`, latencyMs: 0 }))
  const queued: string[] = []
  const prober = new PeriodicProber(p, async (id) => { queued.push(id) }, { now, maxPerRound: 3 })
  await prober.tick()
  assert.equal(queued.length, 3)
  assert.deepEqual(prober.stats.lastQueued, 3)
  assert.ok(prober.stats.lastRunAt > 0)
})

test('PeriodicProber: stop() prevents further rounds', async () => {
  const p = pool()
  p.add(node({ id: 'n-0', source: 'free', exitIP: '10.0.0.1', latencyMs: 0 }))
  const queued: string[] = []
  const prober = new PeriodicProber(p, async (id) => { queued.push(id) }, { now })
  prober.start()
  prober.stop()
  await prober.tick()
  assert.deepEqual(queued, [])
})
