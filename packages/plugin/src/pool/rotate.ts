/**
 * Adapter-layer rotate-retry delegate (docs/ip-pool.md §3.4 / §8.1, IP-7).
 *
 * The dispatcher layer only MARKS a degraded exit; the host's own retry loop
 * then re-enters the adapter, which re-picks through the pool — correct, but
 * every attempt burns one of the host's five retries on the same visible
 * error string ("Connection error." streaks in the user's chat). This module
 * lets the ADAPTER itself retry inside one user-visible request: when a
 * stream fails before any content landed, the adapter asks this delegate
 * whether the failure is exit-shaped (transport / 429 / 401/403) and the pool
 * has another candidate — then transparently restarts the pi-ai stream, which
 * re-picks a fresh exit through the same ALS context.
 *
 * The delegate is set by the runtime assembly (ip-pool.ts) and cleared on
 * dispose, so a disabled pool keeps the adapter's behavior unchanged.
 */

import type { ExitPool } from './pool.ts'

export type RotateFailure = 'transport' | 'limited' | 'refused'

export interface RotateDelegate {
  /**
   * Record the failure against the failed exit (passive-signal parity) and
   * decide whether another rotate attempt is worth it.
   * @param failure - what the stream died of (before any content landed).
   * @param model - the in-flight model (ban-level bookkeeping).
   * @param session - the sticky-session key (broken on rotate).
   * @param attempt - 1-based rotate attempt about to run.
   * @param deterministic - the failure is a property of the exit (upstream
   *        RegionError body); the sticky exit's (exit, model) pairing is
   *        banned at once instead of waiting for a second sample.
   * @returns true to re-pick and restart the stream; false to surface the error.
   */
  decide(failure: RotateFailure, model: string, session: string, attempt: number, deterministic?: boolean): boolean
}

let delegate: RotateDelegate | null = null

/** Install the runtime's rotate delegate (startIpPool). */
export function setRotateDelegate(next: RotateDelegate | null): void {
  delegate = next
}

/**
 * Reports a stream that died AFTER content had already landed.
 *
 * This is the reporting half of the same seam, and it exists because of a gap
 * the dispatcher cannot cover. Its sentinel is disarmed the moment response
 * headers land (`onResponseStart` -> `disarm()`), so once the body goes silent
 * mid-stream there is no longer ANY layer that tells the pool the exit died:
 * the adapter alone sees the watchdog fire, and it used to simply yield a
 * terminal error. The exit therefore stayed `ok` with whatever latency it had
 * measured — i.e. near the front of the pick order — so the SAME exit kept
 * winning the next request and could tear the next stream down too.
 *
 * No rotation here (a partially delivered stream is never replayed, docs 3.4):
 * this only closes the accounting, reusing the pool's existing transport-failure
 * verdict so the exit leaves rotation and the semantics stay uniform.
 */
let failureReporter: ((session: string, model: string) => void) | null = null

/** Install the runtime's stream-failure reporter (startIpPool). */
export function setStreamFailureReporter(next: ((session: string, model: string) => void) | null): void {
  failureReporter = next
}

/** Report a mid-stream death; no-op when no pool is running. */
export function reportStreamFailure(session: string, model: string): void {
  failureReporter?.(session, model)
}

/**
 * Build the reporting half over the live pool (mirrors createRotateDelegate).
 *
 * Reuses the pool's existing transport verdict rather than inventing a second
 * one: a body that stops mid-stream with no error status IS a transport failure
 * by docs §4.2, so `recordPassiveTransport` is exactly the right call and the
 * two-tier semantics stay uniform with the dispatcher's own accounting.
 *
 * `avoid` is what actually fixes the reported symptom: the exit keeps its `ok`
 * mark for a subscription source (disable-only, §3.5) and would otherwise stay
 * at the front of the pick order, so the avoid window is what stops the next
 * request from being torn down by the same exit.
 */
