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

export class RoutingInstaller {
  #deps: InstallerDeps
  #previous: Dispatcher | null = null
  #current: PoolRoutingDispatcher | null = null
  #enabled = false

  constructor(deps: InstallerDeps) {
    this.#deps = deps
  }

  get enabled(): boolean {
    return this.#enabled
  }

  /** Install (or keep installed) the routing dispatcher. */
  install(): void {
    if (this.#enabled) return
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
