/**
 * Death verification (issue #106) — verify a death when it is recorded, instead
 * of trusting it for the next 30 minutes.
 *
 * `markDeadStrike` flips an exit to `dead` on a SINGLE transport failure
 * (pool.ts §3.5/§4.2), and every real request that dies in transport takes that
 * path:
 *
 *   - the dispatcher's silence sentinel (no callback within `sentinelMs`, which
 *     defaults to 2s and covers proxy dial + CONNECT — a slow exit trips it),
 *   - a real `onResponseError`,
 *   - a body that goes silent after content landed (rotate.ts reporter).
 *
 * Leaving rotation at once is correct (§4.2/§4.3) — re-picking a blackhole exit
 * inside the same turn is worse. But the exit's only route BACK was
 * `PeriodicProber`, whose dead-retry gate is 30 minutes (`DEAD_RETRY_MS`) and
 * whose round is capped at 20 exits. Live report (issue #106): exits were
 * marked dead and stayed dead until the user pressed the manual probe button,
 * and a transient network blip drained the whole pool after a few rotate
 * attempts ("drops connections after a few rotation attempts").
 *
 * So: keep the fast exclusion, add the fast verdict. One verification probe
 * runs per death episode, through the shared `Prober` queue and the same
 * `applyProbeVerdict` path every other probe uses. It cannot mark anything
 * healthy that a normal probe would not, and it costs exactly the probe the
 * periodic loop would have spent 30 minutes later — one smoke on the exit's own
 * quota bucket.
 *
 * Deliberately NOT re-entrant: an id stays in the in-flight set until its probe
 * settles, so a burst of failures on one exit queues one verification, not ten.
 */

import type { ExitPool } from './pool.ts'

export interface DeathVerifierDeps {
  pool: ExitPool
  /** Enqueue one probe of this exit (the runtime's `probeExit`). */
  probe: (exitId: string) => Promise<unknown>
  /** Optional diagnostics sink; a failed verification is never fatal. */
  logger?: { warn(message: string): void }
}

/**
 * Build the verify-on-death hook.
 *
 * The returned function is safe to call for ANY exit id: unknown ids, healthy
 * exits, cooling exits and exits whose (exit, model) pairing was merely refused
 * are ignored. Call it from the transport-failure seam only (never a hot path).
 */
export function createDeathVerifier(deps: DeathVerifierDeps): (exitId: string) => void {
  const verifying = new Set<string>()
  return (exitId) => {
    if (verifying.has(exitId)) return
    const entry = deps.pool.list().find((node) => node.id === exitId)
    // Only a DEATH is verified. A 429 cooldown, a refused pairing or a live
    // exit needs no re-measurement, and probing them here would spend quota for
    // a verdict nothing is waiting on.
    if (entry === undefined || entry.health.state !== 'dead') return
    verifying.add(exitId)
    // Deferred by a microtask on purpose: the caller is the dispatcher's
    // handler callback (a request that is failing right now), and `probe` starts
    // the probe synchronously up to its first await. Queueing first keeps a
    // fresh probe out of the teardown of the request that discovered the death.
    void Promise.resolve()
      .then(() => deps.probe(exitId))
      .catch((err: unknown) => {
        deps.logger?.warn(
          `opencode2dsh: death verification of ${exitId} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
      .finally(() => { verifying.delete(exitId) })
  }
}
