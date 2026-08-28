import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProcess } from '../src/agent-process.ts'

/**
 * The fake agent is a Node script that prints the READY line, then either
 * stays alive, or exits after `exitMs` (to exercise the restart shepherd).
 */
async function writeFakeAgent(dir: string, body: string): Promise<string> {
  const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`)
  await writeFile(path, body, 'utf8')
  return path
}

const STAY_ALIVE = `setTimeout(() => {}, 10 * 60 * 1000)
console.log('READY ' + JSON.stringify({ port: 12345, version: 'fake' }))
console.error('fake-agent stderr line')
`

const EXIT_AFTER = (ms: number) => `setTimeout(() => process.exit(7), ${ms})
console.log('READY ' + JSON.stringify({ port: 12346, version: 'fake' }))
`

/** stderr and stdout are separate pipes: chunks may arrive in any order. */
async function waitFor(desc: string, pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  assert.ok(pred(), `condition not met within ${timeoutMs}ms: ${desc}`)
}

test('start() resolves via READY handshake and reports state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2ds-ap-'))
  const agentPath = await writeFakeAgent(dir, STAY_ALIVE)
  const logs: string[] = []
  const proc = new AgentProcess(process.execPath, [agentPath], {
    restartDelayMs: 50,
    restartMaxDelayMs: 200,
    maxConsecutiveCrashes: 3,
    onLog: (line) => logs.push(line),
  })
  try {
    const info = await proc.start(5000)
    assert.deepEqual(info, { port: 12345, version: 'fake' })
    assert.equal(proc.getState(), 'ready')
    await waitFor('stderr log line captured', () => logs.some((l) => l.includes('fake-agent stderr line')))
  } finally {
    await proc.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('start() rejects when the process exits before READY', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2ds-ap-'))
  const agentPath = await writeFakeAgent(dir, 'process.exit(3)')
  const proc = new AgentProcess(process.execPath, [agentPath], {
    restartDelayMs: 50,
    restartMaxDelayMs: 200,
    maxConsecutiveCrashes: 3,
  })
  try {
    // stdout close and process exit race each other; either error is fine.
    await assert.rejects(() => proc.start(5000), /exited before READY|stdout closed before READY/)
    assert.equal(proc.getState(), 'stopped')
  } finally {
    await proc.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('unexpected exit is restarted with backoff and trips the breaker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2ds-ap-'))
  const agentPath = await writeFakeAgent(dir, EXIT_AFTER(150))
  const proc = new AgentProcess(process.execPath, [agentPath], {
    restartDelayMs: 50,
    restartMaxDelayMs: 200,
    maxConsecutiveCrashes: 3,
  })
  const restarts: Array<[number, number]> = []
  let tripped = 0
  proc.on('exit-restart', (delay, crashes) => restarts.push([delay, crashes]))
  proc.on('circuit-tripped', () => {
    tripped += 1
  })
  try {
    await proc.start(5000)
    // 3 generations, each dying after ~150ms; then the breaker trips.
    const deadline = Date.now() + 15000
    while (tripped === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    assert.equal(tripped, 1, 'circuit breaker should trip after 3 consecutive crashes')
    assert.equal(proc.getState(), 'tripped')
    assert.ok(restarts.length >= 1)
    const firstRestart = restarts.at(0)
    assert.ok(firstRestart, 'expected at least one restart event')
    assert.ok(firstRestart[0] === 50, 'first backoff equals restartDelayMs')
    assert.ok(restarts.some(([delay]) => delay === 100), 'backoff doubles up to restartMaxDelayMs')
  } finally {
    await proc.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('dispose() stops a running agent (no orphan)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2ds-ap-'))
  const agentPath = await writeFakeAgent(dir, STAY_ALIVE)
  const proc = new AgentProcess(process.execPath, [agentPath], {
    restartDelayMs: 50,
    restartMaxDelayMs: 200,
    maxConsecutiveCrashes: 3,
  })
  await proc.start(5000)
  await proc.dispose()
  assert.equal(proc.getState(), 'stopped')
  await rm(dir, { recursive: true, force: true })
})

// Keep the child_process import referenced for readers; spawn is used inside AgentProcess.
void spawn
