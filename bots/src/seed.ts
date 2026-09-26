/**
 * Seeds liquidity on a mock deployment:
 *   Markets:    third-party depth in the mock Morpho/Fluid/Aave markets (like real TVL), so interest accrues and
 *               the keeper can measure APYs before we allocate anything
 *   Strategy A: SEED_A_USD into the YieldVault (deployer acts as the first LP)
 *   Strategy B: SEED_B_USD into each InventoryVault at its target split
 *   Carry:      USDC lending depth in the mock credit market, SEED_CARRY_ETH of WETH into the CarryVault
 * Idempotent: vaults that already hold liquidity are skipped.
 */
import { type Address, type Hex, maxUint256, parseEther, parseUnits, toHex, zeroHash } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'

import { aquaAbi, aave4626Abi, carryVaultAbi, mockCreditMarketAbi, inventoryVaultAbi, mockAavePoolAbi, mockERC20Abi, mockLendingVaultAbi, yieldVaultAbi } from './abis.ts'
import { assertCleanWallets } from './maker.ts'
import { StrategyRegistry, encodeStrategy, selfCustodyEnabled, type WalletStrategy } from './wallets.ts'
import { type Context, erc20Abi, write } from './chain.ts'
import { logger } from './log.ts'

const log = logger('seed')

export async function seed(ctx: Context) {
  await seedVaults(ctx)
  await seedCarry(ctx)
  await seedWallets(ctx)
}

async function seedCarry(ctx: Context) {
  const { d, client } = ctx
  const ZERO = '0x0000000000000000000000000000000000000000'
  if (!d.carryVault || d.carryVault === ZERO || !d.creditMarket || d.creditMarket === ZERO) return
  const w = ctx.wallet('deployer')
  const me = w.account.address
  const approve = async (token: Address, spender: Address) => {
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me, spender] })
    if (allowance < maxUint256 / 2n) await write(ctx, w, { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] })
  }
  // Other lenders' USDC, so the vault can borrow.
  const aUsdc = await client.readContract({ address: d.creditMarket, abi: mockCreditMarketAbi, functionName: 'aTokenOf', args: [d.usdc] })
  const depth = parseUnits(process.env.SEED_CREDIT_USD ?? '2000000', 6)
  if ((await client.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [aUsdc] })) < depth / 2n) {
    await write(ctx, w, { address: d.usdc, abi: mockERC20Abi, functionName: 'mint', args: [me, depth] })
    await approve(d.usdc, d.creditMarket)
    await write(ctx, w, { address: d.creditMarket, abi: mockCreditMarketAbi, functionName: 'supply', args: [d.usdc, depth, me, 0] })
    log.info('seeded credit market', { usd: Number(depth / 10n ** 6n) })
  }
  if ((await client.readContract({ address: d.carryVault, abi: carryVaultAbi, functionName: 'totalSupply' })) === 0n) {
    const amount = parseEther(process.env.SEED_CARRY_ETH ?? '20')
    await write(ctx, w, { address: d.weth, abi: mockERC20Abi, functionName: 'mint', args: [me, amount] })
    await approve(d.weth, d.carryVault)
    await write(ctx, w, { address: d.carryVault, abi: carryVaultAbi, functionName: 'deposit', args: [amount, me] })
    log.info('seeded carry vault', { weth: Number(amount / 10n ** 18n) })
  }
}

