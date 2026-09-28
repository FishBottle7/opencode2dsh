/**
 * settings-controller unit tests (no browser): the resolver must find the
 * settings domain through `ctx.get()` — cordis gates SERVICE PROPERTY ACCESS
 * by the fiber's inject list, and this plugin declares only
 * `inject: ["slots", "locale"]` — must project the >= 0.1.7 profile-entry form
 * down to the flat ip-pool section shape with a memoized snapshot, and must
 * fall back to the <= 0.1.6 `settingsScope` service. Every miss returns
 * undefined instead of throwing: a miss costs only the settings card.
 *
 * The resolver contract these tests pin down is what let the client half go
 * from "declared `settingsScope` and died on >= 0.1.7" to "declares nothing
 * era-specific and resolves lazily" (see src/client/index.ts getScope).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveSectionController, UNAVAILABLE_SNAPSHOT, ENTRY_ID } from '../src/client/settings-controller.ts'
import type { SettingsHostFace } from '../src/client/settings-controller.ts'

/**
 * A raw >= 0.1.7 entry-form snapshot: `{ value, base, user }` layers over the
 * plugin's whole `Config` (the configForms era serves the profile ENTRY, not a
 * section), plus the snapshot-level fields the projection must preserve.
 */
function rawEntry(ipPool: Record<string, unknown>): Record<string, unknown> {
  const config = { enabled: false, ipPool, other: 'untouched' }
  return { value: config, base: config, user: config, revision: 7, writable: true, mode: 'memory' }
}

/** A fake >= 0.1.7 configForms service serving one entry form. */
function fakeConfigForms(recorded: { entryIds: string[]; mutations: unknown[] }) {
  const ipPoolValue = { enabled: true, manual: ['http://1.1.1.1:1'] }
  let raw = rawEntry(ipPoolValue)
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot: () => raw,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate(ops: Array<{ op: string; path: string[]; value?: unknown }>) {
      recorded.mutations.push(ops)
      return true
    },
  }
  return {
    service: {
      get(entryId: string) {
        recorded.entryIds.push(entryId)
        return entryId === ENTRY_ID ? form : undefined
      },
    },
    form,
    ipPoolValue,
    commit(next: Record<string, unknown>) {
      raw = next
      for (const listener of listeners) listener()
    },
  }
}

test('>= 0.1.7 host: resolves through ctx.get(), never property access', () => {
  const recorded: { entryIds: string[]; mutations: unknown[] } = { entryIds: [], mutations: [] }
  const { service } = fakeConfigForms(recorded)
  // A cordis-realistic host: the plugin declares only slots/locale, so even a
  // context that HAS the service must be read through get() — property access
  // is gated by the inject list and would stay undefined.
  const host: SettingsHostFace = {
    get: (name: string) => (name === 'configForms' ? service : undefined),
    // No configForms property at all — the strictest gate shape.
  }
  const controller = resolveSectionController(host)
  assert.ok(controller, 'controller resolved on the >= 0.1.7 seam')
  assert.deepEqual(recorded.entryIds, [ENTRY_ID], 'the entry form is addressed by the plugin entry id')
})

test('entry form projects down to the flat ip-pool section, memoized by raw reference', () => {
  const recorded: { entryIds: string[]; mutations: unknown[] } = { entryIds: [], mutations: [] }
  const { service, commit, ipPoolValue } = fakeConfigForms(recorded)
  const controller = resolveSectionController({ get: (name: string) => (name === 'configForms' ? service : undefined) })!
  const first = controller.getSnapshot()
  // Projection: value/base/user are the ipPool subtree (by reference); the
  // snapshot-level fields (revision) ride the raw snapshot through the spread.
  assert.equal(first.value, ipPoolValue)
  assert.equal((first as unknown as Record<string, unknown>).revision, 7, 'snapshot-level siblings survive the projection')
  // useSyncExternalStore compares by identity: the SAME raw snapshot must
  // yield the SAME projected reference, or the card re-renders forever.
  assert.equal(controller.getSnapshot(), first, 'identity-stable while the raw snapshot is unchanged')
  commit(rawEntry({ enabled: false }))
  const second = controller.getSnapshot()
  assert.notEqual(second, first, 'a new raw snapshot yields a new projection')
  assert.deepEqual(second.value, { enabled: false })
})

