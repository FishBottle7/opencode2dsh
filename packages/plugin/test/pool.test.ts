import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, gradeOf, type ExitNode } from '../src/pool/pool.ts'

let clock = 1_000_000
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
    latencyMs: 300,
    quality: 'S',
    addedAt: clock,
    ...overrides,
  }
}

test('gradeOf follows the GoProxy thresholds', () => {
  assert.equal(gradeOf(100), 'S')
  assert.equal(gradeOf(500), 'S')
  assert.equal(gradeOf(501), 'A')
  assert.equal(gradeOf(1000), 'A')
  assert.equal(gradeOf(1001), 'B')
  assert.equal(gradeOf(2000), 'B')
  assert.equal(gradeOf(2001), 'C')
})

test('add rejects duplicate exit IPs across different addresses (one quota bucket)', () => {
  const p = pool()
  assert.ok(p.add(node({ id: 'a:1', exitIP: '9.9.9.9' })))
  assert.ok(!p.add(node({ id: 'b:2', exitIP: '9.9.9.9' })))
  // same address (re-admission) is fine
  assert.ok(p.add(node({ id: 'a:1', exitIP: '9.9.9.9' })))
  // pinned nodes may keep an empty exitIP (3.1 Clash/leased-line fallback)
  assert.ok(p.add(node({ id: 'c:3', exitIP: '', source: 'manual' })))
})

test('429 cooldown is exit-level with exponential backoff (rule table 4.2)', () => {
  const p = pool({ limitedCooldownBaseMs: 60_000, limitedCooldownMaxMs: 30 * 60_000 })
  p.add(node({ id: 'a:1' }))
  p.markOk('a:1')

  const first = p.markLimited('a:1')
  assert.equal(first, now() + 60_000)
  assert.ok(!p.isUsable('a:1', 'm'))
  // another exit keeps serving — the 429 never affects peers
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))
  p.markOk('b:2')
  assert.ok(p.isUsable('b:2', 'm'))

  const second = p.markLimited('a:1')
  assert.equal(second, now() + 120_000)

  // cooldown elapses -> usable again; success resets the backoff ladder
  clock += 121_000
  assert.ok(p.isUsable('a:1', 'm'))
  p.markOk('a:1')
  assert.equal(p.markLimited('a:1'), now() + 60_000)
})

test('401/403 is model-level: suspect -> banned, never cools the exit (rule table 4.2)', () => {
  const p = pool({ modelBanConfirmations: 2 })
  p.add(node({ id: 'a:1' }))
  p.markOk('a:1')

  assert.equal(p.markModelSignal('a:1', 'muse'), 'suspect')
  // suspect does NOT remove the exit from rotation (could be transient)
  assert.ok(p.isUsable('a:1', 'muse'))
  assert.equal(p.markModelSignal('a:1', 'muse'), 'banned')
  assert.ok(!p.isUsable('a:1', 'muse'))
  // the same exit still serves every other model
  assert.ok(p.isUsable('a:1', 'big-pickle'))

  // success clears the ban
  p.markOk('a:1', 'muse')
  assert.ok(p.isUsable('a:1', 'muse'))
})

test('dead strikes: free nodes are evicted, other sources only disabled (3.5)', () => {
  const p = pool({ deadEvictions: 2 })
  p.add(node({ id: 'free:1', source: 'free' }))
  p.add(node({ id: 'manual:1', source: 'manual', exitIP: '3.3.3.3' }))

  assert.equal(p.markDeadStrike('free:1'), false)
  assert.equal(p.markDeadStrike('manual:1'), false)
  assert.ok(p.has('manual:1'))
  assert.ok(!p.isUsable('manual:1', 'm'))

  assert.equal(p.markDeadStrike('free:1'), true)
  assert.ok(!p.has('free:1'))
})

test('pick: pinned wins while usable; rotation otherwise (3.3/3.6)', () => {
  const p = pool()
  p.add(node({ id: 'pinned:1', source: 'manual', exitIP: '5.5.5.5', latencyMs: 900 }))
  p.add(node({ id: 'rot:1', exitIP: '6.6.6.6', latencyMs: 100 }))
  p.add(node({ id: 'rot:2', exitIP: '7.7.7.7', latencyMs: 200 }))
  p.markOk('pinned:1')
  p.markOk('rot:1')
  p.markOk('rot:2')

  assert.ok(p.pin('pinned:1'))
  assert.equal(p.pick('ses-a', 'm'), 'pinned:1')

  // pinned 429 -> falls to rotation while it cools
  p.markLimited('pinned:1')
  const rotated = p.pick('ses-a', 'm')
  assert.ok(rotated === 'rot:1' || rotated === 'rot:2')

  // cooldown expires -> pinned returns
  clock += 61_000
  assert.equal(p.pick('ses-a', 'm'), 'pinned:1')
})

