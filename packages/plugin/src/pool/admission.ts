/**
 * Admission probe — the gate a free-source candidate must pass before it
 * becomes an ExitNode (docs/ip-pool.md 4.5). Four steps, fail-fast:
 *
 *   1. connectivity + latency   (via the candidate, GET an IP echo endpoint)
 *   2. exit IP + geo            (same response; also the pool's routing key)
 *   3. HTTPS tunnel             (via the candidate, GET the Zen models list —
 *                                probing the real target beats generic test
 *                                sites, and a forged 200 cannot fake step 4)
 *   4. anonymous-lane smoke     (1-token chat via the candidate)
 *
 * All requests carry their own ProxyAgent (per-request dispatch, verified
 * against npm undici): the admission path never touches the global
 * dispatcher. manual/subscription/goproxy candidates skip steps 1-3 and run
 * step 4 only (their node facts already exist); pinned nodes are admitted
 * with warnings instead of rejections (the user vouches, 3.1).
 */

import type { Dispatcher } from 'undici'

import { ZEN_BASE_URL } from '../adapter/catalog.ts'
import { opencodeUserAgent } from '../adapter/ids.ts'
import { gradeOf, type ExitNode, type ExitPool } from './pool.ts'

export interface AdmissionDeps {
  pool: ExitPool
  undici: {
    ProxyAgent: new (options: { uri: string; clientFactory?: (origin: URL | string, options?: unknown) => unknown }) => Dispatcher
    request(url: string, options: { dispatcher: Dispatcher; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ statusCode: number; body: { text(): Promise<string> } }>
  }
  /** zen endpoint override for tests. */
  zenBaseUrl?: string
  /** ip echo override for tests. */
  ipEchoUrl?: string
  /** chat model for the smoke request (probeModels[0] upstream). */
  smokeModel?: string
  timeoutMs?: number
  blockedCountries?: string[]
  logger?: { warn(message: string): void }
}

export interface EchoFacts {
  exitIP: string
  exitLocation: string
  latencyMs: number
}

/**
 * Coarse screen (admission steps 1+2, docs/ip-pool.md 4.5 修订): one request
 * through the candidate to the ip echo. This step touches only the wild
 * candidate and a public IP service — never the anonymous lane — so callers
 * may fan it out at high concurrency (admissionFanout; GoProxy uses 300 for
 * the same reason). Steps 3-4 (which spend anonymous-lane quota) stay on the
 * bounded Prober.
 */
export async function coarseScreen(
  deps: Pick<AdmissionDeps, 'undici' | 'ipEchoUrl' | 'blockedCountries' | 'logger'>,
  candidate: { address: string; protocol: 'http' | 'socks5' },
  options: { relaxed?: boolean; pinned?: boolean; timeoutMs?: number } = {},
): Promise<EchoFacts | { rejected: string }> {
  const ipEcho = deps.ipEchoUrl ?? DEFAULT_IP_ECHO
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const blocked = new Set(deps.blockedCountries ?? ['CN'])
  const maxResponseMs = options.relaxed ? RELAXED_RESPONSE_MS : 3_000

  let agent: Dispatcher | null = null
  try {
    agent = new deps.undici.ProxyAgent({
      uri: candidate.protocol === 'socks5' ? `socks5://${candidate.address}` : `http://${candidate.address}`,
    })
  } catch (err) {
    return { rejected: `agent-build: ${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    const started = Date.now()
    const echo = await withTimeout(
      deps.undici.request(ipEcho, { dispatcher: agent }),
      timeout,
      'probe',
    )
    const latencyMs = Date.now() - started
    if (echo.statusCode !== 200) return { rejected: `echo HTTP ${echo.statusCode}` }
    let body: EchoResponse
    try {
      body = JSON.parse(await echo.body.text()) as EchoResponse
    } catch {
      return { rejected: 'echo body not JSON' }
    }
    if (body.status !== 'success' || !body.query) return { rejected: 'echo did not report an exit IP' }
    const country = body.countryCode?.toUpperCase() ?? ''
    if (blocked.has(country)) return { rejected: `geo-blocked ${country}` }
    if (latencyMs > maxResponseMs && !options.pinned) {
      return { rejected: `latency ${latencyMs}ms > ${maxResponseMs}ms` }
    }
    return {
      exitIP: body.query,
      exitLocation: `${body.countryCode} ${body.city}`.trim(),
      latencyMs,
    }
  } catch (err) {
    return { rejected: err instanceof Error ? err.message : String(err) }
  } finally {
    void agent.close().catch(() => {})
  }
}

/** Bounded fan-out helper for the coarse screen (wild candidates only).
 *  onProgress reports (screensCompleted, survivorsSoFar) as the fan-out runs
 *  (settings-page refill progress, docs §5.3). */
export async function coarseScreenBatch(
  deps: Parameters<typeof coarseScreen>[0],
  candidates: Array<{ address: string; protocol: 'http' | 'socks5' }>,
  options: { fanout?: number; relaxed?: boolean; timeoutMs?: number; onProgress?: (done: number, passed: number) => void } = {},
): Promise<Map<string, EchoFacts>> {
  const fanout = Math.max(1, options.fanout ?? 300)
  const results = new Map<string, EchoFacts>()
  const queue = [...candidates]
  let done = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const candidate = queue.shift()
      if (candidate === undefined) return
      const verdict = await coarseScreen(deps, candidate, options)
      done += 1
      if ('exitIP' in verdict) results.set(candidate.address, verdict)
      options.onProgress?.(done, results.size)
    }
  }
  await Promise.all(Array.from({ length: Math.min(fanout, candidates.length) }, () => worker()))
  return results
}

interface EchoResponse {
  status: string
  query: string
  countryCode: string
  city: string
}

const DEFAULT_IP_ECHO = 'http://ip-api.com/json/?fields=status,country,countryCode,city,query'
const DEFAULT_TIMEOUT_MS = 8_000
/** critical-state relaxed latency gate (docs/ip-pool.md 4.6 maxResponseMs). */
const RELAXED_RESPONSE_MS = 6_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** One admission probe for one candidate address. Pure effects: returns the
 *  verdict; the caller (refill scheduler) applies it to the pool. */
export interface AdmissionResult {
  admitted: boolean
  node?: ExitNode
  /** Step that rejected the candidate, with the reason (diagnostics). */
  reason?: string
  /**
   * The candidate passed every step except quota: alive proxy, working Zen
   * tunnel, 429 at smoke (2026-09-05 decision: these are good exits whose
   * quota is consumed elsewhere — free proxies are shared worldwide). The
   * caller admits them and immediately cools them (markLimited), so the
   * periodic probe retries when the cooldown expires.
   */
  limited?: boolean
}

export async function admitCandidate(
  deps: AdmissionDeps,
  candidate: { address: string; protocol: 'http' | 'socks5'; source: ExitNode['source'] },
  options: {
    relaxed?: boolean
    pinned?: boolean
    timeoutMs?: number
    /** Pre-screened echo facts (coarseScreen output): skips steps 1-2. */
    echoFacts?: EchoFacts
  } = {},
): Promise<AdmissionResult> {
  const zenBase = deps.zenBaseUrl ?? ZEN_BASE_URL
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const smokeModel = deps.smokeModel ?? 'big-pickle'

  let agent: Dispatcher | null = null
  try {
    agent = new deps.undici.ProxyAgent({
      uri: candidate.protocol === 'socks5' ? `socks5://${candidate.address}` : `http://${candidate.address}`,
    })
  } catch (err) {
    return { admitted: false, reason: `agent-build: ${err instanceof Error ? err.message : String(err)}` }
  }

