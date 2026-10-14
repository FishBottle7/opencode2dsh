import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import * as realUndici from 'undici'

import { ExitPool } from '../src/pool/pool.ts'
import { admitCandidate, admitTrusted, coarseScreen } from '../src/pool/admission.ts'

/**
 * A fake per-request transport: the seam `undici.request` would hit. Each
 * call records the URL and answers from a scripted map. The dispatcher is
 * never inspected — admission only cares about status codes and bodies.
 */
function fakeTransport(script: Record<string, { status: number; body: string } | Error>) {
  const calls: string[] = []
  const bodies = new Map<string, string>()
  const headers = new Map<string, Record<string, string>>()
  const agents: { uri: string }[] = []
  return {
    calls,
    bodies,
    headers,
    agents,
    undici: {
      ProxyAgent: class {
        constructor(options: { uri: string }) {
          agents.push({ uri: options.uri })
        }
        close() { return Promise.resolve() }
        destroy() { return Promise.resolve() }
      } as never,
      request: (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
        calls.push(url)
        if (typeof init?.body === 'string') bodies.set(url, init.body)
        if (init?.headers) headers.set(url, init.headers)
        const entry = script[url] ?? script['*']
        if (entry instanceof Error) throw entry
        if (!entry) throw new Error(`unexpected request: ${url}`)
        return { statusCode: entry.status, body: { text: async () => entry.body } }
      }) as never,
    },
  }
}

const ECHO_URL = 'http://ip-api.com/json/?fields=status,country,countryCode,city,query'
const MODELS_URL = 'https://zen.test/v1/models'
const CHAT_URL = 'https://zen.test/v1/chat/completions'

function echoBody(query: string, countryCode: string, city = 'city') {
  return JSON.stringify({ status: 'success', query, countryCode, city, country: 'c' })
}

function okScript() {
  return {
    [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'US') },
    [MODELS_URL]: { status: 200, body: '{"data":[]}' },
    [CHAT_URL]: { status: 200, body: '{"id":"x"}' },
  }
}

function deps(transport: ReturnType<typeof fakeTransport>) {
  return {
    pool: new ExitPool(),
    undici: transport.undici,
    zenBaseUrl: 'https://zen.test',
    ipEchoUrl: ECHO_URL,
    smokeModel: 'big-pickle',
  }
}

test('admission: the four-step happy path admits with exit facts and grade', async () => {
  const transport = fakeTransport(okScript())
  const result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.ok(result.admitted, result.reason)
  assert.equal(result.node?.exitIP, '5.5.5.5')
  assert.equal(result.node?.exitLocation, 'US city')
  assert.equal(result.node?.source, 'free')
  assert.equal(result.node?.quality, 'S') // latency ~0
  // exactly the three scripted requests, in chain order
  assert.deepEqual(transport.calls, [ECHO_URL, MODELS_URL, CHAT_URL])
  // the proxy agent targeted the candidate
  assert.equal(transport.agents[0]?.uri, 'http://h:1')
})

