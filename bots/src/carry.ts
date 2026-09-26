/**
 * Conditional carry (CarryVault): WETH collateral on Aave, USDC borrowed into the best whitelisted ERC-4626 sink —
 * only while it pays.
 *
 *   decideCarry()  pure policy (unit-tested): safety first (deleverage when LTV drifts up), then
 *                  open when spread ≥ enter threshold AND expected profit over the horizon ≥ costMultiple × gas,
 *                  close after the spread stays below the exit threshold for N ticks (hysteresis),
 *                  rotate to a better sink, top up toward the target LTV, harvest stable profit into WETH.
 *   tickCarry()    reads on-chain state, runs the policy, executes, and records the decision for the dashboard.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, encodeFunctionData, formatUnits } from 'viem'

import { carryVaultAbi, mockCreditMarketAbi, mockSwapRouterAbi } from './abis.ts'
import { type Context, erc20Abi, revertReason, write } from './chain.ts'
import { logger } from './log.ts'
import { count } from './loop.ts'

const log = logger('carry')
const ZERO = '0x0000000000000000000000000000000000000000'

// ─── Pure policy ─────────────────────────────────────────────────────────────

export interface SinkView {
  address: Address
  shares: bigint
  value: bigint // USDC units
  liquid: bigint // withdrawable by the vault now
  cap: bigint
  tvl: bigint // sink total assets
  apy: number | undefined // measured supply APY (%)
  rewardApr: number // incentive APR counted (already haircut), %
}

export interface CarryInputs {
  collateralUsd: number
  debt: bigint // USDC units
  stableHeld: bigint // USDC units (idle + sinks)
  ltvBps: number
  maxLtvBps: number
  borrowApr: number | undefined // %
  sinks: SinkView[]
  gasRoundTripUsd: number // open + close
  exitCounter: number
}

export interface CarryParams {
  targetLtvBps: number
  enterSpreadPct: number
  exitSpreadPct: number
  exitConfirmations: number
  horizonHours: number
  costMultiple: number
  maxSinkShareBps: number
  rotateGainPct: number
  minMoveUsd: number
  harvestMinUsd: number
}

export type CarryAction =
  | { kind: 'deleverage'; amount: bigint }
  | { kind: 'open'; sink: Address; amount: bigint }
  | { kind: 'close'; sink: Address; shares: bigint }
  | { kind: 'rotate'; from: Address; to: Address; shares: bigint }
  | { kind: 'harvest'; stableIn: bigint }
  | { kind: 'repayShortfall'; stableShort: bigint }

export interface CarryDecision {
  status: 'off' | 'on'
  reason: string
  spreadPct: number | null
  best?: Address
  targetDebt: bigint
  actions: CarryAction[]
  exitCounter: number
}

const USDC = 1e6
const netApy = (s: SinkView) => (s.apy ?? -Infinity) + s.rewardApr

export function decideCarry(i: CarryInputs, p: CarryParams): CarryDecision {
  const on = i.debt > 0n
  const held = i.sinks.filter((s) => s.shares > 0n)
  const best = [...i.sinks].filter((s) => s.apy !== undefined).sort((a, b) => netApy(b) - netApy(a))[0]
  const targetDebt = BigInt(Math.floor((i.collateralUsd * p.targetLtvBps) / 10_000 * USDC))
  const base = { targetDebt, exitCounter: 0, best: best?.address }

  // 1. Safety: LTV drifted toward the vault's limit (ETH fell) → deleverage back to target.
  if (on && i.ltvBps > i.maxLtvBps - 200) {
    return { ...base, status: 'on', reason: `LTV ${(i.ltvBps / 100).toFixed(1)}% near limit → deleverage`, spreadPct: null, actions: [{ kind: 'deleverage', amount: i.debt - targetDebt }] }
  }
  if (i.borrowApr === undefined || !best) {
    return { ...base, status: on ? 'on' : 'off', reason: 'measuring rates…', spreadPct: null, actions: [] }
  }

  const spreadBest = netApy(best) - i.borrowApr
  const capFor = (s: SinkView) => {
    const byShare = (s.tvl * BigInt(p.maxSinkShareBps)) / 10_000n
    const room = s.cap > s.value ? s.cap - s.value : 0n
    return byShare < room ? byShare : room
  }

  if (!on) {
    if (spreadBest < p.enterSpreadPct) {
      return { ...base, status: 'off', reason: `spread ${spreadBest.toFixed(2)}pp < enter ${p.enterSpreadPct}pp`, spreadPct: spreadBest, actions: [] }
    }
    const amount = [targetDebt, capFor(best)].reduce((a, b) => (a < b ? a : b))
    const usd = Number(amount) / USDC
    const expected = usd * (spreadBest / 100) * (p.horizonHours / 8_760)
    if (usd < p.minMoveUsd) {
      return { ...base, status: 'off', reason: `position $${usd.toFixed(0)} below minimum`, spreadPct: spreadBest, actions: [] }
    }
    if (expected < p.costMultiple * i.gasRoundTripUsd) {
      return { ...base, status: 'off', reason: `expected $${expected.toFixed(2)} over ${p.horizonHours}h < ${p.costMultiple}× gas $${i.gasRoundTripUsd.toFixed(3)}`, spreadPct: spreadBest, actions: [] }
    }
    return { ...base, status: 'on', reason: `open: +${spreadBest.toFixed(2)}pp, expected $${expected.toFixed(2)}/${p.horizonHours}h vs gas $${i.gasRoundTripUsd.toFixed(3)}`, spreadPct: spreadBest, actions: [{ kind: 'open', sink: best.address, amount }] }
  }

  // On: judge the position we actually hold.
  const heldValue = held.reduce((a, s) => a + s.value, 0n)
  const heldApy = heldValue === 0n ? netApy(best) : held.reduce((a, s) => a + netApy(s) * Number(s.value), 0) / Number(heldValue)
  const spreadHeld = heldApy - i.borrowApr
  const actions: CarryAction[] = []

  if (spreadHeld < p.exitSpreadPct) {
    const counter = i.exitCounter + 1
    if (counter < p.exitConfirmations) {
      return { ...base, status: 'on', reason: `spread ${spreadHeld.toFixed(2)}pp < exit ${p.exitSpreadPct}pp (${counter}/${p.exitConfirmations})`, spreadPct: spreadHeld, actions: [], exitCounter: counter }
    }
    for (const s of held) actions.push({ kind: 'close', sink: s.address, shares: s.shares })
    const short = i.debt > i.stableHeld ? i.debt - i.stableHeld : 0n
    if (short > 0n) actions.push({ kind: 'repayShortfall', stableShort: short })
    return { ...base, status: 'off', reason: `close: spread ${spreadHeld.toFixed(2)}pp stayed below ${p.exitSpreadPct}pp`, spreadPct: spreadHeld, actions }
  }

  // Rotate into a clearly better sink.
  for (const s of held) {
    if (s.address !== best.address && netApy(best) - netApy(s) >= p.rotateGainPct && Number(s.value) / USDC >= p.minMoveUsd && capFor(best) >= s.value) {
      actions.push({ kind: 'rotate', from: s.address, to: best.address, shares: s.shares })
    }
  }
  // Top up toward the target LTV while the spread still clears the entry bar.
  const gap = targetDebt > i.debt ? targetDebt - i.debt : 0n
  if (spreadBest >= p.enterSpreadPct && Number(gap) / USDC >= p.minMoveUsd && i.ltvBps < p.targetLtvBps - 300) {
    const room = capFor(best)
    const amount = gap < room ? gap : room
    if (Number(amount) / USDC >= p.minMoveUsd) actions.push({ kind: 'open', sink: best.address, amount })
  }
  // Realise stable profit into collateral.
  const surplus = i.stableHeld > i.debt ? i.stableHeld - i.debt : 0n
  if (Number(surplus) / USDC >= p.harvestMinUsd) actions.push({ kind: 'harvest', stableIn: (surplus * 99n) / 100n })

  return { ...base, status: 'on', reason: actions.length ? `hold +${spreadHeld.toFixed(2)}pp; ${actions.map((a) => a.kind).join(', ')}` : `hold +${spreadHeld.toFixed(2)}pp`, spreadPct: spreadHeld, actions }
}

// ─── On-chain ────────────────────────────────────────────────────────────────

const erc4626Lite = [
  { type: 'function', name: 'previewRedeem', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxWithdraw', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const aaveReserveDataAbi = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { type: 'uint256', name: 'configuration' },
          { type: 'uint128', name: 'liquidityIndex' },
          { type: 'uint128', name: 'currentLiquidityRate' },
          { type: 'uint128', name: 'variableBorrowIndex' },
          { type: 'uint128', name: 'currentVariableBorrowRate' },
          { type: 'uint128', name: 'currentStableBorrowRate' },
          { type: 'uint40', name: 'lastUpdateTimestamp' },
          { type: 'uint16', name: 'id' },
          { type: 'address', name: 'aTokenAddress' },
          { type: 'address', name: 'stableDebtTokenAddress' },
          { type: 'address', name: 'variableDebtTokenAddress' },
          { type: 'address', name: 'interestRateStrategyAddress' },
          { type: 'uint128', name: 'accruedToTreasury' },
          { type: 'uint128', name: 'unbacked' },
          { type: 'uint128', name: 'isolationModeTotalDebt' },
        ],
      },
    ],
  },
] as const

export function carryEnabled(ctx: Context) {
  return !!ctx.d.carryVault && ctx.d.carryVault !== ZERO
}

/** Borrow APR (%) of USDC on the credit pool: MockCreditMarket on testnets, Aave V3 reserve data live. */
export async function borrowApr(ctx: Context): Promise<number> {
  const { d, client } = ctx
  if (d.creditMarket && d.creditMarket !== ZERO) {
    const ray = await client.readContract({ address: d.creditMarket, abi: mockCreditMarketAbi, functionName: 'borrowRate', args: [d.usdc] })
    return Number(ray) / 1e25
  }
  const pool = await client.readContract({ address: d.carryVault!, abi: carryVaultAbi, functionName: 'POOL' })
  const r = await client.readContract({ address: pool, abi: aaveReserveDataAbi, functionName: 'getReserveData', args: [d.usdc] })
  return Number(r.currentVariableBorrowRate) / 1e25
}

