/**
 * Read model for dashboards (served by the relayer at GET /v1/snapshot).
 *
 * - Fee income is accumulated from on-chain events: YieldVault `LiquiditySettled.fee` (strategy A, JIT fees) and
 *   InventoryVault `SwapSettled(valueAfter − valueBefore)` (strategy B, spread income at the oracle price).
 * - Market APYs come from supply-index samples (ERC-4626 share price, Aave normalized income) over a rolling window.
 * - Snapshots are cached for SNAPSHOT_TTL_MS so many viewers don't multiply RPC load.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, getAddress, parseEventLogs, zeroHash } from 'viem'

import { erc20Abi, type Context } from './chain.ts'
import { aaveV3AdapterAbi, aquaYieldAppAbi, chainlinkAggregatorAbi } from './abis.ts'
import { StrategyRegistry, positions, selfCustodyEnabled } from './wallets.ts'
import { privateKeyToAccount } from 'viem/accounts'
import { erc4626Rate, walletMarketName } from './markets.ts'
import { inventoryVaultAbi, oracleSwapAppAbi, yieldVaultAbi } from './abis.ts'
import { apyOverWindow, type RateSample } from './allocation.ts'
import { aaveIndex, describeAdapter, type MarketInfo } from './markets.ts'
import { ethUsd } from './prices.ts'
import { borrowApr, carryEnabled, lastDecision, readCarry } from './carry.ts'
import { carryVaultAbi } from './abis.ts'
import { logger } from './log.ts'
import {
  type PerfSample,
  changePct,
  windowStart,
  downsample,
  hodlPrice,
  incomeApy,
  lendingApy,
  round2,
  sharePrice as perShare,
  vsHodlPct,
} from './yield.ts'

const log = logger('snapshot')
const ZERO = '0x0000000000000000000000000000000000000000'
const TTL_MS = Number(process.env.SNAPSHOT_TTL_MS ?? 5_000)
const SAMPLE_EVERY_SEC = 30
/** Performance samples (value, shares, holdings, cumulative income) for APY / vs-HODL / share-price charts. */
const PERF_SAMPLE_SEC = Number(process.env.PERF_SAMPLE_SEC ?? 300)
const PERF_WINDOW_SEC = Number(process.env.PERF_WINDOW_SEC ?? 86_400)
const PERF_MIN_SPAN_SEC = Number(process.env.PERF_MIN_SPAN_SEC ?? 600)
const PERF_KEEP_SEC = 7 * 86_400
const CHART_POINTS = 60
const MARKET_NAMES: Record<string, string> = { aave: 'Aave V3', morpho: 'Morpho', fluid: 'Fluid' }

interface Persisted {
  lastBlock: string
  jitFees: string
  jitFills: number
  spread: Record<string, { income: string; swaps: number }>
  samples: Record<string, { t: number; index: string }[]>
  perf?: Record<string, PerfSample[]>
  /** Self-custody income per maker, from AquaYieldApp events. Amounts in token units (strings). */
  wallets?: Record<
    string,
    { jitFees: Record<string, string>; flashes: number; spreadUsd: number; swaps: number; rebalances: number; lastRebalance?: number }
  >
  inception?: Record<string, PerfSample & { fromDeposit?: boolean }>
  /** CarryVault activity from its events. */
  carry?: { counts: Record<string, number>; harvestedWeth: string; events: { block: string; tx: string; kind: string; detail: Record<string, string> }[] }
}

export class Snapshotter {
  private state: Persisted
  private markets?: { key: string; name: string; rate: MarketInfo['rate'] }[]
  private cache?: { at: number; value: unknown }
  private lastSampleT = 0

