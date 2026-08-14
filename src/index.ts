/**
 * Route agent model requests to a preset cheap model during configured
 * peak-price windows. The switch is a per-request live transformation of the
 * resolved request config: during a peak window the preset provider/model
 * pair replaces whatever the session selected; outside the windows the
 * resolved config is returned unchanged.
 *
 * @module @deepseek-ai/dsh-peak-pricing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

export const name = 'peak-pricing'
export const inject = ['agents']

/** Default peak windows: 09:00-12:00 and 14:00-18:00, Beijing time. */
export const DEFAULT_PEAK_WINDOWS = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '18:00' },
] as const satisfies readonly PeakWindow[]

/**
 * Official DeepSeek API tariff in CNY per million tokens, from
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing. Peak prices are
 * exactly twice the off-peak prices (off-peak is half price); both the new
 * tariff and the peak-window schedule take effect 2026-08-17 00:00 Beijing
 * time. Model ids are the provider-owned ids served by the `deepseek` route.
 */
export const DEEPSEEK_TARIFF: Readonly<Record<string, TariffEntry>> = {
  'deepseek-v4-flash': {
    peak: { inputCacheHit: 0.10, input: 3.0, output: 9.0 },
    offPeak: { inputCacheHit: 0.05, input: 1.5, output: 4.5 },
  },
  'deepseek-v4-pro': {
    peak: { inputCacheHit: 0.30, input: 9.0, output: 27.0 },
    offPeak: { inputCacheHit: 0.15, input: 4.5, output: 13.5 },
  },
}

/** One daily peak-price window in the configured timezone, local wall-clock time. */
export interface PeakWindow {
  /** Inclusive local start, HH:mm. */
  start: string
  /** Exclusive local end, HH:mm; must be later than start. */
  end: string
}

/** Preset model selection used during peak windows. */
export interface PeakPreset {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** One price point of a model, in the tariff's currency per million tokens. */
export interface TariffPrice {
  /** Price per million input tokens served from provider cache. */
  inputCacheHit: number
  /** Price per million input tokens served from cache miss. */
  input: number
  /** Price per million output tokens. */
  output: number
}

/** Peak and off-peak prices of one model. */
export interface TariffEntry {
  /** Price during peak windows. */
  peak: TariffPrice
  /** Price outside peak windows. */
  offPeak: TariffPrice
}

/** Plugin configuration. */
export interface Config {
  /** IANA timezone of the peak windows. Default `'Asia/Shanghai'` (Beijing time). */
  timezone?: string
  /** Peak windows in that timezone. Default: 09:00-12:00 and 14:00-18:00. */
  peakWindows?: PeakWindow[]
  /** RFC 3339 instant before which the switch never engages. Default: none (immediate). */
  effectiveFrom?: string
  /** Preset model selection used during peak windows. */
  peak: PeakPreset
  /** Optional per-model tariff overrides, merged over {@link DEEPSEEK_TARIFF}. */
  tariff?: Record<string, TariffEntry>
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  timezone: z.string().default('Asia/Shanghai'),
  peakWindows: z.array(z.object({
    start: z.string().required(),
    end: z.string().required(),
  })).default([...DEFAULT_PEAK_WINDOWS]),
  effectiveFrom: z.string(),
  peak: z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  }).required(),
  tariff: z.dict(z.object({
    peak: z.object({
      inputCacheHit: z.number().required(),
      input: z.number().required(),
      output: z.number().required(),
    }).required(),
    offPeak: z.object({
      inputCacheHit: z.number().required(),
      input: z.number().required(),
      output: z.number().required(),
    }).required(),
  })),
})

/** Non-serializable hooks used to make time decisions deterministic in tests. */
export interface PeakPricingInternals {
  /** Current instant; defaults to the system clock. */
  now?: () => Date
}

interface ResolvedConfig {
  timezone: string
  windows: readonly { start: number; end: number }[]
  effectiveFromMs: number | undefined
  peak: PeakPreset
  tariff: Readonly<Record<string, TariffEntry>>
}

