/** Thin client for the YieldSolver relayer HTTP API. Bigints arrive as decimal strings and are parsed here. */
import type { Address, Hex } from 'viem';
import { MARKET_NAMES, RELAYER_URL } from './config.ts';

export interface Market {
  adapter: Address;
  name: string;
  assets: bigint;
  apy: number | null;
}

/** Trailing-window yield metrics computed by the relayer. Any number may be null while it is still measuring. */
export interface Performance {
  netApy: number | null; // % — lending + spread/fee
  lendingApy: number | null; // % — value-weighted, only the lent part earns
  /** % — spread (B) or JIT fee (A) income over the trailing window, annualised. */
  incomeApy: number | null;
  sharePrice: number | null;
  sharePriceChangePct: number | null; // % since first deposit
  vsHodlPct: number | null; // % vs holding the inception basket (B only)
  since: number | null; // unix s, first deposit
  windowSec: number | null;
  spanSec: number | null; // seconds of data behind the annualised figures
  earnedUsd: number | null;
  history: { t: number; sharePrice: number; hodl?: number }[];
}

/** Where one asset of an inventory vault sits: lent through its adapter, or idle in the vault for fills. */
export interface Allocation {
  asset: 'USDC' | 'WETH';
  market: string | null; // 'Aave V3' | 'Morpho' | 'Fluid' | null when no adapter is set
  adapter: Address | null;
  total: bigint;
  lent: bigint;
  idle: bigint;
  apy: number | null;
}

export interface InventoryVault {
  address: Address;
  name: string;
  symbol: string;
  targetStableBps: number;
  bandBps: number;
  stable: bigint;
  volatile: bigint;
  value: bigint; // USDC units
  totalSupply: bigint;
  stableRatioBps: number;
  bid: bigint; // USDC units per WETH × 1e18
  ask: bigint;
  skewBps: number;
  spreadIncome: bigint; // USDC units
  swaps: number;
  allocation: Allocation[];
  performance: Performance | null;
}

/* ── Self-custody (Aqua-native) ─────────── */

export type ScAsset = 'USDC' | 'WETH';

/** An ERC-4626 lending market a wallet can hold shares of and list in its Aqua strategy. */
export interface ScMarket {
  address: Address;
  name: string; // 'Morpho' | 'Fluid' | 'Aave V3'
  symbol: string;
  asset: ScAsset;
  apy: number | null;
}

export interface ScPosition {
  market: Address;
  name: string;
  asset: ScAsset;
  shares: bigint; // in the maker's wallet
  budget: bigint; // committed to Aqua (share units)
  usable: bigint; // min(budget, balance, allowance)
  assets: bigint; // shares → underlying
  committedAssets: bigint;
  usd: number;
}

/** A wallet's shipped AquaYieldApp strategy, as tracked by the relayer. */
export interface ScStrategy {
  maker: Address;
  hash: Hex;
  keeper: Address;
  taker: Address;
  flashFeeBps: number;
  mm: { spreadBps: number; targetStableBps: number; bandBps: number };
  positions: ScPosition[];
  valueUsd: number;
  earned: { jitFeesUsd: number; spreadUsd: number; totalUsd: number };
  counts: { flashes: number; swaps: number; rebalances: number };
  lastRebalanceBlock: number | null;
  usdcShare: number | null;
}

export interface ScDefaults {
  keeper: Address;
  taker: Address;
  flashFeeBps: number;
  oracle: Address;
  maxPriceAge: number;
  spreadBps: number;
  skewBps: number;
  maxTradeBps: number;
  bandBps: number;
  profiles: number[]; // targetStableBps options
}

export interface SelfCustody {
  app: Address;
  resolver: Address;
  aqua: Address;
  defaults: ScDefaults;
  markets: ScMarket[];
  strategies: ScStrategy[];
  totals: { wallets: number; valueUsd: number; earnedUsd: number; jitFeesUsd: number; spreadUsd: number; rebalances: number };
}

/* ── Conditional carry ───────────────────── */

export type CarryEventKind = 'Opened' | 'Closed' | 'Rotated' | 'Deleveraged' | 'Harvested' | 'ShortfallRepaid';

