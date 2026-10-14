/**
 * Unified probe verdict — the ONE place a probe outcome becomes pool state
 * (docs/ip-pool.md §4.2 rule table).
 *
 * ## Why this module exists
 *
 * Every probe producer used to apply its own verdict inline, and they
 * disagreed:
 *
 *   - `probeAll` / `probeExit` (ip-pool.ts): `verdict.admitted ? markOk :
 *     markDeadStrike` — treats ALL failures as dead, including `refused`
 *     (401/403: the link is fine, the MODEL is not served here) and
 *     `server-error` (upstream's fault).
 *   - `subscription-fetcher`: `!degraded ? markOk : nothing` — treats NO
 *     failure as dead, so a subscription exit whose link is gone stayed
 *     `unknown` forever. Live-observed 2026-10-14: 703 of 726 subscription
 *     exits sat at `unknown` with zero facts, indistinguishable on the
 *     settings card from a node that had simply never been probed.
 *
 * Neither matched §4.2. This module is the shared classification both call,
 * so the verdict for a given outcome is the same no matter which producer
 * observed it.
 *
 * ## The two layers (this is the whole spec)
 *
 * 1. **Verdict — uniform across sources.** What the failure MEANS is a
 *    property of the exit and the model, never of who supplied the node.
 *    `transport` → dead; `refused` → ban the (exit, model) pairing;
 *    `quota` → exit cooldown; `server-error` / `geo-blocked` / `slow` /
 *    `malformed` → leave health untouched (the link demonstrably answered).
 * 2. **Retention — the ONLY source-dependent rule.** docs §3.5: a dead free
 *    node is evicted so its slot can be refilled; a dead subscription/manual
 *    node is disabled in place, and `PeriodicProber` re-probes it. That split
 *    lives entirely inside `ExitPool.markDeadStrike` and is deliberately not
 *    duplicated here.
 */

import type { AdmissionResult } from './admission.ts'
import type { ExitPool, ProbeFailure } from './pool.ts'

/** What the verdict layer did, for logging/tests. */
export type AppliedVerdict = 'ok' | 'limited' | 'refused' | 'dead' | 'unchanged'

export interface ApplyVerdictOptions {
  /** The exit's source; free nodes are evicted on repeated deaths (§3.5). */
  source: string
  /** The probe model, for (exit × model) ban bookkeeping. */
  model: string
  /** Pinned exits are the user's own line: never struck dead on a probe. */
  pinned?: boolean
}

/**
 * Apply one admission verdict to the pool. Returns what was applied.
 *
 * `pool.add()` is NOT done here — the caller owns node identity (addedAt,
 * exit-IP dedup, insert-vs-refresh) because those differ per producer. This
 * function is purely the verdict→health mapping.
 */
export function applyProbeVerdict(
  pool: ExitPool,
  id: string,
  verdict: AdmissionResult,
  options: ApplyVerdictOptions,
): AppliedVerdict {
  const reason = verdict.reason ?? ''

  // 429 at the smoke: alive exit, verified tunnel, quota consumed elsewhere.
  // Admit and cool; `PeriodicProber` retries when the cooldown expires.
  if (verdict.limited) {
    pool.markLimited(id)
    return 'limited'
  }

  if (!verdict.admitted) {
    return applyFailure(pool, id, verdict.failure, options, reason)
  }

  // Admitted. A degraded verdict means the full chain did NOT clear, so the
  // health write depends on WHY — that is the whole point of this function.
  if (verdict.degraded) {
    return applyFailure(pool, id, verdict.failure, options, reason)
  }

  pool.markOk(id, options.model)
  return 'ok'
}

/** Map a classified failure onto the pool's two-tier health (§4.2). */
function applyFailure(
  pool: ExitPool,
  id: string,
  failure: ProbeFailure | undefined,
  options: ApplyVerdictOptions,
  reason: string,
): AppliedVerdict {
  switch (failure) {
    case 'transport':
      // The link itself is gone (dial fail, SOCKS5 handshake, timeout, reset).
      // A pinned line is the user's own connection: disabling it on a probe
      // would silently kill their only route, so it is left alone (§3.6).
      if (options.pinned === true) {
        pool.markProbeFailure(id, 'transport', reason)
        return 'unchanged'
      }
      pool.markDeadStrike(id, reason)
      return 'dead'

    case 'refused':
      // 401/403 from the model: the exit works, this model is not served
      // here. Ban the pairing, keep the exit (and every other model on it).
      pool.markModelSignal(id, options.model)
      pool.markProbeFailure(id, 'refused', reason)
      return 'refused'

    case 'quota':
      // 429 observed outside the smoke path (e.g. the echo service itself).
      pool.markLimited(id)
      pool.markProbeFailure(id, 'quota', reason)
      return 'limited'

    case 'server-error':
    case 'geo-blocked':
    case 'slow':
    case 'malformed':
    case 'echo-unavailable':
      // The exit ANSWERED. Upstream 5xx is the model's fault behind a healthy
      // exit (pool.recordPassive already made this call on 2026-09-09), a
      // geo-block is a step-2 policy verdict, `slow` is the maxResponseMs
      // gate, and `malformed` means a body we could not read. None of them
      // mean the link died, so health is deliberately left alone — but the
      // failure is still recorded, so the card can say "probed, refused"
      // instead of the indistinguishable 未探活.
      // `echo-unavailable` is the echo-side transport failure: the exit could
      // not reach the IP echo, which says nothing about the real target
      // (opencode.ai). A trusted/pinned exit is kept alive and re-checked via
      // the tunnel step (admitCandidate continues past a failed echo); a free
      // candidate dies at the refill's coarse screen instead (where it is
      // cheaply refilled and no geo/exit-IP could be recorded anyway).
      pool.markProbeFailure(id, failure, reason)
      return 'unchanged'

    default:
      // Unclassified failure (agent construction threw before any request, or
      // a future failure site forgets to classify). Staying 'unknown' is the
      // honest default: it keeps the exit in the table for a later probe
      // without asserting it is dead.
      return 'unchanged'
  }
}
