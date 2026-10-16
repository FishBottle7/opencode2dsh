import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { deriveRequestIDs, disguiseHeaders, opencodeUserAgent } from './ids.ts'
import { FREE_LANE_GATE_TOOL_NAMES, freeLaneGateTool } from './messages.ts'
import { apiForModel } from './routing.ts'

/**
 * Port of agent/internal/catalog (opencode2api models.go + model_metadata.go,
 * trimmed to the single anonymous Zen lane) plus the S3 static fallback:
 *
 *   S1  GET {zen}/v1/models            live catalog (in-sale ids, free or paid)
 *   S2  GET https://models.dev/api.json  pricing metadata -> free decision
 *   S3  compile-time verified ids       last-resort bootstrap list
 *
 * /v1/models-equivalent exposure = S1 ∩ S2-allowed (or S3 while S1 is pending).
 */

export const ZEN_BASE_URL = 'https://opencode.ai/zen'

/**
 * Free-lane blocklist (issue #56 live matrix, 2026-10-10): models the live
 * chat lane has refused to serve from at least one vantage point. The Zen
 * catalog still lists them, so S1 alone would expose ids that are dead from
 * the reporter's network — one exclusion reason per model at the time of
 * writing:
 *   exo-free                             410 ModelDeprecated (upstream delisted)
 *   jev-1.13-free                        400 ModelProtocolUnsupported (SystemOne-only)
 *   ling-3.0-flash-fin-free              400 "Model is unavailable" (upstream-side)
 *   muse-spark-1.*-contributor-free      403 RegionError, chat and responses alike
 *
 * The blocklist is a VANTAGE-POINT claim, not a law of physics: issue #56's
 * matrix was measured from one egress, and the same ids answer HTTP 200 from
 * other networks (2026-10-16, Taiwan egress: both muse ids stream 200 on
 * /zen/v1/responses with the faithful adapter shape). `FREE_LANE_BLOCKLIST`
 * below therefore names only the models that can NEVER serve — a protocol
 * mismatch no amount of retrying fixes. Everything else moves to
 * `FREE_LANE_PROBE_SET` and is re-verified per egress by the catalog's
 * adaptive probe (see ModelCatalog.#probeRound): a model that answers
 * 200/429 is exposed, one that answers the recorded refusal status is kept
 * hidden, and a probe that errors is left hidden until the next round.
 */
export const FREE_LANE_BLOCKLIST: ReadonlySet<string> = new Set([
  'jev-1.13-free', // 400 ModelProtocolUnsupported on chat AND responses — SystemOne-only
])

/** Blocklist candidates re-checked per egress by the adaptive probe.
 * Seeded from the issue #56 matrix minus the never-serve protocol id. */
export const FREE_LANE_PROBE_SET: ReadonlySet<string> = new Set([
  'exo-free',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
])

/** Probe verdicts per model, surviving one catalog instance (per host boot). */
export type ProbeVerdict = 'pass' | 'refused' | 'error'

/** Probe cadence: first round right after warm()'s window, then every 30min. */
export const PROBE_INTERVAL_MS = 30 * 60 * 1000

/** Previously verified models still in the public roster (checked 2026-10-13).
 * New ids arrive through the live directory, which republishes the picker. */
export const staticFreeModels: string[] = [
  'big-pickle', // verified 2026-08-28: anonymous chat 200 (non-stream + stream)
  'mimo-v2.6-flash-free', // verified 2026-10-03: anonymous chat 200 (stream, adapter path); successor of mimo-v2.5-free
  'nemotron-3.5-lightning-free', // verified 2026-09-01: anonymous chat 200
  'muse-spark-1.2-contributor-free', // verified 2026-10-16: /zen/v1/responses 200 (Taiwan egress; see FREE_LANE_PROBE_SET)
  'muse-spark-1.3-contributor-free', // verified 2026-10-16: /zen/v1/responses 200 (Taiwan egress; see FREE_LANE_PROBE_SET)
]

