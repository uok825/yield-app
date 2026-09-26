/**
 * Fusion resolver bot. For every active order it prices both strategies against the current Dutch-auction amount,
 * simulates them on-chain through YieldResolver, and fills with the most profitable one once net profit clears the
 * configured floor.
 *
 *   B · Inventory: buy exactly `takingAmount` of the taker asset from the best InventoryVault profile
 *                  (OracleSwapApp.swapExactOut), fill the order inside the callback, pay the vault with the maker's
 *                  tokens.                                   → YieldResolver.executeSwap
 *   A · JIT:       borrow USDC from the YieldVault (JitLiquidityApp.flash), fill using a router leg, repay
 *                  principal + fee.                          → YieldResolver.execute
 *   Self-custody:  the same two ideas against liquidity that stays in users' wallets (AquaYieldApp strategies):
 *                  buy from a wallet's committed inventory (wallet-mm) or borrow JIT from it (wallet-jit).
 *                                                            → WalletResolver.executeSwap / executeFlash
 *
 * Route A needs a router the bot can quote exactly; on testnets that's MockSwapRouter. Without one (live mode) only
 * route B is used.
 */
import { type Address, type Hex, encodeFunctionData, formatUnits, zeroHash } from 'viem'
import { Address as OneInchAddress, type FusionOrder } from '@1inch/fusion-sdk'

import { aquaYieldAppAbi, mockSwapRouterAbi, oracleSwapAppAbi, walletResolverAbi, yieldResolverAbi } from './abis.ts'
import { StrategyRegistry, positions, selfCustodyEnabled, type Shipped } from './wallets.ts'
import { type Context, revertReason, write } from './chain.ts'
import { decodeOrder, fillCalldata, takingAmountAt } from './fusion.ts'
import { logger } from './log.ts'
import { count, runEvery } from './loop.ts'
import { decimals, ethUsd, usdValue } from './prices.ts'
import type { OrderRecord } from './relayer.ts'
import { relayerClient } from './relayer-client.ts'

const log = logger('resolver')
const MAX_ATTEMPTS = 3

type Call = { target: Address; value: bigint; data: Hex }

export interface Route {
  name: string
  profit: bigint
  profitToken: Address
  profitUsd: number
  gasUsd: number
  send: (minProfit: bigint) => Promise<Hex>
}

interface OrderContext {
  record: OrderRecord
  order: FusionOrder
  taking: bigint
  making: bigint
  fill: Call
}

export async function startResolver(ctx: Context, signal: AbortSignal) {
  const { cfg } = ctx
  const relayer = relayerClient(cfg.relayer.url)
  const operator = ctx.wallet('operator')
  const attempts = new Map<Hex, number>()
  const done = new Set<Hex>()
  const registry = selfCustodyEnabled(ctx) ? new StrategyRegistry(ctx) : undefined
  log.info('starting', { resolver: ctx.d.resolver, operator: operator.account.address, pollMs: cfg.resolver.pollMs })

  await runEvery('resolver', cfg.resolver.pollMs, signal, async () => {
    const orders = (await relayer.active()).filter((o) => !done.has(o.orderHash))
    if (orders.length === 0) return
    await registry?.sync()
    const block = await ctx.client.getBlock()
    const { price } = await ethUsd(ctx)

    for (const record of orders.sort((a, b) => a.auctionStart - b.auctionStart)) {
      if (signal.aborted) return
      try {
        const best = await bestRoute(ctx, record, block.timestamp, block.baseFeePerGas ?? 0n, price, registry?.active())
        if (!best) continue
        const notionalUsd = usdValue(ctx, record.makerAsset, BigInt(record.makingAmount), price, await decimals(ctx, record.makerAsset))
        const net = best.profitUsd - best.gasUsd
        const floor = Math.max(cfg.resolver.minProfitUsd, (notionalUsd * cfg.resolver.minMarginBps) / 10_000)
        if (net < floor) {
          log.debug('waiting for auction', { order: record.orderHash.slice(0, 10), route: best.name, net: net.toFixed(4), floor })
          continue
        }

        const minProfit = (best.profit * BigInt(10_000 - cfg.resolver.profitToleranceBps)) / 10_000n
        const tx = await best.send(minProfit)
        done.add(record.orderHash)
        count('resolver', `filled.${best.name.split(':')[0]}`)
        log.info('filled', {
          order: record.orderHash.slice(0, 10),
          route: best.name,
          profitUsd: best.profitUsd.toFixed(4),
          gasUsd: best.gasUsd.toFixed(4),
          tx: ctx.txUrl(tx),
        })
        await relayer
          .report(record.orderHash, { route: best.name, profit: best.profit.toString(), profitToken: best.profitToken, tx })
          .catch((err) => log.warn('report failed', { error: (err as Error).message }))
      } catch (err) {
        const n = (attempts.get(record.orderHash) ?? 0) + 1
        attempts.set(record.orderHash, n)
        count('resolver', 'errors')
        log.warn('fill attempt failed', { order: record.orderHash.slice(0, 10), attempt: n, error: revertReason(err) })
        if (n >= MAX_ATTEMPTS) {
          done.add(record.orderHash)
          log.error('giving up on order', { order: record.orderHash })
        }
      }
    }
  })
}

