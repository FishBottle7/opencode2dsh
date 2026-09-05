/**
 * ip-pool settings namespace (docs/ip-pool.md §5.1) — the schemastery Config,
 * the `ctx.settings` registration and the live re-apply wiring.
 *
 * Two entry states (docs §5 phase IP-5):
 *  - config.ipPool.enabled at plugin boot: the pool assembles immediately and
 *    the namespace registers with the composition entry as `base`;
 *  - the user flips `enabled` on in the settings page later: the watcher sees
 *    the commit, assembles the pool then.
 *
 * Everything the card can change lands through watch() and is applied to the
 * LIVE runtime (no restart): manual/pinned address lists rebuild the exit
 * table's manual rows, subscription URLs/refresh re-seed the fetcher, probe
 * knobs go straight to the Prober, geo blocklist to the admission deps, and
 * toggling `enabled` installs/uninstalls the global dispatcher.
 */

import Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Namespace owned by this plugin (kebab-case per brand rules). */
export const IP_POOL_NAMESPACE = settingsNamespace('ip-pool')

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
  subscription: Schema.object({
    /** Airport/self-hosted subscription URLs (display-redacted client-side, §5.1). */
    urls: Schema.array(Schema.string()).default([]),
    /** Subscription refresh interval (§4.6, one request per URL per refresh). */
    refreshMs: Schema.number().min(60_000).max(24 * 60 * 60_000).step(1).default(30 * 60_000),
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
})

/** The resolved ip-pool settings value (schema defaults → base → user). */
export interface IpPoolSettings {
  enabled: boolean
  probeModels: string[]
  maxConcurrentProbes: number
  free: { enabled: boolean; targetSize: number; blockedCountries: string[] }
  manual: string[]
  subscription: { urls: string[]; refreshMs: number }
  singbox: { path: string }
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
}

/** Resolve the schema-level default for the probe model set (§4.6). */
export function resolveProbeModels(configured: string[]): string[] {
  if (configured.length > 0) return [...new Set(configured)]
  return [DEFAULT_PROBE_MODEL]
}

/** Map one resolved settings value onto the plugin config shape (config.ts). */
export function toIpPoolConfig(value: IpPoolSettings): {
  enabled: boolean
  manual: string[]
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
  free: { enabled: boolean; targetSize: number; blockedCountries: string[] }
  subscriptions: string[]
  singbox: { path: string }
  probeModels: string[]
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
    singbox: { path: value.singbox.path },
    probeModels: resolveProbeModels(value.probeModels),
  }
}
