# Installing @deepseek-ai/dsh-peak-pricing

`@deepseek-ai/dsh-peak-pricing` (v0.1.0-rc.6) is a Cordis function plugin that routes agent model requests to a preset cheap model during configured peak-price windows, so price spikes never hit a costly session selection.

## Prerequisites

- **Node.js** `^22.19` or `>=24` (the engines range of the deepseek-harness monorepo).
- **pnpm** for installing dependencies and running the test suite.
- **A Cordis host**: a deepseek-harness (dsh) deployment, or any Cordis application that mounts `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, and `@deepseek-ai/cordis`; the plugin injects the `agents` service (`inject: ['agents']`) and listens on the `agent/request` waterfall, so all three are required at runtime.

Peer dependencies are provided by the host, never installed by this package: `@deepseek-ai/cordis` (^4.0.1), `@deepseek-ai/dsh-agent` (^0.1.0-rc.6), `@deepseek-ai/dsh-invariants` (^0.1.0-rc.6), and `@deepseek-ai/dsh-llm` (^0.1.0-rc.6).

## Option A: Mount inside the deepseek-harness monorepo

`@deepseek-ai/dsh-peak-pricing` is a workspace member of the deepseek-harness monorepo (packages/llm/peak-pricing), so no separate `npm install` is needed — pnpm resolves the package from the workspace.

Add a single entry to your `cordis.yml`:

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
```

The entry mounts with the built-in defaults (timezone `Asia/Shanghai`, windows 09:00-12:00 and 14:00-18:00); only the preset selection is required:

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    peak:
      provider: deepseek
      model: deepseek-chat
```

`peak.provider` and `peak.model` are required and validated at load; an unknown timezone, malformed or empty windows, an unparseable `effectiveFrom`, or a missing preset field fails loud when the plugin mounts.

## Option B: Install as a standalone package

In any Cordis application whose host already provides the peer dependencies:

```bash
pnpm add @deepseek-ai/dsh-peak-pricing
```

The peer dependencies — `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-invariants`, and `@deepseek-ai/dsh-llm` at `^0.1.0-rc.6`, and `@deepseek-ai/cordis` at `^4.0.1` — must match the versions your host mounts; pnpm reports the mismatch if they do not.

Then mount the plugin in your own `cordis.yml`:

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    timezone: Asia/Shanghai
    peakWindows:
      - start: '09:00'
        end: '12:00'
      - start: '14:00'
        end: '18:00'
    effectiveFrom: '2026-08-17T00:00:00+08:00'
    peak:
      provider: deepseek
      model: deepseek-chat
```

## Option C: Install from source

```bash
git clone http://liuyuesong.asia:8360/open/dsh-peak-pricing.git
cd dsh-peak-pricing
pnpm install
pnpm run build
```

`pnpm run build` runs `tsc -p tsconfig.json && tsdown`; the artifacts land in `lib/` — `lib/index.js`, `lib/invariant.js`, and type declarations under `lib/types/`. Mount the built package from your own `cordis.yml` exactly as in Option B.

## Verifying the installation

Run the test suite in the repository:

```bash
pnpm run test
```

17 tests pass across three specs (`peak-pricing`, `invariant`, `loader-composition`), including a real Loader composition test that boots the plugin through the actual Cordis Loader together with the host plugins (dsh-llm, dsh-session, dsh-system-prompt, dsh-tools, dsh-agent, dsh-agent-loop) and asserts the served model per request.

Then start your host and watch the logs: once the plugin is mounted, agent model requests inside a peak window carry the preset `provider`/`model` pair instead of the session-selected one, and requests outside the windows keep the session's selection.

## Version compatibility

The peerDependencies mirror the npm published versions this release was built against: `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-invariants`, and `@deepseek-ai/dsh-llm` at `^0.1.0-rc.6`, and `@deepseek-ai/cordis` at `^4.0.1`.
