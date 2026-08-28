# opencode2dsh：实施计划

> 状态：v1（2026-02-05），配套 `design.md`（架构决策 D1/D2、复用审计表 §5、目录结构 §10 均以该文档为准）。执行顺序：Phase 0 → 1 → 2 → 3，Phase 0/1 串行，2/3 可并行。每个 Phase 含「做什么 / 复用来源 / 验收标准」；**验收未过不进下一 Phase**。
> 源码只读约定：opencode2api 克隆位于 `C:\Users\FishBottle\AppData\Local\Temp\opencode\opencode2api\`，**只拷贝、不改动**；所有 `文件:行号` 锚点见 design.md §2.4/§5。

## 0. 总原则

1. **拷贝即冻结**：从 opencode2api 拷入的代码先不改逻辑，先让它跑通原语义，再逐项裁剪，每步可编译可测试（避免「边裁边改」造成语义漂移）。
2. **Chat 单协议贯穿**：Phase 0-3 全链路只走 OpenAI Chat（design.md §6.3），跨协议转换只留接口占位。
3. **每个 Phase 有机器可验证的验收命令**（下文各节给出），以命令通过为完成定义。
4. 提交粒度：一个「移植单元」（design.md §5 表一行）一个 commit，commit message 注明来源文件与裁剪点。

## Phase 0 — Go 代理本地跑通（不接 DSH）

**做什么**：建 Go module，按 design.md §5 审计表完成第一批移植（ids / config / catalog / pool / gateway 骨架），以裸二进制在 127.0.0.1 跑通「列模型 + 一次匿名 chat（流式/非流式）」。

任务分解（建议 commit 顺序）：

| # | 任务 | 复用来源（opencode2api） | 产出 |
| --- | --- | --- | --- |
| 0.1 | 建 `agent/` Go module（go 1.24，无依赖），目录骨架按 design.md §10 | — | `agent/go.mod` + 空包可 `go build ./...` |
| 0.2 | 移植 `internal/ids` | ids.go 整文件（102 行，零改动） | 单测：同请求头/同首条消息 → 同 session id；缺信号 → 随机 fallback |
| 0.3 | 移植 `internal/config`（精简） | config.go（删 WebUI/password 字段；默认值改 `127.0.0.1:0`、`anonymous=true`；新增 listen 必须回环、`anonymous` 恒 true 的校验） | 单测：合法/非法配置各 ≥3 例 |
| 0.4 | 移植 `internal/catalog`：metadata 子模块 + 匿名判定 | model_metadata.go（删 proxy clientProvider）；models.go 的 `isFreeModel`/`anonymousDecision` | 单测：`Decide` 对 cost=0 / cost>0 / deprecated / 名含 free / 元数据未就绪 五类输入的输出与源实现一致 |
| 0.5 | 移植 `internal/catalog`：目录 + 静态兜底 | models.go 的 `modelCatalog`（删 TierGo/docs 正则/keyTierOrder）、`fetchModels`；新增 `static_models.go` S3 清单 | 单测：S1∩S2 合并、S2 未就绪回退名称判定、全失败回退 S3 |
| 0.6 | 移植 `internal/pool` | pool.go 的 `transportPool`/`anonymousPool`/`anonymousCursor`/`isProxyFailure`（删 key 节点池 `nodePool`） | 单测：direct 单节点下 cursor/冷却/MarkFailure(Retry-After) 行为正确 |
| 0.7 | 移植 `internal/convert`（裁剪）+ `internal/obs` | convert.go/stream.go 的 Chat 恒等路径 + `encodeSSE`；slog 装配 | 单测：Chat 请求/响应/流 三用例的恒等转换 |
| 0.8 | 移植 `internal/gateway` | gateway.go 的 `Handler()`(98-106)、`authenticate`(170-194)、`handleInference`(212-327，删 KeyTiers 回退)、`doAnonymousUpstream`(424-483，去多层语义)、`newUpstreamRequest`(640-669)、`writeAPIError`/`copyErrorResponse`、`recoveryMiddleware` | `go build` 通过；`go test ./...` 全绿 |
| 0.9 | 写 `cmd/agent/main.go` | main.go 骨架(16-73) 裁剪：删 WebUI/runtime；保留信号优雅退出 | 二进制可启动、Ctrl+C 干净退出 |
| 0.10 | **Phase 0 验证点** | — | 见下方命令 |

**Phase 0 验收标准**（在 `agent/` 目录手工执行，全部通过即验收）：

```bash
# 1. 编译
go build ./...

