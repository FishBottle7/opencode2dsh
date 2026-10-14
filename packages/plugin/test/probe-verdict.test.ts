/**
 * The unified probe verdict (src/pool/probe-verdict.ts) and the failure
 * classification that feeds it.
 *
 * The live regression these lock down (2026-10-14): a 726-node subscription
 * pool had 703 exits sitting at `unknown` with zero facts. They had all been
 * probed; the subscription path simply never wrote anything on failure, so a
 * verified-dead link was indistinguishable from a never-probed node — on the
 * settings card AND in the rotation, since `isUsable` treats `unknown` as
 * usable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { applyProbeVerdict } from '../src/pool/probe-verdict.ts'
import { PeriodicProber } from '../src/pool/periodic-prober.ts'
import type { AdmissionResult } from '../src/pool/admission.ts'

let clock = 5_000_000
const now = () => clock

function pool(options: ConstructorParameters<typeof ExitPool>[0] = {}) {
  return new ExitPool({ now, ...options })
}

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'sub:1',
    protocol: 'socks5',
    source: 'subscription',
    pinned: false,
    exitIP: '',
    exitLocation: '',
    latencyMs: 0,
    quality: 'C',
    addedAt: 0,
    ...overrides,
  }
}

/** An `admitTrusted` degraded verdict, as the subscription path receives it. */
function degraded(failure: AdmissionResult['failure'], reason = ''): AdmissionResult {
  return { admitted: true, degraded: true, failure, reason }
}

// -- the core regression: a dead link must stop looking unprobed ---------------

test('verdict: a transport failure marks the exit dead instead of leaving it unknown', () => {
  const p = pool()
  p.add(node({ id: 'sub:1' }))
  assert.equal(p.list()[0]!.health.state, 'unknown')

  const applied = applyProbeVerdict(p, 'sub:1', degraded('transport', 'SOCKS5 connection timeout'), {
    source: 'subscription',
    model: 'space-bunny-free',
  })

  assert.equal(applied, 'dead')
  const health = p.list()[0]!.health
  assert.equal(health.state, 'dead')
  assert.equal(health.lastProbeFailure, 'transport')
  assert.equal(health.lastProbeReason, 'SOCKS5 connection timeout')
  // ...and it is out of the rotation, which is the point.
  assert.equal(p.isUsable('sub:1', 'space-bunny-free'), false)
})

test('verdict: only the transport class strikes dead — every answering class does not', () => {
  const answering = ['refused', 'server-error', 'geo-blocked', 'slow', 'malformed', 'echo-unavailable'] as const
  for (const failure of answering) {
    const p = pool()
    p.add(node({ id: 'sub:1' }))
    applyProbeVerdict(p, 'sub:1', degraded(failure, failure), { source: 'subscription', model: 'm' })
    const health = p.list()[0]!.health
    assert.notEqual(health.state, 'dead', `${failure} must not strike the exit dead`)
    // but the failure IS recorded, so the card can explain itself
    assert.equal(health.lastProbeFailure, failure)
    // and a live exit stays usable for a model it was never banned on
    assert.equal(p.isUsable('sub:1', 'other-model'), true)
  }
})

// -- per-class bookkeeping ------------------------------------------------------

test('verdict: refused bans the (exit × model) pairing but keeps the exit alive', () => {
  const p = pool({ })
  p.add(node({ id: 'sub:1' }))
  applyProbeVerdict(p, 'sub:1', degraded('refused', 'zen models HTTP 403'), { source: 'subscription', model: 'muse' })
  // one sample = suspect (§4.2 banConfirmations), exit itself never dead
  assert.equal(p.isUsable('sub:1', 'muse'), true)
  assert.equal(p.list()[0]!.health.state, 'unknown')

  // a second consecutive refusal bans the pairing only
  applyProbeVerdict(p, 'sub:1', degraded('refused', 'zen models HTTP 403'), { source: 'subscription', model: 'muse' })
  assert.equal(p.isUsable('sub:1', 'muse'), false)
  assert.equal(p.isUsable('sub:1', 'space-bunny-free'), true, 'other models on the same exit stay usable')
  assert.equal(p.list()[0]!.health.state, 'unknown', 'a refusal never strikes the exit dead')
})

