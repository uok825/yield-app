import type { Address, Hex } from 'viem';
import type { OrderRecord, Snapshot } from './api.ts';

/** The connected wallet's share balance in one listed self-custody market. */
export interface ScHolding {
  address: Address;
  shares: bigint;
  /** Shares → underlying (USDC / WETH units). */
  assets: bigint;
  decimals: number;
  /** Allowance granted to Aqua for this share token. */
  aquaAllowance: bigint;
}

/** One of the wallet's Aqua strategies as read on-chain (Aqua.rawBalances): what is committed, per market. */
export interface ScCommit {
  hash: Hex;
  /** True while at least one token is in an active (not docked) state. */
  active: boolean;
  /** Markets that are part of the strategy with their committed budget (share units). */
  tokens: { market: Address; budget: bigint }[];
}

/** A strategy this session shipped (params known locally), kept until the relayer reports it. */
export interface ScLocal {
  profileBps: number;
  flashFeeBps: number;
  spreadBps: number;
  shippedAt: number;
  tx: Hex;
}

export interface Balances {
  eth: bigint;
  usdc: bigint;
  weth: bigint;
  /** Strategy A position. */
  a: { shares: bigint; assets: bigint; maxRedeem: bigint };
  /** Strategy B positions, in snapshot.contracts.inventoryVaults order. */
  b: { shares: bigint; stable: bigint; volatile: bigint }[];
  /** Self-custody: holdings in snapshot.selfCustody.markets order, and the wallet's strategies. Null without self-custody. */
  sc: { holdings: ScHolding[]; commits: ScCommit[] } | null;
  /** Carry vault position (ERC-4626 over WETH). Null without the carry vault. */
  carry: CarryPosition | null;
}

export interface CarryPosition {
  shares: bigint;
  /** Shares → WETH. */
  assets: bigint;
  /** Contract limits: withdrawals are capped by what the collateral can release (profit must be harvested first). */
  maxRedeem: bigint;
  maxWithdraw: bigint;
  decimals: number;
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
  /** Strategies shipped in this session, by hash (lets the UI track them before the relayer indexes them). */
  scLocal: Record<Hex, ScLocal>;
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
  scLocal: {},
});
