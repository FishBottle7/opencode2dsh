# Changelog

## Unreleased

- Add an opt-in Bun inference transport for the measured 2026-10-28 v2 compatibility refusal (#108), preserving DSH instructions, tools and streaming; default transport remains unchanged. See docs/free-lane-20261028.md for configuration and live-test limits.

### Fixed

- Transient stream truncations no longer fail the turn without a retry (#103; real-session evidence and root-cause analysis by @1Dreamer666). pi-ai raises `Stream ended without finish_reason` when a provider stream ends without any chunk carrying `finish_reason` — upstream sent `[DONE]` early or the connection was cut before the terminal chunk, a transport/protocol truncation either way. The ported `classifyError()` had no fragment for that wording, so the error fell through to the `UPSTREAM` catch-all — and `UPSTREAM` is deliberately not in `FREE_LANE_RETRY_POLICY.retryableCodes` (adding it would also retry deterministic `AUTH`/`INVALID_REQUEST`/context errors), so the host's `@deepseek-ai/dsh-llm-retry` never fired: the reporter's desktop session (2026-10-20 18:56 +08) died at turn 5 with `{"kind":"error","message":"Stream ended without finish_reason","code":"UPSTREAM"}`, zero `llm/retry` events, on a ~41k-wire-token history far below the 300k window — and the same step succeeded on the next turn, confirming a transient cut, not a model refusal. The native `@deepseek-ai/dsh-llm-pi-ai` adapter classifies this exact wording as TRANSPORT (its convert.spec.ts:839-855); this port diverged. Fixed with an enumerated set of pi-ai transport/truncation wordings — each grounded in the installed dist throw site in both resolutions (nested 0.82.1 and the 0.87.1 alias; the file:line table lives in the new `src/adapter/stream-truncation.ts`; the issue's "WebSocket closed unexpectedly" does not exist in either dist, the grounded family is `WebSocket closed…`/`WebSocket stream closed before response.completed` from the codex transport, which the shipped fragment covers) — classifying as `TRANSPORT` in `classifyError`, so a post-content truncation now gets the host executor's up-to-eight retries with exponential backoff, and mirrored into `pool/rotate.ts`'s `classifyStreamFailure`, which returned `null` for these texts and skipped the pre-content rotate-retry entirely, so a truncation before any content now rotates to a fresh exit as well. `retryableCodes` itself is unchanged (`UPSTREAM` stays the un-retried catch-all) and the provider retry mode is untouched.

## 0.3.14 (2026-10-20)

### Added

- Optional `allowedModels` config — a model whitelist for what DSH shows and serves (#83). Exact-match model ids; omitted or empty keeps today's behavior (every eligible free-lane model is exposed). When set, the picker shows `allowedModels ∩` the currently eligible free models, the serving gate denies a direct call to a non-whitelisted id with the distinct `not_in_whitelisted` source, and zen-adapter's `prepareCall`/`stream` fail fast with a tagged "not in allowedModels" error BEFORE any network traffic — only the whitelist gates serving; probe-pending/blocklisted ids keep today's serving behavior. The adaptive probe skips non-whitelisted ids (they can never be exposed, so their anonymous-lane quota is not spent). The whitelist only narrows: paid/deprecated/local-blocklist/probe verdicts stay authoritative, so a whitelisted id that is currently probe-refused remains hidden. If the whitelist excludes the host's configured default model, one startup warn names it (advisory only — no crash, no config rewrite).

### Fixed

- The `deepseek-v4.1-flash-free` catalog entry no longer claims a 1,048,576-token window that the anonymous lane cannot serve (#99). A 2026-10-20 re-probe of the same lane recalls a needle at 315,596 prompt tokens and refuses a ~326k-token prompt with `context_length_exceeded`; #81's 1M value came from a 2026-10-16 probe and is no longer reproducible. The override now advertises 300,000 tokens, so DSH's 0.8x compaction threshold (240,000) fires before the real ceiling instead of at 800,000, and 240k + the 32k output budget stays below 315,596; this keeps >200k usable while avoiding a hard upstream error. `maxOutput` is unchanged at 32,000; no other model or field is touched.
- Sessions filled up to the advertised context window no longer fail with a fabricated `CONTEXT_WINDOW_EXCEEDED` while the upstream answers normally (#99; reporter @1Dreamer666). The ported `mapStopReason` carried dsh-llm-pi-ai's `isContextOverflow` heuristic: an error-free `stop` finish was re-classified as a context error whenever wire `usage.input` alone exceeded the resolved window. But the wire token count runs ~4-5k above the host's history estimate (system prompt + gate tools + serialization), so history filled right up to the advertised window reliably tripped the heuristic — a 200k-window model fabricated an error out of a turn the upstream had accepted and answered. The healthy-stop classification is removed: a stop is a stop at any size, and the now-unused `contextWindow` parameter came off `toStreamChunks` with it. A genuine upstream context refusal (HTTP 400 `context_length_exceeded`) still surfaces as `CONTEXT_WINDOW_EXCEEDED` with the upstream body preserved through the unchanged error-message regex branch, verified end-to-end against the real adapter + pi-ai transport. This does not claim to fix the reporter's own deepseek case: their posted error text confirmed a genuine upstream `400 context_length_exceeded`, with the lane's live ceiling needle-verified at 315,596 recall-OK and ~326k refused (and one earlier refusal at ~181.7k — the cap moves with time/exit); advertising the verified ceiling is the separate mitigation in PR #100.
- Multi-step tool calls with reasoning enabled no longer fail with a 400 ("The `reasoning_content` in the thinking mode must be passed back to the API") once the history contains an assistant message with reasoning (#96; root-cause analysis and locally verified patch by @IThanjie). Zen's DeepSeek requires replayed assistant messages to carry `reasoning_content`; pi-ai stores the upstream reasoning field name (the replay key, e.g. `reasoning_content`) in the thinking block's `thinkingSignature` while parsing the stream, but the plugin dropped it twice — `toStreamChunks`' `thinking_end` built the harness `{ type: 'reasoning', text }` block without it, and `toPiAssistant`' `reasoning` case rebuilt `{ type: 'thinking', thinking }` without it, so pi-ai's serializer (which writes the thinking under `assistantMsg[signature]`; empty signature -> no reasoning key at all) sent history without the field. pi-ai's own fallback only fires on its `isDeepSeek` auto-detection (provider `deepseek` or a `deepseek.com` baseUrl) — neither matches this provider id or `https://opencode.ai/zen/v1`. Both halves fixed: the signature now round-trips (`thinking_end` reads `event.partial.content[contentIndex].thinkingSignature` into an additive optional `signature` on the harness reasoning block — the reasoning-recovery retry re-emits chunks by spread, so it survives — and `toPiAssistant` restores it as `thinkingSignature`; note pi-ai's `transformMessages` keeps signed thinking blocks only for same-provider + same-api + same-model history, so switching models mid-conversation falls back to the compat path), and `toPiModel` now declares `compat: { requiresReasoningContentOnAssistantMessages: true }` so pi-ai writes an empty `reasoning_content` on every replayed assistant message whose thinking block arrived without a signature — mandatory for migration, since conversations persisted by older plugin builds carry signature-less reasoning blocks forever, and reasoning from the #92 delegate lane never carries one; the key must merely be present, not populated, for upstream to accept the request.

## 0.3.13 (2026-10-19)

### Added

- Optional local-OpenCode delegation for the credential gate (#92, ref #76; **off by default**). When the anonymous lane is persistently refused (direct attempt AND the sibling-host replay both `403 FreeTierError`) and the user opts in via `delegation.enabled`, the turn runs through a real local `opencode serve` child process instead of surfacing the error: only the `opencode` entry of the user's existing auth.json is seeded (0600, isolated XDG root, value never logged), the binary is version-floored at 1.18.0 (managed -> global -> npm download, sha512-verified), memory is capped (`GOMEMLIMIT`/`GOGC` + working-set trim), and every native tool call is mediated ask-then-reject so nothing executes on the user's machine. Success is judged by `info.error` presence, never by "has a text part" (the runtime reports gate failures with HTTP 200). Enabling makes the plugin a credential custodian — read `docs/delegation.md` before turning it on; disabled, the anonymous path is unchanged.
- Blocklisted free models are re-verified from this host's own exit by an adaptive probe (#84). The probe set is the issue #56 blocklist minus the never-serve protocol id (`jev-1.13-free`): `exo-free`, `ling-3.0-flash-fin-free`, `muse-spark-1.2/1.3-contributor-free`. A 1-token request on the model's real lane (Responses for muse, chat for the rest) decides per boot whether the id is exposed again, with a 30-minute retry; refused or still-pending ids stay hidden, so #56's conservative default holds until this egress proves otherwise (#82).

### Fixed

- Host tools (`pwsh`, `read`, `grep`, …) reach the model again in DSH profiles, where a single hoisted pi-ai copy resolves for the whole profile (#77). pi-ai 0.86.0 narrowed the provider-facing API to a normalized `TranscriptContext`: tool declarations now ride the leading system message's `toolsAdded`, and `context.tools` is folded into it only by the `Models` entry points (0.87.1 `dist/models.js:393` -> `normalizeContext`). The adapter called the raw provider's `streamSimple` directly, so under a hoisted pi-ai >= 0.86 every host tool was silently dropped — the wire carried only the injected free-lane gate stubs with `tool_choice: "none"` as the tell, and models answered "I don't have a pwsh tool" or leaked tool-call markup as text. Standalone installs were unaffected because they nest pi-ai 0.82.1, whose transport still reads `context.tools` directly. The adapter now routes both transports (chat and Responses) through pi-ai's `Models` wrapper: a pass-through on 0.82.x, the fold point on >= 0.86 — one code path serves both resolutions, so narrowing the semver range (which a hoisted profile ignores anyway, #40) was not an option. The gate-stub injection, the reasoning-effort payload rewrite, and the #80 sibling-host replay are unchanged.
- `https://` proxies in a subscription (or in `ipPool.manual`) are no longer dialed as plaintext and struck dead. Live diagnosis (2026-10-15): **46 of 118 exits** were `dead` with `transport · other side closed`, on ports 443/9002/9443 — all of them working proxies. The scheme passed the parser's whitelist and was then **discarded**: `protocol` kept its `'http'` initial value, so `ProxyAgent` was handed `http://host:443` and sent a bare `CONNECT` to a TLS listener. The listener closed without a status line, undici reported `SocketError: other side closed` (`client-h1.js` `onHttpSocketEnd`), and the §4.2 rule table — correctly, for what it was told — marked healthy exits dead. Sampling those exits directly: a plaintext `CONNECT` returned a clean FIN, the TLS handshake succeeded (`*.windscribe.com`, `*.nodes.gen4.ninja`), and a TLS-wrapped `CONNECT` answered `HTTP/1.1 200 OK`. Re-running the plugin's own admission over 8 of them: **0/8 admitted as `http`, 8/8 reached the upstream as `https`** (3 admitted, 1 `429`-limited, 4 answered the echo with an empty body → `malformed`, i.e. correctly *not* transport).
  - `https` is now a first-class exit protocol (`ExitProtocol`) carried end to end — `parsePlainAddresses` (plain and base64 lists), the Clash `type: https` proxy gate, the plaintext branch of `subscription-fetcher`, and `parseManualProxy`. `exitProxyUri` emits `https://` instead of collapsing it to `http://`, which is what undici's `proxy-agent.js` keys on when deciding whether to wrap `CONNECT` in TLS (`forwardConnect = protocol === 'https:'`).
  - `https` proxies are built with `proxyTls: { rejectUnauthorized: false }`. Measured: a bare `ProxyAgent({ uri: 'https://…' })` fails **every** request with `Secure Proxy Connection failed` — these exits are IP literals, so there is no hostname for a certificate to be issued against and verification can never succeed. Only the **proxy hop** is unverified; the tunneled request still runs undici's normal TLS path to the real target, so end-to-end confidentiality is unchanged, and an IP-literal proxy has no identity to check in the first place.

- Subscription exits that are genuinely unreachable are now marked `dead` instead of sitting at `unknown` forever, and a probe failure no longer strikes a working exit dead. Live diagnosis (2026-10-14): of 726 subscription exits, **703 rendered as 未探活 with zero facts** (no exit IP, no latency, no passive counters) while the probe queue had fully drained (`enqueued == completed == 25779`). They had all been probed — the failures were simply never written. Two producers disagreed about what a failure means:
  - `probeAll`/`probeExit` treated **every** failure as dead (`else markDeadStrike`), so a `zen models HTTP 403` — a model-level refusal behind a perfectly good link (§4.2) — would disable a usable exit.
  - `subscription-fetcher` wrote **nothing** on failure, because `admitTrusted` reports failures as `admitted: true, degraded: true` (so the address stays in the table as the routing-key fallback, §3.1). A dead link therefore stayed `unknown`, and `isUsable()` treats `unknown` as usable — so dead exits remained rotation candidates. Sampling 24 of those exits with the plugin's own admission code showed 23 `transport` failures (`SOCKS5 connection timeout`, `other side closed`, probe timeout) and 1 refusal (`echo HTTP 400`): only the first group is dead, which is exactly the distinction the code could not make.
  - Failures are now **classified at the failure site** (`transport` / `refused` / `server-error` / `quota` / `geo-blocked` / `slow` / `malformed`) and applied through one shared verdict path (`src/pool/probe-verdict.ts`) that every producer calls. Only `transport` means the link is gone; `refused` bans the (exit × model) pairing; `server-error` (upstream 5xx), `geo-blocked`, `slow` and `malformed` all mean the exit *answered* and deliberately leave health untouched.
  - The spec now has exactly two layers: the **verdict is uniform across sources** (what the failure means never depends on who supplied the node), and the **only source-dependent rule is retention** — a dead `free` node is evicted so its slot can be refilled, while a dead subscription/manual node is disabled in place and re-probed by `PeriodicProber`. Marking a subscription exit dead therefore does **not** drop the user's node: it leaves the rotation and returns automatically once a probe passes.
  - The settings card distinguishes the states it previously conflated: `未探活` is now reserved for genuinely never-probed exits, a probed-but-failed exit shows `探测失败`, and a new **探活失败原因** column carries the classified reason (e.g. `transport · SOCKS5 connection timeout`).
- Real requests no longer collide with a health probe on the same anonymous quota. Live diagnosis (2026-10-15): the settings card showed a healthy spread of `ok` exits while every request still answered 429. Two causes, both about the probe queue and quota contention rather than exit quality:
  - **A subscription refresh re-smoked the entire table every round.** `enqueued` climbed past 2600 with only 400 exits in the table and a 6-hour `refreshMs`, because each round re-queued everything while the queue drained at ~2.5/s under the concurrency cap — buried faster than it drained. A refresh now re-smokes only exits that are **new** or whose last verdict has **gone stale** (30 min), with a hard per-round ceiling as a backstop; node recovery is unaffected (stale exits are re-probed, and `PeriodicProber` still covers them). The converted and plaintext paths now share that rule (the `known`/`stale` sets were previously scoped inside the converted branch), `known` is a `Set` instead of repeated `includes` scans, and `pendingConversion` is spliced by identity — it used to re-filter ~1900 nodes per task, making a round quadratic.
  - **`pick` never considered whether an exit was being probed.** It ranked on health + latency alone, so the fastest `ok` exit won every pick even while a probe of it was spending that exit's quota bucket (§4.1). An exit under probe is now **deprioritized**, and session stickiness no longer re-pins onto it. Deliberately a deprioritizing, not a ban: a full sweep covers up to `maxPerRound` exits, so banning the probed ones would empty the pool mid-sweep and drop traffic to a direct connection — worse than the 429 — and an all-probed pool still answers.
- A stream that dies **after** content has landed is now recorded instead of silently forgotten. The dispatcher's silence sentinel is disarmed the moment response headers arrive (`onResponseStart`), so a body that goes quiet from there on fell into a gap where *no layer told the pool anything*: the adapter raised the watchdog and returned. The exit therefore kept its `ok` mark and its (low) latency — the front of the `pick` order — so the same exit kept winning the next request and could tear that one down too (user-visible as "the run suddenly stops mid-answer"). The adapter now reports it through `reportStreamFailure` (the same seam as `shouldRotate`), and the runtime reuses the pool's existing transport verdict via `createStreamFailureReporter` (`recordPassiveTransport` + `avoid` + `rerouteSession`). Nothing is replayed and no rotation happens — §3.4 never replays a partial stream — only the missing accounting is supplied, so §4.2's rule table now holds for mid-stream failures too.
- Free-lane chats no longer end on a transient `403 FreeTierError`. The lane refuses a request shape it accepted minutes earlier, so an attempt refused before any content is replayed once on the sibling host (`/inference` <-> `/zen`), inside the existing rotation cap. pi-ai takes the request URL from the model rather than the provider (`dist/api/openai-completions.js`: `baseURL: model.baseUrl`), so the replay swaps the model's base URL; a second provider moves nothing.
- The free-lane request follows the gate measured in #74, #75 and #78: `ZEN_BASE_URL` is `/inference`, `x-opencode-request` is no longer sent (any value is refused), `x-opencode-project` carries `global` rather than a `prj_` id, `x-opencode-session-id` repeats the session id, and the injected `bash`/`read` gate tools carry real schemas — an empty-schema shell of a gate name is replaced instead of counted as satisfied. The legacy sidecar's `upstream.zen` follows.
- The catalog now declares the real context window for `deepseek-v4.1-flash-free` — 200000 -> 1048576, needle-verified at 1,011,668 prompt tokens (#81), via the same `LOCAL_MODEL_OVERRIDES` mechanism as the #56 mimo fix.

### Removed

- Code with no production caller, found while auditing this path: `ExitPool.markStreamFailure` and `ExitPool.breakStickySession` (the latter a byte-identical duplicate of `rerouteSession`), `rotate.hasRotateDelegate`, and `PeriodicProber.setMaxPerRound` — plus the test that exercised `markStreamFailure` (it asserted passive counters for a method nothing called). `ExitPool.markDead` is also without a production caller — the pinned path applies `markProbeFailure`, not `markDead` — and is retained for API stability.

## 0.3.12 (2026-10-14)

### Fixed

- Free-lane chats stop failing with `API 密钥无效` / `403 FreeTierError` (#62, #65). The synthesized session id was **shape**-correct but **derivation**-wrong: `canonicalSessionID()` filled the 12 hex characters of its `ses_` id with `sha256("ses\0" + signal)`. Live probes (2026-10-13) show the free tier reads the low 12 bits of that field as a per-millisecond counter — `counter = ~hex & 0xfff` — and rejects anything outside `[0, 63]`; the high 36 clock bits are not checked at all (an id whose clock decodes to 1970 still passes). A digest lands in that window only ~1.5% of the time, so nearly every conversation 403'd while the id matched the canonical regex. Those characters now come from upstream's own generator (`packages/schema/src/identifier.ts`): `~(Date.now() * 0x1000 + counter)`, with `counter` pinned at 1 — which is why a real session's time segment ends in `ffe`. The conversation identity still comes from the digest, but only for the 14-character Base62 tail, so distinct conversations cannot collide and prompt-cache affinity survives. Sessions are memoized per conversation so a retry or a later turn reuses one id. Official `ses_` ids arriving from a real OpenCode client still pass through untouched.
- The model picker now refreshes when the live catalog or its capabilities change, including a Zen response arriving after the 4-second startup window (#59). Failed cold fetches expose an empty catalog with `error` status; a failed refresh of a populated catalog retains its last roster with `stale` status.
- The subscription Refresh now button now drives `scope: 'subscriptions'` (#63), waits for an ongoing round, and shows progress and upstream errors. Clearing URLs or disabling the pool stops the old fetcher. The configurable subscription User-Agent default is shared by host and browser.
- Upstream `403 FreeTierError` now retains its client restriction explanation as `FREE_TIER_RESTRICTED` instead of appearing as an invalid API key (#62). This failure remains non-retryable.
- Saved subscription URLs reach the runtime and remain visible when reopening settings (#60). Host and client share nested/legacy URL resolution, handling schema-injected empty arrays without hiding the saved value.
- Subscription User-Agent is configurable through `ipPool.subscription.userAgent`, applied on the next refresh. Empty values restore `clash-verge/v2.0`; the host and browser share one default and normalization rule (#60).

## 0.3.11 (2026-10-11)

### Fixed

- Anonymous free-lane chats survive the session-header gate that went live ~2026-10-09 (#56). Ablation probes against the live lane (2026-10-11) pin the gate to a canonical `ses_*` id in a session header (`x-opencode-session` / `x-session-affinity` / `X-Session-Id`, any one) — not the endpoint or the credential: `/zen/v1` + `Bearer public` + the canonical session the adapter already sends still answers 200, while `/inference/openai` 401s the Bearer. The one path that actually broke was the IP-pool admission smoke probe, which built its own request without the disguise headers; it now sends the full set. Also from the issue's live matrix: a `FREE_LANE_BLOCKLIST` denies the five models the lane can never serve (`exo-free` 410, `jev-1.13-free` SystemOne-only 400, `ling-3.0-flash-fin-free` 400, `muse-spark-1.*-contributor-free` 403 RegionError) ahead of any metadata or S3 vouch, in `list()` and `decision()` alike; and a `LOCAL_MODEL_OVERRIDES` table corrects models.dev's `mimo-v2.6-flash-free` context window (200000 → 1048576, per the MiMo card and the official CLI config). A `GATE_TOOL_ALIASES` seam (with `toolNameAlias` on `toStreamChunks`) stays ready for a future gate spelling that forces a wire alias such as `shell`.
- Cold boots no longer reject an explicit reasoning effort with `UNSUPPORTED_REASONING_EFFORT` when models.dev is slower than `warm()`'s window (#55). `refreshMetadata()` is now stale-while-revalidate: a fresh disk cache (< 7 days) loads as the capability baseline BEFORE the online fetch, so `reasoningCapability()`/`limits()`/`modalities()` answer immediately on a slow-but-healthy network (23s observed); the online answer still replaces the baseline when it lands, and the failure fallback is unchanged.

## 0.3.10 (2026-10-09)

### Fixed

- Tool results from DSH >= 0.2 hosts now land in the `toolResult` slot instead of being re-emitted as phantom `user` messages (#50). dsh-llm 0.2.0-rc.2's `createToolResultMessage` puts the call id on the message (`role: 'tool'`, `toolCallId`, `source.callId`) with plain content blocks and no `tool-result` wrapper, but `toPiContext()` only looked for wrapper blocks — so every tool result arrived as a new user message while no `toolResult` was ever sent, making models report "the tool returned nothing" (`No result provided`) and mistake tool output for user input. A message with no `tool-result` content blocks but a message-level call id now emits exactly one `toolResult` (never a user message); the wrapper-block path keeps precedence so DSH 0.1.x hosts — whose `isError` lives on the block — behave byte-identically. Reproduced and fixed-verified against the real dsh 0.2.0-rc.2 CLI with a control group (stock 0.3.9 reproduces the issue verbatim; the patched build returns the real stdout in the tool slot with no new user message).
- Free-lane 429 bursts are now ridden out silently instead of surfacing mid-conversation (#51). The adapter's `providerRetryPolicy` hook was returning `undefined`, deferring to the host default (5 retries over ~15s), which transient Zen quota windows (~60s, as measured by the IP pool's cooldown bookkeeping) outlasted — a live probe of the reporter's exact combo (`step-5-preview-free`, high effort) saw 5/8 requests immediately 429'd. The returned policy now runs 8 retries with 1s→20s backoff (~91s silent absorption per step, retries still executed — and cancellable — by the host, with the default retryable-code set so deterministic AUTH/REGION_BLOCKED failures are never retried). Live A/B on the same lane: unretryed baseline 5/8 ok, tuned policy 6/6 + 8/8 with bursts absorbed invisibly, stock-policy control stalled one request for 154s where the tuned spacing kept the worst request at 5.2s; real DSH 0.2.0-rc.2 headless e2e (3 sequential tool calls, high effort) completed cleanly.

## 0.3.9 (2026-10-08)

### Fixed

- Exit routing now restores the host's global dispatcher on disable and plugin unload. `install()` read the replaced dispatcher off `setGlobalDispatcher()`'s return value, which is `void` on undici 8.x, so the previous dispatcher was never saved and `disable()` left the `PoolRoutingDispatcher` installed process-wide: every later `fetch` — including unrelated providers' requests — kept routing through the plugin, failing with `routing dispatcher closed` after teardown, and only a process restart cleared it. The outgoing dispatcher is now captured with `getGlobalDispatcher()` before the swap, ours is destroyed before the previous one is reinstalled, a fresh undici `Agent` takes over when nothing was saved, and the "restored" log line only appears when a restore actually happened. The installer test fixture no longer models a `setGlobalDispatcher` that returns the replaced dispatcher (the fiction that hid this bug from the suite).

## 0.3.8 (2026-10-08)

### Fixed

- Manual `ipPool.manual` entries keep the scheme the settings card requires. Admission prefixed its own scheme onto an address that already carried one, so `http://host:port` built `http://http://host:port`, undici's `ProxyAgent` threw `InvalidArgumentError`, and the trusted-source fallback admitted the node with empty facts — the pool read healthy while exit IP, latency, quality and the geo/latency gates never ran for manual exits. Both admission call sites now reuse `exitProxyUri`, the guard the routing path already had, so the two paths cannot drift apart again.
- The model picker no longer sticks to the bootstrap list after a plugin (re)load. Registration-time `listModels()` answered from the 7-id static fallback whenever the client's first read beat the first Zen fetch, and the host caches that snapshot for its whole generation (delisted `mimo-v2.5-free` shown, live ids such as `exo-free` missing). `listModels()` is now async — the host contract already awaits it — and waits for the live catalog, bounded to 4 s so a dead network still answers promptly with the static list; concurrent warmups share `start()`'s in-flight first fetch.

## 0.3.7 (2026-10-04)

### Added

- The stream-liveness watchdogs are configurable. `firstEventMs`, `bodyIdleMs`, and `responsesBodyIdleMs` widen how long a turn waits for the first stream event and how much mid-response silence it tolerates, so a slow cold start no longer has to fail as `first stream event timeout` with no recourse. Unset, the shipped 30 s / 120 s / 300 s windows still apply.
- Add `mimo-v2.6-flash-free` to the static free-model fallback and IP-pool probe choices.

### Fixed

- Image input follows the model's declared modalities instead of a hardcoded
  family. models.dev publishes `modalities.input` per model, but it was never
  read, so every model outside `/^mimo-v2\.6/i` was advertised as text-only
  and DSH refused the attachment with `Model "…" does not support image input.`
  A model that declares `image` is now accepted, one that declares only `text`
  is still refused, and models.dev being pending, absent or silent leaves the
  verified family exactly as it was.

## 0.3.6 (2026-10-01)

### Fixed

- Retry a reasoning-only output-limit response once with thinking Off on models that expose Off. Keep streamed reasoning, sum both requests' usage, and assign fresh block indices. Responses that emitted text or any tool call, upstream failures, cancelled requests, and models without Off are not replayed.

## 0.3.5 (2026-09-30)

### Fixed

- Restore startup on DSH 0.1.7 and 0.2: the client no longer gates on the removed `settingsScope`; the host requires only `llm`. The server entry returns a valid Cordis effect.
- IP-pool configuration uses the served entry form on 0.1.7 and the installed plugin row on 0.2. Saves respect read-only forms, clear overrides when restoring inherited values, preserve older subscription URLs, and apply live. Late pool startup is disposed correctly on unload.
- Muse Spark 1.3 uses Responses for requests and history. Reasoning choices use the nested payload; default requests omit unsupported `none`/`off`. Responses free-lane gate tools use the flat function format and supported `auto` choice.
- Zen's regional 403 rejection is reported as `REGION_BLOCKED`, preserving the upstream explanation instead of making DSH display "API key is invalid". Model availability still depends on upstream regional policy.
- Add the missing `imageRequestPricing` method used by `/compact`.
- Read each model's context and output limits from models.dev, using the declared output budget instead of an extra 32768 ceiling. Invalid or missing limits retain the fallback.
- Windows agent shutdown handles `taskkill` failures and observes exit before starting shutdown. Tests use portable subscription fixtures.

### Added

- Image input for the verified MiMo v2.6 family. User/tool-result attachments are loaded from the harness store; offloaded images stay offloaded, missing files produce placeholders, and text-only models keep their existing capabilities.

## 0.3.3 (2026-09-18)

### Added

- **带推理的免费模型现在可以选择思考等级。** 在 DSH 的模型选择器中，推理模型
  （big-pickle、mimo-v2.5-free、nemotron 系、muse-spark 系等）会出现思考等级
  选项：模型元数据声明了档位的按声明展示（如 muse-spark 的 Minimal–Xhigh），
  其余推理模型提供 Off/Minimal/Low/Medium/High。选 Off 会向上游发送
  `reasoning_effort: "none"`——实测这是唯一能真正让"常思考"模型停止思考的传法
  （只省略该字段时上游保持默认继续思考）；选具体档位原样透传；不选则请求与
  旧版完全一致。非推理模型不出现该选项。

## 0.3.2 (2026-09-18)

### Fixed

- **免费模型全线恢复：修复 2026-09-17 起所有免费源报 `403 FreeTierError`
  （"free tier can only be used from within OpenCode"）的问题。** 经逐项探针
  实测，上游匿名免费通道现在有两道校验，缺一即拒：其一，会话头必须匹配
  OpenCode 官方客户端的会话格式（原先任意 `ses_` 开头的串即可）；其二，请求体
  必须是"智能体形态"——流式且 `tools` 里同时包含名为 `bash` 与 `read` 的
  function 工具（描述与参数不查；纯聊天请求没有工具，故此前全部被拒）。
  插件现在把会话标识确定性映射成官方格式（同一对话仍映射到同一会话，会话
  亲和不受影响），并在发往上游的请求体缺失这两个工具时注入最小桩工具（纯
  聊天附带 `tool_choice: "none"`，模型不会真的调用它们）；免费源准入冒烟
  探测同步改为流式并携带桩工具。

## 0.3.1 (2026-09-11)

### Fixed

- **旧版 DSH 上插件加载失败的问题（用户反馈 `list slot "settings.plugin.item" requires options.id`）。**
  `settings.plugin.item` 槽位在 DSH 0.1.0-rc.7 起由 list（按 `id` 注册）改为 keyed
  （按 `key` 注册）；0.3.0 的设置页卡片按新版 keyed 形态注册，在旧版 DSH
  （≤ 0.1.0-rc.6）上会让整个插件加载失败、启动页报错。现在卡片注册前会探测宿主
  声明的槽位类型，按对应形态注册，两边都能用；即便宿主行为异常，注册失败也只
  跳过设置卡片（控制台警告提示升级 DSH），模型路由不再被拖垮。

## 0.3.0 (2026-09-09)

The release where the IP pool actually works.

### Fixed

- **模型流量现在真正经过 IP 池。** 此前 Node 内置 fetch 与插件所用 undici
  是两个隔离实例，池开启后模型请求仍然直连、路由从未生效。现在开启
  IP 池后模型流量会真实走池中出口。
- **卡死回合不会再挂住整个会话。** 请求遇到出口无响应时会在超时后
  自动换出口重试或如实报错，不再无限等待。
- **慢响应的正常请求不再被误判为坏出口。** 响应哨兵改为双窗口：
  连接阶段 2 秒严格判定死出口，隧道建立后等待响应头放宽到 10 秒，
  避免误杀慢首包的健康流。
- **上游 5xx 不再连带惩罚出口。** 模型自身报错（如权限不足的模型对
  所有人返回 500）不会再把出口标记为失效导致全部流量静默直连。
- **免费源准入恢复正常。** 上游现在要求会话伪装头，探测请求已同步
  补齐；此前免费源候选全部被误拒。
- **池首次攒到出口后自动启用路由**，无需再手动改一次设置来触发。

### Added

- **免费代理源从 26 个扩展到 48 个**，全部逐个实测可用后接入，每轮
  候选量约提升 75%。

## 0.2.7 (2026-09-05)

IP 池发布（IP-0 … IP-7）：出口池与两级健康度、粘性会话路由调度器、
订阅源（含 sing-box 加密节点转换）、设置页热更新、真实流量的被动健康
统计、全量粗筛、适配器层轮换重试、响应静默哨兵、探测模型下拉选择。

## 0.2.6

免费模型目录修复：元数据弃用优先于免费名回退；marketplace 条目指向
可安装的仓库根。
