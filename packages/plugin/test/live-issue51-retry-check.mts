/**
 * Issue #51 live verification, second half: replay the SAME upstream
 * conditions through ZenAdapter, but wrap each user-visible request in the
 * host's retry algorithm (dsh-llm-retry localDelay + retryableCodes) driven
 * by the adapter's FREE_LANE_RETRY_POLICY. Compare against the unretryed
 * baseline (live-issue51-probe.mts): with the policy applied, transient 429
 * bursts should almost never reach the user.
 *
 * Run: node test/live-issue51-retry-check.mts
 */
import { ZenAdapter, FREE_LANE_RETRY_POLICY } from '../src/adapter/zen-adapter.ts'

const t0 = Date.now()
const log = (tag: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag}`)

const MODEL = process.env.PROBE_MODEL ?? 'step-5-preview-free'
const REQUESTS = Number(process.env.PROBE_REQUESTS ?? 6)

/** POLICY=default replays the host stock policy (5 retries, 0.5s→10s) as the A/B control. */
const POLICY = process.env.POLICY === 'default'
  ? { maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1, retryableCodes: FREE_LANE_RETRY_POLICY.retryableCodes }
  : FREE_LANE_RETRY_POLICY
log(`policy: ${process.env.POLICY === 'default' ? 'host default (control)' : 'FREE_LANE_RETRY_POLICY'}`)

const catalog = {
  list: () => [MODEL],
  decision: () => ({ allowed: true, source: 'probe' }),
  reasoningCapability: () => ({ reasoning: true, effortValues: ['low', 'high'] }),
} as never

const adapter = new ZenAdapter(catalog, { firstEventMs: 30_000, bodyIdleMs: 60_000 })

/** dsh-llm-retry localDelay (lib/index.js:44) verbatim. */
function localDelay(retry: number): number {
  const exponential = Math.min(POLICY.initialDelayMs * 2 ** (retry - 1), POLICY.maxDelayMs)
  const jitter = 1 - POLICY.jitterRatio + 2 * POLICY.jitterRatio * Math.random()
  return Math.min(exponential * jitter, POLICY.maxDelayMs)
}

interface AttemptResult {
  ok: boolean
  code?: string
  message?: string
}

async function oneStream(): Promise<AttemptResult> {
  let finish: { kind: string; failure?: { message: string; code: string } } | null = null
  let text = ''
  try {
    const stream = await adapter.stream({
      model: MODEL,
      provider: 'opencode2dsh',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
      reasoningEffort: 'high',
      temperature: 0,
      maxTokens: 256,
    } as never)
    for (;;) {
      const next = await Promise.race([
        stream.next(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('PROBE 90s ITERATION TIMEOUT')), 90_000)),
      ])
      if (next.done) break
      const chunk = next.value as { type: string; text?: string; reason?: { kind: string; failure?: { message: string; code: string } } }
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') {
        finish = { kind: chunk.reason.kind, failure: chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted' ? chunk.reason.failure : undefined }
        break
      }
    }
  } catch (err) {
    return { ok: false, code: 'THROWN', message: (err instanceof Error ? err.message : String(err)).slice(0, 120) }
  }
  if (finish?.kind === 'stop' || text.length > 0) return { ok: true }
  return { ok: false, code: finish?.failure?.code ?? finish?.kind, message: finish?.failure?.message.slice(0, 120) }
}

let visible = 0
let absorbed = 0
for (let request = 1; request <= REQUESTS; request += 1) {
  const start = Date.now()
  let result = await oneStream()
  let retries = 0
  while (
    !result.ok
    && result.code !== undefined
    && (POLICY.retryableCodes as readonly string[]).includes(result.code)
    && retries < POLICY.maxRetries
  ) {
    retries += 1
    const delay = localDelay(retries)
    log(`  request #${request}: ${result.code} -> retry ${retries}/${POLICY.maxRetries} in ${(delay / 1000).toFixed(1)}s`)
    await new Promise((r) => setTimeout(r, delay))
    result = await oneStream()
  }
  const seconds = ((Date.now() - start) / 1000).toFixed(1)
  if (result.ok) {
    absorbed += 1
    log(`request #${request}: OK after ${retries} retries (${seconds}s total)`)
  } else {
    visible += 1
    log(`request #${request}: VISIBLE FAILURE after ${retries} retries (${seconds}s): ${result.code} ${result.message ?? ''}`)
  }
}

log(`done: ${absorbed}/${REQUESTS} requests succeeded (visible failures: ${visible})`)
process.exit(visible === 0 ? 0 : 1)
