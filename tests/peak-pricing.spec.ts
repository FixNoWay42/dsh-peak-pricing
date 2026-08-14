import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  agentEvents,
  assembleContextFor,
  emitAgentEvent,
  installModelSelection,
  type Agent,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { apply, isPeakTime, type Config } from '../src/index.ts'

/** One deterministic instant: 2026-08-17 01:30 UTC = 09:30 Beijing (peak). */
const PEAK_INSTANT = new Date('2026-08-17T01:30:00Z')
/** 2026-08-17 05:30 UTC = 13:30 Beijing (off-peak). */
const OFF_PEAK_INSTANT = new Date('2026-08-17T05:30:00Z')
/** 2026-08-17 03:59 UTC = 11:59 Beijing (still peak). */
const PEAK_EDGE_INSTANT = new Date('2026-08-17T03:59:00Z')

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    timezone: 'Asia/Shanghai',
    peakWindows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    peak: { provider: 'cheap', model: 'peak-chat' },
    ...overrides,
  }
}

const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
const signal = new AbortController().signal

describe('isPeakTime()', () => {
  it('classifies instants against inclusive-start, exclusive-end windows in the configured timezone', () => {
    const windows = [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]
    // 09:00 Beijing inclusive.
    expect(isPeakTime(new Date('2026-08-17T01:00:00Z'), 'Asia/Shanghai', windows)).toBe(true)
    // 12:00 Beijing exclusive (11:59 is still peak).
    expect(isPeakTime(PEAK_EDGE_INSTANT, 'Asia/Shanghai', windows)).toBe(true)
    expect(isPeakTime(new Date('2026-08-17T04:00:00Z'), 'Asia/Shanghai', windows)).toBe(false)
    // 14:00 Beijing inclusive, 18:00 Beijing exclusive.
    expect(isPeakTime(new Date('2026-08-17T06:00:00Z'), 'Asia/Shanghai', windows)).toBe(true)
    expect(isPeakTime(new Date('2026-08-17T09:59:59Z'), 'Asia/Shanghai', windows)).toBe(true)
    expect(isPeakTime(new Date('2026-08-17T10:00:00Z'), 'Asia/Shanghai', windows)).toBe(false)
    // Midnight and 23:59 are off-peak.
    expect(isPeakTime(new Date('2026-08-17T16:00:00Z'), 'Asia/Shanghai', windows)).toBe(false)
    expect(isPeakTime(new Date('2026-08-17T15:59:00Z'), 'Asia/Shanghai', windows)).toBe(false)
  })

  it('honors a different configured timezone', () => {
    const windows = [{ start: '09:00', end: '12:00' }]
    // 09:00 UTC is 17:00 Beijing — off-peak in Beijing windows, peak in UTC windows.
    expect(isPeakTime(new Date('2026-08-17T09:00:00Z'), 'UTC', windows)).toBe(true)
    expect(isPeakTime(new Date('2026-08-17T09:00:00Z'), 'Asia/Shanghai', windows)).toBe(false)
  })
})

describe('config validation at load', () => {
  it('throws on an unknown timezone', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, baseConfig({ timezone: 'Mars/Olympus' })) })
      .toThrow(/not a valid IANA timezone/)
    void ctx.fiber.dispose()
  })

  it('throws on malformed or out-of-range window times', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, baseConfig({ peakWindows: [{ start: '9:00', end: '12:00' }] })) })
      .toThrow(/must be HH:mm/)
    expect(() => { apply(ctx, baseConfig({ peakWindows: [{ start: '24:00', end: '12:00' }] })) })
      .toThrow(/out of range/)
    void ctx.fiber.dispose()
  })

  it('throws when a window start is not before its end', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, baseConfig({ peakWindows: [{ start: '12:00', end: '12:00' }] })) })
      .toThrow(/start must precede end/)
    expect(() => { apply(ctx, baseConfig({ peakWindows: [{ start: '13:00', end: '12:00' }] })) })
      .toThrow(/start must precede end/)
    void ctx.fiber.dispose()
  })

  it('throws on an empty window list', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, baseConfig({ peakWindows: [] })) })
      .toThrow(/at least one peak window/)
    void ctx.fiber.dispose()
  })

  it('throws on an unparseable effectiveFrom', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, baseConfig({ effectiveFrom: 'not-a-date' })) })
      .toThrow(/must be a parseable instant/)
    void ctx.fiber.dispose()
  })

  it('throws when the peak preset lacks provider or model', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, baseConfig({ peak: { provider: '', model: 'x' } })) })
      .toThrow(/provider and peak.model/)
    expect(() => { apply(ctx, baseConfig({ peak: { provider: 'x', model: '' } })) })
      .toThrow(/provider and peak.model/)
    void ctx.fiber.dispose()
  })

  it('applies the default timezone and peak windows when omitted', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, { peak: { provider: 'cheap', model: 'peak-chat' } }) })
      .not.toThrow()
    void ctx.fiber.dispose()
  })
})

