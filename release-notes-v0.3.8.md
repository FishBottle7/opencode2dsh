## 更新

- 修复手动代理（`ipPool.manual`）按设置页要求的 `http://host:port` / `socks5://host:port` 格式填写时永远无法通过准入的问题：准入探测此前会在地址上再拼一次协议前缀，生成 `http://http://host:port` 导致 `ProxyAgent` 抛出 `invalid url`，出口 IP、位置、延迟、质量与地区/延迟门控全部静默失效（池表面仍显示 `state: ok`）。现在准入与路由共用同一个 URI guard，两种写法（带或不带协议）均能正确探测。
- 修复插件（重）加载后模型选择器停留在 7 个静态兜底模型的问题：注册时的首次模型列表读取现在会等待首次 Zen 拉取落定（有上限，默认 4 秒，与启动首刷共享同一轮请求），选择器拿到的是实时免费模型名单（如 `exo-free`、`space-bunny-free`），不再缓存已下架的 `mimo-v2.5-free`。断网时仍按上限快速返回静态名单，不会卡住启动。

## 验证

- TypeScript 检查、243 项测试以及服务端和客户端的完整构建通过。
- 真实 undici 回归：带协议的地址完整走完四步准入并填齐出口事实（出口与 issue #44 报告一致）；双协议输入得到干净的 `agent-build: invalid url` 拒绝，不再被静默吞掉。
- 真实时序回归：复刻 `applyAdapter` 的注册顺序，首次 `listModels` 在约 1.9 秒返回 13 个实时模型（`total: 87, exposed: 13`，与 issue #45 的 `adapter-status.json` 一致）；黑洞地址断网场景在 4 秒上限内返回静态名单。

## 升级

需要 DSH 0.1.7 或更高版本。web profile 可执行：

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin@0.3.8
```

安装后重启 DSH。
