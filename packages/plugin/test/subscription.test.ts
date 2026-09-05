import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  looksLikeProxyLinks,
  looksLikeYaml,
  parseClashProxy,
  parseProxyLink,
  parseShadowsocksLink,
  parseSubscription,
  parseVmessLink,
  tryBase64Decode,
  type ParsedNode,
} from '../src/pool/subscription.ts'

const CLASH_SAMPLE = `
port: 7890
proxies:
  - name: "US direct"
    type: http
    server: 1.2.3.4
    port: 8080
  - name: "HK vmess"
    type: vmess
    server: hk.example.com
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    alterId: 0
    cipher: auto
    tls: true
    network: ws
    ws-opts:
      path: /path
  - name: "unsupported"
    type: wireguard
    server: 5.6.7.8
    port: 51820
  - name: "missing port"
    type: socks5
    server: 9.9.9.9
`

function vmessLink(fields: Record<string, unknown>): string {
  const json = JSON.stringify({ v: '2', ps: 'test node', add: 'v.example.com', port: '443', ...fields })
  return 'vmess://' + Buffer.from(json, 'utf8').toString('base64')
}

test('looksLikeYaml / looksLikeProxyLinks heuristics', () => {
  assert.ok(looksLikeYaml('proxies:\n  - name: x\n    type: vmess\n'))
  assert.ok(looksLikeYaml('Proxy:\n  - name: old\n'))
  assert.ok(!looksLikeYaml('vmess://abc\nvless://def'))
  assert.ok(looksLikeProxyLinks('vmess://abc\n'))
  assert.ok(looksLikeProxyLinks('ssr://abc'))
  assert.ok(looksLikeProxyLinks('hy2://abc'))
  assert.ok(!looksLikeProxyLinks('1.2.3.4:8080\n5.6.7.8:1080'))
})

