import type { MarketId, ProfileId } from './types.ts';

export interface MarketConfig {
  id: MarketId;
  name: string;
  trustScore: number; // 0–100, scales the allocation weight
  baseApy: number; // % per year
}

export const MARKETS: MarketConfig[] = [
  { id: 'morpho', name: 'Morpho Blue', trustScore: 95, baseApy: 6.5 },
  { id: 'aave', name: 'Aave V3', trustScore: 100, baseApy: 4.0 },
  { id: 'fluid', name: 'Fluid', trustScore: 85, baseApy: 5.5 },
];

export const CONFIG = {
  initialAssets: 10_000, // USDC in the vault at start
  initialUserShares: 2_500, // the connected (mock) user's share of the vault
  walletUsdc: 5_000, // mock wallet balance
  reserveRatio: 0.15, // 15% of TVL stays liquid for JIT fills
  rebalanceStep: 0.5, // fraction of the gap closed per rebalance
  maxFills: 8, // rolling "recent fills" list length
  intervals: {
    tick: 700, // auction progress / settlement check
    newOrder: 3_000,
    drift: 3_500,
    rebalance: 4_000,
  },
  settleDelayMs: 1_400, // time an order spends "lending" before repayment
} as const;

/* ── Strategy B · Inventory MM ─────────────── */

export const PROFILES: { id: ProfileId; name: string; target: number; seedUsd: number }[] = [
  { id: 'stable', name: 'Stable', target: 0.7, seedUsd: 200_000 }, // target = USDC share by value
  { id: 'balanced', name: 'Balanced', target: 0.5, seedUsd: 120_000 },
  { id: 'eth', name: 'ETH-heavy', target: 0.3, seedUsd: 80_000 },
];

/** Mirrors the Solidity parameters (bps). skewBps ≤ spreadBps: never trades worse than oracle. */
export const MM = {
  spreadBps: 20,
  skewBps: 15,
  bandBps: 500, // ±5pp around the USDC target
  maxFillShare: 0.2, // a fill may not exceed 20% of the pool's value
  keeperCostBps: 5, // simulated DEX cost of a keeper rebalance
  startPrice: 3_000,
  usdcApy: 4.5, // Aave USDC
  ethApy: 2.0, // Aave WETH
  simHoursPerTick: 3, // simulated clock used to accrue yield and annualize income
  userSeed: { balanced: 2_000 } as Partial<Record<ProfileId, number>>, // mock user's starting position (USD)
  walletEth: 2.5,
  intervals: { tick: 2_000, intent: 2_400 },
} as const;
