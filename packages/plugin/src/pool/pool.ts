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

export interface ExitNode {
  /** host:port, unique inside the pool (the address we dial). */
  id: string
  protocol: 'http' | 'socks5'
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
  now?: () => number
}

/** Quality grade from admission latency (GoProxy thresholds). */
export function gradeOf(latencyMs: number): ExitNode['quality'] {
  if (latencyMs <= 500) return 'S'
  if (latencyMs <= 1000) return 'A'
  if (latencyMs <= 2000) return 'B'
  return 'C'
}

const banKey = (exitId: string, model: string) => `${exitId}\u0000${model}`

export class ExitPool {
  readonly #nodes = new Map<string, ExitNode>()
  readonly #health = new Map<string, ExitHealth>()
  readonly #bans = new Map<string, ModelBan>()
  readonly #sessionExit = new Map<string, string>()
  #targetSize: number
  #cooldownBase: number
  #cooldownMax: number
  #banConfirmations: number
  #deadEvictions: number
  #now: () => number

  constructor(options: PoolOptions = {}) {
    this.#targetSize = options.targetSize ?? 20
    this.#cooldownBase = options.limitedCooldownBaseMs ?? 60_000
    this.#cooldownMax = options.limitedCooldownMaxMs ?? 30 * 60_000
    this.#banConfirmations = options.modelBanConfirmations ?? 2
    this.#deadEvictions = options.deadEvictions ?? 2
    this.#now = options.now ?? Date.now
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
    for (const key of this.#bans.keys()) {
      if (key.startsWith(`${id}\u0000`)) this.#bans.delete(key)
    }
    for (const [session, exitId] of this.#sessionExit) {
      if (exitId === id) this.#sessionExit.delete(session)
    }
    this.#clearPinnedIf(id)
  }

  /** Disable without dropping (dead manual/subscription/goproxy nodes, 3.5). */
  markDead(id: string): void {
    const health = this.#health.get(id)
    if (!health) return
    health.state = 'dead'
    health.inflight = false
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
    }
    if (model !== undefined) {
      this.#bans.set(banKey(id, model), { state: 'ok', bannedAt: 0, consecutiveFailures: 0 })
    }
  }

  /** 429: exit-level cooldown with exponential backoff (3.2 / 4.6). */
  markLimited(id: string): number {
    const health = this.#health.get(id)
    if (!health) return 0
    health.consecutiveLimited += 1
    health.state = 'ok'
    const backoff = Math.min(
      this.#cooldownBase * 2 ** (health.consecutiveLimited - 1),
      this.#cooldownMax,
    )
    health.cooldownUntil = this.#now() + backoff
    return health.cooldownUntil
  }

  /** 401/403: model-level suspicion; banned after N consecutive (3.2). */
  markModelSignal(id: string, model: string): BanState {
    const key = banKey(id, model)
    const current = this.#bans.get(key) ?? { state: 'ok' as BanState, bannedAt: 0, consecutiveFailures: 0 }
    current.consecutiveFailures += 1
    if (current.consecutiveFailures >= this.#banConfirmations && current.state !== 'banned') {
      current.state = 'banned'
      current.bannedAt = this.#now()
    } else if (current.state !== 'banned') {
      current.state = 'suspect'
    }
    this.#bans.set(key, current)
    return current.state
  }

  /** Transport failure / 5xx / probe timeout: dead, with free-source eviction
   *  after repeated strikes (3.5). Returns true when the node was evicted. */
  markDeadStrike(id: string): boolean {
    const node = this.#nodes.get(id)
    const health = this.#health.get(id)
    if (!node || !health) return false
    health.state = 'dead'
    health.inflight = false
    health.deadStrikes += 1
    if (node.source === 'free' && health.deadStrikes >= this.#deadEvictions) {
      this.remove(id)
      return true
    }
    return false
  }

  /** Death from a mid-flight stream (no retry path): same strike accounting. */
  markStreamFailure(id: string, kind: '429' | 'model', model?: string): void {
    if (kind === '429') this.markLimited(id)
    else if (model !== undefined) this.markModelSignal(id, model)
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
   * Pick the exit for one upstream request. Pinned wins while usable (3.6);
   * the rotation pool then prefers session stickiness, health, fewer
   * cooldowns and lower latency with a same-tier shuffle. Pure; no IO.
   */
  pick(session: string, model: string): string | null {
    if (this.pinnedId !== '' && this.isUsable(this.pinnedId, model)) return this.pinnedId

    const last = this.#sessionExit.get(session)
    if (last !== undefined && this.isUsable(last, model)) return last

    const usable = [...this.#nodes.keys()].filter((id) => this.isUsable(id, model))
    if (usable.length === 0) return null
    const health = (id: string) => this.#health.get(id)!
    const node = (id: string) => this.#nodes.get(id)!
    usable.sort((left, right) => {
      const a = health(left)
      const b = health(right)
      const stateRank = (h: ExitHealth) => (h.state === 'ok' ? 0 : 1)
      const byState = stateRank(a) - stateRank(b)
      if (byState !== 0) return byState
      const byLimited = a.consecutiveLimited - b.consecutiveLimited
      if (byLimited !== 0) return byLimited
      const byLatency = node(left).latencyMs - node(right).latencyMs
      if (byLatency !== 0) return byLatency
      return Math.random() < 0.5 ? -1 : 1
    })
    const chosen = usable[0]
    if (chosen === undefined) return null
    this.#sessionExit.set(session, chosen)
    return chosen
  }

  /** Drop the session's sticky exit (cooldown/dead/ban broke it). */
  breakStickySession(session: string): void {
    this.#sessionExit.delete(session)
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
    // model it serves is effectively exhausted. Track by distinct models:
    const nodeModels = new Set<string>()
    let allBanned = true
    let sawBan = false
    for (const [key, ban] of this.#bans) {
      if (!key.startsWith(`${id}\u0000`)) continue
      const model = key.slice(id.length + 1)
      nodeModels.add(model)
      if (ban.state !== 'banned') allBanned = false
      else sawBan = true
    }
    if (sawBan && nodeModels.size > 0 && allBanned) return false
    return true
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
