# opencode2dsh v0.3.10

## 更新

- **修复工具结果被误投成 user 消息、且永不发出 `toolResult` 的问题（[#50](https://github.com/FishBottle7/opencode2dsh/issues/50)）。** DSH 0.2（dsh-llm `0.2.0-rc.2`）的工具结果消息把调用 id 放在消息层（`role: 'tool'`、`toolCallId`、`source.callId`），content 是裸 text/image 块、没有 `tool-result` 包装块；而适配器只在 content 里找包装块，于是每个工具结果都被重投成一条幻影 `user` 消息、`toolResult` 槽位永远为空——模型自述"工具没有返回结果"（`No result provided`），并把工具输出误当成用户输入，`isError` 一并丢失。现在：不含 `tool-result` 块但带消息层调用 id 的消息只发一条 `toolResult`（绝不再推 user 消息）；包装块路径保持优先，DSH 0.1.x 宿主（`isError` 在块上）行为逐字节不变。
- **免费通道 429 突发不再打断对话（[#51](https://github.com/FishBottle7/opencode2dsh/issues/51)）。** 匿名通道按 IP 限额，热门免费模型（如 `step-5-preview-free` 高强度思考）的 429 突发会超出宿主默认重试预算（5 次、约 15s 窗口），把瞬时竞争抛成用户可见错误。适配器现在通过 `providerRetryPolicy` 钩子返回调优后的策略：8 次重试、1s→20s 退避、更宽抖动，每步最坏静默吸收约 91s（覆盖 IP 池实测的 ~60s 配额窗口）；重试仍由宿主执行（事件可见、可中止），确定性错误（AUTH/REGION_BLOCKED/INVALID_REQUEST）依然不重试。重度用户仍建议在插件设置页开启 IP 池做多出口轮换。

## 验证

- TypeScript 检查与 258 项测试通过（PR #52、#53 合并态）；两个修复均做红绿对照（新测试在旧代码上失败、修复后全绿）。
- 契约第一手核对：npm 实拉 `@deepseek-ai/dsh-llm@0.2.0-rc.2` 源码比对 `createToolResultMessage` 形态，与修复建模逐字一致。
- 真实 DSH `0.2.0-rc.2` CLI 对照实验（与 issue 环境一致，同口令同模型）：#50 对照组（npm 原版 0.3.9）逐字复现 `No result provided` + 幻影 user 消息，修复组工具槽位收到真实 stdout 且工具调用后无新 user 消息；#51 无重试基线 5/8 成功，新策略 6/6 + 8/8 全部成功（突发静默吸收），A/B 对照宿主默认策略单请求最坏卡 154.3s、新策略最坏 5.2s；`step-5-preview-free` + high 的多步工具任务端到端一次通过。
- 复现/验证工具随仓库提交：`test/live-issue51-probe.mts`（基线）与 `test/live-issue51-retry-check.mts`（`POLICY=default` 对照组）。

## 贡献

感谢 [AKAsaton](https://github.com/AKAsaton) 详尽的 #50 报告（含根因分析与补丁建议）和 [berial](https://github.com/berial) 的 #51 报告。

## 升级

需要 DSH 0.1.7 或更高版本。web profile 可执行：

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin@0.3.10
```

安装后重启 DSH。
