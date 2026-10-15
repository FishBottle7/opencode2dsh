import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { Context, Model } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import { ZEN_BASE_URL, fetchZenModels } from '../src/adapter/catalog.ts'
import { deriveRequestIDs, disguiseHeaders } from '../src/adapter/ids.ts'
import { ensureFreeLaneShape, ensureResponsesFreeLaneShape } from '../src/adapter/messages.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'

type Tool = { type: string; function: { name: string; description?: string; parameters: Record<string, unknown> } }
type Chat = { messages: unknown[]; tools: Tool[]; tool_choice?: unknown }
type Flat = { input: unknown[]; tools: Array<{ type: string; name: string; parameters: Record<string, unknown> }>; tool_choice?: unknown }

test('default model listing uses the inference base and retains custom-base support (#72)', async () => {
  assert.equal(ZEN_BASE_URL, 'https://opencode.ai/inference')
  const seen: string[] = []
  const fetcher = (async (url: string | URL | Request) => {
    seen.push(String(url))
    return new Response(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }] }))
  }) as typeof fetch
  await fetchZenModels(ZEN_BASE_URL, fetcher, 'test-agent')
  await fetchZenModels('http://example.test/custom/', fetcher, 'test-agent')
  assert.deepEqual(seen, ['https://opencode.ai/inference/v1/models', 'http://example.test/custom/v1/models'])
})

test('wire headers keep session affinity without legacy synthetic request/project headers', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'wire-regression' }])
  const headers = disguiseHeaders(ids)
  assert.equal(headers['x-opencode-session-id'], ids.session)
  assert.equal(headers['x-opencode-session'], ids.session)
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['X-Session-Id'], ids.session)
  assert.equal('x-opencode-request' in headers, false)
  assert.equal('x-opencode-project' in headers, false)
})

test('chat fills empty gate schemas without duplicating tools or mutating caller data', () => {
  const bash: Tool = { type: 'function', function: { name: 'bash', description: 'host command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } } }
  const read: Tool = { type: 'function', function: { name: 'read', description: 'host read', parameters: { type: 'object', properties: {}, additionalProperties: false } } }
  const choice = { type: 'function', function: { name: 'bash' } }
  const payload = { messages: [], tools: [bash, read], tool_choice: choice }
  const before = JSON.stringify(payload)
  const shaped = ensureFreeLaneShape(payload) as Chat
  assert.equal(JSON.stringify(payload), before)
  assert.equal(shaped.tools.length, 2)
  assert.equal(shaped.tools[0], bash, 'real host schema is unchanged')
  assert.equal(shaped.tools[1]!.function.description, 'host read')
  assert.equal(shaped.tools[1]!.function.parameters.additionalProperties, false)
  assert.ok(Object.keys(shaped.tools[1]!.function.parameters.properties as object).length > 0)
  assert.equal(shaped.tool_choice, choice)
  assert.equal(ensureFreeLaneShape(shaped), undefined, 'rewriting is idempotent')
})

test('injected chat stubs have a property and remain call-disabled', () => {
  const payload = { messages: [] }
  const shaped = ensureFreeLaneShape(payload) as Chat
  assert.deepEqual(shaped.tools.map((tool) => tool.function.name), ['bash', 'read'])
  assert.ok(shaped.tools.every((tool) => Object.keys(tool.function.parameters.properties as object).length > 0))
  assert.equal(shaped.tool_choice, 'none')
  assert.deepEqual(payload, { messages: [] })
})

test('Responses fills flat empty gate schemas and preserves real ones', () => {
  const bash = { type: 'function', name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
  const payload = { input: [], tools: [bash, { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }], tool_choice: 'none' }
  const before = JSON.stringify(payload)
  const shaped = ensureResponsesFreeLaneShape(payload) as Flat
  assert.equal(JSON.stringify(payload), before)
  assert.equal(shaped.tools[0], bash)
  assert.equal(shaped.tools.length, 2)
  assert.ok(shaped.tools.every((tool) => Object.keys(tool.parameters.properties as object).length > 0))
  assert.equal(shaped.tool_choice, 'auto')
  assert.equal(ensureResponsesFreeLaneShape(shaped), undefined)
})

test('real adapter emits the corrected wire request through pi-ai', async (t) => {
  let seen: { url?: string; headers: http.IncomingHttpHeaders; body: Chat & { stream: boolean } } | undefined
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    seen = { url: req.url, headers: req.headers, body: JSON.parse(raw) }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const port = (server.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}/v1`
  const adapter = new ZenAdapter({
    list: () => ['mimo-v2.6-flash-free'], decision: () => ({ allowed: true, source: 'test', known: true }), reasoningCapability: () => undefined,
  }, { providerOverride: {
    streamSimple(model: Model<'openai-completions'>, context: Context, options: never) {
      assert.equal(model.baseUrl, `${ZEN_BASE_URL}/v1`, 'default model URL uses the inference lane')
      // Match the existing real-HTTP recovery test: redirect only the model
      // URL, keeping the actual pi-ai serializer, headers and stream parser.
      return openaiCompletions.streamSimple({ ...model, baseUrl }, context, options)
    },
  } })
  let text = ''
  let finish = ''
  for await (const chunk of adapter.stream({ provider: 'opencode2dsh', model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }], tools: [], maxTokens: 16, signal: AbortSignal.timeout(5000) })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason.kind
  }
  assert.equal(text, 'OK')
  assert.equal(finish, 'stop')
  assert.equal(seen?.url, '/v1/chat/completions')
  assert.equal(seen?.headers.authorization, 'Bearer public')
  assert.match(String(seen?.headers['x-opencode-session-id']), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(seen?.headers['x-opencode-session-id'], seen?.headers['x-opencode-session'])
  assert.equal(seen?.headers['x-opencode-request'], undefined)
  assert.equal(seen?.headers['x-opencode-project'], undefined)
  assert.equal(seen?.body.stream, true)
  assert.equal(seen?.body.tool_choice, 'none')
  assert.ok(seen?.body.tools.every((tool) => Object.keys(tool.function.parameters.properties as object).length > 0))
})
