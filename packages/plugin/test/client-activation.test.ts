/**
 * DSH 0.1.7 activation regression — the exact boot failure this fix addresses:
 *
 * 1. The client manifest must NOT require `settingsScope`: 0.1.7 removed the
 *    service, a missing inject token parks the fiber in `pending`, the boot
 *    screen reports "web boot: 1 entry did not activate", and the host's
 *    plugin recovery answers by REMOVING the plugin from the profile.
 * 2. `apply` must survive a strict cordis ctx: GETting a service this fiber
 *    did not inject THROWS `cannot get property "settingsScope" without
 *    inject` instead of returning undefined (verified live on 0.1.7-rc.2 —
 *    the failure message that sent this fix through three rounds of
 *    root-causing; plain-object mocks cannot reproduce it, hence this proxy).
 *
 * Runs against the BUILT bundle (same convention as client-build.test.ts —
 * run `pnpm build:client` first): the client entry pulls .tsx modules that
 * node's type stripping cannot import directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

interface CapturedExports {
  inject?: string[]
  apply?: (ctx: unknown) => unknown
}

/** Evaluate the built bundle the way the web loader does and capture exports. */
function loadBundleExports(): CapturedExports {
  const path = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(path), 'lib/client.js missing — run `pnpm build:client` first')
  const source = readFileSync(path, 'utf8')
  let captured: { factory?: (req: (n: string) => unknown) => CapturedExports } | undefined
  const globals = globalThis as { window?: unknown }
  const previousWindow = globals.window
  globals.window = {
    __ModuleLoader__: {
      load: (entry: { factory?: (req: (n: string) => unknown) => CapturedExports }) => {
        captured = entry
      },
    },
  }
  try {
    ;(0, eval)(source)
  } finally {
    globals.window = previousWindow
  }
  assert.ok(captured?.factory, 'loader handoff (window.__ModuleLoader__.load) never ran')
  const requireStub = (name: string): unknown => {
    if (name === 'react') return { useSyncExternalStore: () => ({}) }
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null }
    if (name === 'react-dom' || name === 'react-dom/client') return {}
    if (name.startsWith('@deepseek-ai/')) return {}
    throw new Error(`unexpected external require("${name}") — bundle externals drifted from the rc.2 table`)
  }
  return captured!.factory!(requireStub)
}

/** A cordis-like strict ctx: GET of a service outside the inject list THROWS. */
function strictCtx(): unknown {
  const provided: Record<string, unknown> = {
    locale: { register: () => {}, bind: () => (k: string) => k },
    slots: { inject: () => {}, spec: () => undefined, register: () => () => {} },
    effect: (fn: () => unknown) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return new Proxy({}, {
    get(_t, p) {
      if (typeof p === 'symbol') return undefined
      if (p in provided) return provided[p]
      if (p === 'settingsScope') throw new Error(`cannot get property "${String(p)}" without inject`)
      return undefined
    },
  })
}

test('manifest no longer requires the removed settingsScope service', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.dsh?.client, 'dsh.client manifest missing')
  assert.ok(!(pkg.dsh.client.inject as string[]).includes('settingsScope'))
})

test('bundle inject matches the manifest (no settingsScope token)', () => {
  const ex = loadBundleExports()
  assert.ok(Array.isArray(ex.inject), 'exports.inject present')
  assert.ok(!ex.inject!.includes('settingsScope'), 'bundle inject must not park on settingsScope')
})

test('apply survives a strict cordis ctx without settingsScope', () => {
  const ex = loadBundleExports()
  assert.equal(typeof ex.apply, 'function', 'exports.apply present')
  assert.doesNotThrow(() => ex.apply!(strictCtx()), 'apply must contain the strict-proxy miss')
})
