/**
 * Settings-controller resolution for the browser half.
 *
 * DSH renamed BOTH the settings service and the plugin-page slot across
 * releases, and the two services address a namespace differently:
 *
 *  - `settingsScope.bind({ namespace })` (DSH <= 0.1.6) hands back a controller
 *    over a namespace the Host plugin REGISTERED — already section-shaped, so
 *    the card consumes it directly.
 *  - `configForms.get(entryId)` (DSH >= 0.1.7) hands back the profile ENTRY's
 *    own form: the plugin's whole `Config`, addressed by the profile entry id.
 *    The ip-pool knobs therefore sit one level down at `ipPool`.
 *
 * This module keeps that difference in one place and returns the flat,
 * section-shaped controller the card was written against. It is pure (a
 * context in, a controller or undefined out) so it can be unit-tested without
 * a browser, which matters because the failure mode it guards against —
 * declaring a service the host does not provide — parks the ENTIRE client half
 * in `pending (waiting for service: …)`.
 */
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { IpPoolSettingsValue } from './IpPoolCard.tsx'

/** The section-shaped controller the card consumes (either era's resolve result). */
export type SectionController = SettingsScope<IpPoolSettingsValue>

/** The plugin `Config` field holding the ip-pool section (mirrors the Host half). */
const IP_POOL_FIELD = 'ipPool'

/** Profile entry id of this plugin, used to address its form on DSH >= 0.1.7. */
export const ENTRY_ID = 'opencode2dsh'

/** Settings namespace this plugin registered on DSH <= 0.1.6. */
const LEGACY_NAMESPACE = 'ip-pool'

/** Minimal structural face of the profile ENTRY form (DSH >= 0.1.7 configForms). */
interface EntryFormFace {
  getSnapshot(): unknown
  subscribe(listener: () => void): unknown
  mutate?(ops: ReadonlyArray<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>): unknown
  set?(field: string, value: unknown): unknown
  unset?(field: string): unknown
}

/** Minimal structural face of the >= 0.1.7 settings domain service. */
interface ConfigFormsFace {
  get(entryId: string): EntryFormFace | undefined
}

/** Minimal structural face of the <= 0.1.6 settings service. */
interface LegacySettingsScopeFace {
  bind(options: { namespace: string }): SectionController
}

/**
 * Any context whose services can be probed. Property access is gated by the
 * fiber's inject list in cordis, so only `get()` reliably reaches a service
 * this plugin does not declare — property access stays as the fallback.
 */
export interface SettingsHostFace {
  /** The documented cordis escape: read a service outside the inject list. */
  get?(name: string): unknown
  /** Property access — gated by the inject list, may be undefined. */
  [key: string]: unknown
}

/**
 * Adapt the plugin ENTRY's settings form (DSH >= 0.1.7) into the flat ip-pool
 * SECTION controller the card expects.
 *
 * Reads project `value`/`base`/`user` down to the `ipPool` subtree; writes
 * prefix their path with `ipPool`.
 *
 * `getSnapshot` MUST return a stable reference until the underlying form
 * actually changes: `useSyncExternalStore` compares by identity, so an
 * unmemoized projection would re-render forever. The projection is therefore
 * cached against the raw snapshot reference.
 *
 * @param form - the entry form returned by `configForms.get(entryId)`.
 * @returns the section-shaped controller.
 */