/** A whitelisted ERC-4626 USDC market the carry vault may park borrowed USDC in. APYs and spreads in %. */
export interface CarrySink {
  address: Address;
  name: string; // share symbol, e.g. 'mmUSDC'
  valueUsd: number; // the vault's position
  capUsd: number;
  apy: number | null;
  rewardApr: number;
  netApy: number | null; // apy + haircut reward
  spreadPct: number | null; // netApy − borrow APR, percentage points
}

/** The keeper's latest carry decision (written each tick). */
export interface CarryDecision {
  t: number; // unix s
  status: 'on' | 'off';
  reason: string;
  spreadPct: number | null;
  best?: Address;
  borrowApr: number | null;
  sinkApys: Record<Address, number | null>;
  exitCounter: number;
  executed: string[];
}

export interface CarryEvent {
  block: string;
  tx: Hex;
  kind: CarryEventKind;
  detail: Record<string, string>;
}

/** CarryVault: ETH collateral on Aave, USDC borrowed into sinks only while the spread pays. USD figures are oracle-priced. */
export interface Carry {
  vault: Address;
  creditMarket: Address | null;
  status: 'on' | 'off';
  collateralWeth: number;
  collateralUsd: number;
  debtUsd: number;
  stableUsd: number;
  carryPnlUsd: number; // stableUsd − debtUsd
  tvlWeth: number;
  tvlUsd: number;
  ltvPct: number;
  maxLtvPct: number;
  deleverageLtvPct: number;
  targetLtvPct: number;
  healthFactor: number | null; // null while there is no debt
  borrowApr: number | null;
  vaultApy: number | null; // in ETH terms
  rules: { enterSpreadPct: number; exitSpreadPct: number; exitConfirmations: number; horizonHours: number; costMultiple: number; maxSinkSharePct: number };
  sinks: CarrySink[];
  decision: CarryDecision | null;
  counts: Record<CarryEventKind, number>;
  harvestedWeth: number;
  events: CarryEvent[]; // newest first
}

export interface Snapshot {
  chainId: number;
  mock: boolean;
  block: bigint;
  timestamp: number;
  explorer: string;
  contracts: {
    usdc: Address;
    weth: Address;
    vault: Address;
    inventoryVaults: Address[];
    resolver: Address;
    limitOrderProtocol: Address;
    fusionSettlement: Address;
    oracle: Address;
  };
  oracle: { price: number; updatedAt: number };
  strategyA: {
    vault: Address;
    tvl: bigint;
    idle: bigint;
    reserveBps: number;
    totalSupply: bigint;
    sharePrice: bigint; // USDC units per whole share
    flashFeeBps: number;
    jitFees: bigint;
    jitFills: number;
    markets: Market[];
    performance: Performance | null;
  };
  strategyB: {
    spreadBps: number;
    skewBps: number;
    maxTradeBps: number;
    lendingApy: { usdc: number | null; weth: number | null };
    vaults: InventoryVault[];
    /** Value-weighted over profiles (no span/history of its own). */
    performance: Pick<Performance, 'netApy' | 'lendingApy' | 'incomeApy' | 'vsHodlPct'> | null;
  };
  /** Null on deployments without the self-custody app. */
  selfCustody: SelfCustody | null;
  /** Null on deployments without the carry vault. */
  carry: Carry | null;
}

export type OrderStatus = 'pending' | 'filled' | 'expired' | 'cancelled';

export interface OrderRecord {
  orderHash: Hex;
  status: OrderStatus;
  maker: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  minTakingAmount: bigint;
  auctionStart: number;
  auctionEnd: number;
  deadline: number;
  createdAt: number;
  updatedAt: number;
  fillTx?: Hex;
  report?: { route: string; profit: bigint; profitToken: Address; tx: Hex };
}

export interface QuoteResponse {
  orderHash: Hex;
  order: unknown;
  extension: Hex;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: 'Order';
    message: Record<string, unknown>;
  };
  quote: { fairTaking: bigint; startTaking: bigint; minTaking: bigint; auctionStart: number; auctionEnd: number; ethUsd: number };
}

export class ApiError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(RELAYER_URL + path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError('Relayer unreachable');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error ?? `Relayer error ${res.status}`);
  return body as T;
}

