import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BunTransport, environmentPayload, inferenceURL } from '../src/adapter/bun-transport.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { Config, resolveConfig } from '../src/config.ts'
import type { HarnessBlock, HarnessMessage } from '../src/adapter/messages.ts'

const workerPath = fileURLToPath(new URL('./fixtures/bun-transport-worker.mjs', import.meta.url))
const url = 'https://opencode.ai/inference/v1/chat/completions'
const options = { bunPath: process.execPath, workerPath, headerTimeoutMs: 2000, bodyIdleMs: 2000 }
const request = (testMode = 'plain', model = 'test') => ({
  method: 'POST', headers: { authorization: 'Bearer public', 'content-type': 'application/json', cookie: 'do-not-forward', 'x-stainless-runtime': 'node' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'test' }], testMode }),
})

test('compatibility is opt-in and leaves ordinary configuration defaults unchanged', () => {
  assert.equal(Config({}).bunTransport.enabled, false)
  assert.equal(resolveConfig().bunTransport, undefined)
  assert.equal(Config({ bunTransport: { enabled: true, bunPath: '/path with spaces/bun', clientVersion: '2.2.0' } }).bunTransport.bunPath, '/path with spaces/bun')
  assert.throws(() => new BunTransport({ clientVersion: '2.2.0\ninvalid' }), /clientVersion/)
  const before = globalThis.fetch
  const adapter = new ZenAdapter({ list: () => [], decision: () => ({ allowed: false, source: 'test', known: false }), reasoningCapability: () => undefined })
  adapter.dispose()
  assert.equal(globalThis.fetch, before)
})

test('only the exact anonymous inference origin and paths are eligible', () => {
  assert.equal(inferenceURL(url)?.href, 'https://opencode.ai/inference/openai/v1/chat/completions')
  assert.equal(inferenceURL('https://opencode.ai/zen/v1/chat/completions')?.pathname, '/inference/openai/v1/chat/completions')
  for (const value of ['http://opencode.ai/inference/v1/chat/completions', 'https://opencode.ai.evil.test/inference/v1/chat/completions', 'https://opencode.ai/inference/v1/models', url + '?key=anything', 'https://user@opencode.ai/inference/v1/chat/completions', url + '#fragment']) assert.equal(inferenceURL(value), undefined)
})

test('environment metadata preserves host instructions, multimodal history, tools and choices', () => {
  const body = { messages: [{ role: 'system', content: 'You are DSH. Host policy wins.' }, { role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } }] }], tools: [{ type: 'function', function: { name: 'host_tool', parameters: { type: 'object' } } }], tool_choice: 'none', max_completion_tokens: 123 }
  const original = JSON.stringify(body)
  const prepared = environmentPayload(original, 'win32')
  const decoded = JSON.parse(prepared)
  assert.equal(JSON.stringify(body), original)
  assert.ok(decoded.messages[0].content.startsWith(body.messages[0]!.content))
  assert.deepEqual(decoded.messages.slice(1), body.messages.slice(1))
  assert.deepEqual(decoded.tools, body.tools)
  assert.equal(decoded.tool_choice, 'none')
  assert.equal(decoded.max_completion_tokens, 123)
  assert.equal(environmentPayload(prepared, 'win32'), prepared)
  const existing = JSON.stringify({ messages: [{ role: 'developer', content: [{ type: 'text', text: '<env>existing host environment</env>' }] }] })
  assert.equal(environmentPayload(existing), existing)
  const responses = JSON.parse(environmentPayload(JSON.stringify({ instructions: 'Host instructions', input: [{ role: 'user', content: 'test' }] })))
  assert.ok(responses.instructions.startsWith('Host instructions'))
  assert.deepEqual(responses.input, [{ role: 'user', content: 'test' }])
})

test('streaming response framing and rate-limit metadata survive the subprocess boundary', async t => {
  const transport = new BunTransport(options); t.after(() => transport.dispose())
  const response = await transport.fetch(url, request())
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'one-two')
  const limited = await transport.fetch(url, request('rate-limit'))
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '15')
  assert.match(await limited.text(), /FreeUsageLimitError/)
  assert.equal(transport.activeRequests, 0)
})

test('private credentials, unrelated destinations and a live proxy pool fail before spawning', async t => {
  const transport = new BunTransport(options); t.after(() => transport.dispose())
  await assert.rejects(transport.fetch(url, { ...request(), headers: { authorization: 'Bearer not-a-real-key' } }), /anonymous/)
  await assert.rejects(transport.fetch('https://example.test/', request()), /anonymous/)
  let pool = false
  const guarded = new BunTransport({ ...options, isPoolEnabled: () => pool }); t.after(() => guarded.dispose())
  assert.equal(await (await guarded.fetch(url, request())).text(), 'one-two')
  pool = true
  await assert.rejects(guarded.fetch(url, request()), /ipPool.enabled=false/)
  assert.equal(guarded.activeRequests, 0)
})

