/**
 * opencode2dsh — browser half. Registers the IP 池 plugin card inside the
 * plugin settings UI on whichever plugin-page slot this host declares:
 * `settings.plugins.tab` (DSH >= 0.1.7, list-shaped, declared by the
 * ui-settings-plugins peer) or `settings.plugin.item` (DSH <= 0.1.6, keyed by
 * namespace or a plain list). Configuration rides the OFFICIAL settings domain
 * through ./settings-controller.ts (the service/slot names differ by release —
 * see that module). Runtime state + probe actions ride the plugin's own
 * bridge.
 *
 * Export discipline: cross-plugin collaboration goes through cordis services
 * (`slots`, `locale`); the bundle purity gate forbids value imports of other
 * @deepseek-ai packages (type-only imports are erased).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { useSyncExternalStore } from 'react'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-settings-plugins SlotMap merge (the
// 'settings.plugin.item' keyed entry the configurable tab declares at runtime).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IpPoolCard } from './IpPoolCard.tsx'
import type { IpPoolCardInjected } from './IpPoolCard.tsx'
import type { IpPoolSettingsValue } from './IpPoolCard.tsx'
import { resolveSectionController, UNAVAILABLE_SNAPSHOT, ENTRY_ID, type SettingsHostFace } from './settings-controller.ts'
import { en, zh, type IpPoolKey } from './locales.ts'

export type { IpPoolCardInjected, IpPoolCardProps, IpPoolSettingsValue } from './IpPoolCard.tsx'
export type { IpPoolKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The IP 池 card copy. */
    'settings.ip-pool': IpPoolKey
  }
}

/** Dictionary namespace owned by this plugin (i18n only). */
const NS = 'settings.ip-pool'

/** The settings namespace this card edits on DSH <= 0.1.6 (mirrors the Host half). */
const SETTINGS_NAMESPACE = 'ip-pool'

/** The plugin-page slots this card can ride, across host releases. */
type SlotName = 'settings.plugin.item' | 'settings.plugins.tab'

/**
 * Required services (cordis fiber inject). Deliberately NARROW: only services
 * every supported DSH provides. The settings domain is resolved at render time
 * (see ./settings-controller.ts) because its name differs by release and a
 * missing inject token would park the entire client half in `pending`.
 */
export const inject = ['slots', 'locale']

