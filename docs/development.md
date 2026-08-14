# Development Guide

This guide covers `@deepseek-ai/dsh-peak-pricing`, the Cordis function plugin that routes agent model requests to a preset cheap model during configured peak-price windows. It documents environment setup, the npm scripts, the test suite, the build and publish flow, code conventions, and commit conventions. The package publishes two entry points: the root plugin (`lib/index.js`, export `.`) and the invariant companion (`lib/invariant.js`, export `./invariant`).

## Environment Setup

Node.js `^22.19 || >=24` and pnpm are required; install and manage dependencies with pnpm, not npm. `pnpm-workspace.yaml` excludes the freshly published `@deepseek-ai/*@0.1.0-rc.6` packages from pnpm's minimum-release-age guard so the lockfile resolves them right after a release.

```bash
pnpm install
```

The install pulls the `@deepseek-ai/dsh-*` peer packages and the toolchain (typescript, tsdown, vitest, @types/node) from the npm registry; no checkout of the deepseek-harness monorepo is needed to develop or test this package.

## Common Commands

All commands are declared in `package.json` under `scripts`.

### pnpm run typecheck

Runs `tsc -p tsconfig.json --noEmit` and type-checks `src/` (both `index.ts` and `invariant.ts`) under the strict compiler options (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, and more). It emits nothing, so it is safe to run before a build; output is compiler diagnostics only on failure and the exit code is non-zero on error.

### pnpm run test

Runs `vitest run`, executing the suite once in watch-free mode. Per `vitest.config.ts`, Vitest collects `tests/**/*.spec.ts` with a 60-second per-test timeout. Output is per-file progress and a final summary listing files and tests passed; the exit code is non-zero when anything fails. The suite currently contains 29 tests across 4 spec files.

### pnpm run build

Runs `tsc -p tsconfig.json && tsdown` in two stages. First tsc compiles `src/` into `lib/types/` (`rootDir: src`, `outDir: lib/types`), emitting `index.js`/`index.d.ts` and `invariant.js`/`invariant.d.ts` plus source maps and the incremental build info; then tsdown consumes the emitted `lib/types/index.js` and `lib/types/invariant.js` and bundles them to `lib/index.js` and `lib/invariant.js` (ESM, node platform, es2024 target, `dts: false` because tsc already produced declarations, `clean: false` so the tsc output stays). Source imports use `.ts` specifiers (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`), which tsc rewrites to `.js` on emit. The resulting `lib/` layout is what `files` allowlists for publication.

## Test Structure

Tests live in `tests/` and import the npm-published `@deepseek-ai/dsh-*` packages listed in devDependencies (for example `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-invariants`, plus the loader plugins `@deepseek-ai/cordis-plugin-loader` and `@deepseek-ai/cordis-plugin-include`), so the suite runs standalone against released packages. Four spec files cover four layers: unit behavior, tariff estimation and logging, real Loader composition, and the invariant companion.

### tests/peak-pricing.spec.ts — unit behavior (14 tests)

The `isPeakTime()` block (2 tests) classifies instants against inclusive-start, exclusive-end windows in the configured timezone, including the `[start, end)` edges, midnight as off-peak, and the same instant classified differently under `UTC` vs `Asia/Shanghai`. The config-validation block (7 tests) asserts the plugin fails loud at load on an unknown timezone, malformed or out-of-range `HH:mm` times, a window whose start does not precede its end, an empty window list, an unparseable `effectiveFrom`, a peak preset missing `provider` or `model`, and applies the defaults when `timezone`/`peakWindows` are omitted. The `apply()` block (5 tests) drives the `agent/request` waterfall through `agentEvents` with a clock injected via `PeakPricingInternals.now`: peak preset in-window and resolved config unchanged off-peak, preset `reasoningEffort` applied and inherited effort dropped, no switching before `effectiveFrom` and switching after it, precedence over `installModelSelection` in-window and deference outside, and the listener disposed with the agent scope.

### tests/loader-composition.spec.ts — real Loader composition (1 test)

This test boots the actual `@deepseek-ai/cordis-plugin-loader` with `@deepseek-ai/cordis-plugin-include`: it writes a `cordis.yml` to a temp directory, registers the workspace plugin modules through an internal v2 import map, and mounts the file via `cordis:include` on a fresh context. The clock is frozen with `vi.useFakeTimers({ toFake: ['Date'] })` and `vi.setSystemTime(...)` at 09:30 Beijing time (inside the default 09:00-12:00 window) and later at 13:30 Beijing time (off-peak); a `RecordingAdapter` records the model every request was served under. It asserts that every entry loaded, that the served models were `peak-chat` then `default`, that the agent's request header records the switched model (model-visible ⟺ logged), and that the derived assistant message streamed correctly. The test opts into the 60-second timeout because cold-cache tsx resolution after the host/client program split can exceed the default 5-second budget.

### tests/tariff.spec.ts — tariff estimation and logging (12 tests)

The `DEEPSEEK_TARIFF` block (2 tests) pins the exact official prices (cache-hit input, cache-miss input, and output; peak and off-peak) for both `deepseek-v4-flash` and `deepseek-v4-pro`, and asserts every peak price is exactly twice its off-peak price (the official half-price rule). The `estimateCost` block (3 tests) checks per-column billing — cache-hit and cache-miss input tokens at their own rates, linearity in token counts, and a zero-cache-hit call — and `estimateSaving` (2 tests) checks the peak-price cost difference, positive when the preset is cheaper and negative when it is more expensive. The validation block (3 tests) asserts user tariff entries merge over the built-in table and that a negative or non-finite price throws `tariff for model "..." must carry non-negative peak and off-peak prices`. The logging block (2 tests) captures `peak-pricing` info messages through a `ctx.logger.exporter()` and asserts the peak-price comparison line is emitted when both models have tariff entries and omitted when the resolved model has none.

### tests/invariant.spec.ts — invariant companion (2 tests)

These mount `@deepseek-ai/dsh-invariants` followed by `src/invariant.ts` in a fresh context and assert that the companion registers as the package owner and disposes cleanly, and that it names itself `peak-pricing-invariant` with `inject: ['invariants']`.

## Build & Publish

### Build output

After `pnpm run build`, `lib/` looks like this:

```text
lib/
  index.js            bundled root plugin — export "."
  invariant.js        bundled invariant companion — export "./invariant"
  types/
    index.d.ts        types for the root export
    invariant.d.ts    types for the "./invariant" export
    *.js / *.map      tsc intermediates consumed by tsdown (not published)
```

### Pre-publish checklist

- `exports` maps `.` and `./invariant`, each pointing its JS at the bundled `lib/` entry and its types at `lib/types/*.d.ts`, plus `./package.json`; keep every entry in sync when adding subpaths.
- `files` ships exactly `lib/index.js`, `lib/invariant.js`, and `lib/types/**/*.d.ts` — the tsc intermediates and maps stay out of the tarball.
- `peerDependencies` (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-llm`) are supplied by the host deployment; `@deepseek-ai/schemastery` is the only runtime dependency.
- The current version is `0.1.0-rc.6` with `publishConfig.access: public`.

