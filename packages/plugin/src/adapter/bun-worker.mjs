// This worker has no tool executor or local server. Stdin is one in-memory
// anonymous request; stdout is one JSON metadata line followed by response bytes.
const paths = new Set([
  '/inference/openai/v1/chat/completions', '/inference/v1/chat/completions',
  '/zen/v1/chat/completions', '/inference/v1/responses',
  '/inference/openai/v1/responses', '/zen/v1/responses',
])
let started = false
try {
  const input = JSON.parse(await Bun.stdin.text())
  const url = new URL(input.url)
  if (url.origin !== 'https://opencode.ai' || url.username || url.password || url.search || url.hash || !paths.has(url.pathname)) throw new Error('Unsupported Bun transport destination')
  const headers = new Headers(input.headers)
  if (headers.get('authorization') !== 'Bearer public') throw new Error('Bun transport requires the anonymous public credential')
  for (const name of ['cookie', 'host', 'content-length', 'connection']) headers.delete(name)
  const response = await fetch(url, { method: 'POST', headers, body: input.body, redirect: 'error' })
  const outputHeaders = [...response.headers].filter(([name]) => !['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name))
  process.stdout.write(JSON.stringify({ status: response.status, statusText: response.statusText, headers: outputHeaders }) + '\n')
  started = true
  if (response.body) for await (const chunk of response.body) {
    if (!process.stdout.write(chunk)) await new Promise(resolve => process.stdout.once('drain', resolve))
  }
} catch (error) {
  if (!started) process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }) + '\n')
  process.exitCode = 1
}
