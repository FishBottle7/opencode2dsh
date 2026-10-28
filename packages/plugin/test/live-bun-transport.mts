// Manual only: excluded from *.test.ts and never invoked by offline CI.
import assert from 'node:assert/strict'
import { ZenAdapter, type CatalogLike } from '../src/adapter/zen-adapter.ts'
import type { HarnessBlock, HarnessGenerateOptions, HarnessMessage } from '../src/adapter/messages.ts'

const flag = process.argv.indexOf('--bun')
if (!process.argv.includes('--live') || flag < 0 || !process.argv[flag + 1]) {
  throw new Error('Opt in explicitly: node test/live-bun-transport.mts --live --bun /absolute/path/to/bun')
}
const bunPath = process.argv[flag + 1]!
const catalog: CatalogLike = {
  list: () => ['glm-5.3-flash-free', 'mimo-v2.6-flash-free'],
  decision: () => ({ allowed: true, source: 'manual-diagnostic', known: true }),
  reasoningCapability: () => ({ reasoning: true, effortValues: ['low', 'high', 'max'] }),
  limits: () => ({ contextWindow: 200_000, maxOutput: 8192 }),
}
const adapter = new ZenAdapter(catalog, { bunTransport: { enabled: true, bunPath } })
async function run(model: string, messages: HarnessGenerateOptions['messages'], tools: HarnessGenerateOptions['tools'] = []) {
  let text = '', finish: unknown
  const blocks: HarnessBlock[] = []
  for await (const chunk of adapter.stream({ provider: 'opencode2dsh', model, system: 'You are DSH. Use only tools supplied by the host.', messages, tools, maxTokens: 1024, signal: AbortSignal.timeout(60_000) })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end' && chunk.block) blocks.push(chunk.block as unknown as HarnessBlock)
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, finish, blocks }
}
try {
  for (const model of catalog.list()) {
    const result = await run(model, [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly OK. Do not use tools.' }] }])
    assert.deepEqual(result.finish, { kind: 'stop' }); assert.equal(result.text.trim(), 'OK')
    console.log(JSON.stringify({ test: 'chat', model, text: result.text, finish: result.finish }))
  }
  const model = 'glm-5.3-flash-free'
  const tools = [{ name: 'diagnostic_echo', description: 'Return a diagnostic value; no filesystem or shell access.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }]
  const messages: HarnessMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Call diagnostic_echo once with value PONG. After receiving its result, reply with only that value.' }] }]
  const first = await run(model, messages, tools)
  const call = first.blocks.find(block => block.type === 'tool-call' && block.name === 'diagnostic_echo')
  assert.ok(call); assert.deepEqual(first.finish, { kind: 'tool-calls' })
  const next = await run(model, [...messages, { role: 'assistant', content: first.blocks }, { role: 'tool', toolCallId: String(call.id), content: [{ type: 'text', text: 'PONG' }] }], tools)
  assert.deepEqual(next.finish, { kind: 'stop' }); assert.equal(next.text.trim(), 'PONG')
  console.log(JSON.stringify({ test: 'tool-call-and-continuation', model, text: next.text, finish: next.finish }))
} finally { adapter.dispose() }
