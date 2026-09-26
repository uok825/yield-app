/**
 * 1inch SwapVM strategies over wallet liquidity.
 *
 * A wallet that already ships an AquaYieldApp strategy can ship SwapVM orders over the SAME ERC-4626 shares through
 * the same Aqua: an order is `{maker, traits, data}` whose bytecode program runs our `YieldOracleSwap` instruction
 * (oracle ± spread, inventory skew, band, size cap — priced in assets, settled in shares). Orders are discovered from
 * Aqua `Shipped` / `Docked` events for the SwapVM router, decoded, and their programs parsed so bots and the dashboard
 * can show exactly what each wallet runs.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, decodeAbiParameters, getAddress, maxUint256, parseEventLogs, sliceHex, hexToNumber } from 'viem'

import { aquaAbi, swapVMResolverAbi } from './abis.ts'
import { type Context, erc20Abi, revertReason } from './chain.ts'
import { logger } from './log.ts'

const log = logger('swapvm')
const ZERO = '0x0000000000000000000000000000000000000000'

export const OPCODES = { salt: 20, yieldOracleSwap: 64, sequencerGuard: 65 } as const

export interface SwapVMOrder {
  maker: Address
  traits: bigint
  data: Hex
}

export interface YieldOracleSwapArgs {
  stableShare: Address
  volatileShare: Address
  oracle: Address
  maxPriceAge: number
  spreadBps: number
  skewBps: number
  maxTradeBps: number
  targetStableBps: number
  bandBps: number
}

export interface Instruction {
  opcode: number
  name: string
  args: Hex
}

export interface ShippedOrder {
  hash: Hex
  maker: Address
  order: SwapVMOrder
  tokenA: Address
  tokenB: Address
  program: Instruction[]
  params?: YieldOracleSwapArgs
  sequencerFeed?: Address
  docked: boolean
  block: string
}

const orderAbi = [
  {
    type: 'tuple',
    components: [
      { name: 'maker', type: 'address' },
      { name: 'traits', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const

export function swapVMEnabled(ctx: Context): boolean {
  return !!ctx.d.swapVMRouter && ctx.d.swapVMRouter !== ZERO && !!ctx.d.swapVMResolver
}

export function decodeOrder(strategy: Hex): SwapVMOrder {
  const [o] = decodeAbiParameters(orderAbi, strategy)
  return { maker: getAddress(o.maker), traits: o.traits, data: o.data }
}

const NAMES: Record<number, string> = {
  [OPCODES.salt]: 'Salt',
  [OPCODES.yieldOracleSwap]: 'YieldOracleSwap',
  [OPCODES.sequencerGuard]: 'SequencerGuard',
}

/**
 * Parses `[opcode:1][len:1][args:len]…` for orders built by YieldSwapVMStrategies (no maker hooks, so the program is
 * everything after the two token addresses). Returns undefined for anything else.
 */
export function parseProgram(data: Hex): Instruction[] | undefined {
  const bytes = (data.length - 2) / 2
  if (bytes < 40) return undefined
  const out: Instruction[] = []
  let pc = 40
  while (pc < bytes) {
    if (pc + 2 > bytes) return undefined
    const opcode = hexToNumber(sliceHex(data, pc, pc + 1))
    const len = hexToNumber(sliceHex(data, pc + 1, pc + 2))
    if (pc + 2 + len > bytes) return undefined
    out.push({ opcode, name: NAMES[opcode] ?? `op${opcode}`, args: len ? sliceHex(data, pc + 2, pc + 2 + len) : '0x' })
    pc += 2 + len
  }
  return out
}

export function parseYieldOracleSwap(args: Hex): YieldOracleSwapArgs {
  const n = (from: number, to: number) => hexToNumber(sliceHex(args, from, to))
  return {
    stableShare: getAddress(sliceHex(args, 0, 20)),
    volatileShare: getAddress(sliceHex(args, 20, 40)),
    oracle: getAddress(sliceHex(args, 40, 60)),
    maxPriceAge: n(60, 64),
    spreadBps: n(64, 66),
    skewBps: n(66, 68),
    maxTradeBps: n(68, 70),
    targetStableBps: n(70, 72),
    bandBps: n(72, 74),
  }
}

export class SwapVMRegistry {
  private state: { lastBlock: string; orders: Record<Hex, ShippedOrder> }

  constructor(
    private ctx: Context,
    private file = join(ctx.cfg.stateDir, `swapvm-orders-${ctx.chain.id}.json`),
  ) {
    this.state = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'), (k, v) => (k === 'traits' ? BigInt(v) : v))
      : { lastBlock: '0', orders: {} }
  }

  active(): ShippedOrder[] {
    return Object.values(this.state.orders).filter((o) => !o.docked)
  }

  all(): ShippedOrder[] {
    return Object.values(this.state.orders)
  }

