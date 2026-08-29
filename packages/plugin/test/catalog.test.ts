import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeModelsDev, decide, fetchZenModels, isFreeModel, ModelCatalog, staticFreeModels } from '../src/adapter/catalog.ts'
import { opencodeUserAgent } from '../src/adapter/ids.ts'

function price(input?: number, output?: number, deprecated = false) {
  return { input, output, deprecated }
}

test('isFreeModel keys on the name', () => {
  assert.ok(isFreeModel('hy3-free'))
  assert.ok(isFreeModel('BIG-PICKLE-FREE'))
  assert.ok(!isFreeModel('qwen3-max'))
})

test('decide follows the model_metadata.go matrix', () => {
  // metadata pending: free-named pass, others blocked, nothing known
  assert.deepEqual(decide('x-free', new Map(), false), { allowed: true, source: 'name_free', known: false })
  assert.deepEqual(decide('paid', new Map(), false), { allowed: false, source: 'metadata_pending', known: false })
  assert.deepEqual(decide('paid', new Map(), true), { allowed: false, source: 'metadata_pending', known: false })
  // ready but model absent
  assert.deepEqual(decide('paid', new Map([['other', price(0, 0)]]), true), {
    allowed: false,
    source: 'metadata_model_missing',
    known: false,
  })
  // free by name alone
  assert.deepEqual(decide('x-free', new Map([['x-free', price(1, 1)]]), true), {
    allowed: true,
    source: 'name_free',
    known: true,
  })
  // free by metadata alone
  assert.deepEqual(decide('qwen', new Map([['qwen', price(0, 0)]]), true), {
    allowed: true,
    source: 'metadata_free',
    known: true,
  })
  // free by both
  assert.deepEqual(decide('q-free', new Map([['q-free', price(0, 0)]]), true), {
    allowed: true,
    source: 'name_and_metadata_free',
    known: true,
  })
  // paid and deprecated
  assert.deepEqual(decide('paid', new Map([['paid', price(1, 2)]]), true), {
    allowed: false,
    source: 'metadata_paid',
    known: true,
  })
  assert.deepEqual(decide('old', new Map([['old', price(0, 0, true)]]), true), {
    allowed: false,
    source: 'metadata_deprecated',
    known: true,
  })
  // partial pricing has an unknown side -> blocked and not known
  assert.deepEqual(decide('half', new Map([['half', price(0)]]), true), {
    allowed: false,
    source: 'metadata_cost_unknown',
    known: false,
  })
})

test('decodeModelsDev prefers the opencode provider section and parses costs', () => {
  const payload = {
    'openai': { models: { gpt: { cost: { input: 5, output: 10 } } } },
    'opencode': {
      models: {
        'qwen3-coder-next': { cost: { input: 0, output: 0 } },
        'claude-max': { id: 'claude-max', cost: { input: 1.5, output: 7.5 } },
        retired: { status: 'deprecated', cost: { input: 0, output: 0 } },
        ambiguous: { cost: {} },
      },
    },
  }
  const prices = decodeModelsDev(payload)
  assert.equal(prices.size, 4)
  assert.deepEqual(prices.get('qwen3-coder-next'), price(0, 0))
  assert.deepEqual(prices.get('claude-max'), price(1.5, 7.5))
  assert.equal(prices.get('retired')?.deprecated, true)
  assert.deepEqual(prices.get('ambiguous'), price(undefined, undefined, false))
  // no opencode section anywhere -> empty
  assert.equal(decodeModelsDev({ openai: {} }).size, 0)
  assert.equal(decodeModelsDev(null).size, 0)
})

function fakeFetch(routes: Record<string, unknown>, capture: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string | URL, init?: RequestInit) => {
    capture.url = String(url)
    capture.init = init
    const key = String(url).replace(/\?.*$/, '')
    const body = routes[key] ?? routes['*']
    if (body instanceof Error) throw body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const zenBody = { data: [{ id: 'qwen-free' }, { id: 'paid-model' }, { id: 'ghost-free' }] }
const metadataBody = {
  opencode: {
    models: {
      'qwen-free': { cost: { input: 0, output: 0 } },
      'paid-model': { cost: { input: 1, output: 2 } },
      'ghost-free': { cost: { input: 3, output: 4 } },
    },
  },
}

test('fetchZenModels sends the anonymous CLI disguise and parses ids', async () => {
  const capture: { url?: string; init?: RequestInit } = {}
  const ids = await fetchZenModels('https://opencode.ai/zen/', fakeFetch({ 'https://opencode.ai/zen/v1/models': zenBody }, capture), opencodeUserAgent())
  assert.deepEqual(ids, ['qwen-free', 'paid-model', 'ghost-free'])
  assert.equal(capture.url, 'https://opencode.ai/zen/v1/models')
  const headers = new Headers(capture.init?.headers)
  assert.equal(headers.get('authorization'), 'Bearer public')
  assert.equal(headers.get('x-opencode-client'), 'cli')
  assert.ok(headers.get('user-agent')?.startsWith('opencode/'))
  await assert.rejects(
    fetchZenModels('https://opencode.ai/zen', fakeFetch({ 'https://opencode.ai/zen/v1/models': { data: [] } }), opencodeUserAgent()),
    /empty list/,
  )
})

test('ModelCatalog intersects the live catalog with free decisions', async () => {
  const catalog = new ModelCatalog({ fetchImpl: fakeFetch({ 'https://opencode.ai/zen/v1/models': zenBody, 'https://models.dev/api.json': metadataBody }) })
  try {
    await catalog.refreshOnce()
    assert.deepEqual(catalog.list(), ['ghost-free', 'qwen-free'], 'paid-model is filtered out')
    assert.equal(catalog.decision('paid-model').allowed, false)
    assert.equal(catalog.snapshot().status, 'ready')
    assert.equal(catalog.snapshot().exposed, 2)
  } finally {
    catalog.stop()
  }
})

test('ModelCatalog falls back to static ids while the live catalog is pending', async () => {
  const fail = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl: fail })
  await catalog.refreshOnce()
  assert.deepEqual(catalog.list(), staticFreeModels)
  // static ids are verified upstream: allowed even without metadata
  assert.equal(catalog.decision('big-pickle').allowed, true)
  assert.equal(catalog.decision('big-pickle').source, 'static_verified')
  assert.equal(catalog.decision('unknown-model').allowed, false)
  assert.equal(catalog.snapshot().status, 'pending')
  catalog.stop()
})
