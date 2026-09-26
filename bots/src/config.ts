import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Address, Hex } from 'viem'

/** Shape of contracts/deployments/<chainId>.json written by script/Deploy.s.sol. */
export interface Deployment {
  mock: boolean
  deployBlock: number
  usdc: Address
  weth: Address
  aqua: Address
  resolver: Address
  router: Address
  orderBook: Address
  limitOrderProtocol: Address
  fusionSettlement: Address
  fusionAccessToken: Address
  // Strategy A
  vault: Address
  app: Address
  adapters: Address[]
  strategyHash: Hex
  flashFeeBps: number
  morphoMarket: Address
  fluidMarket: Address
  aavePool: Address
  aaveAToken: Address
  // Strategy B
  oracle: Address
  swapApp: Address
  aaveWethPool: Address
  inventoryVaults: Address[]
  inventoryStrategyHashes: Hex[]
  spreadBps: number
  skewBps: number
  maxTradeBps: number
}

const here = dirname(fileURLToPath(import.meta.url))
const ZERO = '0x0000000000000000000000000000000000000000'

function env(name: string, fallback?: string): string {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required env var ${name}`)
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`)
  return n
}

function optionalKey(name: string): Hex | undefined {
  const value = process.env[name]
  if (!value) return undefined
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Env var ${name} must be a 0x-prefixed 32-byte private key`)
  return value as Hex
}

export function loadDeployment(chainId: number, file?: string): Deployment {
  const path = resolve(file ?? join(here, `../../contracts/deployments/${chainId}.json`))
  if (!existsSync(path)) {
    throw new Error(`No deployment file at ${path}. Run contracts/script/Deploy.s.sol first or set DEPLOYMENTS_FILE.`)
  }
  const d = JSON.parse(readFileSync(path, 'utf8')) as Deployment
  d.deployBlock = Number(d.deployBlock ?? 0)
  d.flashFeeBps = Number(d.flashFeeBps)
  d.spreadBps = Number(d.spreadBps)
  d.skewBps = Number(d.skewBps)
  d.maxTradeBps = Number(d.maxTradeBps)
  for (const key of ['limitOrderProtocol', 'fusionSettlement', 'resolver', 'usdc'] as const) {
    if (!d[key] || d[key] === ZERO) throw new Error(`Deployment is missing "${key}" — redeploy with the current Deploy.s.sol`)
  }
  return d
}

export function loadConfig() {
  return {
    rpcUrl: env('RPC_URL'),
    deploymentsFile: process.env.DEPLOYMENTS_FILE,
    stateDir: resolve(env('STATE_DIR', join(here, '../.state'))),
    explorerUrl: process.env.EXPLORER_URL ?? '',
    /** Max block span per eth_getLogs call (public Base RPC allows 1,000). */
    logBlockRange: BigInt(num('LOG_BLOCK_RANGE', 500)),

    keys: {
      deployer: optionalKey('DEPLOYER_PRIVATE_KEY'),
      keeper: optionalKey('KEEPER_PRIVATE_KEY'),
      operator: optionalKey('OPERATOR_PRIVATE_KEY'),
    },
    makerMnemonic: process.env.MAKER_MNEMONIC,
    makerCount: num('MAKER_COUNT', 4),
    /** First HD index for maker wallets — keep clear of indices used by role keys from the same mnemonic. */
    makerIndexOffset: num('MAKER_INDEX_OFFSET', 0),

    relayer: {
      url: env('RELAYER_URL', 'http://127.0.0.1:8080'),
      host: env('RELAYER_HOST', '0.0.0.0'),
      port: num('RELAYER_PORT', 8080),
      pollMs: num('RELAYER_POLL_MS', 4_000),
    },
    resolver: {
      pollMs: num('RESOLVER_POLL_MS', 2_000),
      minProfitUsd: num('RESOLVER_MIN_PROFIT_USD', 0.01),
      /** Minimum net margin over the order's notional before filling (don't fill at break-even). */
      minMarginBps: num('RESOLVER_MIN_MARGIN_BPS', 5),
      /** On-chain minProfit = simulated profit × (1 − this). Protects against being front-run into a loss. */
      profitToleranceBps: num('RESOLVER_PROFIT_TOLERANCE_BPS', 5_000),
    },
    keeper: {
      intervalMs: num('KEEPER_INTERVAL_MS', 60_000),
      apyWindowSec: num('KEEPER_APY_WINDOW_SEC', 600),
      rebalanceThresholdBps: num('KEEPER_REBALANCE_THRESHOLD_BPS', 100),
      /** Reorder the withdraw queue only when APYs are out of order by more than this (percentage points). */
      queueHysteresisPct: num('KEEPER_QUEUE_HYSTERESIS_PCT', 0.25),
      idleBufferBps: num('KEEPER_IDLE_BUFFER_BPS', 3_000),
      maxSwapSlippageBps: num('KEEPER_MAX_SWAP_SLIPPAGE_BPS', 30),
      trustScores: JSON.parse(env('KEEPER_TRUST_SCORES', '{}')) as Record<string, number>,
    },
    maker: {
      intervalMs: num('MAKER_INTERVAL_MS', 15_000),
      minUsd: num('MAKER_ORDER_MIN_USD', 200),
      maxUsd: num('MAKER_ORDER_MAX_USD', 3_000),
      auctionDurationSec: num('MAKER_AUCTION_DURATION_SEC', 120),
      auctionDelaySec: num('MAKER_AUCTION_DELAY_SEC', 2),
      startPremiumBps: num('MAKER_AUCTION_START_PREMIUM_BPS', 50),
      minDiscountBps: num('MAKER_AUCTION_MIN_DISCOUNT_BPS', 100),
    },
    sim: {
      intervalMs: num('SIM_INTERVAL_MS', 30_000),
      priceSourceRpcUrl: process.env.PRICE_SOURCE_RPC_URL ?? '',
      /** Simulated DEX cost (pool fee + price impact) on each side of the mock router. */
      routerSpreadBps: num('SIM_ROUTER_SPREAD_BPS', 10),
      timeScale: num('SIM_TIME_SCALE', 1),
      marketApys: JSON.parse(env('SIM_MARKET_APYS', '{"morpho":6.5,"aave":4.2,"fluid":5.4,"aaveWeth":2.1}')) as Record<
        string,
        number
      >,
    },
  }
}

export type Config = ReturnType<typeof loadConfig>
