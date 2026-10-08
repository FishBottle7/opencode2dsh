import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { ModelCatalog, defaultCachePath, type CatalogSnapshot } from './adapter/catalog.ts'
import { ZenAdapter, PROVIDER_ID } from './adapter/zen-adapter.ts'
import { AgentProcess, type ReadyInfo } from './agent-process.ts'
import { Config, configPaths, ensureToken, ordinaryConfig, resolveConfig, writeAgentConfig, type Opencode2dshConfig, type ResolvedPluginConfig } from './config.ts'
import { applyIpPoolSettings } from './ip-pool-settings/apply.ts'
import { readVolatile, type IpPoolSettings } from './ip-pool-settings/namespace.ts'
import { fetchHealth, fetchModels, registerProvider, removeProviderRoute } from './provider.ts'

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
 * Settings: the editable surface is the `ipPool` field of {@link Config},
 * marked volatile. DSH 0.1.7 serves it under this entry's Loader id and
 * commits saves into the same reference, announcing them with
 * `loader/volatile-update`; there is no `ctx.settings.register()`.
 *
 * dispose(): stop timers/catalog, terminate the agent tree (sidecar mode).
 * The cordis fiber disposal guarantees this runs on plugin reload/unload and
 * on DSH shutdown.
 */

// Minimal structural typing against the host ctx; keeps the plugin independent
// of the exact @deepseek-ai/cordis version DSH ships.
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  credentials?: { set(ref: string, value: string): Promise<void> }
  /**
   * DSH 0.1.7 `SettingsForms` (dsh-settings). Read face for the sidecar's
   * namespace writes; `configure` is how a plugin claims its own settings
   * page instead of letting the domain auto-generate one. The 0.1.1
   * `register()/watch()` scope seam is gone and deliberately not re-declared.
   */
  settings?: {
    describe?(options?: { redactSecrets?: boolean }): unknown
    get?(ns: string): unknown
    mutate?(ns: string, ops: Array<{ op: 'set' | 'unset'; path: Array<string | number>; value?: unknown }>, expectedRevision?: number): Promise<void>
    configure?(presentation: { auto?: boolean }, owner?: unknown): () => void
  }
  /** Web route registration (dsh-host-webserver service, docs §5.3). */
  webServer?: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void
  }
  /** cordis fiber injection: run the callback once every listed service is up. */
  inject?(services: string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown
  effect?(fn: () => () => void): unknown
  on?(event: string, listener: (...args: never[]) => unknown): () => void
}

export const name = 'opencode2dsh'
/**
 * The plugin's own settings schema. DSH 0.1.7 reads this export to decide
 * which fields are editable in 设置 → 插件 and under which namespace (the
 * Loader entry id), so it must be named `Config` on the plugin runtime.
 */
export { Config } from './config.ts'
/**
 * Only `llm` gates this fiber, because adapter mode (the shipped default) uses
 * nothing else: the Zen lane's credential is the literal `'public'`, and the
 * ip-pool settings ride the `Config` volatile reference. DSH 0.1.7 composes
 * `ctx.settings` as `SettingsForms`, which itself injects
 * `['configEditor', 'profileContext']` and ships disabled wherever no
 * `profileContext` exists (headless/CLI) — demanding it here kept the whole
 * fiber from ever activating, and with it the provider route. Sidecar mode and
 * the `configure({ auto: false })` page claim ask for the extra seams through
 * `ctx.inject` instead.
 */
export const inject = ['llm'] as const
export function apply(ctx: PluginContext, config: ResolvedPluginConfig | Opencode2dshConfig = {}): void {
  // A host that predates the `Config` export hands over the raw patch object
  // (no volatile reference); readVolatile copes with both spellings.
  const resolved = config as ResolvedPluginConfig
  const mode = resolveConfig(config as Opencode2dshConfig).mode
  // Cordis accepts disposal effects; readiness objects are invalid effects.
  if (mode === 'sidecar') applySidecar(ctx, config as Opencode2dshConfig)
  else applyAdapter(ctx, resolved, () => readVolatile<IpPoolSettings>(resolved.ipPool))
}

/**
 * Adapter mode: catalog + LlmAdapter registration. The adapter registration
 * is disposed with the plugin fiber (registerAdapter uses ctx.effect
 * internally); we only own the catalog refresh loop here.
 */
