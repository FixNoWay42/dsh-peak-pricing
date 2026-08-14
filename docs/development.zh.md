# 开发指南（Development Guide）

本文介绍 `@deepseek-ai/dsh-peak-pricing`：作为 Cordis 函数插件（function plugin），它在配置的高峰计价时段内把 agent 的模型请求路由到预设的廉价模型。内容包括环境准备、npm 脚本、测试结构、构建与发布流程、代码约定与提交规范。该包发布两个入口：根插件（`lib/index.js`，导出 `.`）与伴生插件（invariant companion，`lib/invariant.js`，导出 `./invariant`）。

## 环境准备（Environment Setup）

需要 Node.js `^22.19 || >=24` 与 pnpm；依赖的安装与管理使用 pnpm 而非 npm。`pnpm-workspace.yaml` 将刚发布的 `@deepseek-ai/*@0.1.0-rc.8` 各包排除在 pnpm 的最低发布年龄（minimum release age）限制之外，保证新发布后锁文件能立即解析到它们。

```bash
pnpm install
```

安装会从 npm 仓库拉取 `@deepseek-ai/dsh-*` 的 peer 包与工具链（typescript、tsdown、vitest、@types/node）；开发与测试本包不需要 deepseek-harness 单体仓库的检出。

## 常用命令（Common Commands）

所有命令都声明在 `package.json` 的 `scripts` 中。

### pnpm run typecheck

执行 `tsc -p tsconfig.json --noEmit`，在严格编译选项（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noUnusedLocals`、`noUnusedParameters` 等）下对 `src/`（`index.ts` 与 `invariant.ts`）做类型检查。不产出任何文件，因此可在构建前安全执行；出错时输出编译器诊断信息并以非零退出码结束。

### pnpm run test

执行 `vitest run`，以非监听模式运行一次测试套件。按 `vitest.config.ts`，Vitest 收集 `tests/**/*.spec.ts`，单个测试超时时间为 60 秒。输出为各文件进度与最终汇总（文件数与测试数）；任何失败都以非零退出码结束。当前套件为 4 个 spec 文件共 29 个测试。

### pnpm run build

执行 `tsc -p tsconfig.json && tsdown`，分两阶段。第一阶段 tsc 把 `src/` 编译到 `lib/types/`（`rootDir: src`、`outDir: lib/types`），产出 `index.js`/`index.d.ts` 与 `invariant.js`/`invariant.d.ts` 及 source map 和增量构建信息；第二阶段 tsdown 以产出的 `lib/types/index.js` 与 `lib/types/invariant.js` 为入口，打包为 `lib/index.js` 与 `lib/invariant.js`（ESM、node 平台、es2024 目标、`dts: false` 因声明已由 tsc 产出、`clean: false` 保留 tsc 输出）。源码导入使用 `.ts` 后缀（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`），tsc 在产出时改写为 `.js`。最终 `lib/` 布局即 `files` 白名单所发布的产物。

## 测试结构（Test Structure）

