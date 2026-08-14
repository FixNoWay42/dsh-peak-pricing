/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-peak-pricing`.
 * @module @deepseek-ai/dsh-peak-pricing/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-peak-pricing'

/** Cordis companion plugin name. */
export const name = 'peak-pricing-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the peak switch is a per-request live transformation
 * of the resolved request config; the package appends no durable event and
 * owns no mutable data relation. The effective provider/model is already
 * logged and governed by the agent loop's `request/header` events.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
