import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PeakPricingInvariant from '../src/invariant.ts'

describe('peak-pricing invariant companion', () => {
  it('registers as the package owner and mounts cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(PeakPricingInvariant)
    await ctx.fiber.dispose()
  })

  it('names the companion after the package', () => {
    expect(PeakPricingInvariant.name).toBe('peak-pricing-invariant')
    expect(PeakPricingInvariant.inject).toEqual(['invariants'])
  })
})
