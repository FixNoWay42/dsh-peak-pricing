# Usage

[English](usage.md) | [简体中文](usage.zh.md)

`@deepseek-ai/dsh-peak-pricing` is a Cordis function plugin that routes agent model requests to a preset cheap model during configured peak-price windows, so price spikes never hit a costly session selection. This page shows how to configure it in a deepseek-harness deployment, what to observe to confirm it works, how to drive it programmatically, and how to troubleshoot. See the README for the model-experience details and the known limitations; everything below reflects the implementation in `src/index.ts` and the tests.

## Typical scenario: DeepSeek API peak pricing

DeepSeek API pricing varies by time of day, with peak windows billed at a higher per-token rate than off-peak hours. As an example, assume the peak windows are 09:00-12:00 and 14:00-18:00 Beijing time (these are also the plugin defaults). During those windows the plugin replaces the resolved provider/model pair with a preset cheap model such as `deepseek-chat`, so every agent model request in the peak window bills at the cheap rate; outside the windows the session-selected (or default) model is used unchanged. The switch is a per-request live transformation of the resolved request config at the `agent/request` waterfall: during a peak window the preset provider/model pair replaces whatever the session resolved, and outside the windows the resolved config is returned unchanged.

## Configure in deepseek-harness

Mount the plugin entry in your `cordis.yml` and point `peak` at a provider/model pair the host has already registered — for the DeepSeek adapter that is `provider: deepseek` with `model: deepseek-chat`. The LLM seam, session, system prompt, tools, agent registry, and agent loop all come from the host; the plugin only needs its own entry placed among them. The plugin injects the `agents` service, and the real-Loader composition in `tests/loader-composition.spec.ts` places the entry after `dsh-agent` and before `dsh-agent-loop`:

```yaml
- name: '@deepseek-ai/dsh-llm'

- name: '@deepseek-ai/dsh-session'

- name: '@deepseek-ai/dsh-system-prompt'

- name: '@deepseek-ai/dsh-tools'

- name: '@deepseek-ai/dsh-agent'

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

- name: '@deepseek-ai/dsh-agent-loop'
```

The config fields: `timezone` is the IANA timezone in which all windows are interpreted, defaulting to `Asia/Shanghai` (Beijing time, UTC+8, no daylight saving); `peakWindows` is a list of daily local wall-clock ranges, each start inclusive and end exclusive, defaulting to 09:00-12:00 and 14:00-18:00, and a window whose `end` is not later than its `start` is rejected at load (midnight-crossing windows are not expressible); `effectiveFrom` is an optional RFC 3339 instant before which the switch never engages, defaulting to none (engage immediately); `peak` is required and holds the preset selection — `provider` and `model` are required, and an optional `reasoningEffort` applies only when the preset declares it, while an inherited reasoning effort from the resolved request is discarded (mirroring model-selection semantics). An unknown timezone, malformed or empty windows, an unparseable `effectiveFrom`, or a missing preset field fails loud when the plugin mounts.

## effectiveFrom: starting on a date

`effectiveFrom` is a one-time global effective date expressed as an RFC 3339 instant, not a schedule. Before that instant every request is untouched, even inside a window; from that instant on (or immediately, when omitted) the windows apply. The check is a plain instant comparison: while `now < effectiveFrom`, the switch never engages, regardless of the wall clock. Use it to align the plugin with a price change, for example `'2026-08-17T00:00:00+08:00'` to start switching from 00:00 Beijing time on 2026-08-17.

## Behavior confirmation

During a peak window every request carries the preset provider/model pair, and the applied selection is the ordinary request resolution already recorded by the agent loop (model-visible ⟺ logged), so confirm it via the session request header:

```ts
const header = agent.session.requestHeader()
console.log(header?.config) // { provider: 'deepseek', model: 'deepseek-chat' } during a peak window
```

Outside the windows the resolved config is returned unchanged, and the session-selected model appears in the header. The switch adds no prompt text, system section, tool, or model-visible state, and it changes no tokens — only the model choice, so peak-time requests bill at the preset's rate and off-peak requests at the resolved model's rate. Two boundaries matter: a window's start is inclusive and its end exclusive, so 12:00 is not peak for the 09:00-12:00 window and 18:00 is not peak for the 14:00-18:00 window; and direct `ctx.llm.stream()` consumers that never enter the agent loop's `agent/request` waterfall are untouched — raw adapter calls bypass the switch entirely.

## Interaction with model selection (installModelSelection)

