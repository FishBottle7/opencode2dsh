/**
 * IP 池 plugin card: one card inside 设置 → 插件 → 可配置插件 (the
 * `settings.plugin.item` slot keyed by the `ip-pool` namespace). Configuration
 * rides the OFFICIAL settings scope (rc.2 apiproxy serves every registered
 * namespace); runtime state and probe actions ride the plugin's loopback
 * bridge (/status, /probe). Every setting applies live on save — no restart
 * (docs/ip-pool.md §5).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-settings-plugins SlotMap merge (the
// 'settings.plugin.item' keyed entry the configurable tab declares at runtime).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { en } from './locales.ts'
import styles from './ip-pool.module.css'

/** Injected dependencies of the card (slot `inject`). */
export interface IpPoolCardInjected {
  /** The officially bound ip-pool settings scope (rc.2: always available). */
  scope: SettingsScope<IpPoolSettingsValue>
  /** uSES subscription hook bound to the scope snapshot. */
  useSnapshot: () => SettingsScopeSnapshot<IpPoolSettingsValue>
  /** Card copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet (inject face spread flat). */
export type IpPoolCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<IpPoolCardInjected>

/** The resolved ip-pool settings value (mirrors the schemastery schema). */
export interface IpPoolSettingsValue {
  enabled: boolean
  probeModels: string[]
  maxConcurrentProbes: number
  free: { enabled: boolean; targetSize: number; blockedCountries: string[] }
  manual: string[]
  subscription: { urls: string[]; refreshMs: number }
  singbox: { path: string }
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
}

/** Bridge /status view (mirrors src/ip-pool-settings/bridge.ts). */
export interface PoolStatusView {
  enabled: boolean
  deferredReason: string
  state: 'healthy' | 'warning' | 'critical' | 'emergency'
  total: number
  bySource: Record<'free' | 'manual' | 'subscription' | 'goproxy', number>
  availableFree: number
  targetSize: number
  pinned: { id: string; strict: boolean } | null
  proxyHosts: string[]
  exits: Array<{
    id: string
    source: string
    protocol: string
    pinned: boolean
    exitIP: string
    exitLocation: string
    latencyMs: number
    quality: string
    state: 'unknown' | 'ok' | 'dead'
    cooling: boolean
    cooldownUntil: number
    consecutiveLimited: number
    bannedModels: Array<{ model: string; state: 'suspect' | 'banned'; bannedAt: number }>
    passive: { ok: number; limited: number; refused: number; dead: number; transport: number }
  }>
  prober: { queued: number; inFlight: number; enqueued: number; completed: number }
  refill: {
    admitted: number; rejected: number; fetched: number; coarsePassed: number; state: string; at: number
    progress: { running: boolean; stage: 'fetch' | 'coarse' | 'admit' | 'idle'; sourcesDone: number; sourcesTotal: number; fetched: number; candidates: number; coarsePassed: number; coarseDone: number; admissions: number; admitted: number }
  } | null
  subscription: { urlCount: number; pendingConversion: number; convertedAdmitted: number; plaintextAdmitted: number; lastFetch: number; lastError: string } | null
  at: number
}

/** The bridge prefix (same-origin, loopback-only on the host). */
const BRIDGE_PREFIX = '/api/opencode2dsh/ip-pool'

const DEFAULTS: IpPoolSettingsValue = {
  enabled: false,
  probeModels: [],
  maxConcurrentProbes: 3,
  free: { enabled: true, targetSize: 20, blockedCountries: ['CN'] },
  manual: [],
  subscription: { urls: [], refreshMs: 30 * 60_000 },
  singbox: { path: 'sing-box' },
  pinnedExitId: '',
  pinnedStrict: false,
  proxyHosts: [],
}

/** Subscription URLs never render in full — the settings doc is the only
 *  place they exist in plaintext (docs §5.1 redaction boundary). */
function redactUrl(url: string): string {
  if (url.length <= 24) return url
  return url.slice(0, 12) + '…' + url.slice(-6)
}

/** JSON deep-equal over the card's plain values. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Draft form state (strings for inputs; arrays kept as string lists). */
interface FormState {
  enabled: boolean
  freeEnabled: boolean
  targetSize: string
  blockedCountries: string
  manual: string[]
  subscriptionUrls: string[]
  refreshMs: string
  singboxPath: string
  pinnedExitId: string
  pinnedStrict: boolean
  probeModels: string[]
  maxConcurrentProbes: string
}

function emptyForm(): FormState {
  return {
    enabled: DEFAULTS.enabled,
    freeEnabled: DEFAULTS.free.enabled,
    targetSize: String(DEFAULTS.free.targetSize),
    blockedCountries: DEFAULTS.free.blockedCountries.join(','),
    manual: [],
    subscriptionUrls: [],
    refreshMs: String(DEFAULTS.subscription.refreshMs),
    singboxPath: DEFAULTS.singbox.path,
    pinnedExitId: '',
    pinnedStrict: DEFAULTS.pinnedStrict,
    probeModels: [],
    maxConcurrentProbes: String(DEFAULTS.maxConcurrentProbes),
  }
}

function formFromValue(value: IpPoolSettingsValue): FormState {
  return {
    enabled: value.enabled,
    freeEnabled: value.free.enabled,
    targetSize: String(value.free.targetSize),
    blockedCountries: value.free.blockedCountries.join(','),
    manual: [...value.manual],
    subscriptionUrls: [...value.subscription.urls],
    refreshMs: String(value.subscription.refreshMs),
    singboxPath: value.singbox.path,
    pinnedExitId: value.pinnedExitId,
    pinnedStrict: value.pinnedStrict,
    probeModels: [...value.probeModels],
    maxConcurrentProbes: String(value.maxConcurrentProbes),
  }
}

/** Field writes landing the form on the resolved value, in write order. */
interface FieldWrite { field: string; op: 'set'; value: unknown }

function diffWrites(form: FormState, snapshot: SettingsScopeSnapshot<IpPoolSettingsValue>): FieldWrite[] {
  const value = snapshot.value
  const base = snapshot.base as Partial<IpPoolSettingsValue> | undefined
  const writes: FieldWrite[] = []
  const push = (field: string, next: unknown, current: unknown, baseValue: unknown): void => {
    if (deepEqual(next, current)) return
    if (deepEqual(next, baseValue)) return // reverts inherit via unset, but the
    // official scope only has set/unset per scalar field; a value equal to base
    // still needs set (unset would drop user intent on other fields) — so no
    // unset path here: set carries it.
    writes.push({ field, op: 'set', value: next })
  }
  push('enabled', form.enabled, value?.enabled, base?.enabled)
  push('free', { enabled: form.freeEnabled, targetSize: Number(form.targetSize), blockedCountries: splitCsv(form.blockedCountries) }, value?.free, base?.free)
  push('manual', form.manual, value?.manual, base?.manual)
  push('subscription', { urls: form.subscriptionUrls, refreshMs: Number(form.refreshMs) }, value?.subscription, base?.subscription)
  push('singbox', { path: form.singboxPath }, value?.singbox, base?.singbox)
  push('pinnedExitId', form.pinnedExitId, value?.pinnedExitId, base?.pinnedExitId)
  push('pinnedStrict', form.pinnedStrict, value?.pinnedStrict, base?.pinnedStrict)
  push('probeModels', form.probeModels, value?.probeModels, base?.probeModels)
  push('maxConcurrentProbes', Number(form.maxConcurrentProbes), value?.maxConcurrentProbes, base?.maxConcurrentProbes)
  return writes
}

function splitCsv(line: string): string[] {
  return line.split(',').map((part) => part.trim().toUpperCase()).filter((part) => part.length > 0)
}

/** One-line live refill progress: stage + counters (docs §5.3). */
function refillProgressLine(
  progress: NonNullable<PoolStatusView['refill']>['progress'],
  t: IpPoolCardInjected['t'],
): string {
  const stageText: Record<typeof progress.stage, string> = {
    fetch: t('refillStageFetch'),
    coarse: t('refillStageCoarse'),
    admit: t('refillStageAdmit'),
    idle: t('refillStageIdle'),
  }
  const parts = [stageText[progress.stage]]
  if (progress.stage === 'fetch') {
    const sources = t('refillCountSources').replace('{done}', String(progress.sourcesDone)).replace('{total}', String(progress.sourcesTotal))
    const rows = t('refillCountFetched').replace('{n}', String(progress.fetched))
    parts.push(sources + ' · ' + rows)
  }
  if (progress.stage === 'coarse') {
    parts.push(t('refillCountCoarse').replace('{done}', String(progress.coarseDone)).replace('{total}', String(progress.candidates)).replace('{passed}', String(progress.coarsePassed)))
  }
  if (progress.stage === 'admit') {
    parts.push(t('refillCountAdmit').replace('{done}', String(progress.admissions)).replace('{admitted}', String(progress.admitted)))
  }
  return parts.join(' · ')
}

/** One labeled input. */
function TextField(props: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  testId?: string
  type?: 'text' | 'number'
  min?: number
  max?: number
  step?: number
}): ReactNode {
  const { label, hint, value, onChange, placeholder, testId, type = 'text', min, max, step } = props
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={styles.input}
        type={type}
        value={value}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint !== undefined && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  )
}

