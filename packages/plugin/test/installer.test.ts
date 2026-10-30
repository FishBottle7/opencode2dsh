/**
 * RoutingInstaller: the global dispatcher slot must be RESTORED on disable.
 *
 * Regression cover for the bug this file was created for: `install()` used to
 * read the replaced dispatcher off `setGlobalDispatcher()`'s return value and
 * gate it on `instanceof Object`. On Node 24 / undici 8.x that setter returns
 * `undefined`, so `#previous` stayed null, `disable()` silently skipped the
 * restore, and the PoolRoutingDispatcher captured every later fetch in the
 * process — surviving plugin dispose. The symptom users saw: after installing
 * the plugin, unrelated providers started failing, and only uninstalling it
 * (a process restart) brought them back.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RoutingInstaller } from '../src/pool/installer.ts'
import { PoolRoutingDispatcher, routingContext } from '../src/pool/dispatcher.ts'

/** Minimal undici stand-in: a dispatcher slot with the real setter semantics. */
function makeUndiciStub() {
  class Agent {
    destroyed = false
    dispatch(_options: unknown, _handler: unknown): boolean {
      return true
    }
    async destroy(): Promise<void> {
      this.destroyed = true
    }
    async close(): Promise<void> {
      this.destroyed = true
    }
  }

  const initial = new Agent()
  let slot: unknown = initial
  let setCalls = 0

  const stub = {
    Agent,
    initial,
    /**
     * Per-exit proxy agent; only constructed when a dispatch actually picks an
     * exit, which the tests below do. It fails the request in transport, so a
     * routed request records a death.
     */
    ProxyAgent: class {
      dispatch(_options: unknown, handler: { onResponseError?: (controller: unknown, error: Error) => void }): boolean {
        handler.onResponseError?.({} as never, new Error('connect ECONNREFUSED'))
        return true
      }
      async close(): Promise<void> {}
      async destroy(): Promise<void> {}
    },
    /** The module fetch the installer swaps in (differs from the built-in). */
    fetch: function moduleFetch(_input: unknown, _init?: unknown): Promise<unknown> {
      return Promise.resolve({ ok: true })
    },
    get setCalls(): number {
      return setCalls
    },
    /** `getGlobalDispatcher()` — what the FIXED code reads. */
    getGlobalDispatcher: (): unknown => slot,
    /**
     * Faithful to undici 8.x: swaps the slot and returns **undefined**.
     * The buggy code depended on a return value this never provides.
     */
    setGlobalDispatcher(next: unknown): undefined {
      setCalls += 1
      slot = next
      return undefined
    },
    peek: (): unknown => slot,
  }
  return stub
}

