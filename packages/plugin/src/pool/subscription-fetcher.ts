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
 */

import { ExitPool, type ExitNode } from './pool.ts'
import { Prober, type ProbeTask } from './prober.ts'
import { admitCandidate, admitTrusted, type AdmissionDeps } from './admission.ts'
import { parseSubscription, type ParsedNode } from './subscription.ts'

export interface SubscriptionDeps extends AdmissionDeps {
  pool: ExitPool
  prober: Prober
  fetchImpl?: typeof fetch
}

export interface SubscriptionState {
  /** Parsed nodes needing an external core (IP-4); surfaced to the settings
   *  page as greyed-out "pending conversion" rows. */
  pendingConversion: ParsedNode[]
  lastFetch: number
  lastError: string
  plaintextAdmitted: number
}

export interface SubscriptionOptions {
  /** Refresh interval (docs 4.6, default 30min). */
  intervalMs?: number
  timeoutMs?: number
  logger?: { info(message: string): void; warn(message: string): void }
}

export class SubscriptionFetcher {
  readonly #deps: SubscriptionDeps
  #urls: string[] = []
  #state: SubscriptionState = {
    pendingConversion: [],
    lastFetch: 0,
    lastError: '',
    plaintextAdmitted: 0,
  }
  #timer: NodeJS.Timeout | null = null
  #running = false
  #stopped = false
  #intervalMs: number
  #timeoutMs: number
  #logger?: SubscriptionOptions['logger']

  constructor(deps: SubscriptionDeps, options: SubscriptionOptions = {}) {
    this.#deps = deps
    this.#intervalMs = options.intervalMs ?? 30 * 60_000
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#logger = options.logger
  }

  get state(): SubscriptionState {
    return { ...this.#state, pendingConversion: [...this.#state.pendingConversion] }
  }

  /** Update the subscription URL list (settings change); refresh follows. */
  setUrls(urls: string[]): void {
    this.#urls = urls.filter((url) => url.trim().length > 0)
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return
    void this.refresh()
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /** One refresh round over every URL; never overlaps itself. */
  async refresh(): Promise<SubscriptionState> {
    if (this.#running) return this.state
    this.#running = true
    try {
      const pending: ParsedNode[] = []
      const plaintext: Array<{ address: string; protocol: 'http' | 'socks5' }> = []
      let lastError = ''
      for (const url of this.#urls) {
        try {
          const body = await this.#fetch(url)
          const report = parseSubscription(body)
          for (const node of report.nodes) {
            if (node.type === 'http' || node.type === 'socks5') {
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
          lastError = err instanceof Error ? err.message : String(err)
          this.#logger?.warn(`opencode2dsh: subscription fetch failed for ${this.#redact(url)}: ${lastError}`)
        }
      }
      this.#state = {
        pendingConversion: pending,
        lastFetch: Date.now(),
        lastError,
        plaintextAdmitted: 0,
      }
      // Plaintext nodes go through the trusted admission smoke (never the
      // hot coarse screen: subscription nodes are paid resources, docs 4.1).
      const tasks: ProbeTask[] = plaintext
        .filter((candidate) => !this.#deps.pool.has(candidate.address))
        .map((candidate): ProbeTask => ({
          exitId: candidate.address,
          kind: 'subscription-smoke',
          run: async () => {
            const verdict = await admitTrusted(this.#deps, {
              address: candidate.address,
              protocol: candidate.protocol,
              source: 'subscription',
            })
            if (verdict.admitted && verdict.node) {
              if (this.#deps.pool.add(verdict.node)) {
                this.#deps.pool.markOk(verdict.node.id)
                this.#state.plaintextAdmitted += 1
              }
            }
          },
        }))
      if (tasks.length > 0) await this.#deps.prober.enqueueAll(tasks)
      return this.state
    } finally {
      this.#running = false
    }
  }

  async #fetch(url: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await (this.#deps.fetchImpl ?? fetch)(url, {
        signal: controller.signal,
        headers: { accept: '*/*', 'user-agent': 'clash-verge/1.6.0' },
      })
      if (!response.ok) throw new Error(`subscription HTTP ${response.status}`)
      return await response.text()
    } finally {
      clearTimeout(timer)
    }
  }

  /** Subscriptions embed account credentials; never log them in full. */
  #redact(url: string): string {
    if (url.length <= 24) return url
    return url.slice(0, 12) + '…' + url.slice(-6)
  }
}
