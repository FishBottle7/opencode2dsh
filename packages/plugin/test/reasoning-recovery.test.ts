import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import type { Context, Model } from '@earendil-works/pi-ai'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import type { HarnessChunk, PiDoneMessage, PiEvent } from '../src/adapter/events.ts'
import { piAiTranscriptShape, type HarnessGenerateOptions } from '../src/adapter/messages.ts'

const options: HarnessGenerateOptions = {
  provider: 'opencode2dsh',
  model: 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Calculate 17 * 19.' }] }],
  reasoningEffort: 'high',
  maxTokens: 64,
}

// pi-ai >= 0.87 splits the provider-facing context type: every api
// implementation takes a `TranscriptContext`, which is the `Context` already
// folded by `normalizeContext`. The subpath that exports it only exists from
// 0.86 on, so it is reached dynamically and only when the installed pi-ai is
// actually message-shaped; on 0.82.x the api layer reads `Context` directly and
// this is the identity. 0.82's exports map has no `./utils/*` entry at all,
// which is why this cannot be a static import.
async function brandForInstalledPiAi(context: Context): Promise<unknown> {
  if ((await piAiTranscriptShape()) !== 'message') return context
  const specifier = `${'@earendil-works'}/pi-ai/utils/transcript`
  const { normalizeContext } = await import(specifier)
  return normalizeContext(context)
}

// The api layer is called through a cast: its context parameter carries a brand
// that only exists from 0.87 on and that this test cannot name without importing
// the 0.86+-only subpath above.
const openaiCompletionsUnbranded = openaiCompletions as unknown as {
  streamSimple(model: Model<'openai-completions'>, context: unknown, wireOptions: never): AsyncIterable<unknown>
}

function message(overrides: Partial<PiDoneMessage> = {}): PiDoneMessage {
  return {
    api: 'openai-completions', provider: 'opencode2dsh', model: options.model,
    content: [{ type: 'thinking', thinking: 'Working it out' }],
    stopReason: 'length',
    usage: { input: 10, output: 64, cacheRead: 3, cacheWrite: 2, totalTokens: 79 },
    ...overrides,
  }
}

function thinking(): PiEvent[] {
  const partial = { content: [{ type: 'thinking', thinking: 'Working it out' }] }
  return [
    { type: 'thinking_start', contentIndex: 0, partial },
    { type: 'thinking_delta', contentIndex: 0, delta: 'Working it out', partial },
    { type: 'thinking_end', contentIndex: 0, content: 'Working it out', partial },
  ]
}

function answer(): PiEvent[] {
  const partial = { content: [{ type: 'text', text: '323' }] }
  return [
    { type: 'text_start', contentIndex: 0, partial },
    { type: 'text_delta', contentIndex: 0, delta: '323', partial },
    { type: 'text_end', contentIndex: 0, content: '323', partial },
    { type: 'done', message: message({
      stopReason: 'stop', content: partial.content,
      usage: { input: 11, output: 4, cacheRead: 5, cacheWrite: 1, totalTokens: 21 },
    }) },
  ]
}

type WireOptions = {
  onPayload: (payload: unknown) => unknown
  maxTokens?: number
  signal?: AbortSignal
  headers: Record<string, string>
}

function scripted(scripts: PiEvent[][], efforts: string[] = [], beforeTerminal?: () => void) {
  const calls: Array<{ model: unknown; context: unknown; options: WireOptions }> = []
  const adapter = new ZenAdapter({
    list: () => [options.model],
    decision: () => ({ allowed: true, known: true, source: 'test' }),
    reasoningCapability: () => ({ reasoning: true, effortValues: efforts }),
  }, { providerOverride: {
    streamSimple(model: unknown, context: unknown, wireOptions: WireOptions) {
      const events = scripts[calls.length]
      assert.ok(events, 'unexpected extra request')
      calls.push({ model, context, options: wireOptions })
      return (async function* () {
        for (const event of events) {
          if (event.type === 'done' || event.type === 'error') beforeTerminal?.()
          yield event
        }
      })()
    },
  } })
  return { adapter, calls }
}

