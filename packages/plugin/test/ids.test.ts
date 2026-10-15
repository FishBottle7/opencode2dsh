import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalSessionID, conversationSeed, deriveRequestIDs, disguiseHeaders, invertedTimestampHex, opencodeUserAgent, randomID, stableID } from '../src/adapter/ids.ts'

test('stableID is deterministic and sha256-truncated', () => {
  const first = stableID('ses', 'hello')
  const second = stableID('ses', 'hello')
  assert.equal(first, second)
  assert.ok(first.startsWith('ses_'))
  const hex = first.slice('ses_'.length)
  assert.equal(hex.length, 24, '12 bytes hex')
  const expected = createHash('sha256').update('ses\x00hello').digest().subarray(0, 12).toString('hex')
  assert.equal(hex, expected)
  assert.notEqual(stableID('ses', 'world'), first)
  assert.notEqual(stableID('prj', 'hello'), first, 'prefix is part of the hash input')
})

test('randomID differs per call with the requested size', () => {
  const a = randomID('req', 16)
  const b = randomID('req', 16)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('req_'))
  assert.equal(a.slice('req_'.length).length, 32, '16 bytes hex')
})

test('canonicalSessionID passes official sessions through unchanged', () => {
  const official = 'ses_00000000abc0ABCdefGHIjklMN'
  assert.match(official, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(canonicalSessionID(official), official)
  // foreign shapes do NOT match the canonical gate: 24-hex is the wrong length
  assert.doesNotMatch('ses_0123456789abcdef01234567', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

/**
 * Issue #62: the free tier stopped accepting digest-derived session ids.
 *
 * The 12 hex characters of a `ses_` id are not arbitrary — they are an
 * inverted wall-clock reading, `~(Date.now() * 0x1000 + counter)`. A digest
 * prefix matches the regex perfectly and is still refused, which is why the
 * old shape-only test kept passing while every request 403'd.
 *
 * Upstream's own encoder, transcribed from
 * `packages/schema/src/identifier.ts`, is the oracle here: our output must be
 * byte-identical for the same clock. Comparing against a reimplementation of
 * the same formula inside the module under test would prove nothing.
 */
function upstreamTimeHex(descending: boolean, timestamp: number, counter: number): string {
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  return Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0'),
  ).join('')
}

test('invertedTimestampHex reproduces upstream byte-for-byte (issue #62)', () => {
  // Fixed clocks, so this is an exact vector rather than a "close enough"
  // comparison against a live Date.now() the process may tick past.
  assert.equal(invertedTimestampHex(0), upstreamTimeHex(true, 0, 1))
  assert.equal(invertedTimestampHex(1), upstreamTimeHex(true, 1, 1))
  assert.equal(invertedTimestampHex(1_000_000_000_000), upstreamTimeHex(true, 1_000_000_000_000, 1))
  assert.equal(invertedTimestampHex(1_791_884_044_070), upstreamTimeHex(true, 1_791_884_044_070, 1))

  // Structural consequence of the inversion: counter 1 inverts to ...ffe.
  // A digest prefix has no such structure — this is the string-level tell.
  for (const clock of [0, 1, 1_000_000_000_000, 1_791_884_044_070, Date.now()]) {
    assert.equal(invertedTimestampHex(clock).slice(9, 12), 'ffe', `clock ${clock}`)
  }

  // Descending: a later clock sorts earlier as a plain string, which is what
  // upstream relies on to order sessions.
  assert.ok(invertedTimestampHex(1_000) < invertedTimestampHex(999), 'newer sessions sort first')
})

test('canonicalSessionID emits a live clock, not a digest (issue #62)', () => {
  // A fresh signal each time, so the memo cannot mask a wrong clock.
  for (let i = 0; i < 5; i++) {
    const before = Date.now()
    const session = canonicalSessionID(`live-clock-probe-${i}`)
    const after = Date.now()
    assert.match(session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

    const hex = session.slice('ses_'.length, 'ses_'.length + 12)
    // Our live clock must land inside the window the test just measured, and
    // must equal what upstream's encoder would emit for some clock in it.
    assert.ok(
      [...Array(after - before + 1).keys()].some((offset) => hex === upstreamTimeHex(true, before + offset, 1)),
      `${hex} is not upstream's encoding of any clock in [${before}, ${after}]`,
    )
    assert.equal(hex.slice(9, 12), 'ffe')
  }
})

test('the pre-fix digest prefix could never satisfy the clock check (issue #62 control)', () => {
  // The exact pre-fix derivation, kept as a control so the regression cannot
  // come back unnoticed: shape-valid, and still wrong.
  const signal = '"hello"'
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const digestHex = sum.subarray(0, 6).toString('hex')
  const old = `ses_${digestHex}` + '0ySUUEO3741Ult'
  assert.match(old, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'the old output was shape-valid')

  // Inverting the digest prefix would have to recover a timestamp. Instead of
  // enumerating clocks, solve for the counter: if the 12 hex chars really are
  // `~(clock * 0x1000 + counter)`, the low 12 bits must be ~counter, i.e. the
  // hex must END in fff..000. A digest ends in ffe about 1 time in 256, and
  // even then the recovered clock is meaningless — so pin the structural rule
  // directly rather than a probabilistic one.
  const asCounter = ~(BigInt('0x' + digestHex) & 0xfffn) & 0xfffn
  assert.ok(asCounter > 0x100n, `digest decodes to an absurd counter ${asCounter}, not a per-millisecond one`)

  // And the fixed id always satisfies it.
  const fixed = canonicalSessionID(signal).slice(4, 16)
  assert.equal(~(BigInt('0x' + fixed) & 0xfffn) & 0xfffn, 1n, 'the fix carries counter = 1')
})

test('the synthesized session is stable per conversation but the clock is real (issue #62)', () => {
  // The whole id is memoized per conversation: a retry, or a later turn, must
  // reuse it, because upstream groups free-tier quota and prompt cache by
  // session. Re-reading a live clock here would silently break both.
  const first = canonicalSessionID('conversation A')
  const second = canonicalSessionID('conversation A')
  assert.equal(first, second, 'the same conversation reuses one session id')

  // Distinct conversations must not collide. The clock half can legitimately
  // coincide (both minted in the same millisecond), so the invariant that
  // actually separates them is the digest-derived Base62 tail.
  const TAIL = 'ses_'.length + 12
  assert.notEqual(canonicalSessionID('a'), canonicalSessionID('b'))
  assert.notEqual(canonicalSessionID('a').slice(TAIL), canonicalSessionID('b').slice(TAIL))
})

test('a conversation minted earlier keeps its session across a clock tick', () => {
  // Pin the first id's clock, then let real time pass and ask again: the
  // memoized id must not be re-derived. This is the retry-affinity contract
  // reasoning-recovery.test.ts also depends on.
  const signal = 'clock-tick-sensitivity-probe'
  const before = canonicalSessionID(signal)
  const clockAtFirstCall = invertedTimestampHex()
  const end = Date.now() + 5
  while (Date.now() < end) { /* burn a few milliseconds so the clock really moves */ }
  assert.notEqual(invertedTimestampHex(), clockAtFirstCall, 'the clock advanced')
  assert.equal(canonicalSessionID(signal), before, 'and the session is still the same id')
})

test('canonicalSessionID hashes foreign ids into the canonical shape', () => {
  // Regression vectors for the tail, computed independently of the
  // implementation (sha256("ses\0"+signal) bytes 6..16 as big-endian base62,
  // width 14). The 12 hex characters are the live clock, so only the tail is
  // a fixed vector.
  const TAIL = 'ses_'.length + 12
  assert.equal(canonicalSessionID('"hello"').slice(TAIL), '0ySUUEO3741Ult')
  assert.equal(canonicalSessionID('admission:1.2.3.4:8080').slice(TAIL), '39B83lyhD6aJHb')
  // deterministic: same conversation keeps a stable session
  assert.equal(canonicalSessionID('anything').slice(TAIL), canonicalSessionID('anything').slice(TAIL))
  // distinct identities stay distinct
  assert.notEqual(canonicalSessionID('a').slice(TAIL), canonicalSessionID('b').slice(TAIL))
})

test('deriveRequestIDs emits canonical-shape sessions with a live clock', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  assert.match(ids.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(ids.session.slice('ses_'.length + 9, 'ses_'.length + 12), 'ffe', 'counter-1 sessions end the time segment in ffe')
})

test('conversationSeed uses the first user turn and skips non-user messages', () => {
  const messages = [
    { role: 'system', content: 'sys prompt' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: { text: 'first question' } },
    { role: 'user', content: 'second' },
  ]
  assert.equal(conversationSeed(messages), JSON.stringify({ text: 'first question' }))
  assert.equal(conversationSeed([]), '')
  assert.equal(conversationSeed([{ role: 'assistant', content: 'x' }]), '')
  assert.equal(conversationSeed([{ role: 'user', content: null }]), '', 'null content is skipped')
})

test('deriveRequestIDs keeps the session stable across turns and randomizes requests', () => {
  const turnOne = [{ role: 'user', content: 'hello' }]
  const turnTwo = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'more' },
  ]
  const first = deriveRequestIDs(turnOne)
  const second = deriveRequestIDs(turnTwo)
  assert.equal(first.session, second.session)
  assert.notEqual(first.request, second.request)
  assert.equal(first.project, second.project)
  assert.ok(first.project.startsWith('prj_'))
  assert.equal(first.parentSession, '')
  // fallback: no user content at all still yields usable ids
  const empty = deriveRequestIDs([{ role: 'system', content: 'only system' }])
  assert.ok(empty.session.startsWith('ses_'))
  assert.notEqual(empty.session, deriveRequestIDs([{ role: 'system', content: 'only system' }]).session)
})

test('disguiseHeaders carries the CLI-identical correlation set', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  const headers = disguiseHeaders(ids)
  assert.equal(headers['user-agent'], opencodeUserAgent())
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], ids.session)
  assert.equal(headers['x-opencode-session-id'], ids.session)
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['X-Session-Id'], ids.session)
  // #75 refuses any x-opencode-request value and any prj_-prefixed project id.
  assert.equal(headers['x-opencode-request'], undefined)
  assert.equal(headers['x-opencode-project'], 'global')
  assert.ok(headers['user-agent'].startsWith('opencode/'))
  assert.ok(headers['user-agent'].includes(process.platform))
})
