/**
 * Refill scheduler — drives the free pool from the four-state machine
 * (docs/ip-pool.md 3.5): on each tick, compute the pool state, select source
 * tiers (fast / all / none), fetch lists through the source breaker, and
 * feed candidates to admission through the Prober queue (bounded admission
 * by the quota; emergency ignores the breaker).
 *
 * The loop is timer-driven and fully injectable: fetch, admission and the
 * clock are seams so the whole state machine is unit-testable offline.
 */

import type { Dispatcher } from 'undici'

import { ExitPool } from './pool.ts'
import { Prober, type ProbeTask } from './prober.ts'
import { SourceBreaker, dedupeAddresses, fetchSource, selectSources, type FetchResult, type FreeSource } from './sources.ts'
import { admitCandidate, coarseScreenBatch, type AdmissionDeps } from './admission.ts'

export interface RefillDeps extends AdmissionDeps {
  prober: Prober
  /** Source tier fetch (injectable). */
  fetchImpl?: typeof fetch
  fetchSourceImpl?: (source: FreeSource, fetchImpl: typeof fetch) => Promise<FetchResult>
  /** Coarse-screen fan-out (docs/ip-pool.md 4.5: wild candidates only —
   *  steps 1-2 touch no anonymous-lane quota, so this may run hot).
   *  Trusted sources never pass through here. */
  admissionFanout?: number
}

export interface RefillOptions {
  /** Tick interval for the refill check (default 10min, docs 4.6). */
  intervalMs?: number
  /** Admission batch cap per refill round (defensive; quota already bounds). */
  maxAdmissionsPerRound?: number
  now?: () => number
}

/** Live progress of one in-flight refill round (docs §5.3 /status). */
export interface RefillProgress {
  running: boolean
  /** Current phase: fetching sources / coarse screening / admitting / idle. */
  stage: 'fetch' | 'coarse' | 'admit' | 'idle'
  /** Source lists answered so far this round (ok or failed). */
  sourcesDone: number
  /** Source lists this round is trying (state-tier + breaker filtered). */
  sourcesTotal: number
  /** Raw rows pulled from the source lists so far this round. */
  fetched: number
  /** Candidates collected for screening (after per-source caps + dedupe). */
  candidates: number
  /** Coarse-screen survivors so far. */
  coarsePassed: number
  /** Coarse screens finished so far (denominator grows as it runs). */
  coarseDone: number
  /** Fine-screen (admission) tasks completed so far. */
  admissions: number
  /** Exits admitted so far this round. */
  admitted: number
}

