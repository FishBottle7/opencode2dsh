import { ensureResponsesFreeLaneShape } from '../src/adapter/messages.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPiTranscriptShape, ensureFreeLaneShape, piAiTranscriptShape, resetPiAiTranscriptShape, toPiContext, type HarnessGenerateOptions, type HarnessMessage, type PiMessage } from '../src/adapter/messages.ts'

function expectAssistant(message: PiMessage | undefined): Extract<PiMessage, { role: 'assistant' }> {
  assert.equal(message?.role, 'assistant')
  return message as Extract<PiMessage, { role: 'assistant' }>
}

function expectRole(message: PiMessage | undefined, role: PiMessage['role']): PiMessage {
  assert.equal(message?.role, role)
  return message as PiMessage
}

/**
 * pi-ai only exports the system-message reader from 0.86 on, so the reader is
 * reached through a structural type and looked up at runtime. PiTool.parameters
 * is `unknown` in this plugin, so PiMessage is deliberately wider than pi-ai's
 * own Message, and the reader wants the narrow shape.
 */
type SystemMessageLike = { role: string; content: unknown; toolsAdded?: unknown; timestamp: number }
const systemMessageReader = (piAi: Record<string, unknown>): ((message: SystemMessageLike) => string) | undefined => {
  const reader = piAi.getSystemMessageText
  return typeof reader === 'function' ? (reader as (message: SystemMessageLike) => string) : undefined
}
async function loadNormalizeContext(): Promise<((context: unknown) => { messages: SystemMessageLike[] }) | undefined> {
  // `./utils/*` is not in 0.82's exports map, so this import is dynamic and
  // legitimately fails there; the caller treats that as "no fold to test". The
  // specifier is held in a variable so the compiler does not try to resolve a
  // subpath the installed pi-ai may not publish.
  const specifier = `${'@earendil-works'}/pi-ai/utils/transcript`
  try {
    const mod = await import(specifier) as unknown as { normalizeContext: (context: unknown) => { messages: SystemMessageLike[] } }
    return mod.normalizeContext
  } catch {
    return undefined
  }
}

function options(overrides: Partial<HarnessGenerateOptions> = {}): HarnessGenerateOptions {
  return { provider: 'opencode2dsh', model: 'qwen-free', messages: [], ...overrides }
}

/** Run against an empty attachment store rooted at a temp DSH_HOME. */
async function withDshHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'o2d-dsh-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** Write one normalized attachment object into an empty store. */
async function putObject(home: string, sha: string, bytes: Buffer): Promise<void> {
  const dir = join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, sha), bytes)
}

test('system prompt and in-transcript system text ride a leading system message', async () => {
  const shape = await piAiTranscriptShape()
  const context = await toPiContext(
    options({
      system: 'be helpful',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'be helpful' }] }],
    }),
  )
  if (shape === 'message') {
    assert.equal(context.messages.length, 2)
    assert.deepEqual(context.messages[0], { role: 'system', content: 'be helpful', timestamp: 0 })
    assert.equal(context.messages[0]?.role, 'system')
    assert.equal('systemPrompt' in context, false, 'Context.systemPrompt is gone in pi-ai 0.87')
    assert.deepEqual(context.messages[1], { role: 'user', content: 'be helpful', timestamp: 0 })
    return
  }
  // The context shape has no system message: the prompt rides the field, and
  // in-transcript system text still has to become a leading message or nothing
  // will read it.
  assert.equal('systemPrompt' in context, true)
  assert.equal(context.systemPrompt, 'be helpful')
})

test('the leading system message carries the tool set as toolsAdded', async () => {
  const shape = await piAiTranscriptShape()
  const tools = [{ name: 'shell', description: 'run', parameters: { type: 'object' } }]
  const context = await toPiContext(options({ system: 'sys', tools }))
  if (shape === 'message') {
    assert.equal(context.messages.length, 1)
    assert.deepEqual(context.messages[0], { role: 'system', content: 'sys', toolsAdded: tools, timestamp: 0 })
    return
  }
  assert.deepEqual(context.tools, tools)
})

test('no system prompt and no tools means no leading message', async () => {
  const context = await toPiContext(options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
  assert.equal(context.messages.length, 1)
  assert.equal(context.messages[0]?.role, 'user')
})

test('tool results become toolResult messages with the name from the prior toolCall', async () => {
  const messages: HarnessMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }], isError: false },
      ],
    },
  ]
  const context = await toPiContext(options({ messages }))
  assert.equal(context.messages.length, 3)
  const toolResult = expectRole(context.messages[2], 'toolResult') as Extract<PiMessage, { role: 'toolResult' }>
  assert.equal(toolResult.toolCallId, 'call_1')
  assert.equal(toolResult.toolName, 'shell')
  assert.equal(toolResult.isError, false)
  assert.deepEqual(toolResult.content, [{ type: 'text', text: 'file.txt' }])
})

