/**
 * Simulated users for testnets: HD wallets that post real, signed 1inch Fusion orders (USDC⇄WETH) to the relayer,
 * priced off the oracle with a Dutch auction from +premium down to −discount.
 *
 * Also provides:
 *   setup   — funds the maker wallets with gas ETH from the deployer (run once per network)
 *   order   — posts a single intent, e.g. `npm run order -- --side buy-eth --usd 1500`
 */
import { type Address, type Hex, type LocalAccount, formatUnits, maxUint256, parseEther, parseUnits, toHex } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'

import { mockERC20Abi } from './abis.ts'
import { type Context, erc20Abi, sleep, write } from './chain.ts'
import { RATE_BUMP_BASE, lopDomain, newFusionOrder, signOrder } from './fusion.ts'
import { logger } from './log.ts'
import { count, runEvery } from './loop.ts'
import { decimals, ethUsd } from './prices.ts'
import { RelayerError, relayerClient } from './relayer-client.ts'

const log = logger('maker')
const MIN_GAS_ETH = parseEther('0.0005')

export interface Maker {
  index: number
  account: LocalAccount
  key: Hex
}

export function makers(ctx: Context): Maker[] {
  const mnemonic = ctx.cfg.makerMnemonic
  if (!mnemonic) throw new Error('MAKER_MNEMONIC is required for the maker bot')
  return Array.from({ length: ctx.cfg.makerCount }, (_, index) => {
    const hd = mnemonicToAccount(mnemonic, { addressIndex: ctx.cfg.makerIndexOffset + index })
    const key = toHex(hd.getHdKey().privateKey!)
    return { index, key, account: privateKeyToAccount(key) }
  })
}

/** Tops up the keeper and operator wallets with gas ETH from the deployer, so only the deployer needs funding. */
export async function fundRoles(ctx: Context, gasEth = parseEther(process.env.ROLE_GAS_ETH ?? '0.004')) {
  const funder = ctx.wallet('deployer')
  for (const role of ['keeper', 'operator'] as const) {
    const key = ctx.cfg.keys[role]
    if (!key) continue
    const address = privateKeyToAccount(key).address
    await assertCleanWallets(ctx, [address])
    const balance = await ctx.client.getBalance({ address })
    if (balance >= gasEth / 2n) {
      log.info(`${role} funded`, { address, eth: formatUnits(balance, 18) })
      continue
    }
    const hash = await funder.sendTransaction({ to: address, value: gasEth })
    await ctx.client.waitForTransactionReceipt({ hash })
    log.info(`sent gas to ${role}`, { address, eth: formatUnits(gasEth, 18), tx: ctx.txUrl(hash) })
  }
}

/** Tops up every maker with gas ETH from the deployer. */
export async function setupMakers(ctx: Context, gasEth = parseEther(process.env.MAKER_GAS_ETH ?? '0.002')) {
  const funder = ctx.wallet('deployer')
  await assertCleanWallets(
    ctx,
    makers(ctx).map((m) => m.account.address),
  )
  for (const m of makers(ctx)) {
    const balance = await ctx.client.getBalance({ address: m.account.address })
    if (balance >= MIN_GAS_ETH) {
      log.info('maker funded', { maker: m.account.address, eth: formatUnits(balance, 18) })
      continue
    }
    const hash = await funder.sendTransaction({ to: m.account.address, value: gasEth })
    await ctx.client.waitForTransactionReceipt({ hash })
    log.info('sent gas to maker', { maker: m.account.address, eth: formatUnits(gasEth, 18), tx: ctx.txUrl(hash) })
  }
}

/** Makes sure the maker holds `amount` of `token` (minting on mock tokens) and has approved the LOP. */
async function ensureFunds(ctx: Context, m: Maker, token: Address, amount: bigint) {
  const wallet = ctx.walletFor(m.key)
  const owner = m.account.address
  const read = () =>
    Promise.all([
      ctx.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
      ctx.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, ctx.d.limitOrderProtocol] }),
    ])
  let [balance, allowance] = await read()
  let wrote = false
  if (balance < amount) {
    if (!ctx.d.mock) throw new Error(`maker ${owner} lacks ${amount - balance} of ${token} (live tokens cannot be minted)`)
    await write(ctx, wallet, { address: token, abi: mockERC20Abi, functionName: 'mint', args: [owner, amount * 5n] }, 'mint')
    wrote = true
  }
  if (allowance < amount) {
    await write(ctx, wallet, { address: token, abi: erc20Abi, functionName: 'approve', args: [ctx.d.limitOrderProtocol, maxUint256] }, 'approve')
    wrote = true
  }
  // Load-balanced RPCs may still serve the pre-transaction state; don't hand the relayer an order it can't verify yet.
  for (let i = 0; wrote && i < 10; i++) {
    ;[balance, allowance] = await read()
    if (balance >= amount && allowance >= amount) return
    await sleep(1_000)
  }
}

