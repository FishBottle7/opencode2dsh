/**
 * Installer — global-dispatcher install/swap/restore (docs/ip-pool.md 2, the
 * makeInstaller pattern from dsh-llm-proxy, adapted):
 *
 *  - installs a PoolRoutingDispatcher only while routing is enabled;
 *  - remembers the pre-existing dispatcher and restores it on disable and
 *    on plugin dispose (another dispatcher plugin — e.g. dsh-llm-proxy —
 *    must not stay short-circuited by us);
 *  - disables by restoring + destroying ours.
 *
 * The rotate-retry loop (3.4) is intentionally NOT here: this layer only
 * routes; the adapter-level loop owns failure semantics.
 */

import type { Dispatcher } from 'undici'

import { PoolRoutingDispatcher, type RoutingDispatcherSurface, type UndiciSeam } from './dispatcher.ts'
import type { ExitPool } from './pool.ts'

/** The setter accepts the full Dispatcher; our router exposes the subset
 *  fetch exercises (RoutingDispatcherSurface — same duck-typing contract
 *  dsh-llm-proxy validated on this host). */
type InstallableDispatcher = Parameters<UndiciSeam['setGlobalDispatcher']>[0]

export interface InstallerDeps {
  pool: ExitPool
  undici: UndiciSeam
  proxyHosts?: string[]
  logger?: { info(message: string): void; warn(message: string): void }
}

/**
 * Why the routing layer is not active (docs/ip-pool.md R1, coexistence
 * policy): another dispatcher-level plugin owns the global dispatcher, so we
 * deferred instead of short-circuiting it. Null = routing is active.
 */
export type DeferredReason = string | null

export class RoutingInstaller {
  #deps: InstallerDeps
  #previous: Dispatcher | null = null
  #current: PoolRoutingDispatcher | null = null
  #enabled = false
  #deferredReason: DeferredReason = null

  constructor(deps: InstallerDeps) {
    this.#deps = deps
  }

  get enabled(): boolean {
    return this.#enabled
  }

  /** The deferral reason exposed to the status bridge / settings card. */
  get deferredReason(): DeferredReason {
    return this.#deferredReason
  }

  /** Live re-apply of the proxied-host list (forwards to the running router). */
  setProxyHosts(hosts?: string[]): void {
    this.#deps.proxyHosts = hosts
    this.#current?.setProxyHosts(hosts)
  }

  /**
   * Decide whether installing is safe (docs/ip-pool.md R1 coexistence policy).
   * The global dispatcher slot is single-owner: if another dispatcher-level
   * plugin (dsh-llm-proxy etc.) already installed its own layer, installing
   * ours would short-circuit theirs silently. We defer instead — routing
   * stays off, the pool keeps assembling (exits/probes/settings all live),
   * and the reason surfaces on the settings card. Default Agent instances
   * (undici's own) are not treated as a foreign owner.
   */
  #detectForeignDispatcher(): DeferredReason | null {
    let current: unknown
    try {
      current = this.#deps.undici.getGlobalDispatcher()
    } catch {
      return null
    }
    if (current === null || current === undefined) return null
    const foreign = current as { constructor?: { name?: string } }
    const name = foreign.constructor?.name ?? ''
    // undici's own defaults, plain-object stand-ins (tests, hosts that never
    // installed anything), and anything unnamed are not a foreign plugin.
    if (name === '' || name === 'Object' || name === 'Agent' || name === 'Dispatcher') return null
    if (current instanceof (this.#deps.undici.Agent as unknown as { new (): unknown })) return null
    return `deferred: global dispatcher is owned by "${name}" — install dsh-llm-proxy or the IP pool in one profile only, not both (R1)`
  }

  /** Install (or keep installed) the routing dispatcher. */
  install(): void {
    if (this.#enabled) return
    const foreign = this.#detectForeignDispatcher()
    if (foreign !== null) {
      this.#deferredReason = foreign
      this.#deps.logger?.warn(`opencode2dsh: exit routing ${foreign}`)
      return
    }
    this.#deferredReason = null
    const router = new PoolRoutingDispatcher({
      pool: this.#deps.pool,
      undici: this.#deps.undici,
      proxyHosts: this.#deps.proxyHosts,
      logger: this.#deps.logger,
    })
    const previous = this.#deps.undici.setGlobalDispatcher(router as unknown as InstallableDispatcher)
    // undici's setter returns the replaced dispatcher (void on some hosts)
    if (previous instanceof Object) this.#previous = previous as Dispatcher
    const old = this.#current
    this.#current = router
    this.#enabled = true
    if (old !== null) void old.destroy().catch(() => {})
    this.#deps.logger?.info('opencode2dsh: global dispatcher -> PoolRoutingDispatcher (exit routing enabled)')
  }

  /** Restore the pre-install dispatcher and close ours. */
  disable(): void {
    if (!this.#enabled) return
    this.#enabled = false
    if (this.#previous !== null) {
      try {
        this.#deps.undici.setGlobalDispatcher(this.#previous)
      } catch {
        // the saved dispatcher may already be gone (host teardown) — our
        // uninstall still succeeded for our own layer
      }
      this.#previous = null
    }
    const dying = this.#current
    this.#current = null
    if (dying !== null) void dying.destroy().catch(() => {})
    this.#deps.logger?.info('opencode2dsh: exit routing disabled; previous global dispatcher restored')
  }

  /** Full teardown (plugin dispose): same as disable. */
  dispose(): void {
    this.disable()
  }
}