const big = (v: unknown): bigint => BigInt(String(v ?? 0));
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parsePerf(p: any): Performance | null {
  if (!p || typeof p !== 'object') return null;
  return {
    netApy: n(p.netApy),
    lendingApy: n(p.lendingApy),
    incomeApy: n(p.spreadApy ?? p.feeApy),
    sharePrice: n(p.sharePrice),
    sharePriceChangePct: n(p.sharePriceChangePct),
    vsHodlPct: n(p.vsHodlPct),
    since: n(p.since),
    windowSec: n(p.windowSec),
    spanSec: n(p.spanSec),
    earnedUsd: n(p.earnedUsd),
    history: Array.isArray(p.history)
      ? p.history
          .map((h: any) => ({ t: Number(h.t), sharePrice: Number(h.sharePrice), hodl: n(h.hodl) ?? undefined }))
          .filter((h: { t: number; sharePrice: number }) => Number.isFinite(h.t) && Number.isFinite(h.sharePrice))
      : [],
  };
}

function parseOrder(o: any): OrderRecord {
  return {
    orderHash: o.orderHash,
    status: o.status,
    maker: o.maker,
    makerAsset: o.makerAsset,
    takerAsset: o.takerAsset,
    makingAmount: big(o.makingAmount),
    minTakingAmount: big(o.minTakingAmount),
    auctionStart: Number(o.auctionStart),
    auctionEnd: Number(o.auctionEnd),
    deadline: Number(o.deadline),
    createdAt: Number(o.createdAt),
    updatedAt: Number(o.updatedAt),
    fillTx: o.fillTx,
    report: o.report ? { ...o.report, profit: big(o.report.profit) } : undefined,
  };
}

const num0 = (v: unknown): number => n(v) ?? 0;

function parseSelfCustody(sc: any): SelfCustody | null {
  if (!sc || typeof sc !== 'object' || !sc.app) return null;
  const e = sc.earned ?? {};
  return {
    ...sc,
    markets: (sc.markets ?? []).map((m: any) => ({ ...m, apy: n(m.apy) })),
    strategies: (sc.strategies ?? []).map((st: any) => ({
      ...st,
      flashFeeBps: num0(st.flashFeeBps),
      positions: (st.positions ?? []).map((p: any) => ({
        ...p,
        shares: big(p.shares),
        budget: big(p.budget),
        usable: big(p.usable),
        assets: big(p.assets),
        committedAssets: big(p.committedAssets),
        usd: num0(p.usd),
      })),
      valueUsd: num0(st.valueUsd),
      earned: { jitFeesUsd: num0(st.earned?.jitFeesUsd ?? e.jitFeesUsd), spreadUsd: num0(st.earned?.spreadUsd), totalUsd: num0(st.earned?.totalUsd) },
      counts: { flashes: num0(st.counts?.flashes), swaps: num0(st.counts?.swaps), rebalances: num0(st.counts?.rebalances) },
      lastRebalanceBlock: n(st.lastRebalanceBlock),
      usdcShare: n(st.usdcShare),
    })),
    totals: {
      wallets: num0(sc.totals?.wallets),
      valueUsd: num0(sc.totals?.valueUsd),
      earnedUsd: num0(sc.totals?.earnedUsd),
      jitFeesUsd: num0(sc.totals?.jitFeesUsd),
      spreadUsd: num0(sc.totals?.spreadUsd),
      rebalances: num0(sc.totals?.rebalances),
    },
  };
}

const CARRY_KINDS: CarryEventKind[] = ['Opened', 'Closed', 'Rotated', 'Deleveraged', 'Harvested', 'ShortfallRepaid'];

function parseCarry(c: any): Carry | null {
  if (!c || typeof c !== 'object' || !c.vault) return null;
  const d = c.decision;
  return {
    ...c,
    healthFactor: n(c.healthFactor),
    borrowApr: n(c.borrowApr),
    vaultApy: n(c.vaultApy),
    sinks: (c.sinks ?? []).map((x: any) => ({
      ...x,
      valueUsd: num0(x.valueUsd),
      capUsd: num0(x.capUsd),
      apy: n(x.apy),
      rewardApr: num0(x.rewardApr),
      netApy: n(x.netApy),
      spreadPct: n(x.spreadPct),
    })),
    decision: d && typeof d === 'object' ? { ...d, t: num0(d.t), spreadPct: n(d.spreadPct), borrowApr: n(d.borrowApr), exitCounter: num0(d.exitCounter), executed: d.executed ?? [] } : null,
    counts: Object.fromEntries(CARRY_KINDS.map((k) => [k, num0(c.counts?.[k])])) as Record<CarryEventKind, number>,
    harvestedWeth: num0(c.harvestedWeth),
    events: c.events ?? [],
  };
}

