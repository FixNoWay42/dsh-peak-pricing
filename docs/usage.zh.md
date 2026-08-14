# 使用说明

[English](usage.md) | [简体中文](usage.zh.md)

`@deepseek-ai/dsh-peak-pricing` 是一个 Cordis 函数插件（function plugin）：在配置的高峰计价时段（peak-price windows）内，把 agent 的模型请求路由到预设的廉价模型，避免价格高峰命中昂贵的会话选型。本页说明如何在 deepseek-harness 部署中配置它、如何确认它生效、如何程序化使用，以及如何排查问题。模型体验细节与已知限制见 README；以下内容以 `src/index.ts` 与测试为准。

## 典型场景：DeepSeek API 峰谷计价

DeepSeek API 的价格随一天中的时段变化，高峰时段的每 token 费率高于非高峰时段。以示例假设高峰时段为北京时间 09:00-12:00 与 14:00-18:00（这两个时段也正是插件默认值）。高峰时段内，插件把解析出的 provider/model 组合替换为预设的廉价模型（如 `deepseek-chat`），于是高峰窗口内的每个 agent 模型请求都按廉价费率计费；时段外继续原样使用会话选中（或默认）的模型。切换是对已解析请求配置的逐请求实时变换，发生在 `agent/request` waterfall：高峰时段内，预设的 provider/model 组合替换会话解析出的结果；时段外，已解析配置原样返回。

## 在 deepseek-harness 中配置

在 `cordis.yml` 中挂载插件条目，并把 `peak` 指向宿主已注册的 provider/model 组合——对 DeepSeek 适配器而言即 `provider: deepseek`、`model: deepseek-chat`。LLM seam、session、system prompt、tools、agent 注册表与 agent loop 都由宿主提供，插件只需要在它们之间占有一个条目。插件注入 `agents` 服务，`tests/loader-composition.spec.ts` 中的真实 Loader 组合把该条目放在 `dsh-agent` 之后、`dsh-agent-loop` 之前：

```yaml
- name: '@deepseek-ai/dsh-llm'

- name: '@deepseek-ai/dsh-session'

- name: '@deepseek-ai/dsh-system-prompt'

- name: '@deepseek-ai/dsh-tools'

- name: '@deepseek-ai/dsh-agent'

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

- name: '@deepseek-ai/dsh-agent-loop'
```

配置字段：`timezone` 是所有时段所依据的 IANA 时区，默认 `Asia/Shanghai`（北京时间，UTC+8，无夏令时）；`peakWindows` 是该时区下每日本地挂钟时间（wall-clock）的区间列表，每个起点包含、终点不包含，默认为 09:00-12:00 与 14:00-18:00，且 `end` 不晚于 `start` 的时段在加载时被拒绝（跨午夜时段无法表达）；`effectiveFrom` 是可选的 RFC 3339 即时点，在此之前开关永不生效，默认无（立即生效）；`peak` 必填，保存预设选型——`provider` 与 `model` 必填，可选的 `reasoningEffort` 仅在预设声明时应用，而继承自已解析请求的 reasoning effort 会被丢弃（与 model-selection 语义一致）。未知时区、非法或空时段、无法解析的 `effectiveFrom`、缺失预设字段都会在插件挂载时立刻报错（fail loud）。

## effectiveFrom：从某个日期起生效

`effectiveFrom` 是一次性全局生效日（RFC 3339 即时点），不是计划表。该时刻之前，即使落在时段内，每个请求也原样不动；从该时刻起（或不设置时立即）时段生效。判定是纯即时点比较：当 `now < effectiveFrom` 时，开关永不触发，与挂钟时间无关。用它对齐价格变更，例如 `'2026-08-17T00:00:00+08:00'` 表示从 2026-08-17 北京时间 00:00 起开始切换。

## 行为确认

高峰时段内，每个请求携带预设的 provider/model 组合；生效的选型就是 agent 循环已经记录的常规请求解析结果（model-visible ⟺ logged），所以可以通过会话请求 header 确认：

```ts
const header = agent.session.requestHeader()
console.log(header?.config) // 高峰时段内为 { provider: 'deepseek', model: 'deepseek-chat' }
```

时段外，已解析配置原样返回，请求 header 中显示会话选中的模型。切换本身不增加任何提示词文本、system 段落、工具或模型可见状态，也不改变任何 token——只改变模型选型，因此高峰请求按预设费率计费、非高峰请求按解析模型的费率计费。两个边界值得注意：时段起点包含、终点不包含，所以 12:00 不属于 09:00-12:00 时段、18:00 不属于 14:00-18:00 时段；直接调用 `ctx.llm.stream()`、从不进入 agent 循环 `agent/request` waterfall 的消费者完全不受影响——原始适配器调用整体绕过开关。

## 与模型选型（installModelSelection）的交互

