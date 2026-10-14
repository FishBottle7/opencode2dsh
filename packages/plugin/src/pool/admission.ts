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
import { FREE_LANE_GATE_TOOL_NAMES, freeLaneGateTool } from '../adapter/messages.ts'
import { canonicalSessionID, disguiseHeaders, opencodeUserAgent, randomID, stableID } from '../adapter/ids.ts'
import { gradeOf, type ExitNode, type ExitPool, type ExitProtocol, type ProbeFailure } from './pool.ts'
import { exitProxyUri, httpsProxyOptions } from './dispatcher.ts'

export interface AdmissionDeps {
  pool: ExitPool
  undici: {
    /** Takes `proxyTls` for https:// candidates (see httpsProxyOptions); kept
     *  structurally loose so the existing test seam doubles still satisfy it. */
    ProxyAgent: new (options: { uri: string; clientFactory?: (origin: URL | string, options?: unknown) => unknown; proxyTls?: { rejectUnauthorized?: boolean } }) => Dispatcher
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
 * Why a probe/admission attempt failed, classified at the point of failure
 * rather than parsed back out of the human-readable `reason` string.
 *
 * The distinction that matters (live-observed 2026-10-14, 24 sampled exits of a
 * 726-node subscription pool): 23 of them failed with a transport error
 * (`SOCKS5 connection timeout`, `other side closed`, `probe timed out`) while
 * ONE answered `echo HTTP 400`. The first group is a dead link; the second is
 * a live node that refused THIS probe. Collapsing both into "failure ⇒ dead"
 * is what made 703 verified-dead exits and a handful of merely-refused ones
 * indistinguishable — and, worse, would strike a working node dead.
 *
 * The union itself lives in pool.ts (ExitHealth records it); re-exported here
 * so admission consumers keep importing it from one place.
 *
 * docs/ip-pool.md §4.2 rule table, now with an explicit failure class per row:
 *   transport   → dead          (§4.2 "5xx / 传输错误 / 超时"; note the 5xx-from-
 *                               upstream split below, which the passive path
 *                               already made on 2026-09-09)
 *   refused     → (exit, model) ban, exit stays alive (§4.2 401/403)
 *   server-error→ no health change (§4.2 5xx; upstream's fault, not the link's)
 *   quota       → exit-level cooldown (§4.2 429)
 *   geo-blocked → no health change (step-2 policy, link is fine)
 *   slow        → no health change (link is fine, gate was maxResponseMs)
 *   malformed   → no health change (node answered, body unusable)
 */
export type { ProbeFailure } from './pool.ts'

/** Classify an echo-step HTTP status (ip-api answered through the candidate). */
function classifyEchoStatus(statusCode: number): ProbeFailure {
  if (statusCode === 429) return 'quota'
  if (statusCode >= 500) return 'server-error'
  return 'refused'
}

/** Classify an upstream (Zen) HTTP status; 429 is a quota verdict, not a refusal. */
function classifyUpstreamStatus(statusCode: number): ProbeFailure {
  if (statusCode === 429) return 'quota'
  if (statusCode >= 500) return 'server-error'
  return 'refused'
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
  candidate: { address: string; protocol: ExitProtocol },
  options: { relaxed?: boolean; pinned?: boolean; timeoutMs?: number } = {},
): Promise<EchoFacts | { rejected: string; failure?: ProbeFailure }> {
  const ipEcho = deps.ipEchoUrl ?? DEFAULT_IP_ECHO
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const blocked = new Set(deps.blockedCountries ?? ['CN'])
  const maxResponseMs = options.relaxed ? RELAXED_RESPONSE_MS : 3_000

  let agent: Dispatcher | null = null
  try {
    // exitProxyUri keeps a scheme the address already carries (issue #44):
    // manual ids are parsed with their scheme, and `http://http://host:port`
    // makes undici's ProxyAgent throw InvalidArgumentError.
    agent = new deps.undici.ProxyAgent({
      uri: exitProxyUri(candidate.address, candidate.protocol),
      ...(candidate.protocol === 'https' ? httpsProxyOptions() : {}),
    })
  } catch (err) {
    return { rejected: `agent-build: ${err instanceof Error ? err.message : String(err)}`, failure: 'malformed' }
  }
  try {
    const started = Date.now()
    const echo = await withTimeout(
      deps.undici.request(ipEcho, { dispatcher: agent }),
      timeout,
      'probe',
    )
    const latencyMs = Date.now() - started
    if (echo.statusCode !== 200) {
      return { rejected: `echo HTTP ${echo.statusCode}`, failure: classifyEchoStatus(echo.statusCode) }
    }
    let body: EchoResponse
    try {
      body = JSON.parse(await echo.body.text()) as EchoResponse
    } catch {
      return { rejected: 'echo body not JSON', failure: 'malformed' }
    }
    if (body.status !== 'success' || !body.query) {
      return { rejected: 'echo did not report an exit IP', failure: 'malformed' }
    }
    const country = body.countryCode?.toUpperCase() ?? ''
    if (blocked.has(country)) return { rejected: `geo-blocked ${country}`, failure: 'geo-blocked' }
    if (latencyMs > maxResponseMs && !options.pinned) {
      return { rejected: `latency ${latencyMs}ms > ${maxResponseMs}ms`, failure: 'slow' }
    }
    return {
      exitIP: body.query,
      exitLocation: `${body.countryCode} ${body.city}`.trim(),
      latencyMs,
    }
  } catch (err) {
    // Dial failure, SOCKS5 handshake failure, timeout, socket reset: the echo
    // endpoint was NOT reachable THROUGH this exit. This is deliberately NOT
    // `transport`: an echo-side failure says nothing about whether the exit
    // can reach the real target (opencode.ai) — a proxy that blocks port 80
    // or times out to ip-api.com can still carry the HTTPS tunnel fine.
    // Callers decide what the class means: `admitCandidate` keeps a trusted
    // candidate and re-checks the tunnel, while the free-candidate refill
    // (coarseScreenBatch) treats it as a rejection because a node that cannot
    // reach the echo cannot have its geo/exit-IP recorded.
    return { rejected: err instanceof Error ? err.message : String(err), failure: 'echo-unavailable' }
  } finally {
    void agent.close().catch(() => {})
  }
}

/** Bounded fan-out helper for the coarse screen (wild candidates only).
 *  onProgress reports (screensCompleted, survivorsSoFar) as the fan-out runs
 *  (settings-page refill progress, docs §5.3). */
export async function coarseScreenBatch(
  deps: Parameters<typeof coarseScreen>[0],
  candidates: Array<{ address: string; protocol: ExitProtocol }>,
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
  /**
   * Steps 1+2 facts measured on this attempt, returned even when a LATER step
   * rejected the candidate. Previously they died with the failure and the
   * trusted path fell back to placeholders (live-measured 2026-10-13: an exit
   * whose echo answered `203.0.113.9 / JP Tokyo` was stored as
   * `exitIP: '' / latencyMs: 0`), which the pool then ranked as the fastest
   * healthy node in the table.
   */
  facts?: EchoFacts
  /**
   * WHY the attempt failed, classified at the failure site (see ProbeFailure).
   * `undefined` means the attempt never got far enough to classify (agent
   * construction threw before any request). Callers MUST branch on this rather
   * than on `admitted`/the reason string: `transport` is the only class that
   * legitimately means "this link is dead".
   */
  failure?: ProbeFailure
  /**
   * Admitted WITHOUT clearing the full chain (the trusted/pinned fallback).
   * The address keeps its pool slot so a later probe can revisit it, but its
   * health is UNKNOWN — callers must not markOk it, or a node that never
   * answered anything outranks exits that demonstrably work.
   */
  degraded?: boolean
}

export async function admitCandidate(
  deps: AdmissionDeps,
  candidate: { address: string; protocol: ExitProtocol; source: ExitNode['source'] },
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
  // Live-observed 2026-09-09: zen now REJECTS anonymous-lane chat without
  // the CLI session headers (400 MissingSessionID "can only be used in
  // OpenCode") — the smoke request must carry the same disguise set the
  // adapter sends, or every candidate fails step 4 regardless of exit
  // quality (a full refill round admitted 0 of 701 tunnel-OK survivors).
  // Per-candidate ids: the upstream correlates sessions with exits, so a
  // probe session must not collide with real adapter sessions. The canonical
  // mapping (ids.ts) is mandatory here too — the old 24-hex probe sessions
  // drew 403 FreeTierError on the free lane like every other foreign shape.
  const probeHeaders = disguiseHeaders({
    session: canonicalSessionID(`admission:${candidate.address}`),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2dsh:default-project'),
    parentSession: '',
  })

  let agent: Dispatcher | null = null
  try {
    agent = new deps.undici.ProxyAgent({
      uri: exitProxyUri(candidate.address, candidate.protocol),
      ...(candidate.protocol === 'https' ? httpsProxyOptions() : {}),
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
    let facts: EchoFacts | undefined
    let echoUnavailable = ''
    if (options.echoFacts) {
      facts = options.echoFacts
    } else {
      const verdict = await coarseScreen(deps, candidate, options)
      if ('rejected' in verdict) {
        // Echo endpoint unreachable THROUGH this exit (connect timeout, SOCKS5
        // handshake failure, reset). This says the exit cannot reach
        // ip-api.com — NOT that it cannot reach the real target. A trusted or
        // pinned candidate keeps its pool slot and is re-checked against the
        // tunnel below (the geo/exit-IP we lose is re-derived on a later
        // successful probe). Free candidates should NOT take this path: the
        // refill pre-screens them through coarseScreenBatch, which rejects
        // here; the inline free path (probeAll) deliberately continues so a
        // working free exit is not evicted by a blocked echo endpoint.
        if (verdict.failure === 'echo-unavailable') {
          echoUnavailable = verdict.rejected
          facts = undefined
        } else {
          // Non-network echo rejections (geo-blocked, slow, malformed, quota,
          // refused, server-error) are policy verdicts on a node that DID
          // answer — the candidate is refused outright.
          return { admitted: false, reason: verdict.rejected, failure: verdict.failure }
        }
      } else {
        facts = verdict
      }
    }

    // Step 3: HTTPS tunnel to the real upstream (models list, Bearer public).
    const models = await request(`${zenBase.replace(/\/+$/, '')}/v1/models`, {
      headers: { authorization: 'Bearer public', 'user-agent': opencodeUserAgent(), 'x-opencode-client': 'cli', accept: 'application/json', ...probeHeaders },
    })
    if (models.statusCode !== 200) {
      // facts ride along: steps 1+2 succeeded, so the exit IP and latency are
      // REAL even though the tunnel step refused. Dropping them here is what
      // made the trusted fallback store placeholders (see AdmissionResult.facts).
      return {
        admitted: false,
        reason: `zen models HTTP ${models.statusCode}`,
        failure: classifyUpstreamStatus(models.statusCode),
        facts,
      }
    }

    // Step 4: anonymous-lane smoke (streaming, 1 token). The free lane
    // rejects non-streaming bodies outright and wants the agent-shape gate
    // tools in the body; since ~2026-10-09 (issue #56) it additionally
    // requires a canonical ses_* session header — the same disguise the
    // adapter sends on every chat request (adapter/ids.ts).
    const smoke = await request(`${zenBase.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer public',
        'content-type': 'application/json',
        ...disguiseHeaders({
          session: canonicalSessionID('opencode2dsh:admission-smoke'),
          request: randomID('req', 16),
          project: stableID('prj', 'opencode2dsh:admission'),
          parentSession: '',
        }),
        ...probeHeaders,
      },
      body: JSON.stringify({
        model: smokeModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: true,
        stream_options: { include_usage: true },
        tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
        tool_choice: 'none',
      }),
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
          reason: `zen smoke HTTP 429${echoUnavailable ? ` (echo unavailable: ${echoUnavailable})` : ''}`,
          node: {
            id: candidate.address,
            protocol: candidate.protocol,
            source: candidate.source,
            pinned: options.pinned ?? false,
            exitIP: facts?.exitIP ?? '',
            exitLocation: facts?.exitLocation ?? '',
            latencyMs: facts?.latencyMs ?? 0,
            // Unmeasured latency is the worst grade, not the best (see
            // admitTrusted): gradeOf(0) would hand out 'S'.
            quality: facts && facts.latencyMs > 0 ? gradeOf(facts.latencyMs) : 'C',
            addedAt: Date.now(),
          },
        }
      }
      return { admitted: false, reason: `zen smoke HTTP ${smoke.statusCode}${echoUnavailable ? ` (echo unavailable: ${echoUnavailable})` : ''}`, failure: classifyUpstreamStatus(smoke.statusCode), facts }
    }

    return {
      admitted: true,
      // Tunnel + smoke both cleared; the echo never answered (blocked port,
      // ip-api timeout, proxy restrict) but the exit demonstrably serves the
      // real target. Admitted without facts: the caller keeps the node in the
      // pool, and a later probe re-derives geo/exitIP/latency. Health stays
      // 'ok' (this is a VERIFIED tunnel, unlike the degraded fallback).
      reason: echoUnavailable ? `admitted with echo unavailable: ${echoUnavailable}` : undefined,
      node: {
        id: candidate.address,
        protocol: candidate.protocol,
        source: candidate.source,
        pinned: options.pinned ?? false,
        exitIP: facts?.exitIP ?? '',
        exitLocation: facts?.exitLocation ?? '',
        latencyMs: facts?.latencyMs ?? 0,
        // Unmeasured latency is the worst grade, not the best (see
        // admitTrusted): gradeOf(0) would hand out 'S'.
        quality: facts && facts.latencyMs > 0 ? gradeOf(facts.latencyMs) : 'C',
        addedAt: Date.now(),
      },
    }
  } catch (err) {
    // Transport-level: the request never produced a response (dial failure,
    // SOCKS5 handshake, timeout, reset). The only class that means "dead".
    return { admitted: false, reason: err instanceof Error ? err.message : String(err), failure: 'transport' }
  } finally {
    void agent.close().catch(() => {})
  }
}

/** Admit a trusted-source candidate (manual/subscription/goproxy): smoke
 *  only; failure warns instead of rejecting for pinned (docs 4.5). Existing
 *  pool facts are PRESERVED on the failure fallback — a failed smoke wipes
 *  neither a previously measured exitIP/latency nor the routing key.
 *
 *  The fallback node is flagged `degraded`: the caller keeps the address in
 *  the table (so a later probe can revisit it) but must NOT markOk it. Live
 *  regression this guards (2026-10-13): sing-box had converted 0 of 470
 *  subscription nodes, every smoke failed, and the fallback stamped each node
 *  `exitIP: '' / latencyMs: 0 / quality: 'S'`; the caller then markOk'd them,
 *  so 30 never-answering exits outranked all 6 healthy free exits and took
 *  600/600 picks. Unknown latency is 0 and sorts LAST (pool.pick), and an
 *  unmeasured node is 'C', never the top grade. */
export async function admitTrusted(
  deps: AdmissionDeps,
  candidate: { address: string; protocol: ExitProtocol; source: 'manual' | 'subscription' | 'goproxy' },
  options: { pinned?: boolean; previous?: { exitIP: string; exitLocation: string; latencyMs: number; quality?: ExitNode['quality'] } } = {},
): Promise<AdmissionResult> {
  const result = await admitCandidate(deps, candidate, { pinned: options.pinned })
  if (result.admitted) {
    // Admitted with empty facts because the echo never answered (a blocked
    // echo endpoint, not a dead link): merge the pool's previously measured
    // facts so a known exitIP/latency is not wiped by an empty re-probe. The
    // tunnel + smoke cleared, so health may be 'ok'; the node just loses
    // nothing it already had.
    if (result.node && !result.node.exitIP && options.previous?.exitIP) {
      return {
        ...result,
        node: {
          ...result.node,
          exitIP: options.previous.exitIP,
          exitLocation: options.previous.exitLocation,
          latencyMs: options.previous.latencyMs,
          quality: options.previous.quality ?? result.node.quality,
        },
      }
    }
    return result
  }
  // Prefer what THIS attempt measured (steps 1+2 may have succeeded before a
  // later step refused); fall back to the pool's previously stored facts.
  const facts = result.facts ?? options.previous
  const latencyMs = facts?.latencyMs ?? 0
  deps.logger?.warn(
    `opencode2dsh: trusted exit ${candidate.address} failed admission (${result.reason}); kept as degraded with ${facts?.exitIP ? 'measured' : 'unknown'} exit facts`,
  )
  return {
    admitted: true,
    degraded: true,
    reason: result.reason,
    // Carried through unchanged: the trusted fallback keeps the address in the
    // table, but it must NOT be a black box for the caller. Without this the
    // caller could only see "degraded", which is what let 703 verified-dead
    // subscription exits sit in the table indistinguishable from genuinely
    // unprobed ones (live-observed 2026-10-14).
    failure: result.failure,
    facts: result.facts,
    node: {
      id: candidate.address,
      protocol: candidate.protocol,
      source: candidate.source,
      pinned: options.pinned ?? false,
      exitIP: facts?.exitIP ?? '',
      exitLocation: facts?.exitLocation ?? '',
      latencyMs,
      // An unmeasured node is the worst grade, not the best: gradeOf(0) would
      // hand it 'S' and put it ahead of every exit that was actually measured.
      quality: latencyMs > 0 ? (options.previous?.quality ?? gradeOf(latencyMs)) : 'C',
      addedAt: Date.now(),
    },
  }
}