describe('apply()', () => {
  async function install(ctx: Context, config: Config, now: () => Date) {
    // Mounting and awaiting a plugin joins the test invariant host's ready
    // chain, so disposing the fiber below never races its async companion.
    await ctx.plugin(SystemPrompt)
    apply(ctx, config, { now })
    const agent = {} as Agent
    const scope = createScope(ctx, agent)
    // The runtime mints agent.ctx as the scope context extended with the agent.
    Object.defineProperty(agent, 'ctx', { value: scope.ctx, configurable: true })
    emitAgentEvent(ctx, agent, 'agent/created', {})
    return { agent, scope }
  }

  it('routes requests to the peak preset during a peak window and leaves them unchanged off-peak', async () => {
    const ctx = new Context()
    let current = PEAK_INSTANT
    const { agent, scope } = await install(ctx, baseConfig(), () => current)

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({ provider: 'cheap', model: 'peak-chat', temperature: 0.2 })

    current = OFF_PEAK_INSTANT
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual(seed)

    await scope.dispose()
    await ctx.fiber.dispose()
  })

  it('applies the preset reasoning effort and drops an inherited one', async () => {
    const ctx = new Context()
    const { agent, scope } = await install(ctx, baseConfig({
      peak: { provider: 'cheap', model: 'peak-chat', reasoningEffort: 'low' },
    }), () => PEAK_INSTANT)

    const inherited: LlmCallConfig = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('max'),
      temperature: 0.2,
    }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({
      provider: 'cheap',
      model: 'peak-chat',
      reasoningEffort: ReasoningEffortId('low'),
      temperature: 0.2,
    })

    await scope.dispose()
    await ctx.fiber.dispose()
  })

  it('never switches before effectiveFrom, then switches once it passes', async () => {
    const ctx = new Context()
    let current = new Date('2026-08-17T00:59:00Z') // 08:59 Beijing, but before effectiveFrom
    const { agent, scope } = await install(ctx, baseConfig({
      effectiveFrom: '2026-08-17T01:00:00Z',
    }), () => current)

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual(seed)

    current = PEAK_INSTANT
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({ provider: 'cheap', model: 'peak-chat', temperature: 0.2 })

    await scope.dispose()
    await ctx.fiber.dispose()
  })

  it('wins over installModelSelection when the peak window is open, and defers to it outside', async () => {
    const ctx = new Context()
    // The runtime installs the session model selection during pre-publication
    // setup, BEFORE agent/created fires; the peak switch registers afterwards
    // with prepend so it becomes outermost and wins while the window is open.
    await ctx.plugin(SystemPrompt)
    const agent = {} as Agent
    const scope = createScope(ctx, agent)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    installModelSelection(scope.ctx, selection)
    selection.current = { provider: 'user', model: 'chosen' }
    // Prompt assembly snapshots the selection into `assembled` — the snapshot
    // installModelSelection's request listener actually applies. Dispatch with
    // the agent scope so the agent-scoped assemble listener receives it.
    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    let current = PEAK_INSTANT
    apply(ctx, baseConfig(), { now: () => current })
    Object.defineProperty(agent, 'ctx', { value: scope.ctx, configurable: true })
    emitAgentEvent(ctx, agent, 'agent/created', {})

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({ provider: 'cheap', model: 'peak-chat', temperature: 0.2 })

    current = OFF_PEAK_INSTANT
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({ provider: 'user', model: 'chosen', temperature: 0.2 })

    await scope.dispose()
    await ctx.fiber.dispose()
  })

  it('disposes the agent/request listener with the agent scope', async () => {
    const ctx = new Context()
    const { agent, scope } = await install(ctx, baseConfig(), () => PEAK_INSTANT)
    await scope.dispose()

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual(seed)

    await ctx.fiber.dispose()
  })
})