function applyAdapter(
  ctx: PluginContext,
  config: ResolvedPluginConfig,
  readIpPool: () => Partial<IpPoolSettings> | undefined,
): { ready: Promise<{ port: number; version: string }> } {
  const logger = ctx.logger
  // Strip the volatile reference before the plain config resolution: it is an
  // ordinary-fields consumer, and `{ ...defaults, ...config }` would otherwise
  // hand `startIpPool` the reference object where it expects values.
  const ordinary = ordinaryConfig(config)
  const cfg = resolveConfig(ordinary)
  const ready = Promise.resolve({ port: 0, version: 'adapter' })

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('opencode2dsh: llm service unavailable; adapter mode cannot register')
    return { ready }
  }

  // IP-pool exit routing (docs/ip-pool.md IP-1..IP-5): manual proxies,
  // pinned, free sources, subscriptions, and (IP-5) the settings namespace
  // with live apply + the /status /probe bridge. Opt-in via settings page or
  // cordis.patch.yml; disabled keeps the process byte-for-byte on direct.
  // Lifecycle (assembly on first enable, live reconfigure, dispose) is owned
  // by applyIpPoolSettings through the plugin fiber.
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
  const adapter = new ZenAdapter(catalog, {
    firstEventMs: cfg.firstEventMs,
    bodyIdleMs: cfg.bodyIdleMs,
    responsesBodyIdleMs: cfg.responsesBodyIdleMs,
  })

  // Register FIRST: the provider must appear in the selector right away. The
  // host awaits listModels and caches its answer per host generation, so the
  // registration-time read warms the catalog (bounded, issue #45) instead of
  // handing the picker the staticFreeModels bootstrap list. Registration
  // deliberately precedes every optional layer below — a throw anywhere in
  // the ip-pool wiring, the stale-route sweep, or the refresh loop must never
  // cost the deployment its only free provider.
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  logger.info(`opencode2dsh: adapter registered for "${PROVIDER_ID}" (catalog warms up in background)`)

  // IP-pool exit routing (docs/ip-pool.md IP-1..IP-5): manual proxies,
  // pinned, free sources, subscriptions, and (IP-5) the volatile `ipPool`
  // settings field with live apply + the /status /models /probe bridge. Opt-in
  // via settings page or cordis.patch.yml; disabled keeps the process
  // byte-for-byte on direct. Lifecycle (assembly on first enable, live
  // reconfigure, dispose) is owned by applyIpPoolSettings through the plugin
  // fiber. The probe-model dropdown rows include the live catalog, so this
  // must run after the catalog instance exists — and it is fenced, because the
  // route above is already live and must survive anything this layer throws.
  try {
    applyIpPoolSettings(ctx, ordinary, readIpPool, logger, { listLiveModels: () => catalog.list() })
  } catch (err) {
    logger.error(`opencode2dsh: ip-pool settings wiring failed; the provider route stays direct: ${err instanceof Error ? err.message : String(err)}`)
  }

  void catalog.start().catch((err) => {
    logger.error(`opencode2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  // A sidecar leftover (llm-pi-ai.providers.opencode2dsh pointing at a dead
  // local port) would shadow the adapter registration and fail every dispatch
  // with a connection error. Remove it before the route can be used.
  //
  // The `settings` seam is requested rather than assumed: 0.1.7's SettingsForms
  // is absent from a headless composition, and its read face is `describe()`
  // (the 0.1.1 `get(ns)` is gone), so both the read and the write go through
  // the same resolve-as-available path the sidecar uses.
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(ctx.inject(['settings'], (sctx: PluginContext) => {
      if (!sctx.settings) return
      void removeProviderRoute({ settings: sctx.settings }, cfg.providerId)
        .then((removed) => {
          if (removed) logger.info(`opencode2dsh: removed stale sidecar route for "${cfg.providerId}" from llm-pi-ai settings`)
        })
        .catch((err) => {
          logger.warn(`opencode2dsh: stale route cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        })
    })) as unknown as Promise<unknown>
  }

  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      catalog.stop()
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
   * Sidecar mode's two extra seams, asked for lazily. `inject` declares only
   * `llm` so the shipped adapter mode never waits on services a headless
   * composition does not compose, which means sidecar has to request
   * `credentials`/`settings` itself. A bounded race keeps a composition that
   * composes neither from parking the first refresh forever: the attempt
   * settles on the next tick when the services are already up, and gives up
   * with the warn below when they never arrive.
   */
  let seams: Promise<{ credentials?: PluginContext['credentials']; settings?: PluginContext['settings'] }> | undefined
  const resolveSeams = (): Promise<{ credentials?: PluginContext['credentials']; settings?: PluginContext['settings'] }> => {
    if (seams !== undefined) return seams
    const carried = { credentials: ctx.credentials, settings: ctx.settings }
    if ((carried.credentials !== undefined && carried.settings !== undefined) || typeof ctx.inject !== 'function') {
      seams = Promise.resolve(carried)
      return seams
    }
    const arrived = new Promise<{ credentials?: PluginContext['credentials']; settings?: PluginContext['settings'] }>((resolve) => {
      void Promise.resolve(ctx.inject!(['credentials', 'settings'], (sctx: PluginContext) => {
        resolve({ credentials: sctx.credentials, settings: sctx.settings })
      }))
    })
    seams = Promise.race([arrived, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000))])
      .then((value) => value ?? carried)
    return seams
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
      const { credentials, settings } = await resolveSeams()
      if (credentials && settings) {
        await registerProvider(
          {
            credentials,
            settings,
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

export { AgentProcess } from './agent-process.ts'
export { configPaths, ensureToken, resolveConfig, writeAgentConfig, type Opencode2dshConfig } from './config.ts'
export { fetchHealth, fetchModels, registerProvider, providerBaseURL, toPiAiModels, type DshSeams } from './provider.ts'
