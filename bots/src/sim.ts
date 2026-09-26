/**
 * Testnet world simulator (mock deployments only). Keeps the mocks behaving like live markets:
 *   - MockOracle mirrors Chainlink ETH/USD on Base mainnet (PRICE_SOURCE_RPC_URL), or a bounded random walk
 *   - MockSwapRouter quotes USDC⇄WETH at oracle ± SIM_ROUTER_SPREAD_BPS
 *   - Mock lending markets accrue interest at drifting APYs (SIM_MARKET_APYS, SIM_TIME_SCALE)
 */
import { type Address, createPublicClient, formatUnits, http } from 'viem'
import { base } from 'viem/chains'

import { chainlinkAggregatorAbi, mockAavePoolAbi, mockLendingVaultAbi, mockOracleAbi, mockSwapRouterAbi } from './abis.ts'
import { type Context, write } from './chain.ts'
import { logger } from './log.ts'
import { count, runEvery } from './loop.ts'

const log = logger('sim')
const YEAR = 365 * 24 * 3600
const CHAINLINK_ETH_USD_BASE = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'
const ZERO = '0x0000000000000000000000000000000000000000'

interface SimMarket {
  name: string
  address: Address
  kind: 'erc4626' | 'aave'
  apy: number
  base: number
  /** Interest owed but not yet minted: tiny per-tick amounts would round to zero token units. */
  pendingWad: bigint
}

/** Accrue once the interest is worth at least this many token units. */
const MIN_ACCRUAL_UNITS = 100n

export async function startSim(ctx: Context, signal: AbortSignal) {
  const { d, cfg } = ctx
  if (!d.mock) {
    log.warn('deployment is live (not mock) — the simulator only drives mock markets; exiting')
    return
  }
  const deployer = ctx.wallet('deployer')
  const source = cfg.sim.priceSourceRpcUrl
    ? createPublicClient({ chain: base, transport: http(cfg.sim.priceSourceRpcUrl, { timeout: 10_000 }) })
    : undefined

  const apys = cfg.sim.marketApys
  const markets: SimMarket[] = (
    [
      ['morpho', d.morphoMarket, 'erc4626'],
      ['fluid', d.fluidMarket, 'erc4626'],
      ['aave', d.aavePool, 'aave'],
      ['aaveWeth', d.aaveWethPool, 'aave'],
    ] as const
  )
    .filter(([, address]) => address && address !== ZERO)
    .map(([name, address, kind]) => ({ name, address, kind, apy: apys[name] ?? 4, base: apys[name] ?? 4, pendingWad: 0n }))

  let lastT = Number((await ctx.client.getBlock()).timestamp)
  log.info('starting', {
    priceSource: source ? 'chainlink(base)' : 'random-walk',
    markets: markets.map((m) => `${m.name}:${m.apy}%`).join(' '),
    timeScale: cfg.sim.timeScale,
  })

  await runEvery('sim', cfg.sim.intervalMs, signal, async () => {
    const now = Number((await ctx.client.getBlock()).timestamp)
    const dt = Math.max(1, now - lastT)
    lastT = now

    // ─── Oracle ──────────────────────────────────────────────────────────
    const [, current, , updatedAt] = await ctx.client.readContract({
      address: d.oracle,
      abi: chainlinkAggregatorAbi,
      functionName: 'latestRoundData',
    })
    let next: bigint
    if (source) {
      const round = await source.readContract({
        address: CHAINLINK_ETH_USD_BASE,
        abi: chainlinkAggregatorAbi,
        functionName: 'latestRoundData',
      })
      next = round[1]
    } else {
      const drift = (Math.random() - 0.5) * 0.004 // ±0.2%
      const pull = (3000e8 / Number(current) - 1) * 0.02 // weak mean reversion toward $3,000
      next = BigInt(Math.round(Number(current) * (1 + drift + pull)))
    }
    const moveBps = Number(((next > current ? next - current : current - next) * 10_000n) / current)
    if (moveBps >= 5 || now - Number(updatedAt) > 600) {
      await write(ctx, deployer, { address: d.oracle, abi: mockOracleAbi, functionName: 'setAnswer', args: [next] }, 'oracle.setAnswer')
      count('sim', 'oracle')
    }

    // ─── Router ──────────────────────────────────────────────────────────
    const keep = BigInt(10_000 - cfg.sim.routerSpreadBps)
    const usdcToWeth = ((10n ** 38n / next) * keep) / 10_000n // wei per USDC unit, 1e18-scaled
    const wethToUsdc = ((next / 100n) * keep) / 10_000n // USDC units per WETH, 1e18-scaled
    await write(ctx, deployer, { address: d.router, abi: mockSwapRouterAbi, functionName: 'setPrice', args: [d.usdc, d.weth, usdcToWeth] }, 'router.setPrice')
    await write(ctx, deployer, { address: d.router, abi: mockSwapRouterAbi, functionName: 'setPrice', args: [d.weth, d.usdc, wethToUsdc] }, 'router.setPrice')

    // ─── Interest ────────────────────────────────────────────────────────
    for (const m of markets) {
      m.apy = Math.min(15, Math.max(0.5, m.apy + (Math.random() - 0.5) * 0.3 + (m.base - m.apy) * 0.05))
      m.pendingWad += BigInt(Math.round((m.apy / 100) * (dt / YEAR) * cfg.sim.timeScale * 1e18))
      if (m.kind === 'erc4626') {
        const assets = await ctx.client.readContract({ address: m.address, abi: mockLendingVaultAbi, functionName: 'totalAssets' })
        if ((assets * m.pendingWad) / 10n ** 18n < MIN_ACCRUAL_UNITS) continue
      }
      const rateWad = m.pendingWad
      m.pendingWad = 0n
      if (rateWad === 0n) continue
      if (m.kind === 'erc4626') {
        await write(ctx, deployer, { address: m.address, abi: mockLendingVaultAbi, functionName: 'accrueWad', args: [rateWad] }, `${m.name}.accrue`)
      } else {
        await write(ctx, deployer, { address: m.address, abi: mockAavePoolAbi, functionName: 'accrueWad', args: [rateWad] }, `${m.name}.accrue`)
      }
    }
    count('sim', 'ticks')
    log.info('tick', {
      eth: `$${Number(formatUnits(next, 8)).toFixed(2)}`,
      apys: markets.map((m) => `${m.name}:${m.apy.toFixed(2)}%`).join(' '),
    })
  })
}
