import { createProvider, type Api, type Context, type Model } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses'

import { ModelCatalog, ZEN_BASE_URL } from './catalog.ts'
import { toStreamChunks, type HarnessChunk, type PiDoneMessage, type PiEvent } from './events.ts'
import { deriveRequestIDs, disguiseHeaders } from './ids.ts'
import { ensureFreeLaneShape, ensureResponsesFreeLaneShape, toPiContext, type HarnessGenerateOptions, type PiContext } from './messages.ts'
import { apiForModel, isResponsesModel } from './routing.ts'
export { apiForModel, isResponsesModel } from './routing.ts'
import { routingContext, type RoutingContext } from '../pool/dispatcher.ts'
import { classifyStreamFailure, isRegionBlocked, shouldRotate } from '../pool/rotate.ts'

/**
 * The TS adapter: registers as a DSH LlmAdapter for the `opencode2dsh` route
 * and streams directly from the OpenCode Zen anonymous lane. The wire layer is
 * pi-ai's openai-completions implementation for most models (the same one DSH
 * uses for every OpenAI-compatible provider), plus pi-ai's openai-responses
 * for Responses-only models (muse-spark-*); this module adds the CLI disguise
 * headers, the derived session/request ids, and the free-model catalog.
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
  /**
   * Optional: bounded wait for the first live fetch (issue #45). listModels
   * awaits it so the host's registration-time snapshot is the live roster,
   * never the bootstrap list. Catalogs without it answer immediately from
   * whatever they have.
   */
  warm?(ms?: number): Promise<void>
  reasoningCapability(model: string): { reasoning: boolean; effortValues: string[] } | undefined
  /** Optional: models.dev-declared limits; absent catalogs keep the defaults. */
  limits?(model: string): { contextWindow?: number; maxOutput?: number } | undefined
  /** Optional: models.dev `modalities.input`, the input kinds the model
   *  accepts (["text","image","video",…]). Absent catalogs keep the built-in
   *  vision pattern. */
  modalities?(model: string): string[] | undefined
}

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

/** The advertised context window: the models.dev declaration when the
 * metadata speaks, the host default otherwise (pending/absent metadata or a
 * model that declares no `limit.context`). */
function contextWindowFor(limits: { contextWindow?: number } | undefined): number {
  const declared = limits?.contextWindow
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
    ? declared
    : DEFAULT_CONTEXT_WINDOW
}

/**
 * Use the declared output budget, including models that can answer beyond
 * 32768 tokens. Keep the fallback when metadata cannot provide a valid cap.
 */
function defaultMaxTokensFor(limits: { maxOutput?: number } | undefined): number {
  const declared = limits?.maxOutput
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
    ? declared
    : DEFAULT_MAX_TOKENS
}

/**
 * Reasoning-effort vocabulary the adapter owns end to end (dsh-llm treats the
 * ids as opaque: whatever resolveModel advertises comes back on
 * GenerateOptions.reasoningEffort). The ladder mirrors pi-ai's ThinkingLevel
 * so selected levels pass through untouched; `off` is the only id that maps
 * to a different wire spelling.
 */
export const REASONING_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Levels offered for reasoning models whose metadata declares no ladder. */
const DEFAULT_EFFORT_LADDER: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high']

/** Selectable reasoning effort as dsh-llm's resolveModel contract describes it. */
export interface ZenReasoningEffort {
  id: string
  name: string
  description?: string
}

/**
 * Turn the catalog's models.dev capability into the advertised effort list.
 * A declared ladder (models.dev `reasoning_options` effort values) wins — its
 * values are the upstream-honored spellings, with metadata `none` folded into
 * our `off`. Without a declaration, a reasoning model gets the standard
 * ladder the Zen gateway accepts for every model. Non-reasoning models
 * advertise nothing (the picker then offers only the provider default).
 */
