import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { conversationSeed, deriveRequestIDs, disguiseHeaders, opencodeUserAgent, randomID, stableID } from '../src/adapter/ids.ts'

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
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['X-Session-Id'], ids.session)
  assert.equal(headers['x-opencode-request'], ids.request)
  assert.equal(headers['x-opencode-project'], ids.project)
  assert.ok(headers['user-agent'].startsWith('opencode/'))
  assert.ok(headers['user-agent'].includes(process.platform))
})
