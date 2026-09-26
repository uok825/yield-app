/**
 * 1inch Fusion v2 order helpers built on the official SDKs, pointed at whatever LimitOrderProtocol and
 * SimpleSettlement the deployment uses (our own on testnets, the canonical ones on Base).
 */
import {
  Address as OneInchAddress,
  AmountMode,
  AuctionDetails,
  Extension,
  FusionOrder,
  LimitOrderContract,
  type LimitOrderV4Struct,
  SurplusParams,
  TakerTraits,
  Whitelist,
  randBigInt,
} from '@1inch/fusion-sdk'
import { buildOrderTypedData, getOrderHash } from '@1inch/limit-order-sdk'
import type { Address, Hex, LocalAccount } from 'viem'

import { limitOrderProtocolAbi } from './abis.ts'
import type { Context } from './chain.ts'

/** Rate bumps in the Fusion auction are expressed in 1e7 (10_000_000 = 100%). */
export const RATE_BUMP_BASE = 10_000_000n
const UINT_40_MAX = (1n << 40n) - 1n

export interface Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

/** Wire format shared by the maker, relayer and resolver (bigints as decimal strings). */
export interface SignedOrder {
  orderHash: Hex
  order: LimitOrderV4Struct
  extension: Hex
  signature: Hex
}

let cachedDomain: Domain | undefined

/** Reads the EIP-712 domain from the deployed LOP (differs between our v4 deployment and the 1inch router). */
export async function lopDomain(ctx: Context): Promise<Domain> {
  if (cachedDomain) return cachedDomain
  const [, name, version, chainId, verifyingContract] = await ctx.client.readContract({
    address: ctx.d.limitOrderProtocol,
    abi: limitOrderProtocolAbi,
    functionName: 'eip712Domain',
  })
  cachedDomain = { name, version, chainId: Number(chainId), verifyingContract }
  return cachedDomain
}

export interface NewOrderParams {
  settlement: Address
  resolvers: Address[]
  maker: Address
  makerAsset: Address
  takerAsset: Address
  makingAmount: bigint
  /** Minimum the maker accepts (auction end price). */
  minTakingAmount: bigint
  /** Starting premium over the minimum, in 1e7 units. */
  initialRateBump: number
  auctionStart: bigint
  auctionDuration: bigint
}

export function newFusionOrder(p: NewOrderParams): FusionOrder {
  return FusionOrder.new(
    new OneInchAddress(p.settlement),
    {
      maker: new OneInchAddress(p.maker),
      makerAsset: new OneInchAddress(p.makerAsset),
      takerAsset: new OneInchAddress(p.takerAsset),
      makingAmount: p.makingAmount,
      takingAmount: p.minTakingAmount,
    },
    {
      auction: new AuctionDetails({
        startTime: p.auctionStart,
        duration: p.auctionDuration,
        initialRateBump: p.initialRateBump,
        points: [],
      }),
      whitelist: Whitelist.new(
        p.auctionStart,
        p.resolvers.map((r) => ({ address: new OneInchAddress(r), allowFrom: 0n })),
      ),
      surplus: SurplusParams.NO_FEE,
    },
    {
      nonce: randBigInt(UINT_40_MAX),
      allowPartialFills: false,
      allowMultipleFills: false,
    },
  )
}

function typedData(domain: Domain, struct: LimitOrderV4Struct) {
  return buildOrderTypedData(domain.chainId, domain.verifyingContract, domain.name, domain.version, struct)
}

/** EIP-712 payload in the shape wallets expect for eth_signTypedData_v4 (JSON-safe). */
export function typedDataFor(domain: Domain, order: FusionOrder) {
  const td = typedData(domain, order.build())
  return { domain: td.domain, types: { Order: td.types.Order }, primaryType: 'Order' as const, message: td.message }
}

export function orderHash(domain: Domain, order: FusionOrder): Hex {
  return getOrderHash(typedData(domain, order.build())) as Hex
}

export async function signOrder(account: LocalAccount, domain: Domain, order: FusionOrder): Promise<SignedOrder> {
  const struct = order.build()
  const td = typedData(domain, struct)
  const signature = await account.signTypedData({
    domain: td.domain as any,
    types: { Order: td.types.Order } as any,
    primaryType: 'Order',
    message: td.message as any,
  })
  return { orderHash: getOrderHash(td) as Hex, order: struct, extension: order.extension.encode() as Hex, signature }
}

export function decodeOrder(signed: Pick<SignedOrder, 'order' | 'extension'>): FusionOrder {
  return FusionOrder.fromDataAndExtension(signed.order, Extension.decode(signed.extension))
}

/** Amount of takerAsset the resolver must pay at `time` (seconds) for the full order. */
export function takingAmountAt(order: FusionOrder, taker: Address, time: bigint, baseFee = 0n): bigint {
  return order.calcTakingAmount(new OneInchAddress(taker), order.makingAmount, time, baseFee)
}

/**
 * Calldata for `LimitOrderProtocol.fillOrderArgs` filling the whole order.
 * `maxTakingAmount` is the taker-side slippage guard enforced by the LOP.
 */
export function fillCalldata(order: FusionOrder, signature: Hex, maxTakingAmount: bigint): Hex {
  const traits = TakerTraits.default()
    .setExtension(order.extension)
    .setAmountMode(AmountMode.maker)
    .setAmountThreshold(maxTakingAmount)
  return LimitOrderContract.getFillOrderArgsCalldata(order.build(), signature, traits, order.makingAmount) as Hex
}
