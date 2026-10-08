import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeModelsDev, decide, fetchZenModels, isFreeModel, ModelCatalog, staticFreeModels } from '../src/adapter/catalog.ts'
import { opencodeUserAgent } from '../src/adapter/ids.ts'

function price(input?: number, output?: number, deprecated = false, reasoning = false) {
  return { input, output, deprecated, reasoning }
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

test('decodeModelsDev extracts the reasoning flag and declared effort ladders', () => {
  const payload = {
    opencode: {
      models: {
        // live shape (2026-09-18): effort entries carry the selectable ladder
        'muse-free': {
          cost: { input: 0, output: 0 },
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
        },
        // toggle/budget options reason but declare no ladder
        'toggle-free': { cost: { input: 0, output: 0 }, reasoning: true, reasoning_options: [{ type: 'toggle' }] },
        'budget-free': {
          cost: { input: 0, output: 0 },
          reasoning: true,
          reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', max: 81920 }],
        },
        // effort values dedupe, keep first-seen order
        'dupe-free': { cost: { input: 0, output: 0 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['high', 'low', 'low'] }] },
        // reasoning flag without options
        'plain-free': { cost: { input: 0, output: 0 }, reasoning: true },
        'dumb-free': { cost: { input: 0, output: 0 }, reasoning: false },
        'mystery-free': { cost: { input: 0, output: 0 } },
      },
    },
  }
  const prices = decodeModelsDev(payload)
  assert.deepEqual(prices.get('muse-free'), { ...price(0, 0, false, true), effortValues: ['minimal', 'low', 'medium', 'high', 'xhigh'] })
  assert.deepEqual(prices.get('toggle-free'), { ...price(0, 0, false, true), effortValues: [] })
  assert.deepEqual(prices.get('budget-free'), { ...price(0, 0, false, true), effortValues: [] })
  assert.deepEqual(prices.get('dupe-free'), { ...price(0, 0, false, true), effortValues: ['high', 'low'] })
  assert.deepEqual(prices.get('plain-free'), price(0, 0, false, true))
  assert.deepEqual(prices.get('dumb-free'), price(0, 0))
  assert.deepEqual(prices.get('mystery-free'), price(0, 0))
})