/** Exposed by /v1/models but without a verified anonymous chat yet. */
export const staticFreeCandidates: string[] = [
  // 'deepseek-v4-flash-free',          // models.dev deprecated; 2026-09-01: upstream 400 "Model is unavailable"
  // 'laguna-s-2.1-free',                // models.dev deprecated; 2026-09-01: upstream 503 (intermittent, failed twice)
  // 'hy3-free',                        // models.dev deprecated; 2026-09-01: delisted from /v1/models, upstream 401 "not supported"
]

export function isFreeModel(model: string): boolean {
  return model.toLowerCase().includes('free')
}

export interface AnonymousDecision {
  allowed: boolean
  source: string
  known: boolean
}

interface ModelPrice {
  input?: number
  output?: number
  deprecated: boolean
  /** models.dev `reasoning` flag: the model thinks by default. */
  reasoning?: boolean
  /** models.dev `reasoning_options` effort values the model declares (e.g. ["low","high"]). */
  effortValues?: string[]
  /** models.dev `limit.context`: the model's real context window. */
  contextWindow?: number
  /** models.dev `limit.output`: the model's real max output tokens. */
  maxOutput?: number
  /** models.dev `modalities.input`: the input kinds the model accepts
   *  (["text","image","video",…]). Absent when the metadata declares none, so
   *  the adapter keeps its own vision pattern for such a model. */
  modalities?: string[]
}

/** Decide (model_metadata.go Decide, ported with the deprecation fix).
 *
 * The upstream short-circuits on isFreeModel before consulting metadata, so a
 * delisted-but-still-cataloged id like deepseek-v4-flash-free stays exposed
 * forever. Here the order is: a ready metadata verdict (including deprecated)
 * always wins; the name fallback only fires when metadata cannot speak
 * (pending or model missing) — its original documented intent (design.md 4.2).
 */
export function decide(model: string, prices: Map<string, ModelPrice>, ready: boolean): AnonymousDecision {
  const nameFree = isFreeModel(model)
  const fallback = (source: string): AnonymousDecision => {
    if (nameFree) return { allowed: true, source: 'name_free', known: false }
    return { allowed: false, source, known: false }
  }
  if (!ready || prices.size === 0) return fallback('metadata_pending')
  const price = prices.get(model)
  if (!price) return fallback('metadata_model_missing')
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true }
  const metadataFree = price.input === 0 && price.output === 0
  if (metadataFree) {
    return { allowed: true, source: nameFree ? 'name_and_metadata_free' : 'metadata_free', known: true }
  }
  if (price.input === undefined || price.output === undefined) {
    return { allowed: false, source: 'metadata_cost_unknown', known: false }
  }
  return { allowed: false, source: 'metadata_paid', known: true }
}

/**
 * models.dev fields the plugin knowingly overrides (issue #56 metadata note):
 * the feed declares `mimo-v2.6-flash-free` with `limit.context: 200000`, while
 * the MiMo V2.6 Flash model card and the official OpenCode CLI config use
 * 1048576. Checked BEFORE the metadata in `limits()`/`reasoningCapability()`/
 * `modalities()` — a fixed feed deletes its entry here.
 */
const LOCAL_MODEL_OVERRIDES: Readonly<Record<string, Partial<ModelPrice>>> = {
  'mimo-v2.6-flash-free': { contextWindow: 1048576 },
}

/** Shallow per-field override: declared fields win, the rest pass through. */
function applyLocalOverride(model: string, price: ModelPrice | undefined): ModelPrice | undefined {
  const override = LOCAL_MODEL_OVERRIDES[model]
  if (override === undefined) return price
  return { ...price, ...override } as ModelPrice
}

/**
 * decodeModelsDev (model_metadata.go:253-335): use the OpenCode provider
 * section of models.dev, preferring the exact `opencode`/`opencode-zen` key.
 */
