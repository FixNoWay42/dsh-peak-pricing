# `@deepseek-ai/dsh-peak-pricing`: Architecture and Working Principles

English | [中文](architecture.zh.md)

## Overview

`@deepseek-ai/dsh-peak-pricing` is a Cordis function plugin that routes agent model requests to a preset cheap provider/model pair during configured peak-price windows, so a price spike never hits a costly session-selected model. The switch is a per-request live transformation of the resolved request config at the `agent/request` waterfall: inside a window the preset replaces whatever the session resolved; outside, the resolved config is returned unchanged. The package is tiny: two source files (`src/index.ts`, `src/invariant.ts`) and three test files that pin the behavior (`tests/peak-pricing.spec.ts`, `tests/loader-composition.spec.ts`, `tests/invariant.spec.ts`).

## Plugin shape

The entry point is a function plugin with named exports only — `name`, `inject`, `Config`, and `apply` — and no default export, which is the Cordis Loader convention: the Loader imports the package entry as a module namespace and resolves the plugin from these named members.

```ts
export const name = 'peak-pricing'
export const inject = ['agents']
export interface Config { /* timezone, peakWindows, effectiveFrom, peak */ }
export const Config: z<Config> = z.object({ /* schemastery schema with defaults */ })
export function apply(ctx: Context, config: Config, internals: PeakPricingInternals = {}): void
```

`inject = ['agents']` declares the dependency on the agent registry service, so the plugin mounts only after the registry exists and can deliver `agent/created` events. `Config` is declared twice by design: the interface is the TypeScript view, and the same-named constant is a schemastery `z` schema the Loader validates `cordis.yml` config against, applying defaults (`timezone` `'Asia/Shanghai'`, the two default windows from `DEFAULT_PEAK_WINDOWS`) before `apply` ever runs. `apply` receives the validated config plus an optional `internals.now` test hook that replaces the system clock so tests can freeze time deterministically; in production it defaults to `new Date()`. A second entry point, `@deepseek-ai/dsh-peak-pricing/invariant` (`src/invariant.ts`), exports the invariant companion plugin `peak-pricing-invariant` with `inject = ['invariants']`.

## Extension point: the `agent/request` waterfall

