# 仓库指南

`@deepseek-ai/dsh-peak-pricing` 贡献者指南：一个 Cordis 函数插件，在配置的尖峰价格时段内将 agent 模型请求路由到预设的廉价模型。

## 项目结构与模块组织

- `src/` — 包源码。`index.ts` 是根插件（仅具名导出 `name`、`inject`、`apply`、`Config`）；`invariant.ts` 是 `./invariant` 伴生插件。
- `tests/` — Vitest 测试（`tests/**/*.spec.ts`）。
- `docs/` — 双语文档（英文 + 简体中文），配 `*.i18n.yaml` 一致性记录；每页文档两种语言都要交付。
- `examples/` — 可直接挂载的 `cordis.yml` 示例。
- `scripts/` — 文档门禁（`verify-translation-pairing.mjs`、`verify-md-wrap.mjs`）。
- `lib/` — 构建产物（已 gitignore，禁止提交）。

## 构建、测试与开发命令

要求 Node `^22.19 || >=24` 与 pnpm；安装依赖用 pnpm，不用 npm。

- `pnpm install` — 安装依赖。
- `pnpm run typecheck` — 严格模式 `tsc --noEmit` 检查 `src/`。
- `pnpm run test` — 运行一次 Vitest 全量测试（`vitest run`）。
- `pnpm run build` — `tsc` 产出 `lib/types/`，再由 `tsdown` 打包出 `lib/index.js` 与 `lib/invariant.js`。
- `pnpm run verify:docs` — 运行双语配对与 Markdown 换行门禁。
- 发布前：`pnpm run typecheck && pnpm run test && pnpm run build && npm publish`。

## 编码风格与命名约定

- TypeScript 严格模式（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noUnusedLocals`、`noUnusedParameters`）。未配置独立 lint/格式化工具，`tsc` 即门禁。
- 插件模块只具名导出，无默认导出。
- 每个公开导出都要写 JSDoc（`@param`、`@returns`、契约说明）。
- 配置错误在加载时抛出以 `peak-pricing:` 为前缀的报错，绝不静默跳过。
- 源码导入使用 `.ts` 后缀（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`）。

## 测试指南

- Vitest 规格文件放在 `tests/`，命名 `*.spec.ts`（如 `peak-pricing.spec.ts`）；单测超时 60 秒。
- 覆盖三层：单元行为、真实 Loader 组合（`loader-composition.spec.ts`）、伴生插件。
- 测试名用一句话描述被断言的行为。全量测试用 `pnpm run test` 运行。

## 提交与 Pull Request 指南

- 遵循 Conventional Commits（与现有历史一致：`feat:`、`fix:`、`docs:`）。正文说明行为变更或改动的文档。
- 文档改动必须保持中英文同步，提交前运行 `pnpm run verify:docs`。
- PR 需描述改动与动机、关联工单，并列出已执行的验证（typecheck、测试、构建、文档门禁）。