async function seedVaults(ctx: Context) {
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

/**
 * Self-custody LPs (mock deployments): wallets that supply to lending markets themselves, keep the ERC-4626 shares,
 * approve Aqua and ship one AquaYieldApp strategy (keeper rebalancing + JIT + market making).
 * Keys derive from MAKER_MNEMONIC at index MAKER_INDEX_OFFSET + 100 + i. LPs shipped after the carry module was
 * deployed also list the CarryVault as a WETH market, so the keeper can route their ETH into carry when it pays.
 */
export function walletLps(ctx: Context) {
  const mnemonic = ctx.cfg.makerMnemonic
  if (!mnemonic) throw new Error('MAKER_MNEMONIC is required to seed self-custody LPs')
  const count = Number(process.env.WALLET_LP_COUNT ?? 3)
  return Array.from({ length: count }, (_, i) => {
    const key = toHex(mnemonicToAccount(mnemonic, { addressIndex: ctx.cfg.makerIndexOffset + 100 + i }).getHdKey().privateKey!)
    return { index: i, key: key as Hex, address: privateKeyToAccount(key as Hex).address }
  })
}

export async function seedWallets(ctx: Context) {
  const { d, client, cfg } = ctx
  if (!selfCustodyEnabled(ctx)) return log.info('self-custody mode not deployed; skipping wallet LPs')
  if (!d.mock) throw new Error('seed only runs on mock deployments')
  const lps = walletLps(ctx)
  await assertCleanWallets(ctx, lps.map((l) => l.address))
  const registry = new StrategyRegistry(ctx)
  await registry.sync()
  const funder = ctx.wallet('deployer')
  const keeperAddr = privateKeyToAccount(cfg.keys.keeper ?? cfg.keys.deployer!).address
  const usd = Number(process.env.SEED_WALLET_USD ?? 100_000)
  const stableMarkets = d.walletStableMarkets ?? []
  const volatileMarkets = d.walletVolatileMarkets ?? []

  for (const lp of lps) {
    if (registry.active().some((s) => s.maker === lp.address)) {
      log.info('wallet LP already has a strategy', { lp: lp.address })
      continue
    }
    if ((await client.getBalance({ address: lp.address })) < parseEther('0.001')) {
      const hash = await funder.sendTransaction({ to: lp.address, value: parseEther(process.env.MAKER_GAS_ETH ?? '0.002') })
      await client.waitForTransactionReceipt({ hash })
    }
    const w = ctx.walletFor(lp.key)
    const target = lp.index % 2 === 0 ? 7_000 : 5_000
    const [price] = await Promise.all([
      client.readContract({ address: d.inventoryVaults[0], abi: inventoryVaultAbi, functionName: 'price' }),
    ])
    const stableIn = parseUnits(String((usd * target) / 10_000), 6)
    const wethIn = ((parseUnits(String(usd), 6) - stableIn) * 10n ** 36n) / price
    const usdcMarket = stableMarkets[lp.index % Math.min(2, stableMarkets.length)] // Morpho for LP 0, Fluid for LP 1
    const wethMarket = volatileMarkets[0]

    await write(ctx, w, { address: d.usdc, abi: mockERC20Abi, functionName: 'mint', args: [lp.address, stableIn] })
    await write(ctx, w, { address: d.weth, abi: mockERC20Abi, functionName: 'mint', args: [lp.address, wethIn] })
    await write(ctx, w, { address: d.usdc, abi: erc20Abi, functionName: 'approve', args: [usdcMarket, maxUint256] })
    await write(ctx, w, { address: d.weth, abi: erc20Abi, functionName: 'approve', args: [wethMarket, maxUint256] })
    await write(ctx, w, { address: usdcMarket, abi: aave4626Abi, functionName: 'deposit', args: [stableIn, lp.address] })
    await write(ctx, w, { address: wethMarket, abi: aave4626Abi, functionName: 'deposit', args: [wethIn, lp.address] })

    const markets = [...stableMarkets, ...volatileMarkets] as Address[]
    for (const m of markets) {
      await write(ctx, w, { address: m, abi: erc20Abi, functionName: 'approve', args: [d.aqua, maxUint256] })
    }
    const budgets = await Promise.all(
      markets.map((m) => client.readContract({ address: m, abi: erc20Abi, functionName: 'balanceOf', args: [lp.address] })),
    )
    const strategy: WalletStrategy = {
      maker: lp.address,
      stable: d.usdc,
      volatileAsset: d.weth,
      stableMarkets,
      volatileMarkets,
      keeper: keeperAddr,
      taker: d.walletResolver!,
      flashFeeBps: d.flashFeeBps,
      mm: {
        oracle: d.oracle,
        maxPriceAge: d.mock ? 365 * 24 * 3600 : 3600,
        spreadBps: d.spreadBps,
        skewBps: d.skewBps,
        maxTradeBps: d.maxTradeBps,
        targetStableBps: target,
        bandBps: 500,
      },
      salt: zeroHash,
    }
    await write(ctx, w, {
      address: d.aqua,
      abi: aquaAbi,
      functionName: 'ship',
      args: [d.aquaYieldApp!, encodeStrategy(strategy), markets, budgets],
    })
    log.info('wallet LP shipped strategy', { lp: lp.address, usd, target: target / 100, usdcMarket })
  }
}
