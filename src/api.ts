/** Thin client for the YieldSolver relayer HTTP API. Bigints arrive as decimal strings and are parsed here. */
import type { Address, Hex } from 'viem';
import { RELAYER_URL } from './config.ts';

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

export async function getSnapshot(): Promise<Snapshot> {
  const s: any = await call('/v1/snapshot');
  const a = s.strategyA;
  return {
    ...s,
    block: big(s.block),
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

/** 'jit' → Strategy A; 'inventory:i' → Strategy B vault i. */
export function parseRoute(route: string | undefined): { kind: 'jit' } | { kind: 'inventory'; index: number } | null {
  if (!route) return null;
  if (route === 'jit') return { kind: 'jit' };
  const m = route.match(/^inventory:(\d+)$/);
  return m ? { kind: 'inventory', index: Number(m[1]) } : null;
}
