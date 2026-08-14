# 文档

[English](README.md) | 中文

本目录存放 `@deepseek-ai/dsh-peak-pricing` 的用户与贡献者文档。每个页面都是双语的：英文为 `*.md`，简体中文为对应的 `*.zh.md`，`*.i18n.yaml` 记录配对一致性（见 [scripts/verify-translation-pairing.mjs](../scripts/verify-translation-pairing.mjs)）。

## 快速开始

1. [安装文档](installation.zh.md) — 环境要求与三种安装方式。
2. [配置参考](configuration.zh.md) — 全部配置字段、默认值、校验规则与示例。
3. [使用方法](usage.zh.md) — 在 deepseek-harness 中挂载、行为确认与程序化调用。

## 参考

- [架构原理](architecture.zh.md) — `agent/request` waterfall、prepend 顺序、时间语义与设计取舍。
- [常见问题](faq.zh.md) — FAQ 与故障排查。

## 贡献

- [开发指南](development.zh.md) — 命令、测试结构、构建与发布流程。

## 示例

- [examples/cordis.yml](../examples/cordis.yml) — 使用 mock provider 的最小挂载示例。
- [examples/cordis.deepseek.yml](../examples/cordis.deepseek.yml) — 使用 DeepSeek 适配器的完整挂载示例。

## 维护

编辑任何 Markdown 页面后运行 `pnpm run verify:docs`：它会重新校验双语配对（`verify:pairing`，用 `--write` 重录哈希）与单物理行段落（`verify:md-wrap`）。
