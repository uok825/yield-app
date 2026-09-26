/**
 * Keeper bot.
 *
 * Strategy A (YieldVault): samples each market's supply index (ERC-4626 share price / Aave normalized income),
 * derives APY over a rolling window, and moves capital toward apy × trust weights (reallocate / allocate /
 * deallocate). The withdraw queue is kept lowest-APY-first so JIT unwinds preserve the best yield.
 *
 * Strategy B (InventoryVault ×3): keeps an idle buffer of each asset for fills and lends the rest on Aave; when a
 * profile drifts out of its band (price moves), swaps back to target through the whitelisted router with an
 * oracle-based minimum output.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, encodeFunctionData, formatUnits } from 'viem'

import {
  inventoryVaultAbi,
  mockSwapRouterAbi,
  yieldAdapterAbi,
  yieldVaultAbi,
} from './abis.ts'
import { describeAdapter, type MarketInfo } from './markets.ts'
import { apyOverWindow, inventoryRebalance, planAllocation, queueNeedsReorder, type RateSample } from './allocation.ts'
import { type Context, erc20Abi, revertReason, write } from './chain.ts'
import { logger } from './log.ts'
import { count, runEvery } from './loop.ts'

const log = logger('keeper')
const ZERO = '0x0000000000000000000000000000000000000000'

class RateBook {
  private samples: Record<string, RateSample[]> = {}
  constructor(private file: string) {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { t: number; index: string }[]>
      for (const [k, v] of Object.entries(raw)) this.samples[k] = v.map((s) => ({ t: s.t, index: BigInt(s.index) }))
    }
  }
  add(key: string, sample: RateSample, keepSec: number) {
    const list = (this.samples[key] ??= [])
    list.push(sample)
    while (list.length > 2 && sample.t - list[1].t >= keepSec) list.shift()
  }
  get(key: string) {
    return this.samples[key] ?? []
  }
  save() {
    const out: Record<string, { t: number; index: string }[]> = {}
    for (const [k, v] of Object.entries(this.samples)) out[k] = v.map((s) => ({ t: s.t, index: s.index.toString() }))
    writeFileSync(this.file, JSON.stringify(out))
  }
}

export async function startKeeper(ctx: Context, signal: AbortSignal) {
  const { cfg } = ctx
  mkdirSync(cfg.stateDir, { recursive: true })
  const book = new RateBook(join(cfg.stateDir, `keeper-rates-${ctx.chain.id}.json`))
  const markets = new Map<Address, MarketInfo>()
  log.info('starting', { vault: ctx.d.vault, inventories: ctx.d.inventoryVaults.length, intervalMs: cfg.keeper.intervalMs })

  await runEvery('keeper', cfg.keeper.intervalMs, signal, async () => {
    const now = Number((await ctx.client.getBlock()).timestamp)
    if (ctx.d.vault && ctx.d.vault !== ZERO) {
      try {
        await tickYieldVault(ctx, book, markets, now)
      } catch (err) {
        log.error('strategy A tick failed', { error: revertReason(err) })
      }
    }
    for (const vault of ctx.d.inventoryVaults ?? []) {
      try {
        await tickInventory(ctx, vault)
      } catch (err) {
        log.error('strategy B tick failed', { vault, error: revertReason(err) })
      }
    }
    book.save()
  })
}

async function tickYieldVault(ctx: Context, book: RateBook, cache: Map<Address, MarketInfo>, now: number) {
  const { client, cfg, d } = ctx
  const keeper = ctx.wallet('keeper')
  const vault = d.vault

  const [adapters, assets] = await client.readContract({ address: vault, abi: yieldVaultAbi, functionName: 'positions' })
  const [total, idle, reserveBps] = await Promise.all([
    client.readContract({ address: vault, abi: yieldVaultAbi, functionName: 'totalAssets' }),
    client.readContract({ address: vault, abi: yieldVaultAbi, functionName: 'idleAssets' }),
    client.readContract({ address: vault, abi: yieldVaultAbi, functionName: 'reserveBps' }),
  ])

  const states: { apy: number | undefined; trust: number; current: bigint; maxWithdraw: bigint; name: string }[] = []
  for (let i = 0; i < adapters.length; i++) {
    const a = adapters[i]
    let info = cache.get(a)
    if (!info) cache.set(a, (info = await describeAdapter(ctx, a)))
    book.add(a, { t: now, index: await info.rate() }, cfg.keeper.apyWindowSec * 3)
    const apy = apyOverWindow(book.get(a), cfg.keeper.apyWindowSec)
    const maxWithdraw = await client.readContract({ address: a, abi: yieldAdapterAbi, functionName: 'maxWithdraw' })
    states.push({ apy, trust: cfg.keeper.trustScores[info.name] ?? 90, current: assets[i], maxWithdraw, name: info.name })
  }
  if (total === 0n) return

  const plan = planAllocation(total, idle, Number(reserveBps), states, cfg.keeper.rebalanceThresholdBps)
  log.info('strategy A', {
    tvl: formatUnits(total, 6),
    idle: formatUnits(idle, 6),
    apys: states.map((s) => `${s.name}:${s.apy === undefined ? '…' : s.apy.toFixed(2)}%`).join(' '),
    moves: plan.moves.length,
  })

  for (const m of plan.moves) {
    if (m.kind === 'reallocate') {
      await write(ctx, keeper, { address: vault, abi: yieldVaultAbi, functionName: 'reallocate', args: [BigInt(m.from), BigInt(m.to), m.amount] })
    } else if (m.kind === 'allocate') {
      await write(ctx, keeper, { address: vault, abi: yieldVaultAbi, functionName: 'allocate', args: [BigInt(m.to), m.amount] })
    } else {
      await write(ctx, keeper, { address: vault, abi: yieldVaultAbi, functionName: 'deallocate', args: [BigInt(m.from), m.amount] })
    }
    count('keeper', `A.${m.kind}`)
    log.info(`A ${m.kind}`, { ...m, amount: formatUnits(m.amount, 6) })
  }

  if (queueNeedsReorder(states.map((s) => s.apy), cfg.keeper.queueHysteresisPct)) {
    await write(ctx, keeper, {
      address: vault,
      abi: yieldVaultAbi,
      functionName: 'setWithdrawQueue',
      args: [plan.queue.map(BigInt)],
    })
    count('keeper', 'A.queue')
    log.info('A withdraw queue reordered', { queue: plan.queue.map((i) => states[i].name).join(' → ') })
  }
}

async function tickInventory(ctx: Context, vault: Address) {
  const { client, cfg, d } = ctx
  const keeper = ctx.wallet('keeper')
  const read = <T>(functionName: any, args: readonly unknown[] = []) =>
    client.readContract({ address: vault, abi: inventoryVaultAbi, functionName, args } as any) as Promise<T>

  const symbol = await client.readContract({ address: vault, abi: erc20Abi, functionName: 'symbol' })
  let price: bigint
  try {
    price = await read<bigint>('price')
  } catch (err) {
    log.warn(`${symbol}: oracle unusable, skipping`, { error: revertReason(err) })
    return
  }

  // 1. Idle buffers: keep `idleBufferBps` of each asset liquid for fills, lend the rest.
  const [stable, volatile] = [d.usdc, d.weth]
  const [held] = await Promise.all([read<readonly [bigint, bigint]>('holdings')])
  for (const [token, total] of [
    [stable, held[0]],
    [volatile, held[1]],
  ] as const) {
    const adapter = await read<Address>('adapterOf', [token])
    if (adapter === ZERO) continue
    const idle = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })
    const target = (total * BigInt(cfg.keeper.idleBufferBps)) / 10_000n
    if (idle > (target * 3n) / 2n && idle - target > 0n) {
      await write(ctx, keeper, { address: vault, abi: inventoryVaultAbi, functionName: 'allocate', args: [token, idle - target] })
      count('keeper', 'B.allocate')
      log.info(`${symbol}: lent idle`, { token: token === stable ? 'USDC' : 'WETH', amount: (idle - target).toString() })
    } else if (idle < target / 2n) {
      const lendable = await client.readContract({ address: adapter, abi: yieldAdapterAbi, functionName: 'maxWithdraw' })
      const need = target - idle < lendable ? target - idle : lendable
      if (need > 0n) {
        await write(ctx, keeper, { address: vault, abi: inventoryVaultAbi, functionName: 'deallocate', args: [token, need] })
        count('keeper', 'B.deallocate')
        log.info(`${symbol}: refilled idle buffer`, { token: token === stable ? 'USDC' : 'WETH', amount: need.toString() })
      }
    }
  }

  // 2. Band: swap back to target if the ratio left the band.
  const [ratio, profile] = await Promise.all([read<bigint>('stableRatioBps'), read<readonly [number, number]>('profile')])
  const [target, band] = profile
  const dev = Math.abs(Number(ratio) - target)
  if (dev <= band) return
  if (!d.router || d.router === ZERO) {
    log.warn(`${symbol}: out of band but no router configured for rebalancing`, { ratio: Number(ratio), target })
    return
  }

  const volValue = await read<bigint>('volatileValue', [held[1], price])
  const { sellStable, value } = inventoryRebalance(held[0], volValue, target)
  const wethDecimals = 18n
  const tokenIn = sellStable ? stable : volatile
  const tokenOut = sellStable ? volatile : stable
  // Oracle-implied output, minus the allowed slippage.
  const amountIn = sellStable ? value : (value * 10n ** wethDecimals * 10n ** 18n) / price
  const fairOut = sellStable ? (value * 10n ** wethDecimals * 10n ** 18n) / price : value
  const minOut = (fairOut * BigInt(10_000 - cfg.keeper.maxSwapSlippageBps)) / 10_000n
  const data = encodeFunctionData({
    abi: mockSwapRouterAbi,
    functionName: 'swap',
    args: [tokenIn, tokenOut, amountIn, minOut, vault],
  })
  await write(ctx, keeper, {
    address: vault,
    abi: inventoryVaultAbi,
    functionName: 'rebalance',
    args: [d.router, data, tokenIn, amountIn, minOut],
  })
  count('keeper', 'B.rebalance')
  log.info(`${symbol}: rebalanced to target`, { from: `${Number(ratio) / 100}%`, target: `${target / 100}%` })
}
