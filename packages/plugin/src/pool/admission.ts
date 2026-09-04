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

export interface AdmissionResult {
  admitted: boolean
  node?: ExitNode
  /** Step that rejected the candidate, with the reason (diagnostics). */
  reason?: string
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
export async function admitCandidate(
  deps: AdmissionDeps,
  candidate: { address: string; protocol: 'http' | 'socks5'; source: ExitNode['source'] },
  options: { relaxed?: boolean; pinned?: boolean; timeoutMs?: number } = {},
): Promise<AdmissionResult> {
  const zenBase = deps.zenBaseUrl ?? ZEN_BASE_URL
  const ipEcho = deps.ipEchoUrl ?? DEFAULT_IP_ECHO
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const blocked = new Set(deps.blockedCountries ?? ['CN'])
  const fast = !options.relaxed
  const maxResponseMs = fast ? 3_000 : RELAXED_RESPONSE_MS
  const smokeModel = deps.smokeModel ?? 'big-pickle'

  let agent: Dispatcher | null = null
  try {
    agent = new deps.undici.ProxyAgent({
      uri: candidate.protocol === 'socks5' ? `socks5://${candidate.address}` : `http://${candidate.address}`,
    })
  } catch (err) {
    return { admitted: false, reason: `agent-build: ${err instanceof Error ? err.message : String(err)}` }
  }

  const request = <T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    withTimeout(
      deps.undici.request(url, { dispatcher: agent!, ...init }),
      timeout,
      init.method === 'POST' ? 'smoke' : 'probe',
    )

  try {
    let exitIP = ''
    let location = ''
    let latencyMs = 0

    // Steps 1+2: connectivity, latency, exit IP, geo (one request).
    const started = Date.now()
    const echo = await request(ipEcho)
    latencyMs = Date.now() - started
    if (echo.statusCode !== 200) return { admitted: false, reason: `echo HTTP ${echo.statusCode}` }
    let echoBody: EchoResponse
    try {
      echoBody = JSON.parse(await echo.body.text()) as EchoResponse
    } catch {
      return { admitted: false, reason: 'echo body not JSON' }
    }
    if (echoBody.status !== 'success' || !echoBody.query) {
      return { admitted: false, reason: 'echo did not report an exit IP' }
    }
    exitIP = echoBody.query
    location = `${echoBody.countryCode} ${echoBody.city}`.trim()
    const country = echoBody.countryCode?.toUpperCase() ?? ''
    if (blocked.has(country)) return { admitted: false, reason: `geo-blocked ${country}` }
    if (latencyMs > maxResponseMs && !options.pinned) {
      return { admitted: false, reason: `latency ${latencyMs}ms > ${maxResponseMs}ms` }
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
      return { admitted: false, reason: `zen smoke HTTP ${smoke.statusCode}` }
    }

    return {
      admitted: true,
      node: {
        id: candidate.address,
        protocol: candidate.protocol,
        source: candidate.source,
        pinned: options.pinned ?? false,
        exitIP,
        exitLocation: location,
        latencyMs,
        quality: gradeOf(latencyMs),
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
 *  only; failure warns instead of rejecting for pinned (docs 4.5). */
export async function admitTrusted(
  deps: AdmissionDeps,
  candidate: { address: string; protocol: 'http' | 'socks5'; source: 'manual' | 'subscription' | 'goproxy' },
  options: { pinned?: boolean } = {},
): Promise<AdmissionResult> {
  const result = await admitCandidate(deps, candidate, { pinned: options.pinned })
  if (result.admitted) return result
  // Trusted candidates: keep the node with unknown exit facts (the address is
  // the routing key fallback, 3.1), warn, and let periodic probing revisit.
  deps.logger?.warn(`opencode2dsh: trusted exit ${candidate.address} failed admission (${result.reason}); admitted with unknown exit facts`)
  return {
    admitted: true,
    node: {
      id: candidate.address,
      protocol: candidate.protocol,
      source: candidate.source,
      pinned: options.pinned ?? false,
      exitIP: '',
      exitLocation: '',
      latencyMs: 0,
      quality: gradeOf(0),
      addedAt: Date.now(),
    },
  }
}