export function decodeModelsDev(data: unknown): Map<string, ModelPrice> {
  const result = new Map<string, ModelPrice>()
  if (!data || typeof data !== 'object') return result
  const providers = data as Record<string, { models?: Record<string, Record<string, unknown>>; id?: unknown; name?: unknown }>
  const keys = Object.keys(providers)
  const rank = (key: string): number => {
    const lower = key.toLowerCase()
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0
    if (lower.includes('opencode')) return 1
    return 2
  }
  keys.sort((left, right) => {
    const leftRank = rank(left)
    const rightRank = rank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.localeCompare(right)
  })
  for (const key of keys) {
    if (rank(key) > 1) continue
    const provider = providers[key]
    if (!provider || typeof provider !== 'object') continue
    if (rank(key) === 1) {
      const identity = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim()
      if (!identity.includes('opencode')) continue
    }
    const models = provider.models
    if (!models || typeof models !== 'object') continue
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey
      const cost = (raw.cost ?? {}) as Record<string, unknown>
      const limit = (raw.limit ?? {}) as Record<string, unknown>
      const modalities = (raw.modalities ?? {}) as Record<string, unknown>
      const num = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined
      const contextWindow = num(limit.context)
      const maxOutput = num(limit.output)
      const inputModalities = decodeModalities(modalities.input)
      result.set(modelId, {
        input: num(cost.input),
        output: num(cost.output),
        deprecated: metadataDeprecated(raw),
        reasoning: raw.reasoning === true,
        ...decodeEffortValues(raw.reasoning_options),
        // Omitted when absent so caches written before limits existed stay valid.
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
        // Same for modalities: a cache written before this field existed carries
        // none, and the adapter then keeps its built-in vision pattern.
        ...(inputModalities !== undefined ? { modalities: inputModalities } : {}),
      })
    }
    if (result.size > 0) return result
  }
  return result
}

function metadataDeprecated(model: Record<string, unknown>): boolean {
  if (model.deprecated === true) return true
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase()
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true
  return model.deprecated_at != null || model.retirement_date != null
}

/**
 * models.dev `reasoning_options` (live shape 2026-09-18): an array of
 * `{type: "effort", values: [...]} | {type: "toggle"} | {type: "budget_tokens", ...}`
 * entries, absent when the model never thinks. Only the `effort` entries carry
 * selectable levels; `toggle`/`budget_tokens` map to "reasoning, no declared
 * ladder" and are reported as an empty array. Omitted entirely when the field
 * is absent so cached pre-reasoning metadata stays structurally valid.
 */
function decodeEffortValues(raw: unknown): { effortValues?: string[] } {
  if (!Array.isArray(raw)) return {}
  const values: string[] = []
  for (const option of raw) {
    if (typeof option !== 'object' || option === null) continue
    const entry = option as { type?: unknown; values?: unknown }
    if (entry.type !== 'effort' || !Array.isArray(entry.values)) continue
    for (const value of entry.values) {
      if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value)
    }
  }
  return values.length > 0 ? { effortValues: values } : { effortValues: [] }
}

/**
 * models.dev `modalities.input` (live shape 2026-09-28): an array of lowercase
 * kind strings such as ["text","image","video","pdf","audio"]. Only a non-empty
 * array of non-empty strings is kept, so a malformed or absent field speaks for
 * nothing and the adapter keeps its own vision pattern (isVisionModel).
 */
