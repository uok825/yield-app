import type { Address } from 'viem';
import type { OrderRecord, Snapshot } from './api.ts';

export interface Balances {
  eth: bigint;
  usdc: bigint;
  weth: bigint;
  /** Strategy A position. */
  a: { shares: bigint; assets: bigint; maxRedeem: bigint };
  /** Strategy B positions, in snapshot.contracts.inventoryVaults order. */
  b: { shares: bigint; stable: bigint; volatile: bigint }[];
}

export interface WalletState {
  /** 'none': no injected EIP-1193 wallet in this browser. */
  status: 'none' | 'disconnected' | 'connecting' | 'connected';
  address: Address | null;
  chainId: number | null;
}

export interface State {
  snapshot: Snapshot | null;
  snapshotError: string | null;
  /** Filled orders with a resolver report, newest first (merged across polls). */
  fills: OrderRecord[];
  /** The connected wallet's own intents, newest first. */
  myOrders: OrderRecord[];
  wallet: WalletState;
  balances: Balances | null;
}

/** Minimal reactive store: `update` merges a patch and notifies subscribers. */
function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<(state: T) => void>();
  return {
    get: (): T => state,
    update(patch: Partial<T> | ((s: T) => Partial<T>)): void {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const fn of listeners) fn(state);
    },
    subscribe(fn: (state: T) => void): void {
      listeners.add(fn);
      fn(state);
    },
  };
}

export const store = createStore<State>({
  snapshot: null,
  snapshotError: null,
  fills: [],
  myOrders: [],
  wallet: { status: 'disconnected', address: null, chainId: null },
  balances: null,
});
