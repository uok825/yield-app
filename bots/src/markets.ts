/** Identifies what lending market an adapter wraps and how to read its supply index (for APY measurement). */
import type { Address } from 'viem'

import { aave4626Abi, aaveV3AdapterAbi, erc4626AdapterAbi, mockAavePoolAbi, mockLendingVaultAbi } from './abis.ts'
import { type Context, erc20Abi } from './chain.ts'

export type RateSource = () => Promise<bigint>

export interface MarketInfo {
  adapter: Address
  name: string
  rate: RateSource
}

/** Figures out what an adapter wraps and how to read its supply index. */
export async function describeAdapter(ctx: Context, adapter: Address): Promise<MarketInfo> {
  const { client, d } = ctx
  const label = (target: Address) =>
    target.toLowerCase() === d.morphoMarket?.toLowerCase()
      ? 'morpho'
      : target.toLowerCase() === d.fluidMarket?.toLowerCase()
        ? 'fluid'
        : target.toLowerCase() === d.aavePool?.toLowerCase()
          ? 'aave'
          : target.slice(0, 10)
  try {
    const target = await client.readContract({ address: adapter, abi: erc4626AdapterAbi, functionName: 'target' })
    const shareDecimals = await client.readContract({ address: target, abi: erc20Abi, functionName: 'decimals' })
    const probe = 10n ** BigInt(shareDecimals) * 10n ** 18n
    return {
      adapter,
      name: label(target),
      rate: () =>
        client.readContract({ address: target, abi: mockLendingVaultAbi, functionName: 'convertToAssets', args: [probe] }),
    }
  } catch {
    const pool = await client.readContract({ address: adapter, abi: aaveV3AdapterAbi, functionName: 'pool' })
    const asset = await client.readContract({ address: adapter, abi: aaveV3AdapterAbi, functionName: 'asset' })
    return {
      adapter,
      name: label(pool),
      rate: () =>
        client.readContract({
          address: pool,
          abi: mockAavePoolAbi,
          functionName: 'getReserveNormalizedIncome',
          args: [asset],
        }),
    }
  }
}


/** Supply index of an Aave V3 reserve (ray) — used for the WETH market that no YieldVault adapter wraps. */
export function aaveIndex(ctx: Context, pool: Address, asset: Address): RateSource {
  return () =>
    ctx.client.readContract({ address: pool, abi: mockAavePoolAbi, functionName: 'getReserveNormalizedIncome', args: [asset] })
}

/**
 * Rate source for a self-custody ERC-4626 market. Aave-4626 wrappers use the Aave reserve index (their own share
 * price is flat until someone deposits); other markets are probed via their share price with 1e18 precision.
 */
export async function erc4626Rate(ctx: Context, market: Address): Promise<RateSource> {
  // Aave-4626 wrappers expose A_TOKEN (CarryVault has POOL too, but its share price is the right measure).
  const aToken = await ctx.client
    .readContract({ address: market, abi: aave4626Abi, functionName: 'A_TOKEN' })
    .catch(() => undefined)
  const pool = aToken
    ? await ctx.client.readContract({ address: market, abi: aave4626Abi, functionName: 'POOL' })
    : undefined
  if (pool) {
    const asset = await ctx.client.readContract({ address: market, abi: aave4626Abi, functionName: 'asset' })
    return aaveIndex(ctx, pool, asset)
  }
  const shareDecimals = await ctx.client.readContract({ address: market, abi: erc20Abi, functionName: 'decimals' })
  const probe = 10n ** BigInt(shareDecimals) * 10n ** 18n
  return () =>
    ctx.client.readContract({ address: market, abi: mockLendingVaultAbi, functionName: 'convertToAssets', args: [probe] })
}

/** Trust-score key for a self-custody market: the deployment's Morpho / Fluid markets, otherwise an Aave-4626 wrapper. */
export function walletMarketName(ctx: Context, market: Address): string {
  const m = market.toLowerCase()
  if (m === ctx.d.carryVault?.toLowerCase()) return 'carry'
  if (m === ctx.d.morphoMarket?.toLowerCase()) return 'morpho'
  if (m === ctx.d.fluidMarket?.toLowerCase()) return 'fluid'
  return 'aave'
}