/** One editable string-list (manual proxies / subscription URLs / probe models). */
function StringList(props: {
  label: string
  hint: string
  values: string[]
  placeholder: string
  testId: string
  redacted?: boolean
  onChange: (next: string[]) => void
}): ReactNode {
  const { label, hint, values, placeholder, testId, redacted, onChange } = props
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const entry = draft.trim()
    if (entry === '' || values.includes(entry)) return
    onChange([...values, entry])
    setDraft('')
  }
  return (
    <div className={styles.field} data-testid={testId}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldHint}>{hint}</span>
      {values.length > 0 && (
        <ul className={styles.rowList}>
          {values.map((entry) => (
            <li key={entry} className={styles.row}>
              <span className={styles.rowLabel} title={redacted ? entry : undefined}>
                {redacted ? redactUrl(entry) : entry}
              </span>
              <button
                type="button"
                className={styles.rowRemove}
                onClick={() => onChange(values.filter((v) => v !== entry))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.row}>
        <input
          className={styles.rowInput}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }}
        />
        <button type="button" className={styles.rowAdd} onClick={add}>+</button>
      </div>
    </div>
  )
}

/**
 * Probe-model multi-select over the bridge /models rows: selected models as
 * removable chips above a dropdown of S3-verified + live-catalog options
 * (docs §5.2 探活模型). Empty selection = the S3-first default (big-pickle).
 */
function ModelPicker(props: {
  value: string[]
  hint: string
  models: Array<{ id: string; verified: boolean }>
  loading: boolean
  t: IpPoolCardInjected['t']
  onChange: (next: string[]) => void
}): ReactNode {
  const { value, hint, models, loading, t, onChange } = props
  const toggle = (id: string): void => {
    onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id])
  }
  const options = models.filter((row) => !value.includes(row.id))
  return (
    <div className={styles.field} data-testid="field-probeModels">
      <span className={styles.fieldLabel}>{t('probeModels')}</span>
      <span className={styles.fieldHint}>{hint}</span>
      {value.length > 0 && (
        <ul className={styles.rowList}>
          {value.map((id) => {
            const row = models.find((m) => m.id === id)
            return (
              <li key={id} className={styles.row}>
                <span className={styles.rowLabel}>
                  {id}{row?.verified === false ? ` · ${t('probeModelUnverified')}` : ''}
                </span>
                <button type="button" className={styles.rowRemove} aria-label="remove" onClick={() => toggle(id)}>✕</button>
              </li>
            )
          })}
        </ul>
      )}
      <div className={styles.row}>
        <select
          className={styles.select}
          data-testid="probe-model-select"
          value=""
          disabled={options.length === 0}
          onChange={(event) => {
            const id = event.target.value
            if (id !== '') toggle(id)
            // native select re-shows the list while focused; value stays ''
            // so the placeholder keeps prompting for the next pick
          }}
        >
          <option value="">{loading ? t('statusLoading') : options.length === 0 ? '—' : t('probeModelPick')}</option>
          {options.map((row) => (
            <option key={row.id} value={row.id}>{row.id}{row.verified === false ? ` · ${t('probeModelUnverified')}` : ''}</option>
          ))}
        </select>
      </div>
      {value.length === 0 && (
        <span className={styles.fieldHint}>{t('probeModelsDefault')}</span>
      )}
    </div>
  )
}

