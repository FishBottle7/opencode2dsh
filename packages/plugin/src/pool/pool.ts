/**
 * ExitPool — the exit-node table plus two-tier health and the four-state
 * refill machine (docs/ip-pool.md section 3).
 *
 * Tier 1, per-exit (ExitHealth): 429 cooldown + dead marking. Anonymous
 * quota is metered per exit IP (design.md section 3), so a 429 cools the
 * whole exit while other exits keep serving.
 *
 * Tier 2, per-(exit x model) (ModelBan): 401/403 refusals are usually
 * model-level (region blocks, delisting — see the muse/hy3 notes in
 * catalog.ts), so they ban only that pairing and never cool the exit.
 *
 * The pool is pure state: no IO, no timers. The prober, the dispatcher and
 * the refill scheduler all drive it through the mark* methods and read it
 * through pick()/snapshot(). injectable now() keeps the cooldown math
 * unit-testable.
 */

export type ExitSource = 'free' | 'manual' | 'subscription' | 'goproxy'

/**
 * Transport used to reach the exit. `https` is an HTTP proxy whose OWN hop is
 * TLS-wrapped (`https://host:port` in a subscription) — a different wire
 * protocol from plaintext `http`, not a cosmetic variant. Conflating the two
 * is a measured defect, not a style choice; see dispatcher.exitProxyUri.
 */
export type ExitProtocol = 'http' | 'https' | 'socks5'

/**
 * Why a probe failed, classified at the failure site (docs/ip-pool.md §4.2
 * rule table). Declared HERE rather than in admission.ts because it is part
 * of the pool's own vocabulary — `ExitHealth` records it — and admission.ts
 * already imports this module, so the other direction would be circular.
 *
 * Only `transport` legitimately means "this link is dead" (dial failure,
 * SOCKS5 handshake failure, timeout, socket reset — the node never answered).
 * Every other class means the exit DID answer, so striking it dead would kill
 * a working route. Live-observed 2026-10-14: 23 of 24 sampled subscription
 * failures were `transport`, 1 was a refusal.
 */
export type ProbeFailure =
  | 'transport'
  | 'refused'
  | 'server-error'
  | 'quota'
  | 'geo-blocked'
  | 'slow'
  | 'malformed'
  /**
   * The echo step could not reach its endpoint at all (connect timeout, SOCKS5
   * handshake failure, socket reset to the IP echo). Distinct from
   * `transport`: an echo-side network failure says nothing about whether the
   * exit can reach the REAL target (`opencode.ai`), so a trusted-path probe
   * continues to the tunnel step rather than striking the exit dead. Free
   * candidates still die here (they are cheap to refill, and a node that
   * cannot reach the echo also cannot have its geo/exit-IP recorded).
   */
  | 'echo-unavailable'

export interface ExitNode {
  /** host:port, unique inside the pool (the address we dial). */
  id: string
  protocol: ExitProtocol
  source: ExitSource
  /** Fixed primary exit (docs/ip-pool.md 3.6). */
  pinned: boolean
  /** Empty for pinned nodes whose admission could not read it (3.1). */
  exitIP: string
  exitLocation: string
  latencyMs: number
  quality: 'S' | 'A' | 'B' | 'C'
  addedAt: number
}

export type ExitState = 'unknown' | 'ok' | 'dead'
export type BanState = 'ok' | 'suspect' | 'banned'
interface ExitHealth {
  state: ExitState
  lastProbedAt: number
  consecutiveLimited: number
  /** 429 cooldown deadline (epoch ms); 0 = not cooling. */
  cooldownUntil: number
  /** Serial-probe lock slot: at most one in-flight probe per exit (4.1). */
  inflight: boolean
  /** Consecutive dead rechecks; eviction after deadEvictions (3.5). */
  deadStrikes: number
  /**
   * Why the last probe failed, classified (see probe-verdict.ts). Empty means
   * the exit has never failed a probe. This is what separates "never probed"
   * from "probed and the link was gone" on the settings card — live-observed
   * 2026-10-14, 703 of 726 subscription exits rendered as the same
   * "未探活" whether or not a probe had ever run against them.
   */
  lastProbeFailure: ProbeFailure | ''
  /** Human-readable detail for the same failure (diagnostics only). */
  lastProbeReason: string
}

interface ModelBan {
  state: BanState
  bannedAt: number
  consecutiveFailures: number
}

