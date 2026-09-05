# opencode2dsh IP 池与出口路由 — 架构设计

> 状态：v1 草案（2026-09-04）。实现前定稿；上游锚点在编写时逐一核实。
> 关联：`docs/design.md`（总体架构，特别是 §9.2 多出口收缩）、`docs/ts-adapter.md`（当前 adapter 形态）。
> 参考项目（两个均在本地临时目录读过源码）：
> - [isboyjc/GoProxy](https://github.com/isboyjc/GoProxy)（智能代理池：免费源抓取 + Clash/V2ray 订阅导入 + 探活 + 对外 HTTP/SOCKS5）
> - [superfish058/dsh-llm-proxy](https://github.com/superfish058/dsh-llm-proxy)（DSH 生态插件：undici 全局 dispatcher 按 host 分流 + 设置页卡片 + 连接测试）

## 0. 动机与合规定调（先说清楚）

opencode Zen 匿名通道按**出口 IP** 限流（design.md §3）。当前 adapter 版单出口直连，一个 IP 的匿名配额用尽（401/403/429）就整卡不可用，只能干等窗口恢复。

用户诉求：**IP 池（免费源抓取 + 手填节点 + 机场订阅，三来源同池）→ 批量探活（哪个 IP 对哪个模型可用）→ 自动路由（这个 IP 打到限额/被地区拦 → 自动换下一个可用的 IP；有专线则固定主力、其余作备胎）→ 设置页管理**。

「自动路由」的用户语义（验收口径）：一次对话请求选中模型 M 后——
1. 出口 E₁ 发出，上游 429（配额到顶）→ **自动换** E₂ 重发（E₁ 进入冷却）；
2. 出口 E₂ 对模型 M 返回 403（地区封锁，如我们实测过的 muse region-blocked）→ **自动换** E₃ 重发（E₂×M 记封禁，但 E₂ 服务其他模型不受影响）；
3. E₃ 成功 → 流交付。全程对用户透明，只有最终全败才报错。

design.md §9.2 曾把「多出口」定为灰色能力并默认关闭（当时的形态是：自配 proxies URL 列表、npm 包不携带）。本设计**修订而非推翻**该立场：

1. **形态升级**：不再是「用户手填代理 URL 的隐藏开关」，而是对接一个现成的代理池服务（GoProxy）+ 插件内探活路由层。用户场景是「我已经有 Clash 订阅/免费代理池，想让免费模型的可用性更好」——与 dsh-llm-proxy「境外 API 走代理」是同一类正当需求，甚至目标 host 都是同一个匿名通道。
2. **默认仍关闭**：`routing.mode = "off"`，行为与现状完全一致（直连）。开启需要用户在设置页显式操作。
3. **不做激进绕过**：探活是低频、小流量探测；路由层不做「429 即换 IP 无限重试轰炸」，换 IP 有冷却与尝试上限（§4.6）。README 与设置页文案照旧诚实标注「匿名配额受上游限流」。
4. **合约定性**：本项目以官方客户端同款请求头使用官方开放的匿名通道（design.md §9.3 口径不变）；多出口改变的是「从哪台机器出口」，不伪造凭证、不破解。免费公共代理的合法性与风险由 GoProxy 的免责声明覆盖；设置页提示用户优先使用自有订阅节点。

> 历史备注：Go sidecar 代码（`legacy/`）本就移植了 opencode2api 的 `anonymousPool`（按 IP 指数冷却），`agent-config.json` 也有 `proxies` 字段。本设计把它上移到 TS adapter 进程内，且语义从「静态代理列表轮换」升级为「池服务对接 + per-exit 健康表 + 主动探活」。

## 1. 总体架构

```
┌─────────────────────────── DSH 主进程 (Node.js) ───────────────────────────┐
│                                                                             │
│  dsh-llm (官方) ──dispatch──► opencode2dsh adapter (现 zen-adapter.ts)       │
│                                    │                                        │
│                     pi-ai wire 层 (openai-completions, OpenAI SDK)           │
│                                    │                                        │
│                     Node 内置 fetch（全局 undici dispatcher）                │
│                                    │                                        │
│              ┌─────────────────────┼──────────────────────────────┐         │
│              │  PoolRoutingDispatcher（本设计新增，setGlobalDispatcher）      │  │
│              │  · 按 host 分流：opencode.ai → 出口池；其余 → direct        │  │
│              │  · 出口选择：健康+冷却+封禁过滤（§3.2/§3.3）              │  │
│              │  · 失败换出口重试：429→冷却换IP，403/401→记封禁换IP（§3.4） │  │
│              └─────────┬───────────────────────────────┬─────────┘         │
│                        │ pick/write                    │ probe             │
│              ┌─────────▼─────────────────────┐  ┌──────▼─────────────┐    │
│              │ ExitPool（出口池 + 状态机 §3.5） │  │ Prober（探活引擎）   │    │
│              │ · 出口表（free/manual/sub） │  │ · 准入探测（§4.5）  │    │
│              │ · 两层健康（§3.2）              │◄─│ · 周期/按需探测     │    │
│              │ · per-IP 冷却·模型封禁           │  │ · 两级调度（§4.1）  │    │
│              │ · 四态 refill 调度               │  └────────────────────┘    │
│              └───┬───────────────┬────────────┘                             │
│                  │ 拉取免费源清单   │ 枚举（可选）                            │
│       ┌──────────▼─────────┐  ┌───▼──────────────────────────┐              │
│       │ 免费源（26 个公开清单）│  │ 机场订阅（URL 拉取+解析）   │              │
│       │ raw.githubusercontent │  │ GET /api/proxies（readOnly） │              │
│       │ /jsdelivr 文本清单     │  │ 订阅/sing-box 在它那边        │              │
│       └────────────────────┘  └──────────────────────────────┘              │
└──────────────────────────────────────────────────────────────────────────────┘
（手动添加的明文代理不经网络拉取，直接进出口表，设置页 §5）
```

要点：

- **零外部服务**：池子（抓取/验证/状态机/探活/订阅解析）全部跑在插件本体内。唯一按需外挂的是 sing-box 单文件（加密订阅节点的转换核心，§1.2.2）——spawn 用户自装的二进制 ≠ 分发二进制。
- **注入点唯一且被验证过**：pi-ai 的 wire 层是 `new OpenAI({apiKey, baseURL, defaultHeaders})`（已实读 pi-ai 0.82.1 `dist/api/openai-completions.js:505`），不暴露 fetch/dispatcher 注入点；Node 内置 fetch 走全局 undici dispatcher。dsh-llm-proxy 已在同一宿主上验证 `setGlobalDispatcher` 对 LLM 流量生效（其 README 明言「位于 LLM 适配器之下、供应商之上」）。我们复用同一手法。
- **命名空间**：设置命名空间 `ip-pool`（kebab-case，跟随 dsh-llm-proxy 的 `llm-proxy` 惯例）。

### 1.1 复用策略：从两个参考项目各取什么（吸取有用部分，能直接抄就抄）

| 来源 | 直接拿来的 | 形态 |
| --- | --- | --- |
| dsh-llm-proxy | `RoutingDispatcher` 骨架（150 行，改选择逻辑）、ProxyAgent keep-alive 坑的修法（`clientFactory + pipelining: 0`）、installer 的装卸/热更（makeInstaller）、settings bridge 护栏（loopback guard + `{ok, code, message}` 信封）、tsdown 客户端构建配置、CSS Modules 内联方案 | **抄代码**：同宿主同机制，MIT，全部在真实 DSH 上验证过 |
| GoProxy | 源清单（fast/slow 两档 ~26 个免费源 URL）、验证链（连通→出口 IP/地理→延迟→HTTPS CONNECT 隧道）、池状态机（healthy/warning/critical/emergency 四态 + 按态选抓取模式）、断路器（源级连续失败熔断 + 冷却恢复）、准入-替换-健康检查-优化轮换的控制循环 | **抄设计**：TS 重写进插件本体（免费源全是 HTTP 文本清单，Node 拉取解析毫无障碍；Go 代码不直接移植） |
| GoProxy（运行实例，可选） | `GET /api/proxies`（readOnly 免登录，含 exit_ip） | **抄协议**：作为可选出口来源之一（§1.2），不作为必选依赖 |

### 1.2 架构定案：池子内建，GoProxy 不接（2026-09-05 摘牌）

**池子（抓取/验证/状态机）跑在插件本体里**（TS，进程内），出口来源有三类：

1. **免费源抓取**（内建）：用户开启即用，不依赖任何外部服务。免费代理质量烂，所以配套内建验证与准入（§4.5）。
2. **手动添加的明文 HTTP/SOCKS5 代理**（内建，设置页手填）：几个自备节点直填，undici 原生就拨。其中可标记 **pinned 固定出口**（专线/本机 Clash 场景，§3.6）。
3. **订阅**（内建，机场/自建 Clash·V2ray 订阅，设置页填 URL）：解析层纯 TS 内建（§1.2.1）；拨号按协议分层——明文节点（http/socks5）直拨，加密节点（vmess/vless/trojan/ss/hysteria2/anytls）需要外部核心转换（§1.2.2）。

**GoProxy 实例对接（原第 4 来源，2026-09-05 摘牌）**：设计之初它是「必选依赖」→ IP-2/3 内建了免费源抓取与订阅解析后降为「四来源之一」→ **IP-3 交付后其残余价值归零**：三个用户画像里（已有 Clash → pinned 覆盖；已有 GoProxy → 这类用户装 sing-box 单文件零负担，IP-4 覆盖；全新用户 → 它的安装门槛 Go1.25+CGO/Docker 比 sing-box 还高）没有一个需要它。维护成本（API 变动跟随、它与我们不一致的出口质量标准、多一个来源的文档面）> 残余价值。**IP-5 从分期删除**；触发条件记录进 §8 backlog（真实用户反馈「已在跑 GoProxy 且不想装 sing-box」时再补，那是一个 30 行的 API client）。

三类来源在出口表里统一为 `source: 'free' | 'manual' | 'subscription'`，下游（健康、选择、路由）不区分来源（pinned 标记除外，§3.6）。

#### 1.2.1 订阅解析层：纯 TS 内建（抄 GoProxy parser）

抄 `custom/parser.go` 的三格式自动识别（无需用户选格式）：

| 格式 | 识别方式 | 解析 |
| --- | --- | --- |
| Clash YAML | looksLikeYAML + proxies 键 | 逐节点取 name/type/server/port + 原始字段 |
| 协议链接 | vmess://、vless://、trojan://、ss:// 等前缀 | 逐行解析 URI（vmess 是 base64 JSON，其余是 URI 参数） |
| Base64 | 整体 base64 解码后再按协议链接解析 | 两跳解码 |

解析产物统一为 `ParsedNode { name, type, server, port, raw }`（GoProxy 同构），分两路：`type ∈ {http, socks5}` → 直接进出口表走准入探测；其余 → 待转换清单（§1.2.2）。订阅刷新（默认 30min + 手动）只重拉 URL 重跑解析，断路器同免费源。机场订阅动辄几十节点，准入探测照 §4.5 全链走（机场节点质量参差，冒烟一步不能省）。

#### 1.2.2 订阅拨号层：明文直拨，加密节点需要外部核心

技术边界（2026-09-04 实测 npm 生态）：

- **明文 http/socks5 节点**：undici 原生拨，进程内闭环，零依赖。
- **加密协议（vmess/vless/trojan/hysteria2/anytls，机场订阅的主体）**：Node 生态**没有可用的纯 JS/wasm 栈**——npm 上的 `sing-box` 包是 211 字节占位符；vmess/vless/trojan 客户端只有 React Native 的 Xray binding（react-native-nitro-xray-core，宿主不符）；shadowsocks-js 停更多年。自写协议栈 = 每协议数百行密码学+传输实现 + 持续跟进协议演进，明确不做。

所以加密节点走「外部核心转换成本地 SOCKS5，再按明文处理」的路线，与 GoProxy 的 sing-box 用法完全同构。转换核心二选一，设置页自动探测（有哪个用哪个，都无则明文照常、加密节点标「待转换」灰显）：

1. **sing-box standalone**（官方二进制，用户自装，`sing-box` 在 PATH）：我们生成最小 config（每节点一个本地 SOCKS5 入站，端口 30000+ 递增——GoProxy singbox.go 同构），spawn 为子进程，按需重载。**这是本插件唯一会 spawn 的外部进程**：用户显式配置订阅加密节点才拉起；「spawn 外部已有二进制」与「打包原生二进制进 npm 包」是两回事，后者才是被淘汰的分发问题（§1.4）。
2. ~~**GoProxy 实例**~~（原选项 2，2026-09-05 摘牌）：内建能力覆盖后残余价值归零（§1.2）；外部核心只剩 sing-box standalone 一条路。

**「我们历史上外挂过 Go（legacy/ sidecar），是不是自己写个 Go 端更好做？」——不。要外挂的是 sing-box 这个进程，不是「我们的 Go」**

这个推论很诱人（legacy/ 里确实有完整的 Go sidecar 工程经验：spawn/看护/READY 握手/崩溃熔断全套现成），但中间加一层自己的 Go，两头都是亏的：

| 维度 | 直用 sing-box（TS 直接生成 config + spawn） | 自写 Go 端再包 sing-box |
| --- | --- | --- |
| 我们要写的代码 | 生成 JSON config + spawn 看护（~200 行 TS，看护直接复用 agent-process.ts 的成熟模式） | 同样要写 config 生成与看护（Go 侧），**外加**：IPC 协议、版本对齐、双语言调试、CI 双矩阵 |
| 协议跟进 | sing-box 升级换二进制即得（用户自己换，我们无感） | 新协议/协议变更 → 改我们的 Go 代码 → 发版 npm → 全用户升级链路 |
| 生态对标 | GoProxy 自己都不内嵌 sing-box 库，而是**托管 sing-box 二进制进程**（custom/singbox.go）——专职项目都做了这个取舍 | — |
| 已有资产复用 | ✅ legacy/ 的 spawn/看护模式平移到 TS 直接用（agent-process.ts 就是它） | 名义上复用，实际引入「Go 进程 ↔ Node 进程」一层新边界问题 |

中间层的唯一理论收益是「不用管 sing-box 的 config 格式」——但 config 本来就是我们生成的（数据流单向：TS 解析订阅 → 生成 JSON → sing-box 读），没有反向同步问题。**结论：外挂进程 = sing-box 官方二进制，由 TS 直接托管；「我们的 Go」不复活。** 历史经验真正值钱的部分（进程看护、READY 握手、崩溃熔断——agent-process.ts 已经是 TS 版）全部复用。

**为什么轮换必须自己托管 sing-box、不能借道用户的 Clash（深层理由：可寻址性，不只是协议拨号）**

「每节点一个本地端口」买的不是「能拨加密协议」这一件事，而是**轮换引擎的全部语义前提**：

| 轮换语义 | 经自托管 sing-box（每节点一端口） | 经 Clash 混合端口（7897） |
| --- | --- | --- |
| 指定「这次请求走节点 X」 | ✅ 请求 → X 的专属端口 | ❌ 单端点，节点选择权在 Clash 手里 |
| 出口 IP 可知且稳定 | ✅ 探活拿到 X 的真实 exitIP，路由键成立 | ❌ Clash 自动切换/负载均衡后 exitIP 随时变，健康表无法按 IP 维度积累 |
| 429 → 冷却这个节点 | ✅ 冷却 X 的端口，pick 跳过它 | ❌ 只能冷却整个 Clash 端口 = 冷却用户全部流量 |
| 403 → 该节点×模型封禁 | ✅ 精确到 (X, M) | ❌ 同上，粒度不存在 |
| 「换下一个 IP 重发」 | ✅ §3.4 循环照常 | ❌ 无「下一个」可言 |

借道 Clash API（external-controller 换 select 组节点）同样否决：换组节点会**影响用户经 Clash 的全部流量**（侵入用户的 Clash 全局状态），且无法按请求粒度指定。mihomo 的 `listeners` 配置理论上支持「每个 inbound 绑定一个节点」，但要求用户手改自己的 Clash 配置、且订阅刷新后节点改名全部失效——不产品化，仅作脚注。

结论：**Clash 端口的唯一正确位置是 pinned（§3.6，把节点选择权整体委托给 Clash）；一旦要「轮换机场 IP」，必须走自托管 sing-box（本节）**。两条路线按需分流，互不替代。

订阅 URL 与解析出的节点清单持久化在 settings（脱敏：URL 不回显明文）；转换映射（节点→本地端口）内存态，重启重建。

### 1.3 从 GoProxy 吸取什么：抄「设计」，不接「实例」（对接已于 2026-09-05 摘牌）

两问分开答：

**（对接已于 2026-09-05 摘牌——见 §1.2；下表是当初的吸取审计，仍然成立）**

**内建免费池与订阅需要从它吸取的**（免费源部分此前已定为「抄设计」，订阅部分本轮修订新增）：

| GoProxy 组件 | 我们的对应物 | 抄什么 |
| --- | --- | --- |
| `fetcher/` 26 个源 URL + 断路器 | `src/pool/sources.ts` | 源清单照搬；断路器语义（连续 N 失败禁源 + 冷却恢复）照抄，SQLite 换内存 Map |
| `validator/`（连通→ip-api.com 出口 IP→地理过滤→HTTPS CONNECT） | Prober 准入探测（§4.5） | 验证链路照抄：出口 IP 必须拿到（它同时是路由键）、HTTPS 隧道必须通（上游是 HTTPS）、地理黑名单可配 |
| `pool/manager.go` 四态状态机 | `ExitPool` 的 refill 调度（§3.5） | determineState/NeedsFetch 的阈值思想照抄（emergency 全源强抓 / refill 快源补充 / healthy 不抓），双协议槽位简化为单池 |
| `checker/` + `optimizer/` 定期巡检 | 周期探活（§4.3） | 已有对应设计，无需新抄 |
| `custom/parser.go` 三格式订阅解析 | `src/pool/subscription.ts` 解析层（§1.2.1） | Parse/parseAutoDetect/parseClash/parseBase64/parsePlain 的结构与识别启发式照抄为 TS（纯文本处理，无 Go 依赖） |
| `custom/singbox.go` 外部核心托管 | `src/pool/singbox.ts`（§1.2.2） | 「每节点一个本地 SOCKS5 入站、端口递增、按需重载」的托管模式照抄；子进程健康检查与软删除同构 |
| `storage/` SQLite | 不抄 | 内存态（§3.2）；重启重抓可接受（免费源分钟级更新；订阅清单持久化在 settings） |

**明确不抄的**：它的 WebUI/管理面与 SQLite。加密协议**栈本身**（vmess 密码学、TLS 指纹等）不自写——由 sing-box standalone 承担（§1.2.2）。

### 1.4 「要代理池就得挂个 Go 端吗？」——分层答案：核心纯 TS，加密订阅按需外挂

**一句话：插件本体 100% 纯 TS 原生（零原生依赖、零常驻子进程、零外部服务），五分之四的功能路径完全不碰任何 Go 端**：

| 功能路径 | 需要什么 | 纯 TS？ |
| --- | --- | --- |
| 免费源抓取 + 准入 + 池状态机 | Node 拉文本清单、undici 拨明文代理 | ✅ 进程内闭环 |
| 手填明文代理 / **pinned Clash 端口** | undici 原生 HTTP 代理支持 | ✅ 进程内闭环（Clash 用户注意：Clash 本身就是你已有的「端」，我们只连它的 7897 端口，不感知它的存在形态——本质与手填专线无异） |
| 订阅解析（三格式）+ 订阅里的明文节点 | 纯文本解析（§1.2.1） | ✅ 进程内闭环 |
| 探活 / 两层健康 / 自动路由 / 设置页 | 全部本设计的新增层 | ✅ 进程内闭环 |
| **订阅里的加密节点**（vmess/vless/trojan/hysteria2/anytls） | 协议拨号栈，Node 生态没有（§1.2.2 实测） | ❌ 唯一例外，两条外部路径按需选一 |

加密节点的两条外部路径（按用户画像自然分流）：

1. **本机已有 Clash/mihomo 等代理客户端**（国内用户最常见）：直接填它的混合端口做 pinned（§3.6）或订阅在 Clash 里导入——加密协议由它拨，我们只见本地明文端口。**对这类用户，答案就是「纯 TS，什么都不用装」**。
2. **装一个 sing-box standalone**（官方单文件下载，无编译无 Docker）：仅当用户想把机场订阅喂给我们的池子做轮换时需要；我们生成配置、spawn 子进程托管（这是**插件唯一会拉起的子进程**，且只在订阅含加密节点时）。注意「spawn 用户自装的二进制」≠「npm 包分发原生二进制」——后者才是当年淘汰 Go sidecar 的分发问题，前者与 DSH spawn 它自己的子进程无异。

为什么加密协议不自写（即使理论上 vmess/trojan 的密码学原语 Node 都有）：每个协议数百行传输+密码学实现 × 六种协议 × 持续跟进上游协议演进（vless reality、anytls 都是近两年新出的），这是一个专职开源项目（sing-box/Xray）的维护量级，塞进插件等于养第二个代理核心。边界清晰：**协议拨号外包，调度与智能全归我们**。

### 1.5 评审必问：「既然 GoProxy 的功能我们都要，为什么不直接用它（必选）？」

三个事实把这笔账算清：

**事实一：即使必选 GoProxy，我们 ~80% 的代码照写。** 我们的增量价值——按出口建 ProxyAgent 的路由层、两层健康（出口冷却 + 模型封禁）、探活引擎、换 IP 重试、设置页——GoProxy 一个都没有。而且它的对外端口（7777/7776）是轮换黑盒：同一请求 429 后它可能再轮回同一出口 IP，从外面根本做不了「IP×模型」粒度的冷却与封禁（必须读 `/api/proxies` 拿到每个出口的独立地址、自己按出口建 agent——§2）。所以「直接用」与「可选对接」在我们这层的工作量**完全一样**，差别只在出口清单从哪来。

**事实二：「功能我们都要」不成立——要抄的只是它的极小子集。** 账目：

| GoProxy 功能 | 内建版（抄设计） | 直接用它（必选） |
| --- | --- | --- |
| 免费源抓取（26 源清单） | ~250 行 TS | 0 行 |
| 验证链 + 源断路器 + 四态状态机 | ~350 行 TS | 0 行 |
| 订阅解析（三格式自动识别） | ~400 行 TS | 0 行 |
| 加密节点拨号（sing-box 托管） | ~200 行 TS（托管外部核心，不自写协议栈，§1.2.2） | 0 行 |
| WebUI / SQLite 持久化 / 对外 4 端口 / 代理认证 / 优化器 | **不做** | 0 行 |
| 探活·健康·路由·设置页（真正的增量） | ~2000 行（两边都一样） | ~2000 行（一样跑不掉） |

内建池 = 抄它约 **1200 行**，换「免费源 + 订阅明文节点零部署；加密节点装一个单文件 sing-box」——三个角色全部内建后，GoProxy 实例对接已无残余价值（摘牌记录见 §1.2），它不再是「功能的获取方式」而是纯粹的参考实现。

**事实三：部署门槛恰恰挡住目标用户。** GoProxy 本地运行要 Go 1.25 + CGO（go-sqlite3 编译）或 Docker（其 README 明示；无预编译 Windows 二进制）。Windows 无 Docker 的用户基本装不动。而「免费模型可用性」主张吸引的恰恰是**不想折腾服务的普通用户**；重度的极客用户由 sing-box 单文件路线覆盖（GoProxy 对接已摘牌）。

**结论**：直接用（必选）省 1200 行代码，代价是把全部用户挡在部署门槛外，且核心层一行都省不下。当前定案（内建免费源 + 订阅 + GoProxy 可选对接）是「大众零门槛、极客全功能」的分层覆盖。**反向决策路径也记录在案**：若产品定位收窄为「面向已有代理池/订阅的极客」，砍掉内建池、GoProxy 升为必选，可省 ~30% 工作量——这是定位决策而非技术决策，届时由 README 的目标用户画像触发重审。

## 2. 路由层设计（PoolRoutingDispatcher）

仿 dsh-llm-proxy `RoutingDispatcher`（150 行）的**形态**，但选择逻辑从「host 是否命中静态集合」改为「host 命中 + 当前选哪个出口」：

```
dispatch(opts, handler) {
  host = normalizeHost(opts.origin)
  if (!enabled || host !== 'opencode.ai') return direct.dispatch(opts, handler)
  exit = pool.pick(session(opts), currentModel())  // §3.3；session 从入站头解析，model 从 AsyncLocalStorage 读（不上行）
  if (exit === null) return direct.dispatch(opts, handler)   // 池空/全冷却 → 直连
  return exitAgents[exit.id].dispatch(opts, handler)
}
```

与 dsh-llm-proxy 的三点差异（都是需求差异倒逼的）：

1. **出口多实例**：dsh-llm-proxy 只有一个 `ProxyAgent`（单一 Clash 端点）；我们要按出口建 `ProxyAgent`（undici `ProxyAgent` 支持每个实例独立 uri），并带 LRU 淘汰（池子可达百级节点，连接是惰性建立的，LRU 上限默认 16 个活跃 agent）。
2. **失败要能「换出口重试」**：undici 官方 `RetryAgent` 只会重放给同一 agent；换出口重试在我们这层做（§3.4），**不叠 RetryAgent**——匿名通道重试语义本来就该我们管（401/403/429 不是网络错误，是限额信号）。
3. **连接池参数**：抄 dsh-llm-proxy 实测出的坑——ProxyAgent 内部池默认 keep-alive，Clash 类代理会静默关闭空闲 CONNECT 隧道导致请求挂死；用 `clientFactory: (origin, opts) => new Pool(origin, {...opts, pipelining: 0})` 禁用代理侧复用（其 routing-dispatcher.js:76-79 的注释与数据 2/10 → 10/10）。

### 2.1 SOCKS5 出口

undici `ProxyAgent` 只说 HTTP(S) 代理。GoProxy 的 SOCKS5 端口（7780/7779）需要自定义 dispatcher：实现 undici Dispatcher 接口的 `dispatch/close/destroy/isMockActive` 子集，内部用 `socks-proxy-agent` 风格的 CONNECT 隧道——或者更省事：**走 GoProxy 的 HTTP 端口（7776/7777）即可**，它同样能转发到全部节点（GoProxy 的四个对外端口共享同一个 SQLite 池，`proxy/server.go` selectProxy 无协议隔离）。MVP 只做 HTTP 端口对接，SOCKS5 直连节点列为 backlog（§8）。

### 2.2 与 retry 的关系

现状 adapter 把 `maxRetries: 0` 传给 pi-ai（zen-adapter.ts:141），重试语义完全自管。保持该决策：路由层的「换出口重试」就是匿名链路唯一的重试，见 §3.4。

## 3. 出口池状态机（ExitPool）

### 3.1 数据模型

```ts
type ExitSource = 'free' | 'manual' | 'subscription'  // goproxy 类型保留仅为兼容既有 ExitSource 联合（来源已摘牌，§1.2），新代码不再产生

interface ExitNode {          // 出口表条目；来源决定怎么进来（§1.2），下游一律同质
  id: string                  // address（host:port，池内唯一）
  protocol: 'http' | 'socks5'
  source: ExitSource
  pinned: boolean             // §3.6：固定出口标记（专线/手填主力节点）
  exitIP: string              // 准入探测（§4.5）必填：它既是展示信息，也是「换 IP」的路由键
  exitLocation: string        // "国家代码 城市"（ip-api.com）
  latencyMs: number
  quality: 'S' | 'A' | 'B' | 'C'   // GoProxy 分级照搬：S≤500 / A≤1000 / B≤2000 / C>2000ms
  addedAt: number             // 准入时间；免费节点按「入池时长」参与淘汰
}
```

**为什么 exitIP 必填**（与 GoProxy 同判）：匿名配额按出口 IP 计（design.md §3）。两个不同代理地址若中转同一出口 IP，对上游是同一个配额桶——路由与冷却必须按 exitIP 维度做，所以准入探测拿不到出口 IP 的节点直接不收（也天然去重）。pinned 节点同样要过准入拿 exitIP（去重与展示不能豁免；但专线在准入第 1-3 步失败时**警告而非拒收**——用户明说「我的专线就是通的」，可能是 ip-api.com 被专线屏蔽，此时 exitIP 允许为空、路由键退化为 address）。

### 3.2 两层健康：出口冷却 + 模型封禁（ExitHealth / ModelBan）

配额的两种「坏」要分开记（判定规则见 §4.2）：

```ts
// 第一层：per-exit（出口状态）。key: exitId
interface ExitHealth {
  state: 'unknown' | 'ok' | 'dead'          // 出口链路通不通（探测成功/连接失败/超时）
  lastProbedAt: number
  consecutiveLimited: number
  cooldownUntil: number                     // 429（出口级）指数退避截止
  inflight: boolean                          // §4.1：同出口探测串行的锁位
}

// 第二层：per-(exit × model) 封禁（只记「这个模型在这个出口被拒绝」）。
// key: `${exitId}\u0000${modelId}`
interface ModelBan {
  state: 'ok' | 'banned' | 'suspect'        // banned=403/401 已确认；suspect=首次异常待复核
  bannedAt: number
  consecutiveFailures: number               // suspect → banned 的确认阈值（§4.2）
}
```

- **第一层（429/传输失败）按出口记**：429 = 匿名配额按出口 IP 计（design.md §3），整出口冷却，请求换出口——这正是「限额后自动换 IP」。dead（连接失败/超时）= 代理本身烂了。
- **第二层（401/403）按出口×模型记**：403/401 多是模型级拒绝——区域封锁（如我们实测过 `muse-spark-1.2-contributor-free` 从本机 403 region-blocked）或下架（`hy3-free` 401 not supported，均见 catalog.ts 注释）。这类失败**不冷却整个出口**（同出口其他模型照常用），只把该 (exit, model) 标 banned，pick 时跳过。
- 两层都不持久化（内存态，重启重建；探活成本低）。backlog 同 §8。

### 3.3 出口选择（pick）

每次上游请求前同步调用，必须无 IO。输入 `(session, model)`，过滤条件叠加两层健康：

1. **pinned 优先**：存在健康可用（非 dead、非冷却、该模型未 banned）的 pinned 出口 → 直接选它，跳过轮换池。专线/Clash 端口场景的本质是「我的出口比任何免费 IP 都好」，轮换反而是劣化。pinned `strict: true` 时**甚至不进入 §3.4 的失败换出口循环**——失败直接透传（§3.6 行为契约）。
2. 过滤：第一层非 `dead`、不在冷却期；**该 model 在该出口无 banned 封禁**（第二层）。全部被 ban → 当作该出口对该请求不可用，继续看别的出口。
3. 排序优先级：健康 `ok` 优先 → `consecutiveLimited` 升序（先用没怎么被限的）→ `latencyMs` 升序 → 随机扰动（同优先级打散，避免雷群）。
4. **会话粘性**：同一 DSH 会话（x-opencode-session 同值）优先复用上次出口——匿名通道对 session id 有亲和（x-session-affinity 头），频繁换出口可能被视为异常流量。粘性失效条件：该出口进入冷却/dead/对该请求的模型 banned。
5. 全部不可用 → 返回 null → **直连**（never fail closed：池子是增强，不是依赖；strict 模式无此兜底，§3.6）。

「当前请求的 model」从 AsyncLocalStorage 读（stream 入口 set，dispatch 时 get，不上行到 pi-ai）：pi-ai 的请求体构造与 HTTP dispatch 分属两层，没有现成的「这次 fetch 是哪个模型」通路，ALS 是唯一干净的 per-request 上下文 seam。

### 3.4 失败换出口重试（「自动路由」的核心，限额/被拦后自动换 IP）

这是用户可见语义的直接实现（§0 的三条链路）。发生在**流开始前**的失败（fetch reject / 非 2xx 响应头阶段）：

```
if (pinned?.strict) → 一次 upstream(pinned)，任何失败原样透传，不进循环（§3.6）
attempts = 0
loop:
  exit = pick(session, model)               // 已被冷却/封禁过滤的出口不会再被选中
  if exit == null: 尝试 direct 一次，仍失败 → 返回原始错误（透传上游状态码，design.md §6.2 不变量）
  try upstream(exit) → 2xx：markOk(exit[, model]); 返回流
  catch/非2xx:
    if 429   → markExitLimited(exit); continue   // 「这个 IP 对该模型到限额了」→ 冷却 E，下一个 IP 顶上
    if 401/403 → markModelSignal(exit, model); continue  // 「这个 IP 被(地区/白名单)拦」→ E×M 记嫌疑，换下一个 IP
    if 传输错误/5xx → markDead(exit); continue     // 代理本身烂 → 淘汰路径，换下一个 IP
    if attempts >= maxRotateAttempts (默认 3) → 透传最后错误
```

对用户的三种「不可用」分别落到三个机制上，互不混淆：**限额（429）→ 出口冷却**（同一 IP 其他模型不受影响，因为配额按 IP 计但 429 不标记具体模型）；**地区/白名单拦截（401/403）→ 出口×模型封禁**（该 IP 服务其他模型不受影响）；**代理故障 → 出口 dead**（与上游无关）。三条链全部走「标记 + 换下一个可用 IP 重发」，用户只看到对话正常继续。

**已开始流的 SSE 中途失败不重试**（body 已部分交付，重放会重复输出）。此时按 §4.2 规则表记信号（429 → 出口冷却；401/403 → 模型嫌疑；传输断 → dead），让下一次请求换路——诚实报错优于重复输出。

**不做**「流中断后自动从断点续写」：匿名通道无幂等语义，做不到安全重放。

### 3.5 池状态机与 refill 调度（内建免费池必需，抄 GoProxy 四态思想）

**「自动路由」确实需要池状态机**——路由负责「此刻选哪个 IP」，状态机负责「池子里还有没有 IP 可选、要不要去抓新的」。免费节点的死亡率极高（公开清单分钟级腐烂），没有它：池子慢慢漏空 → pick 永远返回 null → 静默退化成直连，用户毫无感知。抄 GoProxy pool/manager.go 的四态设计（determineState/NeedsFetch 的阈值思想），简化为单池单协议口径：

```
healthy ──可用数<95%──► warning ──可用数<30%──► critical ──可用数<10%──► emergency
   ▲                        │ 每轮 refill 后回升                                  │
   └────────────────────────┴─────────────────────────────────────────────────────┘
```

| 状态 | 判定（「可用」= 非 dead、非冷却、非全模型封禁） | 动作 |
| --- | --- | --- |
| healthy | 可用 ≥ 95% 目标容量 | 不抓取；周期探活维持健康（§4.3） |
| warning | 可用 < 95% | refill：快源抓取（fast 源清单）+ 准入探测 |
| critical | 可用 < 30% | refill + 放宽准入（延迟阈值放宽） |
| emergency | 可用 < 10% | 全源强抓（忽略源断路器，GoProxy emergency 同义） |

- **目标容量**（poolTargetSize，默认 20）：免费池不求大，够路由轮换即可——节点越多探测与巡检成本越高（R5 的消耗公式）。
- **准入-替换**（抄 GoProxy TryAddProxy/tryReplace）：新验证节点优于池内最差节点（C 级/最老）则替换；满员时拒绝准入（emergency 除外）。
- **淘汰**：dead 连续 N 次（§4.6 deadRetryMs 周期复核不过）直接出池；被封禁到「无任何可用模型」的节点同判。**只有 free 来源节点即删**（GoProxy removeOrDisable 对 free 同义），其余来源只禁用不删（见下条）。
- **manual/subscription 来源特殊对待**：手填与订阅节点**不参与淘汰替换**、不占目标容量配额（用户的东西不动）、dead 只禁用不删除（下次探测成功自动回池）。pinned 节点叠加同款豁免（§3.6）。
- 触发时机：refill 检查挂在周期探活同一节拍上（探活发现的死亡/冷却会即时改变「可用数」，两个循环共享一次状态计算，不打两份）。

免费源抓取本身（`src/pool/sources.ts`）只是状态机的执行器：按状态选源档（fast/slow/all）→ 拉文本清单 → 解析 host:port → 交给 §4.5 准入探测。**源断路器**照抄 GoProxy SourceManager（连续 3 次失败禁源 + 10min 冷却自动恢复，SQLite 换内存 Map）；emergency 态无视断路器强抓。

### 3.6 固定出口（pinned）：专线/主力节点，两种固定强度

**用户场景**：「我有专线（或一个稳定的付费代理/本机跑着的 Clash），根本不需要滚免费 IP——但也想保留免费池当备胎。」pinned 把选择权交还用户：**标记一个出口为主力，其余全部退化为兜底**。

**pinned 的三种来源形态**（设置页同一入口，都归一化为一个本地代理地址）：

| 形态 | 用户填什么 | 内部表示 |
| --- | --- | --- |
| 直接代理地址 | `http://1.2.3.4:8080` 或 `socks5://h:p` | 原样入表（manual 来源） |
| **Clash/mihomo 端口**（最常见：用户本机已经跑着 Clash，混合端口 7897/7890） | `http://127.0.0.1:7897` | 同上——**对路由层而言它就是一个本地明文代理**，Clash 在后面怎么选节点是 Clash 的事；我们的探活照常穿透它测「这个出口对匿名通道可用吗」，出口 IP 反映 Clash 当前命中的节点。Clash 换节点时出口 IP 变了，下一轮探活自动刷新（§4.3 周期 + 被动信号兜底）。**这是 pinned 最推荐的形态**：零订阅解析、零 sing-box，还白得 Clash 自己的故障切换/规则分流。**适用边界（§1.2.2）**：Clash 端口只配 pinned——它无法按节点寻址，自动路由/轮换机场 IP 用不了它，轮换需求走自托管 sing-box |
| 订阅/GoProxy 里的某个节点 | 出口列表行内「固定为主力」 | 该节点转 pinned（§3.6 来源标记不变） |

**两种固定强度**（`pinnedStrict`，设置页单选）：

行为契约：

| 场景 | `strict: false`（默认，主力+备胎） | `strict: true`（绝对固定） |
| --- | --- | --- |
| pinned 健康 | 全部流量走 pinned；其余来源闲置待命（低频巡检保持备胎可用，pinned 探测频率减半） | 同左，且轮换池完全不探测（连备胎巡检都省了，用户明说了不需要） |
| pinned 429（到限额） | pinned 冷却 → 自动落轮换池，到期自动回主力 | **不换**。透传 429 给 DSH 显示「匿名配额受限」——用户明确选择「宁可失败也不走别的出口」（比如只信任专线出口的合规/安全要求） |
| pinned 对模型 401/403（地区拦） | 该模型走轮换池，其他模型仍走 pinned | **不换**。透传错误（这类失败换出口也没意义——用户既然绝对固定，就要诚实看到失败） |
| pinned dead（断线/挂） | 轮换池顶上；恢复自动回主力 | **不换不直连**。透传传输错误——绝对固定下直连也是「未经用户授权的出口」，同样禁止 |
| 重试 | §3.4 换出口链路照常 | **maxRotateAttempts 无效**（没有第二个出口可换），传输错误不做自动重试 |

要点：

- pinned 是 **ExitNode 上的标记**而非独立来源：manual 手填的专线/Clash 端口、订阅里的稳定节点、GoProxy 里的节点都可以 pin。
- **Clash 端口形态的诚实边界**：出口 IP 由 Clash 决定且随时可能变（它有自己的负载均衡/自动切换），所以该形态下「按 exitIP 冷却」语义退化为「按本地端口冷却」——Clash 换了节点后 429 可能已不成立，冷却到期自然重试即可，不需要我们去感知 Clash 内部状态。文档与设置页说明这一点。
- **strict 的存在理由**：不是所有限流规避都该自动兜底——有的用户出口选择是**安全/合规要求**（公司专线、只信任特定司法区出口），静默换到免费公共代理反而违背用户意图。strict 把「换不换」的决定权还给用户，代价是失败可见（这是 feature 不是 bug：诚实报错优于静默走未授权出口）。
- **只 pin 一个**（MVP）：多 pinned 策略是 backlog（见 §8）。
- pinned 节点**永不淘汰**、不占 poolTargetSize 配额（§3.5 豁免）。
- 语义 honesty：`strict: false` 不是「绕过限流」——专线 429 一样冷却换路。文案：「固定主力出口，其余来源作为备胎」/「绝对固定：失败也不切换出口」。

## 4. 探活引擎（Prober）

探活回答一个问题：**这个出口现在能不能把请求送到匿名通道、能送哪些模型**。结论写进两级健康表（§3.2），路由层据此选出口。

### 4.1 探活的并发与模型范围（定案 2026-09-04；2026-09-05 修订约束 2 的适用范围）

硬约束，实现时不要「优化」掉：

1. **同一出口（IP）串行**：同一出口的探测任务（哪怕测不同模型）排队执行，上一发返回（或超时）才发下一发。同一个 IP 的配额是共享桶，并发打它就是自己挤兑自己。
2. **不同出口并发，但有全局上限**：不同出口 IP 的配额各自独立，可以并发；`maxConcurrentProbes`（默认 **3**）封顶。**修订（2026-09-05）：此约束的保护对象是「碰 Zen 匿名通道的请求」（探活步骤 3/4、细筛），不适用于粗筛**——粗筛（步骤 1/2，只打野生候选与公共 IP 服务）走独立的暴力并发 `admissionFanout`（§4.5 分层修订），野生代理无账号无封号风险（GoProxy ValidateConcurrency=300 同判）。**订阅/机场节点永不参与暴力并发**（用户付费账号资源，封号风险），它们只以受控方式探活。
3. **探活模型是小集合，默认 1 个**：`probeModels` 默认取 S3 静态清单第一个（`catalog.ts:staticFreeModels[0]`，当前 `big-pickle`）。用户可以加（比如主用 muse，就把 `muse-spark-1.2-contributor-free` 填进去）——多个探活模型在**同一出口内仍串行**（约束 1 覆盖）。不做全模型 × 全出口扫描（50×100=5000 请求 = 配额自杀）；想验证别的模型就发一条真实消息，被动信号会记进健康表。

实现要点：Prober 是一个**两级调度队列**——外层 `maxConcurrentProbes` 个工位，内层 per-exit FIFO（出口在飞探测数 ≤ 1，由 §3.2 `inflight` 锁位表达）。探测顺序：同一出口的多个模型连续探完（省得反复抢同一出口的锁），不同出口交错推进。设置页点「批量探活」看到的是队列进度（x/y），点单出口「探测」是该出口的一次插队（仍遵守串行与全局上限）。粗筛（§4.5）不经 Prober——它是纯代理侧的 TCP/HTTP 探测，不碰匿名通道，用独立的 fanout 池执行。

### 4.2 探测请求与判定规则

```
POST {zen}/v1/chat/completions
{ "model": <probeModels 中的下一个>, "messages": [{"role":"user","content":"ping"}], "max_tokens": 1 }
```

- 1 token、非流式、timeout 8s。**明确不算「绕过付费」**：消耗的是匿名通道自己的免费配额，与正常使用同性质，只是被我们主动花掉一点点用于探测。
- 探测**必须在宿主侧**跑（走全局 dispatcher，与真实流量同路径），设置页按钮经 bridge（§5.3）触发。

按响应分层判定（与 §3.4 被动信号同一张规则表）：

| 探测结果 | 写入 | 语义 |
| --- | --- | --- |
| 2xx | ExitHealth.ok + ModelBan(entry).ok | 链路通、该模型可用 |
| **429** | ExitHealth.cooldownUntil += 指数退避（§4.6） | **出口级**：配额按 IP 计，整出口冷却 |
| **401 / 403** | ModelBan(entry, model)：首次 suspect → 连续 2 次 banned | **模型级**：区域封锁/下架/白名单不含该模型。不冷却出口——同出口换别的模型照常探 |
| 5xx / 传输错误 / 超时 | ExitHealth.state = dead（deadRetryMs 后可重探） | 出口链路问题（代理烂），与限额无关 |

- suspect（首次 401/403）期间照常可用（可能是瞬时抖动），banned 才被 pick 跳过。
- 被动信号（真实请求成败）与探测共用这张规则表与两级健康结构；真实请求已经给出的结论，周期探活只补空白，不重复轰炸。
- `GET /v1/models`（目录刷新）不影响出口结论。

### 4.3 触发时机

| 触发 | 内容 | 频率 |
| --- | --- | --- |
| 启动/启用后首轮 | 全出口 × probeModels（两级调度，§4.1） | 一次性 |
| 周期 | 冷却到期的 + 从未探过的（新入池出口）+ suspect 待复核的 | 默认 10min |
| 按需 | 设置页单出口「探测」/「批量探活」按钮 | 用户点击 |
| 被动 | 真实请求的成败写入两级健康（免费的探活） | 每次请求 |

### 4.5 准入探测（admission probe，免费候选节点进池前的验证）

免费源拉来的候选不直接进池——**准入探测通过才成为 ExitNode**。抄 GoProxy validator/validator.go 的验证链，压缩为我们需要的最小序列（每步失败即弃，不浪费后续步骤）：

| # | 步骤 | 打的是谁 | 拿什么 | 弃用条件 |
| --- | --- | --- | --- | --- |
| 1 | 连通 + 延迟 | **野生候选 + 公共 IP 服务**（无账号、无封号风险） | 经候选代理 GET ip-api.com（一石二鸟） | 连不上 / 超过 maxResponseMs（默认 3000，critical 态放宽到 6000） |
| 2 | 出口 IP + 地理 | 同上 | 同一响应体（query=IP + countryCode/city） | 拿不到 exitIP（§3.1 必填）；地理黑名单命中（blockedCountries，默认 `['CN']`） |
| 3 | HTTPS 隧道 | **Zen 匿名通道（碰配额）** | 经代理 GET `{zen}/v1/models` | 隧道建立失败 |
| 4 | 匿名通道冒烟 | **Zen 匿名通道（烧 1 token）** | §4.2 的 1-token chat | 4xx/5xx |

**并发边界按「打的是谁」分层（2026-09-05 修订，修正此前一刀切）**：并发约束的存在理由是**保护要保护的目标**，而不是保护候选本身——

- **粗筛（步骤 1+2）：暴力高并发**。`admissionFanout`（默认 **300**，与 GoProxy ValidateConcurrency 对齐）并行扫候选。理由：野生免费代理没有账号体系、没有封号风险、发布即被全世界爬虫扫描，它们本来就是拿来消耗的一次性资源；ip-api 的请求经各候选各自的出口 IP 发出，不共享我们的本机限流。
- **细筛（步骤 3+4）：维持克制**。只有粗筛幸存者（实测 ~1-3%）才走到碰 Zen 的步骤，且走 Prober 两级调度（同出口串行 + 全局 `maxConcurrentProbes` 上限）——这两步烧的是匿名通道配额，我们的核心资产。
- **订阅/机场节点永远不暴力**：它们是用户付费的账号资源，有封号风险；粗筛并发只作用于 free 来源候选（trusted 来源跳过粗筛直接细筛，见下）。

这个分层让「一轮 48k 候选」从不可能变成可行：粗筛 100 并发 × 3s 超时几分钟扫完一轮全量，幸存的几十个再花细筛的几十次配额请求。免费代理约 98%+ 死在步骤 1（TCP 不可达），烧配额的步骤只碰幸存者。

- **细筛并发**：与周期探活共享 `maxConcurrentProbes` 工位与两级调度（§4.1；同一候选地址在飞 ≤ 1）。状态机（§3.5）按「目标容量 - 现可用数」计算本轮准入额度，够了就提前终止。
- **manual/subscription 来源**：跳过粗筛与步骤 3（清单已含节点详情），只跑第 4 步冒烟；失败不禁用（可能是暂时的），只标 suspect。**pinned 节点例外**：准入失败也收（exitIP 留空、路由键退化为 address，§3.1），只在冒烟失败时警告——专线场景用户判断优先。
- **429 入池即冷却（2026-09-05 实测定案）**：冒烟 429 的候选是「好代理、Zen 隧道已验证、只是匿名配额此刻被别处消耗」（免费代理是全球共享出口，实测隧道通过者的一半以上死于 429）。这类候选**入池并立即 markLimited**：占池位但不计入可用配额（状态机保持饥饿，继续补真正可用的）、冷却到期由周期探活重试——别人的配额消耗是波动的，冷却后大概率恢复。产出效果：可用出口产量约翻倍。
- 准入通过的节点写 ExitNode + ExitHealth.ok，立即可被 pick。

### 4.6 参数（默认值）

| 参数 | 值 | 说明 |
| --- | --- | --- |
| probeModels | `[S3 首个]`（当前 `['big-pickle']`） | 探活模型集合；可加主用模型，同出口内多模型仍串行 |
| maxConcurrentProbes | **3** | 细筛/探活全局并发上限（碰 Zen 的请求，§4.1） |
| admissionFanout | **300** | 粗筛暴力并发（只打野生候选+IP 服务，不碰 Zen，§4.5；GoProxy ValidateConcurrency 同值） |
| probeTimeoutMs | 8000 | 单探测超时 |
| maxResponseMs | 3000 | 准入延迟门槛（critical 态放宽 6000） |
| probeIntervalMs | 10min | 周期探活 + refill 状态检查节拍（上一轮未跑完则顺延） |
| limitedCooldownBase | 60s | 首次 429 冷却 |
| limitedCooldownMax | 30min | 指数退避上限 |
| deadRetryMs | 2min | dead 出口重新探测间隔 |
| modelBanConfirmations | 2 | suspect → banned 确认次数（防瞬时抖动误杀） |
| maxRotateAttempts | 3 | 单请求换出口上限（§3.4） |
| poolTargetSize | 20 | 免费池目标容量（§3.5） |
| blockedCountries | `['CN']` | 准入地理黑名单（国家代码） |
| freeSourceEnabled | true | 免费源抓取总开关（关掉 = 只用 manual/subscription 来源） |
| subscriptionRefreshMs | 30min | 订阅刷新间隔（拉 URL 重跑解析，断路器同免费源） |
| pinnedStrict | false | 绝对固定模式（§3.6）：true 时 pinned 失败透传、不换出口不直连 |

全部进 settings namespace，设置页可调（maxConcurrentProbes 也开放：有些用户宁可慢也不并发）。

## 5. 设置页（DSH 设置 → 插件 → 可配置插件）

复刻 dsh-llm-proxy 验证过的三层结构，但按本机宿主实测裁剪（2026-09-05，`@deepseek-ai/dsh@0.1.1-rc.2`）：

- **settings 读写走官方通道，不建兜底**：rc.2 的 host-apiproxy `settings.describe/mutate` 对**所有已注册 namespace** 服务（源码核实无 allowlist；rc.6 才有硬编码清单），所以 dsh-llm-proxy 那套「官方 scope 不可用时切自建 bridge」的 compat 层我们**不做**——客户端直接 `ctx.settingsScope.bind({namespace: 'ip-pool'})`，写路径 `scope.set/unset`（字段级 path op，revision fencing 由 SettingsScopeController 负责）。
- **bridge 只补官方通道做不到的两件事**：池运行时没有 settings 对应物的读（`/status`：四态、出口表、封禁表、Prober 进度 x/y）与动作（`/probe`：批量探活/单出口探活/手动 refill 入队）。**探测与状态必须宿主侧跑**：要走真实 undici/凭据路径。
- 平台 seeds 实测（web-frontend dist 内核表）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`；`@deepseek-ai/dsh-client-runtime/client` 是 preload 图行（非 seed，但同样可 external）。

```
浏览器侧 React 卡片（settings.plugin.item slot，keyed by 'ip-pool'，lib/client.js 经 __ModuleLoader__ 注入）
   │ 配置读写：官方 settingsScope（apiproxy settings.describe/mutate RPC）
   │ 状态/动作：same-origin fetch
   ▼
宿主侧 bridge（webServer.register，/api/opencode2dsh/ip-pool/{status,probe}，loopback-only）
   │ 读 ExitPool/Prober/SubscriptionFetcher 活对象；动作入 Prober 两级调度队列
   ▼
settings namespace `ip-pool`（applies: live，保存即热更新：换 pinned/改订阅列表/改并发上限均不重启）

### 5.1 配置 schema（schemastery）

```ts
Config = Schema.object({
  enabled: Schema.boolean().default(false),
  probeModels: Schema.array(Schema.string()).default([]),  // 空 = [S3 首个]；可填主用模型（如 muse-…-free）
  maxConcurrentProbes: Schema.number().min(1).max(8).default(3),  // 跨出口并发上限（探活+准入共享）
  free: Schema.object({
    enabled: Schema.boolean().default(true),      // 免费源抓取总开关（§1.2 来源 1）
    targetSize: Schema.number().default(20),      // 池目标容量（§3.5）
    blockedCountries: Schema.array(Schema.string()).default(['CN']),
  }),
  manual: Schema.array(Schema.string()).default([]),  // 手填明文代理（§1.2 来源 2），'http://h:p' 或 'socks5://h:p'
  subscription: Schema.object({                   // 机场/自建订阅（§1.2 来源 3）
    urls: Schema.array(Schema.string()).default([]),   // 订阅 URL（回显脱敏）
    refreshMs: Schema.number().default(30 * 60 * 1000),
  }),
  singbox: Schema.object({                        // 加密节点转换核心（§1.2.2）
    path: Schema.string().default('sing-box'),    // sing-box 二进制路径（PATH 或绝对路径）
  }),
  pinnedExitId: Schema.string().default(''),       // 固定主力出口（§3.6；出口列表行内设置或此处直填地址）
  pinnedStrict: Schema.boolean().default(false), // true = 绝对固定：失败也不换出口、不直连（§3.6 行为契约）
  cooldown: Schema.object({ /* §4.6 参数 */ }),
  maxRotateAttempts: Schema.number().default(3),
})
```

订阅 URL 的脱敏边界（2026-09-05 定稿，§4.1 纪律延伸）：官方 `settings.describe` 必须回显完整值——表单要能编辑它，redact 会把字段变成只写。所以**脱敏发生在卡片渲染层**（显示 `前12字…后6字`），宿主 bridge 的 `/status` 不回显订阅 URL，日志沿用 `#redact`。明文只存 settings 文档（本机文件，用户自己的磁盘）。

### 5.2 卡片内容（React + CSS Modules）

| 区块 | 内容 |
| --- | --- |
| 总开关 | enabled 开关；「池状态」概览条（四态徽章 + 可用/容量 + 来源计数 free/manual/subscription + pinned 主力徽章） |
| 出口来源 | 三个来源子区块：免费源（开关 + 目标容量 + 地理黑名单 + 「立即补充」）；手填代理（textarea，增删）；订阅（URL 列表脱敏回显 + 刷新间隔 + 「立即刷新」+ 转换核心状态：sing-box 检测结果/待转换节点数） |
| 固定主力出口 | 直填地址框（placeholder：`http://127.0.0.1:7897`（Clash 混合端口）/ `http://专线:端口`，即填即 pin 为 manual 来源节点）+ 当前 pinned 展示（地址/出口 IP/状态）+ strict 单选（「主力+备胎（429/断线自动切换，恢复回归）」/「绝对固定（失败也不换出口、不直连）」）+ 解除固定按钮 |
| 探活模型 | 多选：当前免费目录（catalog.list()）+ S3 清单，默认选 S3 首个；说明文案「探测结论按出口计，建议加主用模型；同一出口内多模型串行探测」 |
| 并发上限 | maxConcurrentProbes 数字框（1-8，默认 3）+ 说明「不同出口并发，同一出口串行」 |
| 出口列表 | 每行：地址、来源、位置、延迟、质量级、出口 IP、状态徽章（ok/冷却中/dead/pinned）、单出口「探测」与「固定为主力」按钮；顶部「批量探活」按钮（两级调度跑，显示队列进度 x/y） |
| 模型封禁列表 | 折叠区：被 banned 的 (出口, 模型) 对及原因（403 region-blocked 等），供用户理解为什么某出口不服务某模型 |
| 探活参数 | §4.6 表格的可调项 |
| 文案 | 「匿名配额受上游限流；多出口不绕过配额，只在出口间调度。固定/订阅节点优先；公共免费代理有安全与合规风险。」 |

### 5.3 bridge（相比 dsh-llm-proxy 的裁剪）

dsh-llm-proxy 的 bridge 有四个面（describe/mutate/models/test），前两个是 rc.6 allowlist 逼出来的 settings 兜底。rc.2 宿主无 allowlist，我们只保留后两类面的思路：

- `POST /status`：池状态机快照——四态徽章 + 可用/容量 + 来源计数（free/manual/subscription）+ 两级健康（出口表：地址/来源/位置/延迟/质量/出口 IP/状态/冷却到期时刻 + 封禁表：(出口, 模型, bannedAt)）+ Prober 队列进度（enqueued/completed/inFlight/queued）+ refill 上轮摘要 + 订阅层状态（pendingConversion 数、convertedAdmitted、lastFetch、lastError——**不含 URL 明文**）。返回结构化 JSON，卡片 3s 轮询（探活进行中 1s）。
- `POST /probe`：`{scope: 'all'|'exit'|'refill', exitId?}`。`all`：全池出口 × probeModels 的周期探测一次（入 Prober 队列，返回队列长度，前端看 /status 进度）；`exit`：单出口插队探测；`refill`：手动触发一次状态机 refill 轮（免费源抓取+准入）。探测在宿主侧跑：走 Prober 两级调度（同出口串行 + 全局上限），不碰浏览器。
- 路由护栏照抄 dsh-llm-proxy settings.js：loopback socket + 规范 Host + same-origin 三重校验、JSON body 上限、`{ok, code, message}` 信封。**不做 settings 代理面**（官方通道在）。
- 卡片注册进 `settings.plugin.item`（keyed slot，`key: 'ip-pool'`——即 namespace 名）；`configurable` tab 按 namespace 取交集分派，卡片在官方 settingsScope ready 后渲染。

### 5.4 客户端构建

照搬 dsh-llm-proxy 的 tsdown 配置（tsdown.config.ts 全文可抄，但平台 externals 按本机 rc.2 seeds 核实）：`format: 'cjs'`、`platform: 'browser'`、`window.__ModuleLoader__.load({id, factory})` banner/footer、纯度门插件（非 seed 的 `@deepseek-ai/*` 值导入报错）、lightningcss 内联 CSS Modules。externals = 平台 seeds + `@deepseek-ai/dsh-client-runtime/client`（preload 图行，合法 external）。包的 `dsh` 字段加：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["slots", "locale", "settingsScope"], "platform": "web" }
}
```

（`remote` 不需要：没有跨 fiber 的 settings/document-updated 监听需求，官方 mirror 自己处理失效。）

构建链随版本走：tsdown 0.15（仓库现有 devDep）+ lightningcss 1.32（dsh-llm-proxy 同版）+ `@deepseek-ai/dsh-client-{runtime,locale,ui-slots,ui-primitives,ui-settings-plugins}@0.1.1-rc.2` 仅 devDependencies（类型与构建期 externals 对齐宿主；运行时由宿主 seeds 提供，不进生产依赖）。`build:client` 独立 script，`build`（宿主半）+ `build:client` 都进 `prepack`。

## 6. 文件落点（增量，不动现有结构）

```
packages/plugin/
├── src/
│   ├── pool/                          # 已交付（IP-0..4）
│   │   ├── dispatcher.ts              # PoolRoutingDispatcher（undici Dispatcher 子集）
│   │   ├── installer.ts               # setGlobalDispatcher 装卸/热更新（仿 makeInstaller）
│   │   ├── pool.ts                     # ExitPool（出口表+两层健康+四态状态机+pinned）
│   │   ├── prober.ts                   # 探活引擎（两级调度）
│   │   ├── admission.ts                # 准入探测（§4.5 粗筛+细筛）
│   │   ├── refill.ts                   # 状态机 refill 调度
│   │   ├── sources.ts                 # 免费源清单（26 URL）+ 拉取 + 解析 + 源断路器
│   │   ├── subscription.ts             # 订阅解析（Clash/链接/Base64 三格式，抄 GoProxy parser §1.2.1）
│   │   ├── subscription-fetcher.ts     # 订阅拉取+节点分路+受控探活
│   │   └── singbox.ts                 # sing-box 子进程托管（配置生成/端口映射/重载，§1.2.2）
│   ├── ip-pool-settings/              # IP-5 宿主半
│   │   ├── namespace.ts               # schemastery Config + ctx.settings.register('ip-pool') + watch 热更新
│   │   └── bridge.ts                  # webServer 路由（/status /probe，loopback-only）
│   └── client/                        # IP-5 浏览器半边（新）
│       ├── index.ts                   # slots.inject('settings.plugin.item', key: 'ip-pool') + scope 绑定
│       ├── IpPoolCard.tsx
│       ├── locales.ts                 # zh/en
│       ├── ip-pool.module.css
│       └── css-modules.d.ts           # 类型 shim
├── test/
│   ├── …（已交付 16 个套件）
│   ├── ip-pool-settings.test.ts       # namespace 注册/热更新/bridge 信封与护栏
│   └── client-build.test.ts           # lib/client.js 构建产物形态
└── tsdown.client.config.ts            # 从 dsh-llm-proxy 抄改（rc.2 seeds 对齐）
```

zen-adapter.ts 改动极小：`stream()` 里把 pi-ai 的 `maxRetries: 0` 保持，失败语义交给 dispatcher 层；可选地把「当前请求命中哪个出口」通过事件暴露给设置页运行统计（`probe` 之外的被动数据）。

## 7. 分期（plan.md 增量）

**零外部依赖即可用**：免费源 + 手填代理 + 订阅明文节点进程内闭环。加密订阅节点需要 sing-box standalone（单文件，设置页给下载指引）或已有 GoProxy——二选一，都没有时加密节点灰显「待转换」，明文节点照常。GoProxy 对接（可选来源）需要用户实例在跑；未部署跳过即可。

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| IP-0 | dispatcher + pool（两层健康 + 四态状态机 + pinned）+ prober（两级调度 + 准入探测）+ sources（拉取/解析/断路器）纯逻辑单测（不装全局 dispatcher） | node --test 全绿；调度断言「同一出口在飞 ≤ 1」「全局在飞 ≤ maxConcurrentProbes」；状态机断言四态迁移与 refill 触发；pinned 优先与回退链断言 |
| IP-1 | installer + adapter 接线（enabled 时才装全局 dispatcher）+ 手填代理来源 + **pinned（两种强度）** | 手填一个可用代理并 pin：全部流量走它；默认强度下模拟 429 后自动落轮换/直连、冷却到期自动回 pinned；strict 下模拟 429/断线，错误原样透传、绝不换出口也绝不直连 |
| IP-2 | 免费源抓取 + 准入探测 + 池状态机接入真实网络 | 开启免费源后池子自动填充到目标容量；批量探活两级调度正确；kill 一个代理节点，巡检后出池、refill 自动补位 |
| IP-3 | 订阅：解析层 + 明文节点直拨 | 填一个机场订阅 URL，明文节点入池可用，加密节点正确灰显「待转换」 |
| IP-4 | 订阅：sing-box 托管（加密节点转换） | 装了 sing-box 的机器上，加密节点自动转本地 SOCKS5 入池；kill sing-box 子进程自动重启、节点恢复 |
| IP-5 | settings namespace + bridge + React 卡片（三来源管理 + pinned + 出口列表 + 探活进度 + 封禁列表） | 设置页改任何项保存即生效无需重启 |
| IP-6 | ~~运行统计（被动信号展示）+ README「IP 池」章节 + 合规文案~~（2026-09-05 交付：dispatcher 层被动信号按 §4.2 规则表写入两级健康并计数，/status 与卡片出口表展示；README 中英双章节含合规/R1 共存） | 文档过目 |

依赖关系：IP-1（含 pinned）最简，先证明路由/换 IP/固定三条链；IP-2 免费池主战场；IP-3/IP-4 订阅两步走（解析先行，转换独立）；IP-5 独立于 IP-2-4 可并行。（原 IP-5 GoProxy 对接已于 2026-09-05 摘牌，见 §1.2 与 §8。）

## 8. 明确不做（backlog）

- **不接 GoProxy 实例**（2026-09-05 摘牌，§1.2）：内建能力覆盖其全部角色后的决策。**触发重审条件**：真实用户反馈「已在跑 GoProxy 且不想装 sing-box」——届时补一个 30 行的 `/api/proxies` 只读 client 即可。
- **不自写加密协议栈**（vmess/vless/trojan/ss/hysteria2/anytls 的拨号实现）：解析进插件（§1.2.1），拨号一律委托 sing-box standalone（§1.2.2）。npm 生态无可用的纯 Node 栈（sing-box 包为占位符、Xray binding 仅 React Native、shadowsocks-js 停更），自写 = 每协议数百行密码学 + 持续跟进演进，明确不做。
- **不做多 pinned 策略**（轮询/按模型/按延迟选主力）：MVP 只 pin 一个（§3.6）；真实需求出现时作为 §3.3 排序键扩展。
- **不做 SOCKS5 出口直连**（MVP）：免费源里的 socks5 候选暂不收（准入只走 http 候选）；订阅的 socks5 节点经本地转换端口后实际是 http 可拨的本地地址，不受影响。undici SOCKS5 dispatcher 列 backlog。
- **不做两级健康持久化**：内存态，重启重建（免费源分钟级更新；手填/订阅清单本来就在 settings 里持久化）。
- **不做全模型 × 全出口矩阵扫描**：probeModels 是小集合（定案 §4.1）。仅当实测确认需要更细粒度的模型级配额地图才重新评估。
- **不做流中断重放/断点续传**：匿名通道无幂等性。
- **不做「按模型路由到不同出口」的策略配置**：两层健康（出口冷却 + 模型封禁）已经覆盖「这个出口不服务这个模型」的客观情况；用户主观的模型→出口偏好映射不做。
- **不动 sidecar 模式**：`legacy/` 的 proxies 能力维持原样，不投入新开发。

## 9. 风险

| # | 风险 | 处置 |
| --- | --- | --- |
| R1 | 全局 dispatcher 与 dsh-llm-proxy（或其它装 dispatcher 的插件）共存 | **谁后装谁生效**对两者都是灾难（对方把我们的路由层整个短路）。缓解：installer 记录 previous 并在 dispose 恢复（dsh-llm-proxy 同款）；文档标注冲突可能；长期靠 DSH 官方提供 per-request dispatcher 注入点。**同装两个此类插件属不支持配置**，README 写明。 |
| R2 | 免费公共代理的安全风险（中间人、注入） | 上游是 HTTPS，出口代理只能看到 CONNECT 隧道目标域名，不能读内容；准入地理黑名单 + 设置页文案明示风险；freeSourceEnabled 可关。 |
| R3 | 上游把「多 IP + 同 session id」识别为滥用 | 会话粘性（§3.3）+ 探活低频 + 诚实文案；若被封禁，退路是关掉本功能（enabled off 回直连）。 |
| R4 | ~~GoProxy API 变动~~（来源已摘牌，风险随之下线；重审时再评估） | — |
| R5 | 探活消耗配额反噬正常使用 | 同出口串行（同一配额桶不自己挤兑自己）；跨出口并发默认仅 3 且可调回 1（准入共享该上限）；被动信号优先；probeModels 小集合 + 池目标容量 20 封顶巡检面；冷却期不重探。稳态单轮消耗 ≈ 池容量 × probeModels 数 × 1 token。 |
| R6 | undici 8.x ProxyAgent keep-alive 坑 | 已由 dsh-llm-proxy 踩平并给出修法（clientFactory + pipelining:0），照抄。 |
| R7 | 免费源 URL 腐烂（GitHub raw 限流/仓库跑路） | 26 源分散在 fast/slow 两档 + 源断路器自动跳死源；清单做成常量表随版本更新（抄 GoProxy 的清单维护方式）；全部源挂掉时状态机 emergency 暴力重试有上限，最终回直连不挂死。 |
| R8 | 免费代理把我们的请求代理到恶意中转（DNS 污染、假 200） | 准入第 3/4 步直探 Zen 真实端点（非通用测试站），假 200 过不了 chat 冒烟；HTTPS 证书校验不开（undici 默认校验 CONNECT 隧道内 TLS，代理无法伪造上游证书）。 |
| R9 | sing-box 子进程稳定性（崩溃/挂死/端口泄漏） | spawn 看护复用 agent-process.ts 的成熟模式（指数退避重启 + 连续崩溃熔断）；转换映射内存态，子进程重启后整表重建（本地端口重新分配，出口 agent 惰性重建）；插件 dispose 时整树回收。 |
| R10 | 订阅 URL 是用户敏感信息（机场账号凭证通常编码在 URL） | 只存 settings 文档（DSH 用户目录）；bridge describe 回显脱敏（仅尾段）；日志永不打印完整 URL；不回传任何远端。 |
| R11 | pinned 单点：主力出口故障期间用户未感知 | 默认强度：切换轮换池时设置页置顶提示（「主力出口冷却中，已临时切换」），恢复回归也提示一次。strict：故障本身就是用户要看到的信号（失败透传、绝不静默换路），设置页在 strict 生效时显示常驻「绝对固定已开启：失败不会自动切换」状态条，防止用户忘了自己开过 strict 而误以为插件坏了。 |