  constructor(
    private ctx: Context,
    private file = join(ctx.cfg.stateDir, `snapshot-${ctx.chain.id}.json`),
  ) {
    this.state = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Persisted)
      : { lastBlock: '0', jitFees: '0', jitFills: 0, spread: {}, samples: {} }
  }

  private save() {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state))
    renameSync(this.file + '.tmp', this.file)
  }

  private async marketList() {
    if (this.markets) return this.markets
    const { d } = this.ctx
    const list: { key: string; name: string; rate: MarketInfo['rate'] }[] = []
    for (const adapter of d.adapters ?? []) {
      const info = await describeAdapter(this.ctx, adapter)
      list.push({ key: getAddress(adapter), name: info.name, rate: info.rate })
    }
    if (d.aaveWethPool && d.aaveWethPool !== ZERO) {
      list.push({ key: 'aaveWeth', name: 'aaveWeth', rate: aaveIndex(this.ctx, d.aaveWethPool, d.weth) })
    }
    return (this.markets = list)
  }

  /** Folds new vault events into the fee totals and samples market indices. Called from the relayer loop. */
  async sync() {
    const { ctx } = this
    const { d, client } = ctx
    const head = await client.getBlockNumber()
    let from = BigInt(this.state.lastBlock) + 1n
    if (from === 1n) from = BigInt(d.deployBlock || Number(head))
    const vaults = [
      d.vault,
      ...(d.inventoryVaults ?? []),
      ...(selfCustodyEnabled(ctx) ? [d.aquaYieldApp!] : []),
      ...(carryEnabled(ctx) ? [d.carryVault!] : []),
    ].filter(
      (a) => a && a !== ZERO,
    )
    while (from <= head) {
      const to = from + ctx.cfg.logBlockRange - 1n < head ? from + ctx.cfg.logBlockRange - 1n : head
      const logs = await client.getLogs({ address: vaults, fromBlock: from, toBlock: to })
      for (const ev of parseEventLogs({ abi: yieldVaultAbi, logs, eventName: 'LiquiditySettled' })) {
        this.state.jitFees = (BigInt(this.state.jitFees) + ev.args.fee).toString()
        this.state.jitFills++
      }
      if (selfCustodyEnabled(ctx)) await this.foldWalletEvents(logs)
      if (carryEnabled(ctx)) this.foldCarryEvents(logs)
      for (const ev of parseEventLogs({ abi: inventoryVaultAbi, logs, eventName: 'SwapSettled' })) {
        const key = getAddress(ev.address)
        const s = (this.state.spread[key] ??= { income: '0', swaps: 0 })
        s.income = (BigInt(s.income) + ev.args.valueAfter - ev.args.valueBefore).toString()
        s.swaps++
      }
      this.state.lastBlock = to.toString()
      from = to + 1n
    }

    const t = Number((await client.getBlock({ blockNumber: head })).timestamp)
    await this.samplePerformance(t)
    if (t - this.lastSampleT >= SAMPLE_EVERY_SEC) {
      this.lastSampleT = t
      const keep = ctx.cfg.keeper.apyWindowSec * 3
      for (const m of [...(d.walletStableMarkets ?? []), ...(d.walletVolatileMarkets ?? [])]) {
        if (!this.walletRates.has(m)) this.walletRates.set(m, await erc4626Rate(ctx, m))
        const list = (this.state.samples[`w:${m}`] ??= [])
        list.push({ t, index: (await this.walletRates.get(m)!()).toString() })
        while (list.length > 2 && t - list[1].t >= ctx.cfg.keeper.apyWindowSec * 3) list.shift()
      }
      if (carryEnabled(ctx)) {
        const { sinks } = await readCarry(ctx)
        for (const [key, m] of [['c:vault', d.carryVault!], ...sinks.map((x) => [`c:${x.address}`, x.address])] as [string, Address][]) {
          if (!this.walletRates.has(m)) this.walletRates.set(m, await erc4626Rate(ctx, m))
          const list = (this.state.samples[key] ??= [])
          list.push({ t, index: (await this.walletRates.get(m)!()).toString() })
          while (list.length > 2 && t - list[1].t >= keep) list.shift()
        }
      }
      for (const m of await this.marketList()) {
        const list = (this.state.samples[m.key] ??= [])
        list.push({ t, index: (await m.rate()).toString() })
        while (list.length > 2 && t - list[1].t >= keep) list.shift()
      }
    }
    this.save()
  }

  /** Current performance sample for strategy A ('A') and each inventory vault (by address). */
  private async perfNow(t: number): Promise<Record<string, PerfSample>> {
    const { d, client } = this.ctx
    const { price } = await ethUsd(this.ctx)
    const read = <T>(address: Address, abi: any, functionName: string) =>
      client.readContract({ address, abi, functionName } as any) as Promise<T>
    const out: Record<string, PerfSample> = {}
    const [tvl, supply] = await Promise.all([
      read<bigint>(d.vault, yieldVaultAbi, 'totalAssets'),
      read<bigint>(d.vault, yieldVaultAbi, 'totalSupply'),
    ])
    const usd = Number(tvl) / 1e6
    out.A = { t, value: usd, supply: Number(supply) / 1e12, stable: usd, volatile: 0, income: Number(this.state.jitFees) / 1e6, price }
    for (const v of d.inventoryVaults ?? []) {
      const [holdings, value, sup] = await Promise.all([
        read<readonly [bigint, bigint]>(v, inventoryVaultAbi, 'holdings'),
        read<bigint>(v, inventoryVaultAbi, 'totalValue'),
        read<bigint>(v, inventoryVaultAbi, 'totalSupply'),
      ])
      out[getAddress(v)] = {
        t,
        value: Number(value) / 1e6,
        supply: Number(sup) / 1e18,
        stable: Number(holdings[0]) / 1e6,
        volatile: Number(holdings[1]) / 1e18,
        income: Number(this.state.spread[getAddress(v)]?.income ?? 0) / 1e6,
        price,
      }
    }
    return out
  }

  private backfilled = false
  private registry?: StrategyRegistry
  private walletRates = new Map<string, () => Promise<bigint>>()

  /**
   * Anchors each vault's inception at its first on-chain Deposit (basket, shares, oracle price at that block), so
   * APY and vs-HODL cover the whole history rather than starting when this process first sampled.
   */
  private async backfillInception() {
    if (this.backfilled) return
    const { d, client, cfg } = this.ctx
    const inception = (this.state.inception ??= {})
    const perf = (this.state.perf ??= {})
    const keys = new Map<string, 'A' | 'B'>([[getAddress(d.vault), 'A']])
    for (const v of d.inventoryVaults ?? []) keys.set(getAddress(v), 'B')
    const missing = new Set([...keys.keys()].filter((a) => !inception[keys.get(a) === 'A' ? 'A' : a]?.fromDeposit))
    if (missing.size === 0) return (this.backfilled = true)

    const head = await client.getBlockNumber()
    const limit = BigInt(d.deployBlock) + 50_000n
    for (let from = BigInt(d.deployBlock); from <= head && from <= limit && missing.size > 0; from += cfg.logBlockRange) {
      const to = from + cfg.logBlockRange - 1n < head ? from + cfg.logBlockRange - 1n : head
      const logs = await client.getLogs({ address: [...missing] as Address[], fromBlock: from, toBlock: to })
      const found: { key: string; blockNumber: bigint; make: (price: number) => Omit<PerfSample, 't'> }[] = []
      for (const ev of parseEventLogs({ abi: yieldVaultAbi, logs, eventName: 'Deposit' })) {
        if (!missing.has(getAddress(ev.address)) || keys.get(getAddress(ev.address)) !== 'A') continue
        const value = Number(ev.args.assets) / 1e6
        found.push({
          key: getAddress(ev.address),
          blockNumber: ev.blockNumber,
          make: (price) => ({ value, supply: Number(ev.args.shares) / 1e12, stable: value, volatile: 0, income: 0, price }),
        })
        missing.delete(getAddress(ev.address))
      }
      for (const ev of parseEventLogs({ abi: inventoryVaultAbi, logs, eventName: 'Deposit' })) {
        if (!missing.has(getAddress(ev.address))) continue
        const stable = Number(ev.args.stableIn) / 1e6
        const volatile = Number(ev.args.volatileIn) / 1e18
        found.push({
          key: getAddress(ev.address),
          blockNumber: ev.blockNumber,
          make: (price) => ({ value: stable + volatile * price, supply: Number(ev.args.shares) / 1e18, stable, volatile, income: 0, price }),
        })
        missing.delete(getAddress(ev.address))
      }
      for (const f of found) {
        const [block, round] = await Promise.all([
          client.getBlock({ blockNumber: f.blockNumber }),
          client.readContract({ address: d.oracle, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData', blockNumber: f.blockNumber }),
        ])
        const sample: PerfSample = { t: Number(block.timestamp), ...f.make(Number(round[1]) / 1e8) }
        const key = keys.get(f.key) === 'A' ? 'A' : f.key
        inception[key] = { ...sample, fromDeposit: true }
        perf[key] = [sample, ...(perf[key] ?? []).filter((x) => x.t > sample.t)]
        log.info('performance anchored at first deposit', { vault: key, block: f.blockNumber })
      }
    }
    this.backfilled = true
  }

  private async samplePerformance(t: number) {
    await this.backfillInception()
    const perf = (this.state.perf ??= {})
    const inception = (this.state.inception ??= {})
    const last = perf.A?.[perf.A.length - 1]
    if (last && t - last.t < PERF_SAMPLE_SEC) return
    for (const [key, sample] of Object.entries(await this.perfNow(t))) {
      if (sample.supply <= 0) continue
      inception[key] ??= sample
      const list = (perf[key] ??= [])
      list.push(sample)
      while (list.length > 2 && t - list[0].t > PERF_KEEP_SEC) list.shift()
    }
  }

  /** APY / vs-HODL / share-price metrics for one key, given its current sample and lending APY. */
  private performance(key: string, now: PerfSample, lending: number | null, isInventory: boolean) {
    const samples = this.state.perf?.[key] ?? []
    const inception = this.state.inception?.[key]
    const income = incomeApy(samples, now, PERF_WINDOW_SEC, PERF_MIN_SPAN_SEC)
    const start = windowStart(samples, now, PERF_WINDOW_SEC, PERF_MIN_SPAN_SEC)
    const net = lending === null || income === null ? null : lending + income
    const series = downsample([...samples.filter((x) => now.t - x.t <= 2 * PERF_WINDOW_SEC), now], CHART_POINTS)
    return {
      netApy: round2(net),
      lendingApy: round2(lending),
      [isInventory ? 'spreadApy' : 'feeApy']: round2(income),
      sharePrice: perShare(now),
      sharePriceChangePct: inception ? round2(changePct(perShare(inception), perShare(now))) : null,
      vsHodlPct: isInventory && inception ? round2(vsHodlPct(inception, now)) : null,
      since: inception?.t ?? null,
      windowSec: PERF_WINDOW_SEC,
      /** Seconds of history the income APY was annualised from (short spans extrapolate a lot). */
      spanSec: start ? now.t - start.t : null,
      /** Income earned since inception, USD. */
      earnedUsd: inception ? round2(now.income - (inception.income ?? 0)) : null,
      history: series.map((x) => ({
        t: x.t,
        sharePrice: perShare(x),
        ...(isInventory && inception ? { hodl: hodlPrice(inception, x.price) } : {}),
      })),
    }
  }

  private adapterNames = new Map<Address, string>()

  /** Market label for an adapter: 'aave' | 'morpho' | 'fluid' (Aave WETH counts as 'aave'). */
  private async adapterName(adapter: Address): Promise<string | undefined> {
    const cached = this.adapterNames.get(adapter)
    if (cached) return cached
    const { d } = this.ctx
    let name: string
    try {
      name = (await describeAdapter(this.ctx, adapter)).name
    } catch {
      return undefined
    }
    if (name.startsWith('0x')) {
      // describeAdapter labels the Aave WETH pool by address; normalise it.
      const pool = await this.ctx.client
        .readContract({ address: adapter, abi: aaveV3AdapterAbi, functionName: 'pool' })
        .catch(() => undefined)
      if (pool && d.aaveWethPool && getAddress(pool) === getAddress(d.aaveWethPool)) name = 'aave'
    }
    this.adapterNames.set(adapter, name)
    return name
  }

  private async foldWalletEvents(logs: any[]) {
    const { d } = this.ctx
    const w = (this.state.wallets ??= {})
    const entry = (maker: string) => (w[getAddress(maker)] ??= { jitFees: {}, flashes: 0, spreadUsd: 0, swaps: 0, rebalances: 0 })
    const app = getAddress(d.aquaYieldApp!)
    const mine = logs.filter((l) => getAddress(l.address) === app)
    for (const ev of parseEventLogs({ abi: aquaYieldAppAbi, logs: mine })) {
      if (ev.eventName === 'Flash') {
        const e = entry(ev.args.maker)
        const token = getAddress(ev.args.market)
        e.jitFees[token] = (BigInt(e.jitFees[token] ?? '0') + ev.args.fee).toString()
        e.flashes++
      } else if (ev.eventName === 'Swap') {
        // Maker's gain at the oracle price: value received − value sold (USDC 6 dp, WETH 18 dp, price 1e18-scaled).
        const e = entry(ev.args.maker)
        const usdcIn = getAddress(ev.args.tokenIn) === getAddress(d.usdc)
        const px = Number(ev.args.oraclePrice) / 1e24 // USD per ETH
        const inUsd = usdcIn ? Number(ev.args.amountIn) / 1e6 : (Number(ev.args.amountIn) / 1e18) * px
        const outUsd = usdcIn ? (Number(ev.args.amountOut) / 1e18) * px : Number(ev.args.amountOut) / 1e6
        e.spreadUsd += inUsd - outUsd
        e.swaps++
      } else if (ev.eventName === 'Rebalanced') {
        const e = entry(ev.args.maker)
        e.rebalances++
        e.lastRebalance = Number(ev.blockNumber)
      }
    }
  }

  /** Self-custody view: listed markets with APYs and every active wallet strategy's positions and income. */
  private async selfCustody(ethPrice: number) {
    const { ctx } = this
    const { d, client } = ctx
    if (!selfCustodyEnabled(ctx)) return null
    this.registry ??= new StrategyRegistry(ctx)
    await this.registry.sync()
    const lite = [
      { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
      { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    ] as const
    const markets = await Promise.all(
      [...(d.walletStableMarkets ?? []), ...(d.walletVolatileMarkets ?? [])].map(async (m) => ({
        address: m,
        name: MARKET_NAMES[walletMarketName(ctx, m)] ?? 'Lending',
        symbol: await client.readContract({ address: m, abi: lite, functionName: 'symbol' }),
        asset: (d.walletStableMarkets ?? []).includes(m) ? ('USDC' as const) : ('WETH' as const),
        apy: this.apy(`w:${m}`),
      })),
    )
    const toUsd = (asset: 'USDC' | 'WETH', amount: bigint) =>
      asset === 'USDC' ? Number(amount) / 1e6 : (Number(amount) / 1e18) * ethPrice
    const strategies = await Promise.all(
      this.registry.active().map(async (sh) => {
        const pos = await positions(ctx, sh)
        const rows = await Promise.all(
          pos.map(async (p) => {
            const asset = sh.strategy.stableMarkets.includes(p.market) ? ('USDC' as const) : ('WETH' as const)
            const [inWallet, committed] = await Promise.all([
              client.readContract({ address: p.market, abi: lite, functionName: 'convertToAssets', args: [p.balance] }),
              client.readContract({ address: p.market, abi: lite, functionName: 'convertToAssets', args: [p.budget] }),
            ])
            return {
              market: p.market,
              name: markets.find((m) => m.address === p.market)?.name ?? 'Lending',
              asset,
              shares: p.balance,
              budget: p.budget,
              usable: p.usable,
              assets: inWallet,
              committedAssets: committed,
              usd: toUsd(asset, inWallet),
            }
          }),
        )
        const income = this.state.wallets?.[sh.maker] ?? { jitFees: {}, flashes: 0, spreadUsd: 0, swaps: 0, rebalances: 0 }
        const jitFeesUsd = Object.entries(income.jitFees).reduce((sum, [market, fee]) => {
          const asset = (d.walletStableMarkets ?? []).includes(market as Address) ? 'USDC' : 'WETH'
          return sum + toUsd(asset, BigInt(fee))
        }, 0)
        const valueUsd = rows.reduce((sum, r) => sum + r.usd, 0)
        return {
          maker: sh.maker,
          hash: sh.hash,
          keeper: sh.strategy.keeper,
          taker: sh.strategy.taker,
          flashFeeBps: sh.strategy.flashFeeBps,
          mm: {
            spreadBps: sh.strategy.mm.spreadBps,
            targetStableBps: sh.strategy.mm.targetStableBps,
            bandBps: sh.strategy.mm.bandBps,
          },
          positions: rows.filter((r) => r.shares > 0n || r.budget > 0n),
          valueUsd: round2(valueUsd),
          earned: {
            jitFeesUsd: round2(jitFeesUsd),
            spreadUsd: round2(income.spreadUsd),
            totalUsd: round2(jitFeesUsd + income.spreadUsd),
          },
          counts: { flashes: income.flashes, swaps: income.swaps, rebalances: income.rebalances },
          lastRebalanceBlock: income.lastRebalance ?? null,
          usdcShare: valueUsd > 0 ? round2((rows.filter((r) => r.asset === 'USDC').reduce((a, r) => a + r.usd, 0) / valueUsd) * 100) : null,
        }
      }),
    )
    const sum = (f: (x: (typeof strategies)[number]) => number) => round2(strategies.reduce((a, x) => a + f(x), 0))
    const keeperKey = ctx.cfg.keys.keeper
    return {
      app: d.aquaYieldApp,
      resolver: d.walletResolver,
      aqua: d.aqua,
      /** Parameters a new wallet strategy should use (what the keeper / resolver bots expect). */
      defaults: {
        keeper: process.env.KEEPER_ADDRESS ?? (keeperKey ? privateKeyToAccount(keeperKey).address : null),
        taker: d.walletResolver,
        flashFeeBps: d.flashFeeBps,
        oracle: d.oracle,
        maxPriceAge: d.mock ? 365 * 24 * 3600 : 3600,
        spreadBps: d.spreadBps,
        skewBps: d.skewBps,
        maxTradeBps: d.maxTradeBps,
        bandBps: 500,
        profiles: [7_000, 5_000, 3_000],
      },
      markets,
      strategies,
      totals: {
        wallets: strategies.length,
        valueUsd: sum((x) => x.valueUsd ?? 0),
        earnedUsd: sum((x) => x.earned.totalUsd ?? 0),
        jitFeesUsd: sum((x) => x.earned.jitFeesUsd ?? 0),
        spreadUsd: sum((x) => x.earned.spreadUsd ?? 0),
        rebalances: strategies.reduce((a, x) => a + x.counts.rebalances, 0),
      },
    }
  }

  private foldCarryEvents(logs: any[]) {
    const c = (this.state.carry ??= { counts: {}, harvestedWeth: '0', events: [] })
    const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2)
    const pct = (v: bigint) => (Number(v) / 100).toFixed(1)
    const evs = parseEventLogs({
      abi: carryVaultAbi,
      logs,
      eventName: ['Opened', 'Closed', 'Rotated', 'Deleveraged', 'Harvested', 'ShortfallRepaid'],
    })
    for (const ev of evs as any[]) {
      const a = ev.args
      const detail: Record<string, string> =
        ev.eventName === 'Opened' ? { sink: a.sink, borrowedUsd: usd(a.borrowed), ltvPct: pct(a.ltvBps) }
        : ev.eventName === 'Closed' ? { sink: a.sink, repaidUsd: usd(a.repaid), receivedUsd: usd(a.received), ltvPct: pct(a.ltvBps) }
        : ev.eventName === 'Rotated' ? { from: a.from, to: a.to, usd: usd(a.assets) }
        : ev.eventName === 'Deleveraged' ? { repaidUsd: usd(a.repaid), ltvPct: pct(a.ltvBps) }
        : ev.eventName === 'Harvested' ? { stableInUsd: usd(a.stableIn), wethOut: (Number(a.assetOut) / 1e18).toFixed(5) }
        : { wethIn: (Number(a.assetIn) / 1e18).toFixed(5), repaidUsd: usd(a.repaid) }
      if (ev.eventName === 'Harvested') c.harvestedWeth = (BigInt(c.harvestedWeth) + a.assetOut).toString()
      c.counts[ev.eventName] = (c.counts[ev.eventName] ?? 0) + 1
      c.events.push({ block: String(ev.blockNumber), tx: ev.transactionHash, kind: ev.eventName, detail })
    }
    if (c.events.length > 30) c.events.splice(0, c.events.length - 30)
  }

  /** Conditional carry: position, live spread, the keeper's last decision and activity. */
  private async carry(ethPrice: number) {
    const { ctx } = this
    if (!carryEnabled(ctx)) return null
    const { d } = ctx
    const [s, apr] = await Promise.all([readCarry(ctx), borrowApr(ctx).catch(() => null)])
    const reward = (a: Address) => (ctx.cfg.carry.sinkRewardApr[a] ?? ctx.cfg.carry.sinkRewardApr[a.toLowerCase()] ?? 0) * ctx.cfg.carry.rewardHaircut
    const sinks = s.sinks.map((x) => {
      const apy = this.apy(`c:${x.address}`)
      const net = apy === null ? null : round2(apy + reward(x.address))
      return {
        address: x.address,
        name: x.symbol,
        valueUsd: round2(Number(x.value) / 1e6),
        capUsd: round2(Number(x.cap) / 1e6),
        apy,
        rewardApr: reward(x.address),
        netApy: net,
        spreadPct: net === null || apr === null ? null : round2(net - apr),
      }
    })
    const collateralWeth = Number(s.collateral) / 1e18
    const debtUsd = Number(s.debt) / 1e6
    const stableUsd = Number(s.stableHeld) / 1e6
    const c = this.state.carry ?? { counts: {}, harvestedWeth: '0', events: [] }
    const decision = lastDecision(ctx)
    return {
      vault: d.carryVault,
      creditMarket: d.creditMarket && d.creditMarket !== ZERO ? d.creditMarket : null,
      status: s.debt > 0n ? 'on' : 'off',
      collateralWeth: Math.round(collateralWeth * 1e5) / 1e5,
      collateralUsd: round2(collateralWeth * ethPrice),
      debtUsd: round2(debtUsd),
      stableUsd: round2(stableUsd),
      carryPnlUsd: round2(stableUsd - debtUsd),
      tvlWeth: Math.round((Number(s.totalAssets) / 1e18) * 1e5) / 1e5,
      tvlUsd: round2((Number(s.totalAssets) / 1e18) * ethPrice),
      ltvPct: s.ltvBps / 100,
      maxLtvPct: s.maxLtvBps / 100,
      deleverageLtvPct: s.deleverageLtvBps / 100,
      targetLtvPct: ctx.cfg.carry.targetLtvBps / 100,
      healthFactor: s.healthFactor > 10n ** 30n ? null : round2(Number(s.healthFactor) / 1e18),
      borrowApr: apr === null ? null : round2(apr),
      vaultApy: this.apy('c:vault'),
      rules: {
        enterSpreadPct: ctx.cfg.carry.enterSpreadPct,
        exitSpreadPct: ctx.cfg.carry.exitSpreadPct,
        exitConfirmations: ctx.cfg.carry.exitConfirmations,
        horizonHours: ctx.cfg.carry.horizonHours,
        costMultiple: ctx.cfg.carry.costMultiple,
        maxSinkSharePct: ctx.cfg.carry.maxSinkShareBps / 100,
      },
      sinks,
      decision,
      counts: c.counts,
      harvestedWeth: Math.round((Number(c.harvestedWeth) / 1e18) * 1e6) / 1e6,
      events: [...c.events].reverse().slice(0, 12),
    }
  }

  private apy(key: string): number | null {
    const samples: RateSample[] = (this.state.samples[key] ?? []).map((s) => ({ t: s.t, index: BigInt(s.index) }))
    const v = apyOverWindow(samples, this.ctx.cfg.keeper.apyWindowSec)
    return v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100
  }

  async get(): Promise<unknown> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value
    const value = await this.build()
    this.cache = { at: Date.now(), value }
    return value
  }

  private async build() {
    const { ctx } = this
    const { d, client } = ctx
    const markets = await this.marketList()
    const block = await client.getBlock()
    const oracle = await ethUsd(ctx)

    // ─── Strategy A ──────────────────────────────────────────────────────
    const read = <T>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
      client.readContract({ address, abi, functionName, args } as any) as Promise<T>
    const [tvl, idle, reserveBps, supply, sharePrice, positions] = await Promise.all([
      read<bigint>(d.vault, yieldVaultAbi, 'totalAssets'),
      read<bigint>(d.vault, yieldVaultAbi, 'idleAssets'),
      read<number>(d.vault, yieldVaultAbi, 'reserveBps'),
      read<bigint>(d.vault, yieldVaultAbi, 'totalSupply'),
      read<bigint>(d.vault, yieldVaultAbi, 'convertToAssets', [10n ** 12n]),
      read<readonly [readonly Address[], readonly bigint[]]>(d.vault, yieldVaultAbi, 'positions'),
    ])
    const [adapters, assets] = positions
    const now = Number(block.timestamp)
    const perfNow = await this.perfNow(now)
    const aMarkets = adapters.map((a, i) => ({ lentValue: Number(assets[i]) / 1e6, apy: this.apy(getAddress(a)) }))
    const strategyA = {
      performance: this.performance('A', perfNow.A, lendingApy(aMarkets, Number(tvl) / 1e6), false),
      vault: d.vault,
      tvl,
      idle,
      reserveBps,
      totalSupply: supply,
      sharePrice, // USDC units per 1 whole ysUSDC (12 decimals)
      flashFeeBps: d.flashFeeBps,
      jitFees: BigInt(this.state.jitFees),
      jitFills: this.state.jitFills,
      markets: adapters.map((a, i) => {
        const m = markets.find((x) => x.key === getAddress(a))
        return { adapter: a, name: m?.name ?? a.slice(0, 10), assets: assets[i], apy: this.apy(getAddress(a)) }
      }),
    }

    // ─── Strategy B ──────────────────────────────────────────────────────
    const aaveUsdc = markets.find((m) => m.name === 'aave')
    const vaults = await Promise.all(
      (d.inventoryVaults ?? []).map(async (v) => {
        const strategy = {
          maker: v,
          taker: d.resolver,
          spreadBps: d.spreadBps,
          skewBps: d.skewBps,
          maxTradeBps: d.maxTradeBps,
          salt: zeroHash,
        }
        const [name, symbol, holdings, value, ratio, profile, supplyB, prices, idleS, idleV] = await Promise.all([
          read<string>(v, inventoryVaultAbi, 'name'),
          read<string>(v, erc20Abi, 'symbol'),
          read<readonly [bigint, bigint]>(v, inventoryVaultAbi, 'holdings'),
          read<bigint>(v, inventoryVaultAbi, 'totalValue'),
          read<bigint>(v, inventoryVaultAbi, 'stableRatioBps'),
          read<readonly [number, number]>(v, inventoryVaultAbi, 'profile'),
          read<bigint>(v, inventoryVaultAbi, 'totalSupply'),
          read<readonly [bigint, bigint, bigint]>(d.swapApp, oracleSwapAppAbi, 'prices', [strategy]).catch(() => null),
          read<bigint>(d.usdc, erc20Abi, 'balanceOf', [v]),
          read<bigint>(d.weth, erc20Abi, 'balanceOf', [v]),
        ])
        const spread = this.state.spread[getAddress(v)] ?? { income: '0', swaps: 0 }
        const usdcApy = aaveUsdc ? this.apy(aaveUsdc.key) : null
        const wethApy = this.apy('aaveWeth')
        const lent = lendingApy(
          [
            { lentValue: Number(holdings[0] - idleS) / 1e6, apy: usdcApy },
            { lentValue: (Number(holdings[1] - idleV) / 1e18) * oracle.price, apy: wethApy },
          ],
          Number(value) / 1e6,
        )
        const perf = perfNow[getAddress(v)]
        // Where each asset sits: lent through the vault's adapter for that token, or idle in the vault for fills.
        const allocation = await Promise.all(
          ([
            ['USDC', d.usdc, holdings[0], idleS, usdcApy],
            ['WETH', d.weth, holdings[1], idleV, wethApy],
          ] as const).map(async ([asset, token, total, idle, apy]) => {
            const adapter = await read<Address>(v, inventoryVaultAbi, 'adapterOf', [token])
            if (adapter === ZERO) return { asset, adapter: null, market: null, total, lent: 0n, idle, apy: null }
            const name = (await this.adapterName(adapter)) ?? ''
            // Rate of the market this adapter actually uses (Aave WETH has its own series; others share A's).
            const rate = name === 'aave' ? apy : this.apy(markets.find((m) => m.name === name)?.key ?? '')
            return { asset, adapter, market: MARKET_NAMES[name] ?? 'Lending', total, lent: total - idle, idle, apy: rate }
          }),
        )
        return {
          allocation,
          performance: perf ? this.performance(getAddress(v), perf, lent, true) : null,
          address: v,
          name,
          symbol,
          targetStableBps: profile[0],
          bandBps: profile[1],
          stable: holdings[0],
          volatile: holdings[1],
          idleStable: idleS,
          idleVolatile: idleV,
          value,
          totalSupply: supplyB,
          stableRatioBps: Number(ratio),
          bid: prices?.[0] ?? null, // USDC units per WETH, 1e18-scaled
          ask: prices?.[1] ?? null,
          skewBps: prices ? Number(prices[2]) : null,
          spreadIncome: BigInt(spread.income),
          swaps: spread.swaps,
        }
      }),
    )

    return {
      chainId: ctx.chain.id,
      mock: d.mock,
      block: block.number,
      timestamp: Number(block.timestamp),
      explorer: ctx.explorer,
      contracts: {
        usdc: d.usdc,
        weth: d.weth,
        vault: d.vault,
        inventoryVaults: d.inventoryVaults,
        resolver: d.resolver,
        limitOrderProtocol: d.limitOrderProtocol,
        fusionSettlement: d.fusionSettlement,
        oracle: d.oracle,
      },
      oracle: { price: oracle.price, updatedAt: oracle.updatedAt },
      strategyA,
      selfCustody: await this.selfCustody(oracle.price),
      carry: await this.carry(oracle.price),
      strategyB: {
        performance: aggregate(vaults),
        spreadBps: d.spreadBps,
        skewBps: d.skewBps,
        maxTradeBps: d.maxTradeBps,
        lendingApy: { usdc: aaveUsdc ? this.apy(aaveUsdc.key) : null, weth: this.apy('aaveWeth') },
        vaults,
      },
    }
  }
}

/** Value-weighted average of the per-profile metrics. */
function aggregate(vaults: { value: bigint; performance: Record<string, any> | null }[]) {
  const total = vaults.reduce((sum, v) => sum + Number(v.value), 0)
  const avg = (key: string) => {
    if (total <= 0 || vaults.some((v) => v.performance?.[key] == null)) return null
    return round2(vaults.reduce((sum, v) => sum + (Number(v.value) / total) * v.performance![key], 0))
  }
  return { netApy: avg('netApy'), lendingApy: avg('lendingApy'), spreadApy: avg('spreadApy'), vsHodlPct: avg('vsHodlPct') }
}

export function logSnapshotError(err: unknown) {
  log.warn('snapshot failed', { error: err instanceof Error ? err.message : String(err) })
}
