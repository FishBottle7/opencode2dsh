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
