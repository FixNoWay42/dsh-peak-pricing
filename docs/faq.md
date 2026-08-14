# FAQ

Frequently asked questions about `@deepseek-ai/dsh-peak-pricing`, the Cordis function plugin that routes agent model requests to a preset cheap model during configured peak-price windows.

## Why does the switch not engage during peak hours?

Walk this checklist in order: the `timezone` you configured is the wall clock the windows are expressed in — the default `Asia/Shanghai` runs 8 hours ahead of UTC, so a `09:00` window means `01:00` UTC and comparing UTC hours will misread every hit; a window is `[start, end)` — start inclusive, end exclusive — so `12:00:00` Beijing time is already outside `09:00-12:00`; when `effectiveFrom` is set, no request is switched before that RFC 3339 instant; the preset `provider` must name a route the LLM seam has registered (for example `deepseek` or `mock`) — an unknown route fails at request time, not at plugin load; and consumers that call `ctx.llm.stream()` directly never enter the agent loop's `agent/request` waterfall, so they bypass the switch by design (they bypass model selection too).

## Does the peak preset conflict with the session's model selection?

In-window the preset wins, out-of-window the selection wins: the switch installs its `agent/request` listener on the agent scope with `prepend: true`, so while a window is open it is the outermost waterfall transformation and replaces whatever the session's model selection resolved via `next()`; outside the windows the listener awaits `next()` and returns the resolved config unchanged, so the session's selection applies.

## How do timezone and daylight saving time work?

Windows are daily local wall-clock ranges in the single configured IANA timezone; the default `Asia/Shanghai` is UTC+8 with no daylight saving time, so Beijing windows never shift. For timezones that observe DST, wall-clock determination goes through `Intl.DateTimeFormat` against the IANA database, so the windows honor the local clock including transitions — the same `09:00-12:00` covers a different UTC span the week before and after a timezone's spring-forward or fall-back.

## Can a window cross midnight?

No, by design: a window whose `end` is not later than its `start` is rejected at load with `peak-pricing: window start must precede end, got ...`, so a single `22:00-02:00` window cannot be written. Express the same coverage as two adjacent windows instead, e.g. `{ start: '22:00', end: '23:59' }` plus `{ start: '00:00', end: '02:00' }`.

## Peak hours are cheap for me — what if I still want the expensive model?

The preset is just a provider/model pair — nothing forces it to be cheap — so point `peak.provider` and `peak.model` at the expensive model and the "peak preset" becomes the expensive one; alternatively, simply do not mount the plugin, because without it no transformation happens at all.

## My deployments run in different timezones — how do I configure them?

Timezone is fixed per mount: one `timezone` applies to all windows of one instance, so each deployment sets its own `timezone` (and its own `peakWindows`) in its own cordis.yml. Because the plugin's `name` is the same (`peak-pricing`) everywhere, mounting several instances inside one process requires distinct package entries in the compose file.

## What does the error "peak.provider and peak.model are required" mean?

It is a load-time error thrown from `resolveConfig()` when `apply()` runs with a `peak` preset missing a non-empty `provider` or `model`; the full message is `peak-pricing: peak.provider and peak.model are required`. Fix it by supplying both fields in `config.peak`. Its siblings all fail the same way at mount: an unknown timezone yields `timezone ... is not a valid IANA timezone`, malformed times `window time must be HH:mm`, out-of-range times `window time out of range`, inverted windows `window start must precede end`, an empty list `at least one peak window is required`, and an unparseable `effectiveFrom` `effectiveFrom must be a parseable instant`.

## How do the tests verify time without waiting for real peak hours?

Two mechanisms, one per test layer: the unit tests inject a clock — `apply(ctx, config, { now: () => date })` through `PeakPricingInternals.now` — so every request classification uses a deterministic instant without touching the system clock; the Loader-composition test instead freezes the real clock with `vi.useFakeTimers({ toFake: ['Date'] })` and `vi.setSystemTime(...)` while driving a real agent loop through the Loader. Both approaches make the peak/off-peak instants exact, and between them every time-dependent test is deterministic.