export async function readCarry(ctx: Context) {
  const { d, client } = ctx
  const v = d.carryVault!
  const [pos, maxLtv, delevLtv, sinks, supply, totalAssets] = await Promise.all([
    client.readContract({ address: v, abi: carryVaultAbi, functionName: 'position' }),
    client.readContract({ address: v, abi: carryVaultAbi, functionName: 'maxLtvBps' }),
    client.readContract({ address: v, abi: carryVaultAbi, functionName: 'deleverageLtvBps' }),
    client.readContract({ address: v, abi: carryVaultAbi, functionName: 'sinks' }),
    client.readContract({ address: v, abi: carryVaultAbi, functionName: 'totalSupply' }),
    client.readContract({ address: v, abi: carryVaultAbi, functionName: 'totalAssets' }),
  ])
  const [collateral, debt, stableHeld, ltvBps, healthFactor] = pos
  const sinkRows = await Promise.all(
    sinks.map(async (s) => {
      const shares = await client.readContract({ address: s, abi: erc20Abi, functionName: 'balanceOf', args: [v] })
      const [value, liquid, cap, tvl, symbol] = await Promise.all([
        client.readContract({ address: s, abi: erc4626Lite, functionName: 'previewRedeem', args: [shares] }),
        client.readContract({ address: s, abi: erc4626Lite, functionName: 'maxWithdraw', args: [v] }),
        client.readContract({ address: v, abi: carryVaultAbi, functionName: 'sinkCap', args: [s] }),
        client.readContract({ address: s, abi: erc4626Lite, functionName: 'totalAssets' }),
        client.readContract({ address: s, abi: erc20Abi, functionName: 'symbol' }),
      ])
      return { address: s, symbol, shares, value, liquid, cap, tvl }
    }),
  )
  return {
    vault: v,
    collateral,
    debt,
    stableHeld,
    ltvBps: Number(ltvBps),
    healthFactor,
    maxLtvBps: Number(maxLtv),
    deleverageLtvBps: Number(delevLtv),
    totalSupply: supply,
    totalAssets,
    sinks: sinkRows,
  }
}

