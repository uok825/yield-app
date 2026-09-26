/**
 * Seeds liquidity on a mock deployment:
 *   Markets:    third-party depth in the mock Morpho/Fluid/Aave markets (like real TVL), so interest accrues and
 *               the keeper can measure APYs before we allocate anything
 *   Strategy A: SEED_A_USD into the YieldVault (deployer acts as the first LP)
 *   Strategy B: SEED_B_USD into each InventoryVault at its target split
 * Idempotent: vaults that already hold liquidity are skipped.
 */
import { maxUint256, parseUnits } from 'viem'

import { inventoryVaultAbi, mockAavePoolAbi, mockERC20Abi, mockLendingVaultAbi, yieldVaultAbi } from './abis.ts'
import { type Context, erc20Abi, write } from './chain.ts'
import { logger } from './log.ts'

const log = logger('seed')

export async function seed(ctx: Context) {
  const { d, client } = ctx
  if (!d.mock) throw new Error('seed only runs on mock deployments — deposit real funds through the vaults instead')
  const w = ctx.wallet('deployer')
  const me = w.account.address
  const aUsd = Number(process.env.SEED_A_USD ?? 50_000)
  const bUsd = Number(process.env.SEED_B_USD ?? 100_000)

  const approve = async (token: `0x${string}`, spender: `0x${string}`) => {
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me, spender] })
    if (allowance < maxUint256 / 2n) await write(ctx, w, { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] })
  }

  const ZERO = '0x0000000000000000000000000000000000000000'
  const depth = parseUnits(process.env.SEED_MARKET_USD ?? '1000000', 6)
  for (const market of [d.morphoMarket, d.fluidMarket]) {
    if (!market || market === ZERO) continue
    const assets = await client.readContract({ address: market, abi: mockLendingVaultAbi, functionName: 'totalAssets' })
    if (assets >= depth / 2n) continue
    await write(ctx, w, { address: d.usdc, abi: mockERC20Abi, functionName: 'mint', args: [me, depth] })
    await approve(d.usdc, market)
    await write(ctx, w, { address: market, abi: mockLendingVaultAbi, functionName: 'deposit', args: [depth, me] })
    log.info('seeded market depth', { market, usd: Number(depth / 10n ** 6n) })
  }
  for (const [pool, token, amount] of [
    [d.aavePool, d.usdc, depth],
    [d.aaveWethPool, d.weth, parseUnits('300', 18)],
  ] as const) {
    if (!pool || pool === ZERO) continue
    const cash = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [await client.readContract({ address: pool, abi: mockAavePoolAbi, functionName: 'aToken' })] })
    if (cash >= amount / 2n) continue
    await write(ctx, w, { address: token, abi: mockERC20Abi, functionName: 'mint', args: [me, amount] })
    await approve(token, pool)
    await write(ctx, w, { address: pool, abi: mockAavePoolAbi, functionName: 'supply', args: [token, amount, me, 0] })
    log.info('seeded aave depth', { pool, amount: amount.toString() })
  }

  if ((await client.readContract({ address: d.vault, abi: yieldVaultAbi, functionName: 'totalAssets' })) === 0n) {
    const amount = parseUnits(String(aUsd), 6)
    await write(ctx, w, { address: d.usdc, abi: mockERC20Abi, functionName: 'mint', args: [me, amount] })
    await approve(d.usdc, d.vault)
    await write(ctx, w, { address: d.vault, abi: yieldVaultAbi, functionName: 'deposit', args: [amount, me] })
    log.info('seeded strategy A', { usd: aUsd })
  }

  for (const v of d.inventoryVaults) {
    if ((await client.readContract({ address: v, abi: erc20Abi, functionName: 'balanceOf', args: [me] })) > 0n) continue
    const [price, [targetStable]] = await Promise.all([
      client.readContract({ address: v, abi: inventoryVaultAbi, functionName: 'price' }),
      client.readContract({ address: v, abi: inventoryVaultAbi, functionName: 'profile' }),
    ])
    const stableIn = parseUnits(String((bUsd * targetStable) / 10_000), 6)
    const wethIn = ((parseUnits(String(bUsd), 6) - stableIn) * 10n ** 36n) / price
    await write(ctx, w, { address: d.usdc, abi: mockERC20Abi, functionName: 'mint', args: [me, stableIn] })
    await write(ctx, w, { address: d.weth, abi: mockERC20Abi, functionName: 'mint', args: [me, wethIn] })
    await approve(d.usdc, v)
    await approve(d.weth, v)
    await write(ctx, w, { address: v, abi: inventoryVaultAbi, functionName: 'deposit', args: [stableIn, wethIn, me, 1n] })
    log.info('seeded inventory profile', { vault: v, usd: bUsd, targetStable: targetStable / 100 })
  }
}
