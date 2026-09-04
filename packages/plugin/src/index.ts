import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { ModelCatalog, defaultCachePath, type CatalogSnapshot } from './adapter/catalog.ts'
import { ZenAdapter, PROVIDER_ID } from './adapter/zen-adapter.ts'
import { AgentProcess, type ReadyInfo } from './agent-process.js'
import { configPaths, ensureToken, resolveConfig, writeAgentConfig, type Opencode2dshConfig } from './config.js'
import { startIpPool, type IpPoolRuntime } from './ip-pool.ts'
import { fetchHealth, fetchModels, registerProvider, removeProviderRoute } from './provider.js'

/**
 * opencode2dsh DSH cordis plugin entry.
 *
 * Two modes (config.mode, default `adapter`):
 *  - adapter: register a DSH LlmAdapter streaming directly from the Zen
 *    anonymous lane (marketplace shape: no child process, no binary).
 *  - sidecar (legacy/dev): prepare data dir + token + agent-config.json,
 *    spawn the Go agent, wait for READY, register the llm-pi-ai provider
 *    route, schedule model refresh.
 *
 * dispose(): stop timers/catalog, terminate the agent tree (sidecar mode).
 * The cordis fiber disposal guarantees this runs on plugin reload/unload and
 * on DSH shutdown.
 */

// Minimal structural typing against the host ctx; keeps the plugin independent
// of the exact @deepseek-ai/cordis version DSH ships.
interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  credentials?: { set(ref: string, value: string): Promise<void> }
  settings?: {
    get(ns: string): unknown
    mutate(ns: string, ops: Array<{ op: 'set' | 'unset'; path: Array<string | number>; value?: unknown }>): Promise<void>
  }
  effect?(fn: () => () => void): unknown
}

export const name = 'opencode2dsh'
export const inject = ['llm', 'credentials', 'settings'] as const
export function apply(ctx: PluginContext, config: Opencode2dshConfig = {}): { ready: Promise<ReadyInfo> } {
  if (resolveConfig(config).mode === 'sidecar') return applySidecar(ctx, config)
  return applyAdapter(ctx, config)
}

/**
 * Adapter mode: catalog + LlmAdapter registration. The adapter registration
 * is disposed with the plugin fiber (registerAdapter uses ctx.effect
 * internally); we only own the catalog refresh loop here.
 */
