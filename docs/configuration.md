# Configuration

This is the configuration reference for the `@deepseek-ai/dsh-peak-pricing` Cordis function plugin (npm package `@deepseek-ai/dsh-peak-pricing`). During configured peak-price windows the plugin routes every agent model request to a preset cheap `provider`/`model` pair; outside the windows the resolved request config is returned unchanged. The plugin's internal name is `peak-pricing`, it injects the `agents` service (`inject: ['agents']`), and in a Cordis compose file the entry is the npm package name with the plugin's settings under its `config` key.

## Overview

The switch is a per-request live transformation of the resolved request config at the `agent/request` waterfall: during a peak window the preset `provider`/`model` pair replaces whatever the session resolved; outside the windows the resolved config is passed through untouched. All settings below are validated at load, and an invalid configuration fails loud when the plugin mounts instead of degrading silently.

## Field reference

Top-level fields:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `timezone` | `string` | No | `'Asia/Shanghai'` | IANA timezone in which all peak windows are interpreted; one timezone applies to every window. |
| `peakWindows` | `PeakWindow[]` | No | `[{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]` | Daily peak windows, each with start inclusive and end exclusive. |
| `effectiveFrom` | `string` | No | none (switch active immediately) | RFC 3339 instant before which the switch never engages. |
| `peak` | `PeakPreset` | Yes | — (no default) | Required preset model selection used during peak windows. |

`PeakWindow` (`{ start, end }`, both fields required):

| Field | Type | Description |
|---|---|---|
| `start` | `string` | Inclusive local start of the window, strict `HH:mm`. |
| `end` | `string` | Exclusive local end of the window, strict `HH:mm`; must be later than `start`. |

`PeakPreset` (the `peak` object):

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | Yes | A registered LLM route, for example the DeepSeek adapter's `deepseek`. |
| `model` | `string` | Yes | A model id that the route serves, for example `deepseek-chat`. |
| `reasoningEffort` | `string` | No | Adapter-owned reasoning effort applied during peak; when absent, the inherited effort is dropped and the provider/default behavior applies. |

The TypeScript types as exported by the package:

```ts
interface PeakWindow {
  /** Inclusive local start, HH:mm. */
  start: string
  /** Exclusive local end, HH:mm; must be later than start. */
  end: string
}

interface PeakPreset {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}
```

## `timezone`

The timezone all peak windows are expressed in. Default `'Asia/Shanghai'` (Beijing time, UTC+8, no daylight saving). Any IANA timezone is accepted, for example `UTC`, `America/New_York`, or `Europe/Berlin`.

The value is validated at load with an `Intl.DateTimeFormat` probe; an unknown or empty zone throws `peak-pricing: timezone "..." is not a valid IANA timezone` (the message embeds the offending value, for example `peak-pricing: timezone "Mars/Olympus" is not a valid IANA timezone`).

## `peakWindows`

An array of daily peak windows. Default `[{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]`. Each window is a `{ start, end }` pair of strict `HH:mm` strings — hour and minute must both be exactly two digits — and validation runs per endpoint in this order:

1. Format: a value that is not exactly `HH:mm` throws `peak-pricing: window time must be HH:mm, got "9:00"`.
2. Range: hour > 23 or minute > 59 throws `peak-pricing: window time out of range, got "24:00"`.
3. Order: a start that is not strictly before its end (equal or reversed) throws `peak-pricing: window start must precede end, got {"start":"12:00","end":"12:00"}`.

The array itself must not be empty: `peakWindows: []` throws `peak-pricing: at least one peak window is required`. Omit the key entirely to keep the default windows; an explicit empty array is an error. Because `end` must be strictly later than `start`, midnight-crossing windows such as `22:00`–`02:00` cannot be expressed — configure only windows that fit inside a single day.

## `effectiveFrom`

Optional RFC 3339 instant (for example `2026-08-17T00:00:00Z` or `2026-08-17T00:00:00+08:00`) that gates the whole switch. Validation is a `Date.parse` probe: an unparseable value throws `peak-pricing: effectiveFrom must be a parseable instant, got "not-a-date"`. When omitted the switch is active immediately (subject to the windows); when set, no request is switched before that instant, even inside a window. It is a one-time global effective date, not a schedule.

## `peak`

