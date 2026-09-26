import { describe, expect, it } from 'vitest'
import {
  apyFromSamples,
  apyOverWindow,
  inventoryRebalance,
  planAllocation,
  queueNeedsReorder,
  type MarketState,
} from '../src/allocation.ts'

const YEAR = 365 * 24 * 3600
const U = 10n ** 6n

describe('apy', () => {
  it('annualises index growth', () => {
    // 5% simple over a year ≈ 5% APY
    const apy = apyFromSamples({ t: 0, index: 10n ** 18n }, { t: YEAR, index: (105n * 10n ** 18n) / 100n })!
    expect(apy).toBeCloseTo(5, 6)
  })
  it('compounds short windows', () => {
    const perDay = 1.0001 // ≈ 3.72% APY compounded
    const apy = apyFromSamples({ t: 0, index: 10n ** 18n }, { t: 86_400, index: BigInt(Math.round(perDay * 1e18)) })!
    expect(apy).toBeCloseTo((Math.pow(perDay, 365) - 1) * 100, 3)
  })
  it('rejects decreasing or degenerate samples', () => {
    expect(apyFromSamples({ t: 10, index: 5n }, { t: 10, index: 6n })).toBeUndefined()
    expect(apyFromSamples({ t: 0, index: 6n }, { t: 10, index: 5n })).toBeUndefined()
  })
  it('needs at least half a window of history', () => {
    const s = [
      { t: 0, index: 10n ** 18n },
      { t: 100, index: 10n ** 18n + 10n ** 10n },
    ]
    expect(apyOverWindow(s, 600)).toBeUndefined()
    expect(apyOverWindow(s, 200)).toBeGreaterThan(0)
  })
})

describe('planAllocation', () => {
  const market = (apy: number | undefined, current: bigint, trust = 100): MarketState => ({
    apy,
    trust,
    current,
    maxWithdraw: current,
  })

  it('waits until every market has an APY', () => {
    const plan = planAllocation(1_000n * U, 1_000n * U, 1500, [market(5, 0n), market(undefined, 0n)], 100)
    expect(plan.moves).toEqual([])
  })

  it('allocates idle above the reserve by apy × trust', () => {
    const plan = planAllocation(10_000n * U, 10_000n * U, 1500, [market(6, 0n), market(3, 0n)], 100)
    const allocs = plan.moves.filter((m) => m.kind === 'allocate')
    expect(allocs).toHaveLength(2)
    const total = allocs.reduce((a, m) => a + m.amount, 0n)
    // deployable = 10k − 15.5% (reserve + buffer)
    expect(total).toBeLessThanOrEqual(8_450n * U)
    expect(total).toBeGreaterThan(8_440n * U)
    const [a, b] = allocs.map((m) => m.amount)
    expect(Number(a) / Number(b)).toBeCloseTo(2, 2)
  })

  it('moves capital between markets without touching the reserve', () => {
    const plan = planAllocation(10_000n * U, 1_550n * U, 1500, [market(8, 1_000n * U), market(2, 7_450n * U)], 100)
    expect(plan.moves[0]).toMatchObject({ kind: 'reallocate', from: 1, to: 0 })
    expect(plan.moves.some((m) => m.kind === 'allocate')).toBe(false)
  })

  it('skips moves below the threshold', () => {
    const plan = planAllocation(10_000n * U, 1_550n * U, 1500, [market(5, 4_230n * U), market(5, 4_220n * U)], 100)
    expect(plan.moves).toEqual([])
  })

  it('refills a drained reserve from the lowest-yield market', () => {
    const plan = planAllocation(10_000n * U, 100n * U, 1500, [market(8, 5_000n * U), market(2, 4_900n * U)], 10_000)
    expect(plan.moves).toContainEqual({ kind: 'deallocate', from: 1, amount: 1_450n * U })
  })

  it('orders the withdraw queue lowest APY first', () => {
    const plan = planAllocation(1n, 0n, 1500, [market(6, 0n), market(3, 0n), market(9, 0n)], 100)
    expect(plan.queue).toEqual([1, 0, 2])
  })
})

describe('queueNeedsReorder', () => {
  it('ignores wobble inside the hysteresis band', () => {
    expect(queueNeedsReorder([4.1, 4.0, 6], 0.25)).toBe(false)
    expect(queueNeedsReorder([4.5, 4.0, 6], 0.25)).toBe(true)
    expect(queueNeedsReorder([3, undefined, 6], 0.25)).toBe(false)
  })
})

describe('inventoryRebalance', () => {
  it('sells the overweight side down to target', () => {
    expect(inventoryRebalance(80n, 20n, 7000)).toEqual({ sellStable: true, value: 10n })
    expect(inventoryRebalance(60n, 40n, 7000)).toEqual({ sellStable: false, value: 10n })
  })
})
