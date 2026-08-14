# 常见问题（FAQ）

关于 `@deepseek-ai/dsh-peak-pricing` —— 在配置的高峰计价时段内将 agent 模型请求路由到预设廉价模型的 Cordis 函数插件（function plugin）—— 的常见问题。

## 高峰时段为什么没有切换？

按顺序排查以下几点：`timezone` 是时段所依据的本地挂钟时区，默认为 `Asia/Shanghai`，比 UTC 快 8 小时，所以 `09:00` 时段对应 `01:00` UTC，用 UTC 小时判断会全部误判；时段的语义是 `[start, end)`——起点包含、终点不包含——因此北京时间 `12:00:00` 已经不在 `09:00-12:00` 内；设置了 `effectiveFrom` 时，在该 RFC 3339 即时点之前任何请求都不切换；预设的 `provider` 必须指向 LLM 接缝已注册的路由（例如 `deepseek` 或 `mock`），未知路由在请求时才报错而非加载时；以及直接调用 `ctx.llm.stream()` 的消费者从不进入 agent 循环的 `agent/request` waterfall，按设计绕过切换（它们同样绕过模型选型）。

## 与会话的模型选型冲突时谁赢？

时段内预设赢，时段外选型赢：插件以 `prepend: true` 在 agent 作用域上安装 `agent/request` 监听器，时段打开时它是最外层的 waterfall 变换，替换掉会话模型选型经 `next()` 解析出的结果；时段外监听器等待 `next()` 并原样返回解析出的配置，会话选型生效。

## 时区与夏令时（DST）如何处理？

时段是配置的单个 IANA 时区下的每日本地挂钟区间；默认 `Asia/Shanghai` 为 UTC+8 且无夏令时，北京时段永远不变。对实行夏令时的时区，挂钟时间经 `Intl.DateTimeFormat` 依据 IANA 时区数据库解析，时段会遵循本地时钟并自动跨越转换——同一个 `09:00-12:00` 在春季拨快前后与冬季拨慢前后对应的 UTC 区间不同。

## 时段可以跨午夜吗？

不可以，这是设计使然：`end` 不晚于 `start` 的时段在加载时被拒绝（`peak-pricing: window start must precede end, got ...`），因此单个 `22:00-02:00` 时段无法表达。请改用两个相邻时段覆盖同样的范围，例如 `{ start: '22:00', end: '23:59' }` 加 `{ start: '00:00', end: '02:00' }`。

## 高峰时价格反而便宜，我还想用昂贵的模型怎么办？

预设只是一组 provider/model 对——没有任何机制强制它便宜——因此把 `peak.provider` 与 `peak.model` 指向昂贵模型，「高峰预设」就是昂贵模型；或者干脆不挂载该插件，因为不挂载就不发生任何变换。

## 多个部署的时区不同，如何配置？

时区按挂载实例固定：一个实例的所有时段共用同一个 `timezone`，所以每个部署在各自的 cordis.yml 里配置自己的 `timezone`（以及各自的 `peakWindows`）。由于插件的 `name` 各处相同（`peak-pricing`），在同一进程内挂载多个实例需要在 compose 文件中使用不同的包条目。

## 报错 "peak.provider and peak.model are required" 是什么意思？

这是加载期错误，由 `resolveConfig()` 在 `apply()` 执行时抛出，触发条件是 `peak` 预设缺少非空的 `provider` 或 `model`；完整消息为 `peak-pricing: peak.provider and peak.model are required`。修复方法是在 `config.peak` 中同时提供这两个字段。它的同类错误同样在挂载时报出：未知时区对应 `timezone ... is not a valid IANA timezone`，时间格式非法对应 `window time must be HH:mm`，时间越界对应 `window time out of range`，时段倒置对应 `window start must precede end`，空列表对应 `at least one peak window is required`，`effectiveFrom` 无法解析对应 `effectiveFrom must be a parseable instant`。

## 测试如何验证时间而不真的等到高峰？

按测试层次分两种机制：单元测试注入时钟——通过 `PeakPricingInternals.now` 调用 `apply(ctx, config, { now: () => date })`——每次请求分类都使用确定性即时点而不触碰系统时钟；Loader 组合测试则用 `vi.useFakeTimers({ toFake: ['Date'] })` 与 `vi.setSystemTime(...)` 冻结真实时钟，同时经 Loader 驱动真实的 agent 循环。两种方式都让高峰/非高峰即时点精确可控，所有依赖时间的测试都因此保持确定性。
