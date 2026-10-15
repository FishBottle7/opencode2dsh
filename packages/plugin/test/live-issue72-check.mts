/** Manual live probe; never run by the offline test suite. Uses no user key/history. */
import assert from 'node:assert/strict'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { ZEN_BASE_URL } from '../src/adapter/catalog.ts'

if (!process.argv.includes('--live')) {
  console.error('Explicit opt-in required: node test/live-issue72-check.mts --live [--nemotron]')
  process.exit(1)
}

const model = process.argv.includes('--nemotron') ? 'nemotron-3.5-lightning-free' : 'mimo-v2.6-flash-free'
const adapter = new ZenAdapter({
  list: () => [model],
  decision: () => ({ allowed: true, known: true, source: 'diagnostic' }),
  reasoningCapability: () => ({ reasoning: true, effortValues: ['off', 'low', 'medium', 'high'] }),
  limits: () => ({ contextWindow: 1048576, maxOutput: 32768 }),
  modalities: () => ['text'],
}, { firstEventMs: 35000, bodyIdleMs: 35000 })

let text = ''
let finish: unknown
for await (const chunk of adapter.stream({
  provider: 'opencode2dsh', model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly OK. Do not call any tools.' }] }],
  tools: [], reasoningEffort: 'off', maxTokens: 128, signal: AbortSignal.timeout(45000),
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') finish = chunk.reason
}
console.log(JSON.stringify({ base: ZEN_BASE_URL, model, text, finish }, null, 2))
assert.equal((finish as { kind?: string } | undefined)?.kind, 'stop')
assert.ok(text.trim(), 'expected a non-empty answer')
