# opencode2dsh：DSH 免登录接入 OpenCode 免费模型 — 架构设计

> 状态：架构设计 v1（2026-02-05）。实现前定稿文档；所有 `文件:行号` 锚点均针对 opencode2api 源码（本地克隆位于 `C:\Users\FishBottle\AppData\Local\Temp\opencode\opencode2api\`，Go 1.24，`package main` 单包）逐一核实过，可直接作为移植依据。
> 关联项目：`D:\codes\dshPlugins\cc-migrate`（同为 DSH 生态插件，本文档风格与其 `docs/design.md` 对齐）。

## 1. 定位（一句话）

opencode2dsh 是一个 **DSH cordis 插件**：它在 DSH 进程旁拉起一台**单租户、匿名通道专用**的本地 Go 代理（移植自 opencode2api），把 OpenCode Zen 的「匿名免费模型」（`Authorization: Bearer public`）包装成一个标准的 OpenAI 兼容 provider 端点，使 DSH 无需任何 key、无需登录即可调用 `https://opencode.ai/zen` 上标记为免费的模型。

**改名/定位说明**：原项目 opencode2api 是「多租户、多 key、带 WebUI 的通用网关」；opencode2dsh 取其匿名链路子集，收缩为「DSH 专用的单用户本地桥」。产品语义是"接入 OpenCode 官方提供的免费匿名通道"，不是"绕过付费"。

## 2. 总体架构

### 2.1 架构图

```
┌───────────────────────────────────────────────────────────────────┐
│ DSH 主进程 (Node.js)                                               │
│                                                                   │
│  ┌──────────────┐   baseURL=http://127.0.0.1:<port>/v1            │
│  │ DSH 模型网关  │──────────────────────────────┐                  │
│  │ (OpenAI 协议) │   Authorization: Bearer <local-token>           │
│  └──────────────┘                              │                  │
│  ┌──────────────────────────────┐              │                  │
│  │ opencode2dsh cordis 插件      │              │                  │
│  │  · 配置/端口/token 管理        │              │                  │
│  │  · child_process 拉起/看护     │              │                  │
│  │  · 模型清单注入 DSH provider   │              │                  │
│  └──────────────┬───────────────┘              │                  │
└─────────────────┼──────────────────────────────┼──────────────────┘
                  │ spawn (stdout/stderr 管道)    │ HTTP (loopback only)
                  ▼                              ▼
        ┌─────────────────────────────────────────────┐
        │ opencode2dsh-agent (Go 二进制, 独立进程)        │
        │  · GET /v1/models   POST /v1/chat/completions│
        │  · GET /healthz                              │
        │  · 匿名判定 (models.dev + 名称含 free)          │
        │  · 请求头伪装 + session/request id 派生          │
        │  · SSE 流式透传/互转                            │
        │  · (可选, 默认关) proxy 池 + 按 IP 冷却            │
        └──────────────────┬──────────────────────────┘
                           │ HTTPS
                           ▼
              https://opencode.ai/zen/v1/...
              (Authorization: Bearer public
               + x-opencode-client: cli 等)
```

要点：

- **进程边界**：Go 代理是独立 OS 进程，由 DSH 插件以 `child_process.spawn` 拉起、以管道采集日志、以信号/kill 回收（§8）。
- **协议面**：对 DSH 只暴露 OpenAI Chat Completions 一个协议面（`POST /v1/chat/completions`、`GET /v1/models`、`GET /healthz`）；对上游同样走 Zen 的 Chat 端点。Anthropic/Responses 协议保留接口但 Phase 0-3 不启用（§6.3）。
- **监听面**：仅绑定 `127.0.0.1`（回环），并要求本地随机 token（§7）。

### 2.2 设计决策 D1：DSH 集成方式 — 本地 HTTP 端口 + 插件拉起（而非纯进程内嵌入式 HTTP handler，而非用户手动 sidecar）

三个候选：

