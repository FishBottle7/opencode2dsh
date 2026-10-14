/**
 * Subscription fetcher — pulls airport/Clash subscription URLs, parses them
 * with the three-format auto-detector (subscription.ts) and routes the
 * parsed nodes (docs/ip-pool.md 1.2 source 3):
 *
 *   - plaintext nodes (http/socks5) -> admission smoke -> ExitPool
 *   - encrypted nodes (vmess/vless/trojan/ss/hysteria2/anytls/tuic) ->
 *     parked as pending-conversion until the sing-box layer lands (IP-4)
 *
 * Deliberately gentle: subscription servers are paid account resources
 * (ban risk), so one request per URL per refresh — no retries, no fan-out
 * (docs 4.1: subscription never goes hot).
 *
 * The fetch User-Agent is settings-driven (docs 5.1 `subscription.userAgent`,
 * default DEFAULT_SUBSCRIPTION_USER_AGENT): airports gate on it and a UA their
 * panel does not list can come back as an error page or a 502 rather than a
 * subscription body — one airport measured here answers 502 for
 * `clash-verge/1.6.0` and serves normally for `clash-verge/v2.0`.
 */

import { ExitPool, type ExitNode, type ExitProtocol } from './pool.ts'
import { Prober, type ProbeTask } from './prober.ts'
import { admitTrusted, type AdmissionDeps } from './admission.ts'
import { applyProbeVerdict } from './probe-verdict.ts'
import { parseSubscription, type ParsedNode } from './subscription.ts'
import { DEFAULT_SUBSCRIPTION_USER_AGENT, normalizeSubscriptionUserAgent } from './subscription-defaults.ts'
import { SingBoxSupervisor, type ConvertedExit } from './singbox.ts'

/**
 * The fetch UA the settings layer and the runtime both default to; re-exported
 * so callers wiring the fetcher need not reach into the parser module.
 */
export { DEFAULT_SUBSCRIPTION_USER_AGENT }

export interface SubscriptionDeps extends AdmissionDeps {
  pool: ExitPool
  prober: Prober
  fetchImpl?: typeof fetch
  /** sing-box supervisor for encrypted-node conversion; when null the
   *  encrypted nodes simply park as pending (no binary configured). */
  supervisor?: {
    reload(nodes: ParsedNode[]): Promise<ConvertedExit[]>
    stop(): Promise<void>
    readonly running: boolean
  }
}

export interface SubscriptionState {
  running: boolean
  /** Parsed nodes needing an external core; empty once conversion ran. */
  pendingConversion: ParsedNode[]
  /** Converted local exits admitted into the pool this round. */
  convertedAdmitted: number
  lastFetch: number
  lastError: string
  plaintextAdmitted: number
}

export interface SubscriptionOptions {
  /** Refresh interval (docs 4.6, default 30min). */
  intervalMs?: number
  timeoutMs?: number
  /**
   * User-Agent for subscription fetches (docs 5.1 `subscription.userAgent`).
   * Airports gate on this — an unlisted UA returns an error page instead of a
   * body, and may also select the returned format. Empty/unset falls back to
   * DEFAULT_SUBSCRIPTION_USER_AGENT.
   */
  userAgent?: string
  logger?: { info(message: string): void; warn(message: string): void }
}

/** How stale a known exit's last probe must be before a refresh re-smokes it.
 *  A refresh used to re-smoke EVERY converted exit unconditionally, so a pool
 *  of a few hundred exits re-enqueued a few hundred anonymous-lane smokes on
 *  every round. Measured live (2026-10-15): `enqueued` climbed past 2600 with
 *  only 400 exits in the table and a 6-hour refresh interval, because each
 *  round re-queued the whole table while the queue drained at ~2.5/s under the
 *  concurrency cap. Those smokes share the per-exit-IP anonymous quota with real
 *  traffic, which is what produced OK-looking exits that still answered 429. */
const RESMOKE_AFTER_MS = 30 * 60_000

/** Hard cap on smokes one refresh round may queue, so no future path can
 *  rebuild the pile-up this ceiling exists to stop. */
const MAX_SMOKES_PER_ROUND = 60

