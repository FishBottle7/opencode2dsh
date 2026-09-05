/**
 * Subscription parsing — the TS port of GoProxy custom/parser.go (docs/
 * ip-pool.md 1.2.1): three-format auto-detection with no user format choice.
 *
 *   1. Clash YAML (proxies key, new+old layout)      -> per-proxy nodes
 *   2. protocol links (vmess:// vless:// trojan:// ss:// hysteria2:// tuic://)
 *      vmess is V2rayN base64 JSON; the rest are standard URIs
 *   3. Base64 wrapping either of the above (airport default)
 *
 * Output is GoProxy's ParsedNode shape verbatim: plaintext nodes (http/
 * socks5) dial directly; everything else needs an external core (1.2.2) and
 * only carries its raw config forward for that layer.
 */

import { parse as parseYaml } from 'yaml'

export interface ParsedNode {
  name: string
  /** Normalized type: vmess/vless/trojan/shadowsocks/hysteria2/tuic/anytls/http/socks5 */
  type: string
  server: string
  port: number
  /** Raw config fields (the future sing-box conversion input, 1.2.2). */
  raw: Record<string, unknown>
}

export interface ParseReport {
  nodes: ParsedNode[]
  /** Counters for diagnostics (the settings page shows them). */
  detected: 'clash-yaml' | 'proxy-links' | 'base64:clash-yaml' | 'base64:proxy-links' | 'plain'
  skipped: number
}

const SUPPORTED_TYPES = new Set([
  'vmess', 'vless', 'trojan', 'shadowsocks', 'shadowsocksr',
  'hysteria', 'hysteria2', 'tuic', 'anytls', 'http', 'socks5',
])

/** GoProxy looksLikeYAML: the structural markers of a Clash config. */
export function looksLikeYaml(content: string): boolean {
  if (/^proxies:\s*$/m.test(content) || /^Proxy:\s*$/m.test(content)) return true
  if (content.includes('proxies:') && content.includes('- name:')) return true
  // defensive heuristic: a mappings-heavy document with a port field
  return /^---\s*$/m.test(content) && content.includes('port:')
}

/** GoProxy looksLikeProxyLinks. */
export function looksLikeProxyLinks(content: string): boolean {
  return (
    content.includes('vmess://') ||
    content.includes('vless://') ||
    content.includes('trojan://') ||
    content.includes('ss://') ||
    content.includes('ssr://') ||
    content.includes('hysteria2://') ||
    content.includes('hy2://') ||
    content.includes('tuic://')
  )
}

/** Base64 decode tolerant of the variants subscriptions actually use
 *  (missing padding, URL-safe alphabet, embedded newlines). */
export function tryBase64Decode(content: string): string | null {
  const compact = content.replace(/\s+/g, '')
  if (compact.length < 8) return null
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    // Guard against the classic trap: arbitrary text is often "decodable".
    // A real subscription payload must survive a round trip.
    const recheck = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '')
    if (recheck.replace(/\+/g, '-').replace(/\//g, '_') !== compact.replace(/=+$/, '')) return null
    // and must be printable text (protocol links / YAML), not binary soup
    if (decoded.includes('\u0000')) return null
    return decoded
  } catch {
    return null
  }
}

/** One Clash YAML proxy entry -> ParsedNode (GoProxy parseClashProxy). */
export function parseClashProxy(proxy: Record<string, unknown>): ParsedNode | null {
  if (typeof proxy !== 'object' || proxy === null) return null
  const type = typeof proxy.type === 'string' ? proxy.type.toLowerCase() : ''
  const server = typeof proxy.server === 'string' ? proxy.server : ''
  if (type === '' || server === '') return null
  let port = 0
  const rawPort = proxy.port
  if (typeof rawPort === 'number' && Number.isFinite(rawPort)) port = rawPort
  else if (typeof rawPort === 'string' && /^\d+$/.test(rawPort)) port = Number(rawPort)
  if (port < 1 || port > 65535) return null
  const normalized = type === 'ss' ? 'shadowsocks' : type === 'ssr' ? 'shadowsocksr' : type
  if (!SUPPORTED_TYPES.has(normalized)) return null
  const name = typeof proxy.name === 'string' && proxy.name.length > 0 ? proxy.name : `${server}:${port}`
  return { name, type: normalized, server, port, raw: proxy }
}

