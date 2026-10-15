import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createModels, createProvider } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'

import { ZenAdapter } from '../src/adapter/zen-adapter.ts'

/**
 * Regression: the adapter must send the caller's tools.
 *
 * pi-ai reads a request's tools from the leading system message's `toolsAdded`
 * field, not from `context.tools` (dist/utils/transcript.js:6-27,195-203;
 * dist/api/openai-completions.js:598-599). Only the `Models` entry points fold
 * `context.tools` into that message (dist/models.js:382,393), so calling a raw
 * provider drops every caller tool: the model is left holding only the injected
 * gate stubs and reports that the host's tools do not exist.
 *
 * The failure is version-dependent. On the range this package declares
 * (`^0.82.1`) a raw provider still read `context.tools` directly, so a
 * standalone install works and these assertions pass either way. A DSH profile
 * hoists ONE pi-ai for every plugin in the profile, so it can resolve
 * >= 0.86.0, where the raw path drops tools. The tests below therefore drive the
 * adapter's real construction path (no `providerOverride`) and assert on the
 * bytes that actually leave, so they fail on >= 0.86.0 if the adapter ever calls
 * a raw provider again, and pass on every version when it uses `Models`.
 *
 * The adapter builds its own model record with `ZEN_BASE_URL`, so the local
 * server is reached by redirecting that origin at the fetch layer rather than
 * through the constructor's `zenBaseUrl` (which today only feeds the catalog
 * fetch, not the chat wire).
 */

/** Tools the harness hands an adapter: flat { name, description, parameters }. */
const HOST_TOOLS = [
  {
    name: 'pwsh',
    description: 'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'], additionalProperties: false },
  },
  {
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
  },
  {
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
  },
]

const SSE = 'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n'
  + 'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
  + 'data: [DONE]\n\n'

/**
 * Serve a local stand-in for the lane and redirect the adapter's requests to it.
 *
 * Redirecting at `fetch` keeps the adapter on its real construction path, so the
 * `Models` wrapper under test is the one the adapter itself builds.
 */
async function withLane<T>(run: (requests: Array<{ url: string; body: Record<string, unknown> }>) => Promise<T>): Promise<T> {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* keep {} */ }
    requests.push({ url: req.url ?? '', body })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(SSE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return realFetch(url.replace(/^https:\/\/opencode\.ai/, origin), init)
  }) as typeof fetch
  try {
    return await run(requests)
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function adapterFor(): ZenAdapter {
  return new ZenAdapter({
    list: () => ['mimo-v2.6-flash-free', 'muse-spark-1.2-contributor-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
  }, { firstEventMs: 5000, bodyIdleMs: 5000 })
}

async function streamOnce(adapter: ZenAdapter, options: Record<string, unknown>): Promise<void> {
  for await (const chunk of adapter.stream(options as never)) void chunk
}

const namesOf = (body: Record<string, unknown> | undefined): string[] =>
  ((body?.tools ?? []) as Array<{ function?: { name?: string }; name?: string }>)
    .map((tool) => tool.function?.name ?? tool.name)
    .filter((name): name is string => typeof name === 'string')

test('the adapter sends the caller\'s tools, not just the gate stub', { timeout: 15000 }, async () => {
  const sent = await withLane(async (requests) => {
    await streamOnce(adapterFor(), {
      provider: 'opencode2dsh',
      model: 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'List the files here.' }] }],
      tools: HOST_TOOLS,
      maxTokens: 32,
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(requests.length, 1, 'exactly one upstream request')
    return requests[0]!
  })

  const names = namesOf(sent.body)
  // The decisive assertion: every tool the host offered reached the wire. A raw
  // provider call on pi-ai >= 0.86.0 leaves only the injected gate tool here.
  for (const tool of HOST_TOOLS) {
    assert.ok(names.includes(tool.name), `host tool "${tool.name}" must reach the wire (got ${JSON.stringify(names)})`)
  }
  // Schemas travel intact, so the model can actually fill them.
  const readTool = (sent.body.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>)
    .find((tool) => tool.function.name === 'read')
  assert.ok(readTool, 'read is present')
  assert.deepEqual(Object.keys(readTool!.function.parameters.properties), ['file_path'])
})

test('a host toolset with no gate-named tool still gets its own tools through', { timeout: 15000 }, async () => {
  // A shell-only toolset: the shaper injects a gate stub, but the caller's real
  // tools must survive alongside it. On a raw-provider path they are dropped and
  // only the stub remains.
  const shellOnly = [HOST_TOOLS[0]!, HOST_TOOLS[2]!]
  const names = await withLane(async (requests) => {
    await streamOnce(adapterFor(), {
      provider: 'opencode2dsh',
      model: 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Run a command.' }] }],
      tools: shellOnly,
      maxTokens: 32,
      signal: AbortSignal.timeout(10_000),
    })
    return namesOf(requests[0]?.body)
  })

  assert.ok(names.includes('pwsh'), `pwsh must reach the wire (got ${JSON.stringify(names)})`)
  assert.ok(names.includes('grep'), `grep must reach the wire (got ${JSON.stringify(names)})`)
  // The gate is still satisfied, additively, by the injected tool.
  assert.ok(names.includes('read'), 'the gate tool is injected when the caller lacks one')
})

test('the Responses path also forwards the caller\'s tools', { timeout: 15000 }, async () => {
  // muse-spark-* route through the responses provider; it needs the same fold.
  const names = await withLane(async (requests) => {
    await streamOnce(adapterFor(), {
      provider: 'opencode2dsh',
      model: 'muse-spark-1.2-contributor-free',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'List the files here.' }] }],
      tools: HOST_TOOLS,
      maxTokens: 32,
      signal: AbortSignal.timeout(10_000),
    })
    return namesOf(requests[0]?.body)
  })

  for (const tool of HOST_TOOLS) {
    assert.ok(names.includes(tool.name), `host tool "${tool.name}" must reach the responses wire (got ${JSON.stringify(names)})`)
  }
})

test('pi-ai folds context.tools through Models, which is why the adapter must use it', async () => {
  // Documents the trap itself, so the reason for the fix is executable: the
  // `Models` entry point folds `context.tools` into the transcript, and that is
  // the only path pi-ai >= 0.86.0 reads tools from.
  const captured: Array<Record<string, unknown>> = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try { captured.push(JSON.parse(raw) as Record<string, unknown>) } catch { captured.push({}) }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(SSE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  try {
    const provider = createProvider({
      id: 'probe',
      name: 'probe',
      baseUrl,
      auth: { apiKey: { name: 't', resolve: async () => ({ auth: { apiKey: 'public' } }) } },
      models: [],
      api: openaiCompletions,
    } as never)
    const model = {
      id: 'm', name: 'm', api: 'openai-completions', provider: 'probe', baseUrl,
      reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072, maxTokens: 4096,
    }
    const models = createModels()
    models.setProvider(provider as never)
    for await (const _ of models.streamSimple(
      model as never,
      { messages: [{ role: 'user', content: 'hi' }], tools: HOST_TOOLS } as never,
      { apiKey: 'public', maxTokens: 8 } as never,
    )) void _

    assert.equal(captured.length, 1)
    assert.deepEqual(namesOf(captured[0]), HOST_TOOLS.map((tool) => tool.name),
      'the Models wrapper folds context.tools into the transcript')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