async function collect(adapter: ZenAdapter, request = options): Promise<HarnessChunk[]> {
  const chunks: HarnessChunk[] = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}

test('reasoning-only length retries once with Off, streams immediately and aggregates both requests', async () => {
  const { adapter, calls } = scripted([[...thinking(), { type: 'done', message: message() }], answer()])
  const stream = adapter.stream(options)
  const chunks: HarnessChunk[] = []
  chunks.push((await stream.next()).value!)
  assert.equal(calls.length, 1, 'first reasoning block is streamed before retry')
  for await (const chunk of stream) chunks.push(chunk)

  assert.equal(calls.length, 2)
  assert.equal((calls[0]!.options.onPayload({}) as Record<string, unknown>).reasoning_effort, 'high')
  // the Off retry has no wire spelling (both 'none' and 'off' are a hard 400),
  // so the payload must come back with no reasoning_effort field at all
  assert.equal(calls[1]!.options.onPayload({}), undefined)
  assert.deepEqual(calls[1]!.context, calls[0]!.context, 'retry uses the original conversation')
  assert.equal(calls[1]!.options.maxTokens, 64)
  assert.equal(calls[1]!.options.headers['x-opencode-session'], calls[0]!.options.headers['x-opencode-session'])
  assert.notEqual(calls[1]!.options.headers['x-opencode-request'], calls[0]!.options.headers['x-opencode-request'])
  assert.deepEqual(chunks.filter((c) => c.type === 'block-start').map((c) => c.index), [0, 1])
  assert.deepEqual(chunks.filter((c) => c.type === 'block-end').map((c) => c.index), [0, 1])
  assert.equal(chunks.find((c) => c.type === 'text-delta')?.index, 1)
  assert.deepEqual(chunks.slice(-2), [
    { type: 'usage', usage: { inputTokens: 21, outputTokens: 68, cacheReadTokens: 8, cacheWriteTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(chunks.filter((c) => c.type === 'finish').length, 1)
})

test('recovery also applies to provider-default thinking, but never exceeds one retry', async () => {
  const { adapter, calls } = scripted([
    [...thinking(), { type: 'done', message: message() }],
    [...thinking(), { type: 'done', message: message() }],
  ])
  const chunks = await collect(adapter, { ...options, reasoningEffort: undefined })
  assert.equal(calls.length, 2)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.deepEqual(chunks.filter((c) => c.type === 'block-start').map((c) => c.index), [0, 1])
})

test('any text or tool-call event forbids replay, including incomplete tool calls', async () => {
  const partial = { content: [{ type: 'toolCall', id: 'call-1', name: 'write' }] }
  const cases: PiEvent[] = [
    { type: 'text_delta', contentIndex: 1, delta: ' ', partial: { content: [] } },
    { type: 'text_end', contentIndex: 1, content: 'partial answer', partial: { content: [] } },
    { type: 'toolcall_start', contentIndex: 1, partial },
    { type: 'toolcall_delta', contentIndex: 1, delta: '{', partial },
    { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'call-1', name: 'write', arguments: {} }, partial },
  ]
  for (const event of cases) {
    const { adapter, calls } = scripted([[...thinking(), event, { type: 'done', message: message() }]])
    const chunks = await collect(adapter)
    assert.equal(calls.length, 1, event.type)
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  }
})

test('Off, models without Off and Responses-only Muse do not trigger recovery', async () => {
  for (const entry of [
    { effort: 'off', model: options.model, ladder: [] },
    { effort: 'none', model: options.model, ladder: [] },
    { effort: 'high', model: options.model, ladder: ['low', 'high'] },
    { effort: 'high', model: 'muse-spark-1.3-contributor-free', ladder: [] },
  ]) {
    const { adapter, calls } = scripted([[...thinking(), { type: 'done', message: message() }]], entry.ladder)
    await collect(adapter, { ...options, model: entry.model, reasoningEffort: entry.effort })
    assert.equal(calls.length, 1)
  }
})

test('terminal answer or tool content forbids replay even if its delta events are absent', async () => {
  for (const block of [
    { type: 'text', text: 'answer' },
    { type: 'toolCall', id: 'call-1', name: 'write', arguments: {} },
    { type: 'unknown-output' },
  ]) {
    const { adapter, calls } = scripted([[...thinking(), { type: 'done', message: message({ content: [block] }) }]])
    await collect(adapter)
    assert.equal(calls.length, 1)
  }
})

test('empty output, completed reasoning and upstream failures do not trigger recovery', async () => {
  const cases: PiEvent[][] = [
    [{ type: 'done', message: message({ content: [] }) }],
    [...thinking(), { type: 'done', message: message({ stopReason: 'stop' }) }],
    [...thinking(), { type: 'error', error: message({ stopReason: 'error', errorMessage: '429 rate limit' }) }],
    [...thinking(), { type: 'error', error: message({ stopReason: 'aborted' }) }],
  ]
  for (const events of cases) {
    const { adapter, calls } = scripted([events])
    await collect(adapter)
    assert.equal(calls.length, 1)
  }
})

test('cancellation after the first request prevents recovery and preserves its usage', async () => {
  const controller = new AbortController()
  const { adapter, calls } = scripted([[...thinking(), { type: 'done', message: message() }]], [], () => controller.abort())
  const chunks = await collect(adapter, { ...options, signal: controller.signal })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.options.signal, controller.signal)
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 64, cacheReadTokens: 3, cacheWriteTokens: 2 } })
})

