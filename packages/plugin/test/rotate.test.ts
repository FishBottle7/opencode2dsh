/**
 * IP-7 adapter rotate-retry tests (docs/ip-pool.md §3.4 / §8.1): a stream
 * failing BEFORE content restarts on a fresh exit (up to maxRotateAttempts);
 * any content lands -> never replayed; no pool running -> unchanged surface.
 * The pi-ai provider seam is injected through ZenAdapter's providerOverride
 * (a scripted streamSimple); the pool is real.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import {
  classifyStreamFailure,
  createRotateDelegate,
  isRegionBlocked,
  setRotateDelegate,
  shouldRotate,
} from '../src/pool/rotate.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import type { ModelCatalog } from '../src/adapter/catalog.ts'

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1', protocol: 'http', source: 'free', pinned: false,
    exitIP: '1.1.1.1', exitLocation: '', latencyMs: 100, quality: 'S', addedAt: 0,
    ...overrides,
  }
}

function fakeCatalog(): ModelCatalog {
  return {
    list: () => ['big-pickle'],
    decision: () => ({ allowed: true, source: 'test' }),
    reasoningCapability: () => ({ reasoning: true, effortValues: [] }),
  } as never as ModelCatalog
}

type ScriptedEvent = { type: string; [key: string]: unknown }

/** Scripted zen stream: each stream() call yields the next attempt's events. */
function adapterWith(script: ScriptedEvent[][]): ZenAdapter {
  let call = 0
  const provider = {
    streamSimple(): AsyncIterable<ScriptedEvent> {
      const events = script[Math.min(call, script.length - 1)]!
      call += 1
      return (async function* () {
        for (const e of events) yield e
      })()
    },
  }
  return new ZenAdapter(fakeCatalog(), { providerOverride: provider })
}

const harnessOptions = {
  model: 'big-pickle',
  messages: [],
  temperature: 0,
  maxTokens: 100,
} as never

/** Collect the chunks a stream yields (JSON-stringified for matching). */
async function collect(adapter: ZenAdapter): Promise<string[]> {
  const out: string[] = []
  const stream = await adapter.stream(harnessOptions)
  for (;;) {
    const next = await stream.next()
    if (next.done) break
    out.push(JSON.stringify(next.value))
  }
  return out
}

/**
 * A provider that yields NOTHING and never will — the tunnel that stood and
 * went mute. Parks on a REF'D timer instead of a bare promise: the adapter's
 * deadline is unref'd on purpose (a watchdog must never hold a real process
 * open), so with no ref'd handle left the event loop drains and `node --test`
 * cancels the file before the watchdog can fire. Callers clear the timer.
 */
function muteProvider(armed?: { timer?: NodeJS.Timeout }): { streamSimple(): AsyncIterable<ScriptedEvent> } {
  return {
    streamSimple(): AsyncIterable<ScriptedEvent> {
      return (async function* (): AsyncGenerator<ScriptedEvent> {
        await new Promise((resolve) => { if (armed) armed.timer = setTimeout(resolve, 60_000) })
      })()
    },
  }
}

const err = (message: string): ScriptedEvent => ({
  type: 'error',
  error: {
    api: 'openai-completions', provider: 'opencode2dsh', model: 'big-pickle',
    content: [], stopReason: 'error', errorMessage: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  },
})
const ok = (): ScriptedEvent[] => ([
  { type: 'start' },
  { type: 'text_delta', delta: 'hi' },
  { type: 'done', message: { stopReason: 'stop', content: [{}], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } },
])

test('classifyStreamFailure maps the taxonomy', () => {
  assert.equal(classifyStreamFailure('429: {"type":"FreeUsageLimitError"}'), 'limited')
  assert.equal(classifyStreamFailure('403 Forbidden'), 'refused')
  assert.equal(classifyStreamFailure('Connection error.'), 'transport')
  assert.equal(classifyStreamFailure('Request timed out'), 'transport')
  assert.equal(classifyStreamFailure('400 bad request'), null)
})