test('a user turn with text and tool results emits both messages', async () => {
  const messages: HarnessMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'ok' }] },
        { type: 'text', text: 'now summarize' },
      ],
    },
  ]
  const context = await toPiContext(options({ messages }))
  assert.equal(context.messages.length, 3)
  expectRole(context.messages[1], 'user')
  expectRole(context.messages[2], 'toolResult')
  expectRole(context.messages[0], 'assistant')
})

test('an empty user turn still emits an empty-string user message', async () => {
  const context = await toPiContext(options({ messages: [{ role: 'user', content: [] }] }))
  assert.deepEqual(context.messages[0], { role: 'user', content: '', timestamp: 0 })
})

test('assistant history replays text, thinking and tool calls with parsed arguments', async () => {
  const messages: HarnessMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'reasoning', text: 'internal scratch' },
        { type: 'tool-call', id: 't1', name: 'calc', arguments: '{"a":1}' },
      ],
      source: { kind: 'model', provider: 'opencode2dsh', model: 'qwen-free' },
    },
  ]
  const context = await toPiContext(options({ messages }))
  const assistant = expectAssistant(context.messages[0])
  assert.deepEqual(assistant.content, [
    { type: 'text', text: 'thinking out loud' },
    { type: 'thinking', thinking: 'internal scratch' },
    { type: 'toolCall', id: 't1', name: 'calc', arguments: { a: 1 } },
  ])
  assert.equal(assistant.stopReason, 'toolUse')
  assert.equal(assistant.model, 'qwen-free')
})

test('arguments parsing tolerates junk', async () => {
  const context = await toPiContext(
    options({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'a', name: 'x', arguments: '' },
            { type: 'tool-call', id: 'b', name: 'x', arguments: 'not json' },
          ],
        },
      ],
    }),
  )
  const assistant = expectAssistant(context.messages[0])
  assert.deepEqual(assistant.content[0], { type: 'toolCall', id: 'a', name: 'x', arguments: {} })
  assert.deepEqual(assistant.content[1], { type: 'toolCall', id: 'b', name: 'x', arguments: { raw: 'not json' } })
  assert.equal(assistant.stopReason, 'toolUse')
})

test('assistant images are dropped rather than failing the stream', async () => {
  const context = await toPiContext(
    options({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'caption' }, { type: 'image' }] }],
    }),
  )
  const assistant = expectAssistant(context.messages[0])
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'caption' }])
  assert.equal(assistant.stopReason, 'stop')
})

test('user images load from the attachment store as byte-exact image parts', async () => {
  const sha = 'ed20e4a1244ed9a30f2b68b9c670e615c39531d0d84c9b0ed07bd3ac96cae1ed'
  const bytes = Buffer.from('png fixture bytes for conversion')
  await withDshHome(async (home) => {
    await putObject(home, sha, bytes)
    const context = await toPiContext(
      options({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png' } },
            ],
          },
        ],
      }),
    )
    const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
    assert.equal(Array.isArray(user.content), true, 'image content stays a parts array')
    const parts = user.content as Extract<PiMessage, { role: 'user' }>['content']
    assert.ok(Array.isArray(parts))
    assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' })
    assert.deepEqual(parts[1], { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
  })
})

test('a lone image message keeps content as a parts array', async () => {
  const sha = 'a'.repeat(64)
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  await withDshHome(async (home) => {
    await putObject(home, sha, bytes)
    const context = await toPiContext(
      options({
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png' } }] }],
      }),
    )
    const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
    assert.equal(Array.isArray(user.content), true, 'a lone image must never collapse to a string')
    assert.deepEqual(user.content, [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }])
  })
})

test('offloaded image blocks stay out of the request even when the object exists', async () => {
  // The host flagged this occurrence as out-of-budget (offloaded: true);
  // the bytes ARE on disk, but re-reading them would defy the request budget
  // dsh-llm already enforced — the placeholder must win over the store.
  const sha = 'c'.repeat(64)
  const bytes = Buffer.from('bytes that exist but are offloaded')
  await withDshHome(async (home) => {
    await putObject(home, sha, bytes)
    const context = await toPiContext(
      options({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png' },
                offloaded: true,
              },
            ],
          },
        ],
      }),
    )
    const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
    assert.equal(typeof user.content, 'string')
    assert.match(user.content as string, /image omitted: offloaded to fit the request image budget/)
  })
})