/** Prices every route for `record` at `time` and returns the most profitable one (net of gas), if any. */
export async function bestRoute(
  ctx: Context,
  record: OrderRecord,
  time: bigint,
  baseFee: bigint,
  ethPrice: number,
  wallets: Shipped[] = [],
): Promise<Route | undefined> {
  const order = decodeOrder(record)
  if (!order.canExecuteAt(new OneInchAddress(ctx.d.resolver), time)) return undefined
  if (order.isExpiredAt(time)) return undefined

  // Price at the latest block: the most the LOP can ask for until the auction decays further.
  const taking = takingAmountAt(order, ctx.d.resolver, time, baseFee)
  const oc: OrderContext = {
    record,
    order,
    taking,
    making: order.makingAmount,
    fill: { target: ctx.d.limitOrderProtocol, value: 0n, data: fillCalldata(order, record.signature, taking) },
  }

  const candidates = await Promise.all([
    ...inventoryRoutes(ctx, oc, ethPrice),
    jitRoute(ctx, oc, ethPrice),
    ...wallets.flatMap((sh) => walletRoutes(ctx, oc, ethPrice, sh)),
  ])
  const routes = candidates.filter((r): r is Route => !!r && r.profit > 0n)
  routes.sort((a, b) => b.profitUsd - b.gasUsd - (a.profitUsd - a.gasUsd))
  return routes[0]
}

/** Gas cost in USD for a simulated call. */
async function gasUsd(ctx: Context, gas: bigint, ethPrice: number): Promise<number> {
  const fees = await ctx.client.estimateFeesPerGas()
  const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n
  return Number(formatUnits(gas * perGas, 18)) * ethPrice
}

function inventoryStrategy(ctx: Context, maker: Address) {
  return {
    maker,
    taker: ctx.d.resolver,
    spreadBps: ctx.d.spreadBps,
    skewBps: ctx.d.skewBps,
    maxTradeBps: ctx.d.maxTradeBps,
    salt: zeroHash,
  } as const
}

function inventoryRoutes(ctx: Context, oc: OrderContext, ethPrice: number): Promise<Route | undefined>[] {
  const { d, client } = ctx
  const operator = ctx.wallet('operator')
  return d.inventoryVaults.map(async (vault, i) => {
    const strategy = inventoryStrategy(ctx, vault)
    const tokenOut = oc.record.takerAsset
    let cost: bigint
    try {
      cost = await client.readContract({
        address: d.swapApp,
        abi: oracleSwapAppAbi,
        functionName: 'quoteExactOut',
        args: [strategy, tokenOut, oc.taking],
      })
    } catch {
      return undefined // band / size / stale-oracle guard would reject
    }
    if (cost >= oc.making) return undefined

    const args = [strategy, tokenOut, oc.taking, cost, [oc.fill], 0n] as const
    try {
      const sim = await client.simulateContract({
        address: d.resolver,
        abi: yieldResolverAbi,
        functionName: 'executeSwap',
        args,
        account: operator.account,
      })
      const gas = await client.estimateContractGas({
        address: d.resolver,
        abi: yieldResolverAbi,
        functionName: 'executeSwap',
        args,
        account: operator.account,
      })
      const profitToken = oc.record.makerAsset
      const profit = sim.result
      return {
        name: `inventory:${i}`,
        profit,
        profitToken,
        profitUsd: usdValue(ctx, profitToken, profit, ethPrice, await decimals(ctx, profitToken)),
        gasUsd: await gasUsd(ctx, gas, ethPrice),
        send: async (minProfit: bigint) =>
          (
            await write(
              ctx,
              operator,
              {
                address: d.resolver,
                abi: yieldResolverAbi,
                functionName: 'executeSwap',
                args: [strategy, tokenOut, oc.taking, cost, [oc.fill], minProfit],
                gas: (gas * 13n) / 10n,
              },
              `executeSwap[inventory:${i}]`,
            )
          ).transactionHash,
      }
    } catch {
      return undefined
    }
  })
}

/**
 * Borrow amount and calls for a JIT fill via the router: the resolver (`recipient`) needs the taker asset before
 * the LOP pulls it, and must end with at least the borrowed USDC. Undefined if there is no router or pair.
 */