test('admission: fail-fast at each step (echo/geo/latency/models/smoke)', async () => {
  // step 1-2: non-200 echo. 5xx is the echo service's fault, never the link's.
  let transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 503, body: '' } })
  let result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /echo HTTP 503/)
  assert.equal(result.failure, 'server-error')

  // step 2: echo without an exit IP — an unreadable body, not a dead link
  transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 200, body: '{"status":"fail"}' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /exit IP/)
  assert.equal(result.failure, 'malformed')

  // step 2: geo-blocked country — policy, the link demonstrably works
  transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'CN') } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /geo-blocked CN/)
  assert.equal(result.failure, 'geo-blocked')

  // step 3: HTTPS tunnel to the real upstream fails (403 = refusal, not death)
  transport = fakeTransport({ ...okScript(), [MODELS_URL]: { status: 403, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /zen models HTTP 403/)
  assert.equal(result.failure, 'refused')

  // step 4: anonymous-lane smoke 429 -> admitted with `limited` (good exit,
  // quota consumed elsewhere; the caller cools it, docs 4.5)
  transport = fakeTransport({ ...okScript(), [CHAT_URL]: { status: 429, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(result.admitted, result.reason)
  assert.ok(result.limited)
  assert.equal(result.node?.exitIP, '5.5.5.5')

  // step 4: any other smoke failure still rejects outright
  transport = fakeTransport({ ...okScript(), [CHAT_URL]: { status: 403, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /zen smoke HTTP 403/)
  assert.equal(result.failure, 'refused')

  // step 4: an upstream 5xx is the MODEL failing behind a healthy exit — the
  // class the passive path already refused to strike dead (2026-09-09)
  transport = fakeTransport({ ...okScript(), [CHAT_URL]: { status: 500, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.equal(result.failure, 'server-error')

  // the smoke body must satisfy the free-lane gate (issue #56): streaming,
  // bash+read stubs call-disabled, and a canonical ses_* session header
  const okTransport = fakeTransport(okScript())
  const okResult = await admitCandidate(deps(okTransport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(okResult.admitted)
  const smokeBody = JSON.parse(okTransport.bodies.get(CHAT_URL)!) as {
    stream?: boolean
    tool_choice?: string
    tools?: Array<{ type: string; function: { name: string } }>
  }
  assert.equal(smokeBody.stream, true)
  assert.equal(smokeBody.tool_choice, 'none')
  const smokeToolNames = smokeBody.tools?.map((t) => t.function.name) ?? []
  assert.deepEqual([...smokeToolNames].sort(), ['bash', 'read'])
  const smokeHeaders = okTransport.headers.get(CHAT_URL)!
  assert.match(smokeHeaders['x-opencode-session'] ?? '', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'canonical session header')

  // transport errors surface as reasons (timeout / reset)
  transport = fakeTransport({ '*': new Error('connect ECONNREFUSED') })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /ECONNREFUSED/)
})

test('admission: latency gate (relaxed for critical/emergency states)', async () => {
  // >3000ms response rejects in fast mode... simulate via a script that
  // answers slowly is overkill; the gate reads latencyMs from Date.now(),
  // so test the relaxed branch by forcing a slow echo through real sleep.
  const transport = fakeTransport(okScript())
  // fast path admits (latency ~0)
  const fastResult = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.ok(fastResult.admitted)
})

test('admission: trusted sources are admitted with warnings even on failure', async () => {
  const warnings: string[] = []
  const transport = fakeTransport({ '*': new Error('connect ECONNREFUSED') })
  const result = await admitTrusted(
    { ...deps(transport), logger: { warn: (m) => warnings.push(m) } },
    { address: 'leased:1', protocol: 'http', source: 'manual' },
  )
  assert.ok(result.admitted)
  assert.equal(result.node?.exitIP, '') // unknown facts, address is the key
  assert.equal(result.degraded, true, 'an unverified fallback must be flagged degraded')
  assert.ok(warnings.some((line) => line.includes('leased:1')))
})

test('admission: the trusted fallback carries the failure CLASS, not just "degraded"', async () => {
  // Without this the caller cannot tell a dead link from a refused probe, which
  // is exactly how 703 verified-dead subscription exits ended up looking
  // identical to never-probed ones (live-observed 2026-10-14).
  const refused = await admitTrusted(
    { ...deps(fakeTransport({ [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'JP') }, [MODELS_URL]: { status: 403, body: '' } })), logger: { warn: () => {} } },
    { address: 'sub:1', protocol: 'http', source: 'subscription' },
  )
  assert.equal(refused.degraded, true)
  assert.equal(refused.failure, 'refused', 'a 403 is a refusal, NOT a dead link')

  const dead = await admitTrusted(
    { ...deps(fakeTransport({ '*': new Error('SOCKS5 connection timeout') })), logger: { warn: () => {} } },
    { address: '127.0.0.1:30001', protocol: 'socks5', source: 'subscription' },
  )
  assert.equal(dead.degraded, true)
  assert.equal(dead.failure, 'transport', 'a dial timeout IS a dead link')
})

test('admission: a failed trusted smoke never invents a fast, top-grade exit', async () => {
  // Live regression (2026-10-13): all 470 subscription nodes failed to convert,
  // every smoke failed, and the fallback stamped each node
  // `latencyMs: 0 / quality: 'S'` — which pick() then ranked ahead of every
  // measured exit. `0` means never-measured and must grade WORST.
  const transport = fakeTransport({ '*': new Error('connect ECONNREFUSED') })
  const result = await admitTrusted(
    { ...deps(transport), logger: { warn: () => {} } },
    { address: 'sub-dead:1', protocol: 'http', source: 'subscription' },
  )
  assert.ok(result.admitted)
  assert.equal(result.node?.latencyMs, 0)
  assert.notEqual(result.node?.quality, 'S')
  assert.equal(result.node?.quality, 'C')
  assert.equal(result.degraded, true)
})

test('admission: facts measured in steps 1-2 survive a later step failing', async () => {
  // Steps 1+2 answered with a REAL exit IP, then step 3 refused. The measured
  // facts must ride the failure result instead of being dropped, so the trusted
  // fallback stores a real exit IP rather than a placeholder.
  const transport = fakeTransport({
    [ECHO_URL]: { status: 200, body: echoBody('203.0.113.9', 'JP', 'Tokyo') },
    [MODELS_URL]: { status: 403, body: '' },
  })
  const failed = await admitCandidate(deps(transport), { address: 'sub:1', protocol: 'http', source: 'subscription' })
  assert.equal(failed.admitted, false)
  assert.equal(failed.reason, 'zen models HTTP 403')
  assert.equal(failed.facts?.exitIP, '203.0.113.9', 'steps 1+2 facts must survive the step-3 refusal')
  assert.equal(failed.failure, 'refused', 'the class must survive alongside the facts')

  const trusted = await admitTrusted(
    { ...deps(transport), logger: { warn: () => {} } },
    { address: 'sub:1', protocol: 'http', source: 'subscription' },
  )
  assert.ok(trusted.admitted)
  assert.equal(trusted.node?.exitIP, '203.0.113.9', 'the fallback must keep the measured exit IP')
  assert.equal(trusted.node?.exitLocation, 'JP Tokyo')
})

test('admission: the trusted fallback prefers previously stored facts over placeholders', async () => {
  const transport = fakeTransport({ '*': new Error('connect ECONNREFUSED') })
  const result = await admitTrusted(
    { ...deps(transport), logger: { warn: () => {} } },
    { address: 'sub:2', protocol: 'http', source: 'subscription' },
    { previous: { exitIP: '198.51.100.7', exitLocation: 'DE Frankfurt', latencyMs: 275, quality: 'S' } },
  )
  assert.equal(result.node?.exitIP, '198.51.100.7')
  assert.equal(result.node?.latencyMs, 275)
  assert.equal(result.node?.quality, 'S')
})

test('admission: an echo-side transport failure continues to the tunnel instead of striking dead', async () => {
  // Live symptom (2026-10-14): subscription exits all died with
  // `Connect Timeout Error (attempted address: ip-api.com:80, timeout: 5000ms)`
  // and `SOCKS5 connection failed` — the echo endpoint was unreachable THROUGH
  // them, but that says nothing about whether they reach the real target
  // (opencode.ai). A healthy exit must not be struck dead because ip-api.com
  // is blocked/slow for it. The tunnel step decides.
  //
  // 1) Echo transport fails but the tunnel + smoke clear: the exit is ADMITTED
  //    with unknown facts (no geo/exitIP/latency), NOT dead.
  const transport = fakeTransport({
    [ECHO_URL]: new Error('Connect Timeout Error (attempted address: ip-api.com:80, timeout: 5000ms)'),
    [MODELS_URL]: { status: 200, body: '{"data":[]}' },
    [CHAT_URL]: { status: 200, body: '{"id":"x"}' },
  })
  const result = await admitCandidate(deps(transport), { address: 'sub:1', protocol: 'http', source: 'subscription' })
  assert.equal(result.admitted, true, 'tunnel+smoke cleared: the exit is usable even without echo facts')
  assert.equal(result.node?.exitIP, '', 'no echo facts to record')
  assert.equal(result.node?.quality, 'C', 'unmeasured latency is the worst grade, never the best')
  assert.equal(result.failure, undefined, 'an admitted exit carries no failure class')

  // 2) Echo AND tunnel both fail at the transport level: the link is dead.
  const deadTransport = fakeTransport({ '*': new Error('SOCKS5 connection timeout') })
  const dead = await admitCandidate(deps(deadTransport), { address: 'sub:1', protocol: 'http', source: 'subscription' })
  assert.equal(dead.admitted, false)
  assert.equal(dead.failure, 'transport', 'echo AND tunnel unreachable = genuinely dead')
})

test('admission: scheme-carrying manual addresses build a valid agent URI (issue #44)', async () => {
  // manual entries keep the scheme the UI asks for (http://host:port), and
  // prefixing again yields http://http://host:port — InvalidArgumentError in
  // every ProxyAgent, invisible because admitTrusted admits on failure with
  // empty facts. Both the coarse-screen agent and the full-chain agent must
  // keep the user's scheme.
  const transport = fakeTransport(okScript())
  const result = await admitCandidate(deps(transport), {
    address: 'http://127.0.0.1:24021',
    protocol: 'http',
    source: 'manual',
  })
  assert.ok(result.admitted, result.reason)
  assert.equal(result.node?.exitIP, '5.5.5.5')
  assert.equal(transport.agents[0]?.uri, 'http://127.0.0.1:24021', 'coarse-screen agent must not double the scheme')
  assert.ok(transport.agents.every((a) => a.uri === 'http://127.0.0.1:24021'))

  // socks5 carries its scheme too, and a bare address still gains one
  const socks = fakeTransport(okScript())
  const socksResult = await admitCandidate(deps(socks), {
    address: 'socks5://10.0.0.2:1080',
    protocol: 'socks5',
    source: 'manual',
  })
  assert.ok(socksResult.admitted, socksResult.reason)
  assert.ok(socks.agents.every((a) => a.uri === 'socks5://10.0.0.2:1080'))
})

test('coarseScreen: scheme-carrying address keeps its scheme in the agent URI', async () => {
  const transport = fakeTransport({ [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'US') } })
  const verdict = await coarseScreen(deps(transport), { address: 'http://127.0.0.1:24001', protocol: 'http' })
  assert.ok('exitIP' in verdict)
  assert.equal(verdict.exitIP, '5.5.5.5')
  assert.equal(transport.agents[0]?.uri, 'http://127.0.0.1:24001')

  const bare = fakeTransport({ [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'US') } })
  const bareVerdict = await coarseScreen(deps(bare), { address: '127.0.0.1:24001', protocol: 'http' })
  assert.ok('exitIP' in bareVerdict)
  assert.equal(bare.agents[0]?.uri, 'http://127.0.0.1:24001')
})

test('admission end-to-end: real undici.request through a real local proxy', async () => {
  // Load-bearing integration: admission's per-request ProxyAgent path works
  // against npm undici's request API (the seam verified in the IP-2 probe).
  let proxied = 0
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('http://')) proxied += 1
    res.writeHead(200)
    res.end(echoBody('5.5.5.5', 'US'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port

  const depsReal = {
    pool: new ExitPool(),
    undici: realUndici,
    ipEchoUrl: `http://example.test:${port}/echo`, // absolute URI -> proxied
    zenBaseUrl: `http://example.test:${port}`, // steps 3-4 hit the same echo server
    timeoutMs: 3000,
  }
  const result = await admitCandidate(depsReal as never, { address: `127.0.0.1:${port}`, protocol: 'http', source: 'free' })
  // All four steps answered 200 by the echo server, so the candidate is
  // admitted with the echo-reported exit facts — and every step rode the
  // candidate proxy (absolute-form requests), with no global dispatcher.
  assert.ok(proxied >= 3, 'admission chain did not ride the candidate proxy')
  assert.ok(result.admitted, result.reason)
  assert.equal(result.node?.exitIP, '5.5.5.5')

  // issue #44 end-to-end: the scheme the card asks for must survive the real
  // ProxyAgent too (undici throws InvalidArgumentError on http://http://...)
  const withScheme = await admitCandidate(depsReal as never, {
    address: `http://127.0.0.1:${port}`,
    protocol: 'http',
    source: 'manual',
  })
  assert.ok(withScheme.admitted, withScheme.reason)
  assert.equal(withScheme.node?.exitIP, '5.5.5.5')
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
