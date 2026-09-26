/* Simulated 1inch Fusion flow: an order's Dutch auction runs, the resolver
   borrows the USDC leg from the vault (Aqua maker), fills, and repays
   principal + fee. Every function is pure: State in, patch out. */
import { CONFIG } from '../config.ts';
import type { Fill, State } from '../types.ts';
import { draw, idleAssets } from './vault.ts';

const PAIRS = ['WETH → USDC', 'cbBTC → USDC', 'AERO → USDC', 'DAI → USDC', 'EURC → USDC'];
const FILL_AT = 70; // auction progress at which the resolver steps in
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Keep the newest items, dropping oldest *settled* fills first so in-flight loans are never lost. */
function trim(fills: Fill[]): Fill[] {
  let extra = fills.length - CONFIG.maxFills;
  const out: Fill[] = [];
  for (let i = fills.length - 1; i >= 0; i--) {
    if (extra > 0 && fills[i].status === 'settled') {
      extra--;
      continue;
    }
    out.unshift(fills[i]);
  }
  return out;
}

export function newOrder(s: State, now: number): Partial<State> {
  // Sizes are USDC. Occasionally larger than the reserve so markets get unwound.
  const cap = idleAssets(s) * 0.4;
  const amount = Math.round(Math.min(cap, rand(200, 2_800)));
  if (amount <= 0) return {};
  const fill: Fill = {
    id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
    pair: PAIRS[Math.floor(Math.random() * PAIRS.length)],
    amount,
    fee: amount * rand(0.0004, 0.001), // 4–10 bps
    draws: [],
    status: 'auction',
    progress: 0,
    createdAt: now,
    lentAt: 0,
  };
  return { fills: trim([fill, ...s.fills]) };
}

/** Advance auctions, lend liquidity to the resolver, settle repayments. */
export function tick(s: State, now: number): Partial<State> {
  let next: State = s;
  const fills = s.fills.map((f): Fill => {
    if (f.status === 'auction') {
      const progress = Math.min(100, f.progress + rand(12, 26));
      if (progress < FILL_AT) return { ...f, progress };
      const d = draw(next, f.amount);
      next = { ...next, markets: d.markets, reserve: d.reserve, inFlight: next.inFlight + d.drawn };
      const fee = (f.fee / f.amount) * d.drawn;
      return { ...f, progress, amount: d.drawn, fee, draws: d.draws, status: 'lending', lentAt: now };
    }
    if (f.status === 'lending' && now - f.lentAt >= CONFIG.settleDelayMs) {
      // Principal + fee land in the reserve; the next rebalance redeploys them.
      next = {
        ...next,
        reserve: next.reserve + f.amount + f.fee,
        inFlight: Math.max(0, next.inFlight - f.amount),
        feesEarned: next.feesEarned + f.fee,
        filledCount: next.filledCount + 1,
        volume: next.volume + f.amount,
      };
      return { ...f, status: 'settled', progress: 100 };
    }
    return f;
  });
  return { ...next, fills };
}
