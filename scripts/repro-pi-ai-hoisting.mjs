#!/usr/bin/env node
/**
 * Repro: a hoisted DSH profile holds exactly ONE copy of @earendil-works/pi-ai,
 * so a plugin that pins an old minor forces that copy onto every other plugin in
 * the profile, past what their own peer ranges allow. pnpm installs anyway,
 * because a hoisted profile does not enforce peer ranges.
 *
 * Layout mirrors what DSH creates:
 *   .npmrc                          node-linker=hoisted, auto-install-peers=false
 *   package.json                    the profile: two plugins as file: deps
 *   plugins/a/                      depends on pi-ai ^0.82.1        (the pin)
 *   plugins/b/                      peer-depends on pi-ai >=0.85    (the victim)
 *
 *   node scripts/repro-pi-ai-hoisting.mjs <path-to-pnpm.cjs> [range-a] [range-b]
 *
 * Both ranges are arguments so a reader can put their own next to ours:
 *
 *   node scripts/repro-pi-ai-hoisting.mjs <pnpm> '^0.82.1' '>=0.85.0 <0.88.0'
 *   node scripts/repro-pi-ai-hoisting.mjs <pnpm> '>=0.82.1 <0.88.0' '>=0.85.0 <0.88.0'
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What the plugin that ships with the profile pins. */
const PLUGIN_A_RANGE = process.argv[3] ?? '^0.82.1'
/** What a second, unrelated plugin in the same profile asks for. */
const PLUGIN_B_PEER_RANGE = process.argv[4] ?? '>=0.85.0 <0.88.0'

const NODE = process.execPath
const PNPM = process.argv[2]

const write = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * The single pi-ai version a whole profile ends up with.
 *
 * Both plugins are dependencies of the profile root, so the lockfile records
 * their resolutions under the `.` importer. A plugin that declares pi-ai as a
 * plain dependency contributes nothing to that resolution string -- only the
 * peer edge does, which is exactly the asymmetry that causes the bug: the peer
 * is recorded as `file:plugins/b(@earendil-works/pi-ai@0.82.1(...))`, i.e. the
 * older version plugin-a dragged in, not the range plugin-b asked for.
 */
function resolvedVersion(lock, plugin) {
  const importers = lock.slice(lock.indexOf('\nimporters:'), lock.indexOf('\npackages:'))
  const entry = importers.match(new RegExp(`^\\s{6}${plugin}:\\n\\s{8}specifier: .*\\n\\s{8}version: (.+)$`, 'm'))?.[1]
  return entry?.match(/pi-ai@(\d+\.\d+\.\d+)/)?.[1] ?? null
}

/** Minimal semver check: caret, or an explicit >= / < pair. */
function satisfies(version, range) {
  const parse = (v) => v.split('.').map(Number)
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const actual = parse(version)
  if (range.startsWith('^')) {
    const base = parse(range.slice(1))
    return actual[0] === base[0] && cmp(actual, base) >= 0
  }
  const lower = range.match(/>=\s*(\d+\.\d+\.\d+)/)
  const upper = range.match(/<\s*(\d+\.\d+\.\d+)/)
  let ok = true
  if (lower) ok = ok && cmp(actual, parse(lower[1])) >= 0
  if (upper) ok = ok && cmp(actual, parse(upper[1])) < 0
  return ok
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-pi-ai-hoist-'))
try {
  writeFileSync(join(dir, '.npmrc'), 'node-linker=hoisted\nauto-install-peers=false\n')

  write(join(dir, 'plugins', 'a', 'package.json'), {
    name: 'plugin-a',
    version: '1.0.0',
    dependencies: { '@earendil-works/pi-ai': PLUGIN_A_RANGE },
  })
  write(join(dir, 'plugins', 'b', 'package.json'), {
    name: 'plugin-b',
    version: '1.0.0',
    peerDependencies: { '@earendil-works/pi-ai': PLUGIN_B_PEER_RANGE },
  })

  write(join(dir, 'package.json'), {
    name: 'profile-sim',
    version: '0.0.0',
    private: true,
    dependencies: {
      'plugin-a': 'file:./plugins/a',
      'plugin-b': 'file:./plugins/b',
    },
  })

  const out = execFileSync(NODE, [PNPM, 'install', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const lock = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
  const rootCopy = lock.match(/^  '@earendil-works\/pi-ai@(\d+\.\d+\.\d+)':/m)?.[1] ?? null
  const aSees = resolvedVersion(lock, 'plugin-a')
  const bSees = resolvedVersion(lock, 'plugin-b') ?? rootCopy
  console.log(`plugin-a declares        ${PLUGIN_A_RANGE}`)
  console.log(`plugin-b peer-depends on ${PLUGIN_B_PEER_RANGE}`)
  console.log('')
  console.log(`one pi-ai copy on disk   ${rootCopy}`)
  console.log(`plugin-a resolves        ${aSees ?? 'no peer edge (it is the plain dependency)'}`)
  console.log(`plugin-b resolves        ${bSees}   <- its own peer range says ${PLUGIN_B_PEER_RANGE}`)
  console.log('')

  const broken = !satisfies(bSees, PLUGIN_B_PEER_RANGE)
  console.log(
    broken
      ? `BROKEN: plugin-b peer-depends on ${PLUGIN_B_PEER_RANGE} but the profile gave it ${bSees}. pnpm installed it anyway -- a hoisted profile does not enforce peer ranges.`
      : `OK: the profile gave plugin-b ${bSees}, which satisfies its peer range.`,
  )

  console.log('\nlockfile:')
  for (const line of lock.split('\n').filter((l) => /plugin-b|pi-ai@/.test(l)).slice(0, 8)) {
    console.log(`  ${line.trim()}`)
  }

  const warned = out.split('\n').filter((l) => /peer|ignored/i.test(l))
  if (warned.length) {
    console.log('\npnpm said:')
    for (const line of warned) console.log(`  ${line}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}