/** Pool overview strip: four-state badge + counts + pinned badge. */
function OverviewBar(props: { status: PoolStatusView | null; t: IpPoolCardInjected['t'] }): ReactNode {
  const { status, t } = props
  if (status === null) return null
  const stateLabel: Record<PoolStatusView['state'], string> = {
    healthy: t('poolStateHealthy'),
    warning: t('poolStateWarning'),
    critical: t('poolStateCritical'),
    emergency: t('poolStateEmergency'),
  }
  const stateClass: Record<PoolStatusView['state'], string> = {
    healthy: styles.badgeHealthy!,
    warning: styles.badgeWarning!,
    critical: styles.badgeCritical!,
    emergency: styles.badgeEmergency!,
  }
  return (
    <div className={styles.overviewBar} data-testid="ip-pool-overview">
      <span className={`${styles.badge} ${stateClass[status.state]}`}>{stateLabel[status.state]}</span>
      {status.deferredReason !== '' && (
        <span className={`${styles.badge} ${styles.badgeCritical}`}>
          {t('deferredNotice').replace('{reason}', status.deferredReason)}
        </span>
      )}
      <span>{t('poolAvailable').replace('{available}', String(status.availableFree)).replace('{capacity}', String(status.targetSize))}</span>
      <span>
        {t('poolSources')
          .replace('{free}', String(status.bySource.free))
          .replace('{manual}', String(status.bySource.manual))
          .replace('{subscription}', String(status.bySource.subscription))}
      </span>
      {status.pinned !== null && (
        <span className={`${styles.badge} ${styles.badgePinned}`}>
          {t('pinnedBadge')}{status.pinned.strict ? ' (' + t('pinnedStrict') + ')' : ''}
        </span>
      )}
    </div>
  )
}

