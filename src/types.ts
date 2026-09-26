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

/* ── Strategy B · Inventory MM ─────────────── */
export type ProfileId = 'stable' | 'balanced' | 'eth';

export interface Profile {
  id: ProfileId;
  name: string;
  target: number; // target USDC share of value, e.g. 0.7
  usdc: number;
  eth: number;
  totalShares: number;
  userShares: number;
  rebalancing: boolean; // out of band; the keeper swaps back to target next tick
}

export interface MmEvent {
  id: string;
  kind: 'fill' | 'rejected' | 'keeper';
  dir: 'USDC → ETH' | 'ETH → USDC'; // the taker's direction (keeper: the vault's swap)
  usd: number; // notional at oracle price
  profile: ProfileId | null;
  price: number; // execution price, USD per ETH
  edgeBps: number; // vault's gain vs oracle
  income: number; // USD, measured at oracle price
  at: number;
}

export interface MmState {
  price: number; // oracle, USD per ETH
  history: number[]; // recent oracle prices
  usdcApy: number;
  ethApy: number;
  profiles: Profile[];
  events: MmEvent[];
  flow: number; // −1…1, persistent taker bias toward selling (−) or buying (+) ETH
  walletEth: number;
  simHours: number;
  spreadIncome: number;
  keeperCost: number;
  fillCount: number;
  rejectedCount: number;
  volume: number;
}
