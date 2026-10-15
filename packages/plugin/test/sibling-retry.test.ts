import test from 'node:test'
import assert from 'node:assert/strict'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import type { HarnessChunk, PiDoneMessage, PiEvent } from '../src/adapter/events.ts'
import type { HarnessGenerateOptions } from '../src/adapter/messages.ts'

const options: HarnessGenerateOptions = {
  provider: 'opencode2dsh',
  model: 'big-pickle',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  maxTokens: 16,
}

function message(overrides: Partial<PiDoneMessage> = {}): PiDoneMessage {
  return {
    api: 'openai-completions',
    provider: 'opencode2dsh',
    model: options.model,
    content: [],
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    ...overrides,
  }
}

/** The anonymous lane's refusal, as pi-ai reports it before any content arrives. */
function refused(): PiEvent[] {
  return [
    {
      type: 'error',
      error: message({
        stopReason: 'error',
        content: [],
        errorMessage: '403 FreeTierError: free tier can only be used from within OpenCode',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      }),
    },
  ]
}

function answered(text = 'OK'): PiEvent[] {
  const partial = { content: [{ type: 'text', text }] }
  return [
    { type: 'text_start', contentIndex: 0, partial },
    { type: 'text_delta', contentIndex: 0, delta: text, partial },
    { type: 'text_end', contentIndex: 0, content: text, partial },
    { type: 'done', message: message({ stopReason: 'stop', content: partial.content }) },
  ]
}

type WireOptions = { headers: Record<string, string> }
type WireModel = { baseUrl: string }

function scripted(scripts: PiEvent[][]) {
  const calls: Array<{ model: WireModel; options: WireOptions }> = []
  const adapter = new ZenAdapter(
    {
      list: () => [options.model],
      decision: () => ({ allowed: true, known: true, source: 'test' }),
      reasoningCapability: () => ({ reasoning: false, effortValues: [] }),
    },
    {
      providerOverride: {
        streamSimple(model: unknown, _context: unknown, wireOptions: WireOptions) {
          const events = scripts[calls.length]
          assert.ok(events, 'unexpected extra request')
          calls.push({ model: model as WireModel, options: wireOptions })
          return (async function* () {
            for (const event of events) yield event
          })()
        },
      },
    },
  )
  return { adapter, calls }
}

async function collect(adapter: ZenAdapter): Promise<HarnessChunk[]> {
  const chunks: HarnessChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

test('a refusal before any content replays once on the sibling host', async () => {
  const { adapter, calls } = scripted([refused(), answered()])
  const chunks = await collect(adapter)

  assert.equal(calls.length, 2, 'the refused attempt is replayed once')
  assert.equal(calls[0]!.model.baseUrl, 'https://opencode.ai/inference/v1')
  // pi-ai reads the URL from the model, so the replay has to move the model (#75).
  assert.equal(calls[1]!.model.baseUrl, 'https://opencode.ai/zen/v1')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('a second refusal surfaces the error instead of looping', async () => {
  const { adapter, calls } = scripted([refused(), refused()])
  const chunks = await collect(adapter)

  assert.equal(calls.length, 2, 'one replay and no more')
  assert.equal(calls[1]!.model.baseUrl, 'https://opencode.ai/zen/v1')
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type === 'finish') assert.equal(finish.reason.kind, 'error')
})

test('content already delivered forbids the replay', async () => {
  const { adapter, calls } = scripted([
    [
      ...answered('partial').slice(0, 3),
      ...refused(),
    ],
  ])
  const chunks = await collect(adapter)

  assert.equal(calls.length, 1, 'a stream that already produced text is never replayed')
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true)
})
