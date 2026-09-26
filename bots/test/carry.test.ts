import { describe, expect, it } from 'vitest'

import { type CarryInputs, type CarryParams, type SinkView, decideCarry } from '../src/carry.ts'

const P: CarryParams = {
  targetLtvBps: 2_500,
  enterSpreadPct: 0.3,
  exitSpreadPct: 0.05,
  exitConfirmations: 3,
  horizonHours: 24,
  costMultiple: 3,
  maxSinkShareBps: 500,
  rotateGainPct: 0.25,
  minMoveUsd: 50,
  harvestMinUsd: 20,
}
const usd = (n: number) => BigInt(Math.round(n * 1e6))
const sink = (address: string, apy: number | undefined, o: Partial<SinkView> = {}): SinkView => ({
  address: address as `0x${string}`,
  shares: 0n,
  value: 0n,
  liquid: 0n,
  cap: usd(5_000_000),
  tvl: usd(10_000_000),
  apy,
  rewardApr: 0,
  ...o,
})
const off = (o: Partial<CarryInputs> = {}): CarryInputs => ({
  collateralUsd: 60_000,
  debt: 0n,
  stableHeld: 0n,
  ltvBps: 0,
  maxLtvBps: 3_000,
  borrowApr: 4.8,
  sinks: [sink('0xa', 6.5), sink('0xb', 5.4)],
  gasRoundTripUsd: 0.05,
  exitCounter: 0,
  ...o,
})

describe('decideCarry', () => {
  it('opens into the best sink at the target LTV when the spread pays', () => {
    const d = decideCarry(off(), P)
    expect(d.actions).toEqual([{ kind: 'open', sink: '0xa', amount: usd(15_000) }])
    expect(d.spreadPct).toBeCloseTo(1.7)
  })

  it('stays out when the spread is below the entry threshold', () => {
    const d = decideCarry(off({ borrowApr: 6.4 }), P)
    expect(d.actions).toEqual([])
    expect(d.reason).toMatch(/< enter/)
  })

  it('stays out when expected profit does not cover entry + exit gas', () => {
    const d = decideCarry(off({ gasRoundTripUsd: 5 }), P) // $15k × 1.7% × 24h ≈ $0.70 < 3 × $5
    expect(d.actions).toEqual([])
    expect(d.reason).toMatch(/gas/)
  })

  it('caps the position at a share of the sink TVL', () => {
    const d = decideCarry(off({ sinks: [sink('0xa', 6.5, { tvl: usd(100_000) })] }), P)
    expect(d.actions[0]).toMatchObject({ kind: 'open', amount: usd(5_000) })
  })

  it('counts incentive rewards (already haircut) in the spread', () => {
    const d = decideCarry(off({ sinks: [sink('0xa', 4.6, { rewardApr: 0.8 })] }), P)
    expect(d.actions[0]).toMatchObject({ kind: 'open', sink: '0xa' })
  })

  it('waits for rates before acting', () => {
    expect(decideCarry(off({ borrowApr: undefined }), P).actions).toEqual([])
    expect(decideCarry(off({ sinks: [sink('0xa', undefined)] }), P).actions).toEqual([])
  })

  const on = (o: Partial<CarryInputs> = {}) =>
    off({
      debt: usd(15_000),
      stableHeld: usd(15_005),
      ltvBps: 2_500,
      sinks: [sink('0xa', 6.5, { shares: 1n, value: usd(15_005) }), sink('0xb', 5.4)],
      ...o,
    })

  it('holds a paying position', () => {
    const d = decideCarry(on(), P)
    expect(d.status).toBe('on')
    expect(d.actions).toEqual([])
  })

  it('deleverages first when LTV approaches the vault limit', () => {
    const d = decideCarry(on({ ltvBps: 2_850, collateralUsd: 52_000 }), P)
    expect(d.actions).toEqual([{ kind: 'deleverage', amount: usd(15_000) - usd(13_000) }])
  })

  it('closes only after the spread stays below the exit threshold (hysteresis)', () => {
    let d = decideCarry(on({ borrowApr: 6.5 }), P)
    expect(d.actions).toEqual([])
    expect(d.exitCounter).toBe(1)
    d = decideCarry(on({ borrowApr: 6.5, exitCounter: 1 }), P)
    expect(d.actions).toEqual([])
    d = decideCarry(on({ borrowApr: 6.5, exitCounter: 2 }), P)
    expect(d.actions).toEqual([{ kind: 'close', sink: '0xa', shares: 1n }])
    // A good tick resets the counter.
    expect(decideCarry(on({ exitCounter: 2 }), P).exitCounter).toBe(0)
  })

  it('repays a negative-carry shortfall from collateral on close', () => {
    const d = decideCarry(on({ borrowApr: 7, exitCounter: 2, stableHeld: usd(14_990) }), P)
    expect(d.actions).toContainEqual({ kind: 'repayShortfall', stableShort: usd(10) })
  })

  it('rotates into a clearly better sink', () => {
    const d = decideCarry(on({ sinks: [sink('0xa', 6.5, { shares: 7n, value: usd(15_005) }), sink('0xb', 7.0)] }), P)
    expect(d.actions).toContainEqual({ kind: 'rotate', from: '0xa', to: '0xb', shares: 7n })
  })

  it('does not rotate for a marginal gain', () => {
    const d = decideCarry(on({ sinks: [sink('0xa', 6.5, { shares: 7n, value: usd(15_005) }), sink('0xb', 6.6)] }), P)
    expect(d.actions).toEqual([])
  })

  it('harvests stable profit above the threshold', () => {
    const d = decideCarry(on({ stableHeld: usd(15_100) }), P)
    expect(d.actions).toEqual([{ kind: 'harvest', stableIn: (usd(100) * 99n) / 100n }])
  })

  it('tops up toward the target LTV after collateral grows', () => {
    const d = decideCarry(on({ collateralUsd: 90_000, ltvBps: 1_667 }), P)
    expect(d.actions).toContainEqual({ kind: 'open', sink: '0xa', amount: usd(22_500) - usd(15_000) })
  })
})