/** The carry vault is also listed as a self-custody WETH market; the relayer names it generically, so label it here. */
function labelCarryMarket(sc: SelfCustody | null, carry: Carry | null): SelfCustody | null {
  if (!sc || !carry) return sc;
  const isCarry = (a: string) => a.toLowerCase() === carry.vault.toLowerCase();
  const name = MARKET_NAMES.carry;
  return {
    ...sc,
    markets: sc.markets.map((m) => (isCarry(m.address) ? { ...m, name } : m)),
    strategies: sc.strategies.map((st) => ({ ...st, positions: st.positions.map((p) => (isCarry(p.market) ? { ...p, name } : p)) })),
  };
}

export async function getSnapshot(): Promise<Snapshot> {
  const s: any = await call('/v1/snapshot');
  const a = s.strategyA;
  const carry = parseCarry(s.carry);
  return {
    ...s,
    block: big(s.block),
    selfCustody: labelCarryMarket(parseSelfCustody(s.selfCustody), carry),
    carry,
    strategyA: {
      ...a,
      tvl: big(a.tvl),
      idle: big(a.idle),
      totalSupply: big(a.totalSupply),
      sharePrice: big(a.sharePrice),
      jitFees: big(a.jitFees),
      markets: a.markets.map((m: any) => ({ ...m, assets: big(m.assets) })),
      performance: parsePerf(a.performance),
    },
    strategyB: {
      ...s.strategyB,
      performance: parsePerf(s.strategyB.performance),
      vaults: s.strategyB.vaults.map((v: any) => ({
        ...v,
        stable: big(v.stable),
        volatile: big(v.volatile),
        value: big(v.value),
        totalSupply: big(v.totalSupply),
        bid: big(v.bid),
        ask: big(v.ask),
        spreadIncome: big(v.spreadIncome),
        allocation: (v.allocation ?? []).map((a: any) => ({
          ...a,
          total: big(a.total),
          lent: big(a.lent),
          idle: big(a.idle),
          apy: n(a.apy),
        })),
        performance: parsePerf(v.performance),
      })),
    },
  };
}

export async function getOrders(q: { limit?: number; maker?: Address; status?: OrderStatus } = {}): Promise<OrderRecord[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const r = await call<{ items: unknown[] }>(`/v1/orders?${params}`);
  return r.items.map(parseOrder);
}

export const getOrder = async (hash: Hex): Promise<OrderRecord> => parseOrder(await call(`/v1/orders/${hash}`));

export async function postQuote(req: { maker: Address; makerAsset: Address; takerAsset: Address; makingAmount: bigint }): Promise<QuoteResponse> {
  const r: any = await call('/v1/quote', { method: 'POST', body: JSON.stringify({ ...req, makingAmount: req.makingAmount.toString() }) });
  const q = r.quote;
  return {
    ...r,
    quote: { ...q, fairTaking: big(q.fairTaking), startTaking: big(q.startTaking), minTaking: big(q.minTaking), auctionStart: Number(q.auctionStart), auctionEnd: Number(q.auctionEnd) },
  };
}

export async function postOrder(body: { orderHash: Hex; order: unknown; extension: Hex; signature: Hex }): Promise<Hex> {
  const r = await call<{ orderHash: Hex }>('/v1/orders', { method: 'POST', body: JSON.stringify(body) });
  return r.orderHash;
}

export type Route =
  | { kind: 'jit' }
  | { kind: 'inventory'; index: number }
  /** Filled from a self-custody wallet's committed shares: market making ('mm') or a JIT loan ('jit'). */
  | { kind: 'wallet'; mode: 'mm' | 'jit'; makerPrefix: string };

/** 'jit' → Strategy A; 'inventory:i' → Strategy B vault i; 'wallet-mm:0x…' / 'wallet-jit:0x…' → a self-custody wallet. */
export function parseRoute(route: string | undefined): Route | null {
  if (!route) return null;
  if (route === 'jit') return { kind: 'jit' };
  const w = route.match(/^wallet-(mm|jit):(0x[0-9a-fA-F]+)$/);
  if (w) return { kind: 'wallet', mode: w[1] as 'mm' | 'jit', makerPrefix: w[2].toLowerCase() };
  const m = route.match(/^inventory:(\d+)$/);
  return m ? { kind: 'inventory', index: Number(m[1]) } : null;
}