const decisionFile = (ctx: Context) => join(ctx.cfg.stateDir, `carry-decision-${ctx.chain.id}.json`)

export function lastDecision(ctx: Context): (Omit<CarryDecision, 'actions' | 'targetDebt'> & { t: number; borrowApr: number | null; sinkApys: Record<string, number | null>; executed: string[] }) | null {
  try {
    return existsSync(decisionFile(ctx)) ? JSON.parse(readFileSync(decisionFile(ctx), 'utf8')) : null
  } catch {
    return null
  }
}

let exitCounter = 0

/**
 * One keeper pass. `sinkApy(address)` returns the measured supply APY (%) of a sink or undefined while measuring.
 */
export async function tickCarry(ctx: Context, sinkApy: (sink: Address) => number | undefined, ethUsd: number) {
  const { cfg, client } = ctx
  const keeper = ctx.wallet('keeper')
  const s = await readCarry(ctx)
  const apr = await borrowApr(ctx)
  // Round trip (open + close, ~900k gas) at the current base fee plus a Base-typical tip, plus L1 data fees.
  const { baseFeePerGas } = await client.getBlock()
  const gasPrice = ((baseFeePerGas ?? 0n) * 12n) / 10n + 1_000_000n
  const gasRoundTripUsd = Number(formatUnits(900_000n * gasPrice, 18)) * ethUsd + cfg.carry.l1FeeUsd

  const decision = decideCarry(
    {
      collateralUsd: (Number(s.collateral) / 1e18) * ethUsd,
      debt: s.debt,
      stableHeld: s.stableHeld,
      ltvBps: s.ltvBps,
      maxLtvBps: s.maxLtvBps,
      borrowApr: apr,
      sinks: s.sinks.map((x) => ({
        address: x.address,
        shares: x.shares,
        value: x.value,
        liquid: x.liquid,
        cap: x.cap,
        tvl: x.tvl,
        apy: sinkApy(x.address),
        rewardApr: (cfg.carry.sinkRewardApr[x.address] ?? cfg.carry.sinkRewardApr[x.address.toLowerCase()] ?? 0) * cfg.carry.rewardHaircut,
      })),
      gasRoundTripUsd,
      exitCounter,
    },
    cfg.carry,
  )
  exitCounter = decision.exitCounter

  const executed: string[] = []
  for (const a of decision.actions) {
    try {
      await execute(ctx, keeper, a, ethUsd)
      executed.push(a.kind)
      count('keeper', `C.${a.kind}`)
    } catch (err) {
      log.error(`carry ${a.kind} failed`, { error: revertReason(err) })
      break
    }
  }
  const record = {
    t: Math.floor(Date.now() / 1000),
    status: decision.status,
    reason: decision.reason,
    spreadPct: decision.spreadPct,
    best: decision.best,
    borrowApr: apr,
    sinkApys: Object.fromEntries(s.sinks.map((x) => [x.address, sinkApy(x.address) ?? null])),
    exitCounter: decision.exitCounter,
    executed,
  }
  writeFileSync(decisionFile(ctx), JSON.stringify(record))
  log.info(`carry ${decision.status}: ${decision.reason}`, {
    ltv: `${(s.ltvBps / 100).toFixed(1)}%`,
    debt: formatUnits(s.debt, 6),
    borrowApr: `${apr.toFixed(2)}%`,
  })

}

