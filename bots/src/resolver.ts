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
 *
 * Route A needs a router the bot can quote exactly; on testnets that's MockSwapRouter. Without one (live mode) only
 * route B is used.
 */
import { type Address, type Hex, encodeFunctionData, formatUnits, zeroHash } from 'viem'
import { Address as OneInchAddress, type FusionOrder } from '@1inch/fusion-sdk'

import { mockSwapRouterAbi, oracleSwapAppAbi, yieldResolverAbi } from './abis.ts'
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
  log.info('starting', { resolver: ctx.d.resolver, operator: operator.account.address, pollMs: cfg.resolver.pollMs })

  await runEvery('resolver', cfg.resolver.pollMs, signal, async () => {
    const orders = (await relayer.active()).filter((o) => !done.has(o.orderHash))
    if (orders.length === 0) return
    const block = await ctx.client.getBlock()
    const { price } = await ethUsd(ctx)

    for (const record of orders.sort((a, b) => a.auctionStart - b.auctionStart)) {
      if (signal.aborted) return
      try {
        const best = await bestRoute(ctx, record, block.timestamp, block.baseFeePerGas ?? 0n, price)
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

  const candidates = await Promise.all([...inventoryRoutes(ctx, oc, ethPrice), jitRoute(ctx, oc, ethPrice)])
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

async function jitRoute(ctx: Context, oc: OrderContext, ethPrice: number): Promise<Route | undefined> {
  const { d, client } = ctx
  const ZERO = '0x0000000000000000000000000000000000000000'
  if (!d.router || d.router === ZERO || !d.vault || d.vault === ZERO) return undefined
  const operator = ctx.wallet('operator')
  const usdc = d.usdc.toLowerCase()
  const swap = (tokenIn: Address, tokenOut: Address, amountIn: bigint, minOut: bigint): Call => ({
    target: d.router,
    value: 0n,
    data: encodeFunctionData({
      abi: mockSwapRouterAbi,
      functionName: 'swap',
      args: [tokenIn, tokenOut, amountIn, minOut, d.resolver],
    }),
  })

  let borrow: bigint
  let calls: Call[]
  if (oc.record.takerAsset.toLowerCase() === usdc) {
    // User sells WETH for USDC: borrow the USDC to pay, then sell the received WETH on the router.
    borrow = oc.taking
    const out = await client.readContract({
      address: d.router,
      abi: mockSwapRouterAbi,
      functionName: 'quote',
      args: [oc.record.makerAsset, d.usdc, oc.making],
    })
    calls = [oc.fill, swap(oc.record.makerAsset, d.usdc, oc.making, out)]
  } else if (oc.record.makerAsset.toLowerCase() === usdc) {
    // User sells USDC for WETH: borrow USDC, buy the WETH on the router, fill, repay with the user's USDC.
    const p = await client.readContract({
      address: d.router,
      abi: mockSwapRouterAbi,
      functionName: 'price',
      args: [d.usdc, oc.record.takerAsset],
    })
    if (p === 0n) return undefined
    borrow = (oc.taking * 10n ** 18n + p - 1n) / p + 1n
    calls = [swap(d.usdc, oc.record.takerAsset, borrow, oc.taking), oc.fill]
  } else {
    return undefined
  }

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
