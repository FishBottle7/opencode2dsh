/**
 * Issue #51 live probe: hammer the Zen anonymous lane with the reporter's
 * exact combo (step-5-preview-free, reasoningEffort high) through the REAL
 * ZenAdapter path and record what failures look like: how often 429s occur,
 * the raw error text, and how long a failure streak lasts.
 *
 * Run: node test/live-issue51-probe.mts
 */
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'

const t0 = Date.now()
const log = (tag: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag}`)

const MODEL = process.env.PROBE_MODEL ?? 'step-5-preview-free'
const ATTEMPTS = Number(process.env.PROBE_ATTEMPTS ?? 8)
const GAP_MS = Number(process.env.PROBE_GAP_MS ?? 3000)

const catalog = {
  list: () => [MODEL],
  decision: () => ({ allowed: true, source: 'probe' }),
  reasoningCapability: () => ({ reasoning: true, effortValues: ['low', 'high'] }),
} as never

const adapter = new ZenAdapter(catalog, { firstEventMs: 30_000, bodyIdleMs: 60_000 })

interface Outcome {
  attempt: number
  ok: boolean
  seconds: number
  finishKind?: string
  code?: string
  message?: string
  text?: string
}

const outcomes: Outcome[] = []
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const start = Date.now()
  let text = ''
  let finish: { kind: string; failure?: { message: string; code: string } } | null = null
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
    finish = { kind: 'thrown', failure: { message: err instanceof Error ? err.message : String(err), code: '' } }
  }
  const seconds = (Date.now() - start) / 1000
  const ok = finish?.kind === 'stop' || (text.length > 0 && finish?.kind !== 'error')
  outcomes.push({
    attempt,
    ok,
    seconds: Math.round(seconds * 10) / 10,
    finishKind: finish?.kind,
    code: finish?.failure?.code,
    message: finish?.failure?.message.slice(0, 200),
    text: text.slice(0, 60),
  })
  log(`#${attempt} ${ok ? 'OK' : 'FAIL'} ${seconds.toFixed(1)}s kind=${finish?.kind} code=${finish?.failure?.code ?? '-'} ${ok ? `text=${JSON.stringify(text.slice(0, 40))}` : `msg=${finish?.failure?.message.slice(0, 160)}`}`)
  if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, GAP_MS))
}

const fails = outcomes.filter((o) => !o.ok)
log(`done: ${outcomes.length - fails.length}/${outcomes.length} ok`)
if (fails.length > 0) {
  const streak = fails.map((f) => f.attempt).join(',')
  log(`failed attempts: ${streak}`)
}
process.exit(0)
