/**
 * ip-pool settings namespace (docs/ip-pool.md §5.1) — the schemastery schema
 * the plugin's `Config` marks volatile, and the live re-apply wiring.
 *
 * Two entry states (docs §5 phase IP-5):
 *  - `ipPool.enabled` in the entry config at plugin boot: the Loader resolves
 *    it into the volatile reference, so the pool assembles immediately;
 *  - the user flips `enabled` on in the settings page later: the committed
 *    value lands in the same reference, `loader/volatile-update` fires, and
 *    the pool assembles then.
 *
 * Everything the card can change lands through that event and is applied to
 * the LIVE runtime (no restart): manual/pinned address lists rebuild the exit
 * table's manual rows, subscription URLs/refresh re-seed the fetcher, probe
 * knobs go straight to the Prober, geo blocklist to the admission deps, and
 * toggling `enabled` installs/uninstalls the global dispatcher.
 *
 * DSH 0.1.7 owns this seam end to end: there is no `ctx.settings.register()`.
 * A plugin's editable settings ARE the volatile fields of its own exported
 * `Config`, and the namespace they are served under is the Loader entry id
 * (`dsh-settings` reads `entry.options.id`). So this constant mirrors the
 * `id:` of the row in cordis.patch.yml, and the client half spells the same
 * literal (a browser package may not import a Host one).
 */

import Schema from '@deepseek-ai/schemastery'

import { DEFAULT_SUBSCRIPTION_USER_AGENT, normalizeSubscriptionUserAgent } from '../pool/subscription-defaults.ts'
import { resolveSubscriptionUrls } from './subscription-urls.ts'

/**
 * Settings namespace owned by this plugin: the Loader entry id declared by
 * `cordis.patch.yml`. Mirrored by `SETTINGS_NAMESPACE` in src/client/index.ts.
 */
export const IP_POOL_NAMESPACE = 'opencode2dsh'

/**
 * cosmokit's volatile config reference, structurally typed.
 *
 * DSH wraps every `.volatile()` Config field in one of these and hands the
 * plugin a STABLE reference whose `get()` returns the current immutable
 * snapshot; the Loader commits saves into the same object and announces them
 * with `loader/volatile-update`. Declared structurally (rather than imported
 * from cosmokit/cordis) to keep the plugin independent of the host's exact
 * @deepseek-ai version, per the PluginContext discipline in src/index.ts.
 */
export interface VolatileRef<T> {
  get(): T
}

