import { baseSepolia } from 'viem/chains';

/** Runtime endpoints (override with VITE_RPC_URL / VITE_RELAYER_URL). */
export const RPC_URL: string = import.meta.env.VITE_RPC_URL || 'https://sepolia.base.org';
export const RELAYER_URL: string = (import.meta.env.VITE_RELAYER_URL || '/api').replace(/\/$/, '');

export const CHAIN = baseSepolia;
export const CHAIN_ID = baseSepolia.id; // 84532

export const GAS_FAUCET_URL = 'https://docs.base.org/base-chain/tools/network-faucets';

/** Poll cadence (ms). The public RPC is rate-limited, so wallet reads are batched and slower. */
export const POLL = {
  snapshot: 8_000,
  orders: 8_000,
  wallet: 10_000,
  order: 3_000,
} as const;

export const DECIMALS = { usdc: 6, weth: 18, ysUsdc: 12, inv: 18 } as const;

/** Faucet amounts (MockERC20.mint) in whole tokens. */
export const FAUCET = { usdc: 10_000n, weth: 3n } as const;

/** Short display names for the three inventory vaults, in snapshot order. */
export const PROFILE_NAMES = ['Stable', 'Balanced', 'ETH-heavy'] as const;

/** Friendly names for Strategy A market adapters (snapshot names are lowercase ids). */
export const MARKET_NAMES: Record<string, string> = { morpho: 'Morpho Blue', aave: 'Aave V3', fluid: 'Fluid', carry: 'Carry (ETH)' };
