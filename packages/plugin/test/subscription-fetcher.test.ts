import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { SubscriptionFetcher } from '../src/pool/subscription-fetcher.ts'

/** A fake undici seam: every admission request answers 200 (smoke passes). */
function seam() {
  return {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      const address = init.dispatcher.uri.replace(/^https?:\/\//, '')
      if (url.includes('ip-api')) {
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: `8.8.${address.length}.1`, countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
}

/** A subscription body fixture: mixed airport content (anytls + plaintext). */
const SUB_BODY = [
  'proxies:',
  '  - name: "机场US"',
  '    type: anytls',
  '    server: us01.example.com',
  '    port: 18888',
  '    password: secret-pw',
  '  - name: "明文HTTP"',
  '    type: http',
  '    server: 1.2.3.4',
  '    port: 8080',
  '  - name: "明文SOCKS"',
  '    type: socks5',
  '    server: 5.6.7.8',
  '    port: 1080',
].join('\n')

function makeFetcher(fetchImpl: typeof fetch, logger?: { info(message: string): void; warn(message: string): void }) {
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam() as never, fetchImpl },
    { logger: logger ?? { info: () => {}, warn: () => {} } },
  )
  return { pool, fetcher }
}

test('subscription refresh: plaintext nodes smoke into the pool, encrypted park as pending', async () => {
  const { pool, fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  const state = await fetcher.refresh()
  // plaintext nodes admitted through the trusted smoke
  assert.equal(state.plaintextAdmitted, 2)
  assert.ok(pool.has('1.2.3.4:8080'))
  assert.ok(pool.has('5.6.7.8:1080'))
  assert.ok(pool.list().every((n) => n.source === 'subscription'))
  // the anytls node parked for IP-4 conversion, not in the pool
  assert.equal(state.pendingConversion.length, 1)
  assert.equal(state.pendingConversion[0]?.type, 'anytls')
  assert.ok(!pool.has('us01.example.com:18888'))
  assert.equal(state.lastError, '')
})

test('subscription fetch failures are reported, never thrown', async () => {
  const { fetcher } = makeFetcher((async () => { throw new Error('ETIMEDOUT') }) as unknown as typeof fetch)
  fetcher.setUrls(['https://dead.example.com/sub'])
  const state = await fetcher.refresh()
  assert.match(state.lastError, /ETIMEDOUT/)
  assert.equal(state.pendingConversion.length, 0)
})

test('subscription URLs are redacted in logs', async () => {
  const logs: string[] = []
  const { fetcher } = makeFetcher(
    (async () => new Response('')) as unknown as typeof fetch,
    { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  )
  fetcher.setUrls(['https://sub.example.com/VerySecretToken1234567890abcdef'])
  await fetcher.refresh()
  // nothing in the log carries the full credential
  assert.ok(logs.every((line) => !line.includes('VerySecretToken1234567890abcdef')))
  assert.ok(logs.some((line) => line.includes('…')))
})

test('subscription nodes never enter the pool twice (idempotent refresh)', async () => {
  const { pool, fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  await fetcher.refresh()
  const rows = pool.list().filter((n) => n.source === 'subscription')
  assert.equal(rows.length, 2) // still the same two plaintext nodes
})
