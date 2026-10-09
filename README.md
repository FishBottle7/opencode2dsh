<div align="center">

# opencode2dsh

**Free OpenCode Zen models, natively inside DSH (DeepSeek Harness).**

No API key. No registration. No extra process.

[![npm](https://img.shields.io/npm/v/@opencode2dsh%2Fdsh-plugin)](https://www.npmjs.com/package/@opencode2dsh/dsh-plugin)
[![license](https://img.shields.io/npm/l/@opencode2dsh%2Fdsh-plugin)](https://github.com/FishBottle7/opencode2dsh/blob/master/LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/FishBottle7/opencode2dsh)

English | [简体中文](README.zh-CN.md)

</div>

---

opencode2dsh registers a native DSH `LlmAdapter` that streams directly from
[OpenCode Zen](https://opencode.ai/zen)'s **anonymous free lane** — the same
models OpenCode's own CLI uses without an account, served to your DSH model
picker as a regular provider called `opencode2dsh`.

Requests leave your machine looking exactly like traffic from the OpenCode
CLI (same user agent, same correlation headers), and the model catalog stays
fresh through a three-tier fallback chain. There is nothing to log into and
nothing to host.

## Highlights

- **Zero credential, zero setup** — the anonymous lane needs no key; install, restart, chat
- **Native adapter, no sidecar** — one npm package, no child process, no binary, no local port (the legacy Go sidecar is not part of the published package; see `legacy/`)
- **CLI-identical disguise** — requests carry the OpenCode CLI user agent and its session/request/project header set, derived per conversation
- **Selectable thinking levels** — reasoning-capable free models expose an effort picker in DSH's model selector (declared ladders where the model metadata provides them, Off/Minimal/Low/Medium/High otherwise); Responses-only `muse-spark-*` models expose only upstream-supported effort levels, and no selection keeps the provider default
- **Image input where it is declared** — image attachments are accepted for every model whose [models.dev](https://models.dev) entry lists `image` in `modalities.input`, and refused for the ones that declare `text` only; models.dev being silent falls back to the live-verified vision family
- **Live catalog with a fallback chain** — live upstream list ∩ free-by-metadata, falling back to offline cache and a verified static list
- **Self-healing** — fast startup retries, periodic refresh, and a written health snapshot for diagnostics
- **Proper error surfaces** — upstream failures (rate limit, auth, timeout, transport) arrive in DSH as classified finish reasons, and retries stay owned by DSH

## Install

**From the plugin market** (recommended, once this repo is listed there):
in DSH open **Settings → Plugin Market**, search `opencode2dsh`, one-click
install.

**From npm**:

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin
```

**From source** (build the tarball yourself):

```sh
git clone https://github.com/FishBottle7/opencode2dsh.git
cd opencode2dsh/packages/plugin
pnpm install && pnpm pack
dsh plugin --profile web add ./opencode2dsh-dsh-plugin-<version>.tgz
```

**Verify**: restart `dsh web`, open the model picker, and pick a model from
the **opencode2dsh** group.

Requires DSH (DeepSeek Harness) 0.1.7 or newer with a web profile (the IP 池
settings page rides the 0.1.7 Plugins page contract); Node.js ≥ 20 (already
present if DSH runs); outbound HTTPS to `opencode.ai` and `models.dev`.

## Configuration

Defaults work out of the box. Override via the profile's `cordis.patch.yml`:

```yaml
- id: opencode2dsh
  name: '@opencode2dsh/dsh-plugin'
  config:
    mode: adapter        # adapter (default) | sidecar
    providerId: opencode2dsh
    refreshSeconds: 300  # catalog refresh cadence
```

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `adapter` | `adapter`: native LlmAdapter streaming straight from Zen. `sidecar`: legacy local-agent mode, not bundled — build the agent from `legacy/agent` and pass `agentPath`. |
| `providerId` | `opencode2dsh` | Provider name shown in DSH. |
| `refreshSeconds` | `300` | Live catalog refresh interval. Pricing metadata refreshes every 24 h. |
| `agentPath` | auto-resolved | Sidecar only: path to the agent binary. |
| `agentArgs` | — | Sidecar only: extra CLI args for the agent. |
| `restartDelayMs` / `restartMaxDelayMs` / `maxConsecutiveCrashes` | `1000` / `60000` / `5` | Sidecar only: restart backoff and circuit breaker. |
| `firstEventMs` / `bodyIdleMs` / `responsesBodyIdleMs` | `30000` / `120000` / `300000` | Adapter only, plugin 0.3.7+: stream-liveness watchdogs, in ms (integers from `1` to `600000`). Time to the first stream event, mid-response body silence, and the body-idle floor for Responses models (`muse-spark-*`). Increase `firstEventMs` for slow cold starts. Unset keeps the defaults; restart DSH after editing. |

## How it works

```
DSH session
   │  harness chunks (block-start / text-delta / usage / finish …)
   ▼
ZenAdapter (registered LlmAdapter)
   │  pi-ai openai-completions stream (chat models)
   │  pi-ai openai-responses stream (`muse-spark-*`, Responses-only on Zen)
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
   with CLI-identical headers:
     user-agent: opencode/…
     x-opencode-client, x-opencode-session, x-session-affinity,
     X-Session-Id, x-opencode-request, x-opencode-project
```

- **Session correlation** — session/project ids are SHA-256 derived from the
  conversation's first user turn (stable per conversation, non-reversible),
  and each request gets a fresh random id, mirroring the CLI.
- **Catalog fallback chain** — S1: live `GET /v1/models`; S2: models.dev
  pricing metadata decides "free"; S3: a compile-time verified static list.
  A disk cache (~7-day TTL) covers upstream outages.
- **Resilience** — the adapter registers immediately at startup; if the first
  catalog fetch races your network (VPN/TUN reconnects, DNS), the plugin
  retries on a short cadence (~1 min) before settling into the periodic
  refresh.
- **Sidecar mode** (`mode: sidecar`, legacy) — spawns a local Go agent (a
  single-tenant port of [opencode2api](https://github.com/jasonxu114514/opencode2api))
  on `127.0.0.1:<random>`, token-authenticated, and registers a standard
  `llm-pi-ai` route. **Not part of the published package**; build it from
  `legacy/agent` (`go build ./cmd/agent`) and point `agentPath` at the binary.

## Health & troubleshooting

The plugin writes a health snapshot after every refresh round:

```
~/.opencode2dsh/adapter-status.json
```

```json
{
  "status": "ready",
  "total": 64,
  "exposed": 9,
  "lastError": "",
  "writtenAt": "2026-08-29T07:01:54.915Z"
}
```

| Symptom | Likely cause & fix |
| --- | --- |
| Boot screen shows `Failed to load plugins … list slot "plugins.item" requires options.id`, or the IP 池 entry has no configuration page | Your DSH predates the 0.1.7 Plugins page contract. Upgrade DSH to 0.1.7 (latest recommended). On 0.1.6 and older the page never mounts (it is gated on `configForms.whileServed`) — model routing is unaffected. |
| DSH 0.1.7/0.2 cannot start after plugin installation (`pending … settingsScope`) | Upgrade the plugin to 0.3.5. On DSH 0.2, configure IP pooling through the installed opencode2dsh row on the Plugins page. |
| Only 3 models | Startup fetch raced your network; retries land within ~1 min. Check `adapter-status.json` for `lastError`. |
| `lastError: "fetch failed"` persisting | Outbound HTTPS to `opencode.ai` blocked; check proxy/VPN rules. |
| Rate-limit errors in chat (`429 … Endpoint is unavailable`) | The anonymous lane is quota-per-IP and free models are contended. Since the fix for [#51](https://github.com/FishBottle7/opencode2dsh/issues/51) the plugin's provider retry policy rides out 429 bursts silently (8 retries, ~1s→20s backoff, ≈90s worst case per step) instead of surfacing them; when contention still wins, lower the reasoning effort, pick a less contended `-free` model, or enable IP pooling (multi-exit rotation) on the plugin settings page. |
| Output limit reached after reasoning with no answer | Plugin 0.3.6 retries once with thinking Off when the model supports it. Any answer text or tool-call event prevents replay. The retry preserves the original output cap and may still fail; both requests' usage is counted. Models without Off, including Muse, require a manual change of settings or model. |
| Muse reports `REGION_BLOCKED` / "This model is not available in your country" | Zen has rejected the current network region for this model. Plugin 0.3.5 preserves that explanation; older versions mislabeled the same 403 as an invalid API key. The anonymous lane does not need a personal key. Use a model available in your region. |
| Connection error to `127.0.0.1:*` | A stale sidecar route shadows the adapter; plugin ≥ 0.2.1 removes it at startup. |
| Install fails with `ERR_PNPM_IGNORED_BUILDS` | A transitive dependency of `pi-ai` (`@google/genai`, `protobufjs`) has build scripts that are not needed at runtime. Approve-or-decline them via the plugin market, or set both to `false` under `allowBuilds:` in the profile's `pnpm-workspace.yaml`. |

## Security

- No secrets involved: the anonymous lane's key is the literal string `public`; nothing is stored, nothing telemetry.
- Install paths restricted to `lib/` only; no build scripts run from dependencies.
- All requests go directly from your machine to `opencode.ai` / `models.dev`.

## Development

```sh
git clone https://github.com/FishBottle7/opencode2dsh.git
cd opencode2dsh/packages/plugin
pnpm install
pnpm typecheck && pnpm test
pnpm build                    # bundle to lib/
```

The legacy Go sidecar lives in `legacy/agent` (`go test ./...`). Architecture
notes and the porting record live in `docs/`.

Releasing: `pnpm pack` in `packages/plugin` (prepack builds and syncs docs).

## Acknowledgments

- [**opencode2api**](https://github.com/jasonxu114514/opencode2api) by
  [@jasonxu114514](https://github.com/jasonxu114514) — the legacy Go sidecar
  in `legacy/agent` is a port of its anonymous-lane implementation, and the
  catalog fallback chain and request-disguise details are derived from it.
  This project stands on its shoulders.
- [OpenCode](https://opencode.ai) — for running the free anonymous Zen lane.
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) — the wire layer used by adapter mode.
- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) and the
  [dsh-market](https://github.com/dsh-market/dsh-market) community.

## Friends

<div align="center">

**[LinuxDo](https://linux.do)** — 新的理想型社区 / a new ideal community

</div>

## License

[MIT](./LICENSE) © FishBottle7
