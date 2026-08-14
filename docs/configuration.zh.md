# 配置参考（Configuration）

本文档是 `@deepseek-ai/dsh-peak-pricing` Cordis 函数插件（npm 包 `@deepseek-ai/dsh-peak-pricing`）的配置参考。在配置的高峰计价时段内，插件把每个 agent 的模型请求路由到预设的廉价 `provider`/`model` 组合；时段外，已解析的请求配置原样返回。插件内部名为 `peak-pricing`，注入 `agents` 服务（`inject: ['agents']`）；在 Cordis compose 文件中，条目使用 npm 包名，插件配置放在其 `config` 键下。

## 概述

切换是对已解析请求配置的逐请求实时变换，发生在 `agent/request` waterfall：高峰时段内，预设的 `provider`/`model` 组合替换会话解析出的结果；时段外，已解析配置原样放行。以下所有配置项都在加载时校验，配置非法会在插件挂载时立即报错（fails loud），不会静默降级。

## 字段参考

顶层字段：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `timezone` | `string` | 否 | `'Asia/Shanghai'` | 所有高峰时段所在的 IANA 时区；一个时区作用于全部时段。 |
| `peakWindows` | `PeakWindow[]` | 否 | `[{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]` | 每日高峰时段，每个时段起点包含、终点不包含。 |
| `effectiveFrom` | `string` | 否 | 无（开关立即生效） | RFC 3339 即时点；在此之前开关永不触发。 |
| `peak` | `PeakPreset` | 是 | —（无默认值） | 高峰时段使用的预设模型选型（必填对象）。 |

`PeakWindow`（`{ start, end }`，两项均必填）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `start` | `string` | 时段的本地起点（包含），严格 `HH:mm`。 |
| `end` | `string` | 时段的本地终点（不包含），严格 `HH:mm`；必须晚于 `start`。 |

`PeakPreset`（`peak` 对象）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `provider` | `string` | 是 | 已注册的 LLM 路由，例如 DeepSeek 适配器的 `deepseek`。 |
| `model` | `string` | 是 | 该路由服务的模型 id，例如 `deepseek-chat`。 |
| `reasoningEffort` | `string` | 否 | 高峰期间应用的 reasoning effort；不声明时丢弃继承值，走 provider/默认行为。 |

包导出的 TypeScript 类型：

```ts
interface PeakWindow {
  /** Inclusive local start, HH:mm. */
  start: string
  /** Exclusive local end, HH:mm; must be later than start. */
  end: string
}

interface PeakPreset {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}
```

## `timezone`

所有高峰时段所在时区。默认 `'Asia/Shanghai'`（北京时间，UTC+8，无夏令时）。任意 IANA 时区均可，例如 `UTC`、`America/New_York`、`Europe/Berlin`。

加载时用 `Intl.DateTimeFormat` 探测校验；未知或空时区抛出 `peak-pricing: timezone "..." is not a valid IANA timezone`（消息内嵌具体值，例如 `peak-pricing: timezone "Mars/Olympus" is not a valid IANA timezone`）。

## `peakWindows`

每日高峰时段数组。默认 `[{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]`。每个时段是 `{ start, end }` 一对严格 `HH:mm` 字符串——小时和分钟都必须是两位数——校验按每个端点依次进行：

1. 格式：不是精确 `HH:mm` 的值抛出 `peak-pricing: window time must be HH:mm, got "9:00"`。
2. 范围：hour > 23 或 minute > 59 抛出 `peak-pricing: window time out of range, got "24:00"`。
3. 顺序：`start` 不严格早于 `end`（相等或倒序）抛出 `peak-pricing: window start must precede end, got {"start":"12:00","end":"12:00"}`。

数组本身不能为空：`peakWindows: []` 抛出 `peak-pricing: at least one peak window is required`。整个省略该键才使用默认时段；显式写成空数组是错误。由于 `end` 必须严格晚于 `start`，跨午夜时段（如 22:00-02:00）无法表达——只能配置完整落在单日内的时段。

## `effectiveFrom`

可选的 RFC 3339 即时点（例如 `2026-08-17T00:00:00Z` 或 `2026-08-17T00:00:00+08:00`），作为整个开关的生效门槛。校验是 `Date.parse` 探测：无法解析的值抛出 `peak-pricing: effectiveFrom must be a parseable instant, got "not-a-date"`。缺省时开关立即生效（仍受时段约束）；设置后，在那一刻之前任何请求都不切换，即使处于时段内。它是一次性全局生效日，不是计划表。

## `peak`

必填对象，选择预设模型。`provider` 与 `model` 均必填且必须是非空字符串：任一为空即抛出 `peak-pricing: peak.provider and peak.model are required`。`provider` 指向宿主已注册的路由（例如 DeepSeek 适配器的 `deepseek`）；`model` 是该路由服务的模型 id（例如 `deepseek-chat`）。可选的 `reasoningEffort` 仅在声明时应用；继承自已解析请求的 reasoning effort 会被丢弃，与 model-selection 语义一致。