| 方案 | 描述 | 结论 |
| --- | --- | --- |
| A. 纯进程内 | 用 Node/TS 在 DSH 插件内重写整个代理 | 否决：三协议互转 + SSE 流互转 + 池管理约 4000 行 Go 代码，重写引入等价性风险（见 D2） |
| B. Go 以内嵌方式编译进 Node（cgo/FFI/napi） | 把 Go 代理做成共享库由 Node 加载 | 否决：`net/http` 服务型代码与 FFI 生命周期管理复杂；崩溃会连带 DSH 主进程；跨平台构建矩阵（Windows/macOS/Linux × x64/arm64）成本高 |
| C. 独立 sidecar 子进程，由插件拉起 | Go 静态二进制，插件 spawn + 看护，DSH provider 的 `baseURL` 指向 `http://127.0.0.1:<port>` | **采纳** |

采纳 C 的理由：

1. **复用最大化**：opencode2api 的 `gateway.go`/`convert.go`/`stream.go`/`pool.go`/`ids.go`/`models.go`/`model_metadata.go` 全部为标准库实现（唯一第三方依赖 `golang.org/x/crypto` 仅被不移植的 `password.go` 使用，见 §5），以独立进程形态几乎原样运行。
2. **故障隔离**：代理崩溃/挂死不影响 DSH 主进程；插件可检测退出并重启，可设崩溃计数熔断。
3. **生命周期可控**：插件（cordis）天然有 start/stop 生命周期钩子，与 sidecar 的启停一一对应；DSH 升级/重载插件时回收子进程。
4. **协议解耦**：DSH 侧只看到标准 OpenAI 兼容端点，未来若改用别的免费上游（或上游改协议），只需换 sidecar，不动 DSH 集成层。
5. **与 opencode2api 演进兼容**：上游 opencode2api 还在活跃开发，sidecar 形态可以低成本的 rebase 方式跟进上游修复。

代价：多一个进程与一个本地端口、需要跨平台二进制分发（§8.4）。这与收益相比可接受。

### 2.3 设计决策 D2：Go 而非 JS/TS — 复用 opencode2api

opencode2api 的核心价值在于**三协议（Chat / Responses / Anthropic）请求、非流式响应、SSE 流式响应的全量互转**（`convert.go` 1858 行 + `stream.go` 1109 行），以及**匿名池按 IP 冷却**的工程细节（`pool.go`）。这些逻辑：

- 语义等价重写（TS 版）需要逐行翻译并补测试，估计工作量是移植版 3-5 倍，且流式互转的对齐细节（usage 归并、tool call 分片、reasoning 签名透传）极易出错；
- Go 版只需**裁剪**（删 WebUI/admin/password/多实例热重载）而无需重写；
- Go 交叉编译产物为无依赖静态二进制，分发简单（§8.4）。

结论：**Go**。Node 侧只做进程管理与配置传递（§8）。

### 2.4 匿名链路时序（一次 chat 请求）

```
DSH                opencode2dsh-agent (Go)                opencode.ai/zen
 │                       │                                    │
 │ POST /v1/chat/completions                                  │
 │ Authorization: Bearer <local-token>                        │
 │ {model:"gpt-oss-120b", messages:[...], stream:true}        │
 │──────────────────────►│                                    │
 │                       │ authenticate() 常量时间比对           │
 │                       │ deriveRequestIDs()                  │
 │                       │  · session = sha256("ses\0"+signal) │
 │                       │  · signal = 入站 x-opencode-session │
 │                       │    或首条 user 消息内容(会话亲和)      │
 │                       │ anonymousDecision(model)            │
 │                       │  · models.dev: cost=0 且未 deprecated│
 │                       │  · 或 id 含 "free" (名称兜底)         │
 │                       │ Route() → {Tier:zen, Anonymous:true}│
 │                       │ newUpstreamRequest()                │
 │                       │───────────────────────────────────►│
 │                       │ POST https://opencode.ai/zen/v1/chat/completions
 │                       │ Content-Type: application/json
 │                       │ Accept: application/json, text/event-stream
 │                       │ User-Agent: opencode/1.18.21 (<goos> <goarch>; <goversion>)
 │                       │ x-opencode-client: cli
 │                       │ x-opencode-session: ses_<24hex>
 │                       │ x-session-affinity: ses_<24hex>
 │                       │ X-Session-Id: ses_<24hex>
 │                       │ x-opencode-request: req_<32hex>
 │                       │ x-opencode-project: prj_<24hex>
 │                       │ Authorization: Bearer public        ← 匿名凭证
 │                       │                                    │
 │                       │      ◄──── 200 text/event-stream ──│
 │                       │ (协议相同时 SSE 原样透传;              │
 │  ◄────────────────────│  usage 经 observer 旁路统计)          │
 │  200 text/event-stream│                                    │
```

