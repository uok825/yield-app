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
import { inventoryVaultAbi, oracleSwapAppAbi, yieldVaultAbi } from './abis.ts'
import { apyOverWindow, type RateSample } from './allocation.ts'
import { aaveIndex, describeAdapter, type MarketInfo } from './markets.ts'
import { ethUsd } from './prices.ts'
import { logger } from './log.ts'

const log = logger('snapshot')
const ZERO = '0x0000000000000000000000000000000000000000'
const TTL_MS = Number(process.env.SNAPSHOT_TTL_MS ?? 5_000)
const SAMPLE_EVERY_SEC = 30

interface Persisted {
  lastBlock: string
  jitFees: string
  jitFills: number
  spread: Record<string, { income: string; swaps: number }>
  samples: Record<string, { t: number; index: string }[]>
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
    const vaults = [d.vault, ...(d.inventoryVaults ?? [])].filter((a) => a && a !== ZERO)
    while (from <= head) {
      const to = from + ctx.cfg.logBlockRange - 1n < head ? from + ctx.cfg.logBlockRange - 1n : head
      const logs = await client.getLogs({ address: vaults, fromBlock: from, toBlock: to })
      for (const ev of parseEventLogs({ abi: yieldVaultAbi, logs, eventName: 'LiquiditySettled' })) {
        this.state.jitFees = (BigInt(this.state.jitFees) + ev.args.fee).toString()
        this.state.jitFills++
      }
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
    if (t - this.lastSampleT >= SAMPLE_EVERY_SEC) {
      this.lastSampleT = t
      const keep = ctx.cfg.keeper.apyWindowSec * 3
      for (const m of await this.marketList()) {
        const list = (this.state.samples[m.key] ??= [])
        list.push({ t, index: (await m.rate()).toString() })
        while (list.length > 2 && t - list[1].t >= keep) list.shift()
      }
    }
    this.save()
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
    const strategyA = {
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
        return {
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
      strategyB: {
        spreadBps: d.spreadBps,
        skewBps: d.skewBps,
        maxTradeBps: d.maxTradeBps,
        lendingApy: { usdc: aaveUsdc ? this.apy(aaveUsdc.key) : null, weth: this.apy('aaveWeth') },
        vaults,
      },
    }
  }
}

export function logSnapshotError(err: unknown) {
  log.warn('snapshot failed', { error: err instanceof Error ? err.message : String(err) })
}
