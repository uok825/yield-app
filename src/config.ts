import type { MarketId } from './types.ts';

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