function projectEntryForm(form: EntryFormFace): SectionController {
  // Sentinel (not undefined) so the very first call always projects, even when
  // the form's first snapshot is itself undefined.
  const NO_RAW = Symbol('opencode2dsh:no-raw-snapshot')
  let lastRaw: unknown = NO_RAW
  let lastProjected: SettingsScopeSnapshot<IpPoolSettingsValue> | undefined
  const section = (layer: unknown): IpPoolSettingsValue | undefined =>
    layer !== null && typeof layer === 'object'
      ? (layer as Record<string, unknown>).ipPool as IpPoolSettingsValue | undefined
      : undefined
  /**
   * Write one section-relative field. `mutate` takes the full path (the only
   * way to reach a nested field); the leaner set/unset face takes the bare
   * field name and relies on the Host's own section addressing, so the
   * `ipPool` prefix must NOT be passed to it — doing so would write the whole
   * subtree instead of the field.
   */
  const write = (field: string, op: 'set' | 'unset', value?: unknown): unknown => {
    if (typeof form.mutate === 'function') {
      const ops = op === 'unset'
        ? [{ op: 'unset' as const, path: [IP_POOL_FIELD, field] }]
        : [{ op: 'set' as const, path: [IP_POOL_FIELD, field], value }]
      return form.mutate(ops)
    }
    if (op === 'unset') return typeof form.unset === 'function' ? form.unset(field) : Promise.resolve(false)
    return typeof form.set === 'function' ? form.set(field, value) : Promise.resolve(false)
  }
  return {
    getSnapshot() {
      const raw: unknown = form.getSnapshot()
      if (raw === lastRaw) return lastProjected as SettingsScopeSnapshot<IpPoolSettingsValue>
      lastRaw = raw
      const record = raw as Record<string, unknown> | undefined
      lastProjected = {
        ...record,
        value: section(record?.value),
        base: section(record?.base),
        user: section(record?.user),
      } as SettingsScopeSnapshot<IpPoolSettingsValue>
      return lastProjected
    },
    subscribe: (listener: () => void) => form.subscribe(listener) as () => void,
    set: (field: string, value?: unknown) => write(field, 'set', value),
    unset: (field: string) => write(field, 'unset'),
  } as SectionController
}

/**
 * Resolve the settings controller the card edits, on whichever settings
 * service this host provides.
 *
 * The two services are mutually exclusive across releases, so their presence
 * also identifies the addressing scheme. Returns undefined when neither exists,
 * which costs only the settings card — model routing is unaffected.
 *
 * @param host - the client context (only the two settings services are read).
 * @returns the section-shaped controller, or undefined when unsupported.
 */
export function resolveSectionController(host: SettingsHostFace): SectionController | undefined {
  try {
    // [host-compat patch] Reach the settings domain through `ctx.get()`, not
    // property access. This plugin deliberately declares only
    // `inject: ["slots", "locale"]`, and cordis gates SERVICE PROPERTY ACCESS
    // by the fiber's inject list — so `host.configForms` stayed undefined on a
    // host that does provide the service, and the card was dropped even though
    // everything it needed was available. `get()` is the documented escape for
    // exactly this shape (the bundled plugin manager uses it the same way) and
    // returns undefined while the provider is still activating, which is why
    // the caller retries instead of caching a miss.
    const readService = (name: string): unknown => {
      try {
        if (typeof host.get === 'function') {
          const viaGet = host.get(name)
          if (viaGet !== undefined) return viaGet
        }
      } catch { /* a throwing provider reads as absent */ }
      return host[name]
    }
    const configForms = readService('configForms') as ConfigFormsFace | undefined
    if (configForms !== undefined && typeof configForms.get === 'function') {
      const form = configForms.get(ENTRY_ID)
      if (form !== undefined && typeof form.getSnapshot === 'function') return projectEntryForm(form)
      return undefined
    }
    const settingsScope = readService('settingsScope') as LegacySettingsScopeFace | undefined
    if (settingsScope !== undefined && typeof settingsScope.bind === 'function') {
      return settingsScope.bind({ namespace: LEGACY_NAMESPACE })
    }
  } catch { /* any probing failure costs only the settings card */ }
  return undefined
}

/**
 * Snapshot exposed when no settings service exists, so the card renders its own
 * "unavailable" row instead of dereferencing an undefined controller.
 */
export const UNAVAILABLE_SNAPSHOT: SettingsScopeSnapshot<IpPoolSettingsValue> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
} as SettingsScopeSnapshot<IpPoolSettingsValue>
