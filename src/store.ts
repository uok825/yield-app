import { CONFIG, MARKETS, MM, PROFILES } from './config.ts';
import type { MmState, State } from './types.ts';

/** Minimal reactive store. Updaters must be pure: compute the next state, no timers or DOM. */
function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<(state: T) => void>();
  return {
    get: (): T => state,
    update(updater: (s: T) => Partial<T>): void {
      state = { ...state, ...updater(state) };
      for (const fn of listeners) fn(state);
    },
    subscribe(fn: (state: T) => void): void {
      listeners.add(fn);
      fn(state);
    },
  };
}

const deployable = CONFIG.initialAssets * (1 - CONFIG.reserveRatio);

/** Strategy A · Yield + JIT (also holds the mock wallet's USDC and connection). */
export const store = createStore<State>({
  markets: MARKETS.map((m) => ({
    id: m.id,
    name: m.name,
    trustScore: m.trustScore,
    apy: m.baseApy,
    balance: deployable / MARKETS.length,
    history: [m.baseApy],
  })),
  reserve: CONFIG.initialAssets * CONFIG.reserveRatio,
  inFlight: 0,
  totalShares: CONFIG.initialAssets, // share price starts at 1.00
  userShares: CONFIG.initialUserShares,
  walletUsdc: CONFIG.walletUsdc,
  walletConnected: false,
  fills: [],
  feesEarned: 0,
  filledCount: 0,
  volume: 0,
});

/** Strategy B · Inventory MM. Each profile starts on target with share price $1.00. */
export const mmStore = createStore<MmState>({
  price: MM.startPrice,
  history: [MM.startPrice],
  usdcApy: MM.usdcApy,
  ethApy: MM.ethApy,
  profiles: PROFILES.map((p) => ({
    id: p.id,
    name: p.name,
    target: p.target,
    usdc: p.seedUsd * p.target,
    eth: (p.seedUsd * (1 - p.target)) / MM.startPrice,
    totalShares: p.seedUsd,
    userShares: MM.userSeed[p.id] ?? 0,
    rebalancing: false,
  })),
  events: [],
  flow: 0,
  walletEth: MM.walletEth,
  simHours: 0,
  spreadIncome: 0,
  keeperCost: 0,
  fillCount: 0,
  rejectedCount: 0,
  volume: 0,
});
