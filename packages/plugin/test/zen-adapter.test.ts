import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { isResponsesModel, PROVIDER_ID, reasoningEfforts, reasoningEffortWire, ZenAdapter } from '../src/adapter/zen-adapter.ts'

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
    list: () => ['big-pickle', 'big-pickle', 'mimo-v2.5-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => ({ reasoning: true, effortValues: [] }),
  })
  const models = adapter.listModels('opencode2dsh')
  assert.deepEqual(models.map((m) => m.id), ['big-pickle', 'mimo-v2.5-free'])
})

test('reasoningEfforts: declared ladder wins, none folds into off, default ladder otherwise', () => {
  // no capability / non-reasoning model: advertise nothing
  assert.equal(reasoningEfforts(undefined), undefined)
  assert.equal(reasoningEfforts({ reasoning: false, effortValues: ['low'] }), undefined)
  // reasoning without a declared ladder: the standard five the gateway accepts
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: [] })?.map((e) => e.id),
    ['off', 'minimal', 'low', 'medium', 'high'],
  )
  // declared ladder (muse-spark shape) is offered verbatim, ladder-ordered
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: ['xhigh', 'low', 'medium'] })?.map((e) => e.id),
    ['low', 'medium', 'xhigh'],
  )
  // metadata `none` folds into our `off`; out-of-vocabulary values drop
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: ['none', 'high', 'banana'] })?.map((e) => e.id),
    ['off', 'high'],
  )
  // selector labels are the capitalized level names
  assert.deepEqual(reasoningEfforts({ reasoning: true, effortValues: [] })?.[0], { id: 'off', name: 'Off' })
})

test('reasoningEffortWire maps picker ids to the gateway spelling', () => {
  // no selection: inject nothing (provider default keeps always-think models thinking)
  assert.equal(reasoningEffortWire(undefined), undefined)
  // off must SEND none — a mere omission never disables Zen's thinking models
  assert.equal(reasoningEffortWire('off'), 'none')
  // ladder levels pass through verbatim
  assert.equal(reasoningEffortWire('low'), 'low')
  assert.equal(reasoningEffortWire('xhigh'), 'xhigh')
  // unknown ids were never advertised; inject nothing rather than risk the 400
  assert.equal(reasoningEffortWire('banana'), undefined)
})

test('resolveModel advertises the thinking-level picker for reasoning models only', () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle', 'ghost'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: (model: string) =>
      model === 'big-pickle' ? { reasoning: true, effortValues: ['low', 'high'] } : undefined,
  })
  assert.deepEqual(
    adapter.resolveModel('opencode2dsh', 'big-pickle').reasoning?.efforts.map((e) => e.id),
    ['low', 'high'],
  )
  // unknown metadata: no reasoning field — dsh-llm then offers only the default
  assert.equal(adapter.resolveModel('opencode2dsh', 'ghost').reasoning, undefined)
})

/** Scripted provider that records the streamSimple options it receives. */
function capturingProvider() {
  const captured: Array<{ onPayload?: (payload: unknown) => unknown }> = []
  const provider = {
    streamSimple(_model: unknown, _context: unknown, options: { onPayload?: (payload: unknown) => unknown }): AsyncIterable<{ type: string }> {
      captured.push(options)
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'text_delta', delta: 'hi' }
        yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  return { provider, captured }
}

/** A body that already satisfies the free-lane agent-shape gate. */
const gateBody = {
  model: 'big-pickle',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  tools: ['bash', 'read'].map((name) => ({ type: 'function', function: { name, description: 'd', parameters: {} } })),
}

async function runStream(catalogReasoning: boolean, effort?: string): Promise<Array<{ onPayload?: (payload: unknown) => unknown }>> {
  const { provider, captured } = capturingProvider()
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => ({ reasoning: catalogReasoning, effortValues: [] }),
    },
    { providerOverride: provider },
  )
  const options = { provider: 'opencode2dsh', model: 'big-pickle', messages: [], temperature: 0, maxTokens: 16 }
  const stream = adapter.stream({ ...options, ...(effort !== undefined ? { reasoningEffort: effort } : {}) } as never)
  for await (const chunk of stream) void chunk
  return captured
}

