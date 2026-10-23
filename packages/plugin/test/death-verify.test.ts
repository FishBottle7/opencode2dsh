import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { createDeathVerifier } from '../src/pool/death-verify.ts'

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'sub:1',
    protocol: 'http',
    source: 'subscription',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'US city',
    latencyMs: 200,
    quality: 'A',
    addedAt: 0,
    ...overrides,
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('death verification: a transport death is probed once, through the runtime probe (#106)', async () => {
  const pool = new ExitPool()
  pool.add(node())
  pool.markOk('sub:1')
  // A real request died in transport: the pool strikes it dead on the spot.
  pool.recordPassiveTransport('sub:1')
  assert.equal(pool.isUsable('sub:1', 'm'), false)

  const probed: string[] = []
  const verify = createDeathVerifier({ pool, probe: async (id) => { probed.push(id) } })
  // A burst of failures in one turn (sentinel + a rerouted retry) must not
  // queue a burst of probes.
  verify('sub:1')
  verify('sub:1')
  verify('sub:1')
  await settle()
  assert.deepEqual(probed, ['sub:1'])
})

test('death verification: only a death earns a probe — live, cooling and unknown ids do not (#106)', async () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'live:1', exitIP: '1.1.1.1' }))
  pool.markOk('live:1')
  pool.add(node({ id: 'hot:1', exitIP: '2.2.2.2' }))
  pool.markOk('hot:1')
  pool.markLimited('hot:1') // alive, just cooling: the periodic loop retries it
  pool.add(node({ id: 'fresh:1', exitIP: '3.3.3.3', latencyMs: 0 })) // unknown, never probed

  const probed: string[] = []
  const verify = createDeathVerifier({ pool, probe: async (id) => { probed.push(id) } })
  verify('live:1')
  verify('hot:1')
  verify('fresh:1')
  verify('never:seen')
  await settle()
  assert.deepEqual(probed, [], 'no quota is spent verifying something that is not dead')
})

test('death verification: the dedupe re-arms after the probe settles (#106)', async () => {
  const pool = new ExitPool()
  pool.add(node())
  pool.recordPassiveTransport('sub:1')

  const probed: string[] = []
  let release: () => void = () => {}
  const verify = createDeathVerifier({
    pool,
    probe: (id) => {
      probed.push(id)
      return new Promise<void>((resolve) => { release = resolve })
    },
  })
  verify('sub:1')
  verify('sub:1')
  await settle()
  assert.deepEqual(probed, ['sub:1'], 'the second call while queued is a duplicate')

  release()
  await settle()
  // Still dead (the fake probe applied no verdict), so a LATER failure is a new
  // episode and earns its own verification.
  verify('sub:1')
  await settle()
  assert.deepEqual(probed, ['sub:1', 'sub:1'])
})

test('death verification: a probe that throws is reported and never blocks the next one (#106)', async () => {
  const pool = new ExitPool()
  pool.add(node())
  pool.recordPassiveTransport('sub:1')

  const warnings: string[] = []
  let calls = 0
  const verify = createDeathVerifier({
    pool,
    probe: async () => {
      calls += 1
      throw new Error('prober exploded')
    },
    logger: { warn: (message) => warnings.push(message) },
  })
  verify('sub:1')
  await settle()
  assert.equal(calls, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /prober exploded/)

  verify('sub:1')
  await settle()
  assert.equal(calls, 2, 'the slot was released, so the next death is still verified')
})
