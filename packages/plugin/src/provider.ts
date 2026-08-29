/**
 * Registers the local agent into DSH's llm-pi-ai provider settings and keeps
 * the model list fresh (plan.md 1.5, per Appendix A conclusion).
 *
 * Two touches, both idempotent:
 *  1. credentials: store the local token behind apiKeyEnv so the settings
 *     document never carries the secret (ctx.credentials.set).
 *  2. settings: ensure llm-pi-ai.providers.<providerId> exists with baseURL
 *     http://127.0.0.1:<port>/v1 and the model list from GET /v1/models
 *     (ctx.settings.mutate on the user section).
 */

export interface AgentModel {
  id: string
  name?: string
  description?: string
}

export interface PiAiModelEntry {
  id: string
  name: string
}

export interface ProviderTarget {
  providerId: string
  apiKeyEnv: string
  port: number
}

export function providerBaseURL(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

/** Minimal settings/credentials seam so tests can run against fakes. */
export interface DshSeams {
  credentials: {
    set(ref: string, value: string): Promise<void>
  }
  settings: {
    get(ns: string): unknown
    mutate(ns: string, ops: Array<{ op: 'set' | 'unset'; path: Array<string | number>; value?: unknown }>): Promise<void>
  }
  logger: { info(message: string): void; warn(message: string): void }
}

/** Parse the agent's OpenAI-shaped /v1/models reply into pi-ai model entries. */
export function toPiAiModels(data: unknown): PiAiModelEntry[] {
  if (!data || typeof data !== 'object') return []
  const list = (data as { data?: unknown }).data
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const entries: PiAiModelEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const name = (item as { name?: unknown }).name
    entries.push({
      id,
      name: typeof name === 'string' && name.length > 0 ? name : id,
    })
  }
  return entries
}

export async function fetchModels(port: number, token: string, timeoutMs = 10000): Promise<PiAiModelEntry[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(providerBaseURL(port) + '/models', {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GET /v1/models failed: HTTP ${response.status}`)
    return toPiAiModels(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

/** GET /healthz (no auth); throws on transport failure or non-2xx. */
export async function fetchHealth(port: number, timeoutMs = 3000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal })
    if (!response.ok) throw new Error(`GET /healthz failed: HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ensure the credential and the llm-pi-ai provider route reflect the running
 * agent. Safe to call repeatedly (every refresh): writes are no-ops when the
 * stored shape already matches, and mutate keeps other namespaces/routes
 * untouched because it edits only the opencode2dsh subtree.
 */
export async function registerProvider(
  seams: DshSeams,
  target: ProviderTarget,
  token: string,
  models: PiAiModelEntry[],
): Promise<void> {
  await seams.credentials.set(target.apiKeyEnv, token)

  const route = {
    displayName: 'opencode2dsh',
    apiKeyEnv: target.apiKeyEnv,
    api: 'openai-completions',
    baseURL: providerBaseURL(target.port),
    models,
  }
  await seams.settings.mutate('llm-pi-ai', [
    { op: 'set', path: ['providers', target.providerId], value: route },
  ])
  seams.logger.info(`opencode2dsh: registered llm-pi-ai provider "${target.providerId}" with ${models.length} model(s) at ${route.baseURL}`)
}