test('async fetch scoping isolates concurrent providers and restores the previous fetch on final disposal', async t => {
  const previous = globalThis.fetch
  let fallback = 0
  const stub: typeof fetch = async () => { fallback++; return new Response('unrelated-provider') }
  globalThis.fetch = stub
  const first = new BunTransport(options), second = new BunTransport(options)
  t.after(() => { first.dispose(); second.dispose(); globalThis.fetch = previous })
  const api = first.wrapApi({ streamSimple: async () => { await delay(5); return globalThis.fetch(url, request('plain', 'first')) } })
  const api2 = second.wrapApi({ streamSimple: async () => globalThis.fetch(url, request('plain', 'second')) })
  const [a, b, ordinary] = await Promise.all([api.streamSimple(), api2.streamSimple(), globalThis.fetch(url, request())])
  assert.equal(a.headers.get('x-fixture-model'), 'first')
  assert.equal(b.headers.get('x-fixture-model'), 'second')
  assert.equal(await ordinary.text(), 'unrelated-provider')
  await Promise.all([a.text(), b.text()])
  assert.equal(fallback, 1)
  first.dispose(); assert.notEqual(globalThis.fetch, stub)
  second.dispose(); assert.equal(globalThis.fetch, stub)
})

test('abort before headers, body cancellation and plugin disposal release subprocesses', async t => {
  const transport = new BunTransport(options); t.after(() => transport.dispose())
  const controller = new AbortController()
  const pending = transport.fetch(url, { ...request('hang-headers'), signal: controller.signal })
  await delay(30); controller.abort(new Error('diagnostic cancellation'))
  await assert.rejects(pending, /diagnostic cancellation/)
  assert.equal(transport.activeRequests, 0)
  const response = await transport.fetch(url, request('hang-body'))
  await response.body!.cancel()
  assert.equal(transport.activeRequests, 0)
  const active = await transport.fetch(url, request('hang-body'))
  const text = active.text()
  transport.dispose()
  await assert.rejects(text, /disposed/)
  assert.equal(transport.activeRequests, 0)
})

test('header and body-idle deadlines and early worker failures cannot leave orphan requests', async t => {
  const transport = new BunTransport({ ...options, headerTimeoutMs: 250, bodyIdleMs: 80 }); t.after(() => transport.dispose())
  await assert.rejects(transport.fetch(url, request('hang-headers')), /response-header timeout/)
  const idle = await transport.fetch(url, request('hang-body'))
  await assert.rejects(idle.text(), /body-idle timeout/)
  await assert.rejects(transport.fetch(url, request('empty')), /before response headers/)
  await assert.rejects(transport.fetch(url, request('large-header')), /headers/)
  const truncated = await transport.fetch(url, request('midstream-error'))
  await assert.rejects(truncated.text(), /unexpectedly.*2/)
  assert.equal(transport.activeRequests, 0)
})

test('actual pi-ai SDK preserves DSH host tools and consumes their results through the opt-in bridge', async t => {
  const model = 'glm-5.3-flash-free'
  const adapter = new ZenAdapter({ list: () => [model], decision: () => ({ allowed: true, source: 'test', known: true }), reasoningCapability: () => undefined }, { bunTransport: { ...options, enabled: true } })
  t.after(() => adapter.dispose())
  const tools = [{ name: 'diagnostic_echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }]
  const messages: HarnessMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Call diagnostic_echo.' }] }]
  let call: Extract<HarnessBlock, { type: 'tool-call' }> | undefined
  let finish: unknown
  for await (const chunk of adapter.stream({ provider: 'opencode2dsh', model, system: 'You are DSH.', messages, tools, maxTokens: 128 })) {
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') call = chunk.block as typeof call
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.equal(call?.name, 'diagnostic_echo'); assert.deepEqual(finish, { kind: 'tool-calls' })
  let text = ''
  for await (const chunk of adapter.stream({ provider: 'opencode2dsh', model, system: 'You are DSH.', messages: [...messages, { role: 'assistant', content: [call!] }, { role: 'tool', toolCallId: call!.id, content: [{ type: 'text', text: 'PONG' }] }], tools, maxTokens: 128 })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.equal(text, 'PONG'); assert.deepEqual(finish, { kind: 'stop' })
})
