import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { platform } from 'node:process'

import Schema from '@deepseek-ai/schemastery'

import { IpPoolConfigSchema, type IpPoolSettings, type VolatileRef } from './ip-pool-settings/namespace.ts'

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 */
export interface Opencode2dshConfig {
  /**
   * Integration mode. `adapter` (default) registers a DSH LlmAdapter that
   * streams directly from the Zen anonymous lane — no child process. `sidecar`
   * (legacy, not bundled with the published package) spawns the Go agent
   * binary and registers an llm-pi-ai route to it; build the agent from
   * legacy/agent and pass agentPath.
   */
  mode?: 'adapter' | 'sidecar'
  /** Path to the agent binary (sidecar mode). Not bundled: build from legacy/agent. */
  agentPath?: string
  /** Extra CLI args forwarded to the agent (after --config). */
  agentArgs?: string[]
  /** Provider route name registered into llm-pi-ai settings. */
  providerId?: string
  /** Credential reference (env var name) holding the local agent token. */
  apiKeyEnv?: string
  /** Model list refresh interval in seconds (agent refresh_seconds matches). */
  refreshSeconds?: number
  /** Restart backoff: initial delay ms. */
  restartDelayMs?: number
  /** Restart backoff: max delay ms. */
  restartMaxDelayMs?: number
  /** Consecutive crash count that trips the circuit breaker. */
  maxConsecutiveCrashes?: number
  /**
   * Watchdog: ms to wait for the first pi-ai stream event (issue #33). The
   * shipped window (zen-adapter.ts DEFAULT_FIRST_EVENT_MS) is the fallback
   * when unset, so nobody who does not set it sees a behavior change.
   */
  firstEventMs?: number
  /** Watchdog: ms of body silence tolerated mid-stream (chat models). */
  bodyIdleMs?: number
  /**
   * Watchdog: body-idle window for Responses models (muse-spark-*), whose
   * bursty reasoning needs the wider window (issue #7). Applied as a floor
   * over `bodyIdleMs`, never below it.
   */
  responsesBodyIdleMs?: number
  /**
   * IP-pool exit routing (docs/ip-pool.md). Everything below is pure plugin
   * config; the settings page (IP-6) will own these live, this object is
   * the cordis.patch.yml seam.
   */
  ipPool?: IpPoolConfig
}

/** docs/ip-pool.md section 5.1 schema (subset owned by config today). */
export interface IpPoolConfig {
  /** Master switch; false keeps the process exactly as today (direct). */
  enabled?: boolean
  /** Manually added plain proxies: 'http://h:p' or 'socks5://h:p'. */
  manual?: string[]
  /** Fixed primary exit address (docs/ip-pool.md 3.6). */
  pinnedExitId?: string
  /** Absolute pinning: never rotate, never direct-fallback (3.6). */
  pinnedStrict?: boolean
  /** Hosts whose traffic goes through the pool (default opencode.ai). */
  proxyHosts?: string[]
  /** Free-source pool (docs/ip-pool.md 1.2 source 1, 3.5, 4.5). */
  free?: {
    enabled?: boolean
    /** Target capacity for the free pool (docs 3.5). */
    targetSize?: number
    /** Admission geo blocklist (country codes). */
    blockedCountries?: string[]
  }
  /** Airport/Clash subscriptions (docs 1.2 source 3, IP-3). */
  subscriptions?: string[]
  /** Subscription refresh interval ms (docs 4.6, default 30min). */
  subscription?: { refreshMs?: number }
  /** Cross-exit probe concurrency cap (docs 4.1; same-exit always serial). */
  maxConcurrentProbes?: number
  /** sing-box conversion core for encrypted nodes (docs 1.2.2, IP-4). */
  singbox?: {
    /** sing-box binary: PATH name or absolute path; unset parks encrypted
     *  nodes as pending-conversion. */
    path?: string
  }
  /** Admission smoke model (docs 4.1 probeModels[0]). */
  probeModels?: string[]
  /** Same-request rotate attempts on pre-content failures (docs 3.4). */
  maxRotateAttempts?: number
}

export const defaults = {
  providerId: 'opencode2dsh',
  apiKeyEnv: 'OPENCODE2DSH_TOKEN',
  refreshSeconds: 300,
  restartDelayMs: 1000,
  restartMaxDelayMs: 60000,
  maxConsecutiveCrashes: 5,
}

export type ResolvedConfig = Required<
  Pick<Opencode2dshConfig, 'providerId' | 'apiKeyEnv' | 'refreshSeconds' | 'restartDelayMs' | 'restartMaxDelayMs' | 'maxConsecutiveCrashes'>
> & Opencode2dshConfig

export function resolveConfig(config: Opencode2dshConfig = {}): ResolvedConfig {
  return { ...defaults, ...config }
}

/**
 * The plugin's `Config` — the whole DSH settings contract in one schema.
 *
 * DSH 0.1.7 has no imperative `ctx.settings.register(ns, schema)`. A plugin
 * declares editable settings by exporting this schema, and dsh-settings derives
 * the served namespace from the Loader entry id. Two consequences drive this
 * shape:
 *
 *  - `ipPool` is ONE `.volatile()` node, so the entire ip-pool subtree is the
 *    settings form (dsh-settings' `volatileForm()` selects a node's whole plain
 *    schema once that node is volatile). Nesting `.volatile()` deeper is a hard
 *    schemastery error, and per-field marks would also fragment the card's
 *    form value into siblings instead of one `ipPool` object.
 *  - every other field is ORDINARY configuration. `volatileForm()` drops it
 *    from the form, which is the intent: these are set by the composition
 *    (`cordis.patch.yml`) or a hand-edited profile patch, never by the card.
 *
 * The reference is `dsh-llm-deepseek`'s `deepSeekConfigFields`.
 */