export type Side = 'buy-eth' | 'sell-eth'

/** Builds, signs and submits one Fusion order worth `usd`. Returns the order hash. */
export async function placeOrder(ctx: Context, m: Maker, side: Side, usd: number): Promise<Hex> {
  const { cfg, d } = ctx
  const { price } = await ethUsd(ctx)
  const [usdcDec, wethDec] = await Promise.all([decimals(ctx, d.usdc), decimals(ctx, d.weth)])
  const toUnits = (value: number, dec: number) => parseUnits(value.toFixed(dec), dec)

  const buyEth = side === 'buy-eth'
  const makerAsset = buyEth ? d.usdc : d.weth
  const takerAsset = buyEth ? d.weth : d.usdc
  const makingAmount = buyEth ? toUnits(usd, usdcDec) : toUnits(usd / price, wethDec)
  const fairTaking = buyEth ? usd / price : usd
  const takerDec = buyEth ? wethDec : usdcDec

  // Auction: starts `startPremiumBps` above fair value, decays to `minDiscountBps` below it.
  const minTaking = toUnits(fairTaking * (1 - cfg.maker.minDiscountBps / 10_000), takerDec)
  const startFactor = (1 + cfg.maker.startPremiumBps / 10_000) / (1 - cfg.maker.minDiscountBps / 10_000)
  const initialRateBump = Math.round((startFactor - 1) * Number(RATE_BUMP_BASE))

  await ensureFunds(ctx, m, makerAsset, makingAmount)

  const now = (await ctx.client.getBlock()).timestamp
  const order = newFusionOrder({
    settlement: d.fusionSettlement,
    resolvers: [d.resolver],
    maker: m.account.address,
    makerAsset,
    takerAsset,
    makingAmount,
    minTakingAmount: minTaking,
    initialRateBump,
    auctionStart: now + BigInt(cfg.maker.auctionDelaySec),
    auctionDuration: BigInt(cfg.maker.auctionDurationSec),
  })
  const signed = await signOrder(m.account, await lopDomain(ctx), order)
  await relayerClient(cfg.relayer.url).submit(signed)
  log.info('order posted', {
    maker: m.index,
    side,
    usd: usd.toFixed(0),
    making: formatUnits(makingAmount, buyEth ? usdcDec : wethDec),
    minTaking: formatUnits(minTaking, takerDec),
    order: signed.orderHash.slice(0, 10),
  })
  return signed.orderHash
}

/**
 * Well-known keys (anvil/hardhat mnemonics) are EIP-7702-delegated to sweeper contracts on public testnets:
 * any ETH sent there is stolen and every transaction fails. Refuse to run with such wallets.
 */
export async function assertCleanWallets(ctx: Context, addresses: Address[]) {
  for (const address of addresses) {
    const code = await ctx.client.getCode({ address })
    if (code && code !== '0x') {
      const kind = code.startsWith('0xef0100') ? `EIP-7702-delegated to 0x${code.slice(8, 48)}` : 'a contract'
      throw new Error(`wallet ${address} is ${kind} on this chain — the key is public/compromised; use a fresh MAKER_MNEMONIC`)
    }
  }
}

export async function startMaker(ctx: Context, signal: AbortSignal) {
  const all = makers(ctx)
  await assertCleanWallets(
    ctx,
    all.map((m) => m.account.address),
  )
  const relayer = relayerClient(ctx.cfg.relayer.url)
  log.info('starting', { makers: all.length, intervalMs: ctx.cfg.maker.intervalMs })
  let next = 0
  await runEvery('maker', ctx.cfg.maker.intervalMs, signal, async () => {
    await relayer.health()
    const m = all[next++ % all.length]
    const side: Side = Math.random() < 0.5 ? 'buy-eth' : 'sell-eth'
    const usd = ctx.cfg.maker.minUsd + Math.random() * (ctx.cfg.maker.maxUsd - ctx.cfg.maker.minUsd)
    try {
      await placeOrder(ctx, m, side, usd)
      count('maker', 'posted')
    } catch (err) {
      if (err instanceof RelayerError) {
        count('maker', 'rejected')
        log.warn('relayer rejected order', { reason: err.message })
        return
      }
      throw err
    }
  })
}
