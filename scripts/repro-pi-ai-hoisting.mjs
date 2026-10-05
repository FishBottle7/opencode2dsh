#!/usr/bin/env node
/**
 * Repro: what a hoisted profile actually resolves for @earendil-works/pi-ai.
 *
 * Every plugin goes in as an argument, then the script asks each one, by
 * importing pi-ai from inside that plugin's own directory, which version it got
 * and whether that version is inside the range it declared. The lockfile is
 * printed too, but it is evidence, not the measurement.
 *
 *   node scripts/repro-pi-ai-hoisting.mjs <path-to-pnpm.cjs> [name:kind:range ...] [options]
 *
 * kind is `dep` or `peer`. Defaults to this plugin's pin against one peer:
 *
 *   node scripts/repro-pi-ai-hoisting.mjs <pnpm>
 *
 * A whole profile at once, with the ranges swapped, is the interesting run:
 *
 *   node scripts/repro-pi-ai-hoisting.mjs <pnpm> \
 *     a:dep:^0.82.1 b:peer:>=0.85.0 <0.88.0 c:peer:^0.87.1
 *   node scripts/repro-pi-ai-hoisting.mjs <pnpm> \
 *     a:dep:>=0.82.1 <0.88.0 b:peer:>=0.85.0 <0.88.0 c:peer:^0.87.1
 *
 * Options, so the host-side half is measured with the same script:
 *
 *   --auto-install-peers[=true]   set autoInstallPeers in the workspace file
  *   --resolve-peers-from-workspace-root[=true]   set it, rather than assume it
  *   --dedupe-peer-dependents[=false]             set it, rather than assume it
 *   --root <range>                the profile's own package.json declares
 *                                 pi-ai as a plain dependency on <range>
 *
 * The two settings flags exist because both defaults have changed pnpm's
  * answer, so neither may be assumed. `resolvePeersFromWorkspaceRoot` lets the
  * profile's own package.json satisfy an unmet peer, and `dedupePeerDependents:
  * false` builds a per-consumer peer-suffixed copy instead of forcing every peer
  * onto the one hoisted copy. Either one changes what "there is only one copy"
  * means, so every run prints the settings it used.
  *
  * Read the result this way: a hoisted profile gets ONE copy of a shared
 * dependency, at the root, for every plugin. Which version lands there is
 * decided by the first plugin in the tree that declares it as a plain
 * dependency, and every other plugin is handed that one whether or not it
 * agreed to it. A peer range that rejects the winner does not stop the install.
 *
 * pnpm v11 reads linker settings from pnpm-workspace.yaml. An .npmrc carrying
 * `node-linker=hoisted` is ignored, which silently gives you an isolated layout
 * and a profile that resolves nothing the way a real one does.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NODE = process.execPath
const PNPM = process.argv[2]
if (!PNPM) {
  console.error('usage: node repro-pi-ai-hoisting.mjs <path-to-pnpm.cjs> [name:kind:range ...] [--auto-install-peers] [--root <range>] [--resolve-peers-from-workspace-root] [--dedupe-peer-dependents]')
  process.exit(2)
}

const argv = process.argv.slice(3)
/** Walked once: a flag takes its value with it, so `--root ^0.82.1` never reads as a spec. */
const positional = []
let AUTO_INSTALL_PEERS = false
let ROOT_RANGE = null
/** Defaults are printed, never assumed: both of these changed pnpm's answer. */
const SETTINGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--auto-install-peers' || arg === '--auto-install-peers=true') {
    AUTO_INSTALL_PEERS = true
  } else if (arg === '--resolve-peers-from-workspace-root' || arg.startsWith('--resolve-peers-from-workspace-root=')) {
    SETTINGS.set('resolvePeersFromWorkspaceRoot', arg.includes('=') ? arg.split('=')[1] : 'true')
  } else if (arg === '--dedupe-peer-dependents' || arg.startsWith('--dedupe-peer-dependents=')) {
    SETTINGS.set('dedupePeerDependents', arg.includes('=') ? arg.split('=')[1] : 'false')
  } else if (arg === '--root' || arg.startsWith('--root=')) {
    ROOT_RANGE = arg.includes('=') ? arg.split('=')[1] : argv[++i]
    if (!ROOT_RANGE) {
      console.error('--root needs a version range')
      process.exit(2)
    }
  } else {
    positional.push(arg)
  }
}
const SPECS = (positional.length ? positional : ['a:dep:^0.82.1', 'b:peer:>=0.85.0 <0.88.0']).map((spec) => {
  const at = spec.indexOf(':')
  const kind = spec.indexOf(':', at + 1)
  return {
    name: spec.slice(0, at),
    range: spec.slice(kind + 1),
    kind: spec.slice(at + 1, kind) === 'peer' ? 'peer' : 'dep',
  }
})