export const Config = Schema.object({
  /** Integration mode; `adapter` (default) is the shipped shape. */
  mode: Schema.union(['adapter', 'sidecar']).default('adapter'),
  /** Path to the agent binary (sidecar mode only; not bundled). */
  agentPath: Schema.string(),
  /** Extra CLI args forwarded to the agent (after --config). */
  agentArgs: Schema.array(Schema.string()).default([]),
  /** Provider route name registered into llm-pi-ai settings (sidecar mode). */
  providerId: Schema.string().default(defaults.providerId),
  /** Credential reference (env var name) holding the local agent token. */
  apiKeyEnv: Schema.string().default(defaults.apiKeyEnv),
  /** Model list refresh interval in seconds. */
  refreshSeconds: Schema.number().step(1).min(1).default(defaults.refreshSeconds),
  /** Restart backoff: initial delay ms. */
  restartDelayMs: Schema.number().step(1).min(0).default(defaults.restartDelayMs),
  /** Restart backoff: max delay ms. */
  restartMaxDelayMs: Schema.number().step(1).min(0).default(defaults.restartMaxDelayMs),
  /** Consecutive crash count that trips the circuit breaker. */
  maxConsecutiveCrashes: Schema.number().step(1).min(0).default(defaults.maxConsecutiveCrashes),
  /**
   * Watchdog: ms to wait for the first stream event. No `.default()` on
   * purpose — the adapter owns those numbers (DEFAULT_FIRST_EVENT_MS &
   * friends), and duplicating them here would make two sources of truth for
   * one window. Undefined leaves the shipped value in force.
   */
  firstEventMs: Schema.number().step(1).min(0),
  /** Watchdog: ms of body silence tolerated mid-stream (chat models). */
  bodyIdleMs: Schema.number().step(1).min(0),
  /** Watchdog: body-idle floor for Responses models (muse-spark-*). */
  responsesBodyIdleMs: Schema.number().step(1).min(0),
  /** The ip-pool settings form (docs/ip-pool.md §5.1); served as this entry. */
  ipPool: IpPoolConfigSchema.volatile(),
})

/**
 * What `apply()` receives once the Loader has resolved {@link Config}.
 *
 * `ipPool` is a STABLE reference, not a value: the Loader commits a settings
 * save into the same object and announces it with `loader/volatile-update`, so
 * consumers read `.get()` at the moment they need a snapshot and never cache
 * the object it returned.
 */
export interface ResolvedPluginConfig extends Omit<ResolvedConfig, 'ipPool'> {
  ipPool: VolatileRef<IpPoolSettings>
}

/** Every field except the volatile ip-pool reference. */
export type OrdinaryPluginConfig = Omit<ResolvedPluginConfig, 'ipPool'>

/**
 * The ordinary half of a resolved config, for the call sites that reconfigure
 * the pool runtime and need a plain object. Spreading the whole config instead
 * would hand `startIpPool` the volatile reference where it expects values.
 */
export function ordinaryConfig(config: ResolvedPluginConfig): OrdinaryPluginConfig {
  const { ipPool: _ipPool, ...ordinary } = config
  return ordinary
}

/**
 * Everything the plugin persists next to the agent: the generated
 * agent-config.json (design.md section 8.3 template) and the local auth token.
 * The data directory doubles as the models.dev cache location for the agent.
 */
export interface AgentConfigPaths {
  dataDir: string
  configPath: string
  tokenPath: string
}

export function configPaths(dataDir: string): AgentConfigPaths {
  return {
    dataDir,
    configPath: join(dataDir, 'agent-config.json'),
    tokenPath: join(dataDir, 'agent-token.txt'),
  }
}

/** 32-byte random token, base64url (design.md section 7). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read the persisted token or generate and persist a fresh one.
 * Best-effort 0600 on POSIX; Windows profile dirs are user-scoped already.
 */
export async function ensureToken(paths: AgentConfigPaths): Promise<string> {
  if (await fileExists(paths.tokenPath)) {
    const existing = (await readFile(paths.tokenPath, 'utf8')).trim()
    if (existing.length > 0) return existing
  }
  const token = generateToken()
  await mkdir(dirname(paths.tokenPath), { recursive: true })
  await writeFile(paths.tokenPath, token + '\n', { encoding: 'utf8' })
  if (platform !== 'win32') {
    await chmod(paths.tokenPath, 0o600).catch(() => {})
  }
  return token
}

/**
 * Write agent-config.json atomically (tmp + rename) every plugin start, so a
 * version upgrade or option change reaches the next agent spawn. The agent
 * accepts JSON with comments; we emit plain JSON.
 */
export async function writeAgentConfig(
  paths: AgentConfigPaths,
  options: { token: string; refreshSeconds: number },
): Promise<void> {
  // design.md section 8.3 template; listen 127.0.0.1:0 => random port,
  // discovered via the READY line (--print-ready).
  const config = {
    listen: '127.0.0.1:0',
    server_keys: [options.token],
    anonymous: true,
    zen_keys: [],
    go_keys: [],
    upstream: { zen: 'https://opencode.ai/zen' },
    models: { refresh_seconds: options.refreshSeconds },
    retry: { max_attempts: 2, timeout_seconds: 300 },
    proxies: ['direct'],
    logging: { level: 'info' },
  }
  await mkdir(paths.dataDir, { recursive: true })
  const tmpPath = paths.configPath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf8')
  await rm(paths.configPath, { force: true })
  await rename(tmpPath, paths.configPath)
}
