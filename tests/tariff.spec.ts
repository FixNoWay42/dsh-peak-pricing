import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  agentEvents,
  emitAgentEvent,
  type Agent,
} from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import {
  DEEPSEEK_TARIFF,
  apply,
  estimateCost,
  estimateSaving,
  type Config,
} from '../src/index.ts'

/** 2026-08-17 01:30 UTC = 09:30 Beijing (peak). */
const PEAK_INSTANT = new Date('2026-08-17T01:30:00Z')

const seed: LlmCallConfig = { provider: 'deepseek', model: 'deepseek-v4-pro', temperature: 0.2 }
const signal = new AbortController().signal

describe('DEEPSEEK_TARIFF', () => {
  it('carries the official DeepSeek tariff with cache-hit, input, and output prices', () => {
    expect(DEEPSEEK_TARIFF['deepseek-v4-flash']).toEqual({
      peak: { inputCacheHit: 0.10, input: 3.0, output: 9.0 },
      offPeak: { inputCacheHit: 0.05, input: 1.5, output: 4.5 },
    })
    expect(DEEPSEEK_TARIFF['deepseek-v4-pro']).toEqual({
      peak: { inputCacheHit: 0.30, input: 9.0, output: 27.0 },
      offPeak: { inputCacheHit: 0.15, input: 4.5, output: 13.5 },
    })
  })

  it('prices peak exactly twice the off-peak price for every model and column', () => {
    for (const entry of Object.values(DEEPSEEK_TARIFF)) {
      expect(entry.peak.inputCacheHit).toBeCloseTo(entry.offPeak.inputCacheHit * 2)
      expect(entry.peak.input).toBeCloseTo(entry.offPeak.input * 2)
      expect(entry.peak.output).toBeCloseTo(entry.offPeak.output * 2)
    }
  })
})

describe('estimateCost()', () => {
  it('bills cache-hit input, cache-miss input, and output each at their own price', () => {
    // 1M cache-hit input @ 0.05 + 1M miss input @ 1.5 + 1M output @ 4.5.
    const usage = { inputCacheHitTokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(estimateCost(usage, DEEPSEEK_TARIFF['deepseek-v4-flash']!.offPeak)).toBeCloseTo(6.05)
  })

  it('is linear in token counts', () => {
    const price = DEEPSEEK_TARIFF['deepseek-v4-pro']!.peak
    const small = { inputCacheHitTokens: 100_000, inputTokens: 200_000, outputTokens: 300_000 }
    const doubled = {
      inputCacheHitTokens: 200_000,
      inputTokens: 400_000,
      outputTokens: 600_000,
    }
    expect(estimateCost(doubled, price)).toBeCloseTo(estimateCost(small, price) * 2)
  })

  it('ignores cache-hit tokens when the call reports no cache hit', () => {
    const price = DEEPSEEK_TARIFF['deepseek-v4-flash']!.peak
    const usage = { inputCacheHitTokens: 0, inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(estimateCost(usage, price)).toBeCloseTo(12.0)
  })
})

describe('estimateSaving()', () => {
  it('is the peak-price cost difference between the resolved and preset models', () => {
    const usage = { inputCacheHitTokens: 100_000, inputTokens: 900_000, outputTokens: 500_000 }
    const resolved = DEEPSEEK_TARIFF['deepseek-v4-pro']!
    const peak = DEEPSEEK_TARIFF['deepseek-v4-flash']!
    const expected = estimateCost(usage, resolved.peak) - estimateCost(usage, peak.peak)
    expect(estimateSaving(usage, resolved, peak)).toBeCloseTo(expected)
    // v4-pro output 27 vs v4-flash 9: saving is positive for this usage.
    expect(estimateSaving(usage, resolved, peak)).toBeGreaterThan(0)
  })

  it('goes negative when the preset is more expensive than the resolved model', () => {
    const usage = { inputCacheHitTokens: 0, inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const resolved = DEEPSEEK_TARIFF['deepseek-v4-flash']!
    const peak = DEEPSEEK_TARIFF['deepseek-v4-pro']!
    expect(estimateSaving(usage, resolved, peak)).toBeLessThan(0)
  })
})

describe('tariff config validation at load', () => {
  function configWithTariff(tariff: Config['tariff']): Config {
    return {
      timezone: 'Asia/Shanghai',
      peak: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      tariff,
    }
  }

  it('accepts a user tariff merged over the built-in one', async () => {
    const ctx = new Context()
    apply(ctx, configWithTariff({
      'my-model': {
        peak: { inputCacheHit: 1, input: 2, output: 3 },
        offPeak: { inputCacheHit: 0.5, input: 1, output: 1.5 },
      },
    }), { now: () => PEAK_INSTANT })
    await ctx.fiber.dispose()
  })

  it('throws when a tariff entry has a negative price', () => {
    const ctx = new Context()
    expect(() => apply(ctx, configWithTariff({
      'my-model': {
        peak: { inputCacheHit: -1, input: 2, output: 3 },
        offPeak: { inputCacheHit: 0.5, input: 1, output: 1.5 },
      },
    }))).toThrow(/tariff for model "my-model" must carry non-negative/)
    void ctx.fiber.dispose()
  })

  it('throws when a tariff entry lacks the off-peak price point', () => {
    const ctx = new Context()
    expect(() => apply(ctx, configWithTariff({
      'my-model': {
        peak: { inputCacheHit: 1, input: 2, output: 3 },
        offPeak: { inputCacheHit: NaN, input: 1, output: 1.5 },
      },
    }))).toThrow(/tariff for model "my-model" must carry non-negative/)
    void ctx.fiber.dispose()
  })
})

describe('apply() tariff logging', () => {
  async function install(ctx: Context, config: Config) {
    await ctx.plugin(SystemPrompt)
    apply(ctx, config, { now: () => PEAK_INSTANT })
    const agent = {} as Agent
    const scope = createScope(ctx, agent)
    Object.defineProperty(agent, 'ctx', { value: scope.ctx, configurable: true })
    emitAgentEvent(ctx, agent, 'agent/created', {})
    return { agent, scope }
  }

  /** Collect every info-level message from the peak-pricing logger. */
  function capturePeakLogs(ctx: Context) {
    const messages: unknown[][] = []
    ctx.logger.exporter({
      export(message) {
        if (message.type === 'info' && message.name === 'peak-pricing') messages.push(message.args)
      },
    })
    return messages
  }

  it('logs the peak-price comparison when both models have tariff entries', async () => {
    const ctx = new Context()
    const messages = capturePeakLogs(ctx)
    const { agent, scope } = await install(ctx, {
      timezone: 'Asia/Shanghai',
      peak: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    })

    await agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )
    expect(messages).toEqual([[
      'peak window: routing %s/%s → %s/%s; peak prices CNY/1M input %s→%s, cache-hit %s→%s, output %s→%s',
      'deepseek', 'deepseek-v4-pro', 'deepseek', 'deepseek-v4-flash',
      9, 3, 0.3, 0.1, 27, 9,
    ]])

    await scope.dispose()
    await ctx.fiber.dispose()
  })

  it('does not log when the resolved model has no tariff entry', async () => {
    const ctx = new Context()
    const messages = capturePeakLogs(ctx)
    const { agent, scope } = await install(ctx, {
      timezone: 'Asia/Shanghai',
      peak: { provider: 'cheap', model: 'peak-chat' },
    })

    await agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )
    expect(messages).toEqual([])

    await scope.dispose()
    await ctx.fiber.dispose()
  })
})
