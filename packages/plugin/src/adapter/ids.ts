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
    session: stableID('ses', signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2dsh:default-project'),
    parentSession: '',
  }
}

/** CLI-identical user agent (ids.go opencodeUserAgent, node runtime values). */
export function opencodeUserAgent(): string {
  return `opencode/1.18.21 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * The full disguise header set sent with every upstream request
 * (design.md 2.4; gateway.go newUpstreamRequest:640-669).
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
