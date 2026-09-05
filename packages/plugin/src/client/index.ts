/**
 * opencode2dsh — browser half. Registers the IP 池 plugin card inside
 * 设置 → 插件 → 可配置插件 via the `settings.plugin.item` slot (declared at
 * runtime by @deepseek-ai/dsh-client-ui-settings-plugins), keyed by the
 * `ip-pool` namespace this plugin's Host half registers.
 *
 * Configuration rides the OFFICIAL settings scope
 * (ctx.settingsScope.bind({namespace: 'ip-pool'})): the rc.2 host-apiproxy
 * serves every registered namespace, so dsh-llm-proxy's loopback fallback
 * compat layer is deliberately absent (docs/ip-pool.md §5, 2026-09-05
 * revision). Runtime state + probe actions ride the plugin's own bridge.
 *
 * Export discipline: cross-plugin collaboration goes through cordis services
 * (`slots`, `locale`, `settingsScope`); the bundle purity gate forbids value
 * imports of other @deepseek-ai packages (type-only imports are erased).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { useSyncExternalStore } from 'react'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-settings-plugins SlotMap merge (the
// 'settings.plugin.item' keyed entry the configurable tab declares at runtime).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IpPoolCard } from './IpPoolCard.tsx'
import type { IpPoolCardInjected } from './IpPoolCard.tsx'
import type { IpPoolSettingsValue } from './IpPoolCard.tsx'
import { en, zh, type IpPoolKey } from './locales.ts'

export type { IpPoolCardInjected, IpPoolCardProps, IpPoolSettingsValue } from './IpPoolCard.tsx'
export type { IpPoolKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The IP 池 card copy. */
    'settings.ip-pool': IpPoolKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.ip-pool'

/** The settings namespace this card edits (mirrors the Host half). */
const SETTINGS_NAMESPACE = 'ip-pool'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Register the IP 池 plugin card once the `settings.plugin.item` declaration
 * is on the ledger, and bind the ip-pool settings scope.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode2dsh: copy dictionaries')

  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE }) as unknown as IpPoolCardInjected['scope']
  // The scope's methods are instance methods (this-bound to the controller);
  // uSES receives them as bare functions, so bind explicitly — an unbound
  // getSnapshot reads `this.store` of undefined and crashes the card.
  const getSnapshot = scope.getSnapshot.bind(scope)
  const subscribe = scope.subscribe.bind(scope)
  const useSnapshot = (): ReturnType<typeof getSnapshot> =>
    useSyncExternalStore(subscribe, getSnapshot)
  // Registration-time copy and the inject face share one bound translate;
  // copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as IpPoolCardInjected['t']
  const injected = (): IpPoolCardInjected => ({ scope, useSnapshot, t })

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SETTINGS_NAMESPACE,
      locale: NS,
      inject: injected,
    }, IpPoolCard)
  })
}
