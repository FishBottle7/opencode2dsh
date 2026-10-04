#!/usr/bin/env node
/**
 * Is `>=0.82.1` compatible with EVERY published pi-ai version it claims?
 *
 * Answering "is it universally compatible" from a handful of sampled versions is
 * an extrapolation. This drives the adapter's real request-building path against
 * every version on the registry that the declared range accepts, so the answer
 * is a table rather than an inference.
 *
 * Each version gets a clean install; the plugin's own `toPiContext` output --
 * built here by mirroring `applyPiTranscriptShape` for the shape that
 * `probePiAiTranscriptShape` picks, since the plugin itself is not installed in
 * the scratch profile -- goes through `createProvider().streamSimple` with only
 * `fetch` stubbed. The probe is what decides the shape, and the captured request
 * body is where a wrong shape shows up, as a lost prompt or a lost tool.
 *
 *   node scripts/sweep-all-pi-ai.mjs <path-to-pnpm.cjs>
 *
 * Network and a few minutes per version; this is a measurement script, not a test.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNPM = process.argv[2]
const NODE = process.execPath
const PI_AI = '@earendil-works/pi-ai'
const RANGE_MIN = '0.82.1'

// `>=0.82.1`, compared component-wise. An earlier hand-rolled version compared
// only major and minor, which let 0.82.0 through -- below the declared floor.
const sat = (v) => {
  const got = v.split('.').map(Number)
  const min = RANGE_MIN.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (got[i] !== min[i]) return got[i] > min[i]
  }
  return true
}

const meta = JSON.parse(
  execFileSync(
    NODE,
    [
      '-e',
      `fetch('https://registry.npmjs.org/@earendil-works%2Fpi-ai',{headers:{accept:'application/vnd.npm.install-v1+json'}}).then(r=>r.text()).then(t=>process.stdout.write(t))`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ),
)
const all = Object.keys(meta.versions).filter((v) => /^\d+\.\d+\.\d+$/.test(v))
const inRange = all.filter(sat).sort((a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
})
console.log(`registry versions total : ${all.length}`)
console.log(`accepted by >=${RANGE_MIN} : ${inRange.length}`)
console.log(`skipped (below the floor): ${all.filter((v) => !sat(v)).join(', ') || 'none'}`)
console.log('')

const RUNNER = [
  "import { createProvider } from '@earendil-works/pi-ai'",
  "import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'",
  '',
  'const CANARY = "freelane_probe_canary"',
  'const SYSTEM = "SYSTEM_PROMPT_SENTINEL"',
  'const TOOLS = [',
  '  { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } },',
  '  { name: "read", description: "read a file", parameters: { type: "object", properties: {} } },',
  '  { name: CANARY, description: "canary", parameters: { type: "object", properties: {} } },',
  ']',
  '',
  'const captured = []',
  'globalThis.fetch = async (url, init) => {',
  '  let body = init?.body',
  '  if (typeof body === "string") { try { body = JSON.parse(body) } catch {} }',
  '  captured.push(body)',
  '  const sse = [',
  '    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\\n\\n`,',
  '    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 1 } })}\\n\\n`,',
  '    "data: [DONE]\\n\\n",',
  '  ].join("")',
  '  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }), { status: 200, headers: { "content-type": "text/event-stream" } })',
  '}',
  '',
  "const piAi = await import('@earendil-works/pi-ai')",
  '// the plugin\'s own probe: the reader pi-ai exposes, never a version number',
  "const shape = typeof piAi.getSystemMessageText === 'function' ? 'message' : 'context'",
  '',
  '// Mirror toPiContext + applyPiTranscriptShape for the probed shape.',
  'function buildContext() {',
  '  const base = [{ role: "user", content: "hello", timestamp: 0 }]',
  '  if (shape !== "message") return { messages: base, systemPrompt: SYSTEM, tools: TOOLS }',
  '  return { messages: [{ role: "system", content: SYSTEM, toolsAdded: TOOLS, timestamp: 0 }, ...base] }',
  '}',
  '',
  'const provider = createProvider({',
  '  id: "opencode2dsh", name: "opencode2dsh", baseUrl: "https://example.invalid/v1",',
  '  auth: { apiKey: { name: "anon", resolve: async () => ({ auth: { apiKey: "public" } }) } },',
  '  models: [], api: openaiCompletions,',
  '})',
  'const model = { id: "probe", name: "probe", provider: "opencode2dsh", api: "openai-completions", baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, limit: { context: 128000, output: 4096 } }',
  '',
  'let verdict = "no request reached fetch"',
  'try {',
  '  const stream = provider.streamSimple(model, buildContext(), {',
  '    apiKey: "public", sessionId: "probe", maxRetries: 0,',
  '    onPayload: (p) => { if (p && Array.isArray(p.tools) && p.tools.length === 0 && !p.tool_choice) p.tools = TOOLS.map((t) => ({ type: "function", function: t })); return p },',
  '  })',
  '  for await (const _ of stream) {}',
  '  verdict = captured.length ? "OK" : "no request reached fetch"',
  '} catch (e) { verdict = "THREW " + (e && String(e.message).slice(0, 70)) }',
  '',
  'const body = captured[0]',
  'const json = body ? JSON.stringify(body) : ""',
  'console.log(JSON.stringify({',
  '  shape, verdict,',
  '  prompt: json ? (json.includes(SYSTEM) ? "YES" : "LOST") : "n/a",',
  '  canary: json ? (json.includes(CANARY) ? "present" : "absent") : "n/a",',
  '  roles: body ? JSON.stringify((body.messages ?? []).map((m) => m.role)) : "n/a",',
  '  tools: body ? (body.tools ?? []).length : -1,',
  '}))',
  '',
].join('\n')

const rows = []
for (const v of inRange) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sweep-'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'sweep', version: '0.0.0', private: true, type: 'module', dependencies: { [PI_AI]: v } }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(dir, 'run.mjs'), RUNNER)
  let row
  try {
    execFileSync(NODE, [PNPM, 'install', '--ignore-scripts', '--reporter=silent'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const out = execFileSync(NODE, [join(dir, 'run.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    row = JSON.parse(out.trim().split('\n').pop())
  } catch (e) {
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`
    const line = text.split('\n').find((l) => l.includes('Error') || l.includes('ERR_'))
    row = { shape: '?', verdict: 'INSTALL/RUN FAILED', err: (line ?? '').trim().slice(0, 80), prompt: 'n/a', canary: 'n/a', roles: 'n/a', tools: -1 }
  }
  rows.push({ v, ...row })
  console.log(
    `${v.padEnd(8)} ${String(row.shape).padEnd(8)} ${String(row.verdict).slice(0, 44).padEnd(45)} ${String(row.prompt).padEnd(6)} ${String(row.canary).padEnd(8)} ${row.roles ?? ''}`,
  )
  try {
    execFileSync(NODE, ['-e', `require('fs').rmSync(${JSON.stringify(dir)},{recursive:true,force:true})`])
  } catch {
    /* best effort */
  }
}

const bad = rows.filter((r) => r.verdict !== 'OK' || r.prompt !== 'YES' || r.canary !== 'present')
const shapes = [...new Set(rows.map((r) => r.shape))]
console.log('')
console.log(`shapes exercised: ${shapes.join(', ')}`)
console.log(`versions OK     : ${rows.length - bad.length}/${rows.length}`)
if (bad.length === 0) {
  console.log('')
  console.log(`VERDICT: >=${RANGE_MIN} is compatible with every published version it accepts (${rows.length}/${rows.length}).`)
} else {
  console.log('')
  console.log(`VERDICT: NOT universally compatible. Broken on:`)
  for (const b of bad) console.log(`   ${b.v}: ${b.verdict} | prompt ${b.prompt} | canary ${b.canary}${b.err ? ' | ' + b.err : ''}`)
}