export function reasoningEfforts(capability: { reasoning: boolean; effortValues: string[] } | undefined): ZenReasoningEffort[] | undefined {
  if (!capability?.reasoning) return undefined
  const declared: string[] = []
  for (const value of capability.effortValues) {
    const level = value === 'none' ? 'off' : value
    if ((REASONING_EFFORT_LADDER as readonly string[]).includes(level) && !declared.includes(level)) declared.push(level)
  }
  const levels = declared.length > 0
    ? declared.sort(
        (a, b) =>
          (REASONING_EFFORT_LADDER as readonly string[]).indexOf(a) -
          (REASONING_EFFORT_LADDER as readonly string[]).indexOf(b),
      )
    : DEFAULT_EFFORT_LADDER
  return levels.map((level) => ({ id: level, name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` }))
}

/**
 * The `reasoning_effort` wire value for a selected effort id. The Zen gateway
 * validates the field against `minimal|low|medium|high|xhigh|max|none`
 * (live-probed 2026-09-18: any other value is a hard 400), and `none` is the
 * only spelling that stops the always-think free models from thinking — a
 * mere omission keeps the provider default. So `off` maps to wire `none`,
 * ladder levels pass through verbatim, and unknown ids (never advertised)
 * inject nothing rather than risk the 400.
 */
export function reasoningEffortWire(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  if (id === 'off') return 'none'
  return (REASONING_EFFORT_LADDER as readonly string[]).includes(id) ? id : undefined
}

/** Anonymous credential: the literal upstream accepts for the free lane. */
const ANONYMOUS_KEY = 'public'

/**
 * Stream-liveness watchdogs (live-observed 2026-09-07): neither fetch nor
 * pi-ai owns a body-silence timeout, so a tunnel that stands but never
 * streams hangs the turn forever (70 minutes observed). Both messages
 * carry "timeout" so classifyStreamFailure maps them to 'transport' and
 * the rotate loop gets to move the session to a live exit.
 */
export const WATCHDOG_FIRST_MESSAGE = 'opencode2dsh: first stream event timeout (exit silent before any response)'
export const WATCHDOG_IDLE_MESSAGE = 'opencode2dsh: stream body idle timeout (exit went silent mid-response)'

/** Default watchdog windows (docs/ip-pool.md; test-injectable via constructor). */
export const DEFAULT_FIRST_EVENT_MS = 30_000
export const DEFAULT_BODY_IDLE_MS = 120_000
/**
 * Body-idle window for Responses models (muse-spark-*, issue #7): their
 * chain-of-thought streams pace in bursts with long mid-stream pauses, so
 * the chat default misreads slow reasoning as a dead tunnel. Named and
 * constructor-injectable so tests can exercise the wider window without
 * waiting out five real minutes.
 */
export const RESPONSES_BODY_IDLE_MS = 300_000

/** The terminal error event pi-ai owes but never sent (watchdog teardown). */
function terminalErrorEvent(errorMessage: string, model: Model<Api>): PiEvent {
  return {
    type: 'error',
    error: {
      api: model.api ?? 'openai-completions',
      provider: PROVIDER_ID,
      model: model.id,
      content: [],
      stopReason: 'error',
      errorMessage,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    },
  }
}

/**
 * Responses-only models on Zen (issue #7): `muse-spark-*` return a bare 500
 * on `POST /zen/v1/chat/completions` but 200 on `POST /zen/v1/responses`
 * (opencode #44659/#44847, DSH #3957). Route by model id; extend this list
 * if Zen moves more models (candidates: gpt-5.6-luna, grok-4.6).
 */


/**
 * Vision gate: whether a model accepts image input on the Zen lane.
 *
 * models.dev `modalities.input` decides whenever it speaks — the same
 * declaration that already drives `limit.context` / `limit.output` lists the
 * input kinds each model takes, and the free roster rotates constantly, so a
 * family-scoped pattern cannot track it: space-bunny-free,
 * muse-spark-1.*-contributor-free, mimo-v2.5-free, fledge-alpha-free and
 * longcat-2.5-preview-free all declare `image` upstream and are refused today
 * with `Model "<id>" does not support image input.` A declared text-only model
 * stays refused, so the gate still protects the lane in both directions.
 *
 * The built-in pattern remains the fallback for the ids whose image input was
 * live-verified end-to-end on 2026-09-28 (the mimo-v2.6 family), so metadata
 * being pending, absent or silent never changes what those models can do.
 * Models that end up text-only make DSH's attachment gates and pi-ai's image
 * downgrade refuse image parts instead of forwarding them to a model that
 * cannot see them.
 */
export function isVisionModel(id: string, declaredModalities?: string[]): boolean {
  if (Array.isArray(declaredModalities) && declaredModalities.length > 0) {
    return declaredModalities.includes('image')
  }
  return /^mimo-v2\.6/i.test(String(id ?? ''))
}

function toPiModel(id: string, reasoning: boolean, limits?: { contextWindow?: number; maxOutput?: number }, declaredModalities?: string[]): Model<Api> {
  const isResponses = isResponsesModel(id)
  return {
    id,
    name: id,
    api: apiForModel(id),
    provider: PROVIDER_ID,
    baseUrl: `${ZEN_BASE_URL.replace(/\/+$/, '')}/v1`,
    // The honest capability flag: gates pi-ai's reasoning_effort branch and
    // keeps developer-role replay suppressed (the Zen lane's compat detects
    // supportsDeveloperRole=false for opencode.ai, so the system slot is
    // unchanged either way). `image` (see isVisionModel) keeps pi-ai's
    // downgradeUnsupportedImages from dropping the image parts toPiContext
    // loads from the attachment store (the Zen gateway accepts image_url
    // data URLs, live-probed 2026-09-23; full round-trip through
    // DSH 0.1.7-rc.2 with mimo-v2.6-flash-free 2026-09-28).
    reasoning,
    input: isVisionModel(id, declaredModalities) ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowFor(limits),
    maxTokens: defaultMaxTokensFor(limits),
  }
}

function normalizeResponsesEffort(value: string | undefined): string | undefined {
  if (!value || value === 'off' || value === 'none') return undefined
  return (REASONING_EFFORT_LADDER as readonly string[]).includes(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize pi-ai's mixed reasoning shapes before a Responses request. */
export function normalizeResponsesPayload(payload: unknown, requestedEffort?: string): unknown | undefined {
  const shaped = ensureFreeLaneShape(payload)
  const base = shaped ?? payload
  if (!isRecord(base)) return shaped

  const next = { ...base }
  const legacyEffort = typeof next.reasoning_effort === 'string' ? next.reasoning_effort : undefined
  delete next.reasoning_effort

  const reasoning = isRecord(next.reasoning) ? { ...next.reasoning } : {}
  const existingEffort = normalizeResponsesEffort(typeof reasoning.effort === 'string' ? reasoning.effort : undefined)
  const effort = normalizeResponsesEffort(requestedEffort) ?? existingEffort ?? normalizeResponsesEffort(legacyEffort)
  if (effort) reasoning.effort = effort
  else delete reasoning.effort

  if (Object.keys(reasoning).length > 0) next.reasoning = reasoning
  else delete next.reasoning
  return next
}

export class ZenAdapter {
  readonly #catalog: CatalogLike
  readonly #provider: { streamSimple(model: unknown, context: unknown, options: unknown): unknown }
  readonly #responsesProvider: { streamSimple(model: unknown, context: unknown, options: unknown): unknown } | null
  readonly #firstEventMs: number
  readonly #bodyIdleMs: number
  readonly #responsesBodyIdleMs: number

  constructor(catalog: CatalogLike, options: {
    zenBaseUrl?: string
    providerOverride?: unknown
    /** Watchdog windows (tests inject short ones; defaults are live-tuned). */
    firstEventMs?: number
    bodyIdleMs?: number
    /** Overrides RESPONSES_BODY_IDLE_MS (watchdog tests inject short ones). */
    responsesBodyIdleMs?: number
  } = {}) {
    this.#catalog = catalog
    this.#firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS
    this.#bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS
    this.#responsesBodyIdleMs = options.responsesBodyIdleMs ?? RESPONSES_BODY_IDLE_MS
    if (options.providerOverride !== undefined) {
      this.#provider = options.providerOverride as never
      this.#responsesProvider = null
      return
    }
    const baseUrl = `${(options.zenBaseUrl ?? ZEN_BASE_URL).replace(/\/+$/, '')}/v1`
    const auth = {
      apiKey: {
        name: 'OpenCode Zen anonymous lane',
        resolve: async () => ({ auth: { apiKey: ANONYMOUS_KEY } }),
      },
    }
    this.#provider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_ID,
      baseUrl,
      auth,
      models: [],
      api: openaiCompletions,
    })
    this.#responsesProvider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_ID,
      baseUrl,
      auth,
      models: [],
      api: openaiResponses,
    })
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_ID }
  }

  /**
   * dsh-llm calls this unconditionally at registration (index.js:1208).
   * undefined = the host default retry policy, matching sidecar behavior.
   */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  /** No image pricing for the free Zen lane. */
  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** The input kinds DSH is told about for one model (isVisionModel). */
  #inputModalities(model: string): string[] {
    return isVisionModel(model, this.#catalog.modalities?.(model)) ? ['text', 'image'] : ['text']
  }

  /**
   * Advisory catalog for the DSH model picker (deduped; dsh-llm rejects
   * duplicates). Async on purpose (issue #45): the host awaits this call and
   * caches its answer per host generation, so the first read waits —
   * bounded, inside the catalog — for the live Zen fetch instead of handing
   * the host the staticFreeModels bootstrap list it would then keep showing.
   */
  async listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string; inputModalities: string[] }>> {
    await this.#catalog.warm?.()
    const seen = new Set<string>()
    const models: Array<{ provider: string; id: string; name: string; inputModalities: string[] }> = []
    for (const id of this.#catalog.list()) {
      if (seen.has(id)) continue
      seen.add(id)
      models.push({ provider, id, name: id, inputModalities: this.#inputModalities(id) })
    }
    return models
  }

  resolveModel(provider: string, model: string): {
    provider: string
    id: string
    name: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
    reasoning?: { efforts: ZenReasoningEffort[] }
  } {
    const resolved: ReturnType<ZenAdapter['resolveModel']> = {
      provider,
      id: model,
      name: model,
      inputModalities: this.#inputModalities(model),
      context: { contextWindow: contextWindowFor(this.#catalog.limits?.(model)) },
      defaultMaxTokens: defaultMaxTokensFor(this.#catalog.limits?.(model)),
    }
    // The thinking-level picker: dsh-llm validates every selected id against
    // this list and echoes the choice back on GenerateOptions.reasoningEffort.
    const declaredEfforts = reasoningEfforts(this.#catalog.reasoningCapability(model))
    const efforts = isResponsesModel(model) ? declaredEfforts?.filter((effort) => effort.id !== 'off') : declaredEfforts
    if (efforts) resolved.reasoning = { efforts }
    return resolved
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

  /**
   * Recover once from a reasoning-only output limit on models that offer Off.
   * Keep the first attempt's reasoning visible, but withhold its terminal
   * chunks until recovery finishes. Answer/tool events forbid replay; retry
   * blocks get fresh indices and the final usage includes both requests.
   */
  async *stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const selectedEffort = options.reasoningEffort ?? options.reasoning
    const canDisableThinking = selectedEffort !== 'off' && selectedEffort !== 'none'
      && this.resolveModel(options.provider, options.model).reasoning?.efforts.some((effort) => effort.id === 'off') === true
    let request = options
    let indexOffset = 0
    let nextIndex = 0
    let priorUsage: Extract<HarnessChunk, { type: 'usage' }>['usage'] | undefined

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let sawReasoning = false
      let sawAnswerOrTool = false
      let usage: Extract<HarnessChunk, { type: 'usage' }> | undefined
      let finish: Extract<HarnessChunk, { type: 'finish' }> | undefined

      for await (const chunk of this.#streamAttempt(request, (message) => {
        for (const block of message.content) {
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) sawReasoning = true
          if (block.type !== 'thinking' && (block.type !== 'text' || (typeof block.text === 'string' && block.text.length > 0))) sawAnswerOrTool = true
        }
      })) {
        if (chunk.type === 'usage') {
          usage = chunk
          continue
        }
        if (chunk.type === 'finish') {
          finish = chunk
          continue
        }
        if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) sawReasoning = true
        if (chunk.type === 'text-delta' && chunk.text.length > 0) sawAnswerOrTool = true
        if ((chunk.type === 'block-start' && chunk.blockType === 'tool-call') || chunk.type === 'tool-call-delta') sawAnswerOrTool = true
        if (chunk.type === 'block-end') {
          if (chunk.block.type === 'reasoning' && chunk.block.text.length > 0) sawReasoning = true
          if (chunk.block.type === 'tool-call' || (chunk.block.type === 'text' && chunk.block.text.length > 0)) sawAnswerOrTool = true
        }
        if (typeof chunk.index === 'number') nextIndex = Math.max(nextIndex, chunk.index + indexOffset + 1)
        yield indexOffset === 0 ? chunk : { ...chunk, index: chunk.index + indexOffset }
      }

      const recover = attempt === 0 && canDisableThinking && sawReasoning && !sawAnswerOrTool
        && finish?.reason.kind === 'max-tokens' && !options.signal?.aborted
      if (recover) {
        priorUsage = usage?.usage
        indexOffset = nextIndex
        request = { ...options, reasoningEffort: 'off', reasoning: 'off' }
        continue
      }
      if (usage || priorUsage) {
        const current = usage?.usage
        const cacheReadTokens = (priorUsage?.cacheReadTokens ?? 0) + (current?.cacheReadTokens ?? 0)
        const cacheWriteTokens = (priorUsage?.cacheWriteTokens ?? 0) + (current?.cacheWriteTokens ?? 0)
        yield priorUsage === undefined ? usage! : {
          type: 'usage',
          usage: {
            inputTokens: priorUsage.inputTokens + (current?.inputTokens ?? 0),
            outputTokens: priorUsage.outputTokens + (current?.outputTokens ?? 0),
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
          },
        }
      }
      if (finish) yield finish
      return
    }
  }

  /** Stream one attempt from the Zen anonymous lane.
   *
   * IP-7 rotate loop (docs/ip-pool.md §3.4 / §8.1): a stream that dies
   * BEFORE any content landed restarts on a fresh exit — the pool's health
   * marks already degraded the failed exit, so the restarted pick routes
   * elsewhere, and the host's retry budget never sees the intermediate
   * error. Once ANY content event has flowed, rotation stops (§3.4: a
   * partially delivered stream is never replayed). No pool running (or the
   * failure is not exit-shaped) = the original stream surface untouched.
   */
  async *#streamAttempt(options: HarnessGenerateOptions, onTerminal?: (message: PiDoneMessage) => void): AsyncGenerator<HarnessChunk> {
    const context = await toPiContext(options)
    const ids = deriveRequestIDs(options.messages)
    const model = toPiModel(options.model, this.#catalog.reasoningCapability(options.model)?.reasoning === true, this.#catalog.limits?.(options.model), this.#catalog.modalities?.(options.model))
    // IP-pool routing context (docs/ip-pool.md 3.3): pi-ai builds the request
    // body and dispatches it on separate layers with no channel for "which
    // model is this fetch for", so the per-request context rides AsyncLocalStorage.
    const contextStore: RoutingContext = { model: options.model, session: ids.session }
    const self = this
    const MAX_ROTATES = 3
    // Watchdog windows (live-observed 2026-09-07): the OpenAI SDK timeout
    // only covers time-to-response-headers — once headers arrive it clears
    // its timer and NOTHING on any layer owns body silence. FIRST_EVENT: no
    // pi-ai event at all (not even `start`, which only arrives after
    // response headers). BODY_IDLE: content flowing, then a long gap (LLM
    // streams may pace slowly, but minutes of nothing mid-stream is a dead
    // tunnel, not pacing). The race fires the watchdog INTO the pending
    // next() — a background return() could never cancel one (it queues
    // behind the pending request), so timeout-promise racing is the only
    // mechanism that actually interrupts a hung stream.
    const firstEventMs = this.#firstEventMs
    // Responses models (muse-spark-*) get RESPONSES_BODY_IDLE_MS (see the
    // constant); chat models keep the live-tuned default. Derived from
    // model.api — the same routing flag that picked the provider — so the
    // watchdog and the wire layer can never disagree.
    const bodyIdleMs = model.api === 'openai-responses'
      ? Math.max(this.#bodyIdleMs, this.#responsesBodyIdleMs)
      : this.#bodyIdleMs
    const rotateStory: string[] = []
    for (let attempt = 0; ; attempt += 1) {
      const events = routingContext.run(contextStore, () =>
        self.#eventsFor(options, context, ids, model),
      ) as AsyncIterable<PiEvent>
      let deliveredContent = false
      let preContentFailure: { message: string } | null = null
      const buffered: PiEvent[] = []
      const source = events[Symbol.asyncIterator]()
      // Peek events until the stream proves itself one way or the other:
      // content -> flush and stream through; error before content -> maybe
      // rotate. Content flushes IMMEDIATELY (only the pre-content events are
      // buffered): holding every token hostage to a failure that may never
      // come would also kill streaming for the UI.
      let flushed = false
      let sawAnyEvent = false
      let lastEventAt = Date.now()
      // One deadline timer at a time, re-armed per pull (a timer per pull
      // would accumulate thousands over a long token stream). While no event
      // has arrived at all, the FIRST-EVENT window applies (stricter — the
      // tunnel/connect stage should answer within seconds); once ANY event
      // has landed (start, or content directly), the looser BODY-IDLE
      // window applies so slow TTFT pacing on healthy exits is not misread
      // as a dead tunnel.
      let deadlineTimer: NodeJS.Timeout | undefined
      const raceDeadline = (): Promise<never> => {
        clearTimeout(deadlineTimer)
        const idleWindow = sawAnyEvent ? bodyIdleMs : firstEventMs
        const message = sawAnyEvent ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE
        const ms = Math.max(0, idleWindow - (Date.now() - lastEventAt))
        return new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new Error(message)), ms)
          deadlineTimer.unref?.()
        })
      }
      // The pump the consumer sees after flush: buffered events first, then
      // the live rest of the stream, through ONE toStreamChunks pass so the
      // done/error terminator is never missing (the pre-fix flush fed it a
      // terminator-less slice and threw "ended without done/error").
      const pumpLive = async function* (): AsyncGenerator<PiEvent> {
        for (const e of buffered) yield e
        for (;;) {
          let next: IteratorResult<PiEvent>
          try {
            next = await Promise.race([source.next(), raceDeadline()])
          } catch (err) {
            // watchdog or foreign teardown tore the stream down mid-content:
            // the consumer already saw partial content, so surface the
            // terminal error honestly and stop — never a hang, never a replay
            yield terminalErrorEvent(err instanceof Error ? err.message : String(err), model)
            return
          }
          if (next.done) {
            clearTimeout(deadlineTimer)
            return
          }
          const event = next.value as PiEvent
          lastEventAt = Date.now()
          if (event.type === 'error' || event.type === 'done') {
            clearTimeout(deadlineTimer)
            onTerminal?.(event.type === 'done' ? event.message : event.error)
            yield event
            return
          }
          yield event
        }
      }
      // Peek phase (pre-content): pull with the first-event deadline armed.
      for (;;) {
        let next: IteratorResult<PiEvent>
        try {
          next = await Promise.race([source.next(), raceDeadline()])
        } catch (err) {
          // pre-content silence: synthesize the terminal error pi-ai never
          // delivered so the rotate decision sees a transport failure
          preContentFailure = { message: err instanceof Error ? err.message : String(err) }
          buffered.push(terminalErrorEvent(preContentFailure.message, model))
          break
        }
        if (next.done) break
        const event = next.value as PiEvent
        lastEventAt = Date.now()
        sawAnyEvent = true
        if (event.type === 'error') {
          onTerminal?.(event.error)
          preContentFailure = { message: event.error.errorMessage ?? 'pi-ai stream error' }
          // the event still flows to the consumer unless we rotate
          buffered.push(event)
          break
        }
        if (event.type === 'done') {
          onTerminal?.(event.message)
          // pi-ai can also deliver the failure on done (stopReason: error)
          if (event.message.stopReason === 'error' && !deliveredContent) {
            preContentFailure = { message: event.message.errorMessage ?? 'pi-ai stream error' }
          }
          buffered.push(event)
          break
        }
        buffered.push(event)
        if (event.type !== 'start') deliveredContent = true
        if (deliveredContent) {
          // first content event: flush everything buffered and go live
          flushed = true
          break
        }
      }
      // peek phase over: whatever path exited the loop, this attempt's
      // deadline timer is spent (pumpLive re-arms its own per pull)
      clearTimeout(deadlineTimer)
      if (preContentFailure === null && deliveredContent) {
        yield* toStreamChunks(pumpLive(), model.contextWindow)
        return
      }
      if (preContentFailure === null && !deliveredContent) {
        // stream ended cleanly with no content and no error: pass through
        // (pi-ai's empty-response classification owns this case)
        yield* toStreamChunks((async function* pumped() { for (const e of buffered) yield e })(), model.contextWindow)
        return
      }
      // Exit-shaped failure before content: ask the pool whether rotating is
      // worth another attempt; otherwise surface the buffered events as-is.
      const failureMessage = (preContentFailure as { message: string }).message
      const failure = classifyStreamFailure(failureMessage)
      const deterministic = isRegionBlocked(failureMessage)
      const rotate = failure !== null
        && attempt < MAX_ROTATES
        && shouldRotate(failure, options.model, ids.session, attempt + 1, deterministic)
      rotateStory.push(`#${attempt + 1} ${failure ?? 'unknown'}: ${failureMessage.slice(0, 80)}`)
      if (!rotate) {
        // last resort: rewrite the terminal error to tell the whole story
        // (the user saw minutes of silence — the surfaced error must say
        // what was tried, not just the last attempt's failure)
        for (let i = 0; i < buffered.length; i += 1) {
          const e = buffered[i] as PiEvent & { error?: { errorMessage?: string }; message?: { errorMessage?: string; stopReason?: string } }
          if (e.type === 'error' && e.error) {
            e.error.errorMessage = rotateStory.length > 1
              ? `${e.error.errorMessage} (opencode2dsh 轮换 ${rotateStory.length - 1} 次后放弃: ${rotateStory.join(' -> ')})`
              : e.error.errorMessage
            break
          }
          if (e.type === 'done' && e.message?.stopReason === 'error') {
            e.message.errorMessage = rotateStory.length > 1
              ? `${e.message.errorMessage} (opencode2dsh 轮换 ${rotateStory.length - 1} 次后放弃: ${rotateStory.join(' -> ')})`
              : e.message.errorMessage!
            break
          }
        }
        yield* toStreamChunks((async function* pumped() { for (const e of buffered) yield e })(), model.contextWindow)
        return
      }
      // rotate: loop re-runs #eventsFor inside the same ALS store; the pool
      // has already degraded the failed exit, so pick lands elsewhere.
    }
  }

  #eventsFor(
    options: HarnessGenerateOptions,
    context: PiContext,
    ids: ReturnType<typeof deriveRequestIDs>,
    model: ReturnType<typeof toPiModel>,
  ): unknown {
    // Structural boundary: PiContext (own types, unit-tested) -> pi-ai Context.
    const isResponses = model.api === 'openai-responses'
    const requestedReasoning = typeof options.reasoningEffort === 'string'
      ? options.reasoningEffort
      : typeof options.reasoning === 'string'
        ? options.reasoning
        : undefined
    const responseReasoning = isResponses ? normalizeResponsesEffort(requestedReasoning) : undefined
    const effortWire = isResponses ? undefined : reasoningEffortWire(options.reasoningEffort)

    // onPayload injects the free-lane gate tools (adapter/messages.ts) into the
    // serialized body right before dispatch — plain-chat contexts carry no
    // tools and the anonymous lane 403s every body without bash+read. The same
    // seam carries the selected reasoning effort: pi-ai has no option with the
    // wire semantics this lane needs (selected off must SEND `none`, not omit),
    // so the effort rides the payload rewrite instead.
    const onPayload =
      isResponses
        ? (payload: unknown): unknown => {
            const normalized = normalizeResponsesPayload(payload, responseReasoning)
            return ensureResponsesFreeLaneShape(normalized ?? payload) ?? normalized
          }
        : effortWire === undefined
        ? ensureFreeLaneShape
        : (payload: unknown): unknown => {
            const shaped = ensureFreeLaneShape(payload)
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return shaped
            return { ...((shaped ?? payload) as Record<string, unknown>), reasoning_effort: effortWire }
          }
    // Responses-only models (muse-spark-*) must hit /responses, not /chat/completions.
    const provider = isResponsesModel(model.id) && this.#responsesProvider
      ? this.#responsesProvider
      : this.#provider
    return provider.streamSimple(model, context as unknown as Context, {
      apiKey: ANONYMOUS_KEY,
      sessionId: ids.session,
      headers: disguiseHeaders(ids),
      onPayload,
      signal: options.signal,
      maxRetries: 0,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      ...(responseReasoning ? { reasoning: responseReasoning } : {}),
    })
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