export type PoolState = 'healthy' | 'warning' | 'critical' | 'emergency'

export interface PoolOptions {
  /** Free-pool target capacity (docs/ip-pool.md 3.5). Free-source nodes only. */
  targetSize?: number
  /** First 429 cooldown. */
  limitedCooldownBaseMs?: number
  /** Exponential backoff ceiling. */
  limitedCooldownMaxMs?: number
  /** Suspect -> banned after this many consecutive 401/403. */
  modelBanConfirmations?: number
  /** Dead exits are evicted after this many probe strikes (free source only). */
  deadEvictions?: number
  /** How long a session avoids the exit that just failed it (rotate escape). */
  avoidMs?: number
  now?: () => number
}

/** Quality grade from admission latency (GoProxy thresholds). */
export function gradeOf(latencyMs: number): ExitNode['quality'] {
  if (latencyMs <= 500) return 'S'
  if (latencyMs <= 1000) return 'A'
  if (latencyMs <= 2000) return 'B'
  return 'C'
}

/**
 * Sort key for latency. `0` means "never measured" (a trusted-conversion
 * fallback, or a manual entry before its first probe), NOT "instantaneously
 * fast". Treating it as a real measurement put unverified exits ahead of every
 * exit that had actually answered, so it sorts last instead.
 */
function latencyRank(latencyMs: number): number {
  return latencyMs > 0 ? latencyMs : Number.POSITIVE_INFINITY
}

const banKey = (exitId: string, model: string) => `${exitId}\u0000${model}`

export class ExitPool {
  readonly #nodes = new Map<string, ExitNode>()
  readonly #health = new Map<string, ExitHealth>()
  readonly #bans = new Map<string, ModelBan>()
  /** exitId -> its ban records, so per-exit lookups never scan all bans. */
  readonly #bansByExit = new Map<string, Map<string, ModelBan>>()
  readonly #sessionExit = new Map<string, string>()
  /** Passive-signal counters per exit (docs/ip-pool.md §4.3 被动 + IP-6 stats). */
  readonly #passive = new Map<string, { ok: number; limited: number; refused: number; dead: number; transport: number }>()
  #targetSize: number
  #cooldownBase: number
  #cooldownMax: number
  #banConfirmations: number
  #deadEvictions: number
  #avoidMs: number
  /** exitId -> epoch ms until which a rotate loop should skip it (§3.4). */
  readonly #avoidUntil = new Map<string, number>()
  #now: () => number

  constructor(options: PoolOptions = {}) {
    this.#targetSize = options.targetSize ?? 20
    this.#cooldownBase = options.limitedCooldownBaseMs ?? 60_000
    this.#cooldownMax = options.limitedCooldownMaxMs ?? 30 * 60_000
    this.#banConfirmations = options.modelBanConfirmations ?? 2
    this.#deadEvictions = options.deadEvictions ?? 2
    this.#avoidMs = options.avoidMs ?? 30_000
    this.#now = options.now ?? Date.now
  }

  /** Live re-apply of the free-pool target capacity (settings page, §5.1). */
  setTargetSize(value: number): void {
    this.#targetSize = Math.max(1, value)
  }

  /** The effective target capacity (diagnostics / status bridge). */
  get targetSize(): number {
    return this.#targetSize
  }

  // -- table management ------------------------------------------------------