Required object that selects the preset model. `provider` and `model` are both required and must be non-empty strings: an empty `provider` or an empty `model` throws `peak-pricing: peak.provider and peak.model are required`. `provider` names a route the host has registered (for example the DeepSeek adapter's `deepseek`); `model` names a model id that route serves (for example `deepseek-chat`). The optional `reasoningEffort` is applied only when declared; an inherited reasoning effort from the resolved request is discarded, mirroring model-selection semantics.

## Window semantics

Each window is a daily local wall-clock range `[start, end)`: the start minute is inside the window, the end minute is outside. Classification compares the wall-clock minutes of the current instant in the configured `timezone` (computed with `Intl.DateTimeFormat`). The endpoints are plain `HH:mm` values and are never DST-adjusted; a zone without daylight saving such as `Asia/Shanghai` behaves identically, and DST shifts in other zones only move which wall-clock minutes the instant lands on, never the window boundaries.

With the default windows: 09:00 and 11:59 Beijing time are peak, 12:00 is not; 14:00 is peak, 18:00 is not; midnight and 23:59 are off-peak. The schedule repeats every calendar day.

## Switch behavior

A request is switched when both conditions hold at the instant of the request: the instant is not before `effectiveFrom` (when set), and its wall-clock time in `timezone` falls inside at least one window. During a peak window the preset `provider`/`model` replaces the resolved request's pair; an inherited `reasoningEffort` is dropped and the preset's own value, when declared, is applied; all other request fields (for example `temperature`) pass through unchanged.

The listener is registered on the agent scope with `prepend`, making it the outermost `agent/request` waterfall transformation: while a window is open the preset wins over the session's model selection, and outside the windows the session's selection applies. The listener is disposed together with the agent scope.

## Validation order

`resolveConfig` validates in a fixed order and fails on the first violation, so only one error surfaces at a time: timezone probe, then each window endpoint (format, range, order), then the non-empty array check, then `effectiveFrom` parsing, then the `peak.provider`/`peak.model` presence check.

## YAML examples

The configuration lives under the plugin entry's `config` key in a Cordis compose file.

Full example — all optional fields, with comments:

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    # IANA timezone in which every peak window is expressed.
    # Default: Asia/Shanghai (Beijing time, UTC+8, no daylight saving).
    timezone: Asia/Shanghai
    # Daily peak windows, [start, end): start inclusive, end exclusive.
    # Both endpoints are strict HH:mm. Default: 09:00-12:00, 14:00-18:00.
    # Midnight-crossing windows are rejected at load.
    peakWindows:
      - start: '09:00'
        end: '12:00'
      - start: '14:00'
        end: '18:00'
    # Optional RFC 3339 instant; before it the switch never engages.
    # Omit for immediate effect.
    effectiveFrom: '2026-08-17T00:00:00+08:00'
    # Required preset model selection applied during a peak window.
    peak:
      provider: deepseek      # Required: a registered LLM route.
      model: deepseek-chat    # Required: a model id that route serves.
      reasoningEffort: low    # Optional: applied during peak; inherited effort is dropped.
```

Minimal example — everything except `peak` keeps its default:

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    peak:
      provider: deepseek
      model: deepseek-chat
```

## Common configuration errors

| Misconfiguration | Error message | Fix |
|---|---|---|
| Unknown `timezone`, e.g. `Mars/Olympus` | `peak-pricing: timezone "Mars/Olympus" is not a valid IANA timezone` | Use a valid IANA zone such as `Asia/Shanghai`, `UTC`, or `Europe/Berlin`. |
| Empty `timezone` (`''`) | `peak-pricing: timezone "" is not a valid IANA timezone` | Set a valid IANA zone or omit the key to use the default. |
| Window endpoint that is not `HH:mm`, e.g. `9:00` | `peak-pricing: window time must be HH:mm, got "9:00"` | Pad hour and minute to two digits: `09:00`. |
| Out-of-range window endpoint, e.g. `24:00` or `09:60` | `peak-pricing: window time out of range, got "24:00"` | Use a real clock time between `00:00` and `23:59`. |
| Equal or reversed window, e.g. `12:00`–`12:00` | `peak-pricing: window start must precede end, got {"start":"12:00","end":"12:00"}` | Make `start` strictly earlier than `end`; midnight-crossing windows cannot be expressed. |
| Explicit empty array `peakWindows: []` | `peak-pricing: at least one peak window is required` | Omit the key to keep the default windows, or list at least one window. |
| Unparseable `effectiveFrom`, e.g. `not-a-date` | `peak-pricing: effectiveFrom must be a parseable instant, got "not-a-date"` | Use an RFC 3339 instant such as `2026-08-17T00:00:00Z`. |
| Empty `peak.provider` or `peak.model` | `peak-pricing: peak.provider and peak.model are required` | Provide non-empty `provider` and `model` inside `peak`. |
| `peak` object missing entirely | Rejected by the plugin schema at load (no `peak-pricing:` message; the required field is missing) | Add a `peak` object with non-empty `provider` and `model`. |