/** Whether a tariff entry is a finite non-negative price point. */
function isFinitePrice(price: unknown): price is TariffPrice {
  if (typeof price !== 'object' || price === null) return false
  const { inputCacheHit, input, output } = price as Partial<TariffPrice>
  return [inputCacheHit, input, output].every(
    value => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  )
}

/** Whether a tariff entry carries both a peak and an off-peak price point. */
function isValidTariffEntry(entry: TariffEntry): boolean {
  return isFinitePrice(entry.peak) && isFinitePrice(entry.offPeak)
}

/** Parse one `HH:mm` window endpoint into minutes since local midnight. */
function parseWindowTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (match === null) {
    throw new Error(`peak-pricing: window time must be HH:mm, got ${JSON.stringify(value)}`)
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new Error(`peak-pricing: window time out of range, got ${JSON.stringify(value)}`)
  }
  return hour * 60 + minute
}

/** Minutes since midnight of the given instant's wall clock in `timezone`. */
function wallClockMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  // These options always emit hour and minute parts, so the lookup is total.
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return Number(values['hour']) * 60 + Number(values['minute'])
}

/**
 * Whether the given instant's wall clock in `timezone` falls inside any peak
 * window, with each window's start inclusive and end exclusive.
 * @param now - the instant to classify.
 * @param timezone - IANA timezone the windows are expressed in.
 * @param windows - the windows to test against.
 * @returns true when the wall clock is inside at least one window.
 */
export function isPeakTime(now: Date, timezone: string, windows: readonly PeakWindow[]): boolean {
  const minutes = wallClockMinutes(now, timezone)
  return windows.some((window) => {
    const start = parseWindowTime(window.start)
    const end = parseWindowTime(window.end)
    return minutes >= start && minutes < end
  })
}

/**
 * Validate and normalize the plugin config, failing loud at load.
 * @param config - raw plugin config (schema defaults already applied).
 * @returns the normalized runtime view used by the switch.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const timezone = config.timezone ?? 'Asia/Shanghai'
  try {
    // RangeError for unknown zones; this is the load-time validation probe.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new Error(`peak-pricing: timezone ${JSON.stringify(timezone)} is not a valid IANA timezone`)
  }
  const windows = (config.peakWindows ?? DEFAULT_PEAK_WINDOWS).map((window) => {
    const start = parseWindowTime(window.start)
    const end = parseWindowTime(window.end)
    if (start >= end) {
      throw new Error(`peak-pricing: window start must precede end, got ${JSON.stringify(window)}`)
    }
    return { start, end }
  })
  if (windows.length === 0) {
    throw new Error('peak-pricing: at least one peak window is required')
  }
  let effectiveFromMs: number | undefined
  if (config.effectiveFrom !== undefined) {
    effectiveFromMs = Date.parse(config.effectiveFrom)
    if (Number.isNaN(effectiveFromMs)) {
      throw new Error(
        `peak-pricing: effectiveFrom must be a parseable instant, got ${JSON.stringify(config.effectiveFrom)}`,
      )
    }
  }
  if (!config.peak.provider || !config.peak.model) {
    throw new Error('peak-pricing: peak.provider and peak.model are required')
  }
  const tariff = { ...DEEPSEEK_TARIFF, ...config.tariff }
  for (const [model, entry] of Object.entries(tariff)) {
    if (!isValidTariffEntry(entry)) {
      throw new Error(
        `peak-pricing: tariff for model ${JSON.stringify(model)} must carry non-negative peak and off-peak prices`,
      )
    }
  }
  return { timezone, windows, effectiveFromMs, peak: config.peak, tariff }
}

/** Whether the switch should engage at `now` under the resolved config. */
function shouldSwitch(now: Date, resolved: ResolvedConfig): boolean {
  if (resolved.effectiveFromMs !== undefined && now.getTime() < resolved.effectiveFromMs) return false
  const minutes = wallClockMinutes(now, resolved.timezone)
  return resolved.windows.some(window => minutes >= window.start && minutes < window.end)
}