对应实现锚点：

| 步骤 | 函数 | 锚点 |
| --- | --- | --- |
| 本地鉴权 | `Gateway.authenticate` | gateway.go:170-194（`x-api-key` 或 `Authorization: Bearer`，`crypto/subtle.ConstantTimeCompare`） |
| 请求体与模型校验 | `Gateway.handleInference` | gateway.go:212-249（`maxRequestBody = 32MiB` @ gateway.go:18） |
| id 派生 | `deriveRequestIDs` | ids.go:21-57；`conversationSeed` ids.go:59-76（首条 user 消息 JSON 作信号 → 多轮会话稳定）；`stableID`/`randomID` ids.go:78-89 |
| 入口路由 | `modelCatalog.Route` | models.go:173-191（匿名恒走 Zen 层；被拒后进入认证 key 回退，opencode2dsh 无 key 时回退为空） |
| 免费判定 | `anonymousDecision` → `modelMetadataStore.Decide` | models.go:253-258；model_metadata.go:192-237（`!deprecated && input==0 && output==0`；`isFreeModel` 名称含 `free` 兜底，models.go:303-305） |
| 上游请求构造 | `newUpstreamRequest` | gateway.go:640-669（全部请求头注入；Chat 走 `Authorization: Bearer <key>`，key=`"public"`，常量 `anonymousZenKey` @ gateway.go:20） |
| 匿名尝试 | `Gateway.doAnonymousUpstream` | gateway.go:424-483（逐 proxy 尝试至多一轮；仅 2xx 结束） |
| 上游端点 | `UpstreamConfig.Zen` 默认值 | config.go:85：`https://opencode.ai/zen`；路径拼接 `protocolPath` gateway.go:789-798（Chat → `/v1/chat/completions`） |
| 流式回传 | 协议相同则透传 | gateway.go:291-298：`io.Copy(w, TeeReader(resp.Body, observer))`；协议不同才 `transcodeStreamWithUsage`（stream.go:49） |
| 非流式回传 | 协议相同时原样 | gateway.go:307-325 |

## 3. 上游契约（OpenCode Zen 匿名通道）

事实陈述（已在 opencode2api 源码与 OpenCode 仓库交叉核实）：

1. **凭证**：匿名请求使用字面量 `Authorization: Bearer public`（gateway.go:20 `anonymousZenKey = "public"`；gateway.go:448 以它构造上游请求）。无需注册、无需 key。
2. **模型白名单**：OpenCode 服务端在模型 schema 上有 `allowAnonymous` 标记（opencode 仓库 `packages/console/core/src/model.ts:28`），仅带标记的模型能从 `Bearer public` 命中；客户端侧无法枚举该标记，只能靠 models.dev 成本数据 + 名称启发式**逼近**（§4）。
3. **计费语义**：匿名请求的账单来源标记为 `anonymous`，不产生扣费。opencode2dsh 不配置任何认证 key，因此 `doUpstream` 的认证回退分支（gateway.go:390-410）恒为空 —— 匿名失败就是失败，不做付费降级。
4. **限流**：OpenCode 对匿名请求按**出口 IP** 限流，阈值在平台侧 Secret 配置，公开仓库不可见。表现为 401/403/429 或 5xx。opencode2dsh 的应对见 §9；**必须诚实表述为「匿名配额受上游限流」，任何多 IP 轮换能力默认关闭且仅限自部署场景**（§9.2）。

