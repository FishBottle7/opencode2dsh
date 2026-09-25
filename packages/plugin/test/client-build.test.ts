/**
 * Client-bundle build check (dsh-llm-proxy's client-build.test.js adapted):
 * verifies lib/client.js exists (run `pnpm build:client` first) and carries
 * the loader handoff, the plugin id, the settings.plugin.item card
 * registration keyed by the ip-pool namespace, the apply/inject exports the
 * shell expects, and that the bridge URL is baked in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

test('client bundle is built and well-formed', () => {
  const path = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(path), 'lib/client.js missing — run `pnpm build:client` first')
  const source = readFileSync(path, 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'loader handoff present')
  assert.ok(source.includes('"@opencode2dsh/dsh-plugin"'), 'scoped bundle id stamped')
  assert.ok(source.includes('settings.plugin.item'), 'settings.plugin.item card registration present')
  // The slot's kind is keyed on DSH >= 0.1.0-rc.7 and list (id-keyed) on older
  // builds; the card probes ctx.slots.spec and shapes the registration for
  // whichever era this host declared, so both forms must be in the bundle.
  assert.ok(/id:\s*SETTINGS_NAMESPACE/.test(source), 'list-era registration shape (options.id) present')
  assert.ok(/key:\s*SETTINGS_NAMESPACE/.test(source), 'keyed registration shape (options.key) present')
  // A rejected card must not kill the plugin fiber (the boot screen lists the
  // whole plugin as failed) — the registration is contained with a warn.
  assert.ok(source.includes('settings card rejected'), 'registration failure is contained, not fatal')
  assert.ok(source.includes('/api/opencode2dsh/ip-pool'), 'bridge prefix baked in')
  assert.ok(/exports\.apply\s*=/.test(source), 'apply exported')
  assert.ok(/exports\.inject\s*=/.test(source), 'inject exported')
})

test('client externals stay inside the rc.2 platform table', () => {
  const path = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(path), 'lib/client.js missing — run `pnpm build:client` first')
  const source = readFileSync(path, 'utf8')
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!)
  const allowed = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-runtime/client',
  ])
  for (const specifier of required) {
    assert.ok(
      allowed.has(specifier),
      `bundle requires "${specifier}" which is not in the rc.2 module table — it would miss at runtime`,
    )
  }
})

test('client manifest is declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.dsh?.client, 'dsh.client manifest missing')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['slots', 'locale', 'settingsScope'])
  assert.deepEqual(pkg.exports?.['./client'], './lib/client.js')
})

/**
 * Regression: the chevron was imported as a single named binding
 * (`IconChevronDownOutline14`). That export only exists on the 0.1.2–0.1.5
 * line; 0.1.6+ renamed it (unsuffixed + artwork/regular/medium), so the binding
 * is `undefined` there and React throws #130 — which kills the WHOLE card, not
 * just the chevron. The bundle must carry a cross-release fallback chain.
 */
test('chevron icon resolves across host releases, never a single binding', () => {
  const path = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(path), 'lib/client.js missing — run `pnpm build:client` first')
  const source = readFileSync(path, 'utf8')
  for (const name of [
    'IconChevronDownOutline',
    'IconChevronDownOutlineRegular',
    'IconChevronDownOutlineArtwork',
    'IconChevronDownOutlineMedium',
    'IconChevronDownOutline14',
  ]) {
    assert.ok(source.includes(name), `fallback chain must try ${name}`)
  }
  // The primitives must be reached as a namespace so a missing export reads as
  // `undefined` and falls through, instead of failing at import time.
  assert.ok(
    /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/.test(source),
    'primitives imported as a namespace for fallback probing',
  )
})