async function jitPlan(ctx: Context, oc: OrderContext, recipient: Address): Promise<{ borrow: bigint; calls: Call[] } | undefined> {
  const { d, client } = ctx
  const ZERO = '0x0000000000000000000000000000000000000000'
  if (!d.router || d.router === ZERO) return undefined
  const usdc = d.usdc.toLowerCase()
  const swap = (tokenIn: Address, tokenOut: Address, amountIn: bigint, minOut: bigint): Call => ({
    target: d.router,
    value: 0n,
    data: encodeFunctionData({
      abi: mockSwapRouterAbi,
      functionName: 'swap',
      args: [tokenIn, tokenOut, amountIn, minOut, recipient],
    }),
  })
  if (oc.record.takerAsset.toLowerCase() === usdc) {
    // User sells WETH for USDC: borrow the USDC to pay, then sell the received WETH on the router.
    const out = await client.readContract({
      address: d.router,
      abi: mockSwapRouterAbi,
      functionName: 'quote',
      args: [oc.record.makerAsset, d.usdc, oc.making],
    })
    return { borrow: oc.taking, calls: [oc.fill, swap(oc.record.makerAsset, d.usdc, oc.making, out)] }
  }
  if (oc.record.makerAsset.toLowerCase() === usdc) {
    // User sells USDC for WETH: borrow USDC, buy the WETH on the router, fill, repay with the user's USDC.
    const p = await client.readContract({
      address: d.router,
      abi: mockSwapRouterAbi,
      functionName: 'price',
      args: [d.usdc, oc.record.takerAsset],
    })
    if (p === 0n) return undefined
    const borrow = (oc.taking * 10n ** 18n + p - 1n) / p + 1n
    return { borrow, calls: [swap(d.usdc, oc.record.takerAsset, borrow, oc.taking), oc.fill] }
  }
  return undefined
}

async function jitRoute(ctx: Context, oc: OrderContext, ethPrice: number): Promise<Route | undefined> {
  const { d, client } = ctx
  const ZERO = '0x0000000000000000000000000000000000000000'
  if (!d.vault || d.vault === ZERO) return undefined
  const operator = ctx.wallet('operator')
  const plan = await jitPlan(ctx, oc, d.resolver)
  if (!plan) return undefined
  const { borrow, calls } = plan

  const strategy = {
    maker: d.vault,
    token: d.usdc,
    taker: d.resolver,
    feeBps: d.flashFeeBps,
    salt: zeroHash,
  } as const
  const args = [strategy, borrow, calls, 0n] as const
  try {
    const sim = await client.simulateContract({
      address: d.resolver,
      abi: yieldResolverAbi,
      functionName: 'execute',
      args,
      account: operator.account,
    })
    const gas = await client.estimateContractGas({
      address: d.resolver,
      abi: yieldResolverAbi,
      functionName: 'execute',
      args,
      account: operator.account,
    })
    const profit = sim.result
    return {
      name: 'jit',
      profit,
      profitToken: d.usdc,
      profitUsd: Number(formatUnits(profit, await decimals(ctx, d.usdc))),
      gasUsd: await gasUsd(ctx, gas, ethPrice),
      send: async (minProfit: bigint) =>
        (
          await write(
            ctx,
            operator,
            {
              address: d.resolver,
              abi: yieldResolverAbi,
              functionName: 'execute',
              args: [strategy, borrow, calls, minProfit],
              gas: (gas * 13n) / 10n,
            },
            'execute[jit]',
          )
        ).transactionHash,
    }
  } catch {
    return undefined
  }
}

// ─── Self-custody routes ─────────────────────────────────────────────────────

function walletRoutes(ctx: Context, oc: OrderContext, ethPrice: number, sh: Shipped): Promise<Route | undefined>[] {
  const { d } = ctx
  const ZERO = '0x0000000000000000000000000000000000000000'
  if (!d.walletResolver || (sh.strategy.taker !== ZERO && sh.strategy.taker.toLowerCase() !== d.walletResolver.toLowerCase())) {
    return []
  }
  if (sh.maker.toLowerCase() === oc.record.maker.toLowerCase()) return [] // don't fill a wallet's own order from itself
  const routes: Promise<Route | undefined>[] = []
  const skip = (kind: string) => (err: unknown) => {
    log.debug('wallet route unavailable', { kind, maker: sh.maker.slice(0, 10), reason: revertReason(err).slice(0, 160) })
    return undefined
  }
  if (sh.strategy.mm.spreadBps > 0) routes.push(walletSwapRoute(ctx, oc, ethPrice, sh).catch(skip('mm')))
  if (sh.strategy.flashFeeBps > 0) routes.push(walletJitRoute(ctx, oc, ethPrice, sh).catch(skip('jit')))
  return routes
}

