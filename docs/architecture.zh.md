# `@deepseek-ai/dsh-peak-pricing`：架构与工作原理

[English](architecture.md) | 中文

## 概述

`@deepseek-ai/dsh-peak-pricing` 是一个 Cordis 函数插件：在配置的高峰计价时段内，把 agent 的模型请求路由到预设的廉价 provider/model 组合，避免价格高峰命中昂贵的会话选型。切换是对已解析请求配置的逐请求实时变换，发生在 `agent/request` waterfall 上：时段内，预设替换会话解析出的结果；时段外，已解析配置原样返回。整个包很小：两个源文件（`src/index.ts`、`src/invariant.ts`）和三个钉住行为的测试文件（`tests/peak-pricing.spec.ts`、`tests/loader-composition.spec.ts`、`tests/invariant.spec.ts`）。

## 插件形态

入口是函数插件，只有具名导出——`name`、`inject`、`Config` 与 `apply`——没有 default export，这是 Cordis Loader 的约定：Loader 把包入口当作模块命名空间导入，从这些具名成员中解析插件。

```ts
export const name = 'peak-pricing'
export const inject = ['agents']
export interface Config { /* timezone、peakWindows、effectiveFrom、peak */ }
export const Config: z<Config> = z.object({ /* schemastery schema，含默认值 */ })
export function apply(ctx: Context, config: Config, internals: PeakPricingInternals = {}): void
```

`inject = ['agents']` 声明对 agent 注册表服务的依赖，确保插件在注册表就绪、能够投递 `agent/created` 事件之后才挂载。`Config` 有意声明两次：接口是 TypeScript 视角，同名常量是 schemastery `z` schema，Loader 用它校验 `cordis.yml` 中的配置，并在 `apply` 运行前套用默认值（`timezone` 为 `'Asia/Shanghai'`、`DEFAULT_PEAK_WINDOWS` 里的两个默认时段）。`apply` 收到校验后的配置，外加可选的 `internals.now` 测试钩子——它替换系统时钟，让测试可以确定性地冻结时间；生产环境默认 `new Date()`。第二个入口 `@deepseek-ai/dsh-peak-pricing/invariant`（`src/invariant.ts`）导出 invariant 伴生插件 `peak-pricing-invariant`，`inject = ['invariants']`。

## 扩展点：`agent/request` waterfall

切换只挂一个扩展点：agent 作用域上的 `agent/request` waterfall。waterfall 监听器是 `(payload, next) => Promise<LlmCallConfig>`——它收到请求载荷和一个 `next` 委托，其返回值就是请求实际使用的配置。载荷携带 `{ turn, step, signal }`（见 agent 循环的 `buildRequest`）；最内层的 `next` 解析出由 agent 选项与已持久化请求头构建的种子配置（seed config）。

waterfall 语义（Cordis `events.ts`）：同一事件的监听器按注册顺序存放在数组中，`prepend` 插到数组头部而非尾部。分发按最外层优先执行——`next()` 从数组头部 `shift`，数组为空时回落到最内层回调——因此最先注册的监听器是最外层变换，其返回值就是 waterfall 的最终结果。返回而不调用 `next()` 的监听器会否决链上其余部分，所以 waterfall 监听器必须通过 `next()` 委托。

峰值监听器以 `{ prepend: true }` 注册，被 `unshift` 到下标 0：虽然它比内置模型选型晚安装，却成为最外层变换，其返回值——时段内的预设、时段外的原样提案——最终生效。

```ts
agent.ctx.on('agent/request', async (_payload, next) => {
  const proposed = await next()
  if (!shouldSwitch(now(), resolved)) return proposed
  return applyPeakPreset(proposed, resolved.peak)
}, { prepend: true })
```

## 时序：模型选型与峰值切换

顺序是插件生效的关键，由 `wins over installModelSelection` 测试钉死。宿主在发布前的 setup 阶段、agent 被 announce 之前，于 agent 作用域安装 `installModelSelection`——它的 `agent/request` 监听器先被 push。插件的 `apply` 在根上下文注册 `agent/created` 监听器；agent 被 announce（`{ agent }`）时，它在那个 agent 的作用域上以 `prepend: true` 安装峰值监听器，unshift 到模型选型监听器之前。于是时段内预设覆盖选型；时段外 `shouldSwitch` 为 false，峰值监听器原样返回已解析配置，`next()` 的结果——会话选型——不受影响地透传。

## 作用域生命周期

两个监听器都挂在 agent 作用域上，而不是插件上下文上。Cordis 把监听器注册记为 fiber effect，因此释放作用域即释放其监听器。`disposes the agent/request listener with the agent scope` 测试证明了这一点：`scope.dispose()` 之后，同样的 waterfall、同样的冻结峰值时钟解析出种子配置——峰值监听器已消失，没有任何东西再改写请求。根上下文上的 `agent/created` 监听器同样是挂载上下文的 fiber effect，随上下文一并消失。监听器在 agent 创建时安装一次；由于切换不保存 per-agent 可变状态，除作用域自身的释放外不需要任何 per-agent 清理。

## 逐请求实时变换

切换不保存状态、不注册会话事件。每个请求都从头决定：取当前即时点，把它的挂钟时间对照时段分类，返回预设替换后的配置或原样提案。这正是把切换描述为"对已解析请求配置的实时变换"而非有状态路由表的原因。

`applyPeakPreset` 用预设组合替换 `provider`/`model`，并丢弃任何继承的 `reasoningEffort`（解构剔除），仅当预设声明时才通过 `ReasoningEffortId` 重新应用预设自己的 effort——与 `installModelSelection` 的模型选型语义一致。

