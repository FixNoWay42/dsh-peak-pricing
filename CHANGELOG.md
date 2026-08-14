# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/); this project adheres to [Semantic Versioning](https://semver.org/). Pre-release versions (`0.1.0-rc.*`) track the npm published line of `@deepseek-ai/dsh-peak-pricing`.

## [0.1.0-rc.7] - 2026-08-14

### Added

- Built-in DeepSeek tariff (`DEEPSEEK_TARIFF`): official peak and off-peak prices per million tokens (cache-hit input, cache-miss input, output) for `deepseek-v4-flash` and `deepseek-v4-pro`, from the DeepSeek pricing page; off-peak is exactly half the peak price.
- Optional `tariff` config key merging per-model price overrides over the built-in table, validated at load (finite, non-negative prices).
- Pure cost functions `estimateCost(usage, price)` and `estimateSaving(usage, resolved, peak)`; cache-hit and cache-miss input tokens are billed at their own rates.
- Peak-price comparison log line emitted when a request is routed to the preset and both the resolved and preset models have tariff entries.
- Test suite extended to 29 tests across 4 spec files (new `tests/tariff.spec.ts`, 12 tests).

### Changed

- Tariff is estimation and logging only: the switch still keys on configured wall-clock windows, never on prices.
- README and docs updated (overview, configuration, usage, architecture, FAQ, development); the "no tariff table" limitation is replaced by "no billing integration".

## [0.1.0-rc.6] - 2026-08-14

### Added

- Initial standalone release of the peak-pricing plugin, extracted from the deepseek-harness monorepo.
- `agent/request` waterfall listener registered with `prepend` on the agent scope: inside a configured peak window the resolved request config is replaced with the preset provider/model pair; outside, the resolved config is returned unchanged.
- Configurable `timezone` (default `Asia/Shanghai`), daily `peakWindows` (default 09:00-12:00 and 14:00-18:00, start inclusive / end exclusive), optional `effectiveFrom` RFC 3339 gate, and a required `peak` preset with optional `reasoningEffort`.
- Loud load-time validation of timezone, window format and ordering, non-empty windows, parseable `effectiveFrom`, and non-empty preset provider/model.
- Invariant companion with an explained empty installer.
- Test suite: 17 tests across unit behavior, real-Loader composition, and invariant topology.
- Bilingual README (English / 简体中文) with Model Experience and Known Limitations sections.
- Documentation: installation, configuration reference, usage, architecture, development, and FAQ.

[0.1.0-rc.7]: http://liuyuesong.asia:8360/open/dsh-peak-pricing/compare/10a573c...HEAD
[0.1.0-rc.6]: http://liuyuesong.asia:8360/open/dsh-peak-pricing/compare/1d07174...6de8682
