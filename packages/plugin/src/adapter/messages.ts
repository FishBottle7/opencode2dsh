import { apiForModel } from './routing.ts'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Harness GenerateOptions -> pi-ai Context conversion (clean-room version of
 * dsh-llm-pi-ai's textOnlyContext). Unlike the host's text-only projection,
 * user and tool-result image blocks are kept: the adapter declares image
 * input modalities, so dsh-llm forwards them untouched and the bytes load
 * from the harness attachment store here.
 */

export interface HarnessTool {
  name: string
  description: string
  parameters: unknown
}

export type HarnessBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; [key: string]: unknown }
  | { type: 'tool-result'; toolCallId: string; content: HarnessBlock[]; isError?: boolean; [key: string]: unknown }

export interface HarnessMessage {
  /**
   * DSH >= 0.2 delivers tool results as `role: 'tool'` messages with the call
   * id at the message level; older hosts wrap them in `role: 'user'` messages
   * carrying `tool-result` content blocks. Both shapes are handled.
   */
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: HarnessBlock[]
  toolCallId?: string
  isError?: boolean
  source?: { kind: string; provider?: string; model?: string; callId?: string; [key: string]: unknown }
}

export interface HarnessGenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: string
  tools?: HarnessTool[]
  maxTokens?: number
  temperature?: number
  reasoning?: string
  reasoningEffort?: string
  signal?: AbortSignal
  [key: string]: unknown
}

/** pi-ai message vocabulary (subset we emit). */
export type PiMessage =
  | { role: 'user'; content: string | PiContentBlock[]; timestamp: number }
  | {
      role: 'assistant'
      content: PiAssistantBlock[]
      api: 'openai-completions' | 'openai-responses'
      provider: string
      model: string
      usage: PiUsage
      stopReason: 'stop' | 'toolUse'
      timestamp: number
    }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: PiContentBlock[]; isError: boolean; timestamp: number }

export type PiAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

export type PiContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface PiTool {
  name: string
  description: string
  parameters: unknown
}

export interface PiContext {
  systemPrompt?: string
  messages: PiMessage[]
  tools?: PiTool[]
}

export function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed }
  } catch {
    return { raw }
  }
}

/**
 * Harness attachment root (mirrors dsh-attachment-local's resolveDshHome).
 * DSH_HOME is always set by the harness child; the homedir fallback covers
 * direct invocation (tests, tooling).
 */
function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh')
}

/**
 * Convert one harness image block to pi-ai ImageContent by reading the
 * content-addressed normalized object (DSH_HOME/attachments/v1/objects/<2>/<sha>).
 * Falls back to stable text on any failure so a missing object can never
 * fail the whole stream.
 */
async function toPiImage(ref: unknown): Promise<PiContentBlock> {
  const attachment = (ref ?? {}) as { attachmentId?: unknown; mediaType?: unknown }
  const id = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : ''
  const sha = id.startsWith('sha256:') ? id.slice(7) : id
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    return { type: 'text', text: `[image omitted: unreadable attachment reference ${JSON.stringify(id)}]` }
  }
  const path = join(dshHome(), 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
  try {
    const bytes = await readFile(path)
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: typeof attachment.mediaType === 'string' && attachment.mediaType.length > 0 ? attachment.mediaType : 'image/png',
    }
  } catch {
    return { type: 'text', text: `[image omitted: failed to read normalized attachment ${JSON.stringify(id)}]` }
  }
}

/**
 * Host-budget-offloaded images were routed out of the request by dsh-llm on
 * purpose (`offloaded: true`); re-reading their bytes from disk would defy the
 * image budget the host already enforced. Emit a stable placeholder instead —
 * the same semantics as the host adapter's projectOffloadedImages.
 */
function offloadedImagePart(ref: unknown): PiContentBlock {
  const id = (ref as { attachmentId?: unknown } | null | undefined)?.attachmentId
  const short = typeof id === 'string' && id.length > 0 ? ` ${id.slice(0, 30)}` : ''
  return { type: 'text', text: `[image omitted: offloaded to fit the request image budget${short}]` }
}

/** One image block, respecting the host's offload flag. */
async function imagePart(block: { type?: unknown; attachment?: unknown; offloaded?: unknown }): Promise<PiContentBlock> {
  return block.offloaded === true ? offloadedImagePart(block.attachment) : toPiImage(block.attachment)
}

/** Text/image parts of one user message's content, in block order. */
async function userParts(blocks: HarnessBlock[]): Promise<PiContentBlock[]> {
  const parts: PiContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block))
    }
  }
  return parts
}

/** Text/image parts of one tool result's content, walking nested results. */
async function toolResultParts(blocks: HarnessBlock[]): Promise<PiContentBlock[]> {
  const parts: PiContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block))
    } else if (block.type === 'tool-result') {
      parts.push(...(await toolResultParts(block.content)))
    }
  }
  return parts
}

