# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/); this project adheres to [Semantic Versioning](https://semver.org/). Pre-release versions (`0.1.0-rc.*`) track the npm published line of `@deepseek-ai/dsh-peak-pricing`.

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

[0.1.0-rc.6]: http://liuyuesong.asia:8360/open/dsh-peak-pricing/compare/1d07174...6de8682