async function execute(ctx: Context, keeper: ReturnType<Context['wallet']>, a: CarryAction, ethUsd: number) {
  const { d } = ctx
  const v = d.carryVault!
  switch (a.kind) {
    case 'deleverage':
      await write(ctx, keeper, { address: v, abi: carryVaultAbi, functionName: 'deleverage', args: [a.amount] })
      return
    case 'open':
      await write(ctx, keeper, { address: v, abi: carryVaultAbi, functionName: 'open', args: [a.sink, a.amount, 0n] })
      return
    case 'close':
      await write(ctx, keeper, { address: v, abi: carryVaultAbi, functionName: 'close', args: [a.sink, a.shares] })
      return
    case 'rotate':
      await write(ctx, keeper, { address: v, abi: carryVaultAbi, functionName: 'rotate', args: [a.from, a.to, a.shares] })
      return
    case 'harvest': {
      if (!d.router || d.router === ZERO) throw new Error('no router configured for harvest')
      const minOut = BigInt(Math.floor((Number(a.stableIn) / 1e6 / ethUsd) * 0.99 * 1e18))
      const data = encodeFunctionData({ abi: mockSwapRouterAbi, functionName: 'swap', args: [d.usdc, d.weth, a.stableIn, minOut, v] })
      await write(ctx, keeper, { address: v, abi: carryVaultAbi, functionName: 'harvest', args: [d.router, data, a.stableIn, minOut] })
      return
    }
    case 'repayShortfall': {
      if (!d.router || d.router === ZERO) throw new Error('no router configured to repay a shortfall')
      const wethIn = BigInt(Math.ceil((Number(a.stableShort) / 1e6 / ethUsd) * 1.01 * 1e18))
      const minOut = a.stableShort
      const data = encodeFunctionData({ abi: mockSwapRouterAbi, functionName: 'swap', args: [d.weth, d.usdc, wethIn, minOut, v] })
      await write(ctx, keeper, { address: v, abi: carryVaultAbi, functionName: 'repayFromCollateral', args: [d.router, data, wethIn, minOut] })
      return
    }
  }
}
