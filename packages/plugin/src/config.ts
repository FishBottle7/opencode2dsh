import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { platform } from 'node:process'

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
  /** Admission smoke model (docs 4.1 probeModels[0]). */
  probeModels?: string[]
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
