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

/**
 * Context for a host WITHOUT `settings.register` (DSH >= 0.1.7, where the
 * section is the entry's own `Config` field) that also records every bridge
 * route the plugin registers through `inject(['webServer'])`.
 */
function fakeNoRegisterCtx(): { ctx: PluginContext; routes: string[] } {
  const routes: string[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    // Deliberately no `register` — this is the >= 0.1.7 seam.
    settings: { get: () => ({}), mutate: async () => {} },
    inject: (services: string[], callback: (bctx: unknown) => unknown) => {
      assert.deepEqual(services, ['webServer'])
      return callback({
        webServer: {
          register(route: { path?: string }) {
            routes.push(String(route?.path))
            return () => {}
          },
        },
      })
    },
  }
  return { ctx: ctx as unknown as PluginContext, routes }
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

/**
 * Regression: the bridge used to be mounted only on the `settings.register`
 * path, below an early `return` taken when the seam lacks `register`. On DSH
 * >= 0.1.7 that early return is the normal path, so no route was ever
 * registered and every settings-card read answered `404 not found` (rendered as
 * "状态获取失败" / "status fetch failed") even though the plugin was live.
 */
test('no-register host (>= 0.1.7) still mounts the ip-pool bridge', async () => {
  resetCalls()
  const { ctx, routes } = fakeNoRegisterCtx()
  applyIpPoolSettings(ctx, {}, ctx.logger, { assemble })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(
    routes.sort(),
    ['/api/opencode2dsh/ip-pool/models', '/api/opencode2dsh/ip-pool/probe', '/api/opencode2dsh/ip-pool/status'],
    'all three card-facing routes register on a host without settings.register',
  )
})

/** Regression: the register-era host keeps mounting the bridge too. */
test('register host (<= 0.1.6) also mounts the ip-pool bridge', async () => {
  resetCalls()
  const { seam } = makeFakeSeam()
  const { ctx } = fakeNoRegisterCtx()
  // Give the same context a real register seam so it takes the legacy branch.
  ;(ctx as unknown as { settings: unknown }).settings = seam
  const routes: string[] = []
  ;(ctx as unknown as { inject: unknown }).inject = (
    _services: string[],
    callback: (bctx: unknown) => unknown,
  ) => callback({
    webServer: {
      register(route: { path?: string }) {
        routes.push(String(route?.path))
        return () => {}
      },
    },
  })
  applyIpPoolSettings(ctx, {}, ctx.logger, { assemble })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(routes.length, 3, 'legacy host mounts the same three routes')
})
