# Changelog

## Unreleased

### Fixed

- The adapter now reads the transcript shape off the installed `@earendil-works/pi-ai` instead of assuming one, so it emits the shape that pi-ai actually reads on any version in the declared range. From 0.86.0 on, pi-ai reads the prompt and the tool set off a leading `role: 'system'` message and reads neither `Context.systemPrompt` nor `Context.tools`; below it, those two context fields are the only place it looks. Which of the two shapes is correct therefore depends entirely on the version a profile happens to resolve, and this removes the dependency on that being right.
- A `@earendil-works/pi-ai` that fails to load now raises `PiAiShapeUnknownError` from the transcript-shape probe. The two shapes fail in opposite ways, one dropping the prompt and the tool set silently and one throwing inside pi-ai's token estimator, so a missing dependency is surfaced instead of guessed in favour of either.
- `scripts/sweep-all-pi-ai.mjs` and `scripts/repro-pi-ai-hoisting.mjs` reproduce the shape and hoisting measurements behind the probe. Both take a pnpm path as an argument and want network; they are measurement scripts, not tests.

- Selecting the `off` effort level no longer fails the request. The Zen gateway accepts `minimal|low|medium|high|xhigh|max` and answers a hard 400 to both `none` and `off`, so there is no wire spelling for "do not think" and the field is now omitted instead. This is the path the max-tokens recovery retry takes when a turn stops on reasoning alone, which means that retry could not succeed before.

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