  async sync(): Promise<void> {
    const { ctx } = this
    if (!swapVMEnabled(ctx)) return
    const router = getAddress(ctx.d.swapVMRouter!)
    const head = await ctx.client.getBlockNumber()
    let from = BigInt(this.state.lastBlock) + 1n
    if (from === 1n) from = BigInt(ctx.d.deployBlock || Number(head))
    while (from <= head) {
      const to = from + ctx.cfg.logBlockRange - 1n < head ? from + ctx.cfg.logBlockRange - 1n : head
      const logs = await ctx.client.getLogs({ address: ctx.d.aqua, fromBlock: from, toBlock: to })
      for (const ev of parseEventLogs({ abi: aquaAbi, logs, eventName: ['Shipped', 'Docked'] })) {
        if (getAddress(ev.args.app) !== router) continue
        const hash = ev.args.strategyHash
        if (ev.eventName === 'Shipped') {
          try {
            const order = decodeOrder((ev.args as any).strategy)
            const program = parseProgram(order.data)
            const yos = program?.find((i) => i.opcode === OPCODES.yieldOracleSwap)
            const guard = program?.find((i) => i.opcode === OPCODES.sequencerGuard)
            this.state.orders[hash] = {
              hash,
              maker: order.maker,
              order,
              tokenA: getAddress(sliceHex(order.data, 0, 20)),
              tokenB: getAddress(sliceHex(order.data, 20, 40)),
              program: program ?? [],
              params: yos ? parseYieldOracleSwap(yos.args) : undefined,
              sequencerFeed: guard ? getAddress(sliceHex(guard.args, 0, 20)) : undefined,
              docked: false,
              block: String(ev.blockNumber),
            }
            log.info('SwapVM order shipped', { maker: order.maker.slice(0, 10), hash: hash.slice(0, 10), program: program?.map((i) => i.name).join('→') })
          } catch (err) {
            log.warn('undecodable SwapVM order', { hash, error: (err as Error).message })
          }
        } else if (this.state.orders[hash]) {
          this.state.orders[hash].docked = true
        }
      }
      this.state.lastBlock = to.toString()
      from = to + 1n
    }
    writeFileSync(
      this.file + '.tmp',
      JSON.stringify(this.state, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    )
    renameSync(this.file + '.tmp', this.file)
  }
}

/** The maker's SwapVM budgets (Aqua) for an order's two share tokens. */
export async function orderBudgets(ctx: Context, o: ShippedOrder) {
  const read = (token: Address) =>
    ctx.client.readContract({ address: ctx.d.aqua, abi: aquaAbi, functionName: 'rawBalances', args: [o.maker, ctx.d.swapVMRouter!, o.hash, token] })
  const [[a], [b]] = await Promise.all([read(o.tokenA), read(o.tokenB)])
  return { [o.tokenA]: BigInt(a), [o.tokenB]: BigInt(b) } as Record<Address, bigint>
}

const erc4626Lite = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'previewWithdraw', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToShares', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const

const assetCache = new Map<Address, Address>()
export async function shareAsset(ctx: Context, share: Address): Promise<Address> {
  if (!assetCache.has(share)) {
    assetCache.set(share, getAddress(await ctx.client.readContract({ address: share, abi: erc4626Lite, functionName: 'asset' })))
  }
  return assetCache.get(share)!
}

export { erc4626Lite }

/**
 * Plan a SwapVM fill of a Fusion order: the resolver must deliver `taking` of `takerAsset` and receives `making` of
 * `makerAsset`. Buys the wallet's `takerAsset` shares with freshly minted `makerAsset` shares. Returns the args for
 * SwapVMResolver.executeSwap (without calls / minProfit), or undefined if this order can't serve it.
 */
export async function planSwapVMFill(
  ctx: Context,
  o: ShippedOrder,
  makerAsset: Address,
  takerAsset: Address,
  taking: bigint,
) {
  const [assetA, assetB] = await Promise.all([shareAsset(ctx, o.tokenA), shareAsset(ctx, o.tokenB)])
  let shareOut: Address, shareIn: Address
  if (assetA === getAddress(takerAsset) && assetB === getAddress(makerAsset)) [shareOut, shareIn] = [o.tokenA, o.tokenB]
  else if (assetB === getAddress(takerAsset) && assetA === getAddress(makerAsset)) [shareOut, shareIn] = [o.tokenB, o.tokenA]
  else return undefined
  const sharesOut = await ctx.client.readContract({ address: shareOut, abi: erc4626Lite, functionName: 'previewWithdraw', args: [taking] })
  const [budgets, walletShares, allowance] = await Promise.all([
    orderBudgets(ctx, o),
    ctx.client.readContract({ address: shareOut, abi: erc20Abi, functionName: 'balanceOf', args: [o.maker] }),
    ctx.client.readContract({ address: shareOut, abi: erc20Abi, functionName: 'allowance', args: [o.maker, ctx.d.aqua] }),
  ])
  if (budgets[shareOut] < sharesOut || walletShares < sharesOut || allowance < sharesOut) return undefined
  return { shareOut, shareIn, sharesOut, maxSharesIn: maxUint256 }
}

export function orderTuple(o: ShippedOrder) {
  return { maker: o.order.maker, traits: BigInt(o.order.traits), data: o.order.data }
}

export { swapVMResolverAbi, revertReason }
