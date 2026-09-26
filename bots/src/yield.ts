/** Pure performance math for the dashboard read model (unit-tested in test/yield.test.ts). */

const YEAR = 365 * 24 * 3600

/** One performance sample. Amounts are in whole units (USD, shares, USDC, ETH). */
export interface PerfSample {
  t: number
  value: number // total value in USD at `price`
  supply: number // total shares
  stable: number // stable holdings (USDC)
  volatile: number // volatile holdings (ETH)
  income: number // cumulative fee / spread income in USD
  price: number // ETH/USD
}

/** Oldest sample inside the trailing window (or the first one), if it spans at least `minSpanSec`. */
export function windowStart(samples: PerfSample[], now: PerfSample, windowSec: number, minSpanSec: number) {
  const inWindow = samples.filter((s) => now.t - s.t <= windowSec)
  const start = inWindow[0] ?? samples[0]
  if (!start || now.t - start.t < minSpanSec) return undefined
  return start
}

/** Annualised income over the trailing window as % of average value (simple, not compounded). */
export function incomeApy(samples: PerfSample[], now: PerfSample, windowSec: number, minSpanSec: number): number | null {
  const start = windowStart(samples, now, windowSec, minSpanSec)
  if (!start) return null
  const avgValue = (start.value + now.value) / 2
  if (avgValue <= 0) return null
  return ((now.income - start.income) / avgValue) * (YEAR / (now.t - start.t)) * 100
}

export const sharePrice = (s: PerfSample) => (s.supply > 0 ? s.value / s.supply : 0)

/** Value per share of the inception basket if it had simply been held, at the current price. */
export function hodlPrice(inception: PerfSample, price: number): number {
  if (inception.supply <= 0) return 0
  return (inception.stable + inception.volatile * price) / inception.supply
}

/** Performance of a share versus holding its inception basket, in %. */
export function vsHodlPct(inception: PerfSample, now: PerfSample): number | null {
  const hodl = hodlPrice(inception, now.price)
  return hodl > 0 ? (sharePrice(now) / hodl - 1) * 100 : null
}

export function changePct(from: number, to: number): number | null {
  return from > 0 ? (to / from - 1) * 100 : null
}

/** Evenly thins a series down to at most `points` entries, always keeping the last one. */
export function downsample<T>(series: T[], points: number): T[] {
  if (series.length <= points) return series
  const step = (series.length - 1) / (points - 1)
  return Array.from({ length: points }, (_, i) => series[Math.round(i * step)])
}

/** Value-weighted lending APY: only the lent part of each asset earns its market rate. */
export function lendingApy(
  parts: { lentValue: number; apy: number | null }[],
  totalValue: number,
): number | null {
  if (totalValue <= 0 || parts.some((p) => p.lentValue > 0 && p.apy === null)) return null
  return parts.reduce((sum, p) => sum + p.lentValue * (p.apy ?? 0), 0) / totalValue
}

export const round2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100)