test('tool results keep image blocks alongside text', async () => {
  const sha = 'b'.repeat(64)
  const bytes = Buffer.from('tool result image bytes')
  await withDshHome(async (home) => {
    await putObject(home, sha, bytes)
    const messages: HarnessMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            content: [
              { type: 'text', text: 'caption' },
              { type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/webp' } },
            ],
            isError: false,
          },
        ],
      },
    ]
    const context = await toPiContext(options({ messages }))
    const toolResult = expectRole(context.messages[2], 'toolResult') as Extract<PiMessage, { role: 'toolResult' }>
    assert.equal(toolResult.toolName, 'read')
    assert.deepEqual(toolResult.content, [
      { type: 'text', text: 'caption' },
      { type: 'image', data: bytes.toString('base64'), mimeType: 'image/webp' },
    ])
  })
})

test('an empty tool result without images falls back to (no output)', async () => {
  const messages: HarnessMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'shell', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: '' }] }] },
  ]
  const context = await toPiContext(options({ messages }))
  const toolResult = expectRole(context.messages[1], 'toolResult') as Extract<PiMessage, { role: 'toolResult' }>
  assert.deepEqual(toolResult.content, [{ type: 'text', text: '(no output)' }])
})

test('unreadable image references degrade to stable text instead of failing', async () => {
  const context = await toPiContext(
    options({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', attachment: { attachmentId: 'sha256:not-a-real-sha', mediaType: 'image/png' } }],
        },
      ],
    }),
  )
  const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
  assert.equal(typeof user.content, 'string')
  assert.match(user.content as string, /image omitted: unreadable attachment reference/)
})

test('a missing attachment object degrades to a readable placeholder', async () => {
  const sha = 'f'.repeat(64)
  await withDshHome(async () => {
    const context = await toPiContext(
      options({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png' } }],
          },
        ],
      }),
    )
    const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
    assert.equal(typeof user.content, 'string')
    assert.match(user.content as string, /image omitted: failed to read normalized attachment/)
  })
})

test('tools ride the leading system message and empty tool lists are omitted', async () => {
  const shape = await piAiTranscriptShape()
  const tool = { name: 'shell', description: 'run', parameters: { type: 'object' } }
  const withTools = await toPiContext(options({ tools: [tool] }))
  if (shape === 'message') {
    assert.equal('tools' in withTools, false, 'Context.tools is gone in pi-ai 0.87')
    assert.deepEqual(withTools.messages[0], { role: 'system', content: '', toolsAdded: [tool], timestamp: 0 })
  } else {
    assert.deepEqual(withTools.tools, [tool])
  }
  const withoutTools = await toPiContext(options())
  if (shape === 'message') {
    assert.equal(withoutTools.messages.length, 0)
  } else {
    assert.equal('tools' in withoutTools, false, 'empty tool lists are omitted')
  }
})

test("applyPiTranscriptShape 'message' folds prompt and tools into a leading system message", () => {
  const tools = [{ name: 'shell', description: 'run', parameters: { type: 'object' } }]
  const context = applyPiTranscriptShape([{ role: 'user', content: 'hi', timestamp: 0 }], 'sys', tools, 'message')
  assert.equal(context.messages.length, 2)
  assert.deepEqual(context.messages[0], { role: 'system', content: 'sys', toolsAdded: tools, timestamp: 0 })
  assert.equal('systemPrompt' in context, false)
  assert.equal('tools' in context, false)
})

test("applyPiTranscriptShape 'message' omits the leading message when prompt and tools are empty", () => {
  const context = applyPiTranscriptShape([{ role: 'user', content: 'hi', timestamp: 0 }], '', [], 'message')
  assert.deepEqual(context.messages, [{ role: 'user', content: 'hi', timestamp: 0 }])
})

test("applyPiTranscriptShape 'context' uses the 0.82 context fields and never a system message", () => {
  const tools = [{ name: 'shell', description: 'run', parameters: { type: 'object' } }]
  const context = applyPiTranscriptShape([{ role: 'user', content: 'hi', timestamp: 0 }], 'sys', tools, 'context')
  assert.deepEqual(context.messages, [{ role: 'user', content: 'hi', timestamp: 0 }])
  assert.equal(context.systemPrompt, 'sys')
  assert.deepEqual(context.tools, tools)
})

test("applyPiTranscriptShape 'context' omits empty prompt and tool fields", () => {
  const context = applyPiTranscriptShape([], '', [], 'context')
  assert.equal('systemPrompt' in context, false)
  assert.equal('tools' in context, false)
})

test('piAiTranscriptShape picks the shape the installed pi-ai can actually read back', async () => {
  resetPiAiTranscriptShape()
  const shape = await piAiTranscriptShape()
  assert.equal(await piAiTranscriptShape(), shape, 'the probe is cached')

  // Oracle is the library, not the probe's own condition: feed the transcript
  // the probe chose to the reader pi-ai ships and require the prompt to come
  // back. A probe that answered 'message' on a context-only pi-ai, or the
  // reverse, loses the prompt here instead of silently.
  const context = applyPiTranscriptShape([{ role: 'user', content: 'hi', timestamp: 0 }], 'THE_PROMPT', [], shape)
  const piAi = await import('@earendil-works/pi-ai') as unknown as Record<string, unknown>
  const readSystem = systemMessageReader(piAi)
  const [leading] = context.messages as unknown as SystemMessageLike[]
  if (shape === 'message') {
    assert.notEqual(readSystem, undefined, 'a message shape implies the reader is exported')
    assert.equal(leading!.role, 'system', 'the message shape leads with the system message the reader reads')
    assert.equal(readSystem!(leading!), 'THE_PROMPT')
  } else {
    assert.equal(context.systemPrompt, 'THE_PROMPT', 'the context shape carries the prompt where 0.82 reads it')
  }
})