test('ModelCatalog.reasoningCapability reads the parsed metadata', async () => {
  const catalog = new ModelCatalog({
    fetchImpl: fakeFetch({
      'https://opencode.ai/zen/v1/models': zenBody,
      'https://models.dev/api.json': {
        opencode: {
          models: {
            'qwen-free': { cost: { input: 0, output: 0 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
            'paid-model': { cost: { input: 1, output: 2 }, reasoning: true },
          },
        },
      },
    }),
  })
  try {
    await catalog.refreshOnce()
    assert.deepEqual(catalog.reasoningCapability('qwen-free'), { reasoning: true, effortValues: ['low', 'high'] })
    // capability is independent of the free decision: paid models still speak
    assert.deepEqual(catalog.reasoningCapability('paid-model'), { reasoning: true, effortValues: [] })
    // metadata cannot speak for the model
    assert.equal(catalog.reasoningCapability('ghost-free'), undefined)
  } finally {
    catalog.stop()
  }
})

test('decodeModelsDev extracts the declared context/output limits', () => {
  const payload = {
    opencode: {
      models: {
        // live shape: limit.context is the window, limit.output the max completion
        'windowed-free': { cost: { input: 0, output: 0 }, limit: { context: 131072, output: 16384 } },
        // output-only and context-only declarations both stand alone
        'output-only-free': { cost: { input: 0, output: 0 }, limit: { output: 8192 } },
        'context-only-free': { cost: { input: 0, output: 0 }, limit: { context: 1048576 } },
        // no limit block: keys stay absent so pre-limit caches remain valid
        'limitless-free': { cost: { input: 0, output: 0 } },
        // malformed values are dropped, not guessed
        'bad-limit-free': { cost: { input: 0, output: 0 }, limit: { context: 'huge', output: null } },
      },
    },
  }
  const prices = decodeModelsDev(payload)
  assert.deepEqual(prices.get('windowed-free')?.contextWindow, 131072)
  assert.deepEqual(prices.get('windowed-free')?.maxOutput, 16384)
  assert.equal(prices.get('output-only-free')?.contextWindow, undefined)
  assert.equal(prices.get('output-only-free')?.maxOutput, 8192)
  assert.equal(prices.get('context-only-free')?.maxOutput, undefined)
  assert.equal('contextWindow' in (prices.get('limitless-free') ?? {}), false)
  assert.equal('maxOutput' in (prices.get('limitless-free') ?? {}), false)
  assert.equal(prices.get('bad-limit-free')?.contextWindow, undefined)
  assert.equal(prices.get('bad-limit-free')?.maxOutput, undefined)
})

test('ModelCatalog.limits speaks only when the metadata declares them', async () => {
  const catalog = new ModelCatalog({
    fetchImpl: fakeFetch({
      'https://opencode.ai/zen/v1/models': zenBody,
      'https://models.dev/api.json': {
        opencode: {
          models: {
            'qwen-free': { cost: { input: 0, output: 0 }, limit: { context: 262144, output: 32768 } },
            'paid-model': { cost: { input: 1, output: 2 } },
          },
        },
      },
    }),
  })
  try {
    await catalog.refreshOnce()
    assert.deepEqual(catalog.limits('qwen-free'), { contextWindow: 262144, maxOutput: 32768 })
    // capability is independent of the free decision: paid models still speak
    assert.deepEqual(catalog.limits('paid-model'), undefined)
    // metadata cannot speak for the model
    assert.equal(catalog.limits('ghost-free'), undefined)
  } finally {
    catalog.stop()
  }
})

test('decodeModelsDev extracts the declared input modalities', () => {
  const payload = {
    opencode: {
      models: {
        // live shape: modalities.input lists every accepted input kind
        'multimodal-free': { cost: { input: 0, output: 0 }, modalities: { input: ['text', 'image', 'video'] } },
        // output-only declarations are valid
        'image-only-free': { cost: { input: 0, output: 0 }, modalities: { input: ['image'] } },
        // no modalities block: keys stay absent so pre-modality caches stay valid
        'plain-free': { cost: { input: 0, output: 0 } },
        // an empty modalities object is the same as none
        'silent-free': { cost: { input: 0, output: 0 }, modalities: {} },
        // malformed values are dropped, not guessed
        'bad-modalities-free': { cost: { input: 0, output: 0 }, modalities: { input: 'image' } },
        'empty-modalities-free': { cost: { input: 0, output: 0 }, modalities: { input: [] } },
        'noise-modalities-free': { cost: { input: 0, output: 0 }, modalities: { input: ['text', '', 7, 'image', 'image'] } },
      },
    },
  }
  const prices = decodeModelsDev(payload)
  assert.deepEqual(prices.get('multimodal-free')?.modalities, ['text', 'image', 'video'])
  assert.deepEqual(prices.get('image-only-free')?.modalities, ['image'])
  assert.equal('modalities' in (prices.get('plain-free') ?? {}), false)
  assert.equal('modalities' in (prices.get('silent-free') ?? {}), false)
  assert.equal(prices.get('bad-modalities-free')?.modalities, undefined)
  assert.equal(prices.get('empty-modalities-free')?.modalities, undefined)
  assert.deepEqual(prices.get('noise-modalities-free')?.modalities, ['text', 'image'])
})

test('ModelCatalog.modalities speaks only when the metadata declares them', async () => {
  const catalog = new ModelCatalog({
    fetchImpl: fakeFetch({
      'https://opencode.ai/zen/v1/models': zenBody,
      'https://models.dev/api.json': {
        opencode: {
          models: {
            'qwen-free': { cost: { input: 0, output: 0 }, modalities: { input: ['text', 'image'] } },
            'plain-free': { cost: { input: 0, output: 0 } },
          },
        },
      },
    }),
  })
  try {
    await catalog.refreshOnce()
    assert.deepEqual(catalog.modalities('qwen-free'), ['text', 'image'])
    // no modalities block: the adapter keeps its own vision pattern
    assert.equal(catalog.modalities('plain-free'), undefined)
    // metadata cannot speak for the model
    assert.equal(catalog.modalities('ghost-free'), undefined)
    // the returned array is a copy: a caller cannot mutate the cache
    catalog.modalities('qwen-free')?.push('audio')
    assert.deepEqual(catalog.modalities('qwen-free'), ['text', 'image'])
  } finally {
    catalog.stop()
  }
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

test('warm() waits for the first live fetch so a list() read is never the bootstrap list (issue #45)', async () => {
  // The gate holds the first fetch back, exactly like a slow first round on
  // a cold start: cold list() reads staticFreeModels, warm() blocks until
  // the fetch lands, then list() exposes the live roster.
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes('/v1/models')) await gate
    const body = String(url).includes('/v1/models') ? zenBody : metadataBody
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl })
  try {
    assert.deepEqual(catalog.list(), staticFreeModels, 'cold catalog answers with the bootstrap list')
    const warmed = catalog.warm()
    queueMicrotask(() => release?.())
    await warmed
    assert.deepEqual(catalog.list(), ['qwen-free'], 'warm() resolves into the live roster')
    assert.equal(catalog.snapshot().status, 'ready')
  } finally {
    catalog.stop()
  }
})

test('warm() shares the in-flight refresh round instead of fetching twice', async () => {
  let zenCalls = 0
  const fetchImpl = (async (url: string | URL) => {
    const body = String(url).includes('/v1/models') ? zenBody : metadataBody
    if (String(url).includes('/v1/models')) {
      zenCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl })
  try {
    const inFlight = catalog.refreshOnce()
    await catalog.warm()
    await inFlight
    assert.equal(zenCalls, 1, 'warm() joins start()\'s in-flight round, no duplicate fetch')
    assert.deepEqual(catalog.list(), ['qwen-free'])
  } finally {
    catalog.stop()
  }
})

test('warm() is bounded: a dead network answers with the static list, a slow one times out', async () => {
  // the round settles (network error) before the bound: static list, promptly
  const fail = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  const dead = new ModelCatalog({ fetchImpl: fail })
  try {
    await dead.warm(2_000)
    assert.deepEqual(dead.list(), staticFreeModels)
    assert.equal(dead.snapshot().status, 'pending')
  } finally {
    dead.stop()
  }

  // the round outlives the bound: warm() still returns at the deadline
  const slow = (async (url: string | URL) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const body = String(url).includes('/v1/models') ? zenBody : metadataBody
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl: slow })
  try {
    const startedAt = Date.now()
    await catalog.warm(25)
    assert.ok(Date.now() - startedAt < 250, 'warm() returned at its bound, not with the fetch')
    assert.deepEqual(catalog.list(), staticFreeModels)
  } finally {
    catalog.stop()
  }
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