test('tryBase64Decode round-trips and rejects binary soup', () => {
  const encoded = Buffer.from('vmess://hello', 'utf8').toString('base64')
  assert.equal(tryBase64Decode(encoded), 'vmess://hello')
  // URL-safe alphabet + missing padding
  assert.equal(tryBase64Decode(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'vmess://hello')
  // ordinary prose is not a subscription payload
  assert.equal(tryBase64Decode('hello world this is prose'), null)
})

test('parseClashProxy: normalization, port variants, type gate', () => {
  const httpNode = parseClashProxy({ name: 'a', type: 'http', server: '1.1.1.1', port: 80 })
  assert.equal(httpNode?.type, 'http')
  const ssNode = parseClashProxy({ name: 'b', type: 'ss', server: '2.2.2.2', port: '8388' })
  assert.equal(ssNode?.type, 'shadowsocks') // normalized
  assert.equal(ssNode?.port, 8388) // string port
  const defaultedName = parseClashProxy({ type: 'socks5', server: '3.3.3.3', port: 1080 })
  assert.equal(defaultedName?.name, '3.3.3.3:1080') // name fallback
  assert.equal(parseClashProxy({ type: 'wireguard', server: 'x', port: 1 }), null) // unsupported
  assert.equal(parseClashProxy({ type: 'vmess', server: 'x' }), null) // missing port
  assert.equal(parseClashProxy({ type: 'vmess', server: 'x', port: 70000 }), null) // bad port
})

test('parseSubscription: Clash YAML with good and skipped nodes', () => {
  const report = parseSubscription(CLASH_SAMPLE)
  assert.equal(report.detected, 'clash-yaml')
  assert.equal(report.nodes.length, 2) // http + vmess; wireguard/missing-port skipped
  assert.equal(report.skipped, 2)
  const vmess = report.nodes.find((node) => node.type === 'vmess')
  assert.equal(vmess?.server, 'hk.example.com')
  assert.deepEqual(vmess?.raw, {
    name: 'HK vmess', type: 'vmess', server: 'hk.example.com', port: 443,
    uuid: '11111111-2222-3333-4444-555555555555', alterId: 0, cipher: 'auto',
    tls: true, network: 'ws', 'ws-opts': { path: '/path' },
  })
})

test('vmess link: base64 JSON -> node with transport opts', () => {
  const link = vmessLink({ id: 'uuid-1', aid: '0', scy: 'auto', tls: 'tls', net: 'ws', path: '/ws', host: 'cdn.example.com' })
  const node = parseVmessLink(link)
  assert.equal(node?.type, 'vmess')
  assert.equal(node?.server, 'v.example.com')
  assert.equal(node?.port, 443)
  assert.equal(node?.raw.uuid, 'uuid-1')
  assert.equal(node?.raw.tls, true)
  assert.equal((node?.raw['ws-opts'] as { headers?: { Host?: string } })?.headers?.Host, 'cdn.example.com')
})

test('standard links: vless/trojan/hysteria2 via parseProxyLink', () => {
  const vless = parseProxyLink('vless://uuid-123@v.example.com:8443?encryption=none&flow=xtls-rprx-vision#NodeA')
  assert.equal(vless?.type, 'vless')
  assert.equal(vless?.name, 'NodeA')
  assert.equal(vless?.raw.uuid, 'uuid-123')
  assert.equal(vless?.raw.flow, 'xtls-rprx-vision')

  const trojan = parseProxyLink('trojan://pass%40word@t.example.com:443?sni=example.com#TrojanB')
  assert.equal(trojan?.type, 'trojan')
  assert.equal(trojan?.raw.password, 'pass@word')
  assert.equal(trojan?.raw.sni, 'example.com')

  const hy2 = parseProxyLink('hy2://pw@h.example.com:443/#Hy2C')
  assert.equal(hy2?.type, 'hysteria2')
  assert.equal(hy2?.name, 'Hy2C')

  // default port when omitted
  const noPort = parseProxyLink('trojan://pw@t.example.com#NoPort')
  assert.equal(noPort?.port, 443)
})

test('ss:// both layout variants', () => {
  // SIP002: base64 userinfo @ host:port
  const userinfo = Buffer.from('aes-256-gcm:pass123', 'utf8').toString('base64')
  const a = parseShadowsocksLink(`ss://${userinfo}@4.5.6.7:8388#SS-A`)
  assert.equal(a?.type, 'shadowsocks')
  assert.equal(a?.server, '4.5.6.7')
  assert.equal(a?.name, 'SS-A')
  assert.equal(a?.raw.cipher, 'aes-256-gcm:pass123')

  // legacy: whole thing base64(method:password@host:port)
  const legacy = Buffer.from('chacha20:pw@5.6.7.8:9000', 'utf8').toString('base64')
  const b = parseShadowsocksLink(`ss://${legacy}#SS-B`)
  assert.equal(b?.server, '5.6.7.8')
  assert.equal(b?.port, 9000)
  assert.equal(b?.raw.method, 'chacha20')
  assert.equal(b?.raw.password, 'pw')
})

test('base64-wrapped subscriptions (both inner formats)', () => {
  const links = ['vmess://' + Buffer.from('{"add":"a.com","port":"1","id":"x"}').toString('base64'), 'trojan://pw@b.com:443#t'].join('\n')
  const report = parseSubscription(Buffer.from(links, 'utf8').toString('base64'))
  assert.equal(report.detected, 'base64:proxy-links')
  assert.equal(report.nodes.length, 2)

  const yamlReport = parseSubscription(Buffer.from(CLASH_SAMPLE, 'utf8').toString('base64'))
  assert.equal(yamlReport.detected, 'base64:clash-yaml')
  assert.equal(yamlReport.nodes.length, 2)
})

test('plain address list falls through', () => {
  const report = parseSubscription('1.2.3.4:8080\nsocks5://5.6.7.8:1080\n# comment\n\njunk line')
  assert.equal(report.detected, 'plain')
  assert.equal(report.nodes.length, 2)
  assert.equal(report.nodes[1]?.type, 'socks5')
})

test('real-world airport fixture: 38 anytls nodes parse clean', () => {
  // The Clash subscription sample committed in the GoProxy repository
  // (subscriptions/sub_1775301718713.yaml): a real airport config with
  // proxy-groups and anytls nodes — the parser must take only the proxies
  // section and skip the group entries.
  const fixture = readFileSync('C:/Users/FishBottle/AppData/Local/Temp/GoProxy/subscriptions/sub_1775301718713.yaml', 'utf8')
  const report = parseSubscription(fixture)
  assert.equal(report.detected, 'clash-yaml')
  assert.equal(report.nodes.length, 38)
  assert.ok(report.nodes.every((node: ParsedNode) => node.type === 'anytls'))
  const first = report.nodes[0]
  assert.equal(first?.server, 'us01.shanhai.click')
  assert.equal(first?.port, 18888)
  assert.equal(first?.raw.password, '848f43e4-6e11-4efa-9f96-84c0e16a03e5')
  assert.equal(first?.raw.sni, 'us01.shanhai.click')
})
