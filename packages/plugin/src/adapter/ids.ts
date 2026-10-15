import { createHash, randomBytes } from 'node:crypto'

/**
 * Port of agent/internal/ids (opencode2api ids.go, verbatim semantics):
 * stable session/project ids derived from the conversation's first user turn,
 * and a per-request random id. The upstream sees CLI-identical correlation
 * headers built from these (zen-adapter.ts).
 */

export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

export function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * The conversation signal: JSON of the first user message's content. Using the
 * first user turn keeps a multi-turn conversation stable as its history grows
 * while separating conversations with different beginnings (ids.go:59-76).
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/**
 * Derive the correlation ids for one upstream request. In adapter mode there
 * are no inbound opencode headers, so the seed is the conversation itself.
 */
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2dsh:default-project'),
    parentSession: '',
  }
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 lowercase hex timestamp
 * characters + 14 Base62 characters. Since 2026-09-16 the Zen free tier
 * rejects any other session shape with 403 FreeTierError ("free tier can
 * only be used from within OpenCode") — the plain User-Agent gate stopped
 * being sufficient (upstream fix: jasonxu114514/opencode2api 8185202).
 * Live-probed 2026-09-18: the gate has a second, body-shape half (streaming
 * + bash/read tools, adapter/messages.ts); both must pass.
 *
 * Issue #62 (2026-10-13): matching that SHAPE stopped being sufficient. The
 * 12 hex characters are not an arbitrary blob — they encode a real
 * timestamp, bitwise-inverted, and the free tier decodes them back and
 * rejects anything that is not a plausible wall-clock time. A digest-derived
 * prefix therefore 403s even though it matches the regex. See
 * `invertedTimestampHex`.
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/**
 * The 12 hex characters a genuine OpenCode client emits, ported from
 * upstream's identifier generator (`packages/schema/src/identifier.ts`):
 * take the millisecond clock, append a per-millisecond sequence in the low
 * 12 bits, and invert the whole thing bitwise (`~x`), so ids sort newest
 * first as plain strings.
 *
 * The sequence matters: the low 12 bits are exactly `counter`, and the
 * inversion flips them, which is why a real counter-1 session ends its time
 * segment in `ffe` — a structural consequence, not a magic marker. Live
 * probes (2026-10-13) show the free tier reads those low 12 bits back as a
 * per-millisecond counter and accepts only `[0, 63]`; the high 36 clock bits
 * are not checked (an id whose clock decodes to 1970 still passes). A digest
 * prefix lands in that window ~1.5% of the time, so it is rejected almost
 * always even though it matches the regex.
 *
 * We always mint counter 1: this plugin is the only writer of its own
 * sessions, so a per-millisecond counter would only add state.
 *
 * Exported for the regression test that pins this against upstream's own
 * encoder; not part of the wire contract.
 */
export function invertedTimestampHex(now: number = Date.now()): string {
  const current = BigInt(now) * 0x1000n + 1n
  const inverted = ~current & 0xffffffffffffn
  return inverted.toString(16).padStart(12, '0')
}

/**
 * A synthesized session, memoized per conversation signal.
 *
 * The clock half must be minted ONCE per conversation, not per request: a
 * retry (reasoning-only → Off), or any second call in the same conversation,
 * has to reuse the identical `ses_` id. Upstream groups the free tier's quota
 * and prompt cache by session, so a fresh clock on every request would both
 * break the retry contract asserted in reasoning-recovery.test.ts and forfeit
 * cache reuse across turns.
 *
 * Capped at {@link SESSION_MEMO_LIMIT} entries, oldest-evicted, so a
 * long-lived process cannot grow the map without bound.
 */
const SESSION_MEMO_LIMIT = 1024
const sessionMemo = new Map<string, string>()

/**
 * The session id sent upstream. A signal that already carries an official
 * OpenCode session passes through unchanged (preserving upstream prompt-cache
 * affinity); any other identity — the conversation seed in adapter mode,
 * foreign client sessions, admission probes — is expanded into a canonical id
 * whose timestamp segment is a REAL clock (issue #62), with the conversation
 * identity folded into the Base62 tail so distinct conversations never collide.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal

  const memoized = sessionMemo.get(signal)
  if (memoized !== undefined) return memoized

  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const timePart = invertedTimestampHex()
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  const session = `ses_${timePart}${randomPart}`

  // Evict the oldest entry rather than clearing. Insertion-ordered Map, so
  // this is FIFO by first mint, NOT LRU: a hit returns early above and does
  // not re-insert. That is fine here — 1024 live conversations is far past
  // any realistic window, and a re-minted id only costs cache affinity.
  if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
    const oldest = sessionMemo.keys().next()
    if (!oldest.done) sessionMemo.delete(oldest.value)
  }
  sessionMemo.set(signal, session)
  return session
}

/** CLI-identical user agent (ids.go opencodeUserAgent, node runtime values). */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * The full disguise header set sent with every upstream request
 * (design.md 2.4; gateway.go newUpstreamRequest:640-669).
 *
 * `x-opencode-request` is never sent — any value is refused (#75). The project
 * header carries `global` rather than a `prj_` id, which is refused too (#75).
 * `x-opencode-session-id` repeats the session id, required once the User-Agent
 * claims an opencode release above 1.18.33 (#74, #78).
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-opencode-session-id': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-project': 'global',
  }
}