/** True when a value is one of the Loader's stable volatile references. */
export function isVolatileRef<T>(value: unknown): value is VolatileRef<T> {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Read a volatile reference, tolerating an absent one and a host that handed
 * over a plain object instead (a composition predating the `Config` export, or
 * a direct unit-test invocation of `apply()`).
 */
export function readVolatile<T>(value: VolatileRef<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  return isVolatileRef<T>(value) ? value.get() : value
}

/** docs/ip-pool.md §4.6 probe defaults (S3 first entry is the doc-mandated default). */
const DEFAULT_PROBE_MODEL = 'big-pickle'

export const IpPoolConfigSchema = Schema.object({
  /** Master switch; false keeps the process exactly as today (direct). */
  enabled: Schema.boolean().default(false),
  /** Probe model set; empty = [S3 first] (docs §4.6 probeModels). */
  probeModels: Schema.array(Schema.string()).default([]),
  /** Cross-exit probe concurrency cap (1-8; same-exit is always serial, §4.1). */
  maxConcurrentProbes: Schema.number().min(1).max(8).step(1).default(3),
  free: Schema.object({
    /** Free-source fetching master switch (docs §1.2 source 1). */
    enabled: Schema.boolean().default(true),
    /** Free-pool target capacity (docs §3.5). */
    targetSize: Schema.number().min(1).max(100).step(1).default(20),
    /** Admission geo blocklist (ISO country codes). */
    blockedCountries: Schema.array(Schema.string()).default(['CN']),
  }),
  /** Manually added plain proxies: 'http://h:p' or 'socks5://h:p' (§1.2 source 2). */
  manual: Schema.array(Schema.string()).default([]),
  /**
   * Previous patch spelling (legacy flat key), migrated away on the next
   * subscription edit.
   *
   * NOTE: omitting `.default()` does NOT leave this field `undefined` —
   * schemastery assigns `meta.default = []` to every `Schema.array()`. Reading
   * it as a fallback therefore has to treat an empty list as "absent"; a bare
   * `??` would let this key shadow the nested one. See subscription-urls.ts.
   */
  subscriptions: Schema.array(Schema.string()),
  subscription: Schema.object({
    /** Airport/self-hosted subscription URLs (display-redacted client-side, §5.1). */
    urls: Schema.array(Schema.string()).default([]),
    /** Subscription refresh interval (§4.6, one request per URL per refresh). */
    refreshMs: Schema.number().min(60_000).max(24 * 60 * 60_000).step(1).default(30 * 60_000),
    /**
     * Fetch User-Agent for subscription URLs (§4.6). Airports gate on it and
     * some pick the returned format from it, so it stays user-editable without
     * a plugin release. Empty = the built-in default.
     */
    userAgent: Schema.string().default(DEFAULT_SUBSCRIPTION_USER_AGENT),
  }),
  singbox: Schema.object({
    /** sing-box binary: PATH name or absolute path; empty parks encrypted nodes. */
    path: Schema.string().default('sing-box'),
  }),
  /** Fixed primary exit address (docs §3.6). */
  pinnedExitId: Schema.string().default(''),
  /** Absolute pinning: never rotate, never direct-fallback (docs §3.6). */
  pinnedStrict: Schema.boolean().default(false),
  /** Hosts whose traffic goes through the pool (default opencode.ai). */
  proxyHosts: Schema.array(Schema.string()).default([]),
  /** Same-request rotate attempts on pre-content transport/429 failures (§3.4). */
  maxRotateAttempts: Schema.number().min(0).max(10).step(1).default(3),
  /** Periodic health-probe tick (§4.6 probeIntervalMs, default 10min). */
  probeIntervalMs: Schema.number().min(60_000).max(24 * 60 * 60_000).step(1).default(10 * 60_000),
})

/** The resolved ip-pool settings value (schema defaults → base → user). */
export interface IpPoolSettings {
  enabled: boolean
  probeModels: string[]
  maxConcurrentProbes: number
  free: { enabled: boolean; targetSize: number; blockedCountries: string[] }
  manual: string[]
  subscription: { urls: string[]; refreshMs: number; userAgent: string }
  singbox: { path: string }
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
  maxRotateAttempts: number
  probeIntervalMs: number
}

/** Resolve the schema-level default for the probe model set (§4.6). */
export function resolveProbeModels(configured: string[]): string[] {
  if (configured.length > 0) return [...new Set(configured)]
  return [DEFAULT_PROBE_MODEL]
}

/**
 * Either layer's ip-pool spelling: the resolved settings value (the volatile
 * reference's snapshot) and the flat entry-config shape, which carries
 * subscription URLs under the legacy `subscriptions` key.
 *
 * Declared as a recursive partial rather than `Partial<IpPoolSettings> & ...`,
 * because the latter intersects the REQUIRED nested `subscription` shape with
 * its partial and so still demands `refreshMs` from a patch that only sets
 * `urls` — exactly the half-written form the defaults exist to complete.
 */
export interface AnyIpPoolSection {
  enabled?: boolean
  manual?: string[]
  pinnedExitId?: string
  pinnedStrict?: boolean
  proxyHosts?: string[]
  free?: Partial<IpPoolSettings['free']>
  /** Settings spelling: nested. */
  subscription?: Partial<IpPoolSettings['subscription']>
  /** Entry-config spelling: flat list, legacy key. */
  subscriptions?: string[]
  singbox?: Partial<IpPoolSettings['singbox']>
  probeModels?: string[]
  maxConcurrentProbes?: number
  maxRotateAttempts?: number
  probeIntervalMs?: number
}

/**
 * Fill every default into one ip-pool value, from whichever layer produced
 * it. Deliberately schema-independent: the volatile reference is the
 * authoritative source, but a composition that predates the `Config` export
 * (or a hand-edited profile patch) can still present the flat spelling, and
 * neither may crash the boot path.
 */
export function resolveIpPoolSettings(value: AnyIpPoolSection | undefined): IpPoolSettings {
  const raw = value ?? {}
  // Never `raw.subscriptions ?? raw.subscription?.urls`: schemastery gives every
  // `Schema.array()` an implicit `[]` default, so the flat key is never
  // `undefined` and would short-circuit the canonical nested field away (see
  // subscription-urls.ts for the full account).
  const urls = resolveSubscriptionUrls(raw)
  return {
    enabled: raw.enabled ?? false,
    probeModels: raw.probeModels ?? [],
    maxConcurrentProbes: raw.maxConcurrentProbes ?? 3,
    free: {
      enabled: raw.free?.enabled ?? true,
      targetSize: raw.free?.targetSize ?? 20,
      blockedCountries: raw.free?.blockedCountries ?? ['CN'],
    },
    manual: raw.manual ?? [],
    subscription: {
      urls,
      refreshMs: raw.subscription?.refreshMs ?? 30 * 60_000,
      userAgent: normalizeSubscriptionUserAgent(raw.subscription?.userAgent),
    },
    singbox: { path: raw.singbox?.path ?? 'sing-box' },
    pinnedExitId: raw.pinnedExitId ?? '',
    pinnedStrict: raw.pinnedStrict ?? false,
    proxyHosts: raw.proxyHosts ?? [],
    maxRotateAttempts: raw.maxRotateAttempts ?? 3,
    probeIntervalMs: raw.probeIntervalMs ?? 10 * 60_000,
  }
}

/**
 * Map one resolved settings value onto the plugin config shape (config.ts).
 * Round-trip complete: every field the runtime reads must survive here, or a
 * live commit silently resets it to the default.
 */
export function toIpPoolConfig(value: IpPoolSettings): {
  enabled: boolean
  manual: string[]
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
  free: { enabled: boolean; targetSize: number; blockedCountries: string[] }
  subscriptions: string[]
  subscription: { refreshMs: number; userAgent: string }
  singbox: { path: string }
  probeModels: string[]
  maxConcurrentProbes: number
  maxRotateAttempts: number
  probeIntervalMs: number
} {
  return {
    enabled: value.enabled,
    manual: value.manual,
    pinnedExitId: value.pinnedExitId,
    pinnedStrict: value.pinnedStrict,
    proxyHosts: value.proxyHosts,
    free: {
      enabled: value.free.enabled,
      targetSize: value.free.targetSize,
      blockedCountries: value.free.blockedCountries,
    },
    subscriptions: value.subscription.urls,
    subscription: { refreshMs: value.subscription.refreshMs, userAgent: value.subscription.userAgent },
    singbox: { path: value.singbox.path },
    probeModels: resolveProbeModels(value.probeModels),
    maxConcurrentProbes: value.maxConcurrentProbes,
    maxRotateAttempts: value.maxRotateAttempts,
    probeIntervalMs: value.probeIntervalMs,
  }
}