/**
 * Replace a resolved request config with the peak preset, dropping any
 * inherited reasoning effort and re-applying the preset's own when declared
 * (mirroring model-selection semantics).
 * @param config - the config the downstream waterfall resolved.
 * @param peak - the peak preset selection.
 * @returns the preset config when the preset declares effort, else the
 *   resolved config with provider/model replaced and effort cleared.
 */
function applyPeakPreset(config: LlmCallConfig, peak: PeakPreset): LlmCallConfig {
  const { reasoningEffort: _inherited, ...rest } = config
  return {
    ...rest,
    provider: peak.provider,
    model: peak.model,
    ...peak.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(peak.reasoningEffort) },
  }
}

/** Token counts of one model call, used to estimate cost against a price point. */
export interface TokenUsage {
  /** Input tokens served from provider cache. */
  inputCacheHitTokens: number
  /** Input tokens served from cache miss. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
}

/**
 * Estimate the cost of a token usage against one price point, in the
 * tariff's currency. Cache-hit input tokens are billed at the cache-hit
 * price; cache-miss input tokens at the input price; output tokens at the
 * output price (all per million tokens).
 * @param usage - token counts of the call.
 * @param price - the price point to bill against.
 * @returns the estimated cost in the tariff's currency.
 */
export function estimateCost(usage: TokenUsage, price: TariffPrice): number {
  return usage.inputCacheHitTokens / 1_000_000 * price.inputCacheHit
    + usage.inputTokens / 1_000_000 * price.input
    + usage.outputTokens / 1_000_000 * price.output
}

/**
 * Estimate the per-call saving of routing a token usage to a cheaper peak
 * preset instead of the session-resolved model, both priced at their peak
 * tariff entries (the plugin only switches inside peak windows).
 * @param usage - token counts of the call.
 * @param resolved - peak tariff entry of the session-resolved model.
 * @param peak - peak tariff entry of the peak preset model.
 * @returns the estimated saving in the tariff's currency; negative when the
 *   preset is more expensive.
 */
export function estimateSaving(usage: TokenUsage, resolved: TariffEntry, peak: TariffEntry): number {
  return estimateCost(usage, resolved.peak) - estimateCost(usage, peak.peak)
}

/**
 * Install the peak-pricing switch for future agents. During a configured peak
 * window (and after `effectiveFrom` when set), each model request is routed to
 * the preset provider/model pair; otherwise the resolved config is untouched.
 * The scoped `agent/request` listener registers with `prepend` so the switch
 * is the outermost waterfall transformation and wins over the session's model
 * selection while the window is open.
 *
 * When both the resolved model and the peak preset model have tariff entries,
 * the switch logs the peak-price comparison (input, output, and cache-hit
 * input, per million tokens) so the per-call saving can be derived from the
 * actual token usage. The estimate functions {@link estimateCost} and
 * {@link estimateSaving} price a concrete token usage against the entries.
 *
 * @param ctx - plugin context owning the `agent/created` listener.
 * @param config - validated plugin configuration.
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config, internals: PeakPricingInternals = {}): void {
  const resolved = resolveConfig(config)
  const now = internals.now ?? (() => new Date())
  const logger = ctx.logger('peak-pricing')
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    agent.ctx.on('agent/request', async (_payload, next) => {
      const proposed = await next()
      if (!shouldSwitch(now(), resolved)) return proposed
      const peakConfig = applyPeakPreset(proposed, resolved.peak)
      const resolvedTariff = resolved.tariff[proposed.model]
      const peakTariff = resolved.tariff[resolved.peak.model]
      if (resolvedTariff !== undefined && peakTariff !== undefined) {
        logger.info(
          'peak window: routing %s/%s → %s/%s; peak prices CNY/1M input %s→%s, cache-hit %s→%s, output %s→%s',
          proposed.provider, proposed.model, peakConfig.provider, peakConfig.model,
          resolvedTariff.peak.input, peakTariff.peak.input,
          resolvedTariff.peak.inputCacheHit, peakTariff.peak.inputCacheHit,
          resolvedTariff.peak.output, peakTariff.peak.output,
        )
      }
      return peakConfig
    }, { prepend: true })
  })
}