/** Clash YAML document -> nodes (new `proxies` + legacy `Proxy` layouts). */
export function parseClashYaml(content: string): { nodes: ParsedNode[]; skipped: number } {
  let document: unknown
  try {
    document = parseYamlDocument(content)
  } catch {
    return { nodes: [], skipped: 0 }
  }
  if (typeof document !== 'object' || document === null) return { nodes: [], skipped: 0 }
  const config = document as Record<string, unknown>
  const proxyLists = [config.proxies, config.Proxy].filter(
    (value): value is unknown[] => Array.isArray(value),
  )
  const nodes: ParsedNode[] = []
  let skipped = 0
  for (const list of proxyLists) {
    for (const entry of list) {
      const node = parseClashProxy(entry as Record<string, unknown>)
      if (node) nodes.push(node)
      else skipped += 1
    }
  }
  return { nodes, skipped }
}

function parseYamlDocument(content: string): unknown {
  return parseYaml(content)
}

/** vmess:// V2rayN base64-JSON link (GoProxy parseVmessLink). */
export function parseVmessLink(link: string): ParsedNode | null {
  const decoded = tryBase64Decode(link.slice('vmess://'.length))
  if (decoded === null) return null
  let info: Record<string, unknown>
  try {
    info = JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return null
  }
  const server = String(info.add ?? '')
  const port = Number(info.port ?? 0)
  if (server === '' || !Number.isFinite(port) || port < 1) return null
  const name = typeof info.ps === 'string' && info.ps.length > 0 ? info.ps : server
  const raw: Record<string, unknown> = {
    type: 'vmess',
    name,
    server,
    port,
    uuid: String(info.id ?? ''),
    alterId: Number(info.aid ?? 0) || 0,
    cipher: typeof info.scy === 'string' ? info.scy : 'auto',
  }
  if (String(info.tls) === 'tls') {
    raw.tls = true
    if (typeof info.sni === 'string' && info.sni) raw.sni = info.sni
  }
  const network = typeof info.net === 'string' ? info.net : 'tcp'
  raw.network = network
  if (network === 'ws') {
    const wsOpts: Record<string, unknown> = {}
    if (typeof info.path === 'string' && info.path) wsOpts.path = info.path
    if (typeof info.host === 'string' && info.host) wsOpts.headers = { Host: info.host }
    raw['ws-opts'] = wsOpts
  } else if (network === 'grpc') {
    const grpcOpts: Record<string, unknown> = {}
    if (typeof info.path === 'string' && info.path) grpcOpts['grpc-service-name'] = info.path
    raw['grpc-opts'] = grpcOpts
  }
  return { name, type: 'vmess', server, port, raw }
}

/** Standard URI link (vless/trojan/hysteria2/tuic) — GoProxy parseStandardLink. */
export function parseStandardLink(link: string, type: string): ParsedNode | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  const server = url.hostname.replace(/^\[|\]$/g, '')
  let port = Number(url.port)
  if (!Number.isFinite(port) || port < 1) port = 443
  const name = decodeURIComponent(url.hash.slice(1)) || server
  const raw: Record<string, unknown> = { type, name, server, port }
  const username = url.username ? decodeURIComponent(url.username) : ''
  if (username !== '') {
    if (type === 'trojan' || type === 'hysteria2') raw.password = username
    else if (type === 'vless' || type === 'tuic') {
      raw.uuid = username
      if (url.password) raw.password = decodeURIComponent(url.password)
    }
  }
  for (const [key, value] of url.searchParams) raw[key] = value
  return { name, type, server, port, raw }
}