test('pick: pinned banned for one model routes only that model away (3.6)', () => {
  const p = pool({ modelBanConfirmations: 2 })
  p.add(node({ id: 'pinned:1', source: 'manual', exitIP: '5.5.5.5' }))
  p.add(node({ id: 'rot:1', exitIP: '6.6.6.6' }))
  p.markOk('pinned:1')
  p.markOk('rot:1')
  p.pin('pinned:1')

  p.markModelSignal('pinned:1', 'muse')
  p.markModelSignal('pinned:1', 'muse')
  assert.equal(p.pick('ses-a', 'muse'), 'rot:1')
  assert.equal(p.pick('ses-a', 'big-pickle'), 'pinned:1')
})

test('pick: session stickiness keeps one conversation on one exit (3.3)', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 100 }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 120 }))
  p.markOk('a:1')
  p.markOk('b:2')

  const first = p.pick('ses-1', 'm')
  const second = p.pick('ses-1', 'm')
  assert.ok(first !== null)
  assert.equal(first, second)
  // a different session may land elsewhere
  assert.ok(typeof p.pick('ses-2', 'm') === 'string')

  // stickiness breaks when the sticky exit cools
  p.markLimited(first)
  assert.notEqual(p.pick('ses-1', 'm'), first)
})

test('pick: null when everything is unusable (direct fallback decision, 3.3)', () => {
  const p = pool()
  p.add(node({ id: 'a:1' }))
  p.markDead('a:1')
  assert.equal(p.pick('ses', 'm'), null)
})

test('four-state machine thresholds over the free pool (3.5)', () => {
  const p = pool({ targetSize: 10 })
  const addFree = (n: number) => {
    for (let i = 0; i < n; i++) p.add(node({ id: `f:${i}`, exitIP: `10.0.0.${i}`, latencyMs: 100 + i }))
  }
  assert.equal(p.state(), 'emergency') // 0 usable of 10

  addFree(10)
  for (let i = 0; i < 10; i++) p.markOk(`f:${i}`)
  assert.equal(p.state(), 'healthy') // 10/10

  p.markLimited('f:0') // 9/10 = 0.9 < 0.95
  assert.equal(p.state(), 'warning')

  for (let i = 1; i < 8; i++) p.markLimited(`f:${i}`) // 2/10 = 0.2
  assert.equal(p.state(), 'critical')

  for (let i = 8; i < 10; i++) p.markLimited(`f:${i}`) // 0/10
  assert.equal(p.state(), 'emergency')

  // manual/pinned nodes never count toward the free pool state
  p.add(node({ id: 'm:1', source: 'manual', exitIP: '8.8.8.8' }))
  p.markOk('m:1')
  assert.equal(p.state(), 'emergency')
})

test('admission quota, capacity and worst-free eviction (3.5)', () => {
  const p = pool({ targetSize: 2 })
  p.add(node({ id: 'f:0', exitIP: '1.1.1.1', latencyMs: 100, quality: 'S' }))
  p.add(node({ id: 'f:1', exitIP: '2.2.2.2', latencyMs: 200, quality: 'A' }))
  p.markOk('f:0')
  p.markOk('f:1')
  assert.ok(p.isFreeFull())
  assert.equal(p.admissionQuota(), 0)

  // a dead node frees quota for admission
  p.markLimited('f:0')
  assert.equal(p.admissionQuota(), 1)

  // replace flow: with the pool full again, evict the worst (C-grade)
  p.markOk('f:0')
  p.markOk('f:1')
  p.add(node({ id: 'f:2', exitIP: '3.3.3.3', latencyMs: 3000, quality: 'C' }))
  assert.ok(p.evictWorstFree())
  assert.ok(!p.has('f:2'))
  assert.ok(p.has('f:0') && p.has('f:1'))
})

test('evictWorstFree drops C-grade before S-grade', () => {
  const p = pool({ targetSize: 5 })
  p.add(node({ id: 's:1', exitIP: '1.1.1.1', latencyMs: 100, quality: 'S' }))
  p.add(node({ id: 'c:1', exitIP: '2.2.2.2', latencyMs: 3000, quality: 'C' }))
  assert.ok(p.evictWorstFree())
  assert.ok(!p.has('c:1'))
  assert.ok(p.has('s:1'))
})

test('snapshot reports state, per-source counts and pinned (diagnostics, 5.3)', () => {
  const p = pool()
  p.add(node({ id: 'a:1', source: 'free' }))
  p.add(node({ id: 'b:2', source: 'manual', exitIP: '2.2.2.2' }))
  p.add(node({ id: 'c:3', source: 'subscription', exitIP: '3.3.3.3' }))
  p.add(node({ id: 'd:4', source: 'goproxy', exitIP: '4.4.4.4' }))
  p.pin('b:2')
  const snap = p.snapshot()
  assert.equal(snap.total, 4)
  assert.deepEqual(snap.bySource, { free: 1, manual: 1, subscription: 1, goproxy: 1 })
  assert.equal(snap.pinned, 'b:2')
  assert.equal(snap.state, 'emergency') // 0 usable free of 20 default target
})

test('unpinning/removing the pinned node clears the pointer', () => {
  const p = pool()
  p.add(node({ id: 'a:1', source: 'manual', exitIP: '2.2.2.2' }))
  p.pin('a:1')
  p.remove('a:1')
  assert.equal(p.pinnedId, '')
  assert.equal(p.pick('ses', 'm'), null)
})
