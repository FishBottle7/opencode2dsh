## 更新

- 图片输入能力读取 models.dev 的模型声明，支持声明了 `image` 的免费模型；只声明文本输入的模型仍保持文本模式。元数据缺失时保留此前已验证模型的图片支持。
- 新增 `firstEventMs`、`bodyIdleMs`、`responsesBodyIdleMs` 三个 adapter 超时配置，接受 `1` 到 `600000` 的整数毫秒值。默认首事件等待仍为 30 秒，聊天流静默为 120 秒，Responses 流静默下限为 300 秒。
- 将 `mimo-v2.6-flash-free` 加入静态免费模型回退名单和 IP 池探活选项。

慢速冷启动可以在 profile 的 `cordis.patch.yml` 中调大首事件等待窗口：

```yaml
- id: opencode2dsh
  name: '@opencode2dsh/dsh-plugin'
  config:
    firstEventMs: 120000
```

修改后重启 DSH。Responses 流静默窗口取 `bodyIdleMs` 和 `responsesBodyIdleMs` 中较大的值。

## 验证

- TypeScript 检查、236 项测试以及服务端和客户端的完整构建通过。
- 三项生产入口回归测试验证超时配置确实传到注册的 adapter；移除参数传递时三项测试均失败。
- DSH 0.2.0-rc.2 的实际模块加载器、Cordis 和 SlotCore 兼容性检查通过，包含 0.1.7 插件页槽位检查；浏览器服务和外部请求使用模拟实现。
- 发布包检查确认版本、导出、文档和安装内容正确。GitHub Release 附件与 npm 发布使用同一个安装包。

## 贡献

整合 [#34](https://github.com/FishBottle7/opencode2dsh/pull/34)、[#35](https://github.com/FishBottle7/opencode2dsh/pull/35) 和 [#36](https://github.com/FishBottle7/opencode2dsh/pull/36)，保留 alexhegit、djs-91 和 Swcmb 的原始贡献署名。

## 升级

需要 DSH 0.1.7 或更高版本。web profile 可执行：

```sh
dsh plugin --profile web add @opencode2dsh/dsh-plugin@0.3.7
```

安装后重启 DSH。
