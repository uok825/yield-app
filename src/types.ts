export type MarketId = 'morpho' | 'aave' | 'fluid';
export type Source = MarketId | 'reserve';

export interface Market {
  id: MarketId;
  name: string;
  trustScore: number;
  apy: number; // % per year
  balance: number; // USDC supplied
  history: number[]; // recent APY samples
}

export interface Fill {
  id: string;
  pair: string; // e.g. "WETH → USDC"; the vault always lends the USDC leg
  amount: number; // USDC lent to the resolver
  fee: number; // USDC paid back on top of principal
  draws: { source: Source; amount: number }[]; // where the liquidity came from
  status: 'auction' | 'lending' | 'settled';
  progress: number; // Dutch auction progress, 0–100
  createdAt: number;
  lentAt: number; // 0 until liquidity is lent
}

export interface State {
  markets: Market[];
  reserve: number; // idle USDC in the vault
  inFlight: number; // USDC currently lent to the resolver (repaid same tx)
  totalShares: number;
  userShares: number;
  walletUsdc: number;
  walletConnected: boolean;
  fills: Fill[];
  feesEarned: number;
  filledCount: number;
  volume: number;
}