function applyAdapter(ctx: PluginContext, config: Opencode2dshConfig): { ready: Promise<{ port: number; version: string }> } {
  const logger = ctx.logger
  const cfg = resolveConfig(config)
  const ready = Promise.resolve({ port: 0, version: 'adapter' })

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('opencode2dsh: llm service unavailable; adapter mode cannot register')
    return { ready }
  }

  // IP-pool exit routing (docs/ip-pool.md IP-1: manual proxies + pinned).
  // Opt-in; disabled keeps the process byte-for-byte on the direct path.
  const ipPoolRuntimePromise: Promise<IpPoolRuntime | null> = cfg.ipPool?.enabled
    ? startIpPool(cfg, logger).catch((err) => {
        logger.warn(`opencode2dsh: ip pool start failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      })
    : Promise.resolve(null)

  const dataDir = join(homedir(), '.opencode2dsh')
  const statusPath = join(dataDir, 'adapter-status.json')
  const writeStatus = (status: CatalogSnapshot, lastError: string): void => {
    void writeFile(
      statusPath,
      JSON.stringify({ ...status, lastError, writtenAt: new Date().toISOString() }, null, 2),
      'utf8',
    ).catch(() => {})
  }

  const catalog = new ModelCatalog({
    refreshSeconds: cfg.refreshSeconds,
    cachePath: defaultCachePath(dataDir),
    onRefresh: (status, lastError) => {
      writeStatus(status, lastError)
      if (lastError) logger.warn(`opencode2dsh: catalog refresh issue: ${lastError}`)
    },
  })
  const adapter = new ZenAdapter(catalog)

  // Register immediately: the provider must appear in the selector right
  // away, even while the catalog is still warming up (listModels is read
  // live at selector time, so models appear as refreshes land).
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  logger.info(`opencode2dsh: adapter registered for "${PROVIDER_ID}" (catalog warms up in background)`)
  void catalog.start().catch((err) => {
    logger.error(`opencode2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  // A sidecar leftover (llm-pi-ai.providers.opencode2dsh pointing at a dead
  // local port) would shadow the adapter registration and fail every dispatch
  // with a connection error. Remove it before the route can be used.
  if (ctx.settings) {
    removeProviderRoute({ settings: ctx.settings }, cfg.providerId)
      .then((removed) => {
        if (removed) logger.info(`opencode2dsh: removed stale sidecar route for "${cfg.providerId}" from llm-pi-ai settings`)
      })
      .catch((err) => {
        logger.warn(`opencode2dsh: stale route cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      catalog.stop()
      void ipPoolRuntimePromise.then((runtime) => runtime?.dispose())
    })
  }
  return { ready }
}

function applySidecar(ctx: PluginContext, config: Opencode2dshConfig): { ready: Promise<ReadyInfo> } {
  const cfg = resolveConfig(config)
  const paths = configPaths(join(homedir(), '.opencode2dsh'))
  const logger = ctx.logger

  let agent: AgentProcess | null = null
  let refreshTimer: NodeJS.Timeout | null = null
  let disposed = false
  let readyResolve: (info: ReadyInfo) => void = () => {}
  const ready = new Promise<ReadyInfo>((resolve) => {
    readyResolve = resolve
  })

  const onLog = (line: string) => {
    // Agent structured logs arrive as single JSON lines on stderr/stdout.
    logger.info(`[agent] ${line}`)
  }

  /**
   * Wait until the agent's model catalog is no longer "pending" (it fetches
   * the live S1 list a moment after listen; registering before that bakes the
   * 3-model static fallback into the DSH provider until the next refresh).
   */
  async function waitCatalogReady(port: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const health = await fetchHealth(port, 2000)
        const status = (health as { models?: { status?: string } })?.models?.status
        if (status && status !== 'pending') return
      } catch {
        // healthz hiccups right after listen are normal; keep polling
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    logger.warn('opencode2dsh: catalog still pending after timeout; registering whatever the agent exposes now')
  }

  async function refreshModels(info: ReadyInfo, token: string, { waitReady = false } = {}): Promise<void> {
    try {
      if (waitReady) await waitCatalogReady(info.port)
      const models = await fetchModels(info.port, token)
      if (ctx.credentials && ctx.settings) {
        await registerProvider(
          {
            credentials: ctx.credentials,
            settings: ctx.settings,
            logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
          },
          { providerId: cfg.providerId, apiKeyEnv: cfg.apiKeyEnv, port: info.port },
          token,
          models,
        )
      } else {
        logger.warn('opencode2dsh: credentials/settings services unavailable; provider route not registered')
      }
    } catch (err) {
      logger.warn(`opencode2dsh: model refresh failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function scheduleRefresh(info: ReadyInfo, token: string): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      if (disposed) return
      void refreshModels(info, token).then(() => {
        if (!disposed && agent?.getState() === 'ready') scheduleRefresh(info, token)
      })
    }, cfg.refreshSeconds * 1000)
  }

  async function startOnce(): Promise<ReadyInfo> {
    const token = await ensureToken(paths)
    await writeAgentConfig(paths, { token, refreshSeconds: cfg.refreshSeconds })
    const binary = cfg.agentPath ?? defaultAgentPath()
    agent = new AgentProcess(binary, ['--config', paths.configPath, '--print-ready', ...(cfg.agentArgs ?? [])], {
      restartDelayMs: cfg.restartDelayMs,
      restartMaxDelayMs: cfg.restartMaxDelayMs,
      maxConsecutiveCrashes: cfg.maxConsecutiveCrashes,
      onLog,
    })
    agent.on('exit-restart', (delay, crashes) => {
      logger.warn(`opencode2dsh: agent exited unexpectedly; restarting in ${delay}ms (attempt ${crashes})`)
    })
    agent.on('circuit-tripped', (crashes) => {
      logger.error(`opencode2dsh: agent crashed ${crashes} times consecutively; giving up`)
    })
    agent.on('state', (state) => {
      if (state === 'ready') logger.info('opencode2dsh: agent ready')
    })
    const info = await agent.start()
    readyResolve(info)
    await refreshModels(info, token, { waitReady: true })
    scheduleRefresh(info, token)
    return info
  }

  void startOnce().catch((err) => {
    logger.error(`opencode2dsh: failed to start agent: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Register disposer on the plugin fiber so reload/unload/shutdown reaps the
  // child process (plan.md Phase 1 acceptance: no orphans).
  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      void teardown()
    })
  }

  async function teardown(): Promise<void> {
    disposed = true
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (agent) {
      await agent.dispose().catch(() => {})
      agent = null
    }
  }

  return { ready }
}

/**
 * Locate the agent binary (sidecar mode, legacy — the published package does
 * not bundle it): explicit config wins; then a sibling `legacy/agent` dev
 * build; then a bare name on PATH.
 */
export function defaultAgentPath(): string {
  const bin = 'opencode2dsh-agent'
  const exe = process.platform === 'win32' ? `${bin}.exe` : bin
  const here = __dirnameSafe()
  for (const sibling of [
    join(here, '..', '..', '..', 'legacy', 'agent', exe),
    join(here, '..', '..', 'legacy', 'agent', exe),
  ]) {
    if (existsSync(sibling)) return sibling
  }
  return exe
}

import { fileURLToPath } from 'node:url'

function __dirnameSafe(): string {
  try {
    return fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return '.'
  }
}

export { AgentProcess } from './agent-process.js'
export { configPaths, ensureToken, resolveConfig, writeAgentConfig, type Opencode2dshConfig } from './config.js'
export { fetchHealth, fetchModels, registerProvider, providerBaseURL, toPiAiModels, type DshSeams } from './provider.js'
