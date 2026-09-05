/**
 * ip-pool assembly — builds the ExitPool + RoutingInstaller from plugin
 * config and owns their lifecycle (docs/ip-pool.md IP-1 scope: manual
 * proxies + pinned, both strictness levels; free sources arrive in IP-2).
 *
 * Deliberately lazy about `undici`: the module is only imported when
 * ipPool.enabled is true, so the default install keeps today's dependency
 * surface (pi-ai only).
 *
 * IP-5: the runtime additionally exposes reconfigure() so the settings
 * namespace can hot-apply committed values (docs §5.1) — no restart for any
 * knob, including enabled itself.
 */

import type { Opencode2dshConfig } from './config.ts'

import { homedir } from 'node:os'
import { join } from 'node:path'

import { ExitPool, gradeOf, type ExitNode } from './pool/pool.ts'
import type { UndiciSeam } from './pool/dispatcher.ts'
import type { AdmissionDeps } from './pool/admission.ts'
import { Prober } from './pool/prober.ts'
import { RefillScheduler } from './pool/refill.ts'
import { SubscriptionFetcher } from './pool/subscription-fetcher.ts'
import { SingBoxSupervisor } from './pool/singbox.ts'

/** Data dir shared with the catalog cache (config.ts convention). */
function dataDir(): string {
  return join(homedir(), '.opencode2dsh')
}

/** Parse one manual proxy string into an exit id + protocol, or null. */
export function parseManualProxy(
  entry: string,
): { id: string; protocol: 'http' | 'socks5' } | null {
  const trimmed = entry.trim()
  if (trimmed === '') return null
  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(trimmed)
  const scheme = schemeMatch?.[1]?.toLowerCase()
  const rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed
  if (!/^\[[^\]]+\]|[^:]+:\d{1,5}$/.test(rest)) return null
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'socks5' && scheme !== 'https' && scheme !== 'socks4' && scheme !== 'socks5h') return null
  const protocol = scheme === 'socks5' || scheme === 'socks4' || scheme === 'socks5h' ? 'socks5' : 'http'
  return { id: trimmed, protocol }
}

/** Build the ExitPool from config (manual proxies + pinned). The pool starts
 *  with unknown health; the periodic/probe layer (IP-2) fills it in. Pinned
 *  nodes are admitted even without admission data — the user vouches for
 *  them (docs/ip-pool.md 3.1/4.5). */
export function buildPoolFromConfig(config: Opencode2dshConfig): ExitPool {
  const pool = new ExitPool()
  const ipPool = config.ipPool ?? {}
  for (const entry of ipPool.manual ?? []) {
    const parsed = parseManualProxy(entry)
    if (!parsed) continue
    const node: ExitNode = {
      id: parsed.id,
      protocol: parsed.protocol,
      source: 'manual',
      pinned: false,
      exitIP: '',
      exitLocation: '',
      latencyMs: 0,
      quality: gradeOf(0),
      addedAt: Date.now(),
    }
    pool.add(node)
    pool.markOk(node.id)
  }
  const pinned = ipPool.pinnedExitId?.trim()
  if (pinned) {
    const parsed = parseManualProxy(pinned)
    if (parsed) {
      const node: ExitNode = {
        id: parsed.id,
        protocol: parsed.protocol,
        source: 'manual',
        pinned: true,
        exitIP: '',
        exitLocation: '',
        latencyMs: 0,
        quality: gradeOf(0),
        addedAt: Date.now(),
      }
      pool.add(node)
      pool.markOk(node.id)
      pool.pin(node.id)
    }
  }
  return pool
}

