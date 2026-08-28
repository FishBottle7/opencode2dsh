# 任务：实现 opencode2dsh — DSH 免登录接入 OpenCode 免费模型

你是 opencode2dsh 的开工实现 Agent。你的唯一目标是按 `docs/design.md` + `docs/plan.md` 把项目从文档推到可运行。

## 0. 先读什么（必读，顺序不能错）

1. `D:\codes\dshPlugins\opencode2dsh\docs\design.md` — 架构设计，含所有设计决策 D1/D2、复用审计表 §5、目录结构 §10
2. `D:\codes\dshPlugins\opencode2dsh\docs\plan.md` — 实施计划，Phase 0-3 每项含「做什么/复用来源/验收命令」
3. `D:\codes\dshPlugins\cc-migrate\docs\design.md` — 参考 DSH cordis 插件形态（opencode2dsh 插件与 cc-migrate 同为 cordis 插件）
4. 按需只读（不要改）：`C:\Users\FishBottle\AppData\Local\Temp\opencode\opencode2api\*.go` — 你的拷贝源。关键锚点已在 design.md §2.4/§5 标好行号。

读完再动码。不要重新调研 opencode2api，不要臆造模型 ID。

## 1. 项目定位（一句话）

在 DSH 旁拉起一台单租户 Go sidecar（移植自 opencode2api 的匿名链路），把 `https://opencode.ai/zen` 的 `Authorization: Bearer public`（`gateway.go:20 anonymousZenKey="public"`）包装成 DSH 可配的 OpenAI 兼容 provider（`baseURL=http://127.0.0.1:<port>/v1`）。

## 2. 硬约束

- 工作区：`D:\codes\dshPlugins\opencode2dsh`（workspace-write），`docs/` 已存在且已定稿，不要改文档
- 上游源码：只拷贝，不改动 `C:\Users\FishBottle\...\opencode2api` 任何文件
- Go 1.24，移植后零第三方依赖（`golang.org/x/crypto` 仅被不移植的 `password.go:12` 使用，删掉它依赖即清零）
- 上游模型白名单由服务端 `allowAnonymous`（`packages/console/core/src/model.ts:28`）控制，客户端只能靠 `models.dev` 成本==0 判定 + 名称含 `free` 兜底去逼近，不要硬编码未经实测的模型 ID
- 限流是按出口 IP 的平台侧 Secret 限流，**匿名配额受上游限流**必须诚实表述；`pool.go` 的多 IP 轮换是灰色能力，默认 `proxies=["direct"]` 关闭，仅自部署可选
- 监听只绑 `127.0.0.1`，本地鉴权默认启用（随机 token，`gateway.go:170 authenticate` 常量时间比对）
- 提交粒度：design.md §5 表一行一个 commit，message 注明来源文件与裁剪点

## 3. 目标目录结构（design.md §10）

```
agent/                  # Go module: go 1.24, CGO_ENABLED=0
  go.mod
  cmd/agent/main.go     # 删 WebUI/runtime，加 --print-ready (READY {"port":...})
  internal/ids/         # ids.go 整文件原样
  internal/config/      # config.go 精简（默认值改 127.0.0.1:0, anonymous=true）
  internal/catalog/     # models.go + model_metadata.go 精简 + static_models.go (S3)
  internal/convert/     # convert.go/stream.go 仅 Chat 恒等+接口占位
  internal/pool/        # pool.go 精简（删 key 池，保留 direct 语义）
  internal/gateway/     # gateway.go 精简（删 doKeyUpstream/KeyTiers 回退）
  internal/obs/         # slog + recoveryMiddleware + encodeSSE
packages/plugin/        # DSH cordis 插件 (TS)
  src/index.ts, agent-process.ts, config.ts, provider.ts
packages/agent-bin-*/   # 预编译产物 optionalDependencies（后做）
```

单包改多包时保持 `package main` 语义最小 diff 优先。

## 4. 执行顺序（严格按 plan.md，不跳 Phase）

**Phase 0 — Go 代理本地跑通（不接 DSH）**
0.1 建 `agent/go.mod` → 0.2 ids → 0.3 config → 0.4 catalog/metadata → 0.5 catalog/静态兜底 → 0.6 pool → 0.7 convert/obs → 0.8 gateway → 0.9 main → 0.10 验证
Phase 0 验收（全部通过才进下一 Phase）：
```bash
go build ./...
./agent --config config.json  # config: listen 127.0.0.1:8317, server_keys:["dev"], anonymous:true  (Windows 为 agent.exe)
curl -H "Authorization: Bearer dev" http://127.0.0.1:8317/v1/models | jq '.data|length'  # >0
curl -H "Authorization: Bearer wrong" http://127.0.0.1:8317/v1/models -w "%{http_code}"   # 401
curl -H "Authorization: Bearer dev" -d '{"model":"<S3实测模型>","messages":[{"role":"user","content":"ping"}]}' http://127.0.0.1:8317/v1/chat/completions  # 200
curl -N -H "Authorization: Bearer dev" -d '{"model":"<S3>","messages":[{"role":"user","content":"数到五"}],"stream":true}' http://127.0.0.1:8317/v1/chat/completions  # SSE 含 [DONE]
curl http://127.0.0.1:8317/healthz | jq .status  # ok
```
第 5/6 步同时校准 `static_models.go` — 只有实测 200 的 ID 才进默认表。

**Phase 1 — DSH 集成**
1.1 先核实 DSH provider 注册协议（design.md 开放 Q1，结论写进 plan.md 附录）
1.2 agent 加 --print-ready → 1.3 agent-process.ts (spawn/看护/指数退避1s→60s,5次熔断, Windows taskkill /T) → 1.4 config.ts (crypto.randomBytes(32), 0600持久化) → 1.5 provider.ts → 1.6 cordis 生命周期
验收：DSH 内对话流式成功；杀掉 agent 自动重启；关 DSH 无孤儿进程；断网 degraded 不崩溃。

**Phase 2 — 动态同步+兜底**（可与 Phase 3 并行）
S1 `fetchModels` 300s + S2 `models.dev/api.json` 24h+磁盘缓存 + S3 校准脚本 `scripts/verify-static-models.(ps1/sh)` + healthz 可观测

**Phase 3 — 健壮性**
重试矩阵/错误映射(Retry-After 透传)/可选 proxy(默认关)/32MiB 上限/长流稳定性/信号测试

## 5. 原则

- 拷贝即冻结：先让拷贝的代码跑通原语义，再裁剪，每步可编译可测试
- Chat 单协议贯穿 Phase 0-3，跨协议只留接口
- 验收未过不进下一 Phase；每个 Phase 结束用验收命令自检并报告
- 遇到阻塞（上游 401/403 突变、DSH API 不符预期）先停并报告，不要绕过

## 6. 参考锚点速查

- 匿名凭证 `gateway.go:20` / 路由 `98-106` / 鉴权 `170-194` / handleInference `212-327` / doAnonymousUpstream `424-483` / newUpstreamRequest `640-669` / protocolPath `789-798` / copyError `920-931`
- 免费判定 `models.go:303 isFreeModel` / `253 anonymousDecision` / `model_metadata.go:192 Decide` / `models.go:587 fetchModels`
- 池 `pool.go:36 anonymousPool` / `150 newTransportPool` (direct 初始 healthy=true) / `244 isProxyFailure`
- ID `ids.go:21 deriveRequestIDs` / `100 opencodeUserAgent`
- 默认值 `config.go:85` (zen=https://opencode.ai/zen)

现在从 Phase 0.1 开始执行。