## 4. 免费模型列表策略

### 4.1 三源合并

| 优先级 | 来源 | 内容 | 刷新 |
| --- | --- | --- | --- |
| S1 动态主源 | `GET https://opencode.ai/zen/v1/models`（`Authorization: Bearer public`，models.go:587-618 `fetchModels`） | Zen 上当前在售模型全集（含免费与付费，**不含 allowAnonymous 标记**） | 默认 300s（复用 `models.refresh_seconds`） |
| S2 免费判定 | `GET https://models.dev/api.json`（model_metadata.go:21 `modelsDevDefaultURL`，24h 刷新，带磁盘缓存 `config.json.models.dev.json`） | 每模型 `input_cost`/`output_cost`/`deprecated` → `Decide()` 判定免费 | 24h + 启动时读缓存 |
| S3 静态兜底 | 编译期嵌入的模型清单（Go 常量表） | 已知可用匿名模型 id 列表（以 Phase 0 实测为准填充；预置 `gpt-oss-120b`、`gpt-oss-20b`、`deepseek-v4-flash`、`qwen3-coder-480b` 等，**以实测为准，交付前校准**） | 随版本发布更新 |

判定逻辑（`modelMetadataStore.Decide`，model_metadata.go:192-237）：

```
Allowed = isFreeModel(id)                       // 名称含 "free"，模型缺失/元数据未就绪时的唯一兜底
       OR (!deprecated && input_cost==0 && output_cost==0)   // 元数据就绪且已知
```

`/v1/models` 端点输出 = S1 ∩ S2（或 S2 未就绪时 S1 ∩ S3），即：**在售 ∧ 判定为免费**才对外暴露（gateway.go:196-210 `handleModels` 已实现该过滤）。

### 4.2 失败回退链

```
S1 失败  → 用上一次成功的 S1 结果（catalog 内存态）
S1 从未成功 → 用 S3 静态清单启动（catalog 初始为空 = 「pending」，放行全部 id，
              对应 models.go:358-384 supportedLocked 的 catalogPending 分支）
S2 失败  → Decide 退化为名称兜底 isFreeModel（models.go:257 Source="name_fallback_metadata_pending"）
S2+S1 均失败 → /v1/models 返回 S3 静态清单（保证 DSH 至少有一个可用 provider 模型列表）
```

S3 静态清单中的每个 id 在 Phase 0 必须经过实测（匿名 chat 成功）才允许进入默认表；无法实测的条目放入注释掉的候选区。

## 5. 复用审计表（来源 → 去处）

opencode2dsh 的 Go 部分命名 `opencode2dsh-agent`，Go module 采用 `cmd/agent` + `internal/*` 布局（见 §10），子包划分见下表「去处」列。下表「处置」列：**移植** = 拷贝后裁剪；**精简移植** = 保留骨架删分支；**不移植** = 留在上游。

