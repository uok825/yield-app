/* Strategy B · Inventory MM. Profiles fill intents from their own USDC + ETH stock at
   oracle-based prices, skewed toward their target ratio. Mirrors the Solidity pricing.
   Every updater is pure: MmState in, patch out. */
import { CONFIG, MM } from '../config.ts';
import type { MmEvent, MmState, Profile, ProfileId } from '../types.ts';

const { spreadBps, skewBps, bandBps } = MM;
const BAND = bandBps / 1e4;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const uid = (now: number) => `${now}-${Math.random().toString(36).slice(2, 7)}`;

export const value = (p: Profile, price: number) => p.usdc + p.eth * price;
export const usdcRatio = (p: Profile, price: number) => {
  const v = value(p, price);
  return v > 0 ? p.usdc / v : p.target;
};
export const inBand = (ratio: number, target: number) => Math.abs(ratio - target) <= BAND + 1e-9;
/** Allowed if the new ratio is in band, or at least closer to target than before. */
const bandOk = (before: number, after: number, target: number) =>
  inBand(after, target) || Math.abs(after - target) < Math.abs(before - target);

export const sharePrice = (p: Profile, price: number) => (p.totalShares > 0 ? value(p, price) / p.totalShares : 1);
export const userValue = (p: Profile, price: number) => p.userShares * sharePrice(p, price);
export const tvl = (s: MmState) => s.profiles.reduce((a, p) => a + value(p, s.price), 0);

/** Oracle price → skewed bid / ask, as in OracleSwapApp.sol: ask = P·(1 + spread − skew), bid = P·(1 − spread − skew).
    ETH-heavy vaults quote ETH cheaper, and vice versa. */
export function quote(p: Profile, price: number) {
  const devBps = (1 - usdcRatio(p, price) - (1 - p.target)) * 1e4; // volRatio − targetVol
  const skew = clamp((skewBps * devBps) / bandBps, -skewBps, skewBps);
  return { skew, bid: price * (1 - (spreadBps + skew) / 1e4), ask: price * (1 + (spreadBps - skew) / 1e4) };
}

/** Taker sends `usd` of USDC (buyEth) or `usd` worth of ETH at oracle (sellEth). Null if rejected. */
function tryFill(p: Profile, price: number, buyEth: boolean, usd: number) {
  if (usd > MM.maxFillShare * value(p, price)) return null;
  const q = quote(p, price);
  const exec = buyEth ? q.ask : q.bid;
  const next = buyEth
    ? { ...p, usdc: p.usdc + usd, eth: p.eth - usd / exec }
    : { ...p, usdc: p.usdc - (usd / price) * exec, eth: p.eth + usd / price };
  if (next.usdc < 0 || next.eth < 0) return null;
  if (!bandOk(usdcRatio(p, price), usdcRatio(next, price), p.target)) return null;
  return { next, exec, income: value(next, price) - value(p, price) };
}

const keep = (events: MmEvent[]) => events.slice(0, CONFIG.maxFills);

/** A taker intent arrives; the router picks the profile with the best price that can accept it. */
export function newIntent(s: MmState, now: number): Partial<MmState> {
  // Skew attracts flow back toward targets; `flow` adds persistent one-sided pressure.
  const avgSkew = s.profiles.reduce((a, p) => a + quote(p, s.price).skew, 0) / s.profiles.length / skewBps;
  const buyEth = Math.random() < clamp(0.5 + 0.45 * s.flow + 0.2 * avgSkew, 0.05, 0.95);
  const usd = Math.round(rand(300, 5_000));
  const dir = buyEth ? 'USDC → ETH' : 'ETH → USDC';

  let best = -1;
  let fill: ReturnType<typeof tryFill> = null;
  for (const [i, p] of s.profiles.entries()) {
    const f = tryFill(p, s.price, buyEth, usd);
    if (f && (!fill || (buyEth ? f.exec < fill.exec : f.exec > fill.exec))) [best, fill] = [i, f];
  }

  const base = { id: uid(now), dir, usd, at: now } as const;
  if (!fill) {
    const ev: MmEvent = { ...base, kind: 'rejected', profile: null, price: s.price, edgeBps: 0, income: 0 };
    return { events: keep([ev, ...s.events]), rejectedCount: s.rejectedCount + 1 };
  }
  const ev: MmEvent = { ...base, kind: 'fill', profile: s.profiles[best].id, price: fill.exec, edgeBps: (fill.income / usd) * 1e4, income: fill.income };
  return {
    profiles: s.profiles.map((p, j) => (j === best ? fill.next : p)),
    events: keep([ev, ...s.events]),
    spreadIncome: s.spreadIncome + fill.income,
    fillCount: s.fillCount + 1,
    volume: s.volume + usd,
  };
}

/** Swap back to target on a (simulated) DEX, paying keeperCostBps of the swapped value. */
function rebalance(p: Profile, price: number, now: number) {
  const v = value(p, price);
  const swap = Math.abs(p.usdc - p.target * v);
  const cost = (swap * MM.keeperCostBps) / 1e4;
  const next: Profile = { ...p, usdc: p.target * (v - cost), eth: ((1 - p.target) * (v - cost)) / price, rebalancing: false };
  const sellsEth = p.usdc < p.target * v;
  const exec = price * (1 + (sellsEth ? -1 : 1) * (MM.keeperCostBps / 1e4));
  const ev: MmEvent = {
    id: uid(now),
    kind: 'keeper',
    dir: sellsEth ? 'ETH → USDC' : 'USDC → ETH',
    usd: swap,
    profile: p.id,
    price: exec,
    edgeBps: -MM.keeperCostBps,
    income: -cost,
    at: now,
  };
  return { next, ev, cost };
}