The switch hooks exactly one extension point: the `agent/request` waterfall on the agent scope. A waterfall listener is `(payload, next) => Promise<LlmCallConfig>` — it receives the request payload and a `next` delegate, and its return value is the config the request actually uses. The payload carries `{ turn, step, signal }` (see the agent loop's `buildRequest`); the innermost `next` resolves to the seed config built from the agent options and the persisted request header.

Waterfall semantics (Cordis `events.ts`): listeners for one event are kept in an array in registration order, `prepend` inserting at the front instead of the back. Dispatch runs them outermost-first — `next()` shifts from the front of the array, falling back to the innermost callback once the array is empty — so the first-registered listener is the outermost transformation and its return value is the final waterfall result. A listener that returns without calling `next()` vetoes the rest of the chain, so waterfall listeners must always delegate via `next()`.

The peak listener registers with `{ prepend: true }`, which `unshift`s it to index 0: although it is installed after the built-in model selection, it becomes the outermost transformation, and its return value — the preset during a window, the passed-through proposal outside — wins.

```ts
agent.ctx.on('agent/request', async (_payload, next) => {
  const proposed = await next()
  if (!shouldSwitch(now(), resolved)) return proposed
  return applyPeakPreset(proposed, resolved.peak)
}, { prepend: true })
```

## Timing: model selection vs. peak switch

Ordering is what makes the plugin work, and it is pinned by the `wins over installModelSelection` test. The host installs `installModelSelection` on the agent scope during pre-publication setup, before the agent is announced — its `agent/request` listener is pushed first. The plugin's `apply` registers a root-context `agent/created` listener; when an agent is announced (`{ agent }`), it installs the peak listener on that agent's scope with `prepend: true`, unshifting it ahead of the model-selection listener. Inside a window the preset therefore replaces the selection; outside, `shouldSwitch` is false and the peak listener returns the resolved config unchanged, so `next()`'s result — the session selection — passes through untouched.

## Scope lifecycle

Both listeners live on the agent scope, not on the plugin context. Cordis registers listeners as fiber effects, so disposing a scope disposes its listeners. The `disposes the agent/request listener with the agent scope` test proves it: after `scope.dispose()`, the same waterfall with the same frozen peak clock resolves to the seed config — the peak listener is gone and nothing rewrites the request. The root-context `agent/created` listener is likewise a fiber effect of the mounting context and disappears with it. The listener is installed once per agent at creation; because the switch keeps no per-agent mutable state, no per-agent teardown beyond the scope's own disposal is needed.

## Per-request live transformation

The switch keeps no state and registers no session events. Every request is decided from scratch: take the current instant, classify its wall clock against the windows, and return either the preset-replaced config or the proposal unchanged. This is why the switch is described as a live transformation of the resolved request config rather than a stateful routing table.

`applyPeakPreset` replaces `provider`/`model` with the preset pair and drops any inherited `reasoningEffort` (destructured out), re-applying the preset's own effort via `ReasoningEffortId` only when the preset declares it — mirroring the model-selection semantics in `installModelSelection`.

Model-visible ⟺ logged: whatever the waterfall resolves is exactly what the agent loop binds and records. `buildRequest` canonicalizes the final config into the `request/header` session event before streaming to the adapter; the `loader-composition.spec.ts` test drives a real Loader and asserts `agent.session.requestHeader()?.config` matches the model the adapter actually served (`peak-chat` inside the window, `default` outside). The package appends no durable event of its own, which is exactly why the invariant companion is empty: there is no owned mutable-data relation and no extra log record to assert, because the effective provider/model is already logged and governed by the agent loop's `request/header` events.

## Wall-clock time computation

Window membership is decided in the configured timezone's local wall clock, with no third-party timezone library. `wallClockMinutes` formats the instant with `Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })` and reads the `hour`/`minute` parts out of `formatToParts`; `hourCycle: 'h23'` yields 00-23 hours with no AM/PM ambiguity. The result is minutes since local midnight.

A window `[start, end)` is matched inclusively at `start` and exclusively at `end`: `minutes >= start && minutes < end`. `isPeakTime` classifies an instant against raw `PeakWindow`s (parsing each endpoint on call); `shouldSwitch` applies the same comparison to the pre-parsed windows and additionally returns false before `effectiveFrom` when set. `resolveConfig` pre-parses every window endpoint into minutes at load time, so the per-request hot path only compares integers.

## Load-time validation

`resolveConfig` runs synchronously inside `apply`, so a bad configuration fails loud when the plugin mounts instead of silently misrouting later. It throws for: an unknown IANA timezone (probed by constructing `Intl.DateTimeFormat` with it — a `RangeError` for unknown zones), a window endpoint that is not `HH:mm`, an hour above 23 or minute above 59, a window whose `start` is not before its `end`, an empty window list, an unparseable `effectiveFrom` instant, and a preset missing `provider` or `model`. The `config validation at load` test group asserts each error; the defaults test asserts that omitting `timezone`/`peakWindows` is accepted.

## Request flow

```mermaid
sequenceDiagram
    participant Host as "Host runtime"
    participant Root as "Plugin root ctx"
    participant Scope as "Agent scope"
    participant Peak as "Peak listener (outermost)"
    participant Select as "Model-selection listener"
    participant Loop as "Agent loop"
    participant Adapter as "LLM adapter"

    Host->>Scope: setup: installModelSelection before publication
    Host->>Root: announce agent → emit agent/created
    Root->>Scope: agent.ctx.on('agent/request', listener, { prepend: true })

    Loop->>Scope: dispatch agent/request waterfall (seed as innermost next)
    Scope->>Peak: outermost listener runs first, awaits next()
    Peak->>Select: next()
    Select-->>Peak: resolved config (session selection applied; next() reached seed)
    Peak->>Peak: shouldSwitch(now())?
    alt inside a peak window
        Peak-->>Loop: preset config (provider/model replaced, inherited effort dropped)
    else outside every window
        Peak-->>Loop: resolved config unchanged
    end
    Loop->>Adapter: prepareCall + stream with final config
    Loop->>Loop: record request/header event (model-visible ⟺ logged)
```

The switch only ever sees requests that enter the agent loop's `agent/request` waterfall; direct `ctx.llm.stream()` consumers that bypass the loop are untouched.

## Design tradeoffs

### No tariff table or billing integration

The switch keys on configured wall-clock windows only. It never reads API price lists, and `effectiveFrom` is a one-time global effective date, not a schedule. Price data is provider-owned and volatile; routing on live prices would force the plugin to fetch, cache, and refresh price state — durable mutable state that would contradict the stateless per-request design and complicate the model-visible ⟺ logged guarantee. Declarative windows are deterministic, testable, and cheap to reason about.

### No off-peak preset

Outside the windows the plugin returns the resolved config unchanged, so the user's or session's model selection applies. An off-peak preset would fight the selection on the same extension point and override user intent; the plugin's contract is only to cap peak-hour cost, not to choose models when prices are normal. `next()` has already resolved the "correct" config — overriding it again would add a second transformation with no cost rationale.

### No midnight-crossing windows

A window's `end` must be later than its `start` — enforced at load with `start must precede end` — so a daily window like 22:00-02:00 is rejected. Supporting such windows would require either date arithmetic (which day's window is this?) or an implicit split into two windows, both of which complicate the model for a case the default Beijing-time windows never need.

## Source and test map

- `src/index.ts` — plugin entry: `apply`, `resolveConfig`, `shouldSwitch`, `applyPeakPreset`, `wallClockMinutes`, `isPeakTime`, schema and types.
- `src/invariant.ts` — empty invariant companion (`peak-pricing-invariant`).
- `tests/peak-pricing.spec.ts` — `isPeakTime` classification, load-time validation, peak/off-peak switching, reasoning-effort handling, `effectiveFrom` gating, ordering vs. `installModelSelection`, scope disposal.
- `tests/loader-composition.spec.ts` — real Loader composition; the served model equals the logged `requestHeader().config`.
- `tests/invariant.spec.ts` — the companion mounts cleanly and names itself after the package.
