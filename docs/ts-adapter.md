# opencode2dsh 纯 TS adapter 版 — 实施计划

> 状态：v2（2026-08-29）。**定位定案：插件市场只上 TS 版；Go sidecar 不分发，保留在仓库作语义参照与上游变更时的对照实现。**
> 本档回答「TS 版是否真的简单」：是，但原因不是逻辑少，而是**壳消失 + 协议已验证 + 目录逻辑有现成参照**。
> 所有行数为估计值，用于排期不用于承诺。决策：直接做**完整版（full）**，T0 探针仍执行（其结果决定 SSE 用 pi-ai 复用还是自实现，影响 1.3 的工作量，但不改变 full 版路线）。

## 0. 为什么 TS 版比 Go 版工作量小一个量级

Go 版慢在「保真移植 8300 行里的每一段语义」。TS 版不走移植，走「新写最短链路」，三个前提已成立：

1. **协议面已实测固化**：伪装头（7 个）、session/request id 派生（ids.go 94 行）、`Bearer public`、SSE 帧格式——全部由 Go 版在真实上游验证过，照抄行为，不再抓包猜测。
2. **只做 Chat 单协议**：convert.go（1765 行）与 stream.go（1060 行）的全部跨协议逻辑用不上。Chat→Chat 是恒等透传。
3. **壳消失**：TS 版跑在 DSH 进程内，HTTP 服务器、本地鉴权、端口/token、进程看护（agent-process.ts 全部）都不需要。这占 Go 版热路径代码的约 40%。

**真实核心只剩两块**：模型目录判定（S1/S2/S3 三源合并与免费判定，Go 版 ~400 行 → TS 版估 200-300 行含测试）和请求变换（头 + id + fetch + 错误映射，估 150-200 行含测试）。

## 1. 关键架构发现：可能存在「TS-lite」路径

读 dsh-llm-pi-ai 源码发现其 profile schema 支持**静态自定义头**（`headers: z.dict(z.string())`，index.js:940 附近）与 `apiKeyEnv` 凭证引用。这意味着存在一个零代码方案：

```yaml
llm-pi-ai:
  providers:
    opencode2dsh:
      baseURL: https://opencode.ai/zen/v1     # 直连上游，无本地代理
      apiKeyEnv: OPENCODE2DSH_TOKEN            # 该凭证的值就是字面量 "public"
      api: openai-completions
      headers:                                 # 静态伪装头
        user-agent: opencode/1.18.21 (windows amd64; node)
        x-opencode-client: cli
```

流式/重试/错误全走 pi-ai 现成实现，插件代码量 ≈0（只是配置写入）。

**两个必须实测的风险**（决定 TS-lite 是否成立）：

- R-A：缺动态头。`x-opencode-session` / `x-opencode-request` / `x-opencode-project` 是每请求派生的，静态头给不了。上游是否接受无这些头的请求未知（opencode2api 从不发无头请求）。若拒绝 → TS-lite 死刑。
- R-B：pi-ai 是否用 profile 的 `headers` 覆盖自己的 `user-agent`（pi-ai 有自己的 attributionHeaders）。若不覆盖 → 伪装失效，可能被上游识别拒绝。

## 2. 阶段划分

### 2.0 架构定案（2026-08-29 实读 pi-ai 0.82.1 源码后定稿）

**wire 层全部复用 `@earendil-works/pi-ai`（MIT）**，不自写 SSE/消息编码。关键 API 事实（均已实读确认）：

