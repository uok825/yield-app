import { describe, expect, it } from 'vitest'
import { downsample, hodlPrice, incomeApy, lendingApy, vsHodlPct, type PerfSample } from '../src/yield.ts'

const s = (t: number, o: Partial<PerfSample> = {}): PerfSample => ({
  t,
  value: 100_000,
  supply: 100_000,
  stable: 50_000,
  volatile: 20,
  income: 0,
  price: 2_500,
  ...o,
})

describe('incomeApy', () => {
  it('annualises trailing income over average value', () => {
    // $10 in one day on $100k ≈ 3.65% a year
    expect(incomeApy([s(0)], s(86_400, { income: 10 }), 86_400, 600)).toBeCloseTo(3.65, 6)
  })
  it('uses only the trailing window', () => {
    const samples = [s(0, { income: 0 }), s(86_400, { income: 100 }), s(100_000, { income: 101 })]
    // window of 1 day from t=172_800 starts at the sample at 86_400 → $20 over 1 day
    expect(incomeApy(samples, s(172_800, { income: 120 }), 86_400, 600)).toBeCloseTo(7.3, 6)
  })
  it('waits for a minimum span', () => {
    expect(incomeApy([s(0)], s(300, { income: 5 }), 86_400, 600)).toBeNull()
  })
})

describe('vsHodl', () => {
  it('is zero when nothing but price moved', () => {
    const inception = s(0)
    const now = s(1, { price: 3_000, value: 50_000 + 20 * 3_000 })
    expect(hodlPrice(inception, 3_000)).toBeCloseTo(1.1, 9)
    expect(vsHodlPct(inception, now)).toBeCloseTo(0, 9)
  })
  it('credits spread income on top of price moves', () => {
    const now = s(1, { price: 2_000, value: 50_000 + 20 * 2_000 + 900 }) // +$900 earned while ETH fell
    expect(vsHodlPct(s(0), now)).toBeCloseTo(1, 9) // +1% vs holding
  })
  it('is per share, so deposits do not move it', () => {
    const now = s(1, { value: 200_000, supply: 200_000, stable: 100_000, volatile: 40 })
    expect(vsHodlPct(s(0), now)).toBeCloseTo(0, 9)
  })
})

describe('lendingApy', () => {
  it('weights each lent part by its rate', () => {
    expect(lendingApy([{ lentValue: 35_000, apy: 4 }, { lentValue: 35_000, apy: 2 }], 100_000)).toBeCloseTo(2.1, 9)
  })
  it('is unknown while a lent market is still measuring', () => {
    expect(lendingApy([{ lentValue: 1, apy: null }], 100)).toBeNull()
    expect(lendingApy([{ lentValue: 0, apy: null }], 100)).toBe(0)
  })
})

describe('downsample', () => {
  it('keeps first and last', () => {
    const out = downsample([...Array(100).keys()], 5)
    expect(out).toEqual([0, 25, 50, 74, 99])
  })
})