export class RefillScheduler {
  readonly #pool: ExitPool
  readonly #deps: RefillDeps
  readonly #breaker = new SourceBreaker()
  #intervalMs: number
  /** Candidate cap per source per round (a source can return thousands of
   *  rows; admission cost is 4 requests per candidate). */
  #maxPerRound: number
  #timer: NodeJS.Timeout | null = null
  #running = false
  #stopped = false
  #lastRound = { admitted: 0, rejected: 0, fetched: 0, coarsePassed: 0, state: 'healthy' as string, at: 0 }
  /** Live progress of the in-flight round (settings page 立即补充 feedback). */
  #progress: { running: boolean; stage: 'fetch' | 'coarse' | 'admit' | 'idle'; sourcesDone: number; sourcesTotal: number; fetched: number; candidates: number; coarsePassed: number; coarseDone: number; admissions: number; admitted: number } = {
    running: false, stage: 'idle', sourcesDone: 0, sourcesTotal: 0, fetched: 0, candidates: 0, coarsePassed: 0, coarseDone: 0, admissions: 0, admitted: 0,
  }

  constructor(pool: ExitPool, deps: RefillDeps, options: RefillOptions = {}) {
    this.#pool = pool
    this.#deps = deps
    this.#intervalMs = options.intervalMs ?? 10 * 60_000
    this.#maxPerRound = options.maxAdmissionsPerRound ?? 10
  }

  get lastRound(): { admitted: number; rejected: number; fetched: number; coarsePassed: number; state: string; at: number } {
    return this.#lastRound
  }

  /** The in-flight round's live progress (status bridge, docs §5.3). */
  get progress(): RefillProgress {
    return { ...this.#progress }
  }

  /** Start the periodic refill check (one round immediately). */
  start(): void {
    if (this.#timer !== null || this.#stopped) return
    void this.tick()
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

  /** One refill round; skipped while a previous round is still draining. */
  async tick(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      await this.#round()
    } finally {
      this.#running = false
    }
  }

  async #round(): Promise<void> {
    const state = this.#pool.state()
    const quota = Math.min(this.#pool.admissionQuota(), this.#maxPerRound)
    this.#lastRound = { ...this.#lastRound, state, at: Date.now() }
    if (state === 'healthy' || quota <= 0) {
      this.#progress = { running: false, stage: 'idle', sourcesDone: 0, sourcesTotal: 0, fetched: 0, candidates: 0, coarsePassed: 0, coarseDone: 0, admissions: 0, admitted: 0 }
      return
    }

    // emergency ignores the source breaker (docs 3.5); refill honors it.
    const sources = selectSources(state).filter((source) => state === 'emergency' || this.#breaker.canUse(source.url))
    // live progress: fetch stage begins (sourcesTotal seeds the denominator)
    this.#progress = { running: true, stage: 'fetch', sourcesDone: 0, sourcesTotal: sources.length, fetched: 0, candidates: 0, coarsePassed: 0, coarseDone: 0, admissions: 0, admitted: 0 }
    let fetched = 0
    let admitted = 0
    let rejected = 0
    // Full-scan policy (docs §4.5: "一轮 48k 候选…300 并发几分钟扫完全量"):
    // the coarse screen is brute-force by design — wild candidates are free,
    // have no account system, and 98%+ die at the TCP step, so skipping rows
    // only loses exits. The caps below are defensive against pathological
    // lists, not a sampling knob; the QUOTA-spending steps (fine screen) stay
    // bounded by admissionQuota per round.
    const candidateCap = 20_000
    const perSourceCap = 5_000
    const candidates: Array<{ address: string; host: string; port: number; protocol: 'http' | 'socks5' }> = []
    const seen = new Set<string>(this.#poolAddresses())

    for (const source of sources) {
      if (candidates.length >= candidateCap) break
      try {
        const result = this.#deps.fetchSourceImpl
          ? await this.#deps.fetchSourceImpl(source, this.#deps.fetchImpl ?? fetch)
          : await fetchSource(source, this.#deps.fetchImpl ?? fetch)
        this.#breaker.recordSuccess(source.url)
        fetched += result.addresses.length
        this.#progress.fetched = fetched
        this.#progress.sourcesDone += 1
        this.#progress.candidates = candidates.length
        // shuffle before scanning: free lists are not uniformly distributed
        // (freshness/quality vary) and a later source should not be crowded
        // out by an earlier one's 5k rows
        const rows = result.addresses.slice()
        for (let i = rows.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[rows[i], rows[j]] = [rows[j]!, rows[i]!]
        }
        let fromThisSource = 0
        for (const entry of rows) {
          if (candidates.length >= candidateCap) break
          if (fromThisSource >= perSourceCap) break
          if (seen.has(entry.address)) continue
          seen.add(entry.address)
          // Free pools are HTTP-only for MVP (socks5 candidates are backlog, 8).
          if (source.protocol !== 'http') continue
          candidates.push({ ...entry, protocol: 'http' })
          fromThisSource += 1
        }
        this.#progress.candidates = candidates.length
      } catch {
        this.#breaker.recordFailure(source.url)
        this.#progress.sourcesDone += 1
      }
    }

    // Coarse screen (docs 4.5 分层修订): steps 1-2 touch only the wild
    // candidates and a public IP service, so they fan out hot
    // (admissionFanout, default 300 — GoProxy ValidateConcurrency parity)
    // of thousands of candidates. Survivors (~1-3%) proceed to the
    // anonymous-lane steps through the bounded Prober queue.
    this.#progress.stage = 'coarse'
    const relaxed = state === 'critical' || state === 'emergency'
    const facts = await coarseScreenBatch(
      this.#deps,
      candidates,
      {
        fanout: this.#deps.admissionFanout ?? 300,
        relaxed,
        timeoutMs: 5000,
        onProgress: (done, passed) => {
          this.#progress.coarseDone = done
          this.#progress.coarsePassed = passed
        },
      },
    )
    // coarse rejections count toward the round's rejected total: a candidate
    // dying at the echo step is as rejected as one failing the smoke.
    rejected += candidates.length - facts.size
    this.#progress.stage = 'admit'
    this.#lastRound = { admitted, rejected, fetched, state, at: Date.now(), coarsePassed: facts.size }

    // Fine screen (steps 3-4, anonymous-lane quota): through the Prober
    // queue with the two-level scheduling (serial per exit, bounded
    // global workers, 4.1). Survivors are latency-ranked first so the scarce
    // quota goes to the best exits a full scan surfaced.
    const tasks: ProbeTask[] = []
    let admittedLimited = 0
    const survivors = candidates
      .filter((candidate) => facts.has(candidate.address))
      .sort((left, right) => (facts.get(left.address)?.latencyMs ?? 0) - (facts.get(right.address)?.latencyMs ?? 0))
    for (const candidate of survivors) {
      const echoFacts = facts.get(candidate.address)
      if (!echoFacts) continue
      // Quota counts usable seats: 429-cooling admits occupy a pool seat but
      // do not satisfy the availability quota (the state machine stays hungry
      // until they recover or get replaced), so the gate counts both.
      if (admitted + admittedLimited >= quota) break
      tasks.push({
        exitId: candidate.address,
        kind: 'admission',
        run: async () => {
          try {
            const verdict = await admitCandidate(this.#deps, {
              address: candidate.address,
              protocol: candidate.protocol,
              source: 'free',
            }, { relaxed, echoFacts })
            if (verdict.admitted && verdict.node) {
              // Replace flow when full (3.5): evict the worst free node to room.
              if (this.#pool.isFreeFull()) this.#pool.evictWorstFree()
              if (this.#pool.add(verdict.node)) {
                if (verdict.limited) {
                  // 429 at smoke (4.5): good exit, quota consumed elsewhere —
                  // admit cooling; the periodic probe retries when it expires.
                  this.#pool.markLimited(verdict.node.id)
                  admittedLimited += 1
                } else {
                  this.#pool.markOk(verdict.node.id)
                  admitted += 1
                }
                this.#progress.admitted = admitted + admittedLimited
              }
            } else {
              rejected += 1
            }
          } finally {
            this.#progress.admissions += 1
          }
        },
      })
    }
    if (tasks.length > 0) {
      await this.#deps.prober.enqueueAll(tasks)
      this.#lastRound = { ...this.#lastRound, admitted: admitted + admittedLimited, rejected, at: Date.now() }
    }
    // settle: stop running, keep the round's counters for the "last round"
    // summary the settings card renders (stage idles, numbers persist).
    this.#progress.running = false
    this.#progress.stage = 'idle'
  }

  #poolAddresses(): Set<string> {
    return new Set(this.#pool.list().map((entry) => entry.id))
  }
}