function decodeModalities(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const kinds: string[] = []
  for (const kind of input) {
    if (typeof kind === 'string' && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds.length > 0 ? kinds : undefined
}

export interface CatalogSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'error'
  total: number
  exposed: number
  lastRefresh?: string
}

export interface CatalogOptions {
  /** S1 refresh cadence; the agent config uses models.refresh_seconds. */
  refreshSeconds?: number
  /** Where the models.dev cache lives (agent data dir). */
  cachePath?: string
  /** Upstream override for tests. */
  zenBaseUrl?: string
  /** models.dev override for tests. */
  metadataUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Observability hook: fired after every refresh round (start + interval). */
  onRefresh?: (status: CatalogSnapshot, lastError: string) => void
  /** Delay between startup retries while the live catalog is empty (default 15s). */
  startupRetryMs?: number
  /** Disable the adaptive probe round (tests; default runs it). */
  probeDisabled?: boolean
  /** Probe cadence override in ms (tests use a small value). */
  probeIntervalMs?: number
  /** Probe implementation override (tests inject a canned verdict source). */
  probeImpl?: (model: string, api: 'openai-responses' | 'openai-completions') => Promise<ProbeVerdict>
}

const METADATA_REFRESH_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

/**
 * Live model directory with the S1/S2/S3 fallback chain and the timer-driven
 * refresh loop. All state is in-memory; only the models.dev cache persists.
 *
 * Decision chain (design.md 4.1/4.2, with the deprecation-first fix):
 *   1. ready metadata verdict — deprecated/paid deny, free cost allows; a
 *      "free" name never overrides a negative metadata verdict
 *   2. metadata cannot speak (pending/missing) — name fallback, or the
 *      compile-time verified S3 list for known-good ids
 */
export class ModelCatalog {
  #zen: Set<string> = new Set()
  #updatedAt = 0
  #prices: Map<string, ModelPrice> = new Map()
  #pricesReady = false
  #lastError = ''
  #zenFailed = false
  #refreshSeconds: number
  #cachePath?: string
  #zenBaseUrl: string
  #metadataUrl: string
  #fetch: typeof fetch
  #now: () => number
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #onRefresh?: (status: CatalogSnapshot, lastError: string) => void
  #startupRetryMs: number
  /** In-flight refresh round (deduped so warm() shares start()'s first fetch). */
  #refreshing: Promise<void> | null = null
  #probeDisabled: boolean
  #probeIntervalMs: number
  #probeImpl: (model: string, api: 'openai-responses' | 'openai-completions') => Promise<ProbeVerdict>
  /** Adaptive-probe state: pass = exposed, refused/error = hidden this boot. */
  #probeVerdicts: Map<string, ProbeVerdict> = new Map()
  #probeTimer: NodeJS.Timeout | null = null
  #probing: Promise<void> | null = null

  constructor(options: CatalogOptions = {}) {
    this.#refreshSeconds = options.refreshSeconds ?? 300
    this.#cachePath = options.cachePath
    this.#zenBaseUrl = options.zenBaseUrl ?? ZEN_BASE_URL
    this.#metadataUrl = options.metadataUrl ?? 'https://models.dev/api.json'
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#onRefresh = options.onRefresh
    this.#startupRetryMs = options.startupRetryMs ?? 15_000
    this.#probeDisabled = options.probeDisabled ?? false
    this.#probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS
    this.#probeImpl = options.probeImpl ?? defaultProbeImpl(this.#zenBaseUrl, this.#fetch)
  }

  /**
   * Start the refresh loop: immediate S1+S2, fast retries while the live
   * catalog is still empty (the first fetch often races the machine's network
   * coming up — VPN/TUN reconnect, DNS), then the normal cadence (S2 24h).
   */
  async start(): Promise<void> {
    await this.refreshOnce()
    let attempts = 0
    while (this.#zen.size === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1
      await new Promise((resolve) => setTimeout(resolve, this.#startupRetryMs))
      if (this.#stopped) return
      await this.refreshOnce()
    }
    if (this.#stopped) return
    this.#timer = setInterval(() => {
      void this.refreshOnce()
    }, this.#refreshSeconds * 1000)
    this.#timer.unref?.()
    // First adaptive-probe round: after warm()'s 4s window so a real catalog
    // is in place (probe results decide picker visibility for the probe set).
    if (!this.#probeDisabled) {
      const probeTimer = setTimeout(() => void this.probeOnce(), 5_000)
      probeTimer.unref?.()
    }
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer)
      this.#probeTimer = null
    }
  }

  /** One refresh round, deduped while in flight: a concurrent caller (warm()
   *  racing start()'s first round, or the interval timer) joins the running
   *  round instead of firing a parallel fetch of the same endpoints. */
  refreshOnce(): Promise<void> {
    if (this.#refreshing === null) {
      this.#refreshing = this.#refreshRound().finally(() => {
        this.#refreshing = null
      })
    }
    return this.#refreshing
  }

  async #refreshRound(): Promise<void> {
    await Promise.allSettled([this.refreshZen(), this.refreshMetadata()])
    if (this.#onRefresh) {
      try {
        this.#onRefresh(this.snapshot(), this.#lastError)
      } catch {
        // observers must never break the refresh loop
      }
    }
  }

  async refreshZen(): Promise<void> {
    try {
      const ids = await fetchZenModels(this.#zenBaseUrl, this.#fetch, opencodeUserAgent())
      this.#zen = new Set(ids)
      this.#zenFailed = false
      this.#updatedAt = this.#now()
      this.#lastError = ''
    } catch (err) {
      this.#zenFailed = true
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  async refreshMetadata(): Promise<void> {
    // Stale-while-revalidate (issue #55): on a cold boot a slow-but-healthy
    // models.dev (23s observed) outlives warm()'s window and never touches the
    // failure fallback below — capability reads (reasoning efforts, limits,
    // modalities) then see an empty map and the host rejects explicit efforts
    // with UNSUPPORTED_REASONING_EFFORT. Load a fresh disk cache as the
    // baseline FIRST, then let the online fetch replace it whenever it lands.
    // Only the refresh-triggered path does this; start()'s first round is
    // exactly that path, so cold boots are covered.
    if (this.#cachePath && !this.#pricesReady) {
      const cached = await loadMetadataCache(this.#cachePath, this.#now).catch(() => null)
      if (cached && cached.size > 0) {
        this.#prices = cached
        this.#pricesReady = true
      }
    }
    try {
      const response = await withTimeout(this.#fetch(this.#metadataUrl, { headers: { accept: 'application/json' } }))
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
      const data = (await response.json()) as unknown
      const prices = decodeModelsDev(data)
      if (prices.size === 0) throw new Error('models.dev contains no OpenCode model metadata')
      this.#prices = prices
      this.#pricesReady = true
      if (this.#cachePath) await saveMetadataCache(this.#cachePath, prices, this.#now())
    } catch (err) {
      // Network failure with a cached copy is not fatal: load the cache.
      if (this.#cachePath && !this.#pricesReady) {
        const cached = await loadMetadataCache(this.#cachePath, this.#now).catch(() => null)
        if (cached && cached.size > 0) {
          this.#prices = cached
          this.#pricesReady = true
          return
        }
      }
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * Resolve once the first live fetch has settled, so a model-list read is
   * never answered from the bootstrap list (issue #45: the host caches the
   * snapshot its picker took at adapter registration, and the re-read
   * triggers are topology/settings events a warming catalog never fires —
   * so the 7-id staticFreeModels roster could stick for the whole host
   * generation). Bounded: a dead network still answers promptly with the
   * static list. Joins start()'s in-flight round when one exists (no
   * duplicate fetch), or triggers a round of its own when none does.
   */
  async warm(ms = 4_000): Promise<void> {
    if (this.#zen.size > 0 || this.#stopped) return
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
    try {
      await Promise.race([this.refreshOnce().catch(() => {}), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  decision(model: string): AnonymousDecision {
    // Issue #56: the live chat lane can never serve a blocklisted id (410
    // delisted / 400 unavailable / 403 region) — deny before any metadata or
    // S3 vouch, so a stale cache or the bootstrap list cannot resurrect it.
    if (FREE_LANE_BLOCKLIST.has(model)) return { allowed: false, source: 'local_blocklist', known: true }
    // Vantage-point blocklist entries (FREE_LANE_PROBE_SET): hidden until this
    // host's own probe answers pass. Before the first probe round completes
    // the seeded default is 'refused' (issue #56's verdict) — conservative,
    // never worse than the shipped blocklist.
    if (FREE_LANE_PROBE_SET.has(model) && this.#probeVerdicts.get(model) !== 'pass') {
      return { allowed: false, source: 'probe_pending', known: false }
    }
    const metadata = decide(model, this.#prices, this.#pricesReady)
    // The S3 vouch only covers ids metadata cannot speak for. A metadata
    // verdict of deprecated is Known, but S3 entries are compile-time verified
    // against the live lane, so an S3 id stays vouched even when stale
    // metadata claims deprecation (hy3-free case: works after models.dev
    // flags it, dies only when it leaves the Zen catalog).
    if (!metadata.allowed && metadata.source === 'metadata_deprecated' && staticFreeModels.includes(model)) {
      return { allowed: true, source: 'static_verified', known: false }
    }
    if (!metadata.allowed && !metadata.known && staticFreeModels.includes(model)) {
      return { allowed: true, source: 'static_verified', known: false }
    }
    return metadata
  }

  /** ids exposed to DSH: S1 ∩ allowed, or S3 while the live catalog is pending. */
  list(): string[] {
    if (this.#zen.size === 0) return this.#zenFailed ? [] : staticFreeModels.filter((model) => this.decision(model).allowed)
    const out: string[] = []
    for (const model of this.#zen) {
      if (this.decision(model).allowed) out.push(model)
    }
    return out.sort()
  }

  /**
   * Adaptive vantage-point probe (2026-10-16): models the issue #56 live
   * matrix refused from one egress answer 200 from others; this host's own
   * exit is the only verdict that matters, so probe those ids directly and
   * expose them when the lane answers 200/429.
   *
   * One round: probe every FREE_LANE_PROBE_SET id that is still in the live
   * Zen catalog, store the verdict, schedule the next round. A probe uses a
   * 1-token streaming request on the lane the model actually speaks
   * (apiForModel: muse → Responses, everything else → chat), with the
   * adapter's canonical session id and disguise headers so a pass here is
   * exactly what a real turn would send. Verdicts are per boot; refused
   * models are retried on the next round, so an upstream unblock or a
   * threshold flip is picked up without a host restart.
   */
  async #probeRound(): Promise<void> {
    if (this.#stopped) return
    const ids = [...FREE_LANE_PROBE_SET].filter((id) => this.#zen.has(id))
    if (ids.length === 0) return
    const nextRound = () => {
      if (this.#stopped || this.#probeDisabled) return
      this.#probeTimer = setTimeout(() => void this.probeOnce(), this.#probeIntervalMs)
      this.#probeTimer.unref?.()
    }
    for (const model of ids) {
      const api = apiForModel(model)
      const verdict = await this.#probeImpl(model, api).catch(() => 'error' as ProbeVerdict)
      this.#probeVerdicts.set(model, verdict)
    }
    this.#onRefresh?.(this.snapshot(), this.#lastError)
    nextRound()
  }

  /** Public entry: run one probe round, deduped like refreshOnce(). Manual
   * calls always run (tests drive the round this way); probeDisabled only
   * suppresses the scheduled timers so a disabled catalog never probes on
   * its own. */
  probeOnce(): Promise<void> {
    if (this.#probing === null) {
      this.#probing = this.#probeRound().finally(() => {
        this.#probing = null
      })
    }
    return this.#probing
  }

  /** Current adaptive-probe verdicts (healthz/observability). */
  probeVerdicts(): Record<string, ProbeVerdict> {
    return Object.fromEntries(this.#probeVerdicts)
  }

  /**
   * models.dev declared limits for one model: `contextWindow` (limit.context)
   * and `maxOutput` (limit.output). undefined when the metadata cannot speak
   * for the model (pending, or id absent) or declares no limits — the caller
   * then keeps its own defaults.
   */
  limits(model: string): { contextWindow?: number; maxOutput?: number } | undefined {
    const price = applyLocalOverride(model, this.#prices.get(model))
    if (!price) return undefined
    if (price.contextWindow === undefined && price.maxOutput === undefined) return undefined
    return {
      ...(price.contextWindow !== undefined ? { contextWindow: price.contextWindow } : {}),
      ...(price.maxOutput !== undefined ? { maxOutput: price.maxOutput } : {}),
    }
  }

  /**
   * models.dev `modalities.input` for one model: the input kinds it accepts
   * (["text","image","video",…]). undefined when the metadata cannot speak for
   * the model (pending, or id absent) or declares no modalities — the caller
   * then keeps its own vision pattern (isVisionModel).
   */
  modalities(model: string): string[] | undefined {
    const modalities = applyLocalOverride(model, this.#prices.get(model))?.modalities
    return modalities === undefined ? undefined : [...modalities]
  }

  /**
   * models.dev reasoning capability for one model: `reasoning` flags the
   * always-think models, `effortValues` the declared selectable levels
   * (empty array = reasons but declares no ladder). undefined when the
   * metadata cannot speak for the model (pending, or id absent).
   */
  reasoningCapability(model: string): { reasoning: boolean; effortValues: string[] } | undefined {
    const price = applyLocalOverride(model, this.#prices.get(model))
    if (!price) return undefined
    return { reasoning: price.reasoning === true, effortValues: price.effortValues ?? [] }
  }

  /** healthz models block (design.md 6.1). */
  snapshot(): CatalogSnapshot {
    const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt
    const stale = this.#updatedAt !== 0 && age > 10 * 60 * 1000
    return {
      status: this.#updatedAt === 0 ? (this.#zenFailed ? 'error' : 'pending') : this.#zenFailed || stale ? 'stale' : 'ready',
      total: this.#zen.size,
      exposed: this.list().length,
      ...(this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}),
    }
  }

  get lastError(): string {
    return this.#lastError
  }
}

async function withTimeout(promise: Promise<Response>, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await promise
  } finally {
    clearTimeout(timer)
  }
}

/** S1: fetchModels (models.go:587-618) with the CLI disguise headers. */
export async function fetchZenModels(
  zenBaseUrl: string,
  fetchImpl: typeof fetch,
  userAgent: string,
): Promise<string[]> {
  const response = await withTimeout(
    fetchImpl(`${zenBaseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: {
        authorization: 'Bearer public',
        'user-agent': userAgent,
        'x-opencode-client': 'cli',
        accept: 'application/json',
      },
    }),
  )
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
  const models: string[] = []
  for (const item of payload.data ?? []) {
    if (typeof item?.id === 'string' && item.id.length > 0) models.push(item.id)
  }
  if (models.length === 0) throw new Error('models endpoint returned an empty list')
  return models
}

interface MetadataCache {
  updatedAt: number
  prices: Array<[string, ModelPrice]>
}

async function saveMetadataCache(path: string, prices: Map<string, ModelPrice>, now: number): Promise<void> {
  const cache: MetadataCache = { updatedAt: now, prices: [...prices] }
  const tmp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(cache), 'utf8')
  await rm(path, { force: true })
  await rename(tmp, path)
}

async function loadMetadataCache(path: string, now: () => number = Date.now): Promise<Map<string, ModelPrice>> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as MetadataCache
  if (now() - raw.updatedAt > 7 * METADATA_REFRESH_MS) {
    throw new Error('models.dev cache too old')
  }
  return new Map(raw.prices)
}

/** Default cache location next to the agent data dir (config.ts convention). */
export function defaultCachePath(dataDir: string): string {
  return join(dataDir, 'agent-config.json.models.dev.json')
}

// ---------------------------------------------------------------------------
// Adaptive vantage-point probe
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 15_000

/**
 * The probe speaks the same wire shape the adapter uses for a real turn:
 * canonical ses_ id + disguise headers + gate tools + streaming, 1 output
 * token. Verdict mapping mirrors the catalog philosophy (design.md): any
 * status the gate itself issues on a healthy lane (200, or the free-lane
 * throttle 429) counts as pass; the recorded refusal statuses count as
 * refused; transport/API errors count as error (hidden until next round).
 */
export function defaultProbeImpl(
  zenBaseUrl: string,
  fetchImpl: typeof fetch,
): (model: string, api: 'openai-responses' | 'openai-completions') => Promise<ProbeVerdict> {
  const base = zenBaseUrl.replace(/\/+$/, '')
  return async (model, api) => {
    const ids = deriveRequestIDs([{ role: 'user', content: 'probe' }])
    const headers: Record<string, string> = {
      ...disguiseHeaders(ids),
      'content-type': 'application/json',
    }
    let url: string
    let body: unknown
    if (api === 'openai-responses') {
      url = `${base}/v1/responses`
      body = {
        model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'probe' }] }],
        stream: true,
        max_output_tokens: 16,
        tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => ({ type: 'function', ...freeLaneGateTool(name).function })),
        tool_choice: 'auto',
      }
    } else {
      url = `${base}/v1/chat/completions`
      body = {
        model,
        messages: [{ role: 'user', content: 'probe', timestamp: 0 }],
        stream: true,
        max_tokens: 8,
        tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
        tool_choice: 'none',
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      // Drain a little of the body so the upstream sees a real stream
      // consumer, then discard: a probe must not charge quota or hold sockets.
      if (response.body) {
        const reader = response.body.getReader()
        try {
          await reader.read()
        } finally {
          reader.cancel().catch(() => {})
        }
      }
      if (response.status === 200 || response.status === 429) return 'pass'
      if (response.status === 403 || response.status === 400 || response.status === 410) return 'refused'
      return 'error'
    } catch {
      return 'error'
    } finally {
      clearTimeout(timer)
    }
  }
}