运行时在 pre-publication 阶段、`agent/created` 触发之前就安装了会话的模型选型；高峰开关随后以 `prepend` 在 agent 作用域上注册 `agent/request` 监听，因此它是最外层的 waterfall 变换，时段内压过会话的模型选型。时段外，`next()` 正常解析，会话选型生效。简言之：高峰时段内预设胜出，非高峰时段用户选中的模型胜出。`prepend` 排序只对内置模型选型有保证——若另一个插件刻意以更外层注册 `agent/request`，会覆盖高峰预设。

## 程序化使用

除了经由 loader 挂载外，也可以从 TypeScript 直接挂载。同一入口导出 `apply` 安装器、纯函数 `isPeakTime` 分类器，以及 `Config` schema/类型：

```ts
import { apply, isPeakTime, type Config } from '@deepseek-ai/dsh-peak-pricing'
import type { Context } from '@deepseek-ai/cordis'
```

`apply(ctx, config)` 校验配置（加载时快速失败）并为之后创建的 agent 安装开关：对每个 `agent/created`，在 agent 作用域上注册一个 `prepend` 的 `agent/request` 监听，该监听随 agent 一起释放。

```ts
const config: Config = {
  timezone: 'Asia/Shanghai',
  peakWindows: [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  effectiveFrom: '2026-08-17T00:00:00+08:00',
  peak: { provider: 'deepseek', model: 'deepseek-chat' },
}

apply(ctx, config)
```

`isPeakTime(now, timezone, windows)` 是供独立判定的纯分类函数——回答“该时刻在给定时区下是否落在任一时段内”，每个时段起点包含、终点不包含：

```ts
import { isPeakTime } from '@deepseek-ai/dsh-peak-pricing'

const windows = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '18:00' },
]
const peak = isPeakTime(new Date(), 'Asia/Shanghai', windows)
```

`apply` 接受可选的第三个参数 `PeakPricingInternals`，其 `now` 钩子供出当前时刻，默认使用系统时钟——这是测试中让时间判定确定性的受支持方式：

```ts
import { apply } from '@deepseek-ai/dsh-peak-pricing'

apply(ctx, config, {
  now: () => new Date('2026-08-17T01:30:00Z'), // 北京时间 09:30——落在上午时段内
})
```

## 多时区 / 多套时段

一次挂载只携带一套配置：该实例的所有时段共用同一个 `timezone`。要在同一进程内覆盖多个时区或几套独立的时段，需要挂载多个插件实例。所有实例共享同一个插件 `name`（`peak-pricing`），因此请在 compose 文件中为每个实例使用不同的包条目（独立的列表项），各自携带完整的配置——各自的时区、时段、预设与可选的 `effectiveFrom`。每次挂载都是独立开关，实例之间没有协调。

## 故障排查

### 开关似乎没有生效

按顺序检查：条目是否已挂载且插件加载成功（挂载期校验会直接抛错，条目缺失或非法意味着根本没有监听器）？`peak.provider` 是否指向宿主真正注册过的路由——加载时只要求非空字符串，未知 provider 会在请求分发时由 LLM 运行时报错，而不是在挂载时？`timezone` 是否是合法的 IANA 时区、是否是价格时段实际依据的时区——时段按配置的时区判定，而非服务器本地时间？当前挂钟时间是否真的落在时段内，并记住起点包含、终点不包含？`effectiveFrom` 是否已过——在此之前，即使落在时段内开关也不触发？请求是否真的经由 agent 循环——直接 `ctx.llm.stream()` 调用绕过 waterfall，永远不会被切换？请求 header（`agent.session.requestHeader()?.config`）会显示实际服务的模型。

### 挂载期报错消息

- `$.peak missing required value` / `$.peak.provider missing required value` / `$.peak.model missing required value`——schema 校验：`peak` 预设或其必填字段缺失（空字符串能通过 schema，但随即被下一条拒绝）。
- `peak-pricing: peak.provider and peak.model are required`——预设的 `provider` 或 `model` 为空字符串。
- `peak-pricing: timezone "..." is not a valid IANA timezone`——`timezone` 不是已知的 IANA 时区。
- `peak-pricing: window time must be HH:mm, got "..."`——时段端点不是 `HH:mm` 形式，例如 `'9:00'`。
- `peak-pricing: window time out of range, got "..."`——小时大于 23 或分钟大于 59，例如 `'24:00'`。
- `peak-pricing: window start must precede end, got {...}`——时段的 `end` 不晚于 `start`；这也拒绝了 22:00-02:00 这类跨午夜时段。
- `peak-pricing: at least one peak window is required`——`peakWindows` 解析为空列表。
- `peak-pricing: effectiveFrom must be a parseable instant, got "..."`——`effectiveFrom` 不是合法的 RFC 3339 即时点。