/** The exit table + ban list. */
function ExitTable(props: { status: PoolStatusView | null; t: IpPoolCardInjected['t']; onProbe: (exitId: string) => void; onPin: (exitId: string) => void; busy: boolean }): ReactNode {
  const { status, t, onProbe, onPin, busy } = props
  const [bansOpen, setBansOpen] = useState(false)
  if (status === null) return null
  const stateCell = (exit: PoolStatusView['exits'][number]): ReactNode => {
    if (exit.state === 'dead') return <span className={styles.stateDead}>{t('stateDead')}</span>
    if (exit.cooling) return <span className={styles.stateCooling}>{t('stateCooling')}</span>
    if (exit.state === 'ok') return <span className={styles.stateOk}>{t('stateOk')}</span>
    return <span className={styles.stateUnknown}>{t('stateUnknown')}</span>
  }
  const allBans = status.exits.flatMap((exit) =>
    exit.bannedModels.map((ban) => ({ exitId: exit.id, ...ban })),
  )
  return (
    <>
      <div className={styles.table} data-testid="ip-pool-exits">
        <table className={styles.tableGrid}>
          <thead>
            <tr>
              <th>{t('exitAddress')}</th>
              <th>{t('exitSource')}</th>
              <th>{t('exitLocation')}</th>
              <th>{t('exitLatency')}</th>
              <th>{t('exitQuality')}</th>
              <th>{t('exitIp')}</th>
              <th>{t('exitState')}</th>
              <th>{t('exitPassive')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.exits.map((exit) => (
              <tr key={exit.id}>
                <td className={styles.mono}>{exit.id}{exit.pinned ? ` · ${t('exitPinnedMark')}` : ''}</td>
                <td>{exit.source}</td>
                <td>{exit.exitLocation || '—'}</td>
                <td>{exit.latencyMs > 0 ? `${exit.latencyMs}ms` : '—'}</td>
                <td>{exit.latencyMs > 0 ? exit.quality : '—'}</td>
                <td className={styles.mono}>{exit.exitIP || '—'}</td>
                <td>{stateCell(exit)}</td>
                <td className={styles.mono}>
                  {exit.passive.ok > 0 || exit.passive.limited > 0 || exit.passive.refused > 0 || exit.passive.dead > 0 || exit.passive.transport > 0
                    ? `✓${exit.passive.ok} 429:${exit.passive.limited} 401/403:${exit.passive.refused} ✗:${exit.passive.dead + exit.passive.transport}`
                    : '—'}
                </td>
                <td>
                  <button type="button" className={styles.rowRemove} disabled={busy} onClick={() => onProbe(exit.id)}>{t('exitProbe')}</button>
                  {!exit.pinned && (
                    <button type="button" className={styles.rowRemove} disabled={busy} onClick={() => onPin(exit.id)}>{t('exitPin')}</button>
                  )}
                </td>
              </tr>
            ))}
            {status.exits.length === 0 && (
              <tr><td colSpan={9} className={styles.status}>{t('statusUnavailable')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className={styles.section}>
        <button type="button" className={styles.collapseToggle} onClick={() => setBansOpen((open) => !open)}>
          {t(bansOpen ? 'collapse' : 'expand')} · {t('sectionBans')} ({allBans.length})
        </button>
        {bansOpen && (allBans.length === 0
          ? <span className={styles.status}>{t('bansEmpty')}</span>
          : (
            <ul className={styles.rowList}>
              {allBans.map((ban) => (
                <li key={`${ban.exitId}|${ban.model}`} className={styles.row}>
                  <span className={styles.rowLabel}>
                    <span className={ban.state === 'banned' ? styles.stateDead : styles.stateCooling}>
                      {ban.state === 'banned' ? t('banBanned') : t('banSuspect')}
                    </span>
                    {' · '}
                    <span className={styles.mono}>{ban.exitId}</span>
                    {' × '}
                    <span className={styles.mono}>{ban.model}</span>
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </>
  )
}

/** The card body. */
function CardBody(props: Required<IpPoolCardInjected>): ReactNode {
  const { scope, useSnapshot, t } = props
  const snapshot = useSnapshot()
  const [form, setForm] = useState<FormState>(() => emptyForm())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<PoolStatusView | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [probeModelRows, setProbeModelRows] = useState<Array<{ id: string; verified: boolean }>>([])
  const [probeModelsLoading, setProbeModelsLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const hydratedRef = useRef(false)
  const formRef = useRef(form)
  formRef.current = form

  // Hydrate the form once from the first ready snapshot.
  useEffect(() => {
    if (snapshot.status === 'ready' && !hydratedRef.current && snapshot.value !== undefined) {
      hydratedRef.current = true
      setForm(formFromValue(snapshot.value))
    }
  }, [snapshot.status, snapshot.value])

  // Fetch the probe-model options from the bridge once the body shows
  // (static S3 list first; live catalog rows merge in as they warm up).
  useEffect(() => {
    let cancelled = false
    setProbeModelsLoading(true)
    fetch(`${BRIDGE_PREFIX}/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((response) => response.json() as Promise<{ ok: boolean; value?: { models: Array<{ id: string; verified: boolean }> } }>)
      .then((body) => {
        if (!cancelled && body.ok && body.value) setProbeModelRows(body.value.models)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setProbeModelsLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Poll the bridge /status: 1s while probing or refilling, 3s otherwise (docs §5.3).
  const probing = status !== null && status.prober.queued + status.prober.inFlight > 0
  const refilling = status?.refill?.progress.running === true
  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${BRIDGE_PREFIX}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const body = await response.json() as { ok: boolean; value?: PoolStatusView }
      if (body.ok && body.value) {
        setStatus(body.value)
        setStatusError(null)
      } else {
        setStatusError(t('refreshError'))
      }
    } catch {
      setStatusError(t('refreshError'))
    }
  }, [t])
  useEffect(() => {
    if (snapshot.status !== 'ready' || !hydratedRef.current || !form.enabled) return
    void refreshStatus()
    const interval = setInterval(() => void refreshStatus(), probing || refilling ? 1_000 : 3_000)
    return () => clearInterval(interval)
  }, [snapshot.status, form.enabled, probing, refilling, refreshStatus, hydratedRef.current]) // eslint-disable-line react-hooks/exhaustive-deps

  if (snapshot.status === 'loading') {
    return <p className={styles.status}>{t('statusLoading')}</p>
  }
  if (snapshot.status === 'unavailable') {
    return <p className={styles.status}>{t('statusUnavailable')}</p>
  }

  const validate = (): string | null => {
    const size = Number(form.targetSize)
    if (!/^\d+$/.test(form.targetSize.trim()) || size < 1 || size > 100) return t('invalidRange')
    const conc = Number(form.maxConcurrentProbes)
    if (!/^\d+$/.test(form.maxConcurrentProbes.trim()) || conc < 1 || conc > 8) return t('invalidRange')
    const refresh = Number(form.refreshMs)
    if (!/^\d+$/.test(form.refreshMs.trim()) || refresh < 60_000) return t('invalidRange')
    for (const entry of form.manual) {
      if (!/^https?:\/\/[^\s:]+:\d{1,5}$|^socks5:\/\/[^\s:]+:\d{1,5}$|^socks5h?:\/\/\[[^\]]+\]:\d{1,5}$/.test(entry)) return t('invalidProxy')
    }
    for (const url of form.subscriptionUrls) {
      if (!/^https?:\/\/.+/.test(url)) return t('invalidUrl')
    }
    for (const country of splitCsv(form.blockedCountries)) {
      if (!/^[A-Z]{2}$/.test(country)) return t('invalidCountry')
    }
    for (const model of form.probeModels) {
      if (model.trim() === '') return t('invalidModel')
    }
    return null
  }

  const handleSave = async (): Promise<void> => {
    const validation = validate()
    if (validation !== null) {
      setSaved(false)
      setError(validation)
      return
    }
    const writes = diffWrites(formRef.current, snapshot)
    if (writes.length === 0) {
      setSaved(true)
      setError(null)
      return
    }
    setSaving(true)
    setError(null)
    let firstFailure: string | null = null
    for (const write of writes) {
      try {
        await scope.set(write.field, write.value)
      } catch (err) {
        firstFailure ??= err instanceof Error ? err.message : t('saveError')
      }
    }
    setSaving(false)
    if (firstFailure === null) {
      setSaved(true)
    } else {
      setSaved(false)
      setError(firstFailure)
    }
  }

  const handleReset = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    let firstFailure: string | null = null
    for (const field of ['enabled', 'free', 'manual', 'subscription', 'singbox', 'pinnedExitId', 'pinnedStrict', 'probeModels', 'maxConcurrentProbes']) {
      try {
        await scope.unset(field)
      } catch (err) {
        firstFailure ??= err instanceof Error ? err.message : t('saveError')
      }
    }
    setSaving(false)
    if (firstFailure === null) {
      setForm(formFromValue({ ...DEFAULTS, ...(snapshot.base as Partial<IpPoolSettingsValue> | undefined) } as IpPoolSettingsValue))
      setSaved(true)
    } else {
      setSaved(false)
      setError(firstFailure)
    }
  }

  /** One bridge action (/probe). */
  const bridgeAction = async (body: { scope: 'all' | 'refill' } | { scope: 'exit'; exitId: string }): Promise<void> => {
    setActionBusy(true)
    try {
      await fetch(`${BRIDGE_PREFIX}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      await refreshStatus()
    } catch {
      setStatusError(t('refreshError'))
    } finally {
      setActionBusy(false)
    }
  }

  /** Pin an exit from the table: writes pinnedExitId and saves immediately. */
  const pinExit = async (exitId: string): Promise<void> => {
    setActionBusy(true)
    try {
      await scope.set('pinnedExitId', exitId)
      setForm((current) => ({ ...current, pinnedExitId: exitId }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'))
    } finally {
      setActionBusy(false)
    }
  }

  const probeDone = status !== null ? status.prober.completed : 0
  const probeTotal = status !== null ? status.prober.enqueued : 0

  return (
    <div className={styles.body} data-testid="ip-pool-form">
      <OverviewBar status={form.enabled ? status : null} t={t} />

      <label className={styles.radio}>
        <input
          type="checkbox"
          checked={form.enabled}
          data-testid="field-enabled"
          onChange={(event) => { setSaved(false); setForm({ ...form, enabled: event.target.checked }) }}
        />
        <span>
          <span className={styles.fieldLabel}>{t('enabled')}</span>
          <span className={styles.fieldHint}> {t('enabledHint')}</span>
        </span>
      </label>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>{t('sectionFree')}</span>
        <label className={styles.radio}>
          <input
            type="checkbox"
            checked={form.freeEnabled}
            data-testid="field-freeEnabled"
            onChange={(event) => { setSaved(false); setForm({ ...form, freeEnabled: event.target.checked }) }}
          />
          <span>
            <span className={styles.fieldLabel}>{t('freeEnabled')}</span>
            <span className={styles.fieldHint}> {t('freeEnabledHint')}</span>
          </span>
        </label>
        <div className={styles.fieldRow}>
          <TextField
            label={t('freeTargetSize')}
            hint={t('freeTargetSizeHint')}
            value={form.targetSize}
            testId="field-targetSize"
            type="number"
            min={1}
            max={100}
            step={1}
            onChange={(value) => { setSaved(false); setForm({ ...form, targetSize: value }) }}
          />
          <TextField
            label={t('freeBlockedCountries')}
            hint={t('freeBlockedCountriesHint')}
            value={form.blockedCountries}
            testId="field-blockedCountries"
            onChange={(value) => { setSaved(false); setForm({ ...form, blockedCountries: value }) }}
          />
        </div>
        <button
          type="button"
          className={styles.ghostButton}
          data-testid="refill-now"
          disabled={actionBusy || !form.enabled || refilling}
          onClick={() => { void bridgeAction({ scope: 'refill' }) }}
        >
          {refilling ? t('refillRunning') : t('refillNow')}
        </button>
        {refilling && status?.refill?.progress !== undefined && (
          <span className={styles.status} data-testid="refill-progress">
            {refillProgressLine(status.refill.progress, t)}
          </span>
        )}
        {!refilling && status?.refill?.progress.stage === 'idle' && (status.refill.progress.admitted > 0 || status.refill.progress.admissions > 0) && (
          <span className={styles.status}>
            {t('refillSummary')
              .replace('{admitted}', String(status.refill.progress.admitted))
              .replace('{fetched}', String(status.refill.progress.candidates))}
          </span>
        )}
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>{t('sectionManual')}</span>
        <StringList
          label={t('sectionManual')}
          hint={t('manualHint')}
          values={form.manual}
          placeholder={t('manualPlaceholder')}
          testId="field-manual"
          onChange={(next) => { setSaved(false); setForm({ ...form, manual: next }) }}
        />
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>{t('sectionSubscription')}</span>
        <StringList
          label={t('sectionSubscription')}
          hint={t('subscriptionHint')}
          values={form.subscriptionUrls}
          placeholder={t('subscriptionPlaceholder')}
          testId="field-subscriptions"
          redacted
          onChange={(next) => { setSaved(false); setForm({ ...form, subscriptionUrls: next }) }}
        />
        <div className={styles.fieldRow}>
          <TextField
            label={t('subscriptionRefreshMs')}
            hint={t('subscriptionRefreshMsHint')}
            value={form.refreshMs}
            testId="field-refreshMs"
            type="number"
            min={60_000}
            step={1}
            onChange={(value) => { setSaved(false); setForm({ ...form, refreshMs: value }) }}
          />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{' '}</span>
            <button
              type="button"
              className={styles.ghostButton}
              data-testid="refresh-subscriptions"
              disabled={actionBusy || !form.enabled}
              onClick={() => { void bridgeAction({ scope: 'refill' }) }}
            >
              {t('subscriptionRefreshNow')}
            </button>
          </div>
        </div>
        {status?.subscription !== null && status?.subscription !== undefined && (
          <span className={styles.status}>
            {t('sectionSubscription')}: {status.subscription.pendingConversion} 待转换 · {status.subscription.convertedAdmitted} 已转换入池
            {status.subscription.lastError !== '' ? ` · ${status.subscription.lastError}` : ''}
          </span>
        )}
        <TextField
          label={t('singboxPath')}
          hint={t('singboxPathHint')}
          value={form.singboxPath}
          testId="field-singboxPath"
          onChange={(value) => { setSaved(false); setForm({ ...form, singboxPath: value }) }}
        />
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>{t('sectionPinned')}</span>
        <TextField
          label={t('pinnedAddress')}
          hint={t('pinnedAddressHint')}
          value={form.pinnedExitId}
          placeholder={t('manualPlaceholder')}
          testId="field-pinnedExitId"
          onChange={(value) => { setSaved(false); setForm({ ...form, pinnedExitId: value }) }}
        />
        <span className={styles.fieldLabel}>{t('pinnedStrict')}</span>
        <span className={styles.fieldHint}>{t('pinnedStrictHint')}</span>
        <label className={styles.radio}>
          <input
            type="radio"
            name="ip-pool-strict"
            checked={!form.pinnedStrict}
            onChange={() => { setSaved(false); setForm({ ...form, pinnedStrict: false }) }}
          />
          {t('pinnedStrictOff')}
        </label>
        <label className={styles.radio}>
          <input
            type="radio"
            name="ip-pool-strict"
            checked={form.pinnedStrict}
            data-testid="field-pinnedStrict"
            onChange={() => { setSaved(false); setForm({ ...form, pinnedStrict: true }) }}
          />
          {t('pinnedStrictOn')}
        </label>
        {form.pinnedExitId !== '' && (
          <button
            type="button"
            className={styles.ghostButton}
            data-testid="unpin"
            disabled={saving}
            onClick={() => { setSaved(false); setForm({ ...form, pinnedExitId: '' }) }}
          >
            {t('pinnedUnset')}
          </button>
        )}
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>{t('sectionProbe')}</span>
        <ModelPicker
          value={form.probeModels}
          hint={t('probeModelsHint')}
          models={probeModelRows}
          loading={probeModelsLoading}
          t={t}
          onChange={(next) => { setSaved(false); setForm({ ...form, probeModels: next }) }}
        />
        <TextField
          label={t('probeConcurrency')}
          hint={t('probeConcurrencyHint')}
          value={form.maxConcurrentProbes}
          testId="field-maxConcurrentProbes"
          type="number"
          min={1}
          max={8}
          step={1}
          onChange={(value) => { setSaved(false); setForm({ ...form, maxConcurrentProbes: value }) }}
        />
        <button
          type="button"
          className={styles.ghostButton}
          data-testid="probe-all"
          disabled={actionBusy || !form.enabled}
          onClick={() => { void bridgeAction({ scope: 'all' }) }}
        >
          {probing ? t('probeRunning').replace('{done}', String(probeDone)).replace('{total}', String(probeTotal)) : t('probeAll')}
        </button>
      </div>

      {form.enabled && (
        <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('sectionExits')}</span>
          </div>
          <ExitTable status={status} t={t} busy={actionBusy} onProbe={(id) => { void bridgeAction({ scope: 'exit', exitId: id }) }} onPin={(id) => { void pinExit(id) }} />
        </>
      )}

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.primaryButton}
          data-testid="save-ip-pool"
          disabled={saving || !snapshot.writable}
          onClick={() => { void handleSave() }}
        >
          {saving ? t('saving') : t('save')}
        </button>
        <button
          type="button"
          className={styles.ghostButton}
          data-testid="reset-ip-pool"
          disabled={saving || !snapshot.writable}
          onClick={() => { void handleReset() }}
        >
          {t('reset')}
        </button>
        {statusError !== null && <span className={styles.saveStatusError}>{statusError}</span>}
        {saved && !error && <span className={`${styles.saveStatus} ${styles.saveStatusOk}`}>{t('saved')}</span>}
        {error !== null && <span className={`${styles.saveStatus} ${styles.saveStatusError}`}>{t('saveError')}：{error}</span>}
      </div>

      <p className={styles.compliance}>{t('copyCompliance')}</p>
    </div>
  )
}

/**
 * The IP 池 plugin card. Renders nothing until the slot outlet supplies the
 * inject face; the section stacks cards and reports their count.
 */
export function IpPoolCard(props: IpPoolCardProps): ReactNode {
  const { scope, useSnapshot, t } = props
  const [open, setOpen] = useState(false)
  useMemo(() => undefined, []) // keep React import meaningful for jsx-runtime parity
  if (scope === undefined || useSnapshot === undefined || t === undefined) return null
  return (
    <li className={styles.card}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        data-testid="ip-pool-card-header"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.headText}>
          <span className={styles.name}>{t('title')}</span>
          <span className={styles.description}>{t('description')}</span>
        </span>
        <IconChevronDownOutline14 className={styles.chevron + (open ? ` ${styles.chevronOpen}` : '')} />
      </button>
      {open && <CardBody scope={scope} useSnapshot={useSnapshot} t={t} />}
    </li>
  )
}
