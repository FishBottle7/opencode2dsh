<div align="center">

# opencode2dsh

**在 DSH（DeepSeek Harness）里原生使用 OpenCode Zen 的免费匿名模型。**

无需 API Key。无需注册。无需额外进程。

[![npm](https://img.shields.io/npm/v/@opencode2dsh/dsh-plugin)](https://www.npmjs.com/package/@opencode2dsh/dsh-plugin)
[![license](https://img.shields.io/npm/l/@opencode2dsh/dsh-plugin)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/FishBottle7/opencode2dsh)

[English](README.md) | 简体中文

</div>

---

opencode2dsh 会向 DSH 注册一个原生的 `LlmAdapter`，直接流式对接
[OpenCode Zen](https://opencode.ai/zen) 的**匿名免费通道**——也就是
OpenCode 官方 CLI 无需登录即可使用的那批免费模型，它们会以 `opencode2dsh`
这个常规 provider 出现在你的 DSH 模型选择器里。

插件发出的请求与 OpenCode CLI 的流量完全同形（相同的 User-Agent、相同的
关联请求头），模型目录通过三级回退链保持新鲜。不用登录任何账号，也不用
自己部署任何东西。

## 特性

- **零凭据、零配置**——匿名通道不需要任何 Key；装好、重启、开聊
- **原生 adapter，无 sidecar**——一个 npm 包，没有子进程、没有二进制、没有本地端口（旧版 Go sidecar 不随包发行，见 `legacy/`）
- **CLI 同形伪装**——请求携带 OpenCode CLI 的 User-Agent 和整套会话/请求/项目关联头，按会话派生
- **实时目录 + 三级回退**——上游实时列表 ∩ 元数据判定免费，断网时依次回退到磁盘缓存与已验证的静态名单
- **自愈能力**——启动期快速重试、周期刷新，并落盘健康快照便于排查
- **规范的错误呈现**——上游故障（限流、鉴权、超时、传输）以分类的 finish 原因送达 DSH，重试策略始终由 DSH 掌控

## 安装

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin
```

重启 DSH（`dsh web`），打开模型选择器，在 **opencode2dsh** 分组里选模型即可。

上架社区插件市场后，也可以在 **设置 → 插件市场** 里一键安装。

需要带 web profile 的 DSH（DeepSeek Harness）；Node.js ≥ 20（DSH 能跑就满足）；
出站 HTTPS 需可达 `opencode.ai` 与 `models.dev`。


## 配置

默认配置开箱即用。需要覆盖时，编辑 profile 的 `cordis.patch.yml`：

```yaml
- id: opencode2dsh
  name: '@opencode2dsh/dsh-plugin'
  config:
    mode: adapter        # adapter（默认）| sidecar
    providerId: opencode2dsh
    refreshSeconds: 300  # 目录刷新周期（秒）
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `adapter` | `adapter`：原生 LlmAdapter 直连 Zen。`sidecar`：旧版本地 agent 模式，不随包发行——请从 `legacy/agent` 自行构建并通过 `agentPath` 指定。 |
| `providerId` | `opencode2dsh` | 在 DSH 中显示的 provider 名称。 |
| `refreshSeconds` | `300` | 实时目录刷新间隔；定价元数据每 24 小时刷新。 |
| `agentPath` | 自动解析 | 仅 sidecar：agent 二进制路径。 |
| `agentArgs` | — | 仅 sidecar：传给 agent 的额外 CLI 参数。 |
| `restartDelayMs` / `restartMaxDelayMs` / `maxConsecutiveCrashes` | `1000` / `60000` / `5` | 仅 sidecar：重启退避与熔断阈值。 |

## 工作原理

```
DSH 会话
   │  harness chunk（block-start / text-delta / usage / finish …）
   ▼
ZenAdapter（注册的 LlmAdapter）
   │  pi-ai openai-completions 流式
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
   携带与 CLI 同形的请求头：
     user-agent: opencode/…
     x-opencode-client, x-opencode-session, x-session-affinity,
     X-Session-Id, x-opencode-request, x-opencode-project
```

- **会话关联**——session/project id 由会话首条用户消息经 SHA-256 派生
  （同一会话稳定、不可逆推），每个请求再附带一个全新的随机 id，与 CLI 行为一致。
- **目录回退链**——S1：实时 `GET /v1/models`；S2：models.dev 定价元数据判定
  "免费"；S3：编译期验证的静态名单。上游故障时由磁盘缓存（约 7 天有效期）兜底。
- **韧性**——adapter 在启动时立即注册；若首次目录拉取撞上网络尚未就绪
  （VPN/TUN 重连、DNS 等），会以短周期重试（约 1 分钟内），随后转入常规刷新。
- **sidecar 模式**（`mode: sidecar`，旧版）——拉起本地 Go agent（
  [opencode2api](https://github.com/jasonxu114514/opencode2api) 的单租户移植版），
  监听 `127.0.0.1:<随机端口>`、token 鉴权，并注册标准 `llm-pi-ai` 路由。
  **不随包发行**；请从 `legacy/agent` 构建（`go build ./cmd/agent`）并把
  `agentPath` 指向产物。

## 健康状态与排查

插件在每轮刷新后写入健康快照：

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

| 现象 | 可能原因与处理 |
| --- | --- |
| 只有 3 个模型 | 启动时网络未就绪，重试会在约 1 分钟内补齐；看 `adapter-status.json` 里的 `lastError`。 |
| `lastError: "fetch failed"` 持续出现 | 出站 HTTPS 到 `opencode.ai` 被拦截；检查代理/VPN 规则。 |
| 对话中报限流错误 | 匿名通道按 IP 限额；切换网络节点或稍后再试。 |
| 连接 `127.0.0.1:*` 报错 | 残留的 sidecar 路由遮蔽了 adapter；插件 ≥ 0.2.1 启动时会自动清理。 |
| 安装时报 `ERR_PNPM_IGNORED_BUILDS` | `pi-ai` 的传递依赖（`@google/genai`、`protobufjs`）带构建脚本，运行时并不需要。在插件市场里按提示选择允许/拒绝，或在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds:` 下把这两项设为 `false`。 |

## 安全性

- 不涉及任何机密：匿名通道的 Key 就是字面量 `public`；插件不存储任何东西，也没有任何遥测。
- 安装产物仅限 `lib/`；不执行任何依赖的构建脚本。
- 所有请求均从你的机器直连 `opencode.ai` / `models.dev`。

## 开发

```sh
git clone https://github.com/FishBottle7/opencode2dsh.git
cd opencode2dsh/packages/plugin
pnpm install
pnpm typecheck && pnpm test   # 44 个单元测试
pnpm build                    # 打包到 lib/
```

旧版 Go sidecar 在 `legacy/agent`（`go test ./...`）。架构说明与移植记录见 `docs/`。

发布：在 `packages/plugin` 执行 `pnpm pack`（prepack 会构建并同步文档）。

## 致谢

- [**opencode2api**](https://github.com/jasonxu114514/opencode2api)，作者
  [@jasonxu114514](https://github.com/jasonxu114514)——`legacy/agent` 里的旧版
  Go sidecar 是其匿名通道实现的移植版，目录回退链与请求伪装细节同样源自它。
  本项目能成立，全靠它踩过的路。
- [OpenCode](https://opencode.ai)——运营免费匿名 Zen 通道。
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)——adapter 模式使用的线上协议层。
- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 与
  [dsh-market](https://github.com/dsh-market/dsh-market) 社区。

## 友链

<div align="center">

**[LinuxDo](https://linux.do)** —— 新的理想型社区

</div>

## 许可证

[MIT](./LICENSE) © FishBottle7