The runtime installs the session's model selection during pre-publication setup, before `agent/created` fires; the peak switch registers its `agent/request` listener afterwards with `prepend` on the agent scope, so it is the outermost waterfall transformation and wins over the session's model selection while a window is open. Outside the windows, `next()` resolves normally and the session's selection applies. In short: during a peak window the preset wins; off-peak the user-selected model wins. The prepend ordering is only guaranteed against the built-in model selection — another plugin that deliberately registers `agent/request` even more outwardly overrides the peak preset.

## Programmatic use

The plugin can also be mounted from TypeScript instead of the loader. The same entry exports the `apply` installer, the pure `isPeakTime` classifier, and the `Config` schema/type:

```ts
import { apply, isPeakTime, type Config } from '@deepseek-ai/dsh-peak-pricing'
import type { Context } from '@deepseek-ai/cordis'
```

`apply(ctx, config)` validates the config (failing loud at load) and installs the switch for agents created afterwards: for each `agent/created`, it registers a `prepend` `agent/request` listener on the agent scope, which is disposed with the agent.

```ts
const config: Config = {
  timezone: 'Asia/Shanghai',
  peakWindows: [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  effectiveFrom: '2026-08-17T00:00:00+08:00',
  peak: { provider: 'deepseek', model: 'deepseek-chat' },
}

apply(ctx, config)
```

`isPeakTime(now, timezone, windows)` is a pure classification function available for standalone checks — it answers "is this instant inside any window" in the given timezone, with each window's start inclusive and end exclusive:

```ts
import { isPeakTime } from '@deepseek-ai/dsh-peak-pricing'

const windows = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '18:00' },
]
const peak = isPeakTime(new Date(), 'Asia/Shanghai', windows)
```

`apply` accepts an optional third argument, `PeakPricingInternals`, whose `now` hook supplies the current instant and defaults to the system clock — the supported way to make time decisions deterministic in tests:

```ts
import { apply } from '@deepseek-ai/dsh-peak-pricing'

apply(ctx, config, {
  now: () => new Date('2026-08-17T01:30:00Z'), // 09:30 Beijing — inside the morning window
})
```

## Multiple timezones or window sets

A single mount carries a single configuration set: one `timezone` applies to all windows of that instance. To cover several timezones, or several independent window sets, in the same process you mount multiple plugin instances. Every instance shares the same plugin `name` (`peak-pricing`), so give each instance a distinct package entry (a separate list item) in the compose file, each with its own complete config — its own timezone, windows, preset, and optional `effectiveFrom`. Each mount is an independent switch with no cross-instance coordination.

## Troubleshooting

### The switch seems not to engage

Check in order: is the entry mounted and the plugin loaded (mount-time validation throws as described below, so a missing or invalid entry means no listener at all)? Is `peak.provider` a route the host actually registered — load only requires non-empty strings, and an unknown provider surfaces at request dispatch by the LLM runtime, not at mount? Is `timezone` a valid IANA zone and is it the zone the deployment's price windows are defined in — windows are evaluated in the configured timezone, not the server's local time? Is the current wall clock inside a window, remembering that start is inclusive and end exclusive? Has `effectiveFrom` passed — before it, the switch never engages even inside a window? And is the request actually going through the agent loop — direct `ctx.llm.stream()` calls bypass the waterfall and are never switched? The request header (`agent.session.requestHeader()?.config`) shows which model actually served.

### Mount-time error messages

- `$.peak missing required value` / `$.peak.provider missing required value` / `$.peak.model missing required value` — schema validation: the `peak` preset or one of its required fields is absent (an empty string passes the schema but is then rejected by the next check).
- `peak-pricing: peak.provider and peak.model are required` — the preset's `provider` or `model` is an empty string.
- `peak-pricing: timezone "..." is not a valid IANA timezone` — the `timezone` field is not a known IANA zone.
- `peak-pricing: window time must be HH:mm, got "..."` — a window endpoint is not in `HH:mm` form, for example `'9:00'`.
- `peak-pricing: window time out of range, got "..."` — an hour above 23 or a minute above 59, for example `'24:00'`.
- `peak-pricing: window start must precede end, got {...}` — the window's `end` is not later than its `start`; this also rejects midnight-crossing windows such as 22:00-02:00.
- `peak-pricing: at least one peak window is required` — `peakWindows` resolved to an empty list.
- `peak-pricing: effectiveFrom must be a parseable instant, got "..."` — `effectiveFrom` is not a valid RFC 3339 instant.