const erc4626Lite = [
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxWithdraw', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

/** Listed market of `side` whose usable position can deliver `assets`, preferring the largest. */
async function pickSource(ctx: Context, sh: Shipped, side: 'stable' | 'volatile', assets: bigint) {
  const pos = (await positions(ctx, sh)).filter((p) => p.side === side && p.usable > 0n)
  const sized = await Promise.all(
    pos.map(async (p) => {
      const [value, liquidity] = await Promise.all([
        ctx.client.readContract({ address: p.market, abi: erc4626Lite, functionName: 'convertToAssets', args: [p.usable] }),
        ctx.client.readContract({ address: p.market, abi: erc4626Lite, functionName: 'maxWithdraw', args: [sh.maker] }),
      ])
      return { ...p, value: value < liquidity ? value : liquidity }
    }),
  )
  return sized.filter((p) => p.value > assets + assets / 1000n).sort((a, b) => (a.value > b.value ? -1 : 1))[0]
}

async function walletSwapRoute(ctx: Context, oc: OrderContext, ethPrice: number, sh: Shipped): Promise<Route | undefined> {
  const { d, client } = ctx
  const operator = ctx.wallet('operator')
  const tokenOut = oc.record.takerAsset
  const outSide = tokenOut.toLowerCase() === d.usdc.toLowerCase() ? 'stable' : 'volatile'
  const source = await pickSource(ctx, sh, outSide, oc.taking)
  if (!source) return undefined
  const inList = outSide === 'stable' ? sh.strategy.volatileMarkets : sh.strategy.stableMarkets
  const all = await positions(ctx, sh)
  const inMarket = all.filter((p) => inList.includes(p.market)).sort((a, b) => (a.budget > b.budget ? -1 : 1))[0]?.market ?? inList[0]
  if (!inMarket) return undefined

  const cost = await client.readContract({
    address: d.aquaYieldApp!,
    abi: aquaYieldAppAbi,
    functionName: 'quoteExactOut',
    args: [sh.strategy as any, tokenOut, oc.taking],
  })
  if (cost >= oc.making) return undefined
  const params = { tokenOut, amountOut: oc.taking, maxAmountIn: cost, outMarket: source.market, inMarket, to: d.walletResolver! }
  const args = [sh.strategy as any, params, [oc.fill], 0n] as const
  const sim = await client.simulateContract({ address: d.walletResolver!, abi: walletResolverAbi, functionName: 'executeSwap', args, account: operator.account })
  const gas = await client.estimateContractGas({ address: d.walletResolver!, abi: walletResolverAbi, functionName: 'executeSwap', args, account: operator.account })
  const profitToken = oc.record.makerAsset
  const profit = sim.result
  const name = `wallet-mm:${sh.maker.slice(0, 10)}`
  return {
    name,
    profit,
    profitToken,
    profitUsd: usdValue(ctx, profitToken, profit, ethPrice, await decimals(ctx, profitToken)),
    gasUsd: await gasUsd(ctx, gas, ethPrice),
    send: async (minProfit: bigint) =>
      (
        await write(
          ctx,
          operator,
          {
            address: d.walletResolver!,
            abi: walletResolverAbi,
            functionName: 'executeSwap',
            args: [sh.strategy as any, params, [oc.fill], minProfit],
            gas: (gas * 13n) / 10n,
          },
          `executeSwap[${name}]`,
        )
      ).transactionHash,
  }
}

async function walletJitRoute(ctx: Context, oc: OrderContext, ethPrice: number, sh: Shipped): Promise<Route | undefined> {
  const { d, client } = ctx
  const operator = ctx.wallet('operator')
  const plan = await jitPlan(ctx, oc, d.walletResolver!)
  if (!plan) return undefined
  const source = await pickSource(ctx, sh, 'stable', plan.borrow)
  if (!source) return undefined
  const args = [sh.strategy as any, source.market, plan.borrow, plan.calls, 0n] as const
  const sim = await client.simulateContract({ address: d.walletResolver!, abi: walletResolverAbi, functionName: 'executeFlash', args, account: operator.account })
  const gas = await client.estimateContractGas({ address: d.walletResolver!, abi: walletResolverAbi, functionName: 'executeFlash', args, account: operator.account })
  const profit = sim.result
  const name = `wallet-jit:${sh.maker.slice(0, 10)}`
  return {
    name,
    profit,
    profitToken: d.usdc,
    profitUsd: Number(formatUnits(profit, await decimals(ctx, d.usdc))),
    gasUsd: await gasUsd(ctx, gas, ethPrice),
    send: async (minProfit: bigint) =>
      (
        await write(
          ctx,
          operator,
          {
            address: d.walletResolver!,
            abi: walletResolverAbi,
            functionName: 'executeFlash',
            args: [sh.strategy as any, source.market, plan.borrow, plan.calls, minProfit],
            gas: (gas * 13n) / 10n,
          },
          `executeFlash[${name}]`,
        )
      ).transactionHash,
  }
}
