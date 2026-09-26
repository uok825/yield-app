/**
 * Builds a Fusion order for a user intent, priced off the oracle with the configured Dutch auction
 * (+startPremium → −minDiscount around fair value). Shared by the maker bot and the relayer's /v1/quote.
 */
import { type Address, getAddress } from 'viem'
import type { FusionOrder } from '@1inch/fusion-sdk'

import type { Context } from './chain.ts'
import { RATE_BUMP_BASE, newFusionOrder } from './fusion.ts'
import { decimals, ethUsd } from './prices.ts'

export interface QuoteRequest {
  maker: Address
  makerAsset: Address
  takerAsset: Address
  makingAmount: bigint
}

export interface Quote {
  order: FusionOrder
  fairTaking: bigint
  startTaking: bigint
  minTaking: bigint
  auctionStart: number
  auctionEnd: number
  ethUsd: number
}

export class QuoteError extends Error {}

export async function buildQuote(ctx: Context, req: QuoteRequest): Promise<Quote> {
  const { cfg, d } = ctx
  const usdc = getAddress(d.usdc)
  const weth = getAddress(d.weth)
  const makerAsset = getAddress(req.makerAsset)
  const takerAsset = getAddress(req.takerAsset)
  const pair = new Set([makerAsset, takerAsset])
  if (!pair.has(usdc) || !pair.has(weth)) throw new QuoteError('only USDC⇄WETH is supported')
  if (req.makingAmount <= 0n) throw new QuoteError('makingAmount must be positive')

  const { price } = await ethUsd(ctx)
  const [makerDec, takerDec] = await Promise.all([decimals(ctx, makerAsset), decimals(ctx, takerAsset)])
  const making = Number(req.makingAmount) / 10 ** makerDec
  const fair = makerAsset === usdc ? making / price : making * price
  const usdValue = makerAsset === usdc ? making : making * price
  if (usdValue < 1) throw new QuoteError('order is below $1')
  if (usdValue > 50_000) throw new QuoteError('order is above $50,000')

  const toUnits = (v: number) => BigInt(Math.floor(v * 10 ** Math.min(takerDec, 15))) * 10n ** BigInt(Math.max(0, takerDec - 15))
  const minTaking = toUnits(fair * (1 - cfg.maker.minDiscountBps / 10_000))
  const startFactor = (1 + cfg.maker.startPremiumBps / 10_000) / (1 - cfg.maker.minDiscountBps / 10_000)
  const initialRateBump = Math.round((startFactor - 1) * Number(RATE_BUMP_BASE))

  const now = (await ctx.client.getBlock()).timestamp
  const auctionStart = now + BigInt(cfg.maker.auctionDelaySec)
  const order = newFusionOrder({
    settlement: d.fusionSettlement,
    resolvers: [d.resolver],
    maker: getAddress(req.maker),
    makerAsset,
    takerAsset,
    makingAmount: req.makingAmount,
    minTakingAmount: minTaking,
    initialRateBump,
    auctionStart,
    auctionDuration: BigInt(cfg.maker.auctionDurationSec),
  })
  return {
    order,
    fairTaking: toUnits(fair),
    startTaking: (minTaking * (RATE_BUMP_BASE + BigInt(initialRateBump))) / RATE_BUMP_BASE,
    minTaking,
    auctionStart: Number(auctionStart),
    auctionEnd: Number(auctionStart) + cfg.maker.auctionDurationSec,
    ethUsd: price,
  }
}
