import { Config } from '../src/config.ts'
import { resolveIpPoolSettings } from '../src/ip-pool-settings/namespace.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPaths, ensureToken, resolveConfig, writeAgentConfig, defaults } from '../src/config.ts'

test('resolveConfig fills defaults and keeps overrides', () => {
  const base = resolveConfig()
  assert.equal(base.providerId, defaults.providerId)
  assert.equal(base.apiKeyEnv, defaults.apiKeyEnv)
  assert.equal(base.restartMaxDelayMs, 60000)
  const custom = resolveConfig({ providerId: 'x', refreshSeconds: 60 })
  assert.equal(custom.providerId, 'x')
  assert.equal(custom.refreshSeconds, 60)
  assert.equal(custom.apiKeyEnv, defaults.apiKeyEnv)
})

test('ensureToken persists and reuses one token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2ds-cfg-'))
  try {
    const paths = configPaths(dir)
    const first = await ensureToken(paths)
    assert.ok(first.length >= 40, 'token should be 32 bytes base64url')
    const second = await ensureToken(paths)
    assert.equal(first, second)
    const raw = await readFile(paths.tokenPath, 'utf8')
    assert.equal(raw.trim(), first)
    // blank stored value is regenerated
    await writeFile(paths.tokenPath, '\n')
    const third = await ensureToken(paths)
    assert.ok(third.length >= 40)
    assert.notEqual(third, '\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeAgentConfig emits the design.md section 8.3 template', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2ds-cfg-'))
  try {
    const paths = configPaths(dir)
    await writeAgentConfig(paths, { token: 'tok-1', refreshSeconds: 300 })
    const parsed = JSON.parse(await readFile(paths.configPath, 'utf8'))
    assert.equal(parsed.listen, '127.0.0.1:0')
    assert.deepEqual(parsed.server_keys, ['tok-1'])
    assert.equal(parsed.anonymous, true)
    assert.deepEqual(parsed.zen_keys, [])
    assert.deepEqual(parsed.go_keys, [])
    assert.equal(parsed.upstream.zen, 'https://opencode.ai/zen')
    assert.equal(parsed.models.refresh_seconds, 300)
    assert.deepEqual(parsed.proxies, ['direct'])
    // rewrite with new values replaces atomically
    await writeAgentConfig(paths, { token: 'tok-2', refreshSeconds: 60 })
    const next = JSON.parse(await readFile(paths.configPath, 'utf8'))
    assert.deepEqual(next.server_keys, ['tok-2'])
    assert.equal(next.models.refresh_seconds, 60)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config preserves subscription URLs from an older profile patch', () => {
  const config = Config({ ipPool: { subscriptions: ['https://example.test/sub'] } })
  const value = resolveIpPoolSettings(JSON.parse(JSON.stringify(config.ipPool.get())))
  assert.deepEqual(value.subscription.urls, ['https://example.test/sub'])
})

test('Config declares and bounds the stream watchdog windows, undefined when unset', () => {
  // issue #33: nothing reached ZenAdapter's constructor, so the windows were
  // unreachable. Declaring them here is what makes them settable — and, unlike
  // an undeclared key (schemastery passes those through unvalidated), it also
  // makes the schema reject a nonsensical window instead of arming it.
  const config = Config({ firstEventMs: 300, bodyIdleMs: 900, responsesBodyIdleMs: 1800 })
  assert.equal(config.firstEventMs, 300)
  assert.equal(config.bodyIdleMs, 900)
  assert.equal(config.responsesBodyIdleMs, 1800)
  for (const key of ['firstEventMs', 'bodyIdleMs', 'responsesBodyIdleMs'] as const) {
    for (const value of [-1, 0, 0.5, 600_001, 2 ** 31, Infinity, NaN, '300']) {
      assert.throws(() => Config({ [key]: value }), new RegExp(key))
    }
    assert.equal(Config({ [key]: 1 })[key], 1)
    assert.equal(Config({ [key]: 600_000 })[key], 600_000)
  }
  // No schema default on purpose: an unset window must stay undefined so the
  // adapter's own `?? DEFAULT_*_MS` owns the shipped number (one source).
  const bare = Config({})
  assert.equal(bare.firstEventMs, undefined)
  assert.equal(bare.bodyIdleMs, undefined)
  assert.equal(bare.responsesBodyIdleMs, undefined)
  // resolveConfig() is `{ ...defaults, ...config }`: the keys ride through the
  // plain ordinary half apply() hands it, untouched by `defaults`.
  assert.equal(resolveConfig({ firstEventMs: 300 }).firstEventMs, 300)
  assert.equal(resolveConfig().firstEventMs, undefined)
})