# 2. 起服务（临时 config.json：listen=127.0.0.1:8317, server_keys=["dev"], anonymous=true）
#    Windows 下二进制名为 agent.exe，下文 ./agent 相应替换
./agent --config config.json

# 3. 模型列表含免费模型（HTTP 200 且 data 非空）
curl -s -H "Authorization: Bearer dev" http://127.0.0.1:8317/v1/models | jq '.data | length'   # > 0

# 4. 错误 token 被拒（401）
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong" http://127.0.0.1:8317/v1/models   # 401

# 5. 一次匿名 chat 非流式成功（HTTP 200，choices[0].message.content 非空）
curl -s -H "Authorization: Bearer dev" -H "Content-Type: application/json" \
  -d '{"model":"<S3清单实测模型>","messages":[{"role":"user","content":"ping"}]}' \
  http://127.0.0.1:8317/v1/chat/completions

# 6. 一次匿名 chat 流式成功（SSE 分帧到达，含 [DONE]）
curl -sN -H "Authorization: Bearer dev" -H "Content-Type: application/json" \
  -d '{"model":"<S3清单实测模型>","messages":[{"role":"user","content":"数到五"}],"stream":true}' \
  http://127.0.0.1:8317/v1/chat/completions

# 7. healthz 就绪
curl -s http://127.0.0.1:8317/healthz | jq -r '.status'   # "ok"
```

附加：第 5/6 步同时用于**校准 S3 静态清单** —— 把实测通过的模型 id 固化进 `static_models.go`（design.md §4.1 S3），这一步是 Phase 0 的关键产出，不是可选步骤。

**不做**：不接 DSH、不写插件、不做 proxy 池多节点（代码移植但默认 `direct`）。

## Phase 1 — DSH 集成（插件拉起子进程）

**前置**：Phase 0 验收通过。

**做什么**：建 `packages/plugin`（cordis 插件），实现 spawn/看护/端口发现/token，并把 DSH 的模型请求指向本地代理。

任务分解：

| # | 任务 | 来源/依据 | 要点 |
| --- | --- | --- | --- |
| 1.1 | **核实 DSH provider 注册协议**（design.md 开放问题 Q1） | DSH 侧代码/文档 | 明确插件能否动态注入 provider 与模型清单；决定 provider.ts 是「写配置」还是「运行时注册」。**这是 Phase 1 的第一个任务，产出结论写入本档附录** |
| 1.2 | agent 增加 `--print-ready` | design.md §8.2（对上游唯一的新增逻辑，约 20 行） | 监听成功后 stdout 输出 `READY {"port":...}`；插件据此获得随机端口 |
| 1.3 | `agent-process.ts` | design.md §8.1 | spawn/stdio 管道日志、readiness 轮询、退出重启（指数退避 1s→60s，连续 5 次熔断）、注销时 SIGTERM→5s→SIGKILL（Windows `taskkill /T /PID`） |
| 1.4 | `config.ts` | design.md §8.3 | 生成 `agent-config.json`（模板见 design.md §8.3）；token 用 `crypto.randomBytes(32)` 生成并持久化（0600）；数据目录不存在则建 |
| 1.5 | `provider.ts` | 1.1 结论 | `baseURL = http://127.0.0.1:<port>/v1`，api_key = 本地 token；启动与定时（跟随目录刷新 300s）拉 `/v1/models` 注册到 DSH |
| 1.6 | 插件生命周期接线 | cordis 插件约定（参考 cc-migrate Phase 3 规划的插件形态） | service 工厂 + start/stop；DSH 重载插件不泄漏子进程 |
| 1.7 | **Phase 1 验收标准** | — | 见下 |

**Phase 1 验收标准**：

