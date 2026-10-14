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

import { ExitPool, gradeOf, type ExitNode, type ExitProtocol } from './pool/pool.ts'
import type { UndiciSeam } from './pool/dispatcher.ts'
import type { AdmissionDeps } from './pool/admission.ts'
import { Prober } from './pool/prober.ts'
import { PeriodicProber } from './pool/periodic-prober.ts'
import { RefillScheduler } from './pool/refill.ts'
import { SubscriptionFetcher } from './pool/subscription-fetcher.ts'
import { SingBoxSupervisor } from './pool/singbox.ts'
import { createRotateDelegate, createStreamFailureReporter, setRotateDelegate, setStreamFailureReporter } from './pool/rotate.ts'

/** Data dir shared with the catalog cache (config.ts convention). */
function dataDir(): string {
  return join(homedir(), '.opencode2dsh')
}

/** Parse one manual proxy string into an exit id + protocol, or null. */
export function parseManualProxy(
  entry: string,
): { id: string; protocol: ExitProtocol } | null {
  const trimmed = entry.trim()
  if (trimmed === '') return null
  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(trimmed)
  const scheme = schemeMatch?.[1]?.toLowerCase()
  const rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed
  if (!/^\[[^\]]+\]|[^:]+:\d{1,5}$/.test(rest)) return null
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'socks5' && scheme !== 'https' && scheme !== 'socks4' && scheme !== 'socks5h') return null
  // `https` must survive as itself: an https:// manual proxy dialed as
  // plaintext gets its connection dropped before any status line, which the
  // rule table reads as a dead link (measured 2026-10-15 — see
  // dispatcher.exitProxyUri).
  const protocol: ExitProtocol = scheme === 'socks5' || scheme === 'socks4' || scheme === 'socks5h'
    ? 'socks5'
    : scheme === 'https'
      ? 'https'
      : 'http'
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
    /** R1 coexistence: why the routing layer deferred (null when active). */
    readonly deferredReason: string | null
  }
  /** Shared probe scheduler (admission + periodic probes + UI-triggered). */
  prober: Prober
  /** Subscription layer (null when no URLs configured). */
  subscriptions: SubscriptionFetcher | null
  /** Free-source refill loop (null when free.enabled false). */
  refill: RefillScheduler | null
  /** Periodic health probe loop (docs §4.3; always present while enabled). */
  periodic: PeriodicProber
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
      // Engage routing the moment a subscription round lands exits. The
      // free-source hook (refill.onAdmitted below) never fires for a
      // subscription-only pool, so without this the dispatcher stays
      // uninstalled and real traffic never routes through the pool — the
      // exits sit in the table collecting probes but no 真实流量 (live
      // state 2026-10-16: pool total 38, all subscription, installer off).
      subscriptions.onAdmitted(() => {
        if (!installer.enabled && config.ipPool?.enabled !== false && pool.snapshot().total > 0) {
          installer.install()
          if (installer.enabled) {
            logger.info('opencode2dsh: first subscription exits admitted — exit routing engaged')
          }
        }
      })
    }
    subscriptions.setUrls(urls)
    return subscriptions
  }

  /**
   * Periodic health probe loop, assigned once the piece it drives (probeExit)
   * exists below. Declared here because applyConfig — defined next and invoked
   * at start AND on every settings commit — needs to start/stop it.
   */
  let periodicRef: PeriodicProber | null = null

  /** Apply the config to the live objects (initial start + reconfigure). */
  const applyConfig = (): void => {
    const current = config.ipPool ?? {}
    pool.setTargetSize(current.free?.targetSize ?? 20)
    admissionDeps.blockedCountries = current.free?.blockedCountries
    admissionDeps.smokeModel = probeModels[0]
    prober.setMaxConcurrent(current.maxConcurrentProbes ?? 3)
    periodicRef?.setIntervalMs(current.probeIntervalMs ?? 10 * 60_000)
    installer.setProxyHosts?.(current.proxyHosts)

    // Free loop on/off + restart on target change (interval fixed 10min).
    const wantRefill = (current.free?.enabled ?? true) && current.enabled !== false
    if (wantRefill && refill === null) {
      refill = new RefillScheduler(pool, { ...admissionDeps, prober })
      // Auto-install when the first refill lands exits (live-observed
      // 2026-09-09): the free-source pool starts EMPTY, so the initial
      // install() below stays deferred ("no exits configured") and nothing
      // ever retried it — the pool filled up but routing never engaged
      // until the user touched settings (reconfigure). Watch the pool and
      // engage routing the moment the first exit is admitted.
      refill.onAdmitted(() => {
        if (!installer.enabled && current.enabled !== false && pool.snapshot().total > 0) {
          installer.install()
          if (installer.enabled) {
            logger.info('opencode2dsh: first free exits admitted — exit routing engaged')
          }
        }
        // The periodic prober was created before any exit existed; start its
        // timer once the table is non-empty (start() is idempotent).
        if (periodicRef !== null && current.enabled !== false) periodicRef.start()
      })
      refill.start()
    } else if (!wantRefill && refill !== null) {
      refill.stop()
      refill = null
    }

    // Subscription layer: (re)create on URL change, keep the fetcher across
    // refresh-interval edits.
    const urls = current.subscriptions ?? []
    if (urls.length === 0 || current.enabled === false) {
      subscriptions?.stop()
      subscriptions = null
      fetcherActive = false
      // A disabled pool must not keep probing (each probe spends anonymous-lane
      // quota, §4.1).
      if (current.enabled === false) periodicRef?.stop()
      return
    }
    const fetcher = ensureSubscriptions(urls)
    if (fetcher !== null) {
      fetcher.setIntervalMs(current.subscription?.refreshMs ?? 30 * 60_000)
      // Applied before start() so the very first refresh already carries the
      // configured UA (airports gate on it — an unlisted one answers 502).
      fetcher.setUserAgent(current.subscription?.userAgent)
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
    const { applyProbeVerdict } = await import('./pool/probe-verdict.ts')
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
            }, { pinned: entry.pinned, previous: { exitIP: entry.exitIP, exitLocation: entry.exitLocation, latencyMs: entry.latencyMs, quality: entry.quality } })
          if (verdict.admitted && verdict.node) {
            // Refresh the node's facts (admission re-measured them).
            pool.add({ ...entry, ...verdict.node, pinned: entry.pinned })
          }
          // ONE verdict path for every source (probe-verdict.ts). It derives the
          // health write from the failure CLASS, so a refused probe no longer
          // strikes a working exit dead (the old blanket `else markDeadStrike`)
          // and a genuinely dead link no longer lingers as 'unknown'.
          const applied = applyProbeVerdict(pool, entry.id, verdict, {
            source: entry.source,
            model,
            pinned: entry.pinned,
          })
          if (!verdict.admitted) break
          // An admitted-but-unverified verdict is no reason to burn the NEXT
          // model's quota on the same broken link.
          if (verdict.degraded && applied !== 'limited') break
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
      const { applyProbeVerdict } = await import('./pool/probe-verdict.ts')
      for (const model of models) {
        admissionDeps.smokeModel = model
        const verdict = entry.source === 'free'
          ? await admitCandidate(admissionDeps, { address: entry.id, protocol: entry.protocol, source: 'free' })
          : await admitTrusted(admissionDeps, {
            address: entry.id,
            protocol: entry.protocol,
            source: entry.source === 'manual' ? 'manual' : 'subscription',
          }, { pinned: entry.pinned, previous: { exitIP: entry.exitIP, exitLocation: entry.exitLocation, latencyMs: entry.latencyMs, quality: entry.quality } })
        if (verdict.admitted && verdict.node) {
          pool.add({ ...entry, ...verdict.node, pinned: entry.pinned })
        }
        // Same shared verdict as probeAll / the subscription fetcher.
        const applied = applyProbeVerdict(pool, entry.id, verdict, {
          source: entry.source,
          model,
          pinned: entry.pinned,
        })
        if (!verdict.admitted) break
        if (verdict.degraded && applied !== 'limited') break
      }
    },
  })

  const probeExit = async (exitId: string): Promise<number> => {
    const entry = pool.list().find((node) => node.id === exitId)
    if (!entry) return 0
    await prober.enqueue(probeExitTask(exitId, entry))
    return 1
  }

  // Periodic health probe (docs §4.3): the loop that re-measures cooled-down,
  // never-probed and dead exits. Without it a subscription node whose smoke
  // failed at admission kept `latencyMs: 0` forever — the refresh path filters
  // `!pool.has(address)` and never revisits a node already in the table.
  const periodic = new PeriodicProber(pool, (exitId) => probeExit(exitId))
  periodicRef = periodic
  if (pool.snapshot().total > 0) periodic.start()

  // Adapter-layer rotate delegate (docs §3.4/§8.1, IP-7): lets zen-adapter
  // restart a pre-content stream on a fresh exit instead of surfacing the
  // intermediate error to the host's retry budget.
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: config.ipPool?.maxRotateAttempts ?? 3 }))

  // Mid-stream failure reporting (docs §3.4/§4.2). The dispatcher's sentinel is
  // disarmed once response headers land, so a body that goes silent from there
  // on is invisible to it: without this the exit that just tore the stream down
  // kept its `ok` mark and its (low) latency, so it stayed at the front of the
  // pick order and the next request could be torn down by the same exit. The
  // closure only reads the pool, which never changes identity, so one install
  // covers every reconfigure.
  setStreamFailureReporter(createStreamFailureReporter(pool, (exitId) => {
    logger.warn(`opencode2dsh: exit ${exitId} went silent mid-stream; recorded and excluded from this turn's rotation`)
  }))

  return {
    pool,
    installer,
    prober,
    periodic,
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
      // rotate ceiling is live-tunable (settings page) — rebuild the delegate
      setRotateDelegate(createRotateDelegate(pool, { maxAttempts: next.ipPool?.maxRotateAttempts ?? 3 }))
      // Dispatcher install state follows enabled + pool occupancy. Every
      // enable flip re-attempts install: when another dispatcher-level plugin
      // owned the slot (R1 deferral), its unload is picked up here without a
      // restart.
      if (enable && !installer.enabled && pool.snapshot().total > 0) {
        installer.install()
        if (installer.enabled) {
          logger.info('opencode2dsh: exit routing recovered — global dispatcher is free again (R1)')
        }
      } else if (!enable && installer.enabled) {
        installer.disable()
      }
      // The periodic loop follows `enabled` and only runs with exits present.
      if (enable && pool.snapshot().total > 0) periodicRef?.start()
      else if (!enable) periodicRef?.stop()
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
      setRotateDelegate(null)
      setStreamFailureReporter(null)
      subscriptions?.stop()
      refill?.stop()
      periodicRef?.stop()
      installer.dispose()
    },
  }
}