const write = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Minimal semver: caret on 0.x locks the minor, or an explicit >= / < pair. */
function satisfies(version, range) {
  const parse = (v) => v.split('.').map(Number)
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const actual = parse(version)
  if (range.startsWith('^')) {
    const base = parse(range.slice(1))
    if (base[0] === 0) return actual[0] === 0 && actual[1] === base[1] && cmp(actual, base) >= 0
    return actual[0] === base[0] && cmp(actual, base) >= 0
  }
  let ok = true
  const lower = range.match(/>=\s*(\d+\.\d+\.\d+)/)
  const upper = range.match(/<\s*(\d+\.\d+\.\d+)/)
  if (lower) ok = ok && cmp(actual, parse(lower[1])) >= 0
  if (upper) ok = ok && cmp(actual, parse(upper[1])) < 0
  return ok
}

/** Asks the question from inside a plugin: which pi-ai, which shape, shared or nested. */
const PROBE = `
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
let dir
try {
  dir = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')))
} catch (error) {
  console.log('absent  ERR_MODULE_NOT_FOUND  no copy to load')
  process.exit(0)
}
for (;;) {
  if (existsSync(join(dir, 'package.json'))) break
  const up = dirname(dir)
  if (up === dir) break
  dir = up
}
const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
const api = await import('@earendil-works/pi-ai')
const tail = dir.slice(dir.indexOf('plugins'))
const nested = (tail.match(/node_modules/g) ?? []).length > 1
console.log([version, typeof api.getSystemMessageText === 'function' ? 'message-shaped' : 'context-shaped',
  nested ? 'a nested copy' : 'the root copy'].join('  '))
`

const dir = mkdtempSync(join(tmpdir(), 'dsh-pi-ai-hoist-'))
try {
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    `packages:\n  - .\nnodeLinker: hoisted\nhoistPattern:\n  - '*'\nautoInstallPeers: ${AUTO_INSTALL_PEERS}\n${
      SETTINGS.size ? `${[...SETTINGS].map(([k, v]) => `${k}: ${v}`).join('\n')}\n` : ''
    }`,
  )
  for (const { name, range, kind } of SPECS) {
    const field = kind === 'peer' ? 'peerDependencies' : 'dependencies'
    write(join(dir, 'plugins', name, 'package.json'), {
      name: `plugin-${name}`,
      version: '1.0.0',
      [field]: { '@earendil-works/pi-ai': range },
    })
    writeFileSync(join(dir, 'plugins', name, 'probe.mjs'), PROBE)
  }
  const root = {}
  for (const { name } of SPECS) root[`plugin-${name}`] = `file:./plugins/${name}`
  if (ROOT_RANGE) root['@earendil-works/pi-ai'] = ROOT_RANGE
  write(join(dir, 'package.json'), { name: 'profile-sim', version: '0.0.0', private: true, dependencies: root })

  const out = execFileSync(NODE, [PNPM, 'install', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const rootDir = join(dir, 'node_modules', '@earendil-works', 'pi-ai')
  const rootVersion = existsSync(rootDir)
    ? JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version
    : 'absent'
  console.log('declared:')
  if (ROOT_RANGE) console.log(`  profile    ${ROOT_RANGE.padEnd(18)} dependencies (the profile's own file)`)
  for (const { name, range, kind } of SPECS) {
    console.log(`  plugin-${name}  ${range.padEnd(18)} ${kind === 'peer' ? 'peerDependencies' : 'dependencies'}`)
  }
  console.log(`\nautoInstallPeers: ${AUTO_INSTALL_PEERS}`)
  for (const [key, value] of SETTINGS) console.log(`${key}: ${value}`)
  console.log(`the hoisted root copy: ${rootVersion}`)

  console.log('\nloaded:')
  const verdicts = []
  for (const { name, range } of SPECS) {
    const line = execFileSync(NODE, [join(dir, 'plugins', name, 'probe.mjs')], {
      cwd: join(dir, 'plugins', name),
      encoding: 'utf8',
    }).trim()
    console.log(`  plugin-${name}  ${line}`)
    const version = line.split(/\s{2,}/)[0]
    verdicts.push([name, range, version, satisfies(version, range)])
  }

  console.log('\nagainst what each plugin asked for:')
  for (const [name, range, version, ok] of verdicts) {
    const verdict = version === 'absent' ? 'NOTHING INSTALLED' : ok ? 'ok' : 'OUTSIDE ITS OWN DECLARED RANGE'
    console.log(`  plugin-${name} asked for ${range.padEnd(18)} got ${version.padEnd(8)} ${verdict}`)
  }

  const copies = (() => {
    try {
      return readdirSync(join(dir, 'node_modules', '.pnpm')).filter((d) => d.startsWith('@earendil-works+pi-ai@'))
    } catch (error) {
      return []
    }
  })()
  console.log(`\npi-ai copies pnpm put on disk: ${copies.length === 0 ? 'none beyond the root' : copies.join(', ')}`)

  const warned = out.split('\n').filter((l) => /peer/i.test(l) && l.trim())
  console.log(`pnpm warned about peers: ${warned.length === 0 ? 'no' : 'yes'}`)
  for (const line of warned) console.log(`  ${line.trim()}`)

  console.log('\nlockfile lines:')
  for (const line of readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
    .split('\n')
    .filter((l) => /^\s{6}version: file:/.test(l) || /^\s{2}'@earendil-works\/pi-ai@/.test(l))
    .slice(0, 10)) {
    console.log(`  ${line.trim()}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
