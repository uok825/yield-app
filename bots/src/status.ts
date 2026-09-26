/** Prints a one-screen summary of both strategies, the resolver and the relayer. */
import { formatUnits } from 'viem'

import { inventoryVaultAbi, yieldVaultAbi } from './abis.ts'
import { type Context, erc20Abi } from './chain.ts'
import { ethUsd } from './prices.ts'
import { relayerClient } from './relayer-client.ts'

const usd = (v: bigint, dec = 6) => `$${Number(formatUnits(v, dec)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`

export async function printStatus(ctx: Context) {
  const { client, d } = ctx
  const { price, updatedAt } = await ethUsd(ctx)
  const head = await client.getBlock()
  console.log(`\nchain ${ctx.chain.id} · block ${head.number} · ETH $${price.toFixed(2)} (oracle ${Number(head.timestamp) - updatedAt}s old)\n`)

  const [total, idle, [adapters, assets]] = await Promise.all([
    client.readContract({ address: d.vault, abi: yieldVaultAbi, functionName: 'totalAssets' }),
    client.readContract({ address: d.vault, abi: yieldVaultAbi, functionName: 'idleAssets' }),
    client.readContract({ address: d.vault, abi: yieldVaultAbi, functionName: 'positions' }),
  ])
  console.log(`A · Yield + JIT   TVL ${usd(total)}  idle ${usd(idle)}`)
  adapters.forEach((a, i) => console.log(`    ${a}  ${usd(assets[i])}`))

  console.log('\nB · Inventory MM')
  for (const v of d.inventoryVaults) {
    const [symbol, value, ratio, [s, w]] = await Promise.all([
      client.readContract({ address: v, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: v, abi: inventoryVaultAbi, functionName: 'totalValue' }),
      client.readContract({ address: v, abi: inventoryVaultAbi, functionName: 'stableRatioBps' }),
      client.readContract({ address: v, abi: inventoryVaultAbi, functionName: 'holdings' }),
    ])
    console.log(
      `    ${symbol.padEnd(8)} ${usd(value).padStart(12)}  USDC ${(Number(ratio) / 100).toFixed(1)}%  ` +
        `(${Number(formatUnits(s, 6)).toFixed(0)} USDC + ${Number(formatUnits(w, 18)).toFixed(3)} WETH)`,
    )
  }

  const [ru, rw] = await Promise.all([
    client.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [d.resolver] }),
    client.readContract({ address: d.weth, abi: erc20Abi, functionName: 'balanceOf', args: [d.resolver] }),
  ])
  console.log(`\nResolver profit held: ${usd(ru)} + ${formatUnits(rw, 18)} WETH`)

  try {
    const stats = await relayerClient(ctx.cfg.relayer.url).stats()
    console.log(`Relayer orders: ${JSON.stringify(stats.orders)}`)
  } catch {
    console.log(`Relayer: unreachable at ${ctx.cfg.relayer.url}`)
  }
  console.log()
}
