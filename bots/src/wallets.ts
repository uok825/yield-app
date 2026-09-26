/**
 * Self-custody strategies: wallets that shipped an AquaYieldApp strategy through Aqua. Discovered from Aqua's
 * `Shipped` / `Docked` events (the full strategy is in the event), persisted, and shared by keeper, resolver and
 * snapshot.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters, getAddress, parseEventLogs } from 'viem'

import { aquaAbi, aquaYieldAppAbi } from './abis.ts'
import { type Context, erc20Abi } from './chain.ts'
import { logger } from './log.ts'

const log = logger('wallets')
const ZERO = '0x0000000000000000000000000000000000000000'

const strategyInputs = (aquaYieldAppAbi as readonly any[]).find((f) => f.type === 'function' && f.name === 'strategyHash')
  .inputs

export interface WalletStrategy {
  maker: Address
  stable: Address
  volatileAsset: Address
  stableMarkets: readonly Address[]
  volatileMarkets: readonly Address[]
  keeper: Address
  taker: Address
  flashFeeBps: number
  mm: {
    oracle: Address
    maxPriceAge: number
    spreadBps: number
    skewBps: number
    maxTradeBps: number
    targetStableBps: number
    bandBps: number
  }
  salt: Hex
}

export interface Shipped {
  hash: Hex
  maker: Address
  strategy: WalletStrategy
  docked: boolean
  block: string
}

export function selfCustodyEnabled(ctx: Context): boolean {
  return !!ctx.d.aquaYieldApp && ctx.d.aquaYieldApp !== ZERO
}

export function encodeStrategy(s: WalletStrategy): Hex {
  return encodeAbiParameters(strategyInputs, [s])
}

export function decodeStrategy(bytes: Hex): WalletStrategy {
  const [s] = decodeAbiParameters(strategyInputs, bytes) as unknown as [WalletStrategy]
  return {
    ...s,
    maker: getAddress(s.maker),
    stableMarkets: s.stableMarkets.map((a) => getAddress(a)),
    volatileMarkets: s.volatileMarkets.map((a) => getAddress(a)),
  }
}

export class StrategyRegistry {
  private state: { lastBlock: string; strategies: Record<Hex, Shipped> }

  constructor(
    private ctx: Context,
    private file = join(ctx.cfg.stateDir, `strategies-${ctx.chain.id}.json`),
  ) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { lastBlock: '0', strategies: {} }
  }

  active(): Shipped[] {
    return Object.values(this.state.strategies).filter((s) => !s.docked)
  }

  all(): Shipped[] {
    return Object.values(this.state.strategies)
  }

  async sync(): Promise<void> {
    const { ctx } = this
    if (!selfCustodyEnabled(ctx)) return
    const app = getAddress(ctx.d.aquaYieldApp!)
    const head = await ctx.client.getBlockNumber()
    let from = BigInt(this.state.lastBlock) + 1n
    if (from === 1n) from = BigInt(ctx.d.deployBlock || Number(head))
    while (from <= head) {
      const to = from + ctx.cfg.logBlockRange - 1n < head ? from + ctx.cfg.logBlockRange - 1n : head
      const logs = await ctx.client.getLogs({ address: ctx.d.aqua, fromBlock: from, toBlock: to })
      for (const ev of parseEventLogs({ abi: aquaAbi, logs, eventName: ['Shipped', 'Docked'] })) {
        if (getAddress(ev.args.app) !== app) continue
        const hash = ev.args.strategyHash
        if (ev.eventName === 'Shipped') {
          try {
            const strategy = decodeStrategy((ev.args as any).strategy)
            this.state.strategies[hash] = { hash, maker: getAddress(ev.args.maker), strategy, docked: false, block: String(ev.blockNumber) }
            log.info('strategy shipped', { maker: ev.args.maker, hash: hash.slice(0, 10) })
          } catch (err) {
            log.warn('undecodable strategy', { hash, error: (err as Error).message })
          }
        } else if (this.state.strategies[hash]) {
          this.state.strategies[hash].docked = true
          log.info('strategy docked', { maker: ev.args.maker, hash: hash.slice(0, 10) })
        }
      }
      this.state.lastBlock = to.toString()
      from = to + 1n
    }
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
    renameSync(this.file + '.tmp', this.file)
  }
}

/** Committed budget (Aqua) vs what the wallet can actually deliver (balance and Aqua allowance), per market. */
export async function positions(ctx: Context, sh: Shipped) {
  const markets = [...sh.strategy.stableMarkets, ...sh.strategy.volatileMarkets]
  return Promise.all(
    markets.map(async (market) => {
      const [[budget], balance, allowance] = await Promise.all([
        ctx.client.readContract({
          address: ctx.d.aqua,
          abi: aquaAbi,
          functionName: 'rawBalances',
          args: [sh.maker, ctx.d.aquaYieldApp!, sh.hash, market],
        }),
        ctx.client.readContract({ address: market, abi: erc20Abi, functionName: 'balanceOf', args: [sh.maker] }),
        ctx.client.readContract({ address: market, abi: erc20Abi, functionName: 'allowance', args: [sh.maker, ctx.d.aqua] }),
      ])
      const usable = [budget, balance, allowance].reduce((a, b) => (a < b ? a : b))
      return {
        market,
        side: sh.strategy.stableMarkets.includes(market) ? ('stable' as const) : ('volatile' as const),
        budget: BigInt(budget),
        balance,
        allowance,
        usable,
      }
    }),
  )
}
