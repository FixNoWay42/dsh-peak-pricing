# `@deepseek-ai/dsh-peak-pricing`

[English](README.md) | 中文

在配置的高峰计价时段内，将 agent 的模型请求路由到预设的廉价模型。

## 文档

- [安装文档](docs/installation.zh.md) — 环境要求与三种安装方式（monorepo / npm / 源码）
- [配置参考](docs/configuration.zh.md) — 全部配置字段、默认值、校验规则与示例
- [使用方法](docs/usage.zh.md) — 在 deepseek-harness 中挂载、行为确认、程序化调用
- [架构原理](docs/architecture.zh.md) — `agent/request` waterfall、prepend 顺序与时间语义
- [开发指南](docs/development.zh.md) — 命令、测试、构建与发布
- [常见问题](docs/faq.zh.md) — FAQ 与故障排查
- [示例配置](examples/cordis.yml) — 可直接挂载的 `cordis.yml`
- [`start.sh`](start.sh) — 交互式一键设置、安装与启用

## 概述

函数插件：在配置的高峰计价时段内，将 agent 的模型请求路由到预设的廉价模型，避免价格高峰命中昂贵的会话选型。切换是对已解析请求配置的逐请求实时变换，发生在 `agent/request` waterfall：高峰时段内，预设的 provider/model 组合替换会话解析出的结果；时段外，已解析配置原样返回。

时段是配置时区下每日的本地挂钟时间区间，起点包含、终点不包含。默认为北京时间（`Asia/Shanghai`，UTC+8，无夏令时），时段为 09:00-12:00 与 14:00-18:00。可选的 `effectiveFrom`（RFC 3339 即时点）控制开关生效时间：在此之前所有请求都不切换；此后（或不设置时立即）按时段生效。

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    timezone: Asia/Shanghai
    peakWindows:
      - start: '09:00'
        end: '12:00'
      - start: '14:00'
        end: '18:00'
    effectiveFrom: '2026-08-17T00:00:00+08:00'
    peak:
      provider: deepseek
      model: deepseek-chat
```

预设的 `provider`/`model` 必填，在加载时校验；未知时区、非法或空时段、无法解析的 `effectiveFrom`、缺失预设字段都会在插件挂载时立刻报错。`provider` 指向已注册的 LLM 路由（如 DeepSeek 适配器的 `deepseek`），`model` 是该路由服务的模型 id。可选的 `reasoningEffort` 仅在预设声明时应用；继承自已解析请求的 reasoning effort 会被丢弃（与 model-selection 语义一致）。

注册顺序很关键：插件以 `prepend` 在 agent 作用域上安装 `agent/request` 监听，所以它是最外层的 waterfall 变换，时段内压过会话的模型选型。时段外 `next()` 正常解析，会话选型生效。监听器挂在 agent 作用域上，随 agent 一起释放。

## 价目表与费用估算（Tariff and Cost Estimation）

插件内置 DeepSeek 官方价目表（`DEEPSEEK_TARIFF`），覆盖 `deepseek-v4-flash` 与 `deepseek-v4-pro`，按百万 tokens 提供高峰与空闲价格，分缓存命中输入、缓存未命中输入与输出三列（空闲价格为高峰价格的一半，来源为 [DeepSeek 定价页面](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）。价目表仅用于估算与日志——切换本身仍按挂钟时段判定，从不按价格判定。

当高峰时段把请求路由到预设模型，且被解析模型与预设模型都有价目条目时，插件会记录高峰价格对比日志（输入、缓存命中输入、输出，单位元/百万 tokens），可按实际 token 用量推导单次调用节省。纯函数 `estimateCost(usage, price)` 与 `estimateSaving(usage, resolved, peak)` 按价目条目对具体 token 用量计价，缓存命中与未命中的输入 token 分别按各自费率计算。配置键 `tariff` 可覆盖内置价目表（按模型合并），用于为自定义模型定价或刷新官方数字；条目在加载时校验（非负、有限价格）。

## 模型体验（Model Experience）

### 高峰时段模型替换

#### 模型看到什么

高峰时段内，每个请求携带预设的 `provider`/`model` 组合而非会话选中的模型；时段外，会话选型原样生效。切换本身不增加任何提示词文本、system 段落、工具或模型可见状态；生效的 `provider`/`model` 即 agent 循环已记录的常规请求解析结果。

#### Token 影响

切换到更便宜的预设是模型选型而非 token 变换：请求载荷、提示词与完成预算均不受影响。高峰请求按预设费率计费，非高峰请求按解析模型的费率计费。插件自身不产生任何 token。

#### KV Cache 影响

切换不改变请求前缀，按该 provider 的规则正常复用缓存。provider/model 切换会改变 provider 用于缓存命中的标识；若希望在高峰边界间复用缓存，请选择与默认模型同一条服务路由的预设。

## 已知限制与待办（Known Limitations and Deferred Work）

- **无计费集成**——价目表是仅用于估算与日志的静态可配置价格表；插件不获取实时价格、不对账发票、也不计量实际消费；`effectiveFrom` 是一次性全局生效日，不是计划表。
- **时区按挂载固定**——所有时段共用同一个 `timezone`；多时区部署需挂载多个插件实例（`name` 相同，请在 compose 文件中使用不同的包条目）。
- **不支持跨午夜时段**——`end` 不晚于 `start` 的时段在加载时被拒绝；22:00-02:00 这类时段暂时无法表达。
- **原始适配器绕过切换**——直接调用 `ctx.llm.stream()`、从不进入 agent 循环 `agent/request` waterfall 的消费者不受影响。
- **优先级取决于 waterfall 顺序**——若另一个插件主动以更外层注册 `agent/request`，会覆盖高峰预设；`prepend` 排序只对内置模型选型有保证。
