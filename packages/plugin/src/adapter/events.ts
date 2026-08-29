/**
 * pi-ai AssistantMessageEvent -> harness StreamChunks. Clean-room port of
 * dsh-llm-pi-ai toStreamChunks (verified against its source, index.js:1342-1452):
 * the chunk stream must end with `usage` then `finish`.
 */

export type HarnessChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool-call'; id: string; name: string; arguments: string } }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'tool-calls' }
  | { kind: 'aborted'; failure: { message: string; code: string } }
  | { kind: 'error'; failure: { message: string; code: string } }

/** pi-ai AssistantMessageEvent vocabulary (subset we consume). */
export type PiEvent =
  | { type: 'start'; partial: PiAssistantPartial }
  | { type: 'text_start'; contentIndex: number; partial: PiAssistantPartial }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: PiAssistantPartial }
  | { type: 'text_end'; contentIndex: number; content: string; partial: PiAssistantPartial }
  | { type: 'thinking_start'; contentIndex: number; partial: PiAssistantPartial }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: PiAssistantPartial }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: PiAssistantPartial }
  | { type: 'toolcall_start'; contentIndex: number; partial: PiAssistantPartial }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: PiAssistantPartial }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: { id: string; name: string; arguments: Record<string, unknown> }; partial: PiAssistantPartial }
  | { type: 'done'; message: PiDoneMessage }
  | { type: 'error'; error: PiDoneMessage }

export interface PiAssistantPartial {
  content: Array<{ type: string; id?: string; name?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** pi-ai AssistantMessage content block (done/error messages carry these). */
export type PiAssistantBlock = { type: string; [key: string]: unknown }

export interface PiDoneMessage {
  api: string
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  content: PiAssistantBlock[]
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  errorMessage?: string
  [key: string]: unknown
}

const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'
const EMPTY_RESPONSE = 'EMPTY_RESPONSE'
const QUOTA_EXCEEDED = 'QUOTA_EXCEEDED'

function classifyError(text: string): string {
  if (/\b(?:401|403)\b/.test(text)) return 'AUTH'
  if (/insufficient|quota|billing/i.test(text)) return QUOTA_EXCEEDED
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large/i.test(text)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(text)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return 'TRANSPORT'
  return 'UPSTREAM'
}

function isContextOverflow(message: PiDoneMessage, contextWindow: number): boolean {
  // pi-ai isContextOverflow equivalent: error-free finish whose input usage
  // alone exceeds the resolved window.
  return message.stopReason === 'stop' && message.usage.input > contextWindow
}

/** mapStopReason (dsh-llm-pi-ai index.js:1286-1330). */
function mapStopReason(message: PiDoneMessage, contextWindow: number): FinishReason {
  if (isContextOverflow(message, contextWindow) || (message.stopReason === 'error' && message.errorMessage !== undefined && /context/i.test(message.errorMessage) && /exceed|window|length|token/i.test(message.errorMessage))) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED,
      },
    }
  }
  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: { message: `model "${message.model}" returned a completed response with no content`, code: EMPTY_RESPONSE },
        }
      }
      return { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return { kind: 'aborted', failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' } }
    case 'error':
      return {
        kind: 'error',
        failure: { message: message.errorMessage ?? 'pi-ai stream error', code: classifyError(message.errorMessage ?? '') },
      }
  }
}

function mapUsage(usage: PiDoneMessage['usage']): Extract<HarnessChunk, { type: 'usage' }>['usage'] {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/**
 * Translate one pi-ai event stream into harness chunks. pi-ai never throws
 * mid-stream: failures arrive as `error` events and become error/aborted
 * finish chunks.
 */
export async function* toStreamChunks(events: AsyncIterable<PiEvent>, contextWindow: number): AsyncGenerator<HarnessChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? (partial.id ?? '') : ''
        const name = partial?.type === 'toolCall' ? (partial.name ?? '') : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: known?.id ?? '',
          ...(known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message, contextWindow) }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
    }
  }
  throw new Error('opencode2dsh: pi-ai event stream ended without done/error')
}