test('delegate: rotate while another usable exit exists, stop at the ceiling', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  pool.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))
  pool.markOk('a:1')
  pool.markOk('b:2')
  const delegate = createRotateDelegate(pool, { maxAttempts: 2 })
  assert.equal(delegate.decide('transport', 'm', 's', 1), true)
  assert.equal(delegate.decide('transport', 'm', 's', 2), true)
  assert.equal(delegate.decide('transport', 'm', 's', 3), false, 'ceiling')
  pool.markDead('a:1')
  pool.markDead('b:2')
  assert.equal(delegate.decide('transport', 'm', 's', 1), false, 'nothing usable -> surface the error')
})

test('adapter: pre-content transport error rotates to a healthy attempt', async () => {
  setRotateDelegate(null)
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  pool.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 3 }))
  const adapter = adapterWith([
    [err('Connection error.')],
    ok(),
  ])
  const chunks = await collect(adapter)
  assert.ok(chunks.some((c) => c.includes('hi')), 'the rotated attempt delivered content')
  assert.ok(!chunks.some((c) => c.includes('Connection error')), 'the intermediate error never surfaces')
  setRotateDelegate(null)
})

test('adapter: content followed by an error is NEVER replayed (3.4)', async () => {
  setRotateDelegate(null)
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 3 }))
  const adapter = adapterWith([
    [{ type: 'start' }, { type: 'text_delta', delta: 'partial' }, err('Connection error.')],
    [{ type: 'start' }, { type: 'text_delta', delta: 'SHOULD-NOT-APPEAR' }, { type: 'done', message: { stopReason: 'stop', content: [{}], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }],
  ])
  const chunks = await collect(adapter)
  assert.ok(chunks.some((c) => c.includes('partial')), 'partial content delivered')
  assert.ok(!chunks.some((c) => c.includes('SHOULD-NOT-APPEAR')), 'no replay after content')
  setRotateDelegate(null)
})

test('adapter: no delegate installed -> the original stream surface is unchanged', async () => {
  setRotateDelegate(null)
  assert.equal(shouldRotate('transport', 'm', 's', 1), false)
  const adapter = adapterWith([[err('Connection error.')]])
  const chunks = await collect(adapter)
  assert.ok(chunks.some((c) => c.includes('Connection error')), 'error surfaces when no pool runs')
})

// -- 5xx rotates; RegionError bans the sticky pairing on sight (docs 4.2) ----

test('classifyStreamFailure: 5xx joins the rotate set as transport', () => {
  assert.equal(classifyStreamFailure('500: {"type":"error","message":"Internal server error"}'), 'transport')
  assert.equal(classifyStreamFailure('502 Bad Gateway'), 'transport')
  assert.equal(classifyStreamFailure('404 Not Found'), null, 'non-5xx client errors still surface')
})

test('isRegionBlocked detects the deterministic RegionError body', () => {
  assert.equal(isRegionBlocked('403: {"type":"RegionError","message":"This model is not available in your country."}'), true)
  assert.equal(isRegionBlocked('403: Forbidden'), false)
})

test('delegate: deterministic refusal bans the sticky exit pairing immediately', () => {
  const pool = new ExitPool()
  // distinct latencies: pick() must deterministically bind the session to
  // a:1 (same-latency nodes fall through to the same-tier shuffle coin).
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 100 }))
  pool.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 200 }))
  pool.markOk('a:1')
  pool.markOk('b:2')
  // the session is sticky on a:1 (as the dispatcher would have bound it)
  pool.pick('ses', 'muse')
  const delegate = createRotateDelegate(pool, { maxAttempts: 3 })
  assert.equal(delegate.decide('refused', 'muse', 'ses', 1, true), true, 'rotates to b:2')
  assert.equal(pool.isUsable('a:1', 'muse'), false, 'a:1 banned for muse on sight')
  assert.equal(pool.isUsable('a:1', 'other'), true, 'a:1 still serves other models')
  // next pick for muse must avoid a:1
  assert.equal(pool.pick('ses2', 'muse'), 'b:2')
})

test('adapter: a 500 before content rotates instead of surfacing', async () => {
  setRotateDelegate(null)
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  pool.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 3 }))
  const adapter = adapterWith([
    [err('500: {"type":"error","message":"Internal server error"}')],
    ok(),
  ])
  const chunks = await collect(adapter)
  assert.ok(chunks.some((c) => c.includes('hi')), 'rotated past the 500 to a healthy exit')
  assert.ok(!chunks.some((c) => c.includes('Internal server error')), 'the 500 never surfaces')
  setRotateDelegate(null)
})