- `createProvider({id, name, baseUrl, headers, auth, models, api})`（models.d.ts:158）：构造 provider，`baseUrl` 直指 `https://opencode.ai/zen/v1`，`api` 传 `@earendil-works/pi-ai/api/openai-completions` 模块（导出 `stream`/`streamSimple`，即 DSH 一切 OpenAI 兼容 provider 使用的同一实现）
- `StreamOptions.headers`（types.d.ts:78-85）：**调用方值覆盖默认头** → user-agent 伪装可覆盖（R-B 解除）；`StreamOptions` 是每次调用的参数 → **动态 session/request 头每请求构造传入**（R-A 解除）
- `StreamOptions.apiKey`：传字面量 `'public'`（非秘密，无需 credentials 服务）
- `inputModalities: ['text']` 声明后 dsh-llm 运行时自动剥离图片（`projectImagesForTextModel`，dsh-llm index.js adapterStream）→ 消息转换无图片负担
- pi-ai `Model` 接口（types.d.ts:637）：`{id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens, headers?, compat?}`，目录构造目标
- pi-ai `Context`：`{systemPrompt?, messages, tools?}`；`Message = UserMessage | AssistantMessage | ToolResultMessage`；内容块 `text | thinking | toolCall | image`
- chunk 输出词汇表（dsh-llm-pi-ai toStreamChunks，index.js:1342-1420 逐条核实）：`block-start{text|reasoning|tool-call}` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish{reason, replayState?}`，流必须以 usage+finish 终止

**adapter 模式下插件职责坍缩为**：目录维护 + `ctx.llm.registerAdapter(['opencode2dsh'], adapter)`。无 spawn、无端口、无 token、无 credentials/settings 写入（'public' 非秘密）。

### T0 — 探针（降级为可选信息项）

full 版不再依赖 T0 结论（动态头已由 pi-ai 每请求 options 解决）。T0 仅回答「lite 是否也行」，网络空闲时可顺手测。

### T1 — full 版核心模块

| # | 模块 | 参照 | 估行数（含测试） |
| --- | --- | --- | --- |
| 1.1 | `adapter/ids.ts`：stableID/randomID/deriveRequestIDs/conversationSeed/opencodeUserAgent | internal/ids 逐行为对齐 | ~120 |
| 1.2 | `adapter/catalog.ts`：S1(zen /v1/models, Bearer public) + S2(models.dev + 磁盘缓存) + S3(静态清单移植) + Decide + 定时刷新 | internal/catalog | ~350 |
| 1.3 | `adapter/provider.ts`：createProvider 装配 + 每请求伪装头/ids 构造 | gateway.go newUpstreamRequest | ~120 |
| 1.4 | `adapter/messages.ts`：harness GenerateOptions → pi-ai Context（role/block 改名 + tools 映射） | dsh-llm-pi-ai 转换层的净室版 | ~150 |
| 1.5 | `adapter/events.ts`：pi-ai AssistantMessageEvent → harness chunks（含 usage/stopReason 映射） | toStreamChunks 词汇表 | ~180 |
| 1.6 | `adapter/zen-adapter.ts`：LlmAdapter 壳（providerInfo/listModels/resolveModel/prepareCall/stream）+ 装配 | dsh-llm LlmAdapter 契约 | ~150 |
| 1.7 | plugin apply() 增 `mode: 'adapter'(默认) \| 'sidecar'`；adapter 模式不 spawn 不写 settings | — | ~60 |
| 1.8 | 单测矩阵（ids 对齐 Go 单测；Decide 五类输入；events 用例逐条对齐 toStreamChunks） | agent/internal/* 既有测试 | 含上 |

合计约 1100 行（此前估 650-800 偏乐观；转换层 messages/events 是读源码后修正的真实量级）。

### T2 — provider 注册迁移

复用现有 provider.ts 的 credentials/settings 写入，仅 baseURL 从本地代理改为直连（或 full 版时改走 registerAdapter 注册路由）。模型清单刷新逻辑不变。

### T3 — Go sidecar 退役

- 插件删 agent-process.ts / config.ts 的 agent-config 部分 / stamp-bin 脚本
- `agent/` Go module 归档保留（语义参照物 + 上游变更时的对照实现）
- README 改写安装说明（纯 npm 包，无二进制）

## 3. 顺序与判定点

```
接口精读（已完成 2026-08-29：dsh-llm LlmAdapter + chunk 词汇表 + pi-ai 公开 API）
   │
T1 核心模块（ids → catalog → provider → messages → events → zen-adapter → mode 接线）
   │
T2 实机验收（DSH 内 registerAdapter 生效、模型列表、流式对话、工具调用）
   │
T3 分发形态切换（market 包不含 agent 二进制与看护代码；
        agent/ Go module 与 sidecar 模式代码保留在仓库）
```

**诚实约束**：
- T0 涉及真实上游请求，受当前出口 IP 限流状态影响；429 时换节点重测，连续 429 则 T0 顺延
- full 版的 SSE 事件映射是唯一有对齐风险的点（usage 归并、tool call 分片、reasoning 透传），以 llm-pi-ai 参考实现 + Go 版单测为双重断言基准逐条对齐
- TS-lite 路线放弃作为主交付（缺动态会话头 + UA 覆盖不确定，市场包需要行为确定性），仅在 T0 全过时可作「降级模式」保留

## 4. 明确不做

- 不做多协议（Responses/Anthropic）——与 Go 版同一决策
- 不做 proxy 池/多出口——同一合规收缩（design.md §9.2）
- 不做 WebUI/多实例——同上