### Publishing

```bash
pnpm run typecheck
pnpm run test
pnpm run build
npm publish
```

`npm publish` reads `publishConfig.access: public`, so the package reaches the public registry without an `--access public` flag. Bump the version per semver for each release; the Conventional Commits history keeps the changelog derivable.

## Code Conventions

### Function plugin shape

Each plugin module exports named members only — `name`, `inject`, and `apply`, plus the `Config` schemastery schema for the root plugin — and has no default export. The root plugin registers with `ctx.on('agent/created')` and installs its `agent/request` waterfall listener on the agent scope with `prepend: true`, making it the outermost transformation while a window is open; the listener lives on and is disposed with the agent scope. The companion exports the same trio and registers package ownership through `ctx.invariants.register`.

### Documentation

Every public export carries JSDoc: a module-level doc comment, `@param` for parameters and `@returns` for returns, and contract notes for non-obvious behavior such as the `[start, end)` window semantics and the `reasoningEffort` replacement rules.

### Loud failure on misconfiguration

Configuration is validated once at load in `resolveConfig()`, and any problem throws a `peak-pricing:`-prefixed error when the plugin mounts — never a silent skip. This covers the timezone, the `HH:mm` syntax and range, `start < end`, a non-empty window list, a parseable `effectiveFrom`, and non-empty `peak.provider`/`peak.model`.

### Invariant companion rules

`src/invariant.ts` deliberately installs a no-op invariant and explains why in its JSDoc: the peak switch is a per-request live transformation of the resolved request config, and the package appends no durable event and owns no mutable data relation — the effective provider/model is already logged and governed by the agent loop's `request/header` events. Companions assert owned relationships; with none, an explained empty companion is correct.

## Commit Conventions

Commits follow Conventional Commits, matching the existing history (`feat: standalone dsh-peak-pricing plugin`): `feat:` for new behavior, `fix:` for bug fixes, `docs:` for documentation-only changes, and the other standard types as appropriate.
