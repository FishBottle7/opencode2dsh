/**
 * Periodic health probe — the loop docs/ip-pool.md §4.3 promises but the code
 * never had.
 *
 * The doc's trigger table lists a periodic pass over "cooled-down + never-probed
 * + suspect" exits (default 10min), and §4.5 leans on it in several places
 * ("the periodic probe retries when the expiry", "let periodic probing
 * revisit"). Nothing called `probeAll()` on a timer: the only intervals in the
 * runtime were the free-source refill and the subscription pull. Consequences
 * observed live (2026-10-13):
 *
 *  - a subscription node whose smoke failed at admission stayed
 *    `exitIP: '' / latencyMs: 0` FOREVER, because the subscription refresh
 *    filters `!pool.has(address)` and so never re-examined a node already in
 *    the table;
 *  - a 429-cooldown exit was never re-checked after the cooldown expired, so
 *    its facts and health only ever changed if a real request happened to hit
 *    it;
 *  - 'dead' manual/subscription exits (disable-only, never evicted) had no
 *    route back into service at all.
 *
 * This scheduler closes that gap. It is deliberately conservative: one shared
 * interval, never overlapping rounds, and a per-round cap, because every probe
 * spends anonymous-lane quota (§4.1) — the loop must stay cheaper than the
 * traffic it protects.
 */

import type { ExitPool } from './pool.ts'

/** Minimum gap between two dead-retry probes of the SAME exit (docs §4.6).
 *  The first slice of the exponential backoff the doc names; the round cap plus
 *  the rotating cursor space the retries out from there. */
const DEAD_RETRY_MS = 30 * 60_000

/**
 * Minimum gap before re-probing an exit that is STILL unmeasured after a probe
 * (issue #106).
 *
 * The "never probed" bucket is selected on `state === 'unknown' ||
 * latencyMs <= 0`, and nothing in it ever looked at `lastProbedAt`. A trusted
 * exit whose echo endpoint is unreachable at admission is admitted with
 * `latencyMs: 0` and is meant to have its facts re-derived "by a later probe"
 * (admission.ts) — but when the echo stays blocked the probe can never fill
 * them, so the exit matched the bucket again on every single round, forever.
 * That is both a quota burn (a full probe per round, per such exit) and, given
 * the priority order, the mechanism that starved the dead-retry queue behind it
 * (see `select()`). A probed-but-unmeasured exit now waits this long before it
 * may take another slot; a genuinely new exit (`lastProbedAt === 0`) is still
 * due immediately.
 */
const UNMEASURED_RETRY_MS = 30 * 60_000

/**
 * Share of one round reserved for dead retries (issue #106).
 *
 * Recovering a false death is the point of the whole loop (docs §4.3 "dead
 * 复探"): `markDeadStrike` flips an exit to `dead` on ONE transport failure, so
 * a single transient network error takes a working exit out of rotation. Dead
 * retries still sat LAST in the priority list and were then dropped by the
 * per-round cap — with >= maxPerRound cooled/never-probed/stale exits the dead
 * queue never ran at all, and the user's only way back was the manual probe
 * button (issue #106: "If I do not manually click the probe, ..."). A quarter
 * of the round is now reserved for dead retries; unused slots flow back to the
 * live buckets, and the live buckets keep their priority within the rest.
 */
const DEAD_RETRY_SHARE = 0.25

/** Default tick (docs §4.6 probeIntervalMs): shared by the constructor default,
 *  the runtime's boot seed and the /status stub so they cannot drift apart. */
export const DEFAULT_PROBE_INTERVAL_MS = 10 * 60_000

export interface PeriodicProbeOptions {
  /** Tick interval (docs §4.6 probeIntervalMs, default 10min). */
  intervalMs?: number
  /** Most exits to re-probe per round (quota guard, default 20). */
  maxPerRound?: number
  /** Clock seam for tests. */
  now?: () => number
  /** Cooldown between two urgent rounds (quota guard, default 5min). */
  urgentCooldownMs?: number
}

/** Which exits a round should revisit, in priority order (docs §4.3). */
export interface ProbeCandidate {
  id: string
  reason: 'cooled' | 'never-probed' | 'dead-retry' | 'stale'
}

/**
 * The live (non-dead) buckets, in priority order. Dead retries are deliberately
 * not part of this union: they carry their own rotation (`#deadCursor`) and are
 * appended after the reserved live share.
 */
type LiveReason = 'cooled' | 'never-probed' | 'stale'
type LiveCandidate = ProbeCandidate & { reason: LiveReason }

export class PeriodicProber {
  readonly #pool: ExitPool
  readonly #enqueue: (exitId: string) => Promise<unknown>
  #intervalMs: number
  #maxPerRound: number
  #now: () => number
  #timer: NodeJS.Timeout | null = null
  #running = false
  #stopped = false
  #lastRunAt = 0
  #lastQueued = 0
  /** Timestamp of the last URGENT round (its own quota guard). */
  #lastUrgentAt = 0
  /** Cooldown between two urgent rounds (quota guard). */
  #urgentCooldownMs: number
  /** Rotating start offset into the due dead-retry list, so consecutive rounds
   *  cover different slices instead of re-probing the same head forever. */
  #deadCursor = 0
  /** Rotating start offset per live bucket (issue #106): insertion order plus a
   *  stable cap re-probes the same head of the list every round, so the rest of
   *  the bucket never gets measured. */
  readonly #bucketCursor: Record<LiveReason, number> = { cooled: 0, 'never-probed': 0, stale: 0 }