1. DSH 正常启动后 `Get-Process`（或 `ps`）可见 agent 子进程，父进程为 DSH/Node；关闭 DSH（或停用插件）后子进程在宽限期内退出，无孤儿进程。
2. DSH 模型列表出现 opencode2dsh provider 及 ≥1 个免费模型；选中后发送一次对话，DSH 界面收到流式回复。
3. 手工 `Stop-Process -Kill` agent 进程：插件在退避间隔内自动重启，DSH 恢复可用（看护生效）。
4. 重启 DSH：token 复用（数据目录已持久化），端口可变（DSH provider 每次随插件刷新），模型列表正常。
5. 断网状态启动：DSH 能启动、healthz 为 degraded、对话报错信息可读（不崩溃、不挂死），恢复网络后目录自动刷新（design.md §4.2 回退链 + gateway 定时刷新）。

**不做**：多实例、远程监听、WebUI（均明确排除，见 design.md §5）。

## Phase 2 — 免费模型动态同步 + 备选

**前置**：Phase 1 验收通过（可与 Phase 3 并行）。

**做什么**：把模型目录做成「动态为主、静态兜底、可观测」的完整闭环。

| # | 任务 | 复用来源 | 验收标准 |
| --- | --- | --- | --- |
| 2.1 | S1 定时刷新接线 | models.go `fetchModels`(587-618) + gateway.go `StartModelRefresh`(800-837) 的匿名分支 `refreshAnonymousTier`(870-891) | 上游新增/下架模型后 ≤ refresh_seconds+30s，`GET /v1/models` 与 DSH 模型列表同步变化 |
| 2.2 | S2 models.dev 缓存与 24h 刷新 | model_metadata.go（`loadCache`/`saveMetadataCache`/`Start`） | 删缓存文件冷启动时判定退化为名称兜底并记日志；缓存命中时 `Decide` 元数据路径生效 |
| 2.3 | S3 静态清单校准流程 | Phase 0 第 5/6 步产物 | `static_models.go` 每条目附「实测日期」注释；提供 `scripts/verify-static-models.(ps1/sh)`：逐 id 发一次 1-token 请求，输出 通过/失败 表 |
| 2.4 | 目录可观测 | healthz models 块（gateway.go:108-168 移植） | `/healthz` 报告 `total/exposed/last_refresh/stale`；DSH 日志在刷新失败时出现 warn |
| 2.5 | 判定不一致反馈 | design.md 风险 R3 | S3 清单中被上游 4xx 拒绝的条目在连续 N 次失败后自动移出暴露列表（仅内存，重启恢复；变更写日志） |

**Phase 2 验收标准**（汇总）：

- `scripts/verify-static-models` 输出全部通过（或明确标注候选）。
- 模拟 S1 故障（改 upstream 指向无效地址后重启）：`/v1/models` 回退到上次成功目录或 S3，healthz 报 `degraded` + `model_catalog_stale`；恢复后自动收敛。
- 模拟 S2 故障（改 models.dev endpoint）：名称含 free 的模型仍暴露，日志出现 `metadata_*` 来源标记。

## Phase 3 — 健壮性（重试、错误映射、可选 proxy）

**前置**：Phase 1 验收通过（可与 Phase 2 并行）。

| # | 任务 | 复用来源 | 验收标准 |
| --- | --- | --- | --- |
| 3.1 | 重试语义定型 | gateway.go `isNonRetryableClientResponse`(671-673)、pool.go `MarkFailure`(112-127) | 单测矩阵：401/403/429 → 不换节点重试（冷却退避）；5xx/传输错 → 按 max_attempts 重试；4xx 其他 → 原样透传。**默认 direct 单出口下「重试」= 冷却后同出口再试，不产生多 IP 行为** |
| 3.2 | 错误映射与 UX 文案 | design.md §6.2 错误表 | DSH 端到端：限流时用户看到「匿名配额受限，请稍后再试」而非 hang；断网看到 502 语义；`Retry-After` 透传到 DSH 可见 |
| 3.3 | 可选 proxy 配置面 | pool.go `transportPool`/`anonymousPool`（已移植） | `agent-config.json` 支持 `proxies` 数组；默认 `["direct"]`；npm 分发包与 README 不含多代理示例（design.md §9.2 灰色能力收缩）。配置了 ≥2 出口时 `doAnonymousUpstream` 按 cursor 轮换 |
| 3.4 | proxy 健康检查 | gateway.go:22-26 常量 + `syncProxyResult`(678-702) + `CheckHealth`(pool.go:191-239) | 仅当配置多出口时启用；单 direct 时不产生 cloudflare.com 探测流量 |
| 3.5 | 请求体/资源上限回归 | `maxRequestBody = 32MiB`（gateway.go:18）、响应读上限 64MiB（gateway.go:307）、长流稳定性 | 32MB 请求被 413 拒绝；≥10 分钟长流不断流、内存平稳 |
| 3.6 | 崩溃与信号测试 | 插件看护（1.3） + agent 信号处理（0.9） | kill -9 agent → 插件重启；agent 收到 SIGTERM 时在途流式请求被优雅终止（客户端收到终止而非挂起） |