/**
 * Register the IP 池 plugin card on whichever plugin-page slot this host
 * declares, and bind the ip-pool settings controller.
 *
 * Slot history, newest first: `settings.plugins.tab` (list; id/order/label),
 * `settings.plugin.item` keyed by namespace, `settings.plugin.item` as a plain
 * list keyed by id. Each registration is contained, so any residual mismatch
 * costs only this card — the boot screen never lists the whole plugin as
 * failed.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode2dsh: copy dictionaries')

  // [host-compat patch] Resolve the settings controller LAZILY, at render time.
  //
  // On DSH >= 0.1.7 the settings domain (`ui-settings`) PROVIDES `configForms`,
  // and this plugin declares only `inject: ["slots", "locale"]` on purpose (a
  // missing token would park the whole client half in `pending`). Reading the
  // service synchronously inside apply() therefore races the provider's
  // activation: when it is not up yet the probe reports "no settings service on
  // this DSH build" and the card is dropped for the whole session, even though
  // the service arrives moments later.
  //
  // A MISS IS NEVER CACHED. Only a real controller is remembered, so a probe
  // that ran too early is retried on the next render; caching `undefined`
  // would reproduce the original bug in a new place.
  let scopeCache: IpPoolCardInjected['scope'] | undefined
  const getScope = (): IpPoolCardInjected['scope'] | undefined => {
    if (scopeCache === undefined) {
      scopeCache = resolveSectionController(ctx as unknown as SettingsHostFace)
    }
    return scopeCache
  }
  // Stable bound identities per resolved scope: useSyncExternalStore compares
  // the subscribe/getSnapshot references, so rebinding on every render would
  // resubscribe continuously.
  let boundFor: IpPoolCardInjected['scope'] | undefined
  let boundSubscribe: ((onStoreChange: () => void) => () => void) | undefined
  let boundGetSnapshot: (() => SettingsScopeSnapshot<IpPoolSettingsValue>) | undefined
  const useSnapshot = (): SettingsScopeSnapshot<IpPoolSettingsValue> => {
    const scope = getScope()
    if (scope !== boundFor) {
      boundFor = scope
      boundSubscribe = scope === undefined
        ? () => () => {}
        : scope.subscribe.bind(scope) as (onStoreChange: () => void) => () => void
      boundGetSnapshot = scope === undefined
        ? () => UNAVAILABLE_SNAPSHOT
        : scope.getSnapshot.bind(scope) as () => SettingsScopeSnapshot<IpPoolSettingsValue>
    }
    return useSyncExternalStore(boundSubscribe as (onStoreChange: () => void) => () => void, boundGetSnapshot as () => SettingsScopeSnapshot<IpPoolSettingsValue>)
  }
  // Registration-time copy and the inject face share one bound translate;
  // copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as IpPoolCardInjected['t']
  const injected = (): IpPoolCardInjected => ({ scope: getScope(), useSnapshot, t })

  /**
   * Register the card on one slot, converting any mismatch into a contained
   * warning. Returns the slot disposer the injection iterator must yield.
   */
  const register = (slot: SlotName, options: Record<string, unknown>): (() => void) => {
    try {
      // The options union carries shapes the rc.2-typed overloads cannot name
      // (both legacy shapes, and the >= 0.1.7 tab entry); all are runtime-valid
      // for their era, so the call goes through the wide component-erased face.
      return (ctx.slots.register as (o: typeof options, c: typeof IpPoolCard) => () => void)(options, IpPoolCard)
    } catch (err) {
      console.warn(`opencode2dsh: settings card rejected by this DSH build on slot "${slot}" (${err instanceof Error ? err.message : String(err)}) — model routing is unaffected`)
      return () => {}
    }
  }

  // [host-compat patch] Inject UNCONDITIONALLY instead of gating on
  // `ctx.slots.spec()`.
  //
  // `slots.spec()` is a pure synchronous lookup, so it answers "is this slot
  // declared RIGHT NOW" — but on DSH 0.1.7 the settings section declares
  // `settings.plugins.tab` from a peer plugin (`ui-settings-plugins`) that may
  // activate AFTER this one. The old gate therefore concluded "this DSH
  // declares neither slot" and returned, so the card never appeared on a host
  // that does declare it (README: "One page inside the Plugins settings
  // section").
  //
  // `slots.inject()` — the host's own documented contract — "runs the callback
  // synchronously when the declaration already exists; otherwise it runs inside
  // the declaring register() call after the declaration is committed", and a
  // never-declared slot simply waits (no throw). Injecting into both slots is
  // therefore safe on every supported release and removes the race.
  const injectInto = (slot: SlotName, build: () => Record<string, unknown>): void => {
    const injectWide = ctx.slots.inject as unknown as (name: string, gen: () => Generator<unknown>) => unknown
    injectWide(slot, function* () {
      yield register(slot, build())
    })
  }

  // DSH >= 0.1.7: the plugins settings tab, list-shaped and label-driven.
  injectInto('settings.plugins.tab', () => ({
    name: 'settings.plugins.tab',
    id: ENTRY_ID,
    order: 50,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }))
  // Legacy slot (DSH <= 0.1.6): `settings.plugin.item`, keyed or list. Only one
  // of the two shapes is ever declared, so probing `spec()` HERE is correct —
  // the declaration exists by the time this callback runs.
  injectInto('settings.plugin.item', () => {
    let kind: string | undefined
    try {
      kind = (ctx.slots.spec('settings.plugin.item') as { kind?: string } | undefined)?.kind
    } catch { /* unreachable-spec hosts: default to the keyed shape below */ }
    return kind === 'list'
      ? { name: 'settings.plugin.item', id: SETTINGS_NAMESPACE, locale: NS, inject: injected }
      : { name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: NS, inject: injected }
  })
}
