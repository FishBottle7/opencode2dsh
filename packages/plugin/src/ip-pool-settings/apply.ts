/**
 * ip-pool settings controller — glues the settings namespace (docs/ip-pool.md
 * §5.1) to the runtime assembly (ip-pool.ts) with live apply, and mounts the
 * status/probe bridge (§5.3) on the host webServer.
 *
 * Lifecycle (all no-restart, docs §7 IP-5 acceptance):
 *  - entry config enabled at boot: pool assembles immediately;
 *  - namespace registers with the composition entry as `base`, applies live;
 *  - watch(next) hot-applies every commit through runtime.reconfigure() —
 *    including the `enabled` flip (dispatcher install/uninstall) and address
 *    list edits (manual rows rebuilt, pinned re-pinned);
 *  - bridge routes mount once the webServer service shows up (ctx.inject),
 *    reading the live runtime and the current settings value.
 */

import type { PluginContext } from '../index.ts'
import type { Opencode2dshConfig } from '../config.ts'
import type { IpPoolRuntime } from '../ip-pool.ts'
import { IP_POOL_NAMESPACE, IpPoolConfigSchema, toIpPoolConfig, type IpPoolSettings } from './namespace.ts'
import { IP_POOL_BRIDGE_PREFIX, makeBridgeHandlers, makeBridgeRoutes } from './bridge.ts'

/** Either layer's ip-pool section (settings value or plugin config shape). */
type AnyIpPoolSection = Partial<IpPoolSettings> & {
  subscriptions?: string[]
  free?: Partial<IpPoolSettings['free']>
  subscription?: Partial<IpPoolSettings['subscription']>
}

/** Extract the ip-pool settings value with defaults filled (schema-independent). */
function withDefaults(value: AnyIpPoolSection | undefined): IpPoolSettings {
  const raw = value ?? {}
  const urls = raw.subscription?.urls ?? raw.subscriptions ?? []
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
    },
    singbox: { path: raw.singbox?.path ?? 'sing-box' },
    pinnedExitId: raw.pinnedExitId ?? '',
    pinnedStrict: raw.pinnedStrict ?? false,
    proxyHosts: raw.proxyHosts ?? [],
  }
}

export interface IpPoolController {
  /** The live runtime (null until enabled and assembled). */
  runtime: IpPoolRuntime | null
  /** Current effective settings value (defaults filled). */
  settings(): IpPoolSettings
  /** The plugin config object shape consumed by reconfigure. */
  asConfig(value: IpPoolSettings): Opencode2dshConfig
}

/** Assembly seam (test-injectable); default = the real startIpPool. */
export type AssembleIpPool = (
  config: Opencode2dshConfig,
  logger: PluginContext['logger'],
) => Promise<IpPoolRuntime | null>

const defaultAssemble: AssembleIpPool = async (config, logger) => {
  const { startIpPool } = await import('../ip-pool.ts')
  return startIpPool(config, logger)
}

/**
 * Register the ip-pool namespace, own the live runtime, mount the bridge.
 * Returns the controller handle; disposal rides the plugin fiber.
 */
export function applyIpPoolSettings(
  ctx: PluginContext,
  config: Opencode2dshConfig,
  logger: PluginContext['logger'],
  deps: { assemble?: AssembleIpPool } = {},
): IpPoolController {
  const assemble = deps.assemble ?? defaultAssemble
  const controller: IpPoolController = {
    runtime: null,
    settings: () => withDefaults(config.ipPool as Partial<IpPoolSettings> | undefined),
    asConfig: (value) => ({ ...config, ipPool: toIpPoolConfig(value) }),
  }

  /** Assemble on first enable; reuse across later commits (live reconfigure). */
  const ensureRuntime = async (): Promise<void> => {
    if (controller.runtime !== null) return
    controller.runtime = await assemble(controller.asConfig(controller.settings()), logger)
  }

  // Cold-start ordering (dsh-llm-proxy's applyCurrent pattern): the namespace
  // resolves schema defaults -> base -> the PERSISTED user document, so a
  // saved enabled:true must assemble the pool at boot — not only after the
  // next settings-page write. The entry config alone cannot see it.
  const applyCommitted = (value: IpPoolSettings): void => {
    // Mirror the live value onto the entry-config shape reconfigure consumes.
    config.ipPool = toIpPoolConfig(value)
    const rt = controller.runtime
    if (value.enabled && rt === null) {
      void ensureRuntime()
        .then(() => controller.runtime?.reconfigure(controller.asConfig(value)))
        .catch((err) => {
          logger.warn(`opencode2dsh: ip pool start failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      return
    }
    if (rt !== null) {
      void rt.reconfigure(controller.asConfig(value)).catch((err) => {
        logger.warn(`opencode2dsh: ip pool live re-apply failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  if (typeof ctx.settings?.register !== 'function') {
    logger.warn('opencode2dsh: settings seam lacks register; ip-pool settings page disabled (patch config still works)')
    if (controller.settings().enabled) {
      void ensureRuntime().catch((err) => {
        logger.warn(`opencode2dsh: ip pool start failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    return controller
  }

  const scope = ctx.settings.register(IP_POOL_NAMESPACE, IpPoolConfigSchema, {
    base: controller.settings(),
    applies: 'live',
  })

  // Boot: apply the RESOLVED namespace value (the persisted document is part
  // of it). Watch: apply every commit the same way — one path for both.
  applyCommitted(withDefaults(scope.get() as Partial<IpPoolSettings> | undefined))
  const disposeWatch = scope.watch((next: unknown) => {
    applyCommitted(withDefaults(next as Partial<IpPoolSettings>))
  })

  // Bridge: mount once webServer is up. The handlers read the live runtime
  // and the current settings value at request time (never stale closures).
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(ctx.inject(['webServer'], (bctx: PluginContext) => {
      if (!bctx.webServer) return
      const handlers = makeBridgeHandlers(
        () => controller.runtime,
        () => ({
          pinnedStrict: controller.settings().pinnedStrict,
          proxyHosts: controller.runtime?.installer && controller.settings().proxyHosts.length > 0
            ? controller.settings().proxyHosts
            : ['opencode.ai'],
        }),
      )
      const disposers: Array<() => void> = []
      for (const route of makeBridgeRoutes(handlers)) {
        disposers.push(bctx.webServer.register(route as never))
      }
      logger.info(`opencode2dsh: ip-pool bridge mounted at ${IP_POOL_BRIDGE_PREFIX} (${disposers.length} routes)`)
      const maybeEffect = (bctx as { effect?: PluginContext['effect'] }).effect
      if (typeof maybeEffect === 'function') {
        maybeEffect.call(bctx, () => () => {
          for (const dispose of disposers) dispose()
        })
      }
    })) as unknown as Promise<unknown>
  }

  logger.info('opencode2dsh: settings namespace "ip-pool" registered — live apply via 设置 → 插件 → IP 池')
  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      disposeWatch()
      void controller.runtime?.dispose()
      controller.runtime = null
    })
  }
  return controller
}
