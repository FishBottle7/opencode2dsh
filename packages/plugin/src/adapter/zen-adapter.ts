import { createProvider, type Api, type Context, type Model } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'

import { ModelCatalog, ZEN_BASE_URL } from './catalog.ts'
import { toStreamChunks, type HarnessChunk, type PiEvent } from './events.ts'
import { deriveRequestIDs, disguiseHeaders } from './ids.ts'
import { toPiContext, type HarnessGenerateOptions } from './messages.ts'

/**
 * The TS adapter: registers as a DSH LlmAdapter for the `opencode2dsh` route
 * and streams directly from the OpenCode Zen anonymous lane. The wire layer is
 * pi-ai's openai-completions implementation (the same one DSH uses for every
 * OpenAI-compatible provider); this module adds the CLI disguise headers, the
 * derived session/request ids, and the free-model catalog.
 *
 * Adapter contract: dsh-llm LlmAdapter (providerInfo/listModels/resolveModel/
 * prepareCall/stream) — structural, no host import.
 */

export const PROVIDER_ID = 'opencode2dsh'

export interface ZenModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export interface CatalogLike {
  list(): string[]
  decision(model: string): { allowed: boolean; source: string; known: boolean }
}

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

/** Anonymous credential: the literal upstream accepts for the free lane. */
const ANONYMOUS_KEY = 'public'

function toPiModel(id: string, contextWindow = DEFAULT_CONTEXT_WINDOW, maxTokens = DEFAULT_MAX_TOKENS): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: `${ZEN_BASE_URL.replace(/\/+$/, '')}/v1`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }
}

export class ZenAdapter {
  readonly #catalog: CatalogLike
  readonly #provider

  constructor(catalog: CatalogLike, options: { zenBaseUrl?: string } = {}) {
    this.#catalog = catalog
    const baseUrl = `${(options.zenBaseUrl ?? ZEN_BASE_URL).replace(/\/+$/, '')}/v1`
    this.#provider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_ID,
      baseUrl,
      auth: {
        apiKey: {
          name: 'OpenCode Zen anonymous lane',
          resolve: async () => ({ auth: { apiKey: ANONYMOUS_KEY } }),
        },
      },
      models: [],
      api: openaiCompletions,
    })
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_ID }
  }

  /** Advisory catalog for the DSH model picker. */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    return this.#catalog.list().map((id) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text'],
    }))
  }

  resolveModel(provider: string, model: string): {
    provider: string
    id: string
    name: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
  } {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    }
  }

  async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
    model: ReturnType<ZenAdapter['resolveModel']>
    stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk>
  }> {
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  /** Stream one Chat turn from the Zen anonymous lane. */
  async *stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const context = toPiContext(options)
    const ids = deriveRequestIDs(options.messages)
    const model = toPiModel(options.model)
    // Structural boundary: PiContext (own types, unit-tested) -> pi-ai Context.
    const events = this.#provider.streamSimple(model, context as unknown as Context, {
      apiKey: ANONYMOUS_KEY,
      sessionId: ids.session,
      headers: disguiseHeaders(ids),
      signal: options.signal,
      maxRetries: 0,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    })
    yield* toStreamChunks(events as unknown as AsyncIterable<PiEvent>, model.contextWindow)
  }

  /** Expose the live catalog snapshot for diagnostics. */
  catalogStatus(): { total: number; exposed: number } {
    const list = this.#catalog.list()
    return { total: list.length, exposed: list.length }
  }

  decisionFor(model: string): { allowed: boolean; source: string } {
    const decision = this.#catalog.decision(model)
    return { allowed: decision.allowed, source: decision.source }
  }
}

/** Build the adapter over a live catalog. */
export function createZenAdapter(catalog: ModelCatalog): ZenAdapter {
  return new ZenAdapter(catalog)
}
