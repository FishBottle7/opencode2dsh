/**
 * Harness GenerateOptions -> pi-ai Context conversion (clean-room version of
 * dsh-llm-pi-ai's textOnlyContext, scoped to text-only models: dsh-llm strips
 * images before dispatch when the model declares text-only input modalities).
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
  role: 'system' | 'user' | 'assistant'
  content: HarnessBlock[]
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
  reasoningEffort?: string
  signal?: AbortSignal
  [key: string]: unknown
}

/** pi-ai message vocabulary (subset we emit). */
export type PiMessage =
  | { role: 'user'; content: string; timestamp: number }
  | {
      role: 'assistant'
      content: PiAssistantBlock[]
      api: 'openai-completions'
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
        throw new Error('opencode2dsh: assistant image output cannot be replayed to a text-only model')
      default:
        break
    }
  }
  const source = message.source
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: source?.kind === 'model' && typeof source.provider === 'string' ? source.provider : providerId,
    model: source?.kind === 'model' && typeof source.model === 'string' ? source.model : providerId,
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

function toolResultText(blocks: HarnessBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? toolResultText(block.content) : ''))
    .join('')
}

/**
 * Convert the harness conversation into a pi-ai Context. Mirrors
 * textOnlyContext: text-only user content, tool results as toolResult
 * messages, assistant history as pi-ai assistant messages.
 */
export function toPiContext(options: HarnessGenerateOptions): PiContext {
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
    const text = flattenText(message)
    const results = message.content.filter((block) => block.type === 'tool-result') as Array<
      Extract<HarnessBlock, { type: 'tool-result' }>
    >
    if (text.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content: text, timestamp: 0 })
    }
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(result.content) || '(no output)' }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const context: PiContext = { messages }
  if (typeof options.system === 'string' && options.system.length > 0) context.systemPrompt = options.system
  const tools = options.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  if (tools && tools.length > 0) context.tools = tools
  return context
}