export class SubscriptionFetcher {
  readonly #deps: SubscriptionDeps
  #urls: string[] = []
  #state: SubscriptionState = {
    running: false,
    pendingConversion: [],
    convertedAdmitted: 0,
    lastFetch: 0,
    lastError: '',
    plaintextAdmitted: 0,
  }
  #timer: NodeJS.Timeout | null = null
  #refreshing: Promise<SubscriptionState> | null = null
  #stopped = false
  #controller: AbortController | null = null
  #intervalMs: number
  #timeoutMs: number
  #userAgent: string
  #logger?: SubscriptionOptions['logger']
  /** Notified after every real admission — the runtime assembly uses it to
   *  engage routing the moment a subscription pool stops being empty (the
   *  initial install is skipped exactly then, and a subscription-only pool
   *  has no refill loop to fire the free-source hook). */
  #admittedCallbacks: Array<() => void> = []

  constructor(deps: SubscriptionDeps, options: SubscriptionOptions = {}) {
    this.#deps = deps
    this.#intervalMs = options.intervalMs ?? 30 * 60_000
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#userAgent = normalizeSubscriptionUserAgent(options.userAgent)
    this.#logger = options.logger
  }

  get state(): SubscriptionState {
    return { ...this.#state, running: this.#refreshing !== null, pendingConversion: [...this.#state.pendingConversion] }
  }

  /** Register a callback fired after every node this round really admits. */
  onAdmitted(callback: () => void): void {
    this.#admittedCallbacks.push(callback)
  }

  #notifyAdmitted(): void {
    for (const callback of this.#admittedCallbacks) {
      try {
        callback()
      } catch {
        /* a watcher's failure must never kill the round */
      }
    }
  }

  /** Configured URL count (status bridge; the URLs themselves never ride out). */
  get urlCount(): number {
    return this.#urls.length
  }

  /** Update the subscription URL list (settings change); refresh follows. */
  setUrls(urls: string[]): void {
    this.#urls = urls.filter((url) => url.trim().length > 0)
  }

  /** Live re-apply of the refresh interval (settings page, docs §5.1). */
  setIntervalMs(ms: number): void {
    this.#intervalMs = Math.max(60_000, ms)
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = setInterval(() => void this.refresh(), this.#intervalMs)
      this.#timer.unref?.()
    }
  }

  /**
   * Live re-apply of the fetch User-Agent (settings page, docs §5.1). Takes
   * effect on the next refresh — the in-flight round keeps the UA it started
   * with. Empty falls back to the default rather than sending no UA at all.
   */
  setUserAgent(userAgent: string | undefined): void {
    this.#userAgent = normalizeSubscriptionUserAgent(userAgent)
  }

  /** The UA the next fetch will send (settings card echo / diagnostics). */
  get userAgent(): string {
    return this.#userAgent
  }

  /** Manual refresh trigger (settings page 立即刷新, /probe scope: 'subscriptions'). */
  async refreshNow(): Promise<SubscriptionState> {
    return this.refresh()
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return
    void this.refresh()
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    this.#controller?.abort()
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    void this.#deps.supervisor?.stop().catch(() => {})
  }

  /** One refresh round over every URL; never overlaps itself. */
  refresh(): Promise<SubscriptionState> {
    if (this.#refreshing !== null) return this.#refreshing
    if (this.#stopped) return Promise.resolve(this.state)
    this.#refreshing = this.#refreshRound()
      .finally(() => { this.#refreshing = null })
      .then(() => this.state)
    return this.#refreshing
  }

  async #refreshRound(): Promise<void> {
    const urls = [...this.#urls]
    const userAgent = this.#userAgent
    const pending: ParsedNode[] = []
    const plaintext: Array<{ address: string; protocol: ExitProtocol }> = []
    let lastError = ''
    for (const url of urls) {
      try {
        const body = await this.#fetch(url, userAgent)
        if (this.#stopped) return
        const report = parseSubscription(body)
        for (const node of report.nodes) {
          if (node.type === 'http' || node.type === 'https' || node.type === 'socks5') {
            plaintext.push({
              address: `${node.server}:${node.port}`,
              protocol: node.type,
            })
          } else {
            pending.push(node)
          }
        }
        this.#logger?.info(`opencode2dsh: subscription parsed ${report.nodes.length} node(s) (${report.detected}) from ${this.#redact(url)}`)
      } catch (err) {
        if (this.#stopped) return
        lastError = err instanceof Error ? err.message : String(err)
        this.#logger?.warn(`opencode2dsh: subscription fetch failed for ${this.#redact(url)}: ${lastError}`)
      }
    }
    this.#state = {
      running: false,
      pendingConversion: pending,
      convertedAdmitted: 0,
      lastFetch: Date.now(),
      lastError,
      plaintextAdmitted: 0,
    }
    // Encrypted nodes -> sing-box conversion -> local SOCKS5 exits (IP-4).
    // Without a supervisor configured they stay parked as pending.
    //
    // The incremental rule below is shared by BOTH the converted and the
    // plaintext path: re-smoke a node only when it is new or its last verdict
    // has gone stale. Re-smoking the whole table on every round is what buried
    // the probe queue (see RESMOKE_AFTER_MS).
    const now = Date.now()
    const entries = this.#deps.pool.list()
    const known = new Set(entries.map((entry) => entry.id))
    const stale = new Set(entries
      .filter((entry) => now - entry.health.lastProbedAt >= RESMOKE_AFTER_MS)
      .map((entry) => entry.id))
    if (pending.length > 0 && this.#deps.supervisor) {
      try {
        const exits = await this.#deps.supervisor.reload(pending)
        if (this.#stopped) return
        const tasks: ProbeTask[] = exits
          .filter((exit) => !known.has(exit.address) || stale.has(exit.address))
          .slice(0, MAX_SMOKES_PER_ROUND)
          .map((exit): ProbeTask => ({
            exitId: exit.address,
            kind: 'subscription-smoke',
            run: async () => {
              if (this.#stopped) return
              const existing = this.#deps.pool.get(exit.address)
              const verdict = await admitTrusted(this.#deps, {
                address: exit.address,
                protocol: exit.protocol,
                source: 'subscription',
              }, existing
                ? { previous: { exitIP: existing.exitIP, exitLocation: existing.exitLocation, latencyMs: existing.latencyMs, quality: existing.quality } }
                : {})
              if (!this.#stopped && verdict.admitted && verdict.node) {
                const isNew = this.#deps.pool.add({ ...verdict.node, addedAt: existing?.addedAt ?? verdict.node.addedAt })
                // The verdict layer decides what the probe MEANT. A degraded
                // fallback is no longer a silent dead end: it carries the
                // failure class, so a link that is genuinely gone is marked
                // dead (excluded from rotation, re-probed by PeriodicProber)
                // while a node that merely refused this probe keeps its health.
                // Live-observed 2026-10-14: 703 of 726 exits sat at 'unknown'
                // with no facts because this path never wrote anything on
                // failure — they looked identical to never-probed nodes.
                applyProbeVerdict(this.#deps.pool, exit.address, verdict, {
                  source: 'subscription',
                  model: this.#deps.smokeModel ?? 'big-pickle',
                })
                if (!known.has(exit.address) && isNew) {
                  this.#state.convertedAdmitted += 1
                  this.#notifyAdmitted()
                }
                const served = exit.node
                // Drop the served node by identity, not by value: this ran
                // once per converted exit, and filtering 1900+ pending nodes
                // by value inside every task was quadratic in the round.
                const at = this.#state.pendingConversion.indexOf(served)
                if (at >= 0) this.#state.pendingConversion.splice(at, 1)
              }
            },
          }))
        if (tasks.length > 0) await this.#deps.prober.enqueueAll(tasks)
        this.#logger?.info(`opencode2dsh: sing-box converted ${exits.length} encrypted node(s); ${this.#state.convertedAdmitted} admitted`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.#state.lastError = message
        this.#logger?.warn(`opencode2dsh: sing-box conversion failed: ${message}`)
      }
    }
    // Plaintext nodes go through the trusted admission smoke (never the
    // hot coarse screen: subscription nodes are paid resources, docs 4.1).
    // Same incremental rule as the converted path above: a node already
    // smoked recently keeps its verdict until it goes stale.
    if (this.#stopped) return
    const tasks: ProbeTask[] = plaintext
      .filter((candidate) => !known.has(candidate.address) || stale.has(candidate.address))
      .slice(0, MAX_SMOKES_PER_ROUND)
      .map((candidate): ProbeTask => ({
        exitId: candidate.address,
        kind: 'subscription-smoke',
        run: async () => {
          if (this.#stopped) return
          const existing = this.#deps.pool.get(candidate.address)
          const verdict = await admitTrusted(this.#deps, {
            address: candidate.address,
            protocol: candidate.protocol,
            source: 'subscription',
          }, existing
            ? { previous: { exitIP: existing.exitIP, exitLocation: existing.exitLocation, latencyMs: existing.latencyMs, quality: existing.quality } }
            : {})
          if (!this.#stopped && verdict.admitted && verdict.node) {
            const isNew = !existing
            // add() refreshes the facts; the verdict layer owns the health
            // write, so a plaintext node whose link died is marked dead here
            // too (previously it silently stayed 'unknown' forever).
            this.#deps.pool.add(isNew ? verdict.node : { ...verdict.node, addedAt: existing.addedAt })
            applyProbeVerdict(this.#deps.pool, verdict.node.id, verdict, {
              source: 'subscription',
              model: this.#deps.smokeModel ?? 'big-pickle',
            })
            if (isNew) {
              this.#state.plaintextAdmitted += 1
              this.#notifyAdmitted()
            }
          }
        },
      }))
    if (tasks.length > 0) await this.#deps.prober.enqueueAll(tasks)
  }

  async #fetch(url: string, userAgent: string): Promise<string> {
    const controller = new AbortController()
    this.#controller = controller
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await (this.#deps.fetchImpl ?? fetch)(url, {
        signal: controller.signal,
        headers: { accept: '*/*', 'user-agent': userAgent },
      })
      if (!response.ok) throw new Error(`subscription HTTP ${response.status}`)
      return await response.text()
    } finally {
      clearTimeout(timer)
      this.#controller = null
    }
  }

  /** Subscriptions embed account credentials; never log them in full. */
  #redact(url: string): string {
    if (url.length <= 24) return url
    return url.slice(0, 12) + '…' + url.slice(-6)
  }
}
