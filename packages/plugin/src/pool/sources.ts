/**
 * Free-source list, fetch and the per-source breaker (docs/ip-pool.md 1.2
 * source 1, 3.5) — the TS rewrite of GoProxy fetcher/fetcher.go +
 * source_manager.go. The 26 source URLs are copied verbatim from GoProxy
 * (fast/slow tiers); the breaker semantics (consecutive failures disable a
 * source, cooldown re-enables it) are the same, with the SQLite table
 * replaced by an in-memory Map.
 */

export interface FreeSource {
  url: string
  protocol: 'http' | 'socks5'
  tier: 'fast' | 'slow'
}

export const freeSources: FreeSource[] = [
  // fast tier (GoProxy fastUpdateSources)
  { url: 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt', protocol: 'http', tier: 'fast' },
  { url: 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks4.txt', protocol: 'socks5', tier: 'fast' },
  { url: 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks5.txt', protocol: 'socks5', tier: 'fast' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', protocol: 'http', tier: 'fast' },
  { url: 'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt', protocol: 'http', tier: 'fast' },
  { url: 'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt', protocol: 'socks5', tier: 'fast' },
  { url: 'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks4.txt', protocol: 'socks5', tier: 'fast' },
  { url: 'https://cdn.jsdelivr.net/gh/sunny9577/proxy-scraper/generated/http_proxies.txt', protocol: 'http', tier: 'fast' },
  { url: 'https://cdn.jsdelivr.net/gh/sunny9577/proxy-scraper/generated/socks5_proxies.txt', protocol: 'socks5', tier: 'fast' },
  { url: 'https://cdn.jsdelivr.net/gh/sunny9577/proxy-scraper/generated/socks4_proxies.txt', protocol: 'socks5', tier: 'fast' },
  // slow tier (GoProxy slowUpdateSources)
  { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt', protocol: 'http', tier: 'slow' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/http.txt', protocol: 'http', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/socks5.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/Anonym0usWork1221/Free-Proxies/proxy_files/http_proxies.txt', protocol: 'http', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/Anonym0usWork1221/Free-Proxies/proxy_files/socks5_proxies.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/Anonym0usWork1221/Free-Proxies/proxy_files/socks4_proxies.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/ALIILAPRO/Proxy/http.txt', protocol: 'http', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/ALIILAPRO/Proxy/socks4.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/vakhov/fresh-proxy-list/http.txt', protocol: 'http', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/vakhov/fresh-proxy-list/socks5.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/vakhov/fresh-proxy-list/socks4.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/Zaeem20/FREE_PROXIES_LIST/http.txt', protocol: 'http', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/hookzof/socks5_list/proxy.txt', protocol: 'socks5', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/proxy4parsing/proxy-list/http.txt', protocol: 'http', tier: 'slow' },
  { url: 'https://cdn.jsdelivr.net/gh/proxy4parsing/proxy-list/socks5.txt', protocol: 'socks5', tier: 'slow' },
]

/** One raw free-list line -> host:port address, or null when malformed. */
export function parseFreeListLine(line: string): { address: string; host: string; port: number } | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const address = trimmed.replace(/^[a-z0-9+.-]+:\/\//i, '')
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(address)
  if (!match?.[1] || !match[2]) return null
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return { address, host: match[1], port }
}

/** Deduplicate a raw address list while preserving order. */
export function dedupeAddresses(lines: string[]): { address: string; host: string; port: number }[] {
  const seen = new Set<string>()
  const out: { address: string; host: string; port: number }[] = []
  for (const line of lines) {
    const parsed = parseFreeListLine(line)
    if (!parsed) continue
    if (seen.has(parsed.address)) continue
    seen.add(parsed.address)
    out.push(parsed)
  }
  return out
}

export interface SourceBreakerOptions {
  /** Consecutive failures before a source is disabled (GoProxy: 3). */
  failureThreshold?: number
  /** Disabled-source cooldown before automatic re-enable (GoProxy: 10min). */
  cooldownMs?: number
  now?: () => number
}

interface BreakerEntry {
  consecutiveFails: number
  disabledUntil: number
}

/**
 * Per-source circuit breaker (GoProxy SourceManager semantics, in-memory):
 * N consecutive fetch failures disable the source for a cooldown, after which
 * it is re-enabled with its counter reset.
 */
export class SourceBreaker {
  #entries = new Map<string, BreakerEntry>()
  #threshold: number
  #cooldownMs: number
  #now: () => number

  constructor(options: SourceBreakerOptions = {}) {
    this.#threshold = options.failureThreshold ?? 3
    this.#cooldownMs = options.cooldownMs ?? 10 * 60_000
    this.#now = options.now ?? Date.now
  }

  canUse(url: string): boolean {
    const entry = this.#entries.get(url)
    if (!entry) return true
    if (entry.disabledUntil > this.#now()) return false
    if (entry.consecutiveFails >= this.#threshold) {
      // Cooldown elapsed: re-enable and reset (GoProxy does this lazily too).
      entry.consecutiveFails = 0
      entry.disabledUntil = 0
    }
    return true
  }

  recordSuccess(url: string): void {
    this.#entries.set(url, { consecutiveFails: 0, disabledUntil: 0 })
  }

  recordFailure(url: string): void {
    const entry = this.#entries.get(url) ?? { consecutiveFails: 0, disabledUntil: 0 }
    entry.consecutiveFails += 1
    if (entry.consecutiveFails >= this.#threshold) {
      entry.disabledUntil = this.#now() + this.#cooldownMs
    }
    this.#entries.set(url, entry)
  }

  disabledCount(): number {
    let count = 0
    for (const entry of this.#entries.values()) {
      if (entry.disabledUntil > this.#now()) count += 1
    }
    return count
  }
}

/** Select sources for a refill round by pool state (docs/ip-pool.md 3.5):
 *  warning/critical -> fast tier; emergency -> all sources (breaker ignored). */
export function selectSources(state: 'healthy' | 'warning' | 'critical' | 'emergency'): FreeSource[] {
  if (state === 'emergency') return freeSources
  if (state === 'healthy') return []
  return freeSources.filter((source) => source.tier === 'fast')
}

export interface FetchResult {
  source: FreeSource
  addresses: { address: string; host: string; port: number }[]
}

/** Fetch one source and parse its list. Transport errors propagate to the
 *  caller (the breaker records them); HTTP-level failures throw. */
export async function fetchSource(
  source: FreeSource,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(source.url, { signal: controller.signal })
    if (!response.ok) throw new Error(`source ${source.url} returned HTTP ${response.status}`)
    const text = await response.text()
    return { source, addresses: dedupeAddresses(text.split(/\r?\n/)) }
  } finally {
    clearTimeout(timer)
  }
}