  const request = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    withTimeout(
      deps.undici.request(url, { dispatcher: agent!, ...init }),
      timeout,
      init.method === 'POST' ? 'smoke' : 'probe',
    )

  try {
    // Steps 1+2 run inline only when the caller has not pre-screened the
    // candidate (coarseScreen/batch output = echoFacts; the refill loop
    // always pre-screens free candidates at high fan-out).
    let facts: EchoFacts
    if (options.echoFacts) {
      facts = options.echoFacts
    } else {
      const verdict = await coarseScreen(deps, candidate, options)
      if ('rejected' in verdict) return { admitted: false, reason: verdict.rejected }
      facts = verdict
    }

    // Step 3: HTTPS tunnel to the real upstream (models list, Bearer public).
    const models = await request(`${zenBase.replace(/\/+$/, '')}/v1/models`, {
      headers: { authorization: 'Bearer public', 'user-agent': opencodeUserAgent(), 'x-opencode-client': 'cli', accept: 'application/json' },
    })
    if (models.statusCode !== 200) {
      return { admitted: false, reason: `zen models HTTP ${models.statusCode}` }
    }

    // Step 4: anonymous-lane smoke (1 token, non-streaming).
    const smoke = await request(`${zenBase.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer public',
        'content-type': 'application/json',
        'user-agent': opencodeUserAgent(),
        'x-opencode-client': 'cli',
      },
      body: JSON.stringify({ model: smokeModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    })
    if (smoke.statusCode !== 200) {
      // 429 = the exit is good (alive + tunnel verified) but its anonymous
      // quota is currently consumed. Admit with limited: the caller cools it
      // and the periodic probe retries later (measured 2026-09-05: 429 is
      // the single largest smoke failure among tunnel-OK survivors).
      if (smoke.statusCode === 429) {
        return {
          admitted: true,
          limited: true,
          reason: `zen smoke HTTP 429`,
          node: {
            id: candidate.address,
            protocol: candidate.protocol,
            source: candidate.source,
            pinned: options.pinned ?? false,
            exitIP: facts.exitIP,
            exitLocation: facts.exitLocation,
            latencyMs: facts.latencyMs,
            quality: gradeOf(facts.latencyMs),
            addedAt: Date.now(),
          },
        }
      }
      return { admitted: false, reason: `zen smoke HTTP ${smoke.statusCode}` }
    }

    return {
      admitted: true,
      node: {
        id: candidate.address,
        protocol: candidate.protocol,
        source: candidate.source,
        pinned: options.pinned ?? false,
        exitIP: facts.exitIP,
        exitLocation: facts.exitLocation,
        latencyMs: facts.latencyMs,
        quality: gradeOf(facts.latencyMs),
        addedAt: Date.now(),
      },
    }
  } catch (err) {
    return { admitted: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    void agent.close().catch(() => {})
  }
}

/** Admit a trusted-source candidate (manual/subscription/goproxy): smoke
 *  only; failure warns instead of rejecting for pinned (docs 4.5). Existing
 *  pool facts are PRESERVED on the failure fallback — a failed smoke wipes
 *  neither a previously measured exitIP/latency nor the routing key. */
export async function admitTrusted(
  deps: AdmissionDeps,
  candidate: { address: string; protocol: 'http' | 'socks5'; source: 'manual' | 'subscription' | 'goproxy' },
  options: { pinned?: boolean; previous?: { exitIP: string; exitLocation: string; latencyMs: number; quality?: ExitNode['quality'] } } = {},
): Promise<AdmissionResult> {
  const result = await admitCandidate(deps, candidate, { pinned: options.pinned })
  if (result.admitted) return result
  // Trusted candidates: keep the node (the address is the routing key
  // fallback, 3.1), warn, and let periodic probing revisit.
  deps.logger?.warn(`opencode2dsh: trusted exit ${candidate.address} failed admission (${result.reason}); admitted with ${options.previous?.exitIP ? 'previous' : 'unknown'} exit facts`)
  const previous = options.previous
  return {
    admitted: true,
    node: {
      id: candidate.address,
      protocol: candidate.protocol,
      source: candidate.source,
      pinned: options.pinned ?? false,
      exitIP: previous?.exitIP ?? '',
      exitLocation: previous?.exitLocation ?? '',
      latencyMs: previous?.latencyMs ?? 0,
      quality: previous?.quality ?? gradeOf(previous?.latencyMs ?? 0),
      addedAt: Date.now(),
    },
  }
}
