/**
 * IP-5 live-apply tests: the apply controller over a fake settings seam —
 * boot-time enable, watcher-driven reconfigure (enabled flip included) and
 * the section-shape mapping from either layer's spelling. The real
 * startIpPool is replaced through the assemble seam, so no undici or global
 * dispatcher is ever installed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyIpPoolSettings, type AssembleIpPool } from '../src/ip-pool-settings/apply.ts'
import { IpPoolConfigSchema } from '../src/ip-pool-settings/namespace.ts'
import type { PluginContext } from '../src/index.ts'

/** Recorded assembly + reconfigure calls (reset per test). */
let starts: Array<{ config: Record<string, unknown> }> = []
let reconfigures: Array<Record<string, unknown>> = []

function resetCalls(): void {
  starts = []
  reconfigures = []
}

/** Test assembly seam: a runtime face with just what apply.ts touches. */
const assemble: AssembleIpPool = async (config) => {
  const runtime = {
    pool: { snapshot: () => ({ total: 1 }), targetSize: 20, list: () => [], has: () => true },
    installer: { enabled: false, install() { this.enabled = true }, disable() { this.enabled = false }, dispose() {} },
    prober: { stats: { queued: 0, inFlight: 0, enqueued: 0, completed: 0 }, setMaxConcurrent() {} },
    refill: null,
    subscriptions: null,
    reconfigure: async (next: Record<string, unknown>) => { reconfigures.push(next) },
    probeAll: async () => 0,
    probeExit: async () => 1,
    refillNow: async () => {},
    refreshSubscriptions: async () => {},
    dispose: async () => {},
  }
  starts.push({ config: config as Record<string, unknown> })
  return runtime as never
}

/** Fake settings seam with the register/watch face (dsh-settings shaped). */
function makeFakeSeam() {
  const watchers = new Set<(next: unknown) => void>()
  let resolved: Record<string, unknown> = {}
  const seam = {
    get: () => resolved,
    mutate: async () => {},
    register(ns: string, _schema: unknown, options: { base?: unknown }) {
      assert.equal(String(ns), 'ip-pool')
      resolved = { ...(options?.base as object) }
      return {
        get: () => resolved,
        watch(callback: (next: unknown) => void) {
          watchers.add(callback)
          return () => watchers.delete(callback)
        },
      }
    },
  }
  return {
    seam,
    commit(next: Record<string, unknown>) {
      resolved = next
      for (const callback of watchers) callback(next)
    },
  }
}

function fakeCtx(seam: unknown): PluginContext {
  return {
    logger: { info() {}, warn() {}, error() {} },
    settings: seam as never,
  }
}

test('disabled at boot: namespace registers, no runtime assembled', async () => {
  resetCalls()
  const { seam } = makeFakeSeam()
  const ctx = fakeCtx(seam)
  const controller = applyIpPoolSettings(ctx, {}, ctx.logger, { assemble })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(starts.length, 0)
  assert.equal(controller.runtime, null)
})

test('boot-enabled: runtime assembles once with the entry config', async () => {
  resetCalls()
  const { seam } = makeFakeSeam()
  const ctx = fakeCtx(seam)
  const config = { ipPool: { enabled: true, manual: ['http://1.1.1.1:1'] } } as never
  const controller = applyIpPoolSettings(ctx, config, ctx.logger, { assemble })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(starts.length, 1)
  assert.ok(controller.runtime !== null)
  const passed = starts[0]!.config as { ipPool?: { manual?: string[] } }
  assert.deepEqual(passed.ipPool?.manual, ['http://1.1.1.1:1'])
})

test('settings-page enable: commit assembles the runtime, later commits reconfigure live', async () => {
  resetCalls()
  const { seam, commit } = makeFakeSeam()
  const ctx = fakeCtx(seam)
  const controller = applyIpPoolSettings(ctx, {}, ctx.logger, { assemble })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(starts.length, 0)

  // flip enabled on (settings-page shape)
  commit(IpPoolConfigSchema({ enabled: true, manual: ['http://2.2.2.2:2'], maxConcurrentProbes: 5 }) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(starts.length, 1, 'enable commit assembles the runtime')
  assert.ok(controller.runtime !== null)

  // a later commit (no enable flip) goes through reconfigure, never re-assembles
  const before = starts.length
  commit(IpPoolConfigSchema({ enabled: true, manual: ['http://2.2.2.2:2'], pinnedExitId: 'http://127.0.0.1:7897', pinnedStrict: true }) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(starts.length, before, 'no re-assembly without an enable flip')
  // one reconfigure per commit: the enable commit's post-assembly apply + this one
  assert.equal(reconfigures.length, 2)
  const applied = reconfigures[1]!.ipPool as Record<string, unknown>
  assert.equal(applied.pinnedExitId, 'http://127.0.0.1:7897')
  assert.equal(applied.pinnedStrict, true)
})

test('subscription urls from the settings shape flow into the config assembly', async () => {
  resetCalls()
  const { seam, commit } = makeFakeSeam()
  const ctx = fakeCtx(seam)
  applyIpPoolSettings(ctx, {}, ctx.logger, { assemble })
  commit(IpPoolConfigSchema({ enabled: true, subscription: { urls: ['https://x/y'] } }) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(starts.length, 1)
  const passed = starts[0]!.config as { ipPool?: { subscriptions?: string[] } }
  assert.deepEqual(passed.ipPool?.subscriptions, ['https://x/y'])
})