| 来源文件（opencode2api） | 复用内容（锚点） | 去处（opencode2dsh-agent） | 处置 |
| --- | --- | --- | --- |
| `ids.go`（102 行，整文件） | `deriveRequestIDs`/`conversationSeed`/`stableID`/`randomID`/`opencodeUserAgent` | `internal/ids` | **原样移植**（零改动；仅随包移动） |
| `models.go` | `isFreeModel`(303-305)、`anonymousDecision`(253-258)、`fetchModels`(587-618)、`modelCatalog.Route` 匿名分支(173-191) | `internal/catalog` | **精简移植**：删 Go tier（TierGo）、docs 正则抓取（`fetchProtocolDocs`/`protocolDocEndpointPattern`，models.go:31,508-554）、认证 keyTierOrder；保留 Zen 单层 + 匿名分支 + 静态兜底清单合并 |
| `model_metadata.go` | `modelMetadataStore` 全套：models.dev 拉取(165-183)、磁盘缓存(149-153)、`Decide`(192-237)、`AnonymousDecision` 结构(33-40) | `internal/catalog`（metadata 子模块） | **移植**（删 proxy clientProvider，直连即可） |
| `convert.go` | `convertRequest`(95)、`prepareUpstreamRequest`(111)、bridge 中间表示(19-93) | `internal/convert` | **裁剪移植**：Phase 0-3 仅保留 Chat↔Chat 恒等路径 + 骨架；Responses/Anthropic 编解码函数(723-884, 935-1276)以接口占位，不接线 |
| `stream.go` | `transcodeStreamWithUsage`(49)、`bridgeStreamParser`(33-42) | `internal/convert` | **裁剪移植**：同上；Chat 透传路径（gateway.go:291-295 的 `TeeReader` + observer）已覆盖 DSH 需求，互转仅保留接口 |
| `pool.go` | `transportPool`(29-148, 150-178)、`anonymousPool`/`anonymousCursor`/`MarkFailure` 指数冷却+Retry-After(33-127)、`isProxyFailure`(244-253)、`nodePool`/`upstreamNode`（key 节点，opencode2dsh 不用 key 但保留 direct 节点语义） | `internal/pool` | **精简移植**：默认 `proxies=["direct"]` 单节点；proxy 池多节点代码保留但仅在显式配置时激活（§9.2）；`nodePool` 的 key 机制删除 |
| `gateway.go` | `anonymousZenKey`(20)、`Handler()` 路由(98-106)、`authenticate`(170-194)、`handleInference` 骨架(212-327)、`doAnonymousUpstream`(424-483)、`newUpstreamRequest`(640-669)、`protocolPath`(789-798)、`writeAPIError`/`copyErrorResponse`(920-943)、`recoveryMiddleware`(955-965) | `internal/gateway` | **精简移植**：删 `doKeyUpstream`(485-572) 与 KeyTiers 回退、删 zen/go 双池（保留 zen 单池语义）、删 WebUI/admin 监控钩子（`Monitor` 调用点改为 slog） |
| `config.go` | `Config` 结构(17-34)、默认值(83-92)、`NormalizeConfig`(106-191)、`stripJSONComments`(220-283)、`SaveConfigAtomic`(311-362) | `internal/config` | **精简移植**：默认值改为 `listen=127.0.0.1:0`（随机端口，§8.2）、`anonymous=true`、无 server key 时自动生成、`prefer` 字段删除；**校验规则调整**：`NormalizeConfig` 现行校验本就允许 `anonymous=true && zen_keys=[]`（config.go:131-133），仅需把「server_keys 至少一个」保留（opencode2dsh 启动时自动生成随机 token 满足） |
| `observability.go` | `recoveryMiddleware` 依赖、结构化 slog、SSE 编码 `encodeSSE`(903)（stream 互转用） | `internal/obs` 或并入 gateway | **精简移植**：删 LogHub/SecretRedactor 环形缓冲（子进程日志经管道交给插件）；`encodeSSE` 随 stream 移植 |
| `main.go` | 启动/信号/优雅退出骨架(16-73) | `cmd/agent/main.go` | **重写**：删 WebUI/runtime 多实例；加 `--config` 与 `--print-ready`（见 §8.2） |
| `runtime.go` | 热重载、多实例管理 | — | **不移植**（DSH 单实例，配置变更 = 重启子进程） |
| `admin.go` + `webui/` | 管理 API、Web UI | — | **不移植** |
| `password.go` | argon2 口令哈希（`golang.org/x/crypto` 唯一使用点，password.go:12） | — | **不移植**；移除后 go.mod 第三方依赖清零，仅标准库 |

裁剪后规模估计：Go 侧 ~2500-3000 行（原 ~8000 行），且**零第三方依赖**（go.mod 只剩 `module` + `go` 指令），单文件静态二进制约 8-10 MB。

## 6. 对 DSH 暴露的接口

### 6.1 端点