test('retry failures keep their actual finish reason and account for the failed first attempt', async () => {
  for (const stopReason of ['error', 'aborted'] as const) {
    const { adapter, calls } = scripted([
      [...thinking(), { type: 'done', message: message() }],
      [{ type: 'error', error: message({ stopReason, content: [], errorMessage: '403 invalid API key',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      }) }],
    ])
    const controller = new AbortController()
    const chunks = await collect(adapter, { ...options, signal: controller.signal })
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.options.signal, controller.signal)
    const finish = chunks.at(-1)
    assert.equal(finish?.type, 'finish')
    if (finish?.type === 'finish') assert.equal(finish.reason.kind, stopReason)
    assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 64, cacheReadTokens: 3, cacheWriteTokens: 2 } })
  }
})

test('real pi-ai HTTP streaming sends the Off fallback and returns one usable response', { timeout: 10000 }, async () => {
  const bodies: Array<Record<string, unknown>> = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    bodies.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const first = bodies.length === 1
    const envelope = { id: `response-${bodies.length}`, object: 'chat.completion.chunk', created: 0, model: options.model }
    const write = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
    write({ ...envelope, choices: [{ index: 0, delta: first ? { reasoning_content: 'Working it out' } : { content: '323' }, finish_reason: null }] })
    write({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: first ? 'length' : 'stop' }], usage: { prompt_tokens: first ? 10 : 11, completion_tokens: first ? 64 : 4, total_tokens: first ? 74 : 15 } })
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  try {
    const adapter = new ZenAdapter({
      list: () => [options.model],
      decision: () => ({ allowed: true, known: true, source: 'test' }),
      reasoningCapability: () => ({ reasoning: true, effortValues: [] }),
    }, { providerOverride: {
      streamSimple(model: Model<'openai-completions'>, context: Context, wireOptions: never) {
        // a generator, not an async function: the adapter consumes this as an
        // AsyncIterable, and awaiting the brand must not wrap it in a Promise
        return (async function* () {
          yield* openaiCompletionsUnbranded.streamSimple({ ...model, baseUrl }, await brandForInstalledPiAi(context), wireOptions)
        })()
      },
    } })
    const chunks = await collect(adapter, { ...options, signal: AbortSignal.timeout(5000) })
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0]!.reasoning_effort, 'high')
    assert.equal('reasoning_effort' in bodies[1]!, false, 'the Off retry omits the field')
    assert.deepEqual(bodies[0]!.messages, bodies[1]!.messages)
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '323')
    assert.deepEqual(chunks.filter((c) => c.type === 'block-start').map((c) => c.index), [0, 1])
    assert.deepEqual(chunks.slice(-2), [
      { type: 'usage', usage: { inputTokens: 21, outputTokens: 68 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
