# Documentation

English | [中文](README.zh.md)

This directory holds the user and contributor documentation for `@deepseek-ai/dsh-peak-pricing`. Every page is bilingual: the English side is the `*.md` file, the 简体中文 side is the `*.zh.md` sibling, and `*.i18n.yaml` records the consistency pair (see [scripts/verify-translation-pairing.mjs](../scripts/verify-translation-pairing.mjs)).

## Getting started

1. [Installation](installation.md) — environment requirements and the three install options.
2. [Configuration](configuration.md) — every config field with defaults, validation rules, and examples.
3. [Usage](usage.md) — mounting in deepseek-harness, confirming behavior, and programmatic use.

## Reference

- [Architecture](architecture.md) — the `agent/request` waterfall, prepend ordering, time semantics, and design trade-offs.
- [FAQ](faq.md) — common questions and troubleshooting.

## Contributing

- [Development](development.md) — commands, test structure, build, and publish flow.

## Examples

- [examples/cordis.yml](../examples/cordis.yml) — minimal mount with a mock provider.
- [examples/cordis.deepseek.yml](../examples/cordis.deepseek.yml) — full mount with the DeepSeek adapter.

## Maintenance

Run `pnpm run verify:docs` after editing any Markdown page: it re-checks bilingual pairing (`verify:pairing`, use `--write` to re-record hashes) and single-physical-line paragraphs (`verify:md-wrap`).