**Phase 3 验收标准**（汇总）：上表 6 项全部通过；`go test ./...` 与插件测试全绿；README「限制与合规」章节含 design.md §9 的诚实声明。

## 里程碑与依赖关系

```
Phase 0 ──► Phase 1 ──┬──► Phase 2 ──► 交付
                      └──► Phase 3 ──► 交付
```

- Phase 0 是最大风险集中点（上游连通性、S3 清单实测），建议最先做、当天出结论。
- Phase 1 的 1.1（DSH provider 协议核实）是插件侧唯一不确定项，若结论为「DSH 只能静态配置 provider」，则 provider.ts 退化为生成配置片段 + 提示用户重启 DSH，工作量不增。
- Phase 2/3 无相互依赖，可并行或按需取舍：**最小可交付 = Phase 0+1**（可用），推荐交付 = 0+1+2（模型列表可靠），完整 = 0+1+2+3。

## 风险与对策（执行视角）

| # | 风险 | 触发信号 | 对策 |
| --- | --- | --- | --- |
| R1 | 上游匿名通道变更（design.md R1） | Phase 0 验收 5/6 突然 401/403 | 核对 `anonymousZenKey` 常量与请求头与 opencode2api 最新版；同步上游修复；短期在 README 置顶公告 |
| R2 | 分发环境禁二进制（design.md R2） | 插件市场审核反馈 | 兜底链：预编译包 → 本机 Go 现场编译 → 明确报错+编译指引 |
| R3 | S3 清单含失效模型 | verify 脚本失败项 | 按 2.5 自动摘除 + 人工校准；清单只增实测通过项 |
| R4 | 裁剪引入语义回归 | 0.4-0.8 单测红 | 遵守「拷贝即冻结」：先全量拷贝过测、再裁剪，每次裁剪后重跑单测 |
| R5 | Windows 信号差异 | 1.3/3.6 验收失败 | Windows 无 SIGTERM 语义：用 `taskkill /T`（带 /F 才强制）；插件侧以 stdout 关闭 + healthz 探测判定死亡 |

## 附录 A — 任务 1.1 核实结论：DSH provider 注册协议（2026-08-28，实机核实）

**环境**：DSH CLI `@deepseek-ai/dsh@0.1.1-rc.2`（npm 全局安装，cordis 插件体系），web profile 位于 `~/.dsh/profiles/web/`。

**结论：DSH 支持插件运行时动态注册 provider 与模型清单，无需重启。** provider.ts 采用「运行时注册」，不退化为静态配置片段。

### A.1 LLM 服务面（`@deepseek-ai/dsh-llm`，`lib/index.js`）

- `ctx.llm.registerAdapter(providers: string[], adapter)`（index.js:1174）：为若干 provider 路由注册 adapter；随插件 fiber 生命周期自动注销；`handle.replace(routes)` 原子换路由集，并广播 `llm/adapters-updated`。
- adapter 接口（index.js:1073 `LlmAdapter` 基类）：
  - `providerInfo(provider)` → `{ id, name }` 显示元数据；
  - `listModels(provider)` → `{ provider, id, name, description?, inputModalities? }[]`，**目录仅为建议性**（advisory），不参与请求校验；
  - `resolveModel(provider, model, signal)` → 精确模型元数据（`context.contextWindow`、`defaultMaxTokens`、`reasoning.efforts` 等）；
  - `prepareCall(provider, model, signal)` → `{ model, stream }`；
  - `stream(options)` → 流式生成；请求须带 `attributionHeaders()`（`user-agent`）。