// -- watchdogs: a silent stream surfaces as a transport failure, never a hang ----

/** Scripted provider whose first call never yields a single event. */
function adapterWithWatchdog(
  script: ScriptedEvent[][],
  windows: { firstEventMs: number; bodyIdleMs: number },
): ZenAdapter {
  let call = 0
  const provider = {
    streamSimple(): AsyncIterable<ScriptedEvent> {
      const events = script[Math.min(call, script.length - 1)]!
      call += 1
      return (async function* () {
        for (const e of events) {
          if (typeof e === 'undefined') continue
          // yield microtask-paced events: an explicit await-free loop would
          // deliver everything at once and never exercise the deadline
          await Promise.resolve()
          yield e
        }
      })()
    },
  }
  return new ZenAdapter(fakeCatalog(), { providerOverride: provider, ...windows })
}

test('adapter watchdog: pre-content silence times out and rotates to a live exit', async () => {
  setRotateDelegate(null)
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  pool.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 3 }))
  // attempt 1: a stream that never sends ANY event (the tunnel that stood
  // and went mute — the 70-minute hang shape); attempt 2: healthy.
  let call = 0
  const armed: { timer?: NodeJS.Timeout } = {}
  const mute = muteProvider(armed)
  const provider = {
    streamSimple(): AsyncIterable<ScriptedEvent> {
      call += 1
      if (call === 1) return mute.streamSimple()
      return (async function* () {
        for (const e of ok()) yield e
      })()
    },
  }
  const adapter = new ZenAdapter(fakeCatalog(), { providerOverride: provider, firstEventMs: 80 })
  try {
    const chunks = await collect(adapter)
    assert.ok(chunks.some((c) => c.includes('hi')), 'the watchdog rotated past the mute exit to content')
    assert.ok(!chunks.some((c) => c.includes('timeout')), 'the intermediate watchdog error never surfaces')
  } finally {
    clearTimeout(armed.timer)
    setRotateDelegate(null)
  }
})

test('adapter watchdog: no usable exit left -> the timeout error surfaces with the story', async () => {
  setRotateDelegate(null)
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 3 }))
  const armed: { timer?: NodeJS.Timeout } = {}
  const adapter = new ZenAdapter(fakeCatalog(), { providerOverride: muteProvider(armed), firstEventMs: 80 })
  try {
    const chunks = await collect(adapter)
    const surfaced = chunks.find((c) => c.includes('timeout'))
    assert.ok(surfaced !== undefined, 'the watchdog error surfaces when rotation is impossible')
    assert.ok(surfaced!.includes('first stream event timeout'), 'the message names the silence window')
  } finally {
    clearTimeout(armed.timer)
    setRotateDelegate(null)
  }
})

test('adapter watchdog: mid-stream silence after delivered content surfaces, never hangs', async () => {
  setRotateDelegate(null)
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 3 }))
  // content flows, then the stream goes mute forever (dead tunnel mid-body).
  // No rotate is allowed after content (3.4) — the failure must SURFACE.
  let sawContent = false
  const armed: { timer?: NodeJS.Timeout } = {}
  const mute = muteProvider(armed)
  const provider = {
    streamSimple(): AsyncIterable<ScriptedEvent> {
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'text_delta', delta: 'partial' }
        sawContent = true
        // mute mid-body, forever
        await new Promise<void>((resolve) => {
          const later = setTimeout(resolve, 60_000)
          clearTimeout(armed.timer)
          armed.timer = later
        })
      })()
    },
  }
  const adapter = new ZenAdapter(fakeCatalog(), { providerOverride: provider, firstEventMs: 40, bodyIdleMs: 80 })
  try {
    const chunks = await collect(adapter)
    assert.ok(sawContent, 'content was delivered before the mute')
    assert.ok(chunks.some((c) => c.includes('partial')), 'partial content reached the consumer')
    const surfaced = chunks.find((c) => c.includes('body idle timeout'))
    assert.ok(surfaced !== undefined, 'the mid-stream mute surfaces as a terminal error instead of hanging')
  } finally {
    clearTimeout(armed.timer)
    setRotateDelegate(null)
  }
})