test('verdict: a 429 cooldown leaves the exit alive and clears the stale failure label', () => {
  const p = pool()
  p.add(node({ id: 'sub:1' }))
  applyProbeVerdict(p, 'sub:1', degraded('transport', 'boom'), { source: 'subscription', model: 'm' })
  assert.equal(p.list()[0]!.health.lastProbeFailure, 'transport')

  const applied = applyProbeVerdict(p, 'sub:1', { admitted: true, limited: true, reason: 'zen smoke HTTP 429' }, {
    source: 'subscription',
    model: 'm',
  })
  assert.equal(applied, 'limited')
  const health = p.list()[0]!.health
  assert.equal(health.state, 'ok')
  assert.ok(health.cooldownUntil > now())
  assert.equal(health.lastProbeFailure, '', '429 is a verified-alive verdict; the old failure must not linger')
})

test('verdict: a clean pass is ok and clears the failure record', () => {
  const p = pool()
  p.add(node({ id: 'sub:1', exitIP: '1.1.1.1', latencyMs: 300 }))
  applyProbeVerdict(p, 'sub:1', degraded('transport', 'boom'), { source: 'subscription', model: 'm' })
  assert.equal(p.list()[0]!.health.state, 'dead')

  const applied = applyProbeVerdict(p, 'sub:1', {
    admitted: true,
    node: node({ exitIP: '1.1.1.1', latencyMs: 300 }),
  }, { source: 'subscription', model: 'm' })
  assert.equal(applied, 'ok')
  const health = p.list()[0]!.health
  assert.equal(health.state, 'ok')
  assert.equal(health.lastProbeFailure, '')
  assert.equal(health.deadStrikes, 0)
})

// -- retention stays the ONLY source-dependent rule (docs §3.5) ------------------

test('retention: identical transport failure deads a subscription exit in place but evicts a free one', () => {
  const p = pool()
  p.add(node({ id: 'sub:1', source: 'subscription' }))
  p.add(node({ id: 'free:1', source: 'free', exitIP: '9.9.9.9' }))
  const options = { model: 'm' }

  // The verdict is the SAME for both sources...
  assert.equal(applyProbeVerdict(p, 'sub:1', degraded('transport'), { ...options, source: 'subscription' }), 'dead')
  assert.equal(applyProbeVerdict(p, 'free:1', degraded('transport'), { ...options, source: 'free' }), 'dead')

  // ...only what happens to the row differs.
  assert.equal(p.has('sub:1'), true, 'a subscription exit is disabled in place, never dropped')
  assert.equal(p.list()[0]!.health.state, 'dead')

  // second strike: the free node is evicted (deadEvictions default 2)
  applyProbeVerdict(p, 'free:1', degraded('transport'), { ...options, source: 'free' })
  assert.equal(p.has('free:1'), false, 'a free exit is evicted so its slot can be refilled')
})

test('retention: a pinned exit is never struck dead by a failed probe', () => {
  const p = pool()
  p.add(node({ id: 'pin:1', source: 'manual', pinned: true }))
  const applied = applyProbeVerdict(p, 'pin:1', degraded('transport', 'boom'), {
    source: 'manual',
    model: 'm',
    pinned: true,
  })
  assert.equal(applied, 'unchanged')
  assert.equal(p.list()[0]!.health.state, 'unknown', "the user's own line must not be disabled by a probe")
  assert.equal(p.list()[0]!.health.lastProbeFailure, 'transport', 'but the failure is still on record')
})

// -- the honest default ---------------------------------------------------------

test('verdict: an unclassified failure stays unknown rather than asserting death', () => {
  const p = pool()
  p.add(node({ id: 'sub:1' }))
  const applied = applyProbeVerdict(p, 'sub:1', { admitted: false, reason: 'agent-build: bad uri' }, {
    source: 'subscription',
    model: 'm',
  })
  assert.equal(applied, 'unchanged')
  assert.equal(p.list()[0]!.health.state, 'unknown', 'never assert death from an unclassified failure')
})

