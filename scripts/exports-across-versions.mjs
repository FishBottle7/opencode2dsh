/**
 * Ground two claims in the PR body with real output over EVERY version the
 * widened range accepts, not a sample of 11:
 *
 *   1. the probe anchors on the root named export `getSystemMessageText`
 *   2. the `@earendil-works/pi-ai/utils/transcript` subpath is not exported on
 *      seven of the nine versions the probe has to answer 'context' for, and
 *      appears at 0.85.0
 *
 *   node probe/exports-19.mjs
 */
const VERSIONS = [
  '0.82.1', '0.83.0', '0.84.0', '0.84.1', '0.84.2', '0.84.3', '0.84.4',
  '0.85.0', '0.85.1',
  '0.86.0', '0.86.1', '0.87.0', '0.87.1',
  '0.99.0', '0.99.1', '0.99.2',
  '1.0.0', '1.0.1', '1.0.2',
]

async function get(version, path) {
  const res = await fetch(`https://cdn.jsdelivr.net/npm/@earendil-works/pi-ai@${version}/${path}`)
  return res.ok ? res.text() : null
}

/** Names the root entry re-exports by name (explicit `export { a, b } from ...`). */
function rootReexports(src) {
  const names = new Set()
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*from\s*"[^"]+"/gm)) {
    for (const part of m[1].split(',')) {
      const asMatch = part.match(/\bas\s+([A-Za-z_$][\w$]*)/)
      names.add((asMatch ? asMatch[1] : part.trim()).replace(/^type\s+/, '').trim())
    }
  }
  const wildcards = [...src.matchAll(/^export\s*\*\s*from\s*"([^"]+)"/gm)].map((m) => m[1])
  return { names, wildcards }
}

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('version', 9) + pad('root getSystemMessageText', 26) + pad('"./utils/*" subpath', 22) + 'probe answers')
console.log('-'.repeat(70))

const rows = []
for (const v of VERSIONS) {
  const [index, pkg] = await Promise.all([get(v, 'dist/index.js'), get(v, 'package.json')])
  if (!index || !pkg) { console.log(`${pad(v, 9)}FETCH FAILED`); continue }
  const { names } = rootReexports(index)
  const exportsMap = Object.keys(JSON.parse(pkg).exports ?? {})
  const row = { v, named: names.has('getSystemMessageText'), subpath: exportsMap.includes('./utils/*') }
  row.probe = row.named ? 'message' : 'context'
  rows.push(row)
  console.log(
    pad(v, 9) + pad(row.named ? 'exported' : 'not exported', 26) +
    pad(row.subpath ? 'declared' : 'ABSENT', 22) + `'${row.probe}'`,
  )
}

console.log('')
console.log(`versions checked                         : ${rows.length}`)
console.log(`root exports getSystemMessageText       : ${rows.filter((r) => r.named).map((r) => r.v).join(' ')}`)
console.log(`"./utils/*" declared from                : ${rows.filter((r) => r.subpath).map((r) => r.v).join(' ')}`)

const context = rows.filter((r) => r.probe === 'context')
const noSubpath = context.filter((r) => !r.subpath)
console.log('')
console.log(`context-shaped versions                  : ${context.length} (${context.map((r) => r.v).join(' ')})`)
console.log(`of those, no "./utils/*" subpath          : ${noSubpath.length} (${noSubpath.map((r) => r.v).join(' ')})`)
console.log(`first version declaring "./utils/*"       : ${rows.find((r) => r.subpath)?.v ?? 'none'}`)

// The oracle is the api layer's own reading, measured by reading each version's
// dist/api/openai-completions.js: below 0.86.0 it reads context.systemPrompt,
// from 0.86.0 it calls getSystemMessageText on a leading role:"system" message.
const realShape = (v) => {
  const [major, minor] = v.split('.').map(Number)
  return major >= 1 || minor >= 86 ? 'message' : 'context'
}
const mismatches = rows.filter((r) => r.probe !== realShape(r.v))
console.log('')
console.log(mismatches.length === 0
  ? `VERDICT: the root named export tracks the real shape on all ${rows.length} versions.`
  : `VERDICT: MISMATCH on ${mismatches.map((r) => r.v).join(' ')}`)