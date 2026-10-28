import assert from 'node:assert/strict'
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const body = JSON.parse(input.body)
const headers = new Headers(input.headers)
assert.equal(headers.get('authorization'), 'Bearer public')
assert.match(headers.get('user-agent'), /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/)
assert.equal(headers.get('cookie'), null)
assert.equal(headers.get('x-stainless-runtime'), null)
assert.equal(input.url, 'https://opencode.ai/inference/openai/v1/chat/completions')
assert.ok(body.messages.some(message => message.role === 'system' && String(message.content).includes('<env>')))
const mode = body.testMode
if (mode === 'empty') process.exit(0)
if (mode === 'hang-headers') await new Promise(() => setInterval(() => {}, 1000))
if (mode === 'large-header') { process.stdout.write('x'.repeat(70_000) + '\n'); await new Promise(() => setInterval(() => {}, 1000)) }
const metadata = { status: mode === 'rate-limit' ? 429 : 200, headers: [['content-type', mode === 'sse' || mode === 'tool' ? 'text/event-stream' : 'text/plain'], ['x-fixture-model', body.model ?? 'test'], ['retry-after', '15']] }
const line = JSON.stringify(metadata)
process.stdout.write(line.slice(0, 8))
await new Promise(resolve => setTimeout(resolve, 5))
process.stdout.write(line.slice(8) + '\n')
if (mode === 'hang-body') await new Promise(() => setInterval(() => {}, 1000))
if (mode === 'midstream-error') { process.stdout.write('partial'); process.exit(2) }
if (mode === 'rate-limit') process.stdout.write('{"error":{"type":"FreeUsageLimitError"}}')
else if (mode === 'sse' || mode === 'tool' || body.tools) {
  const send = chunk => process.stdout.write(`data: ${JSON.stringify(chunk)}\n\n`)
  const needsTool = body.tools?.some(tool => tool.function?.name === 'diagnostic_echo') && !body.messages.some(message => message.role === 'tool')
  send({ id: 'test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: needsTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'diagnostic_echo', arguments: '{"value":"PONG"}' } }] } : { role: 'assistant', content: body.messages.some(message => message.role === 'tool') ? 'PONG' : 'OK' }, finish_reason: null }] })
  send({ id: 'test', choices: [{ index: 0, delta: {}, finish_reason: needsTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
  process.stdout.write('data: [DONE]\n\n')
} else {
  process.stdout.write('one-')
  await new Promise(resolve => setTimeout(resolve, 5))
  process.stdout.write('two')
}