test('verdict: a never-probed exit is distinguishable from a probed-and-failed one', () => {
  const p = pool()
  p.add(node({ id: 'never:1', source: 'subscription' }))
  p.add(node({ id: 'failed:1', source: 'subscription' }))
  applyProbeVerdict(p, 'failed:1', degraded('server-error', 'zen models HTTP 500'), { source: 'subscription', model: 'm' })

  const rows = p.list()
  const never = rows.find((r) => r.id === 'never:1')!.health
  const failed = rows.find((r) => r.id === 'failed:1')!.health
  // both are 'unknown' at the state level — the failure record is what the
  // settings card uses to tell them apart (the whole point of this change)
  assert.equal(never.state, 'unknown')
  assert.equal(failed.state, 'unknown')
  assert.equal(never.lastProbeFailure, '')
  assert.equal(failed.lastProbeFailure, 'server-error')
})

// -- the dead-retry loop this feeds (docs §4.3) ---------------------------------

test('a dead subscription exit is re-probed by PeriodicProber and returns on success', () => {
  const p = pool()
  p.add(node({ id: 'sub:1', exitIP: '1.1.1.1', latencyMs: 200 }))
  p.markOk('sub:1')
  applyProbeVerdict(p, 'sub:1', degraded('transport', 'boom'), { source: 'subscription', model: 'm' })
  assert.equal(p.list()[0]!.health.state, 'dead')

  // recovery: a later probe passes and the exit is usable again
  applyProbeVerdict(p, 'sub:1', { admitted: true, node: node({ exitIP: '1.1.1.1', latencyMs: 210 }) }, {
    source: 'subscription',
    model: 'm',
  })
  assert.equal(p.list()[0]!.health.state, 'ok')
  assert.equal(p.isUsable('sub:1', 'm'), true)
})

// -- probe/traffic quota contention (docs §4.1) ---------------------------------

test('an exit being probed is deprioritized, not banned', () => {
  // Live symptom (2026-10-15): the settings card showed a healthy spread of
  // `ok` exits while every real request still answered 429. A probe and real
  // traffic share ONE anonymous quota bucket per exit IP, and `pick` used to
  // rank purely on health+latency — so the fastest `ok` exit won every pick
  // even while a probe of it was spending that bucket.
  const p = pool()
  p.add(node({ id: 'fast', exitIP: '1.1.1.1', latencyMs: 50 }))
  p.add(node({ id: 'slow', exitIP: '2.2.2.2', latencyMs: 900 }))
  p.markOk('fast')
  p.markOk('slow')

  // Before any probe, the fast exit wins on latency alone.
  assert.equal(p.pick('s0', 'm'), 'fast')

  p.takeProbeLock('fast')
  // Still usable — deprioritized, never removed from rotation.
  assert.equal(p.isUsable('fast', 'm'), true)
  // But it now loses to an idle exit even though it is 18x faster.
  const picks: Record<string, number> = {}
  for (let i = 0; i < 100; i += 1) {
    const id = p.pick(`probe-deprio-${i}`, 'm')
    if (id !== null) picks[id] = (picks[id] ?? 0) + 1
  }
  assert.equal(picks.slow ?? 0, 100, 'real traffic moves to the idle exit while the fast one is probed')
  assert.equal(picks.fast ?? 0, 0, 'the probed exit is not handed traffic meanwhile')
})

test('an all-probed pool still answers: no silent direct-fallback', () => {
  // The reason this is a DEPRIORITY and not a ban: a full probe sweep covers
  // up to maxPerRound exits, and refusing every probed exit would empty the
  // pool mid-sweep and drop the user's traffic to a direct connection.
  const p = pool()
  p.add(node({ id: 'a', exitIP: '1.1.1.1', latencyMs: 10 }))
  p.add(node({ id: 'b', exitIP: '2.2.2.2', latencyMs: 20 }))
  p.markOk('a')
  p.markOk('b')
  p.takeProbeLock('a')
  p.takeProbeLock('b')
  assert.notEqual(p.pick('s', 'm'), null, 'a usable exit is still returned when all are being probed')
})

