# `@deepseek-ai/dsh-peak-pricing`

English | [中文](README.zh.md)

Route agent model requests to a preset cheap model during configured peak-price windows.

## Documentation

- [Installation](docs/installation.md) — requirements and install options (monorepo, npm, from source)
- [Configuration](docs/configuration.md) — every config field, defaults, validation, and examples
- [Usage](docs/usage.md) — mounting in deepseek-harness, behavior confirmation, programmatic use
- [Architecture](docs/architecture.md) — the `agent/request` waterfall, prepend ordering, and time semantics
- [Development](docs/development.md) — commands, tests, build, and publish
- [FAQ](docs/faq.md) — common questions and troubleshooting
- [Examples](examples/cordis.yml) — ready-to-mount `cordis.yml` files

## Overview

Function plugin that routes agent model requests to a preset cheap model during configured peak-price windows, so price spikes never hit a costly session selection. The switch is a per-request live transformation of the resolved request config at the `agent/request` waterfall: during a peak window the preset provider/model pair replaces whatever the session resolved; outside the windows the resolved config is returned unchanged.

Windows are daily local wall-clock ranges in a configurable IANA timezone, each start inclusive and end exclusive. The default is Beijing time (`Asia/Shanghai`, UTC+8, no daylight saving) with 09:00-12:00 and 14:00-18:00. An optional `effectiveFrom` RFC 3339 instant gates the switch: before it, every request is untouched; after it (or when omitted, immediately), the windows apply.

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

The preset's `provider`/`model` are required and validated at load; an unknown timezone, malformed or empty windows, an unparseable `effectiveFrom`, or a missing preset field fails loud when the plugin mounts. `provider` names a registered LLM route such as the DeepSeek adapter's `deepseek`, and `model` a model id that route serves. An optional `reasoningEffort` applies only when the preset declares it; an inherited reasoning effort from the resolved request is discarded (mirroring model-selection semantics).

Registration order matters: the switch installs its `agent/request` listener with `prepend` on the agent scope, so it is the outermost waterfall transformation and wins over the session's model selection while a window is open. Outside the windows, `next()` resolves normally and the session's selection applies. The listener lives on the agent scope and is disposed with the agent.

## Model Experience

### Peak-time model substitution

#### What the model sees

During a peak window, every request carries the preset `provider`/`model` pair instead of the session-selected one; outside the windows, the session's selection applies unchanged. The switch itself adds no prompt text, system section, tool, or model-visible state; the applied `provider`/`model` is the ordinary request resolution already recorded by the agent loop.

#### Token effect

Switching to a cheaper preset is a model choice, not a token transformation: the request payload, prompt, and completion budget are untouched. Peak-time requests bill at the preset's rate; off-peak requests at the resolved model's rate. The plugin contributes no tokens itself.

#### KV Cache effect

The request prefix is unchanged by the switch, so provider cache reuse under that provider's rules applies as usual. A provider/model switch changes the cache identity the provider keys on; deployments that want cache reuse across peak boundaries should pick a preset with the same serving route as the default model.

## Known Limitations and Deferred Work

- **No tariff table or billing integration** — the plugin switches on configured wall-clock windows only. It does not read API price lists, and `effectiveFrom` is a one-time global effective date, not a schedule.
- **Timezone is fixed per mount** — one `timezone` applies to all windows; multi-zone deployments mount multiple plugin instances (the `name` is the same, so use distinct package entries in the compose file).
- **No midnight-crossing windows** — a window whose `end` is not later than its `start` is rejected at load; two windows such as 22:00-02:00 stay unwritable.
- **Raw adapters bypass the switch** — direct `ctx.llm.stream()` consumers that never enter the agent loop's `agent/request` waterfall are untouched.
- **Precedence is waterfall order** — another plugin registering `agent/request` outermost deliberately overrides the peak preset; the prepend ordering is only guaranteed against the built-in model selection.