| 方法/路径 | 行为 | 对应上游 |
| --- | --- | --- |
| `GET /v1/models` | 本地鉴权后返回免费模型清单（§4） | S1/S2/S3 合并 |
| `POST /v1/chat/completions` | 本地鉴权 → 匿名转发（流式/非流式均支持） | `POST https://opencode.ai/zen/v1/chat/completions` |
| `GET /healthz` | 无需鉴权；`{"status","ready","version","models":{...},"anonymous":true}`；模型目录 pending/stale/empty、无健康出口时降级（移植 gateway.go:108-168） | — |

`/v1/responses`、`/v1/messages` 不注册（对应 gateway.go:102-103 两行不移植）。

### 6.2 错误映射

| 场景 | 代理返回 | 说明 |
| --- | --- | --- |
| 本地 token 错误 | `401` OpenAI 错误体（gateway.go:189 同型） | DSH 配置错 token |
| 模型非免费/未知 | `400 invalid_request_error`（gateway.go:233-241 同型） | DSH 不应再请求该模型 |
| 上游匿名被拒（401/403/429/5xx，重试耗尽） | 上游状态码与消息透传（`copyErrorResponse` gateway.go:920-931，透传 `Retry-After`）+ `x-request-id` | **限流的诚实信号**：DSH 侧应显示「匿名配额受限，稍后再试」，不静默重试轰炸 |
| 传输失败（所有出口） | `502 upstream_error`（gateway.go:265 同型） | 断网/代理全挂 |
| 目录未就绪 | `503`（healthz `status:"starting"`） | 仅 healthz；推理端点直接尝试 |

### 6.3 协议面收敛的理由

DSH 的模型网关以 OpenAI Chat 协议请求 provider（cc-migrate 调研确认 DSH provider 走标准 OpenAI 兼容面）。Zen 匿名通道的原生协议即 Chat（`protocolForSDK` 对 openai-compatible SDK 判 Chat，models.go:574-575）。因此 Phase 0-3 全链路**Chat-in/Chat-out，零转换**，convert/stream 的跨协议代码只保留接口占位。这不损失后续扩展性：若未来某免费模型在 Zen 上仅暴露 Anthropic 协议，启用对应转换路径即可（代码已在裁剪保留清单内）。

## 7. 鉴权设计（本地）

- **默认启用**：插件首次启动生成 32 字节随机 token（`crypto.randomBytes(32).toString('base64url')`），写入插件数据目录（0600），以 `--server-key <token>` 或配置文件传给子进程；DSH provider 配置同一 token 作为 API key。opencode2api 的 `authenticate`（gateway.go:170-194）原样提供该能力（`x-api-key` 与 `Authorization: Bearer` 双通道、常量时间比对）。
- **理由**：监听 127.0.0.1 不等于只有 DSH 能连 —— 本机任意进程都可连回环端口。免费模型虽无资金风险，但无鉴权端口会被本机其他进程白嫖配额，把 DSH 自己挤出限流窗口。
- **可去**：提供 `auth: false` 开关（`server_keys=[]` + 跳过鉴权），供调试；默认文档不推荐。
- **不暴露公网**：config 校验强制 listen 地址主机部分为 `127.0.0.1`/`localhost`（移植时在 `NormalizeConfig` 加此校验；原版允许任意地址，用于容器部署，opencode2dsh 不需要）。

## 8. Go 二进制在 DSH（Node/cordis 插件）中的生命周期

### 8.1 进程拓扑

```
cordis 插件 service 工厂
  ├─ resolveConfig(): 端口(默认 0=随机)、token(生成/读取)、上游端点、代理开关
  ├─ spawn(agentPath, ["--config", cfgPath], {stdio:['ignore','pipe','pipe']})
  ├─ 等 readiness：轮询 GET /healthz 直到 200（上限 10s）
  ├─ 注销时：child.kill(SIGTERM) → 5s 宽限 → SIGKILL；Windows 走 taskkill /T /PID
  └─ 崩溃看护：exit 事件 → 指数退避重启（1s/2s/4s…上限 60s）；连续 5 次失败熔断并报错给 DSH 日志
```

### 8.2 端口与发现