  /** Upsert a node (admission wrote its details); returns false on duplicate
   *  exit IP for a different address — two addresses sharing one exit IP are
   *  one quota bucket and must not both live in the pool (3.1). */
  add(node: ExitNode): boolean {
    if (node.exitIP !== '' && this.#hasExitIP(node.exitIP, node.id)) return false
    this.#nodes.set(node.id, node)
    if (!this.#health.has(node.id)) {
      this.#health.set(node.id, {
        state: 'unknown',
        lastProbedAt: 0,
        consecutiveLimited: 0,
        cooldownUntil: 0,
        inflight: false,
        deadStrikes: 0,
        lastProbeFailure: '',
        lastProbeReason: '',
      })
    }
    return true
  }

  #hasExitIP(exitIP: string, exceptId: string): boolean {
    for (const node of this.#nodes.values()) {
      if (node.id !== exceptId && node.exitIP === exitIP) return true
    }
    return false
  }

  has(id: string): boolean {
    return this.#nodes.has(id)
  }

  get(id: string): ExitNode | undefined {
    return this.#nodes.get(id)
  }

  /** Drop a node entirely (dead eviction for free nodes, cleanup otherwise). */
  remove(id: string): void {
    this.#nodes.delete(id)
    this.#health.delete(id)
    this.#passive.delete(id)
    this.#avoidUntil.delete(id)
    const nodeBans = this.#bansByExit.get(id)
    if (nodeBans !== undefined) {
      for (const model of nodeBans.keys()) this.#bans.delete(banKey(id, model))
      this.#bansByExit.delete(id)
    }
    for (const [session, exitId] of this.#sessionExit) {
      if (exitId === id) this.#sessionExit.delete(session)
    }
    this.#clearPinnedIf(id)
  }

  /** Single write path for ban records, keeping the per-exit index in sync. */
  #setBan(id: string, model: string, ban: ModelBan): void {
    this.#bans.set(banKey(id, model), ban)
    let nodeBans = this.#bansByExit.get(id)
    if (nodeBans === undefined) {
      nodeBans = new Map<string, ModelBan>()
      this.#bansByExit.set(id, nodeBans)
    }
    nodeBans.set(model, ban)
  }

  /** Disable without dropping (dead manual/subscription/goproxy nodes, 3.5). */
  markDead(id: string): void {
    const health = this.#health.get(id)
    if (!health) return
    health.state = 'dead'
    health.inflight = false
    if (health.lastProbeFailure === '') health.lastProbeFailure = 'transport'
  }

  #clearPinnedIf(id: string): void {
    if (this.pinnedId === id) this.pinnedId = ''
  }

  pinnedId = ''

  /** Pin a node (docs/ip-pool.md 3.6); unpinning any previous pinned node. */
  pin(id: string): boolean {
    if (!this.#nodes.has(id)) return false
    this.pinnedId = id
    return true
  }

  unpin(): void {
    this.pinnedId = ''
  }

  // -- probe locking (4.1: serial per exit) -----------------------------------

  /** Try to take the exit's serial-probe slot; false when already taken. */
  takeProbeLock(id: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.inflight) return false
    health.inflight = true
    return true
  }

  releaseProbeLock(id: string): void {
    const health = this.#health.get(id)
    if (health) health.inflight = false
  }

  // -- passive & probe signals (rule table 4.2) --------------------------------

  markOk(id: string, model?: string): void {
    const health = this.#health.get(id)
    if (health) {
      health.state = 'ok'
      health.lastProbedAt = this.#now()
      health.consecutiveLimited = 0
      health.cooldownUntil = 0
      health.deadStrikes = 0
      // A passing probe clears the failure record: "last probe failed" must
      // never outlive the probe that superseded it.
      health.lastProbeFailure = ''
      health.lastProbeReason = ''
    }
    if (model !== undefined) {
      this.#setBan(id, model, { state: 'ok', bannedAt: 0, consecutiveFailures: 0 })
    }
  }

  /**
   * Record a failed probe's class + reason without touching health.
   *
   * Split out of the mark* family deliberately: several failure classes
   * (server-error, geo-blocked, slow, malformed) must leave the exit's health
   * EXACTLY as it was — the node answered, it just could not serve this probe
   * — yet the settings card still needs to show "probed, and here is why it
   * did not pass" instead of the indistinguishable 未探活. The single
   * write path keeps `lastProbeFailure` and `lastProbeReason` consistent.
   */
  markProbeFailure(id: string, failure: ProbeFailure, reason = ''): void {
    const health = this.#health.get(id)
    if (!health) return
    health.lastProbedAt = this.#now()
    health.lastProbeFailure = failure
    health.lastProbeReason = reason
  }

  /** 429: exit-level cooldown with exponential backoff (3.2 / 4.6). */
  markLimited(id: string): number {
    const health = this.#health.get(id)
    if (!health) return 0
    health.consecutiveLimited += 1
    health.state = 'ok'
    // A 429 is a VERIFIED-ALIVE verdict (the request reached the upstream and
    // came back metered), so it supersedes any older failure record — a stale
    // "probe failed" label next to a cooling-but-working exit would be a lie.
    // The echo-step 429 goes through markProbeFailure AFTER this call, so that
    // narrower case still records itself.
    health.lastProbeFailure = ''
    health.lastProbeReason = ''
    const backoff = Math.min(
      this.#cooldownBase * 2 ** (health.consecutiveLimited - 1),
      this.#cooldownMax,
    )
    health.cooldownUntil = this.#now() + backoff
    return health.cooldownUntil
  }

  /** Deterministic refusal (upstream RegionError: region blocks are a
   *  property of the exit, not transient noise) — ban the pairing at once. */
  markModelBanned(id: string, model: string): void {
    this.#setBan(id, model, { state: 'banned', bannedAt: this.#now(), consecutiveFailures: this.#banConfirmations })
  }

  /** 401/403: model-level suspicion; banned after N consecutive (3.2). */
  markModelSignal(id: string, model: string): BanState {
    const current = this.#bans.get(banKey(id, model)) ?? { state: 'ok' as BanState, bannedAt: 0, consecutiveFailures: 0 }
    current.consecutiveFailures += 1
    if (current.consecutiveFailures >= this.#banConfirmations && current.state !== 'banned') {
      current.state = 'banned'
      current.bannedAt = this.#now()
    } else if (current.state !== 'banned') {
      current.state = 'suspect'
    }
    this.#setBan(id, model, current)
    return current.state
  }

  /** Transport failure / 5xx / probe timeout: dead, with free-source eviction
   *  after repeated strikes (3.5). Returns true when the node was evicted.
   *
   *  This is the ONLY source-dependent rule in the health model (docs 3.5):
   *  a dead `free` node is dropped so its slot can be refilled, while a dead
   *  manual/subscription node is disabled in place and re-probed by
   *  `PeriodicProber`. The verdict itself — that the link is gone — is uniform. */
  markDeadStrike(id: string, reason = ''): boolean {
    const node = this.#nodes.get(id)
    const health = this.#health.get(id)
    if (!node || !health) return false
    health.state = 'dead'
    health.inflight = false
    health.deadStrikes += 1
    health.lastProbeFailure = 'transport'
    if (reason !== '') health.lastProbeReason = reason
    if (node.source === 'free' && health.deadStrikes >= this.#deadEvictions) {
      this.remove(id)
      return true
    }
    return false
  }

  /**
   * Passive signal from a REAL request outcome (docs/ip-pool.md §4.2 rule
   * table, §4.3 被动 row): one response header read at the routing layer,
   * applied to the two-tier health exactly like a probe would. Returns the
   * classification for diagnostics.
   */
  recordPassive(id: string, statusCode: number, model: string, regionBlocked = false): 'ok' | 'limited' | 'refused' | 'dead' {
    if (!this.#nodes.has(id)) return 'ok'
    if (statusCode >= 200 && statusCode < 300) {
      this.markOk(id, model)
      this.#countPassive(id, 'ok')
      return 'ok'
    }
    if (statusCode === 429) {
      this.markLimited(id)
      this.#countPassive(id, 'limited')
      return 'limited'
    }
    if (statusCode === 401 || statusCode === 403) {
      // RegionError bodies are deterministic region blocks — a second sample
      // adds nothing, so ban the (exit, model) pairing immediately (docs 4.2).
      if (regionBlocked) this.markModelBanned(id, model)
      else this.markModelSignal(id, model)
      this.#countPassive(id, 'refused')
      return 'refused'
    }
    // 5xx: count into the dead bucket for diagnostics, but DO NOT strike the
    // exit dead. Live-observed 2026-09-09: upstream 500s are often the MODEL
    // failing behind a healthy exit (muse without contributor access answers
    // 500 through every exit) — one strike used to mark the exit dead, the
    // single-exit pool then picked null, and ALL traffic silently fell back
    // direct while the pool looked enabled. Exit liveness stays the
    // transport layer's call (sentinel/onResponseError); recovery for a
    // 5xx-flapping exit is the adapter rotate loop (5xx is in its set).
    this.#countPassive(id, 'dead')
    return 'dead'
  }

  /** Transport-level failure of a real request (connection died mid-flight). */
  recordPassiveTransport(id: string): void {
    if (!this.#nodes.has(id)) return
    this.markDeadStrike(id)
    this.#countPassive(id, 'transport')
  }

  /** Drop the session's sticky exit when its exit degraded (§3.3). */
  rerouteSession(session: string): void {
    this.#sessionExit.delete(session)
  }

  /** The session's current sticky exit, if any (adapter-side 403 bookkeeping:
   *  the dispatcher recorded the refusal against this exit). */
  exitOfSession(session: string): string | null {
    return this.#sessionExit.get(session) ?? null
  }

  #countPassive(id: string, kind: 'ok' | 'limited' | 'refused' | 'dead' | 'transport'): void {
    const bucket = this.#passive.get(id) ?? { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 }
    if (kind === 'limited') bucket.limited += 1
    else if (kind === 'refused') bucket.refused += 1
    else if (kind === 'dead') bucket.dead += 1
    else if (kind === 'transport') bucket.transport += 1
    else bucket.ok += 1
    this.#passive.set(id, bucket)
  }

  /** Passive-signal counters for one exit (status bridge, IP-6). */
  passiveStats(id: string): { ok: number; limited: number; refused: number; dead: number; transport: number } {
    return { ...(this.#passive.get(id) ?? { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 }) }
  }

  // -- selection (3.3) ---------------------------------------------------------

  isUsable(id: string, model: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.state === 'dead') return false
    if (health.cooldownUntil > this.#now()) return false
    const ban = this.#bans.get(banKey(id, model))
    return ban?.state !== 'banned'
  }

  /**
   * Mark an exit as "just failed this request" so the rotate loop in the same
   * user turn moves on. A 403 whose ban still needs a second sample, and a 5xx
   * (which deliberately does not strike the exit dead), both leave
   * `isUsable()` true — without this the restarted stream re-picked the very
   * exit that had just failed it (measured: `sub-0 -> sub-0 -> sub-5`).
   */
  avoid(id: string): void {
    if (!this.#nodes.has(id)) return
    this.#avoidUntil.set(id, this.#now() + this.#avoidMs)
  }

  /** Exits currently in a rotate-avoid window. */
  #avoiding(id: string): boolean {
    const until = this.#avoidUntil.get(id)
    if (until === undefined) return false
    if (until > this.#now()) return true
    this.#avoidUntil.delete(id)
    return false
  }

  /**
   * Pick the exit for one upstream request. Pinned wins while usable (3.6);
   * the rotation pool then prefers session stickiness, health, fewer
   * cooldowns and lower latency with a same-tier shuffle. Pure; no IO.
   */
  pick(session: string, model: string): string | null {
    if (this.pinnedId !== '' && this.isUsable(this.pinnedId, model)) return this.pinnedId

    const last = this.#sessionExit.get(session)
    // Stickiness yields to an in-flight probe as well as to the avoid window:
    // re-pinning the same exit while it is being probed would hand real
    // traffic straight back to the exit that is spending the quota.
    if (last !== undefined && this.isUsable(last, model) && !this.#avoiding(last) && this.#health.get(last)?.inflight !== true) return last

    const usable = [...this.#nodes.keys()].filter((id) => this.isUsable(id, model))
    if (usable.length === 0) return null
    // Prefer exits outside the rotate-avoid window; when EVERY candidate is
    // avoiding (a single-exit pool mid-rotation) fall back to the full set
    // rather than returning null and silently going direct.
    const preferred = usable.filter((id) => !this.#avoiding(id))
    const candidates = preferred.length > 0 ? preferred : usable
    const health = (id: string) => this.#health.get(id)!
    const node = (id: string) => this.#nodes.get(id)!
    candidates.sort((left, right) => {
      const a = health(left)
      const b = health(right)
      const stateRank = (h: ExitHealth) => (h.state === 'ok' ? 0 : 1)
      const byState = stateRank(a) - stateRank(b)
      if (byState !== 0) return byState
      // An exit whose health probe is in flight is DEPRIORITIZED, not banned.
      // The probe and real traffic share one anonymous quota bucket per exit
      // IP (§4.1), so preferring an exit that is being probed right now is how
      // an `ok`-looking exit still answers 429. Depriving it of PRIORITY (last,
      // after every idle candidate) keeps real traffic off it while probes run
      // without ever emptying the pool: when every usable exit is being probed,
      // this ranking still returns one, so traffic never falls through to direct
      // just because a probe sweep happens to be in progress.
      const busyRank = (h: ExitHealth) => (h.inflight ? 1 : 0)
      const byInflight = busyRank(a) - busyRank(b)
      if (byInflight !== 0) return byInflight
      const byLimited = a.consecutiveLimited - b.consecutiveLimited
      if (byLimited !== 0) return byLimited
      const byLatency = latencyRank(node(left).latencyMs) - latencyRank(node(right).latencyMs)
      if (byLatency !== 0) return byLatency
      return Math.random() < 0.5 ? -1 : 1
    })
    const chosen = candidates[0]
    if (chosen === undefined) return null
    this.#sessionExit.set(session, chosen)
    return chosen
  }

  // -- four-state machine (3.5) -------------------------------------------------

  /** Usable = not dead, not cooling, and not banned for every probe model —
   *  approximation: nodes banned for all their known models count as
   *  unusable; with no ban data they stay usable (they are only banned for
   *  specific models, which the caller's model already filters). */
  #isAvailable(id: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.state === 'dead') return false
    if (health.cooldownUntil > this.#now()) return false
    // A node with at least one banned pairing and no healthy pairing for any
    // model it serves is effectively exhausted. Track by distinct models.
    // Indexed by exit: the previous form walked every ban for every node, so
    // state()/admissionQuota() were O(nodes x bans) on each refill tick — with
    // a subscription pool (470 exits, one ban key per probed model) that ran on
    // every state read.
    const nodeBans = this.#bansByExit.get(id)
    if (nodeBans === undefined || nodeBans.size === 0) return true
    let allBanned = true
    for (const ban of nodeBans.values()) {
      if (ban.state !== 'banned') {
        allBanned = false
        break
      }
    }
    return !allBanned
  }

  /** Count usable free-source nodes toward the refill thresholds. */
  availableFreeCount(): number {
    let count = 0
    for (const node of this.#nodes.values()) {
      if (node.source === 'free' && this.#isAvailable(node.id)) count += 1
    }
    return count
  }

  /** Determine the pool state over the free-source pool (3.5 thresholds). */
  state(): PoolState {
    if (this.#targetSize <= 0) return 'healthy'
    const available = this.availableFreeCount()
    const ratio = available / this.#targetSize
    if (ratio < 0.1) return 'emergency'
    if (ratio < 0.3) return 'critical'
    if (ratio < 0.95) return 'warning'
    return 'healthy'
  }

  /** Admission quota for a refill round: how many free nodes to accept. */
  admissionQuota(): number {
    return Math.max(0, this.#targetSize - this.availableFreeCount())
  }

  /** Replace the worst free node (C grade / oldest) to make room (3.5). */
  evictWorstFree(): boolean {
    let worst: ExitNode | null = null
    for (const node of this.#nodes.values()) {
      if (node.source !== 'free') continue
      if (!worst) {
        worst = node
        continue
      }
      const gradeRank: Record<ExitNode['quality'], number> = { S: 0, A: 1, B: 2, C: 3 }
      const byGrade = gradeRank[node.quality] - gradeRank[worst.quality]
      if (byGrade > 0 || (byGrade === 0 && node.addedAt < worst.addedAt)) worst = node
    }
    if (!worst) return false
    this.remove(worst.id)
    return true
  }

  /** Is the pool full for free-source admission? (pinned and non-free nodes
   *  never count against the target, 3.5/3.6.) */
  isFreeFull(): boolean {
    return this.freeCount() >= this.#targetSize
  }

  freeCount(): number {
    let count = 0
    for (const node of this.#nodes.values()) if (node.source === 'free') count += 1
    return count
  }

  // -- diagnostics ------------------------------------------------------------

  snapshot(): {
    state: PoolState
    total: number
    bySource: Record<ExitSource, number>
    availableFree: number
    pinned: string
  } {
    const bySource: Record<ExitSource, number> = { free: 0, manual: 0, subscription: 0, goproxy: 0 }
    for (const node of this.#nodes.values()) bySource[node.source] += 1
    return {
      state: this.state(),
      total: this.#nodes.size,
      bySource,
      availableFree: this.availableFreeCount(),
      pinned: this.pinnedId,
    }
  }

  list(): Array<ExitNode & { health: ExitHealth; bans: Array<{ model: string; ban: ModelBan }> }> {
    const out: Array<ExitNode & { health: ExitHealth; bans: Array<{ model: string; ban: ModelBan }> }> = []
    for (const [id, node] of this.#nodes) {
      const health = this.#health.get(id)!
      const bans: Array<{ model: string; ban: ModelBan }> = []
      for (const [key, ban] of this.#bans) {
        if (key.startsWith(`${id}\u0000`)) bans.push({ model: key.slice(id.length + 1), ban })
      }
      out.push({ ...node, health, bans })
    }
    return out
  }
}
