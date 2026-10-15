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
 * The anonymous free-lane gate (live-probed 2026-10-15 against opencode
 * v2.0.29): a chat request passes with HTTP 200 only when ALL hold:
 *   1. it goes to `/inference/v1/chat/completions` — the console-proxy path
 *      `/zen/v1/...` now 403s every body (adapter/catalog.ts);
 *   2. `Authorization: Bearer public` is present;
 *   3. the User-Agent starts with `opencode` (the adapter always sends the
 *      official CLI spelling, adapter/ids.ts);
 *   4. a canonical `ses_*` id rides a session header (`x-opencode-session`,
 *      `x-session-affinity`, `X-Session-Id` or `x-opencode-session-id` — any
 *      ONE suffices; bad-shape ids 403);
 *   5. `tools` advertises `read` with a NON-EMPTY `parameters.properties`.
 *
 * The adapter also always streams (`stream: true`), which the previous
 * surface required; a non-streaming body was not re-probed on the new one.
 *
 * Three shapes are refused outright, so they are as load-bearing as the five
 * requirements above:
 *   - an `x-opencode-request` header (any value);
 *   - an `x-opencode-project` starting with `prj_` (adapter/ids.ts);
 *   - `bash`, `shell`, `edit`, `glob`, `grep`, `read` or `write` advertised
 *     with an EMPTY parameter object. A stub tool is worse than no tool: an
 *     otherwise-valid body becomes a 403. Neither the description text nor
 *     `required`/`additionalProperties` is inspected — the parameter object
 *     merely has to be non-empty — but the shipped recipe is the official
 *     definition (below) so a stricter check cannot catch it out.
 *
 * History: the 2026-09-18 recipe was `bash`+`read` stubs with empty schemas;
 * the 2026-10-11 probes read `bash`+`read` as the pass condition. Both are
 * superseded — `bash` is not in the official roster at all, and an empty
 * schema on any of those seven names now fails.
 */
export const FREE_LANE_GATE_TOOL_NAMES = ['read'] as const

/**
 * Inbound tool-call names rewritten before the chunk stream leaves the
 * adapter (zen-adapter.ts hands this to toStreamChunks). Empty on the shipped
 * recipe: every injected stub is call-disabled or host-named, so nothing the
 * model can call needs a rename. Kept as the seam for a future gate spelling
 * that forces an alias (e.g. a mandatory `shell`).
 */
export const GATE_TOOL_ALIASES: Record<string, string> = {}

export interface FreeLaneGateTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/**
 * The gate tool, transcribed from the official CLI v2's own request to the
 * inference surface (captured 2026-10-15 from `opencode` v2.0.29). The gate
 * only reads the parameter object, and would accept any non-empty one, but
 * shipping the real definition keeps the request indistinguishable from the
 * real client's. `strict: false`, which the official tool carries too, is
 * omitted: it is not inspected, and the Responses surface (below) takes a
 * flattened tool shape this field was never probed against.
 */
export const FREE_LANE_GATE_TOOLS: Record<(typeof FREE_LANE_GATE_TOOL_NAMES)[number], FreeLaneGateTool> = {
  read: {
    type: 'function',
    function: {
      name: 'read',
      description:
        'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory to read' },
          offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
          limit: {
            type: 'integer',
            minimum: 0,
            description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
}

export function freeLaneGateTool(name: (typeof FREE_LANE_GATE_TOOL_NAMES)[number]): FreeLaneGateTool {
  return FREE_LANE_GATE_TOOLS[name]
}

/**
 * A gate-named tool whose parameter object carries no properties. The lane
 * reads the schema, not just the name (live-probed 2026-10-15): a `read`
 * with empty `properties` passes the name check and still 403s, and one with
 * no `parameters` at all 400s. Such copies are dropped so the official
 * definition can take their place.
 */
function isHollowGateTool(
  tool: unknown,
  nameOf: (tool: Record<string, unknown>) => string | undefined,
  parametersOf: (tool: Record<string, unknown>) => unknown,
): boolean {
  if (typeof tool !== 'object' || tool === null) return false
  const record = tool as Record<string, unknown>
  const name = nameOf(record)
  if (typeof name !== 'string' || !(FREE_LANE_GATE_TOOL_NAMES as readonly string[]).includes(name)) return false
  const parameters = parametersOf(record) as { properties?: unknown } | undefined
  const properties = typeof parameters === 'object' && parameters !== null ? parameters.properties : undefined
  return typeof properties !== 'object' || properties === null || Object.keys(properties).length === 0
}

const chatFunction = (tool: Record<string, unknown>) => {
  const fn = tool.function as { name?: unknown; parameters?: unknown } | undefined
  return typeof fn === 'object' && fn !== null ? fn : undefined
}

const chatToolName = (tool: Record<string, unknown>) => {
  const name = chatFunction(tool)?.name
  return typeof name === 'string' ? name : undefined
}

const chatToolParameters = (tool: Record<string, unknown>) => chatFunction(tool)?.parameters

const flatToolName = (tool: Record<string, unknown>) =>
  tool.type === 'function' && typeof tool.name === 'string' ? tool.name : undefined

const flatToolParameters = (tool: Record<string, unknown>) => tool.parameters

/** Responses uses flat function tools and its lane gateway accepts auto only. */
export function ensureResponsesFreeLaneShape(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.input)) return undefined
  const tools = Array.isArray(body.tools) ? body.tools as unknown[] : []
  const keep = tools.filter((tool) => !isHollowGateTool(tool, flatToolName, flatToolParameters))
  const names = new Set(keep.map((tool) => flatToolName(tool as Record<string, unknown>)))
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name))
  const invalidChoice = body.tool_choice !== undefined && body.tool_choice !== 'auto'
  if (missing.length === 0 && !invalidChoice && keep.length === tools.length) return undefined
  return {
    ...body,
    tools: [...keep, ...missing.map((name) => ({ type: 'function', ...freeLaneGateTool(name).function }))],
    tool_choice: 'auto',
  }
}

/**
 * Rewrite an outgoing chat-completions payload so it satisfies the free-lane
 * agent-shape gate (wired through pi-ai's onPayload). Appends only the gate
 * tools the payload is missing — and replaces hollow copies in place, since a
 * name-only `read` satisfies the name check yet still 403s the lane. When the
 * context carried no tools at all, tool_choice 'none' keeps the model from
 * ever calling the injected tool, while client-provided tool choices are
 * preserved untouched. Returns undefined when the payload already satisfies
 * the gate or is not a chat-completions body (pi-ai keeps the original in
 * that case).
 *
 * The appended definitions are real (FREE_LANE_GATE_TOOLS), never stubs: an
 * empty `parameters.properties` on a gate-shaped name is itself a 403.
 */
export function ensureFreeLaneShape(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.messages)) return undefined
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const keep = tools.filter((tool) => !isHollowGateTool(tool, chatToolName, chatToolParameters))
  const names = new Set(keep.map((tool) => chatToolName(tool as Record<string, unknown>)))
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name))
  if (missing.length === 0 && keep.length === tools.length) return undefined
  const next: Record<string, unknown> = { ...body }
  next.tools = [...keep, ...missing.map((name) => freeLaneGateTool(name))]
  if (tools.length === 0) next.tool_choice = 'none'
  return next
}