- 子进程 `--listen 127.0.0.1:0`（随机端口）。**采用方案**：为 agent 增加 `--print-ready` 模式 —— 监听成功后向 stdout 写一行 `READY {"port":<port>,"version":"..."}`，插件读取该行即得端口（避免轮询猜测）。这是对 opencode2api 的一处**新增**（约 20 行），在 plan.md Phase 1 验收。
- 插件再把 `http://127.0.0.1:<port>/v1` 写入 DSH provider 配置，模型清单经 `GET /v1/models` 拉取（插件启动时与定时刷新时各一次，向 DSH 动态注册模型）。

### 8.3 配置传递

子进程配置用 **JSON 文件**而非环境变量/命令行（可注释、可审计、与 opencode2api 的 `LoadConfig`/`stripJSONComments`（config.go:74-102, 220-283）直接兼容）。插件每次启动生成：

```jsonc
{
  "listen": "127.0.0.1:0",
  "server_keys": ["<random token>"],
  "anonymous": true,
  "zen_keys": [], "go_keys": [],          // 恒空：opencode2dsh 不做认证通道
  "upstream": { "zen": "https://opencode.ai/zen" },
  "models": { "refresh_seconds": 300 },
  "retry": { "max_attempts": 2, "timeout_seconds": 300 },
  "proxies": ["direct"],                   // 多代理仅当用户显式配置
  "logging": { "level": "info" }
}
```

文件落在 `<插件数据目录>/agent-config.json`（同目录兼作 models.dev 缓存位置）。

### 8.4 二进制分发

| 平台 | 产物 | 获取方式 |
| --- | --- | --- |
| windows-x64 / darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 | `opencode2dsh-agent-<os>-<arch>(.exe)`，`CGO_ENABLED=0` 静态编译 | ① 预编译产物随 npm 包 `optionalDependencies` 分发（每平台一个可选子包，装包时按 `os`/`cpu` 命中）；② 兜底：本机检测到 Go ≥1.24 时 `go build` 现场编译（dev 场景） |

Go 交叉编译矩阵一条命令即可产出（`GOOS=… GOARCH=… go build`），CI 一键生成全部 5 个产物。

### 8.5 为什么不在 Node 里做（tradeoff 复述）

Node 方案（重写或 napi 封装）的对比已在 D1/D2 给出。补充一点：**SSE 透传**在 Node 里是 `fetch` + `ReadableStream`，实现简单，但 opencode2api 的价值在**多协议互转与池管理**；只透传的话匿名判定、冷却、错误映射都要重做。Node 方案唯一胜出场景是「绝不接受二进制分发」的约束 —— 若 DSH 插件市场禁止分发原生二进制，则降级为「要求用户自装 Go 并现场编译」，作为 plan.md 的显式风险项（R2）。

## 9. 限流、配额与灰色边界（诚实声明）

### 9.1 正常路径

- 匿名配额按出口 IP 计，阈值平台侧配置、不可枚举。单用户单 IP 的正常 DSH 使用（人机交互频率）通常不触顶；触发时上游返回 401/403/429/5xx，代理透传给 DSH 显示（§6.2）。
- 代理内置重试仅针对**传输失败**与 5xx（`isNonRetryableClientResponse` gateway.go:671-673 排除 401/403/429；匿名池 `MarkFailure` pool.go:112-127 对这三类指数冷却），不做激进重试轰炸。

### 9.2 多出口 IP（灰色能力）的产品化收缩

opencode2api 的 `anonymousPool` + proxy 池支持「429 → 换出口 IP 再试」（pool.go:36 注释明确其动机：Zen 按 IP 限流匿名节点）。**本项目对此诚实定性：这是灰色绕过能力**。处置：

1. **默认关闭**：`proxies=["direct"]`，单出口；配置文件不出现任何代理 URL。
2. **仅自部署**：多代理配置只对从源码自行构建的用户生效（npm 分发包不携带代理配置样例，README 不宣传该能力）。
3. **代码保留但收缩**：`anonymousPool` 冷却逻辑保留（它同时是单出口下「冷却退避」的正当实现——`MarkFailure` 对 direct 节点同样生效，等价于失败退避），但删除 `doAnonymousUpstream` 中「尝试完一轮 proxy 后再进入认证 key 层」的多层语义（opencode2dsh 无 key，天然只剩一层）。
4. **文档立场**：design.md 与 README 均写明「匿名配额受上游限流；opencode2dsh 不提供、不鼓励任何绕过限流的方式」。