test('stream injects the selected reasoning_effort into the outgoing body', async () => {
  // off -> wire none (the only spelling that stops the always-think models)
  const offOptions = (await runStream(true, 'off'))[0]!
  assert.deepEqual(offOptions.onPayload?.({ ...gateBody }), { ...gateBody, reasoning_effort: 'none' })

  // ladder levels ride verbatim
  const lowOptions = (await runStream(true, 'low'))[0]!
  assert.deepEqual(lowOptions.onPayload?.({ ...gateBody }), { ...gateBody, reasoning_effort: 'low' })

  // no selection: the onPayload stays the plain gate shaper (a gate-satisfied
  // body needs no rewrite -> undefined, and no effort field is ever added)
  const defaultOptions = (await runStream(true))[0]!
  assert.equal(defaultOptions.onPayload?.({ ...gateBody }), undefined)
})

test('stream keeps the free-lane gate rewrite alongside the effort injection', async () => {
  // a body missing the gate tools gets them AND the effort in one rewrite
  const offOptions = (await runStream(true, 'off'))[0]!
  const shaped = offOptions.onPayload?.({ model: 'big-pickle', messages: [], stream: true }) as Record<string, unknown>
  assert.equal(shaped.reasoning_effort, 'none')
  assert.deepEqual(
    (shaped.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort(),
    ['bash', 'read'],
  )
  assert.equal(shaped.tool_choice, 'none')

  // non-chat payloads pass through untouched even with an effort selected
  assert.equal(offOptions.onPayload?.(null), undefined)
})

test('isResponsesModel routes muse-spark to responses, everything else to chat', () => {
  for (const id of ['muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free', 'muse-spark-1.2', 'MUSE-SPARK-1.3']) {
    assert.equal(isResponsesModel(id), true, id)
  }
  for (const id of ['big-pickle', 'mimo-v2.5-free', 'deepseek-v4-flash', '']) {
    assert.equal(isResponsesModel(id), false, id || '(empty)')
  }
})

test('ZenAdapter constructs the responses provider alongside chat', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  assert.equal(typeof adapter.stream, 'function')
})

test('responses models use the wider body-idle window, injectable for tests', async () => {
  // A provider that emits `start` immediately, then never speaks again: the
  // stream can only end through the body-idle watchdog, so the surfaced
  // error's arrival time measures the window actually applied per model.
  async function* hangAfterStart(): AsyncGenerator<{ type: string; partial: unknown }> {
    yield { type: 'start', partial: { content: [] } }
    await new Promise(() => {})
  }
  const measure = async (model: string) => {
    const adapter = new ZenAdapter(
      { list: () => [], decision: () => ({ allowed: true, source: 'test', known: true }), reasoningCapability: () => undefined },
      { providerOverride: { streamSimple: () => hangAfterStart() }, firstEventMs: 50, bodyIdleMs: 50, responsesBodyIdleMs: 400 },
    )
    const began = Date.now()
    let reason: { kind: string } | undefined
    for await (const chunk of adapter.stream({ provider: 'opencode2dsh', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      if (chunk.type === 'finish') {
        reason = chunk.reason as { kind: string }
        break
      }
    }
    return { reason, elapsed: Date.now() - began }
  }
  const chat = await measure('big-pickle')
  assert.equal(chat.reason?.kind, 'error')
  assert.ok(chat.elapsed < 200, `chat should honor the injected 50ms window, took ${chat.elapsed}ms`)
  const responses = await measure('muse-spark-1.2-contributor-free')
  assert.equal(responses.reason?.kind, 'error')
  assert.ok(responses.elapsed > 350, `responses should honor the injected 400ms window, took ${responses.elapsed}ms`)
})