export function createStreamFailureReporter(
  pool: ExitPool,
  onReported?: (exitId: string) => void,
): (session: string, model: string) => void {
  return (session, model) => {
    const failedExit = pool.exitOfSession(session)
    if (failedExit === null) return
    pool.recordPassiveTransport(failedExit)
    pool.avoid(failedExit)
    pool.rerouteSession(session)
    onReported?.(failedExit)
    // `model` is part of the seam for symmetry with the rotate delegate (and
    // for ban-level bookkeeping if this ever grows); the transport verdict is
    // exit-level, so it does not need it today.
    void model
  }
}

/** Ask the installed delegate; false when no pool is running. */
export function shouldRotate(failure: RotateFailure, model: string, session: string, attempt: number, deterministic = false): boolean {
  return delegate?.decide(failure, model, session, attempt, deterministic) ?? false
}

/** Map a pi-ai error message to the failure taxonomy (adapter-side parse). */
export function classifyStreamFailure(errorMessage: string): RotateFailure | null {
  const text = errorMessage.toLowerCase()
  if (/\b429\b|rate.?limit|freeusagelimit/.test(text)) return 'limited'
  if (/\b(?:401|403)\b/.test(text)) return 'refused'
  if (/\b(?:network|connection|socket|fetch|terminated|premature close)\b|\beconn[a-z]+\b|timeout|timed out/.test(text)) return 'transport'
  // 5xx joins the rotate set: through a wild proxy a 500 is as often the
  // proxy mangling the tunnel as the upstream itself — one exit change
  // before taking the error at face value (bounded by maxRotateAttempts).
  if (/\b5\d\d\b|internal server error|server error/.test(text)) return 'transport'
  return null
}

/** True when the error body names a deterministic region block (Zen's
 *  RegionError): the exit's IP cannot serve this model — ban the pairing on
 *  sight instead of collecting two samples (docs 4.2). */
export function isRegionBlocked(errorMessage: string): boolean {
  return /regionerror|not available in your country/i.test(errorMessage)
}

/**
 * Build the runtime delegate over the live pool (ip-pool.ts assembly).
 * Passive bookkeeping mirrors the dispatcher observer: the stream that died
 * before content already recorded its verdict through the routing layer when
 * it could see it — the sentinel covers the mute-connection case — so this
 * delegate only breaks stickiness and checks whether a usable exit remains.
 */
export function createRotateDelegate(pool: ExitPool, options: { maxAttempts?: number } = {}): RotateDelegate {
  const maxAttempts = options.maxAttempts ?? 3
  return {
    decide(failure, model, session, attempt, deterministic = false) {
      // The exit this turn was pinned to (the one that just failed).
      const failedExit = pool.exitOfSession(session)
      // Deterministic refusal (RegionError): ban the sticky exit's pairing
      // immediately — the dispatcher layer recorded the refusal but cannot
      // see the body; the adapter's classify knows it on sight (docs 4.2).
      if (deterministic && failedExit !== null) {
        pool.markModelBanned(failedExit, model)
      }
      // Exclude the exit that just failed THIS turn, however it failed. A first
      // 403 is only 'suspect' (the ban needs a second sample) and a 5xx
      // deliberately does not strike the exit dead, so either left the exit
      // fully usable and the restarted stream re-picked it
      // (measured: `sub-0 -> sub-0 -> sub-5`), spending a rotate attempt on a
      // known-bad exit instead of trying a different one.
      if (failedExit !== null) pool.avoid(failedExit)
      if (attempt > maxAttempts) return false
      // Anything usable for this model left? (pick filters cooldowns, bans,
      // dead.) Nothing usable -> let the error surface honestly.
      const usable = pool.list().some((entry) => pool.isUsable(entry.id, model))
      if (!usable) return false
      // Break the sticky binding so the restarted stream picks a different
      // exit instead of landing on the one that just failed.
      pool.rerouteSession(session)
      return true
    },
  }
}