  constructor(
    pool: ExitPool,
    enqueue: (exitId: string) => Promise<unknown>,
    options: PeriodicProbeOptions = {},
  ) {
    this.#pool = pool
    this.#enqueue = enqueue
    this.#intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS
    this.#maxPerRound = options.maxPerRound ?? 20
    this.#urgentCooldownMs = options.urgentCooldownMs ?? 5 * 60_000
    this.#now = options.now ?? Date.now
  }

  get stats(): { running: boolean; lastRunAt: number; lastQueued: number; intervalMs: number } {
    return {
      running: this.#running,
      lastRunAt: this.#lastRunAt,
      lastQueued: this.#lastQueued,
      intervalMs: this.#intervalMs,
    }
  }

  /** Live re-apply of the tick interval (settings page, §5.1). */
  setIntervalMs(ms: number): void {
    const next = Math.max(60_000, ms)
    if (next === this.#intervalMs) return
    this.#intervalMs = next
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = setInterval(() => void this.tick(), this.#intervalMs)
      this.#timer.unref?.()
    }
  }

  start(): void {
    // Clear the stop() latch: applyConfig toggles stop()/start() on every
    // settings disable->enable cycle, and a latch that never resets would
    // leave the prober dead for the rest of the process lifetime (unlike
    // the fetcher/refill, this object is created once and reused).
    this.#stopped = false
    if (this.#timer !== null) return
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Exits worth re-probing right now. Pure read of pool state, so the selection
   * is unit-testable without timers.
   *
   * Priority (docs §4.3): cooled → never-probed → stale, then dead retries —
   * which also get a RESERVED share of the round (`DEAD_RETRY_SHARE`). The
   * history behind both rules lives on `#selectableDeadRetries` and on those two
   * constants; a second copy here is how the two descriptions end up drifting
   * apart.
   *
   * @param options.ignoreDeadGate - include dead exits regardless of the
   *        DEAD_RETRY_MS backoff. ONLY for the starvation path (`urgent`):
   *        the gate exists to keep routine rounds cheap, but when the pool has
   *        nothing usable left, waiting it out IS the outage (issue #106).
   */
  select(now = this.#now(), options: { ignoreDeadGate?: boolean } = {}): ProbeCandidate[] {
    const cooled: LiveCandidate[] = []
    const neverProbed: LiveCandidate[] = []
    const stale: LiveCandidate[] = []
    const deadDue: string[] = []
    for (const entry of this.#pool.list()) {
      const health = entry.health
      // A probe already in flight for this exit owns it (per-exit serial, §4.1).
      if (health.inflight) continue
      if (health.state === 'dead') {
        // dead retry (docs §4.6 deadRetryMs): dead exits get another chance;
        // manual/subscription ones are disable-only and would otherwise never
        // come back. `urgent` bypasses the gate: it runs when the pool has no
        // usable exit left, and the gate's quota math inverts at that point.
        if (options.ignoreDeadGate === true || now - health.lastProbedAt >= DEAD_RETRY_MS) {
          deadDue.push(entry.id)
        }
        continue
      }
      if (health.cooldownUntil > now) continue // still cooling: probing now wastes quota
      if (health.cooldownUntil !== 0) {
        // cooldown just expired -> re-measure instead of trusting stale facts
        cooled.push({ id: entry.id, reason: 'cooled' })
        continue
      }
      if (health.state === 'unknown' || entry.latencyMs <= 0) {
        // Issue #106: an exit that a previous probe already failed to measure
        // must not jump the queue every round (and starve everything else).
        if (health.lastProbedAt !== 0 && now - health.lastProbedAt < UNMEASURED_RETRY_MS) continue
        neverProbed.push({ id: entry.id, reason: 'never-probed' })
        continue
      }
      const banSuspect = entry.bans.some((b) => b.ban.state === 'suspect')
      if (banSuspect) {
        stale.push({ id: entry.id, reason: 'stale' })
      }
    }

    // Reserve the dead share first, then let the live buckets (still in
    // priority order, but rotating within each bucket) fill what is left.
    const reserve = Math.min(
      deadDue.length,
      Math.max(1, Math.floor(this.#maxPerRound * DEAD_RETRY_SHARE)),
    )
    const liveCap = Math.max(0, this.#maxPerRound - reserve)
    const out: ProbeCandidate[] = []
    const take = (reason: LiveReason, bucket: LiveCandidate[]): void => {
      const room = liveCap - out.length
      if (room > 0) out.push(...this.#rotate(reason, bucket, room))
    }
    take('cooled', cooled)
    take('never-probed', neverProbed)
    take('stale', stale)
    // Dead retries take the reserved slots and then any room the live buckets
    // left unused; #selectableDeadRetries advances its cursor by exactly what
    // it hands out, so no retry window is skipped.
    for (const id of this.#selectableDeadRetries(deadDue, this.#maxPerRound - out.length)) {
      out.push({ id, reason: 'dead-retry' })
    }
    return out
  }

  /** `take` entries of one live bucket starting at that bucket's rotating offset. */
  #rotate(reason: LiveReason, bucket: LiveCandidate[], take: number): LiveCandidate[] {
    if (bucket.length === 0 || take <= 0) return []
    const start = this.#bucketCursor[reason] % bucket.length
    const count = Math.min(take, bucket.length)
    const out: LiveCandidate[] = []
    for (let i = 0; i < count; i += 1) out.push(bucket[(start + i) % bucket.length]!)
    this.#bucketCursor[reason] = (start + count) % bucket.length
    return out
  }

  /**
   * The next `limit` due dead exits to retry, starting at the rotating offset.
   *
   * Two rules, both learned from the live pool of 559 dead subscription exits:
   *
   *  1. **A cooldown gate.** `deadRetryMs` is the first slice of the backoff
   *     docs §4.6 names but the code never had: without it a proven-dead exit
   *     was re-probed every single round, which is pure quota spend to
   *     re-derive a verdict that almost never changes (23 of 24 sampled
   *     subscription failures were `transport`, and a gone link does not heal by
   *     waiting).
   *  2. **A rotating start offset.** Both `pool.list()` insertion order and the
   *     per-round cap are stable, so without a rotation the same head of the
   *     list wins forever and everything past `maxPerRound` starves. The offset
   *     advances by exactly what this round consumed, so the retry window walks
   *     the whole table and a recovered exit eventually gets its chance back —
   *     which matters because a subscription node is disable-only (§3.5) and has
   *     no other route in.
   *
   * Takes the due id list instead of re-deriving it, because the caller already
   * walked the table once (issue #106 split the "who is due" scan from the
   * "who gets the reserved share" decision). The caller also guarantees `limit`
   * slots for the result (`DEAD_RETRY_SHARE`), which is what stops the live
   * buckets from truncating this list away entirely.
   */
  #selectableDeadRetries(due: string[], limit: number): string[] {
    if (due.length === 0 || limit <= 0) return []
    const offset = this.#deadCursor % due.length
    const count = Math.min(limit, due.length)
    const out: string[] = []
    for (let i = 0; i < count; i += 1) out.push(due[(offset + i) % due.length]!)
    // Advance by what was actually handed out: advancing by the full round
    // while only a reserved share is used would silently skip retry windows.
    this.#deadCursor = (offset + count) % due.length
    return out
  }

  /** One round; skipped while the previous one is still draining. */
  async tick(): Promise<void> {
    await this.#round(false)
  }

  /**
   * Starvation fast-path (issue #106): one round that IGNORES the
   * DEAD_RETRY_MS backoff, triggered by the dispatcher when a proxied request
   * finds the pool non-empty but with no usable exit (`pick() -> null`).
   *
   * Layering with #107's verify-on-death: the verifier is the FIRST opinion on
   * a single death (one re-probe per death episode); this is the fallback for
   * when the whole table is down — a shared cause (sing-box crash, local
   * outage) killed every exit, the verifier's probes die through the same
   * broken tunnel, and nothing would retry for 30 minutes. Every urgent round
   * re-sweeps the dead table for a recovery the moment it happens.
   *
   * Quota guard: cooled exits are still excluded (probing a 429-cooling exit
   * answers 429 and extends its backoff — waiting there is correct), the
   * per-round cap and the reserved-share math still apply, and consecutive
   * urgent rounds are spaced by urgentCooldownMs (default 5min) so a genuinely
   * all-dead pool burns at most ~20 smokes per 5 minutes instead of one per
   * failing request.
   */
  async urgent(): Promise<void> {
    if (this.#stopped) return
    if (this.#running) return
    const now = this.#now()
    if (now - this.#lastUrgentAt < this.#urgentCooldownMs) return
    this.#lastUrgentAt = now
    await this.#round(true)
  }

  /** Shared round body; `ignoreDeadGate` passes through to select(). */
  async #round(ignoreDeadGate: boolean): Promise<void> {
    if (this.#running || this.#stopped) return
    this.#running = true
    try {
      const candidates = this.select(this.#now(), { ignoreDeadGate })
      this.#lastRunAt = this.#now()
      this.#lastQueued = candidates.length
      // Enqueue the whole round at once (issue #106). `#enqueue` resolves only
      // once the probe has actually RUN, so awaiting the candidates one by one
      // serialized a round to a single probe at a time — the Prober's
      // `maxConcurrentProbes` (default 3) was never used from here, and a round
      // of timeout-prone exits could outlast the tick interval entirely (the
      // next tick is skipped while `#running`). The Prober still owns per-exit
      // serialization and the global concurrency cap, so nothing overlaps that
      // should not.
      await Promise.allSettled(candidates.map((candidate) => this.#enqueue(candidate.id)))
    } finally {
      this.#running = false
    }
  }
}