测试位于 `tests/`，直接导入 devDependencies 中从 npm 发布的 `@deepseek-ai/dsh-*` 包（例如 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-invariants`，以及加载器插件 `@deepseek-ai/cordis-plugin-loader` 与 `@deepseek-ai/cordis-plugin-include`），套件可脱离仓库独立运行。四个 spec 文件覆盖四层：单元行为、价目表估算与日志、真实 Loader 组合、invariant 伴生插件。

### tests/peak-pricing.spec.ts —— 单元行为（14 个测试）

`isPeakTime()` 一组（2 个）在配置时区下按起点包含、终点不包含的 `[start, end)` 语义分类即时点，覆盖边界、午夜为非高峰，以及同一即时点在 `UTC` 与 `Asia/Shanghai` 下分类不同。配置校验一组（7 个）断言加载时 loud fail：未知时区、非法或越界的 `HH:mm`、`start` 不早于 `end`、空时段列表、无法解析的 `effectiveFrom`、`peak` 缺少 `provider` 或 `model`，并在省略 `timezone`/`peakWindows` 时应用默认值。`apply()` 一组（5 个）通过 `agentEvents` 驱动 `agent/request` waterfall，并用 `PeakPricingInternals.now` 注入时钟：高峰时段内切换为预设、时段外原样保留，应用预设 `reasoningEffort` 并丢弃继承值，`effectiveFrom` 之前不切换、之后切换，时段内压过 `installModelSelection`、时段外让位，监听器随 agent 作用域释放。

### tests/loader-composition.spec.ts —— 真实 Loader 组合（1 个测试）

该测试启动真实的 `@deepseek-ai/cordis-plugin-loader` 与 `@deepseek-ai/cordis-plugin-include`：在临时目录写入 `cordis.yml`，通过内部 v2 import map 注册工作区插件模块，再经 `cordis:include` 在全新上下文中挂载该文件。用 `vi.useFakeTimers({ toFake: ['Date'] })` 与 `vi.setSystemTime(...)` 把时钟冻结在 09:30 北京时间（默认 09:00-12:00 时段内）与之后的 13:30 北京时间（非高峰）；`RecordingAdapter` 记录每个请求实际服务的模型。断言所有条目均已加载、服务模型依次为 `peak-chat` 与 `default`、agent 的 request header 记录了被切换的模型（模型可见 ⟺ 已记录），以及派生的助手消息正确流式返回。该测试显式采用 60 秒超时，因为冷缓存下 host/client 程序拆分后的 tsx 解析可能超过默认的 5 秒预算。

### tests/tariff.spec.ts —— 价目表估算与日志（12 个测试）

`DEEPSEEK_TARIFF` 一组（2 个）钉住两个模型（`deepseek-v4-flash` 与 `deepseek-v4-pro`）的精确官方价格（缓存命中输入、缓存未命中输入、输出；高峰与空闲各一列），并断言每个高峰价格都恰好是空闲价格的两倍（官方半价规则）。`estimateCost` 一组（3 个）验证分列计费——缓存命中与未命中的输入 token 按各自费率、token 数线性、零缓存命中调用；`estimateSaving`（2 个）验证高峰价格下的费用差，预设更便宜时为正、更贵时为负。校验一组（3 个）断言用户价目条目合并到内置表之上，且负数或非有限价格抛出 `tariff for model "..." must carry non-negative peak and off-peak prices`。日志一组（2 个）通过 `ctx.logger.exporter()` 捕获 `peak-pricing` 的 info 消息，断言两个模型都有价目条目时输出高峰价格对比行、被解析模型无条目时不输出。

### tests/invariant.spec.ts —— invariant 伴生插件（2 个测试）

在全新上下文中依次挂载 `@deepseek-ai/dsh-invariants` 与 `src/invariant.ts`，断言伴生插件能注册为包所有者并干净释放，且其命名为 `peak-pricing-invariant`、`inject: ['invariants']`。

## 构建与发布（Build & Publish）

### 构建产物

`pnpm run build` 之后，`lib/` 的结构如下：

```text
lib/
  index.js            打包后的根插件 —— 导出 "."
  invariant.js        打包后的伴生插件 —— 导出 "./invariant"
  types/
    index.d.ts        根导出的类型
    invariant.d.ts    "./invariant" 导出的类型
    *.js / *.map      tsdown 消费的 tsc 中间产物（不发布）
```

### 发布前检查清单（Pre-publish checklist）

- `exports` 映射 `.` 与 `./invariant`，两者的 JS 指向打包后的 `lib/` 入口、类型指向 `lib/types/*.d.ts`，另有 `./package.json`；新增子路径时保持各处同步。
- `files` 只发布 `lib/index.js`、`lib/invariant.js`、`lib/types/**/*.d.ts` 与 `start.sh` —— tsc 中间产物与 source map 不进 tarball。
- `peerDependencies`（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/dsh-llm`）由宿主部署提供；`@deepseek-ai/schemastery` 是唯一的运行时依赖。
- 当前版本为 `0.1.0-rc.8`，`publishConfig.access: public`。

### 发布

```bash
pnpm run typecheck
pnpm run test
pnpm run build
npm publish
```

`npm publish` 读取 `publishConfig.access: public`，无需 `--access public` 标记即可发布到公共仓库。每次发版按 semver 提升版本号；Conventional Commits 历史便于生成变更日志。

## 代码约定（Code Conventions）

### 函数插件形态

每个插件模块只具名导出（named exports）——`name`、`inject`、`apply`，根插件另有 `Config`（schemastery 模式），且没有 default export。根插件以 `ctx.on('agent/created')` 注册，并把 `agent/request` waterfall 监听器以 `prepend: true` 挂在 agent 作用域上，使其在时段内成为最外层变换；监听器随 agent 作用域一起释放。伴生插件导出同样的三项，并通过 `ctx.invariants.register` 注册包所有权。

### 文档注释

每个公开导出都带 JSDoc：模块级注释、参数的 `@param`、返回值的 `@returns`，并对非显而易见的契约（如 `[start, end)` 时段语义、`reasoningEffort` 替换规则）加以说明。

### 配置错误 loud fail

配置在加载时由 `resolveConfig()` 一次性校验，任何问题都会在插件挂载时抛出 `peak-pricing:` 前缀的错误——绝不静默跳过。覆盖范围包括时区、`HH:mm` 语法与范围、`start < end`、非空时段列表、可解析的 `effectiveFrom`，以及非空的 `peak.provider`/`peak.model`。

### invariant 伴生插件规则

`src/invariant.ts` 刻意安装一个空实现（no-op）的 invariant，并在 JSDoc 中说明原因：高峰切换是对已解析请求配置的逐请求实时变换，本包不追加任何持久事件、也不拥有任何可变数据关系——生效的 provider/model 已由 agent 循环的 `request/header` 事件记录与治理。伴生插件断言其拥有的关系；在不存在此类关系时，带说明的空伴生插件是正确的。

## 提交规范（Commit Conventions）

提交遵循 Conventional Commits，与现有历史一致（`feat: standalone dsh-peak-pricing plugin`）：`feat:` 表示新行为，`fix:` 表示缺陷修复，`docs:` 表示纯文档变更，其余标准类型同理。