/** ss:// link (GoProxy parseShadowsocksLink, both layout variants). */
export function parseShadowsocksLink(link: string): ParsedNode | null {
  // variant A: ss://base64(method:password)@host:port#name
  // variant B: ss://base64(method:password@host:port)#name  (legacy SIP002-pre)
  const hashIndex = link.indexOf('#')
  const name = hashIndex >= 0 ? decodeURIComponent(link.slice(hashIndex + 1)) : ''
  const body = hashIndex >= 0 ? link.slice('ss://'.length, hashIndex) : link.slice('ss://'.length)
  const at = body.lastIndexOf('@')
  if (at > 0) {
    const userinfo = tryBase64Decode(body.slice(0, at))
    const hostPart = body.slice(at + 1)
    const hostMatch = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(hostPart)
    if (userinfo === null || !hostMatch?.[1] || !hostMatch[2]) return null
    const port = Number(hostMatch[2])
    if (port < 1) return null
    const server = hostMatch[1].replace(/^\[|\]$/g, '')
    return {
      name: name || server,
      type: 'shadowsocks',
      server,
      port,
      raw: { type: 'shadowsocks', name: name || server, server, port, cipher: userinfo },
    }
  }
  const decoded = tryBase64Decode(body)
  if (decoded === null) return null
  const match = /^(\S+?)@(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(decoded)
  if (!match?.[1] || !match[2] || !match[3]) return null
  const port = Number(match[3])
  const server = match[2].replace(/^\[|\]$/g, '')
  const colon = match[1].indexOf(':')
  const method = colon > 0 ? match[1].slice(0, colon) : match[1]
  const password = colon > 0 ? match[1].slice(colon + 1) : ''
  return {
    name: name || server,
    type: 'shadowsocks',
    server,
    port,
    raw: { type: 'shadowsocks', name: name || server, server, port, method, password },
  }
}

/** One protocol link line -> node (GoProxy parseProxyLink). */
export function parseProxyLink(link: string): ParsedNode | null {
  const value = link.trim()
  if (value.startsWith('vmess://')) return parseVmessLink(value)
  if (value.startsWith('vless://')) return parseStandardLink(value, 'vless')
  if (value.startsWith('trojan://')) return parseStandardLink(value, 'trojan')
  if (value.startsWith('ss://')) return parseShadowsocksLink(value)
  if (value.startsWith('hysteria2://') || value.startsWith('hy2://')) return parseStandardLink(value, 'hysteria2')
  if (value.startsWith('tuic://')) return parseStandardLink(value, 'tuic')
  return null
}

/** Protocol-link document -> nodes (skipping unparsable lines). */
export function parseProxyLinks(content: string): { nodes: ParsedNode[]; skipped: number } {
  const nodes: ParsedNode[] = []
  let skipped = 0
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const node = parseProxyLink(line)
    if (node) nodes.push(node)
    else skipped += 1
  }
  return { nodes, skipped }
}

/** GoProxy parsePlain: bare host:port lines (direct http/socks5 nodes). */
export function parsePlainAddresses(content: string): ParsedNode[] {
  const nodes: ParsedNode[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    let protocol: 'http' | 'socks5' = 'http'
    let address = line
    const scheme = /^([a-z0-9+.-]+):\/\//i.exec(line)
    if (scheme) {
      const name = scheme[1]!.toLowerCase()
      address = line.slice(scheme[0].length)
      if (name === 'socks5' || name === 'socks4' || name === 'socks5h') protocol = 'socks5'
      else if (name !== 'http' && name !== 'https') continue
    }
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(address)
    if (!match) continue
    const port = Number(match[2])
    if (port < 1 || port > 65535) continue
    const server = match[1]!.replace(/^\[|\]$/g, '')
    nodes.push({
      name: address,
      type: protocol,
      server,
      port,
      raw: { type: protocol, server, port },
    })
  }
  return nodes
}

/**
 * Parse a subscription body with format auto-detection (GoProxy
 * parseAutoDetect, same probe order). Never throws: unknown formats report
 * zero nodes with `detected` left as the closest guess.
 */
export function parseSubscription(content: string): ParseReport {
  const trimmed = content.trim()
  if (trimmed === '') return { nodes: [], detected: 'plain', skipped: 0 }

  if (looksLikeYaml(trimmed)) {
    const { nodes, skipped } = parseClashYaml(trimmed)
    if (nodes.length > 0) return { nodes, detected: 'clash-yaml', skipped }
  }
  if (looksLikeProxyLinks(trimmed)) {
    const { nodes, skipped } = parseProxyLinks(trimmed)
    if (nodes.length > 0) return { nodes, detected: 'proxy-links', skipped }
  }
  const decoded = tryBase64Decode(trimmed)
  if (decoded !== null) {
    if (looksLikeYaml(decoded)) {
      const { nodes, skipped } = parseClashYaml(decoded)
      if (nodes.length > 0) return { nodes, detected: 'base64:clash-yaml', skipped }
    }
    if (looksLikeProxyLinks(decoded)) {
      const { nodes, skipped } = parseProxyLinks(decoded)
      if (nodes.length > 0) return { nodes, detected: 'base64:proxy-links', skipped }
    }
    const plain = parsePlainAddresses(decoded)
    if (plain.length > 0) return { nodes: plain, detected: 'plain', skipped: 0 }
  }
  const plain = parsePlainAddresses(trimmed)
  if (plain.length > 0) return { nodes: plain, detected: 'plain', skipped: 0 }
  return { nodes: [], detected: 'plain', skipped: 0 }
}