test('session stickiness yields to an in-flight probe', () => {
  const p = pool()
  p.add(node({ id: 'fast', exitIP: '1.1.1.1', latencyMs: 50 }))
  p.add(node({ id: 'slow', exitIP: '2.2.2.2', latencyMs: 900 }))
  p.markOk('fast')
  p.markOk('slow')
  assert.equal(p.pick('sess', 'm'), 'fast')

  p.takeProbeLock('fast')
  assert.notEqual(p.pick('sess', 'm'), 'fast', 'stickiness does not re-pin a session onto the probed exit')
})

// -- dead-retry fairness and backoff (docs §4.6) --------------------------------

test('dead retries are gated and rotate, so they neither burn quota nor starve', () => {
  // Measured live (2026-10-15) on a 559-exit subscription pool that was all
  // dead: `select()` returned the SAME first 20 exits every round. That burned
  // an anonymous-lane smoke per retry to re-derive a verdict that almost never
  // changes (23 of 24 sampled failures were `transport`), while the other 539
  // exits never got a dead-retry chance at all — and a subscription node is
  // disable-only (§3.5), so a node that recovered late could never rejoin.
  let clock = 10_000_000
  const now = () => clock
  const p = new ExitPool({ now })
  const total = 559
  for (let i = 1; i <= total; i += 1) {
    // A DISTINCT exit IP per node: `pool.add` refuses two addresses sharing one
    // exit IP (§3.1 — they are one quota bucket), so a repeating IP would
    // silently shrink the table and make this test prove nothing.
    p.add(node({ id: `d${i}`, exitIP: `198.51.${Math.floor(i / 250)}.${i % 250}`, latencyMs: 0 }))
    p.markOk(`d${i}`)
    p.recordPassiveTransport(`d${i}`)
  }
  assert.equal(p.list().length, total, 'every node entered the table')
  const prober = new PeriodicProber(p, async () => {}, { now })
  clock += 31 * 60_000 // past the retry gate

  // A dead exit far down the list must eventually be retried.
  const covered = new Set<string>()
  let reachedFarExit = -1
  for (let round = 1; round <= 30; round += 1) {
    const deadRetries = prober.select().filter((c) => c.reason === 'dead-retry').map((c) => c.id)
    for (const id of deadRetries) covered.add(id)
    if (deadRetries.includes(`d${total - 1}`)) reachedFarExit = round
    clock += 31 * 60_000
  }
  assert.ok(reachedFarExit > 0, 'an exit at the end of a 559-entry table is still reached')
  assert.ok(covered.size > 100, `retries rotate across the table (covered ${covered.size} distinct exits)`)

  // The gate: a second round immediately after must not re-probe the same ones.
  const fresh = new ExitPool({ now })
  fresh.add(node({ id: 'a', exitIP: '1.1.1.1', latencyMs: 0 }))
  fresh.markOk('a')
  fresh.recordPassiveTransport('a')
  const gated = new PeriodicProber(fresh, async () => {}, { now })
  assert.equal(gated.select().filter((c) => c.reason === 'dead-retry').length, 0,
    'a just-failed exit is not retried again in the same breath (DEAD_RETRY_MS gate)')
})

test('an exit that recovered is NOT dead-retried', () => {
  let clock = 20_000_000
  const now = () => clock
  const p = new ExitPool({ now })
  p.add(node({ id: 'sub:1', exitIP: '1.1.1.1', latencyMs: 0 }))
  p.markOk('sub:1')
  p.recordPassiveTransport('sub:1')
  assert.equal(p.list()[0]!.health.state, 'dead')

  // A later probe passes: the exit is back in rotation on its own.
  p.markOk('sub:1')
  assert.equal(p.list()[0]!.health.state, 'ok')
  assert.equal(p.isUsable('sub:1', 'm'), true, 'recovery needs no dead-retry, it is already usable')

  const prober = new PeriodicProber(p, async () => {}, { now })
  clock += 31 * 60_000
  assert.equal(prober.select().filter((c) => c.reason === 'dead-retry').length, 0,
    'a healthy exit is never queued as a dead retry')
})
