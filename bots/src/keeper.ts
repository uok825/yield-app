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
import { describeAdapter, erc4626Rate, walletMarketName, type MarketInfo, type RateSource } from './markets.ts'
import { StrategyRegistry, positions, selfCustodyEnabled } from './wallets.ts'
import { aquaYieldAppAbi } from './abis.ts'
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
  const registry = new StrategyRegistry(ctx)
  const walletRates = new Map<Address, RateSource>()
  const lastWalletMove = new Map<string, number>()
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
    if (selfCustodyEnabled(ctx)) {
      try {
        await tickWallets(ctx, registry, book, walletRates, lastWalletMove, now)
      } catch (err) {
        log.error('self-custody tick failed', { error: revertReason(err) })
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

/**
 * Self-custody: for every active AquaYieldApp strategy that names this keeper, move each side's shares into the
 * best listed market (apy × trust) when the gain clears KEEPER_WALLET_MIN_GAIN_PCT. Shares never leave the wallet
 * except inside the rebalance transaction.
 */
async function tickWallets(
  ctx: Context,
  registry: StrategyRegistry,
  book: RateBook,
  rates: Map<Address, RateSource>,
  lastMove: Map<string, number>,
  now: number,
) {
  const { cfg, client, d } = ctx
  await registry.sync()
  const keeper = ctx.wallet('keeper')
  const all = [...(d.walletStableMarkets ?? []), ...(d.walletVolatileMarkets ?? [])]
  const apy = new Map<Address, number | undefined>()
  for (const m of all) {
    if (!rates.has(m)) rates.set(m, await erc4626Rate(ctx, m))
    book.add(`w:${m}`, { t: now, index: await rates.get(m)!() }, cfg.keeper.apyWindowSec * 3)
    apy.set(m, apyOverWindow(book.get(`w:${m}`), cfg.keeper.apyWindowSec))
  }
  const score = (m: Address) => (apy.get(m) ?? -Infinity) * (cfg.keeper.trustScores[walletMarketName(ctx, m)] ?? 90) / 100

  const mine = registry.active().filter((s) => s.strategy.keeper.toLowerCase() === keeper.account.address.toLowerCase())
  log.info('self-custody', {
    strategies: mine.length,
    apys: all.map((m) => `${walletMarketName(ctx, m)}:${apy.get(m)?.toFixed(2) ?? '…'}%`).join(' '),
  })

  for (const sh of mine) {
    const pos = await positions(ctx, sh)
    for (const side of ['stable', 'volatile'] as const) {
      const listed = side === 'stable' ? sh.strategy.stableMarkets : sh.strategy.volatileMarkets
      if (listed.length < 2 || listed.some((m) => apy.get(m) === undefined)) continue
      const key = `${sh.hash}:${side}`
      if (now - (lastMove.get(key) ?? 0) < cfg.keeper.walletCooldownSec) continue
      const best = [...listed].sort((a, b) => score(b) - score(a))[0]
      for (const p of pos.filter((x) => x.side === side && x.market !== best && x.usable > 0n)) {
        const gain = (apy.get(best) ?? 0) - (apy.get(p.market) ?? 0)
        if (gain < cfg.keeper.walletMinGainPct) continue
        const [assets, liquidity] = await Promise.all([
          client.readContract({ address: p.market, abi: mockLendingVaultAbiLite, functionName: 'convertToAssets', args: [p.usable] }),
          client.readContract({ address: p.market, abi: mockLendingVaultAbiLite, functionName: 'maxRedeem', args: [sh.maker] }),
        ])
        const minMove = side === 'stable' ? 10n * 10n ** 6n : 3n * 10n ** 15n // $10 / 0.003 ETH
        const shares = p.usable < liquidity ? p.usable : liquidity
        if (assets < minMove || shares === 0n) continue
        await write(ctx, keeper, {
          address: d.aquaYieldApp!,
          abi: aquaYieldAppAbi,
          functionName: 'rebalance',
          args: [sh.strategy as any, p.market, best, shares],
        })
        count('keeper', 'W.rebalance')
        lastMove.set(key, now)
        log.info('self-custody rebalanced', {
          maker: sh.maker.slice(0, 8),
          from: walletMarketName(ctx, p.market),
          to: walletMarketName(ctx, best),
          gainPct: gain.toFixed(2),
        })
      }
    }
  }
}

const mockLendingVaultAbiLite = [
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxRedeem', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const