## 时段语义

每个时段是时区下的每日本地挂钟区间 `[start, end)`：起点分钟在时段内，终点分钟在时段外。判定时比较当前即时点在配置 `timezone` 下的挂钟分钟数（用 `Intl.DateTimeFormat` 计算）。端点只是普通 `HH:mm` 值，永不做 DST（夏令时）调整；无夏令时的时区（如 `Asia/Shanghai`）行为一致，其他时区的 DST 只会改变即时点落在哪个挂钟分钟上，不会移动时段边界。

以默认时段为例：北京时间 09:00 与 11:59 是高峰，12:00 不是；14:00 是高峰，18:00 不是；午夜与 23:59 均非高峰。该安排每个自然日重复。

## 切换行为

请求在满足两个条件时被切换（以请求发生的即时点为准）：不早于 `effectiveFrom`（若设置），且其在 `timezone` 下的挂钟时间落在至少一个时段内。高峰时段内，预设的 `provider`/`model` 替换已解析请求的组合；继承的 `reasoningEffort` 被丢弃，预设声明了自己的值才应用；其余请求字段（如 `temperature`）原样保留。

监听器以 `prepend` 注册在 agent 作用域上，是最外层的 `agent/request` waterfall 变换：时段开启时预设压过会话的模型选型，时段外会话选型生效。监听器随 agent 作用域一起释放。

## 校验顺序

`resolveConfig` 按固定顺序校验，在第一个违规处失败，因此一次只暴露一个错误：时区探测 → 每个时段端点（格式、范围、顺序）→ 非空数组检查 → `effectiveFrom` 解析 → `peak.provider`/`peak.model` 非空检查。

## YAML 示例

配置放在 Cordis compose 文件中插件条目的 `config` 键下。

完整示例——含全部可选字段与注释：

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    # 所有高峰时段所在的 IANA 时区。
    # 默认：Asia/Shanghai（北京时间，UTC+8，无夏令时）。
    timezone: Asia/Shanghai
    # 每日高峰时段，[start, end)：起点包含、终点不包含。
    # 端点均为严格 HH:mm。默认：09:00-12:00、14:00-18:00。
    # 跨午夜时段在加载时被拒绝。
    peakWindows:
      - start: '09:00'
        end: '12:00'
      - start: '14:00'
        end: '18:00'
    # 可选 RFC 3339 即时点；在此之前开关永不触发。
    # 省略则立即生效。
    effectiveFrom: '2026-08-17T00:00:00+08:00'
    # 高峰时段应用的预设模型选型（必填对象）。
    peak:
      provider: deepseek      # 必填：已注册的 LLM 路由。
      model: deepseek-chat    # 必填：该路由服务的模型 id。
      reasoningEffort: low    # 可选：高峰期间应用；继承的 effort 被丢弃。
```

最小示例——除 `peak` 外全部使用默认值：

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    peak:
      provider: deepseek
      model: deepseek-chat
```

## 常见配置错误

| 错误配置 | 报错消息 | 修复建议 |
|---|---|---|
| `timezone` 未知，如 `Mars/Olympus` | `peak-pricing: timezone "Mars/Olympus" is not a valid IANA timezone` | 使用合法 IANA 时区，如 `Asia/Shanghai`、`UTC`、`Europe/Berlin`。 |
| `timezone` 为空字符串（`''`） | `peak-pricing: timezone "" is not a valid IANA timezone` | 设置合法 IANA 时区，或省略该键使用默认值。 |
| 时段端点不是 `HH:mm`，如 `9:00` | `peak-pricing: window time must be HH:mm, got "9:00"` | 小时与分钟补齐两位：`09:00`。 |
| 时段端点越界，如 `24:00` 或 `09:60` | `peak-pricing: window time out of range, got "24:00"` | 使用 `00:00` 到 `23:59` 之间的真实时刻。 |
| 时段相等或倒序，如 `12:00`–`12:00` | `peak-pricing: window start must precede end, got {"start":"12:00","end":"12:00"}` | 让 `start` 严格早于 `end`；跨午夜时段无法表达。 |
| 显式空数组 `peakWindows: []` | `peak-pricing: at least one peak window is required` | 省略该键使用默认时段，或至少列出一个时段。 |
| `effectiveFrom` 无法解析，如 `not-a-date` | `peak-pricing: effectiveFrom must be a parseable instant, got "not-a-date"` | 使用 RFC 3339 即时点，如 `2026-08-17T00:00:00Z`。 |
| `peak.provider` 或 `peak.model` 为空 | `peak-pricing: peak.provider and peak.model are required` | 在 `peak` 内提供非空的 `provider` 与 `model`。 |
| 整个 `peak` 对象缺失 | 插件 schema 在加载时拒绝（无 `peak-pricing:` 前缀消息；必填字段缺失） | 添加含非空 `provider` 与 `model` 的 `peak` 对象。 |