import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dedupeAddresses,
  fetchSource,
  freeSources,
  parseFreeListLine,
  selectSources,
  SourceBreaker,
} from '../src/pool/sources.ts'

test('free-source list matches the GoProxy inventory (both tiers present)', () => {
  assert.ok(freeSources.length >= 26)
  assert.ok(freeSources.some((s) => s.tier === 'fast'))
  assert.ok(freeSources.some((s) => s.tier === 'slow'))
  // every URL is unique
  assert.equal(new Set(freeSources.map((s) => s.url)).size, freeSources.length)
})

test('parseFreeListLine accepts host:port / IPv6 / scheme prefixes, rejects junk', () => {
  assert.deepEqual(parseFreeListLine('1.2.3.4:8080'), { address: '1.2.3.4:8080', host: '1.2.3.4', port: 8080 })
  assert.deepEqual(parseFreeListLine('  socks5://5.6.7.8:1080 '), { address: '5.6.7.8:1080', host: '5.6.7.8', port: 1080 })
  assert.deepEqual(parseFreeListLine('http://9.9.9.9:3128'), { address: '9.9.9.9:3128', host: '9.9.9.9', port: 3128 })
  assert.deepEqual(parseFreeListLine('[2001:db8::1]:1080'), { address: '[2001:db8::1]:1080', host: '[2001:db8::1]', port: 1080 })
  assert.equal(parseFreeListLine('# comment'), null)
  assert.equal(parseFreeListLine(''), null)
  assert.equal(parseFreeListLine('not-an-address'), null)
  assert.equal(parseFreeListLine('1.2.3.4:0'), null)
  assert.equal(parseFreeListLine('1.2.3.4:70000'), null)
})

test('dedupeAddresses preserves first-seen order and drops duplicates', () => {
  const out = dedupeAddresses(['a:1', 'b:2', 'a:1', 'c:3', '# x', 'b:2'])
  assert.deepEqual(
    out.map((entry) => entry.address),
    ['a:1', 'b:2', 'c:3'],
  )
})

test('source breaker: N consecutive failures disable, cooldown re-enables (GoProxy semantics)', () => {
  let clock = 0
  const breaker = new SourceBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => clock })
  const url = 'https://example.test/list.txt'

  assert.ok(breaker.canUse(url))
  breaker.recordFailure(url)
  breaker.recordFailure(url)
  assert.ok(breaker.canUse(url)) // 2 < 3
  breaker.recordFailure(url)
  assert.ok(!breaker.canUse(url)) // tripped
  assert.equal(breaker.disabledCount(), 1)

  clock = 999
  assert.ok(!breaker.canUse(url))
  clock = 1001
  assert.ok(breaker.canUse(url)) // cooled down, counter reset
  breaker.recordFailure(url)
  assert.ok(breaker.canUse(url)) // back to 1 consecutive

  // success resets instantly
  breaker.recordFailure(url)
  breaker.recordFailure(url)
  breaker.recordSuccess(url)
  assert.ok(breaker.canUse(url))
  breaker.recordFailure(url)
  assert.ok(breaker.canUse(url))
})

test('selectSources maps pool state to source tiers (3.5)', () => {
  assert.equal(selectSources('healthy').length, 0)
  const warningSources = selectSources('warning')
  assert.ok(warningSources.length > 0)
  assert.ok(warningSources.every((s) => s.tier === 'fast'))
  assert.equal(selectSources('critical').length, warningSources.length)
  assert.equal(selectSources('emergency').length, freeSources.length) // breaker ignored
})

test('fetchSource parses a fetched list through the injected fetch', async () => {
  const body = ['1.2.3.4:8080', '5.6.7.8:1080', '1.2.3.4:8080'].join('\n')
  const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch
  const result = await fetchSource(freeSources[0]!, fetchImpl)
  assert.equal(result.addresses.length, 2)
  assert.deepEqual(
    result.addresses.map((a) => a.address),
    ['1.2.3.4:8080', '5.6.7.8:1080'],
  )
})

test('fetchSource surfaces HTTP failures for the breaker to record', async () => {
  const fetchImpl = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
  await assert.rejects(() => fetchSource(freeSources[0]!, fetchImpl), /HTTP 404/)
})
