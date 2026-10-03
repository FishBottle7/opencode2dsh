import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers'

import { apply, Config, type PluginContext } from '../src/index.ts'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { resolveIpPoolSettings } from '../src/ip-pool-settings/namespace.ts'
import { WATCHDOG_FIRST_MESSAGE, WATCHDOG_IDLE_MESSAGE, type ZenAdapter } from '../src/adapter/zen-adapter.ts'
import type { FinishReason } from '../src/adapter/events.ts'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

for (const scenario of [
  { name: 'first event', model: 'big-pickle', headers: false, window: 300 },
  { name: 'chat body idle', model: 'big-pickle', headers: true, window: 900 },
  { name: 'Responses body idle', model: 'muse-spark-1.2-contributor-free', headers: true, window: 1800 },
]) {
  test(`plugin entry applies the configured ${scenario.name} window`, { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
    t.mock.method(ModelCatalog.prototype, 'start', async () => {})
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    let requested!: () => void
    const requestStarted = new Promise<void>((resolve) => { requested = resolve })
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
      requested()
      if (!scenario.headers) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
      }
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }), {
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    let adapter: ZenAdapter | undefined
    const disposers: Array<() => void> = []
    const ctx: PluginContext = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { registerAdapter(_providers, registered) { adapter = registered as ZenAdapter } },
      effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
    }
    const controller = new AbortController()
    t.after(() => {
      controller.abort()
      body?.close()
      for (const dispose of disposers) dispose()
    })
    apply(ctx, {
      ...Config({ firstEventMs: 300, bodyIdleMs: 900, responsesBodyIdleMs: 1800 }),
      ipPool: { get: () => resolveIpPoolSettings({ enabled: false }) },
    })
    assert.ok(adapter, 'the production plugin entry must register an adapter')
    const result: { finish?: FinishReason } = {}
    const pending = (async () => {
      for await (const chunk of adapter.stream({
        provider: 'opencode2dsh', model: scenario.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: controller.signal,
      })) {
        if (chunk.type === 'finish') result.finish = chunk.reason
      }
    })()
    await requestStarted
    await flush()
    // Advance the real registered adapter's clock, with transport kept silent.
    t.mock.timers.tick(scenario.window - 1)
    await flush()
    const earlyFinish = result.finish
    assert.equal(earlyFinish, undefined, 'the configured deadline must not fire early')
    t.mock.timers.tick(1)
    await flush()
    const finish = result.finish
    assert.equal(finish?.kind, 'error')
    if (finish?.kind === 'error') {
      assert.equal(finish.failure.code, 'TIMEOUT')
      assert.equal(finish.failure.message, scenario.headers ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE)
    }
    await pending
  })
}
