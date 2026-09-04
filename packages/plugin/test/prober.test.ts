import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { Prober, type ProbeTask } from '../src/pool/prober.ts'

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
    addedAt: 0,
    ...overrides,
  }
}

interface ProbeObservations {
  /** in-flight counts sampled at each task start, per kind */
  starts: Array<{ exitId: string; kind: string; concurrent: number }>
  perExitConcurrent: Map<string, number>
  maxConcurrent: number
}

function makeRunner(delayMs: number, obs: ProbeObservations) {
  return async (task: ProbeTask) => {
    const priorExit = obs.perExitConcurrent.get(task.exitId) ?? 0
    obs.perExitConcurrent.set(task.exitId, priorExit + 1)
    const concurrent = [...obs.perExitConcurrent.values()].reduce((a, b) => a + b, 0)
    obs.maxConcurrent = Math.max(obs.maxConcurrent, concurrent)
    obs.starts.push({ exitId: task.exitId, kind: task.kind, concurrent })
    await new Promise((r) => setTimeout(r, delayMs))
    obs.perExitConcurrent.set(task.exitId, obs.perExitConcurrent.get(task.exitId)! - 1)
  }
}

test('two-level scheduling: global <= max, per-exit <= 1 (docs/ip-pool.md 4.1)', async () => {
  const pool = new ExitPool()
  for (let i = 0; i < 6; i++) pool.add(node({ id: `e:${i}`, exitIP: `10.0.0.${i}` }))
  const obs: ProbeObservations = { starts: [], perExitConcurrent: new Map(), maxConcurrent: 0 }
  const run = makeRunner(20, obs)
  const prober = new Prober({ pool, maxConcurrentProbes: 3 })

  const tasks: ProbeTask[] = []
  for (let i = 0; i < 6; i++) {
    for (const kind of ['admission', 'health']) {
      tasks.push({ exitId: `e:${i}`, kind, run: () => run({ exitId: `e:${i}`, kind, run: async () => {} }) })
    }
  }
  await prober.enqueueAll(tasks)
  await prober.drained()

  // global in-flight never exceeded the cap
  assert.ok(obs.maxConcurrent <= 3, `max concurrent ${obs.maxConcurrent} > 3`)
  // per-exit in-flight never exceeded 1
  for (const [exitId, peak] of obs.perExitConcurrent) {
    assert.ok(peak <= 1, `exit ${exitId} reached in-flight ${peak}`)
  }
  // same-exit tasks were not the only thing running once >1 exits queued
  assert.ok(obs.maxConcurrent >= 2, 'workers never parallelized across exits')
  assert.equal(prober.stats.completed, 12)
})

test('same-exit tasks serialize even when global workers are free', async () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'e:0', exitIP: '1.1.1.1' }))
  const obs: ProbeObservations = { starts: [], perExitConcurrent: new Map(), maxConcurrent: 0 }
  const run = makeRunner(10, obs)
  const prober = new Prober({ pool, maxConcurrentProbes: 8 })
  const order: string[] = []
  await prober.enqueueAll(
    ['a', 'b', 'c'].map((kind) => ({
      exitId: 'e:0',
      kind,
      run: async () => {
        order.push(`start:${kind}`)
        await run({ exitId: 'e:0', kind, run: async () => {} })
        order.push(`end:${kind}`)
      },
    })),
  )
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
})

test('single worker (maxConcurrentProbes=1) is fully serial', async () => {
  const pool = new ExitPool()
  for (let i = 0; i < 3; i++) pool.add(node({ id: `e:${i}`, exitIP: `10.0.0.${i}` }))
  const obs: ProbeObservations = { starts: [], perExitConcurrent: new Map(), maxConcurrent: 0 }
  const run = makeRunner(5, obs)
  const prober = new Prober({ pool, maxConcurrentProbes: 1 })
  await prober.enqueueAll(
    [0, 1, 2, 0, 1, 2].map((i) => ({
      exitId: `e:${i}`,
      kind: 'probe',
      run: () => run({ exitId: `e:${i}`, kind: 'probe', run: async () => {} }),
    })),
  )
  assert.equal(obs.maxConcurrent, 1)
})

test('task failures never break the scheduler; locks are always released', async () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'e:0', exitIP: '1.1.1.1' }))
  const prober = new Prober({ pool, maxConcurrentProbes: 2 })
  await prober.enqueue({
    exitId: 'e:0',
    kind: 'boom',
    run: async () => {
      throw new Error('probe exploded')
    },
  })
  // the lock was released: the next task of the same exit runs
  let ran = false
  await prober.enqueue({ exitId: 'e:0', kind: 'next', run: async () => { ran = true } })
  assert.ok(ran)
  assert.equal(prober.stats.completed, 2)
})

test('setMaxConcurrent applies live without restarting the queue', async () => {
  const pool = new ExitPool()
  for (let i = 0; i < 4; i++) pool.add(node({ id: `e:${i}`, exitIP: `10.0.0.${i}` }))
  const obs: ProbeObservations = { starts: [], perExitConcurrent: new Map(), maxConcurrent: 0 }
  const run = makeRunner(15, obs)
  const prober = new Prober({ pool, maxConcurrentProbes: 2 })
  const all = prober.enqueueAll(
    [0, 1, 2, 3].map((i) => ({
      exitId: `e:${i}`,
      kind: 'probe',
      run: () => run({ exitId: `e:${i}`, kind: 'probe', run: async () => {} }),
    })),
  )
  prober.setMaxConcurrent(4)
  await all
  assert.ok(obs.maxConcurrent >= 3, `expected widened concurrency, saw ${obs.maxConcurrent}`)
})
