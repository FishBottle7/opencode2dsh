import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeModelsDev, decide, fetchZenModels, isFreeModel, ModelCatalog, staticFreeModels } from '../src/adapter/catalog.ts'
import { opencodeUserAgent } from '../src/adapter/ids.ts'

function price(input?: number, output?: number, deprecated = false) {
  return { input, output, deprecated }
}

test('isFreeModel keys on the name', () => {
  assert.ok(isFreeModel('mimo-v2.5-free'))
  assert.ok(isFreeModel('BIG-PICKLE-FREE'))
  assert.ok(!isFreeModel('qwen3-max'))
})

test('decide gives ready metadata verdicts priority over the name', () => {
  // metadata pending: free-named pass, others blocked, nothing known
  assert.deepEqual(decide('x-free', new Map(), false), { allowed: true, source: 'name_free', known: false })
  assert.deepEqual(decide('paid', new Map(), false), { allowed: false, source: 'metadata_pending', known: false })
  assert.deepEqual(decide('paid', new Map(), true), { allowed: false, source: 'metadata_pending', known: false })
  // ready but model absent -> name fallback keeps its original intent
  assert.deepEqual(decide('paid', new Map([['other', price(0, 0)]]), true), {
    allowed: false,
    source: 'metadata_model_missing',
    known: false,
  })
  assert.deepEqual(decide('x-free', new Map([['other', price(0, 0)]]), true), {
    allowed: true,
    source: 'name_free',
    known: false,
  })
  // ready, known, and paid: a "free" name no longer resurrects it (the
  // deepseek-v4-flash-free regression)
  assert.deepEqual(decide('x-free', new Map([['x-free', price(1, 1)]]), true), {
    allowed: false,
    source: 'metadata_paid',
    known: true,
  })
  // deprecated with a free name: metadata deprecation outranks the name
  assert.deepEqual(decide('ghost-free', new Map([['ghost-free', price(0, 0, true)]]), true), {
    allowed: false,
    source: 'metadata_deprecated',
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

const zenBody = { data: [{ id: 'qwen-free' }, { id: 'paid-model' }, { id: 'ghost-free' }, { id: 'legacy-free' }] }
const metadataBody = {
  opencode: {
    models: {
      'qwen-free': { cost: { input: 0, output: 0 } },
      'paid-model': { cost: { input: 1, output: 2 } },
      'ghost-free': { cost: { input: 3, output: 4 } },
      // delisted upstream but still cataloged: deprecated metadata must deny
      // even though the name carries "free" (deepseek-v4-flash-free case)
      'legacy-free': { status: 'deprecated', cost: { input: 0, output: 0 } },
    },
  },
}

test('start() fast-retries while the live catalog is empty, then settles into the cadence', async () => {
  let zenCalls = 0
  const flaky = (async (url: string | URL) => {
    if (String(url).includes('/v1/models')) {
      zenCalls += 1
      if (zenCalls <= 2) throw new Error('network not ready yet')
      return new Response(JSON.stringify(zenBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(metadataBody), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl: flaky, startupRetryMs: 5, refreshSeconds: 3600 })
  try {
    await catalog.start()
    assert.equal(catalog.snapshot().total, 4)
    assert.equal(zenCalls, 3, 'two failed attempts then one success')
    assert.equal(catalog.snapshot().status, 'ready')
  } finally {
    catalog.stop()
  }
})

test('fetchZenModels sends the anonymous CLI disguise and parses ids', async () => {
  const capture: { url?: string; init?: RequestInit } = {}
  const ids = await fetchZenModels('https://opencode.ai/zen/', fakeFetch({ 'https://opencode.ai/zen/v1/models': zenBody }, capture), opencodeUserAgent())
  assert.deepEqual(ids, ['qwen-free', 'paid-model', 'ghost-free', 'legacy-free'])
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
    // ghost-free (paid metadata) and legacy-free (deprecated metadata) are both
    // filtered out; the cataloged-but-deprecated id no longer leaks through
    assert.deepEqual(catalog.list(), ['qwen-free'], 'paid and deprecated models are filtered out')
    assert.equal(catalog.decision('paid-model').allowed, false)
    assert.equal(catalog.decision('legacy-free').source, 'metadata_deprecated')
    assert.equal(catalog.snapshot().status, 'ready')
    assert.equal(catalog.snapshot().exposed, 1)
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

test('S3 vouch survives a stale deprecated flag but not a paid verdict', async () => {
  // hy3-free regression: models.dev flags it deprecated while it still works
  // upstream — a compile-time verified id keeps its vouch until delisted.
  const deprecatedFlagged = new ModelCatalog({
    fetchImpl: fakeFetch({
      'https://opencode.ai/zen/v1/models': { data: [{ id: 'mimo-v2.5-free' }] },
      'https://models.dev/api.json': {
        opencode: { models: { 'mimo-v2.5-free': { status: 'deprecated', cost: { input: 0, output: 0 } } } },
      },
    }),
  })
  try {
    await deprecatedFlagged.refreshOnce()
    assert.equal(deprecatedFlagged.decision('mimo-v2.5-free').allowed, true)
    assert.equal(deprecatedFlagged.decision('mimo-v2.5-free').source, 'static_verified')
  } finally {
    deprecatedFlagged.stop()
  }

  // a metadata-paid verdict still wins: the static list never resurrects a
  // model the metadata knows is paid.
  const paidVerdict = new ModelCatalog({
    fetchImpl: fakeFetch({
      'https://opencode.ai/zen/v1/models': { data: [{ id: 'big-pickle' }] },
      'https://models.dev/api.json': {
        opencode: { models: { 'big-pickle': { cost: { input: 3, output: 4 } } } },
      },
    }),
  })
  try {
    await paidVerdict.refreshOnce()
    assert.equal(paidVerdict.decision('big-pickle').allowed, false)
    assert.equal(paidVerdict.decision('big-pickle').source, 'metadata_paid')
  } finally {
    paidVerdict.stop()
  }
})