test('piAiTranscriptShape answers the same way through a folded transcript', async () => {
  // The other regime consumes the folded form, so the probe has to agree with
  // what the reader sees after the fold rather than with the input alone.
  resetPiAiTranscriptShape()
  const shape = await piAiTranscriptShape()
  const normalizeContext = await loadNormalizeContext()
  if (shape !== 'message' || normalizeContext === undefined) return
  const readSystem = systemMessageReader(await import('@earendil-works/pi-ai') as unknown as Record<string, unknown>)
  assert.notEqual(readSystem, undefined, 'a message shape implies the reader is exported')
  const folded = normalizeContext(
    applyPiTranscriptShape([{ role: 'user', content: 'hi', timestamp: 0 }], 'THE_PROMPT', [], shape),
  )
  assert.equal(folded.messages.filter((m) => m.role === 'system').length, 1, 'the fold must not duplicate the prompt')
  assert.equal(readSystem!(folded.messages[0]!), 'THE_PROMPT')
})

test('ensureFreeLaneShape injects gate tools into toolless chat bodies', () => {
  const payload = { model: 'm', stream: true, messages: [{ role: 'user', content: 'ping' }] }
  const next = ensureFreeLaneShape(payload) as Record<string, unknown>
  assert.notEqual(next, undefined)
  assert.deepEqual(next.messages, payload.messages, 'messages untouched')
  const tools = next.tools as Array<{ type: string; function: { name: string } }>
  assert.deepEqual(tools.map((t) => t.function.name).sort(), ['bash', 'read'])
  assert.equal(next.tool_choice, 'none', 'injected-only stubs are call-disabled')
})

test('ensureFreeLaneShape appends only missing gate tools and keeps tool_choice', () => {
  const payload = {
    model: 'm',
    messages: [{ role: 'user', content: 'ping' }],
    tools: [{ type: 'function', function: { name: 'webfetch', description: 'x', parameters: {} } }],
    tool_choice: 'auto',
  }
  const next = ensureFreeLaneShape(payload) as Record<string, unknown>
  const tools = next.tools as Array<{ type: string; function: { name: string } }>
  assert.equal(tools.length, 3, 'existing tool kept, both gate tools appended')
  assert.deepEqual(tools.map((t) => t.function.name).sort(), ['bash', 'read', 'webfetch'])
  assert.equal(next.tool_choice, 'auto', 'client choice preserved')
})

test('ensureFreeLaneShape leaves satisfying and non-chat payloads untouched', () => {
  const both = {
    model: 'm',
    messages: [],
    tools: [
      { type: 'function', function: { name: 'bash', description: 'x', parameters: {} } },
      { type: 'function', function: { name: 'read', description: 'x', parameters: {} } },
    ],
  }
  assert.equal(ensureFreeLaneShape(both), undefined)
  assert.equal(ensureFreeLaneShape({ tools: [] }), undefined, 'no messages = not a chat body')
  assert.equal(ensureFreeLaneShape(null), undefined)
  assert.equal(ensureFreeLaneShape('text'), undefined)
})
test('assistant history preserves the Responses API for muse-spark models', async () => {
  const context = await toPiContext(
    options({
      model: 'muse-spark-1.2-contributor-free',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous response' }],
          source: { kind: 'model', provider: 'opencode2dsh', model: 'muse-spark-1.2-contributor-free' },
        },
      ],
    }),
  )
  const assistant = expectAssistant(context.messages[0])
  assert.equal(assistant.api, 'openai-responses')
})


test('Responses free-lane bodies carry flat gate tools and supported tool choice', () => {
  const body = { input: [{ role: 'user', content: 'ping' }], tools: [{ type: 'function', name: 'bash', parameters: {} }], tool_choice: 'none' }
  const rewritten = ensureResponsesFreeLaneShape(body) as typeof body
  assert.equal(rewritten.input, body.input)
  assert.deepEqual(rewritten.tools.map((tool) => tool.name), ['bash', 'read'])
  assert.equal(rewritten.tool_choice, 'auto')
  assert.equal(ensureResponsesFreeLaneShape(rewritten), undefined)
  assert.equal(ensureResponsesFreeLaneShape({ messages: [] }), undefined)
})