- `registerConfigurableProviders(entries)`（index.js:1251）：可选，把 provider 挂进配置目录（供 Web 设置页显示/编辑）；`registerModelDiscovery(ns, discover)`（index.js:1315）：可选，供设置页「探测端点模型」。

### A.2 现成 OpenAI 兼容适配层：`@deepseek-ai/dsh-llm-pi-ai`

内置插件 `llm-pi-ai`（settings 命名空间 `llm-pi-ai`）即为「OpenAI 兼容端点接入」的标准路径（基于 `@earendil-works/pi-ai`）：

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    opencode2dsh:
      displayName: opencode2dsh
      apiKeyEnv: OPENCODE2DSH_TOKEN      # 走 ctx.credentials 解析；协议 openai-completions
      api: openai-completions
      baseURL: http://127.0.0.1:<port>/v1
      models:
        - id: <agent /v1/models 返回的 id>
          name: <显示名>
```

实机已有两个手写 provider（abrdns/pangmao）按此形态工作。profile 字段含 `headers`（dict）、`compat`、`retryPolicy` 等；`apiKeyEnv` 是凭证引用（`ctx.credentials.resolve`），值可由 `ctx.credentials.set(ref, token)` 以编程方式写入（dsh-credentials README「Surface」节），配置文件里永远只有引用没有秘密。

### A.3 第三方 cordis 插件形态（实机先例 `@superfish058/dsh-llm-proxy@1.1.0`）

- npm 包 `type: module`，`main: lib/index.js`，导出 `name`/`inject`/`apply`（可加 `Config`/`schema`）；
- 包根附 `cordis.patch.yml`：bundle patch，`- insert: [{ id, name, config }]` 把插件插进运行图（cordis-plugin-include/loader 机制）；
- 安装：`dsh plugin --profile web add <pkg>`（pnpm 转发到 profile 目录），并把包名加进 profile `package.json` 的 `dsh.profile.bundles`。

### A.4 opencode2dsh 的 provider.ts 定案

两段式：

1. **进程管理**（本项目独有职责）：spawn agent.exe、READY 握手拿端口、看护重启——任何现有插件都不做这件事，必须自己写（agent-process.ts）。
2. **provider 接入**：**不自己实现 LlmAdapter**，改为插件启动/模型刷新时，用 `ctx.settings`（`settings.mutate('llm-pi-ai', …)`）确保 `llm-pi-ai.providers.opencode2dsh` 路由存在并指向 `http://127.0.0.1:<port>/v1`，模型清单从 agent `GET /v1/models` 拉取后写入该路由的 `models` 数组；token 经 `ctx.credentials.set(credentialRef('OPENCODE2DSH_TOKEN'), token)` 写入。流式/重试/错误映射复用 pi-ai 与 dsh-llm-retry 的现成实现，Phase 3 的「DSH 端错误 UX」由这条现成链路承担。
   - 若实测发现 settings 写入在无 UI 的 headless 启动序中不可用，退路：改走 `ctx.llm.registerAdapter` 自实现薄 adapter（仅转发 fetch 到本地代理），接口面见 A.1。

**对 plan.md 的影响**：1.5 的产出从「实现 LlmAdapter」改为「settings/credentials 写入 + 模型清单刷新」；验收标准不变。

## 交付物清单

1. `agent/`：Go module（零第三方依赖），`cmd/agent` 二进制源码 + 单测 + `scripts/verify-static-models`。
2. `packages/plugin/`：DSH cordis 插件（spawn/看护/token/provider 注册）+ 测试。
3. `packages/agent-bin-*`：5 平台预编译子包（optionalDependencies 分发）+ CI 交叉编译 workflow（参照 opencode2api `.github/workflows/release.yml` 的矩阵思路）。
4. `README.md`：安装、模型列表、限制与合规声明（含 design.md §9.2 灰色能力收缩口径）。
5. 文档更新：本档附录记录 1.1 的核实结论与最终 provider 注册方式。