export interface IpPoolRuntime {
  pool: ExitPool
  installer: {
    install(): void
    disable(): void
    dispose(): void
    readonly enabled: boolean
  }
  /** Shared probe scheduler (admission + periodic probes + UI-triggered). */
  prober: Prober
  /** Subscription layer (null when no URLs configured). */
  subscriptions: SubscriptionFetcher | null
  /** Free-source refill loop (null when free.enabled false). */
  refill: RefillScheduler | null
  /** Hot-apply one committed settings value onto the live runtime (docs §5.1).
   *  Every knob lands without restart; enabled toggles the dispatcher. */
  reconfigure(next: Opencode2dshConfig): Promise<void>
  /** Enqueue a probe of every pool exit against the probe models (bridge
   *  /probe scope 'all', docs §5.3). Returns the queue depth after enqueue. */
  probeAll(): Promise<number>
  /** Enqueue one exit's probe (bridge /probe scope 'exit'). */
  probeExit(exitId: string): Promise<number>
  /** One manual refill round (bridge /probe scope 'refill'). */
  refillNow(): Promise<void>
  /** One subscription refresh round (bridge 立即刷新, docs §5.2). */
  refreshSubscriptions(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Assemble the routing stack. Returns null (with a logged reason) when the
 * host has no undici or the pool ends up empty — enabled-but-empty must
 * degrade to today's direct behavior, never a broken dispatcher (3.3).
 *
 * The undici seam is imported once here and threaded to every layer; empty
 * pool does not stop the runtime from existing (reconfigure can add exits
 * later), it only keeps the dispatcher uninstalled.
 */
export async function startIpPool(
  config: Opencode2dshConfig,
  logger: { info(message: string): void; warn(message: string): void },
): Promise<IpPoolRuntime | null> {
  const ipPool = config.ipPool ?? {}
  const pool = buildPoolFromConfig(config)

  let undici: UndiciSeam
  try {
    undici = (await import('undici')) as UndiciSeam
  } catch (err) {
    logger.warn(`opencode2dsh: undici unavailable; exit routing disabled (${err instanceof Error ? err.message : String(err)})`)
    return null
  }

  const { RoutingInstaller } = await import('./pool/installer.ts')
  const installer = new RoutingInstaller({
    pool,
    undici,
    proxyHosts: ipPool.proxyHosts,
    logger,
  })

  const admissionDeps: AdmissionDeps = {
    pool,
    undici: undici as unknown as AdmissionDeps['undici'],
    logger,
    blockedCountries: ipPool.free?.blockedCountries,
    smokeModel: (ipPool.probeModels ?? [])[0],
  }
  const probeModels = ipPool.probeModels ?? []
  const prober = new Prober({ pool, maxConcurrentProbes: ipPool.maxConcurrentProbes ?? 3 })

  // Free-source refill loop (docs/ip-pool.md 3.5/4.5, IP-2): periodic state
  // check -> tiered fetch -> admission probes through the Prober queue.
  let refill: RefillScheduler | null = null

  // Subscriptions (docs 1.2 source 3, IP-3/IP-4): pull + parse + trusted
  // smoke; encrypted nodes convert via sing-box when a binary is configured.
  let subscriptions: SubscriptionFetcher | null = null
  let supervisor: SingBoxSupervisor | undefined

  const ensureSupervisor = (): SingBoxSupervisor | undefined => {
    const singboxPath = config.ipPool?.singbox?.path
    if (typeof singboxPath !== 'string' || singboxPath.length === 0) return undefined
    if (supervisor === undefined) {
      supervisor = new SingBoxSupervisor({
        binPath: singboxPath,
        dataDir: join(dataDir(), 'singbox'),
        logger,
      })
    } else {
      supervisor.setBinPath(singboxPath)
    }
    return supervisor
  }

  const ensureSubscriptions = (urls: string[]): SubscriptionFetcher | null => {
    if (urls.length === 0) return null
    if (subscriptions === null) {
      subscriptions = new SubscriptionFetcher(
        { ...admissionDeps, prober, supervisor: ensureSupervisor() },
        { logger },
      )
    }
    subscriptions.setUrls(urls)
    return subscriptions
  }

  /** Apply the config to the live objects (initial start + reconfigure). */
  const applyConfig = (): void => {
    const current = config.ipPool ?? {}
    pool.setTargetSize(current.free?.targetSize ?? 20)
    admissionDeps.blockedCountries = current.free?.blockedCountries
    admissionDeps.smokeModel = probeModels[0]
    prober.setMaxConcurrent(current.maxConcurrentProbes ?? 3)
    installer.setProxyHosts?.(current.proxyHosts)

    // Free loop on/off + restart on target change (interval fixed 10min).
    const wantRefill = (current.free?.enabled ?? true) && current.enabled !== false
    if (wantRefill && refill === null) {
      refill = new RefillScheduler(pool, { ...admissionDeps, prober })
      refill.start()
    } else if (!wantRefill && refill !== null) {
      refill.stop()
      refill = null
    }

    // Subscription layer: (re)create on URL change, keep the fetcher across
    // refresh-interval edits.
    const urls = current.subscriptions ?? []
    const fetcher = ensureSubscriptions(urls)
    if (fetcher !== null) {
      fetcher.setIntervalMs(current.subscription?.refreshMs ?? 30 * 60_000)
      if (fetcher === subscriptions && !fetcherActive) {
        fetcher.start()
        fetcherActive = true
      }
    }
  }

  let fetcherActive = false
  if (pool.snapshot().total > 0) {
    installer.install()
  } else {
    logger.warn('opencode2dsh: ipPool enabled but no exits configured; staying direct until settings add exits')
  }
  applyConfig()

  const probeAll = async (): Promise<number> => {
    const models = probeModels.length > 0 ? probeModels : ['big-pickle']
    const { admitCandidate, admitTrusted } = await import('./pool/admission.ts')
    const tasks = pool.list().map((entry): import('./pool/prober.ts').ProbeTask => ({
      exitId: entry.id,
      kind: 'probe-all',
      run: async () => {
        for (const model of models) {
          // The smoke rides the shared admission deps; point its model at the
          // current probe-model before each pass (per-exit serial, §4.1).
          admissionDeps.smokeModel = model
          // Free exits re-run the full candidate chain (echo→tunnel→smoke) —
          // their facts may have drifted; trusted exits run the smoke only
          // (docs §4.5 manual/subscription path). Pinned rides the trusted
          // path so a blocked echo endpoint never evicts the user's line.
          const verdict = entry.source === 'free'
            ? await admitCandidate(admissionDeps, {
              address: entry.id,
              protocol: entry.protocol,
              source: 'free',
            })
            : await admitTrusted(admissionDeps, {
              address: entry.id,
              protocol: entry.protocol,
              source: entry.source === 'manual' ? 'manual' : 'subscription',
            }, { pinned: entry.pinned })
          if (verdict.admitted && verdict.node) {
            // Refresh the node's facts (admission re-measured them).
            pool.add({ ...entry, ...verdict.node, pinned: entry.pinned })
            if (verdict.limited) pool.markLimited(entry.id)
            else pool.markOk(entry.id, model)
          } else {
            pool.markDeadStrike(entry.id)
            break
          }
        }
      },
    }))
    if (tasks.length === 0) return 0
    void prober.enqueueAll(tasks).catch(() => {})
    return tasks.length
  }

  const probeExitTask = (exitId: string, entry: import('./pool/pool.ts').ExitNode & { health: unknown; bans: unknown }): import('./pool/prober.ts').ProbeTask => ({
    exitId,
    kind: 'probe-exit',
    run: async () => {
      const models = probeModels.length > 0 ? [...probeModels] : ['big-pickle']
      const { admitCandidate, admitTrusted } = await import('./pool/admission.ts')
      for (const model of models) {
        admissionDeps.smokeModel = model
        const verdict = entry.source === 'free'
          ? await admitCandidate(admissionDeps, { address: entry.id, protocol: entry.protocol, source: 'free' })
          : await admitTrusted(admissionDeps, {
            address: entry.id,
            protocol: entry.protocol,
            source: entry.source === 'manual' ? 'manual' : 'subscription',
          }, { pinned: entry.pinned })
        if (verdict.admitted && verdict.node) {
          pool.add({ ...entry, ...verdict.node, pinned: entry.pinned })
          if (verdict.limited) pool.markLimited(entry.id)
          else pool.markOk(entry.id, model)
        } else {
          pool.markDeadStrike(entry.id)
          break
        }
      }
    },
  })

  const probeExit = async (exitId: string): Promise<number> => {
    const entry = pool.list().find((node) => node.id === exitId)
    if (!entry) return 0
    await prober.enqueue(probeExitTask(exitId, entry))
    return 1
  }

  return {
    pool,
    installer,
    prober,
    get subscriptions() { return subscriptions },
    get refill() { return refill },
    async reconfigure(next: Opencode2dshConfig) {
      const wasEnabled = config.ipPool?.enabled !== false
      // splice the new ipPool section into the config object the runtime closes over
      config.ipPool = next.ipPool
      probeModels.length = 0
      probeModels.push(...(next.ipPool?.probeModels ?? []))
      const enable = next.ipPool?.enabled !== false
      applyConfig()
      // Dispatcher install state follows enabled + pool occupancy.
      if (enable && !installer.enabled && pool.snapshot().total > 0) {
        installer.install()
      } else if (!enable && installer.enabled) {
        installer.disable()
      }
      if (wasEnabled !== enable) {
        logger.info(`opencode2dsh: ip pool ${enable ? 'enabled' : 'disabled'} via settings (live)`)
      }
    },
    probeAll,
    probeExit,
    async refillNow() {
      if (refill !== null) await refill.tick()
    },
    async refreshSubscriptions() {
      await subscriptions?.refreshNow()
    },
    async dispose() {
      subscriptions?.stop()
      refill?.stop()
      installer.dispose()
    },
  }
}