模型可见 ⟺ 已记录：waterfall 解析出的结果正是 agent 循环绑定并记录的配置。`buildRequest` 在流向适配器之前把最终配置规范化写入 `request/header` 会话事件；`loader-composition.spec.ts` 测试驱动真实 Loader，断言 `agent.session.requestHeader()?.config` 与适配器实际服务的模型一致（时段内 `peak-chat`，时段外 `default`）。本包自身不追加任何持久事件——这正是 invariant 伴生插件为空的原因：没有归本包所有的可变数据关系，也没有额外的日志记录需要断言，因为生效的 provider/model 已经由 agent 循环的 `request/header` 事件记录并管辖。

## 挂钟时间计算

时段归属按配置时区的本地挂钟时间判定，不依赖任何第三方时区库。`wallClockMinutes` 用 `Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })` 格式化即时点，从 `formatToParts` 中读取 `hour`/`minute` 两部分；`hourCycle: 'h23'` 产生 00-23 小时，无 AM/PM 歧义。结果是以本地午夜为起点的分钟数。

时段 `[start, end)` 在 `start` 处包含、`end` 处不包含：`minutes >= start && minutes < end`。`isPeakTime` 用原始 `PeakWindow` 分类即时点（每次调用时解析端点）；`shouldSwitch` 对预解析的时段做同样比较，并在设置了 `effectiveFrom` 时于该时刻之前一律返回 false。`resolveConfig` 在加载时把每个时段端点预解析成分钟数，因此逐请求热路径只做整数比较。

## 校验即加载期失败

`resolveConfig` 在 `apply` 内部同步执行，所以错误配置在插件挂载时立刻 loud fail，而不是事后悄悄错路由。以下情况都会抛错：未知 IANA 时区（用 `Intl.DateTimeFormat` 构造探测，未知时区抛 `RangeError`）、时段端点不是 `HH:mm`、小时大于 23 或分钟大于 59、`start` 不早于 `end`、时段列表为空、`effectiveFrom` 无法解析为即时点、预设缺少 `provider` 或 `model`。`config validation at load` 测试组逐条断言这些错误；默认值测试断言省略 `timezone`/`peakWindows` 可以接受。

## 请求流程

```mermaid
sequenceDiagram
    participant Host as "宿主运行时"
    participant Root as "插件根上下文"
    participant Scope as "Agent 作用域"
    participant Peak as "峰值监听器（最外层）"
    participant Select as "模型选型监听器"
    participant Loop as "Agent 循环"
    participant Adapter as "LLM 适配器"

    Host->>Scope: setup：发布前安装 installModelSelection
    Host->>Root: announce agent → 触发 agent/created
    Root->>Scope: agent.ctx.on('agent/request', listener, { prepend: true })

    Loop->>Scope: 分发 agent/request waterfall（seed 为最内层 next）
    Scope->>Peak: 最外层监听器先执行，await next()
    Peak->>Select: next()
    Select-->>Peak: 已解析配置（应用会话选型；next() 到达 seed）
    Peak->>Peak: shouldSwitch(now())？
    alt 处于某个高峰时段
        Peak-->>Loop: 预设配置（替换 provider/model，丢弃继承 effort）
    else 时段之外
        Peak-->>Loop: 已解析配置原样返回
    end
    Loop->>Adapter: 以最终配置 prepareCall + stream
    Loop->>Loop: 记录 request/header 事件（模型可见 ⟺ 已记录）
```

切换只影响进入 agent 循环 `agent/request` waterfall 的请求；绕过循环、直接调用 `ctx.llm.stream()` 的消费者不受影响。

## 设计取舍

### 不做价目表与计费集成

切换只按配置的挂钟时段判定。它不读取 API 价格列表，`effectiveFrom` 是一次性全局生效时间点，不是计划表。价格数据归 provider 所有且易变；按实时价格路由会迫使插件去获取、缓存并刷新价格状态——持久可变状态与无状态逐请求设计相悖，也会复杂化"模型可见 ⟺ 已记录"的保证。声明式时段是确定性的、可测试的、易于推理的。

### 不做 off-peak 预设

时段之外插件原样返回已解析配置，因此用户或会话的模型选型生效。off-peak 预设会在同一个扩展点上与选型竞争，覆盖用户意图；本插件的职责只是封顶高峰成本，而不是在价格正常时替用户选模型。`next()` 已经解析出"正确"的配置——再覆盖一次只是增加一次没有成本理由的变换。

### 不支持跨午夜时段

时段的 `end` 必须晚于 `start`——加载时以 `start must precede end` 强制——因此 22:00-02:00 这类每日时段会被拒绝。支持这类时段要么需要日期运算（这属于哪一天的时段？），要么需要隐式拆成两个时段，两者都会让模型变复杂，而默认的北京时间时段永远用不到。

## 源码与测试索引

- `src/index.ts` —— 插件入口：`apply`、`resolveConfig`、`shouldSwitch`、`applyPeakPreset`、`wallClockMinutes`、`isPeakTime`、schema 与类型。
- `src/invariant.ts` —— 空的 invariant 伴生插件（`peak-pricing-invariant`）。
- `tests/peak-pricing.spec.ts` —— `isPeakTime` 分类、加载期校验、高峰/非高峰切换、reasoning effort 处理、`effectiveFrom` 门控、与 `installModelSelection` 的顺序、作用域释放。
- `tests/loader-composition.spec.ts` —— 真实 Loader 组合；实际服务的模型等于记录的 `requestHeader().config`。
- `tests/invariant.spec.ts` —— 伴生插件干净挂载并以包名命名自身。