/** The installer's pool seam; only the members `disable()` touches matter here. */
function makePoolStub() {
  return {
    get: () => null,
    pick: () => null,
    has: () => false,
    list: () => [],
    snapshot: () => ({ total: 0 }),
    recordPassive: () => 'ok',
    recordPassiveTransport: () => {},
    rerouteSession: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeInstaller(undici: ReturnType<typeof makeUndiciStub>) {
  return new RoutingInstaller({
    pool: makePoolStub(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undici: undici as any,
    proxyHosts: ['opencode.ai'],
    logger: { info: () => {}, warn: () => {} },
  })
}

test('install() swaps the global dispatcher and marks itself enabled', () => {
  const undici = makeUndiciStub()
  const installer = makeInstaller(undici)

  assert.equal(installer.enabled, false)
  installer.install()

  assert.equal(installer.enabled, true)
  assert.ok(
    undici.peek() instanceof PoolRoutingDispatcher,
    'the global slot must hold our routing layer while enabled',
  )
})

test('disable() restores the dispatcher that was active before install (regression)', () => {
  const undici = makeUndiciStub()
  const before = undici.peek()
  const installer = makeInstaller(undici)

  installer.install()
  assert.notEqual(undici.peek(), before, 'install must replace the slot')

  installer.disable()
  assert.equal(
    undici.peek(),
    before,
    'disable() must put the ORIGINAL dispatcher back — the bug left the routing layer installed forever',
  )
})

test('dispose() restores the dispatcher too (plugin teardown path)', () => {
  const undici = makeUndiciStub()
  const before = undici.peek()
  const installer = makeInstaller(undici)

  installer.install()
  installer.dispose()

  assert.equal(undici.peek(), before, 'dispose() is the path a plugin unload takes')
})

test('the restored dispatcher is not our own destroyed layer', () => {
  const undici = makeUndiciStub()
  const installer = makeInstaller(undici)

  installer.install()
  installer.disable()

  assert.equal(
    undici.peek() instanceof PoolRoutingDispatcher,
    false,
    'a destroyed PoolRoutingDispatcher must never be left in the slot',
  )
})

test('install() does not depend on setGlobalDispatcher returning the old dispatcher', () => {
  // The regression's root cause, pinned directly: the setter returns void.
  const undici = makeUndiciStub()
  const old = undici.peek()
  const returned = undici.setGlobalDispatcher(new undici.Agent())

  assert.equal(returned, undefined, 'undici 8.x returns void here')
  assert.notEqual(undici.peek(), old, 'but the slot did change')

  const installer = makeInstaller(undici)
  installer.install()
  installer.disable()
  assert.notEqual(
    undici.peek() instanceof PoolRoutingDispatcher,
    true,
    'a void return must not stop the restore',
  )
})

test('disable() is idempotent and tolerates a never-installed instance', () => {
  const undici = makeUndiciStub()
  const before = undici.peek()
  const installer = makeInstaller(undici)

  installer.disable() // never installed
  assert.equal(undici.peek(), before)

  installer.install()
  installer.disable()
  installer.disable() // second call must be a no-op
  assert.equal(undici.peek(), before)
})

test('install() after disable() works again (re-enable cycle)', () => {
  const undici = makeUndiciStub()
  const before = undici.peek()
  const installer = makeInstaller(undici)

  installer.install()
  installer.disable()
  assert.equal(undici.peek(), before)

  installer.install()
  assert.ok(undici.peek() instanceof PoolRoutingDispatcher, 're-enable must install again')
  installer.disable()
  assert.equal(undici.peek(), before, 'and restore again')
})

test('a foreign dispatcher defers instead of short-circuiting it', () => {
  const undici = makeUndiciStub()
  class ForeignPluginDispatcher {
    dispatch() {
      return true
    }
  }
  undici.setGlobalDispatcher(new ForeignPluginDispatcher())
  const foreign = undici.peek()

  const installer = makeInstaller(undici)
  installer.install()

  assert.equal(installer.enabled, false, 'we must not steal a slot another plugin owns')
  assert.match(String(installer.deferredReason), /deferred/)
  assert.equal(undici.peek(), foreign, 'the foreign layer stays untouched')
})

test('the plugin fetch is saved and restored alongside the dispatcher', () => {
  const undici = makeUndiciStub()
  const builtinFetch = globalThis.fetch
  // makeUndiciStub already exposes a module fetch that differs from the
  // built-in one, which is exactly the condition the installer reacts to.
  assert.notEqual(undici.fetch, builtinFetch, 'fixture precondition: distinct fetch identity')

  const installer = makeInstaller(undici)
  installer.install()
  assert.equal(globalThis.fetch, undici.fetch, 'routing only works if the module fetch is in place')

  installer.disable()
  assert.equal(globalThis.fetch, builtinFetch, 'the built-in fetch must come back')
})

test('the verify-on-death hook survives install, late attach and re-install (#106)', () => {
  // Boot order is fixed: install() runs during assembly, but the runtime can only
  // build its verifier once the probe queue exists. So the hook arrives through
  // the setter — and an enable flip builds a NEW router, which must carry it
  // over, or a re-enabled pool silently stops verifying its deaths.
  const undici = makeUndiciStub()
  const pool = {
    get: (id: string) => (id === 'dead:1' ? { id: 'dead:1', protocol: 'http' } : null),
    pick: () => 'dead:1',
    has: () => true,
    list: () => [],
    snapshot: () => ({ total: 1 }),
    recordPassive: () => 'ok',
    recordPassiveTransport: () => {},
    rerouteSession: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  const installer = new RoutingInstaller({
    pool,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undici: undici as any,
    proxyHosts: ['opencode.ai'],
    logger: { info: () => {}, warn: () => {} },
  })
  const died: string[] = []
  const dispatchRouted = (): void => {
    const router = undici.peek() as PoolRoutingDispatcher
    routingContext.run({ model: 'm', session: 's' }, () => {
      router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
    })
  }

  installer.install()
  installer.setTransportDeathObserver((id) => died.push(id))
  dispatchRouted()
  assert.deepEqual(died, ['dead:1'], 'a hook attached after install reaches the running router')

  installer.disable()
  installer.install() // the enable flip that rebuilds the router
  died.length = 0
  dispatchRouted()
  assert.deepEqual(died, ['dead:1'], 'a re-installed router keeps the hook')
})
