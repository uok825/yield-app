/** Pure allocation math for the Strategy A keeper (unit-tested in test/allocation.test.ts). */

const YEAR = 365 * 24 * 3600

export interface RateSample {
  t: number // unix seconds
  index: bigint // monotonically increasing supply index (any fixed scale)
}

/** Annualised (compounded) APY in percent from two index samples, or undefined if not measurable. */
export function apyFromSamples(older: RateSample, newer: RateSample): number | undefined {
  const dt = newer.t - older.t
  if (dt <= 0 || older.index <= 0n || newer.index < older.index) return undefined
  const growth = Number((newer.index * 10n ** 12n) / older.index) / 1e12
  return (Math.pow(growth, YEAR / dt) - 1) * 100
}

/** Oldest sample that is at least `windowSec` old, else the oldest available if it spans half the window. */
export function apyOverWindow(samples: RateSample[], windowSec: number): number | undefined {
  if (samples.length < 2) return undefined
  const newest = samples[samples.length - 1]
  const eligible = samples.filter((s) => newest.t - s.t >= windowSec)
  const older = eligible.length ? eligible[eligible.length - 1] : samples[0]
  if (newest.t - older.t < windowSec / 2) return undefined
  return apyFromSamples(older, newest)
}

export interface MarketState {
  apy: number | undefined
  trust: number // 0–100
  current: bigint
  maxWithdraw: bigint
}

export type Move =
  | { kind: 'reallocate'; from: number; to: number; amount: bigint }
  | { kind: 'allocate'; to: number; amount: bigint }
  | { kind: 'deallocate'; from: number; amount: bigint }

export interface Plan {
  targets: bigint[]
  moves: Move[]
  queue: number[] // withdraw queue: lowest APY first
}

/**
 * Target = deployable capital split by weight apy × trust. Moves smaller than `thresholdBps` of total are skipped.
 * Overweight markets fund underweight ones directly (reallocate); leftovers go to/from the idle reserve.
 * A small `bufferBps` is kept above the reserve target so rounding never trips the on-chain reserve check.
 */
export function planAllocation(
  total: bigint,
  idle: bigint,
  reserveBps: number,
  markets: MarketState[],
  thresholdBps: number,
  bufferBps = 50,
): Plan {
  const queue = markets
    .map((m, i) => ({ i, apy: m.apy ?? -Infinity }))
    .sort((a, b) => a.apy - b.apy)
    .map((x) => x.i)

  const reserveTarget = (total * BigInt(reserveBps + bufferBps)) / 10_000n
  const deployable = total > reserveTarget ? total - reserveTarget : 0n
  const weights = markets.map((m) => (m.apy !== undefined && m.apy > 0 ? m.apy * Math.max(0, m.trust) : 0))
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum === 0 || markets.some((m) => m.apy === undefined)) {
    return { targets: markets.map((m) => m.current), moves: [], queue }
  }

  const SCALE = 1_000_000n
  const targets = weights.map((w) => (deployable * BigInt(Math.round((w / sum) * 1e6))) / SCALE)
  const threshold = (total * BigInt(thresholdBps)) / 10_000n
  const diff = markets.map((m, i) => targets[i] - m.current)

  const over = diff
    .map((d, i) => ({ i, amount: d < 0n && -d > threshold ? -d : 0n }))
    .filter((x) => x.amount > 0n)
    .map((x) => ({ ...x, amount: x.amount < markets[x.i].maxWithdraw ? x.amount : markets[x.i].maxWithdraw }))
  const under = diff.map((d, i) => ({ i, amount: d > threshold ? d : 0n })).filter((x) => x.amount > 0n)

  const moves: Move[] = []
  for (const u of under) {
    for (const o of over) {
      if (u.amount === 0n) break
      if (o.amount === 0n) continue
      const amount = o.amount < u.amount ? o.amount : u.amount
      moves.push({ kind: 'reallocate', from: o.i, to: u.i, amount })
      o.amount -= amount
      u.amount -= amount
    }
  }

  let spare = idle > reserveTarget ? idle - reserveTarget : 0n
  for (const u of under) {
    if (u.amount === 0n || spare === 0n) continue
    const amount = u.amount < spare ? u.amount : spare
    moves.push({ kind: 'allocate', to: u.i, amount })
    spare -= amount
  }
  for (const o of over) {
    if (o.amount > 0n) moves.push({ kind: 'deallocate', from: o.i, amount: o.amount })
  }
  // Refill the reserve if LP exits or fills drained it.
  const shortfall = idle < (total * BigInt(reserveBps)) / 10_000n ? reserveTarget - idle : 0n
  if (shortfall > 0n && !moves.some((m: Move) => m.kind === 'deallocate')) {
    const from = queue.find((i) => markets[i].maxWithdraw > 0n)
    if (from !== undefined) {
      const amount = shortfall < markets[from].maxWithdraw ? shortfall : markets[from].maxWithdraw
      moves.push({ kind: 'deallocate', from, amount })
    }
  }
  return { targets, moves, queue }
}

/**
 * True if the current withdraw queue (identity order) is out of order by more than `hysteresisPct`: some market
 * sits before one yielding at least that much less. Avoids a reorder transaction on every APY wobble.
 */
export function queueNeedsReorder(apys: (number | undefined)[], hysteresisPct: number): boolean {
  for (let i = 0; i < apys.length; i++) {
    for (let j = i + 1; j < apys.length; j++) {
      const a = apys[i]
      const b = apys[j]
      if (a === undefined || b === undefined) return false
      if (a > b + hysteresisPct) return true
    }
  }
  return false
}

/** Amount to sell to bring a two-asset inventory back to `targetStableBps` (values in stable units). */
export function inventoryRebalance(
  stableValue: bigint,
  volatileValue: bigint,
  targetStableBps: number,
): { sellStable: boolean; value: bigint } {
  const total = stableValue + volatileValue
  const desiredStable = (total * BigInt(targetStableBps)) / 10_000n
  return stableValue > desiredStable
    ? { sellStable: true, value: stableValue - desiredStable }
    : { sellStable: false, value: desiredStable - stableValue }
}
