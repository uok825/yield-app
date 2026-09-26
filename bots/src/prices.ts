import { type Address, formatUnits } from 'viem'
import { chainlinkAggregatorAbi } from './abis.ts'
import { erc20Abi, type Context } from './chain.ts'

const decimalsCache = new Map<Address, number>()

export async function decimals(ctx: Context, token: Address): Promise<number> {
  let d = decimalsCache.get(token)
  if (d === undefined) {
    d = await ctx.client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
    decimalsCache.set(token, d)
  }
  return d
}

/** ETH/USD from the deployment's oracle (MockOracle on testnets, Chainlink on Base). */
export async function ethUsd(ctx: Context): Promise<{ price: number; updatedAt: number; answer: bigint; decimals: number }> {
  const [dec, round] = await Promise.all([
    ctx.client.readContract({ address: ctx.d.oracle, abi: chainlinkAggregatorAbi, functionName: 'decimals' }),
    ctx.client.readContract({ address: ctx.d.oracle, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData' }),
  ])
  const answer = round[1]
  return { price: Number(formatUnits(answer, dec)), updatedAt: Number(round[3]), answer, decimals: dec }
}

/** USD value of `amount` of `token` (USDC ≈ $1, WETH via oracle). */
export function usdValue(ctx: Context, token: Address, amount: bigint, ethPrice: number, tokenDecimals: number): number {
  const units = Number(formatUnits(amount, tokenDecimals))
  return token.toLowerCase() === ctx.d.weth.toLowerCase() ? units * ethPrice : units
}
