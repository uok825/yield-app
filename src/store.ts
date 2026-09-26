import { CONFIG, MARKETS } from './config.ts';
import type { State } from './types.ts';

type Listener = (state: State) => void;

const deployable = CONFIG.initialAssets * (1 - CONFIG.reserveRatio);

const initialState: State = {
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
};

let state = initialState;
const listeners = new Set<Listener>();

export const store = {
  get: (): State => state,

  /** Updaters must be pure: compute the next state, no timers or DOM. */
  update(updater: (s: State) => Partial<State>): void {
    state = { ...state, ...updater(state) };
    for (const fn of listeners) fn(state);
  },

  subscribe(fn: Listener): void {
    listeners.add(fn);
    fn(state);
  },
};