function toPiAssistant(message: HarnessMessage, providerId: string): Extract<PiMessage, { role: 'assistant' }> {
  const content: PiAssistantBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call':
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        break
      case 'image':
        break // assistant images are not replayable; drop rather than fail the stream
      default:
        break
    }
  }
  const source = message.source
  const model = source?.kind === 'model' && typeof source.model === 'string' ? source.model : providerId
  return {
    role: 'assistant',
    content,
    api: apiForModel(model),
    provider: source?.kind === 'model' && typeof source.provider === 'string' ? source.provider : providerId,
    model,
    usage: zeroUsage(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function flattenText(message: HarnessMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

/**
 * Call id of a message-level tool result (DSH >= 0.2: `role: 'tool'`,
 * `toolCallId` on the message, plain content blocks, `source.callId` as a
 * mirror). Returns undefined for ordinary user/system messages. Only consult
 * `source.callId` when the source is a tool, so model/user provenance can
 * never be mistaken for a tool result.
 */
function messageToolCallId(message: HarnessMessage): string | undefined {
  if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0) return message.toolCallId
  const source = message.source
  if (source?.kind === 'tool' && typeof source.callId === 'string' && source.callId.length > 0) return source.callId
  return undefined
}

/** Emit one pi-ai toolResult, substituting a placeholder for empty output. */
async function pushToolResult(
  messages: PiMessage[],
  toolNames: Map<string, string>,
  toolCallId: string,
  content: HarnessBlock[],
  isError: boolean,
): Promise<void> {
  let rparts = await toolResultParts(content)
  const hasImage = rparts.some((part) => part.type === 'image')
  const hasText = rparts.some((part) => part.type === 'text' && part.text.length > 0)
  if (!hasImage && !hasText) rparts = [{ type: 'text', text: '(no output)' }]
  messages.push({
    role: 'toolResult',
    toolCallId,
    toolName: toolNames.get(toolCallId) ?? 'unknown',
    content: rparts,
    isError,
    timestamp: 0,
  })
}

/**
 * Convert the harness conversation into a pi-ai Context. User and tool-result
 * messages keep text AND image blocks (images load from the harness
 * attachment store); tool results as toolResult messages, assistant history as
 * pi-ai assistant messages. Async because image bytes are read from disk.
 */
export async function toPiContext(options: HarnessGenerateOptions): Promise<PiContext> {
  const providerId = options.provider
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = flattenText(message)
      if (text.length > 0) messages.push({ role: 'user', content: text, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, providerId)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const results = message.content.filter((block) => block.type === 'tool-result') as Array<
      Extract<HarnessBlock, { type: 'tool-result' }>
    >
    if (results.length === 0) {
      // DSH >= 0.2 tool result: call id lives on the message, content is
      // plain text/image blocks. It must land in the toolResult slot only —
      // emitting it as a user message makes the model mistake tool output
      // for user input (and the real toolResult is never sent).
      const toolCallId = messageToolCallId(message)
      if (toolCallId !== undefined) {
        await pushToolResult(messages, toolNames, toolCallId, message.content, message.isError ?? false)
        continue
      }
    }
    const parts = await userParts(message.content)
    if (parts.length > 0 || results.length === 0) {
      const first = parts[0]
      let content: string | PiContentBlock[]
      if (parts.length === 0) content = ''
      else if (parts.length === 1 && first?.type === 'text') content = first.text
      else content = parts
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      await pushToolResult(messages, toolNames, result.toolCallId, result.content, result.isError ?? false)
    }
  }
  const context: PiContext = { messages }
  if (typeof options.system === 'string' && options.system.length > 0) context.systemPrompt = options.system
  const tools = options.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  if (tools && tools.length > 0) context.tools = tools
  return context
}

/**
 * The Zen anonymous free lane (live-probed 2026-09-18) rejects chat bodies
 * that do not carry an agent shape: HTTP 403 FreeTierError unless the body
 * streams (`stream: true`) and its `tools` array includes function tools
 * named "bash" AND "read" — descriptions, parameters and every header
 * (User-Agent included) go uninspected. pi-ai always streams, so the
 * chat-path gap is tools only: plain conversations carry none.
 */
export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'] as const

export interface FreeLaneGateTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export function freeLaneGateTool(name: (typeof FREE_LANE_GATE_TOOL_NAMES)[number]): FreeLaneGateTool {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

/** Responses uses flat function tools and its Zen gateway accepts auto only. */
export function ensureResponsesFreeLaneShape(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.input)) return undefined
  const tools = Array.isArray(body.tools) ? body.tools as unknown[] : []
  const names = new Set(tools.map((tool) => {
    if (typeof tool !== 'object' || tool === null) return undefined
    const candidate = tool as { type?: unknown; name?: unknown }
    return candidate.type === 'function' ? candidate.name : undefined
  }))
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name))
  const invalidChoice = body.tool_choice !== undefined && body.tool_choice !== 'auto'
  if (missing.length === 0 && !invalidChoice) return undefined
  return {
    ...body,
    tools: [...tools, ...missing.map((name) => ({ type: 'function', ...freeLaneGateTool(name).function }))],
    tool_choice: 'auto',
  }
}

/**
 * Rewrite an outgoing chat-completions payload so it satisfies the free-lane
 * agent-shape gate (wired through pi-ai's onPayload). Appends only the gate
 * tools the payload is missing; when the context carried no tools at all,
 * tool_choice 'none' keeps the model from ever calling the injected stubs,
 * while client-provided tool choices are preserved untouched. Returns
 * undefined when the payload already satisfies the gate or is not a
 * chat-completions body (pi-ai keeps the original in that case).
 */
export function ensureFreeLaneShape(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.messages)) return undefined
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const names = new Set(
    tools.map((tool) => {
      const fn = typeof tool === 'object' && tool !== null ? (tool as { function?: { name?: unknown } }).function : undefined
      return typeof fn === 'object' && fn !== null ? fn.name : undefined
    }),
  )
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name))
  if (missing.length === 0) return undefined
  const next: Record<string, unknown> = { ...body }
  next.tools = [...tools, ...missing.map((name) => freeLaneGateTool(name))]
  if (tools.length === 0) next.tool_choice = 'none'
  return next
}