test('writes prefix the ipPool path via mutate; the bare face stays bare', async () => {
  const recorded: { entryIds: string[]; mutations: unknown[] } = { entryIds: [], mutations: [] }
  const { service } = fakeConfigForms(recorded)
  const controller = resolveSectionController({ get: (name: string) => (name === 'configForms' ? service : undefined) })!
  await controller.set('enabled', false)
  assert.deepEqual(recorded.mutations.at(-1), [
    { op: 'set', path: ['ipPool', 'enabled'], value: false },
  ], 'mutate gets the full ipPool-prefixed path')
  await controller.unset('pinnedExitId')
  assert.deepEqual(recorded.mutations.at(-1), [
    { op: 'unset', path: ['ipPool', 'pinnedExitId'] },
  ])
})

test('entry form without mutate falls back to the bare set/unset face (no ipPool prefix)', async () => {
  const sets: Array<[string, unknown]> = []
  const unsets: string[] = []
  const service = {
    get: () => ({
      getSnapshot: () => rawEntry({}),
      subscribe: () => () => {},
      set: (field: string, value: unknown) => { sets.push([field, value]); return true },
      unset: (field: string) => { unsets.push(field); return true },
    }),
  }
  const controller = resolveSectionController({ get: (name: string) => (name === 'configForms' ? service : undefined) })!
  await controller.set('enabled', true)
  await controller.unset('pinnedExitId')
  // The Host's own section addressing owns the ipPool prefix here — passing it
  // would write the whole subtree instead of the field.
  assert.deepEqual(sets, [['enabled', true]])
  assert.deepEqual(unsets, ['pinnedExitId'])
})

test('<= 0.1.6 host: falls back to settingsScope.bind({namespace: "ip-pool"})', () => {
  const namespaces: string[] = []
  const sentinel = { getSnapshot: () => ({}) } as never
  const host: SettingsHostFace = {
    get: (name: string) => (name === 'settingsScope'
      ? { bind(options: { namespace: string }) { namespaces.push(options.namespace); return sentinel } }
      : undefined),
  }
  const controller = resolveSectionController(host)
  assert.equal(controller, sentinel, 'the legacy controller passes through untouched')
  assert.deepEqual(namespaces, ['ip-pool'])
})

test('a throwing ctx.get falls back to property access instead of killing the half', () => {
  const service = {
    get: () => ({ getSnapshot: () => rawEntry({}), subscribe: () => () => {} }),
  }
  const host: SettingsHostFace = {
    get() { throw new Error('provider still activating') },
    configForms: service,
  } as SettingsHostFace
  const controller = resolveSectionController(host)
  assert.ok(controller, 'property access still reaches the service')
})

test('configForms present but the entry missing: undefined, and legacy is NOT consulted', () => {
  let legacyAsked = false
  const host: SettingsHostFace = {
    get: (name: string) => {
      if (name === 'configForms') return { get: () => undefined }
      if (name === 'settingsScope') {
        legacyAsked = true
        return { bind: () => ({}) }
      }
      return undefined
    },
  }
  assert.equal(resolveSectionController(host), undefined)
  assert.equal(legacyAsked, false, 'the two eras are mutually exclusive — no fallthrough')
})

test('no settings service at all: undefined (never throws)', () => {
  assert.equal(resolveSectionController({}), undefined)
  assert.equal(resolveSectionController({ get: () => undefined }), undefined)
})

test('an early miss stays a miss only for that call — the caller may retry', () => {
  // This pins the contract index.ts getScope() relies on: the resolver never
  // caches, so a probe that ran before the provider activated can be repeated
  // on the next render.
  const recorded: { entryIds: string[]; mutations: unknown[] } = { entryIds: [], mutations: [] }
  const { service } = fakeConfigForms(recorded)
  let up = false
  const host: SettingsHostFace = { get: (name: string) => (up && name === 'configForms' ? service : undefined) }
  assert.equal(resolveSectionController(host), undefined, 'provider not yet activating')
  up = true
  assert.ok(resolveSectionController(host), 'same host resolves once the provider is up')
})

test('UNAVAILABLE_SNAPSHOT: the card renders its own unavailable row, never undefined derefs', () => {
  assert.equal(UNAVAILABLE_SNAPSHOT.status, 'unavailable')
  assert.equal(UNAVAILABLE_SNAPSHOT.writable, false)
})
