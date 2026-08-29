import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { PROVIDER_ID, ZenAdapter } from '../src/adapter/zen-adapter.ts'

/**
 * The exact method surface dsh-llm touches on a registered adapter. A missing
 * member throws inside registerAdapter and silently drops the provider from
 * the model selector (regression: providerRetryPolicy, index.js:1208).
 */
test('ZenAdapter implements the full dsh-llm adapter surface', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  for (const method of ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], 'function', `missing method: ${method}`)
  }
})

test('providerInfo preserves the route id and names the provider', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  assert.deepEqual(adapter.providerInfo('opencode2dsh'), { id: 'opencode2dsh', name: PROVIDER_ID })
})

test('providerRetryPolicy defers to the host default', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  assert.equal(adapter.providerRetryPolicy('opencode2dsh'), undefined)
})

test('resolveModel declares text-only input and finite limits', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  const resolved = adapter.resolveModel('opencode2dsh', 'big-pickle')
  assert.deepEqual(resolved.inputModalities, ['text'])
  assert.equal(resolved.context.contextWindow > 0, true)
  assert.equal(resolved.defaultMaxTokens > 0, true)
  assert.equal(resolved.provider, 'opencode2dsh')
  assert.equal(resolved.id, 'big-pickle')
})

test('prepareCall returns the resolved model and a stream dispatcher', async () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  const call = await adapter.prepareCall('opencode2dsh', 'big-pickle')
  assert.equal(call.model.id, 'big-pickle')
  assert.equal(typeof call.stream, 'function')
})

test('listModels mirrors the catalog without duplicates', () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle', 'big-pickle', 'hy3-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
  })
  const models = adapter.listModels('opencode2dsh')
  assert.deepEqual(models.map((m) => m.id), ['big-pickle', 'hy3-free'])
})