/** One step of the simulated clock: oracle walk, lending accrual, keeper. */
export function tick(s: MmState, now: number): Partial<MmState> {
  // ±0.1–0.3% per tick; direction repeats 65% of the time, so the price trends a little.
  const up = s.history.length > 1 && s.price >= s.history[s.history.length - 2];
  const move = (Math.random() < 0.65 === up ? 1 : -1) * rand(0.001, 0.003);
  const price = s.price * (1 + move + ((MM.startPrice - s.price) / s.price) * 0.01);
  const years = MM.simHoursPerTick / 8_760;
  const usdcApy = clamp(s.usdcApy + rand(-0.06, 0.06) + (MM.usdcApy - s.usdcApy) * 0.1, 4, 5);
  const ethApy = clamp(s.ethApy + rand(-0.04, 0.04) + (MM.ethApy - s.ethApy) * 0.1, 1.6, 2.4);

  const events: MmEvent[] = [];
  let keeperCost = s.keeperCost;
  const profiles = s.profiles.map((p0) => {
    let p: Profile = { ...p0, usdc: p0.usdc * (1 + (usdcApy / 100) * years), eth: p0.eth * (1 + (ethApy / 100) * years) };
    if (p.rebalancing) {
      const r = rebalance(p, price, now);
      events.push(r.ev);
      keeperCost += r.cost;
      p = r.next;
    } else if (!inBand(usdcRatio(p, price), p.target)) {
      p = { ...p, rebalancing: true }; // flagged now, swapped on the next tick
    }
    return p;
  });

  return {
    price,
    history: [...s.history, price].slice(-60),
    usdcApy,
    ethApy,
    profiles,
    events: keep([...events, ...s.events]),
    keeperCost,
    flow: clamp(s.flow + rand(-0.25, 0.25) - s.flow * 0.05, -1, 1),
    simHours: s.simHours + MM.simHoursPerTick,
  };
}

/** Value-weighted lending APY and annualized spread income (net of keeper costs), in %. */
export function apys(s: MmState) {
  const total = tvl(s) || 1;
  const usdc = s.profiles.reduce((a, p) => a + p.usdc, 0);
  const lending = (usdc * s.usdcApy + (total - usdc) * s.ethApy) / total;
  const spread = s.simHours > 0 ? ((s.spreadIncome - s.keeperCost) / total) * (8_760 / s.simHours) * 100 : 0;
  return { lending, spread, net: lending + spread };
}

/* ── Deposit / withdraw ───────────────────── */

export function previewDeposit(s: MmState, id: ProfileId, usdc: number, eth: number) {
  const p = s.profiles.find((x) => x.id === id)!;
  const val = usdc + eth * s.price;
  const shares = p.totalShares > 0 && value(p, s.price) > 0 ? (val * p.totalShares) / value(p, s.price) : val;
  const after = usdcRatio({ ...p, usdc: p.usdc + usdc, eth: p.eth + eth }, s.price);
  const before = usdcRatio(p, s.price);
  const ok = p.totalShares > 0 ? bandOk(before, after, p.target) : inBand(after, p.target);
  return { value: val, shares, before, after, ok };
}

/** Wallet USDC lives in the Strategy A store; the caller debits it. */
export function deposit(s: MmState, id: ProfileId, usdc: number, eth: number): Partial<MmState> {
  const d = previewDeposit(s, id, usdc, eth);
  if (!(d.value > 0) || usdc < 0 || eth < 0 || eth > s.walletEth + 1e-12 || !d.ok) return {};
  return {
    walletEth: s.walletEth - eth,
    profiles: s.profiles.map((p) =>
      p.id === id ? { ...p, usdc: p.usdc + usdc, eth: p.eth + eth, totalShares: p.totalShares + d.shares, userShares: p.userShares + d.shares } : p,
    ),
  };
}

/** In-kind: burning shares pays a pro-rata slice of both USDC and ETH. */
export function previewWithdraw(s: MmState, id: ProfileId, shares: number) {
  const p = s.profiles.find((x) => x.id === id)!;
  const f = p.totalShares > 0 ? Math.max(0, shares) / p.totalShares : 0;
  return { usdc: p.usdc * f, eth: p.eth * f, value: value(p, s.price) * f };
}

/** Wallet USDC lives in the Strategy A store; the caller credits `usdc` of the preview. */
export function withdraw(s: MmState, id: ProfileId, shares: number): Partial<MmState> {
  const p = s.profiles.find((x) => x.id === id)!;
  if (!(shares > 0) || shares > p.userShares + 1e-9) return {};
  const burn = Math.min(shares, p.userShares);
  const out = previewWithdraw(s, id, burn);
  return {
    walletEth: s.walletEth + out.eth,
    profiles: s.profiles.map((x) =>
      x.id === id ? { ...x, usdc: x.usdc - out.usdc, eth: x.eth - out.eth, totalShares: x.totalShares - burn, userShares: x.userShares - burn } : x,
    ),
  };
}