### 9.3 合规口径

OpenCode 官方提供匿名免费通道（`allowAnonymous` 模型 + `Bearer public`），opencode2dsh 只是**以官方客户端相同的方式（CLI 同款请求头）使用官方开放通道**，无破解、无凭证伪造。风险点仅在频控，处理见 §9.1-9.2。

## 10. 目录结构

```
opencode2dsh/
├── docs/
│   ├── design.md                 # 本文
│   └── plan.md                   # 实施计划
├── agent/                        # Go module（单 module，cmd+internal 布局）
│   ├── go.mod                    # module opencode2dsh/agent; go 1.24; 零第三方依赖
│   ├── cmd/agent/
│   │   └── main.go               # 启动/信号/--listen/--print-ready（移植 main.go 骨架）
│   └── internal/
│       ├── ids/                  # ids.go 整体（§5 行1）
│       ├── config/               # config.go 精简（§5 行8）
│       ├── catalog/              # models.go 精简 + model_metadata.go + 静态兜底清单
│       │   └── static_models.go  # S3 清单（编译期常量）
│       ├── convert/              # convert.go/stream.go 裁剪（Chat 恒等 + 接口占位）
│       ├── pool/                 # pool.go 精简（transportPool + anonymousPool）
│       ├── gateway/              # gateway.go 精简（路由/鉴权/匿名上游/错误映射）
│       └── obs/                  # slog 装配、recoveryMiddleware、encodeSSE
├── packages/
│   └── plugin/                   # DSH cordis 插件（Node/TS）
│       ├── package.json
│       ├── src/
│       │   ├── index.ts          # cordis 插件入口：service 工厂 + 生命周期
│       │   ├── agent-process.ts  # spawn/看护/READY 握手（§8.1-8.2）
│       │   ├── config.ts         # 生成 agent-config.json、token 管理
│       │   └── provider.ts       # 向 DSH 注册 provider：baseURL/token/模型清单刷新
│       └── test/
├── packages/agent-bin-win32-x64/ # 预编译分发子包（optionalDependencies，其余平台同构）
│   └── ...
└── README.md
```

包间关系：`packages/plugin` 通过 `optionalDependencies` 依赖 `agent-bin-*`，启动时按 `process.platform/process.arch` 定位二进制（或 `agent/` 源码 + 本机 Go 现场编译兜底）。

## 11. 风险与开放问题

| # | 风险/问题 | 处置 |
| --- | --- | --- |
| R1 | OpenCode 调整匿名通道（改凭证/缩白名单/取消） | S1 动态目录 + healthz `degraded` 让故障可见；README 明示该依赖关系。代码上把 `anonymousZenKey` 与上游 URL 收敛为单一常量便于跟进 |
| R2 | 插件分发环境禁止原生二进制 | 兜底链：预编译包 → 本机 Go 编译 → 明确报错并给编译指引（§8.4） |
| R3 | models.dev 判定与上游 `allowAnonymous` 不一致（判定免费但上游拒绝） | 400/403 透传给 DSH（§6.2），DSH 可切换模型；S3 清单只收录实测通过条目，降低误报面 |
| R4 | 端口冲突/防火墙 | 随机端口（`127.0.0.1:0`）为主；回环监听通常不受出站防火墙影响 |
| R5 | 上游 SSE 语义变化 | Phase 0 验收含流式用例；`TeeReader` 透传路径对上游变化最不敏感（不做转换） |
| 开放 Q1 | DSH provider 注册 API 的确切形态（静态配置 or 插件动态注入模型清单） | Phase 1 第一步核实 DSH 侧 provider 配置协议后再定 provider.ts 的实现方式；不影响 agent 设计 |
