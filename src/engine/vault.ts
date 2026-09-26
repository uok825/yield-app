/* ERC-4626-style vault math. Every function is pure: State in, patch out. */
import { CONFIG, MARKETS } from '../config.ts';
import type { Market, Source, State } from '../types.ts';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** USDC sitting in the vault or its markets (excludes liquidity lent mid-fill). */
export const idleAssets = (s: State) => s.reserve + sum(s.markets.map((m) => m.balance));
export const totalAssets = (s: State) => idleAssets(s) + s.inFlight;
export const sharePrice = (s: State) => (s.totalShares > 0 ? totalAssets(s) / s.totalShares : 1);
export const userAssets = (s: State) => s.userShares * sharePrice(s);

/** Supply-weighted lending APY across all assets (the reserve earns 0%). */
export const lendingApy = (s: State) => {
  const assets = totalAssets(s);
  return assets > 0 ? sum(s.markets.map((m) => m.balance * m.apy)) / assets : 0;
};

export const sharesForDeposit = (s: State, amount: number) => {
  const assets = totalAssets(s);
  return s.totalShares > 0 && assets > 0 ? (amount * s.totalShares) / assets : amount;
};

/** Random walk with mild pull back toward each market's base rate. */
export function drift(s: State): Partial<State> {
  return {
    markets: s.markets.map((m) => {
      const base = MARKETS.find((c) => c.id === m.id)?.baseApy ?? m.apy;
      const next = m.apy + (Math.random() - 0.5) * 0.3 + (base - m.apy) * 0.08;
      const apy = Math.round(Math.min(14, Math.max(1.5, next)) * 100) / 100;
      return { ...m, apy, history: [...m.history, apy].slice(-24) };
    }),
  };
}

/** Move toward: reserve = 15% of idle assets, rest split by apy × trustScore. */
export function rebalance(s: State): Partial<State> {
  const idle = idleAssets(s);
  const deployable = idle * (1 - CONFIG.reserveRatio);
  const scores = s.markets.map((m) => m.apy * (m.trustScore / 100));
  const totalScore = sum(scores) || 1;
  // Damp the move between markets, then rescale so the reserve lands exactly on target.
  const damped = s.markets.map((m, i) => {
    const target = (deployable * scores[i]) / totalScore;
    return Math.max(0, m.balance + (target - m.balance) * CONFIG.rebalanceStep);
  });
  const scale = deployable / (sum(damped) || 1);
  const markets = s.markets.map((m, i) => ({ ...m, balance: damped[i] * scale }));
  return { markets, reserve: idle - sum(markets.map((m) => m.balance)) };
}

/** Pull `amount` out of the reserve first, then from the lowest-APY markets. */
export function draw(s: State, amount: number) {
  let left = Math.min(amount, idleAssets(s));
  const draws: { source: Source; amount: number }[] = [];

  const fromReserve = Math.min(left, s.reserve);
  if (fromReserve > 0) draws.push({ source: 'reserve', amount: fromReserve });
  left -= fromReserve;

  const byApy = [...s.markets].sort((a, b) => a.apy - b.apy);
  const taken = new Map<string, number>();
  for (const m of byApy) {
    if (left <= 0) break;
    const take = Math.min(left, m.balance);
    if (take <= 0) continue;
    taken.set(m.id, take);
    draws.push({ source: m.id, amount: take });
    left -= take;
  }

  const markets: Market[] = s.markets.map((m) => ({ ...m, balance: m.balance - (taken.get(m.id) ?? 0) }));
  return { markets, reserve: s.reserve - fromReserve, drawn: sum(draws.map((d) => d.amount)), draws };
}

export function deposit(s: State, amount: number): Partial<State> {
  if (!(amount > 0) || amount > s.walletUsdc) return {};
  const shares = sharesForDeposit(s, amount);
  return {
    reserve: s.reserve + amount, // deployed into markets on the next rebalance
    totalShares: s.totalShares + shares,
    userShares: s.userShares + shares,
    walletUsdc: s.walletUsdc - amount,
  };
}

/** Largest withdrawal possible right now: your position, capped by idle liquidity. */
export const maxWithdraw = (s: State) => Math.min(userAssets(s), idleAssets(s));

export function withdraw(s: State, amount: number): Partial<State> {
  const max = maxWithdraw(s);
  if (!(amount > 0) || amount > max + 1e-9) return {};
  const price = sharePrice(s);
  // Within a cent of the full position ("Max" rounds down): burn everything, leave no dust.
  const all = amount >= userAssets(s) - 0.01 && userAssets(s) <= idleAssets(s);
  const shares = all ? s.userShares : amount / price;
  const payout = shares * price;
  const { markets, reserve, drawn } = draw(s, payout);
  return {
    markets,
    reserve,
    totalShares: s.totalShares - shares,
    userShares: s.userShares - shares,
    walletUsdc: s.walletUsdc + drawn,
  };
}
