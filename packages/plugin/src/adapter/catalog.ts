import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { opencodeUserAgent } from './ids.ts'

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

/** Verified against the anonymous lane with a real chat (agent/internal/catalog/static_models.go). */
export const staticFreeModels: string[] = [
  'big-pickle', // verified 2026-08-28: anonymous chat 200 (non-stream + stream)
  'hy3-free', // verified 2026-08-28: anonymous chat 200 (non-stream)
  'mimo-v2.5-free', // verified 2026-08-28: anonymous chat 200 (non-stream)
]

/** Exposed by /v1/models but without a verified anonymous chat yet. */
export const staticFreeCandidates: string[] = [
  // 'deepseek-v4-flash-free',          // 2026-08-28: upstream "Model is unavailable"
  // 'nemotron-3-ultra-free',           // 2026-08-28: upstream server_error payload
  // 'laguna-s-2.1-free',               // 2026-08-28: upstream 503 provider error
  // 'nemotron-3.5-lightning-free',     // 2026-08-28: 502 after all attempts
  // 'muse-spark-1.2-contributor-free', // 2026-08-28: 502 after all attempts
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
}

/** Decide ports model_metadata.go Decide (192-237) line for line. */
export function decide(model: string, prices: Map<string, ModelPrice>, ready: boolean): AnonymousDecision {
  const nameFree = isFreeModel(model)
  const fallback = (source: string): AnonymousDecision => {
    if (nameFree) return { allowed: true, source: 'name_free', known: false }
    return { allowed: false, source, known: false }
  }
  if (!ready || prices.size === 0) return fallback('metadata_pending')
  const price = prices.get(model)
  if (!price) return fallback('metadata_model_missing')
  const metadataFree = !price.deprecated && price.input === 0 && price.output === 0
  if (nameFree || metadataFree) {
    const source = nameFree && metadataFree ? 'name_and_metadata_free' : nameFree ? 'name_free' : 'metadata_free'
    return { allowed: true, source, known: true }
  }
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true }
  if (price.input === undefined || price.output === undefined) {
    return { allowed: false, source: 'metadata_cost_unknown', known: false }
  }
  return { allowed: false, source: 'metadata_paid', known: true }
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
      const num = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined
      result.set(modelId, {
        input: num(cost.input),
        output: num(cost.output),
        deprecated: metadataDeprecated(raw),
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
}

const METADATA_REFRESH_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

/**
 * Live model directory with the S1/S2/S3 fallback chain and the timer-driven
 * refresh loop. All state is in-memory; only the models.dev cache persists.
 */
export class ModelCatalog {
  #zen: Set<string> = new Set()
  #updatedAt = 0
  #prices: Map<string, ModelPrice> = new Map()
  #pricesReady = false
  #lastError = ''
  #refreshSeconds: number
  #cachePath?: string
  #zenBaseUrl: string
  #metadataUrl: string
  #fetch: typeof fetch
  #now: () => number
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #onRefresh?: (status: CatalogSnapshot, lastError: string) => void

  constructor(options: CatalogOptions = {}) {
    this.#refreshSeconds = options.refreshSeconds ?? 300
    this.#cachePath = options.cachePath
    this.#zenBaseUrl = options.zenBaseUrl ?? ZEN_BASE_URL
    this.#metadataUrl = options.metadataUrl ?? 'https://models.dev/api.json'
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#onRefresh = options.onRefresh
  }

  /** Start the refresh loop: immediate S1+S2, then per cadence (S2 every 24h). */
  async start(): Promise<void> {
    await this.refreshOnce()
    if (this.#stopped) return
    this.#timer = setInterval(() => {
      void this.refreshOnce()
    }, this.#refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  async refreshOnce(): Promise<void> {
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
      this.#updatedAt = this.#now()
      this.#lastError = ''
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  async refreshMetadata(): Promise<void> {
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
        const cached = await loadMetadataCache(this.#cachePath).catch(() => null)
        if (cached && cached.size > 0) {
          this.#prices = cached
          this.#pricesReady = true
          return
        }
      }
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  decision(model: string): AnonymousDecision {
    const metadata = decide(model, this.#prices, this.#pricesReady)
    if (!metadata.allowed && !metadata.known && staticFreeModels.includes(model)) {
      return { allowed: true, source: 'static_verified', known: false }
    }
    return metadata
  }

  /** ids exposed to DSH: S1 ∩ allowed, or S3 while the live catalog is pending. */
  list(): string[] {
    if (this.#zen.size === 0) return [...staticFreeModels]
    const out: string[] = []
    for (const model of this.#zen) {
      if (this.decision(model).allowed) out.push(model)
    }
    return out.sort()
  }

  /** healthz models block (design.md 6.1). */
  snapshot(): CatalogSnapshot {
    const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt
    const stale = this.#updatedAt !== 0 && age > 10 * 60 * 1000
    return {
      status: this.#updatedAt === 0 ? 'pending' : stale ? 'stale' : 'ready',
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

async function loadMetadataCache(path: string): Promise<Map<string, ModelPrice>> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as MetadataCache
  if (Date.now() - raw.updatedAt > 7 * METADATA_REFRESH_MS) {
    throw new Error('models.dev cache too old')
  }
  return new Map(raw.prices)
}

/** Default cache location next to the agent data dir (config.ts convention). */
export function defaultCachePath(dataDir: string): string {
  return join(dataDir, 'agent-config.json.models.dev.json')
}
