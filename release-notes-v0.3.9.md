## 更新

- 修复禁用或卸载 IP 池出口路由后全局 dispatcher 不被还原的问题：安装时误从 `setGlobalDispatcher()` 的返回值读取被替换的 dispatcher，而 undici 8.x 该方法返回 `void`，导致原 dispatcher 从未被保存、`disable()` 永远跳过还原，`PoolRoutingDispatcher` 在插件卸载后仍霸占进程级槽位——此后进程内所有 `fetch`（包括其它无关 provider 的请求）都被继续劫持，卸载后一律报 `routing dispatcher closed`，只有重启进程才能恢复。现在改为换入前用 `getGlobalDispatcher()` 保存原 dispatcher，禁用时先销毁自身路由层再装回原 dispatcher；无可还原项时兜底安装新的 undici `Agent`，日志只在真正还原时才提示。
- 修正 `dispatcher.test.ts` 中掩蔽此 bug 的测试夹具（其 `setGlobalDispatcher` 桩返回了被替换的 dispatcher，与真实 undici 行为不符），并新增 `installer.test.ts` 回归覆盖安装/禁用/销毁/重启用期/幂等/外部 dispatcher 延迟与 `globalThis.fetch` 还原。

## 验证

- TypeScript 检查、252 项测试以及完整构建通过（PR #43 与 0.3.8 合并态）。
- 真实 undici 端到端：安装后槽位为 `PoolRoutingDispatcher` 并换入模块 fetch；禁用后槽位还原为安装前的同一 `Agent` 实例、`globalThis.fetch` 还原为内置实现，第三方请求（模拟其它插件）恢复 200。
- 根因确认：真实 undici `setGlobalDispatcher()` 返回 `undefined`，旧代码的 `instanceof Object` 保存门恒为 false。

## 贡献

来自 [eghrhegpe](https://github.com/eghrhegpe) 的 [#43](https://github.com/FishBottle7/opencode2dsh/pull/43)，保留原始提交。

## 升级

需要 DSH 0.1.7 或更高版本。web profile 可执行：

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin@0.3.9
```

安装后重启 DSH。
