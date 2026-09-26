/**
 * Fusion relayer for networks where 1inch runs none (e.g. Base Sepolia).
 *
 * Makers POST signed Fusion orders; the relayer validates them (hash, signature, settlement extension, resolver
 * whitelist, balance/allowance, expiry) and serves them to resolvers. It follows the LimitOrderProtocol for
 * OrderFilled / OrderCancelled events and nonce invalidation, and expires orders past their deadline.
 *
 *   GET  /health                     liveness + chain head
 *   GET  /v1/settings                chain, LOP domain, settlement, whitelisted resolvers
 *   POST /v1/orders                  submit a SignedOrder
 *   GET  /v1/orders/active           pending orders (for resolvers)
 *   GET  /v1/orders?maker=&status=   history
 *   GET  /v1/orders/:hash            one order
 *   POST /v1/orders/:hash/report     resolver fill report (route, profit) — informational
 *   GET  /v1/snapshot                both strategies' state, APYs and fee income (for dashboards)
 *   POST /v1/quote                   build an unsigned Fusion order for a wallet to sign (EIP-712)
 *   GET  /v1/stats                   counters
 *   GET  /v1/bots                    status of bots running in this process
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, getAddress, isAddress, parseEventLogs, recoverTypedDataAddress } from 'viem'
import { buildOrderTypedData } from '@1inch/limit-order-sdk'
import { Address as OneInchAddress } from '@1inch/fusion-sdk'

import { erc20Abi, type Context } from './chain.ts'
import { decodeOrder, lopDomain, orderHash, typedDataFor, type SignedOrder } from './fusion.ts'
import { buildQuote, QuoteError } from './quote.ts'
import { Snapshotter, logSnapshotError } from './snapshot.ts'
import { limitOrderProtocolAbi } from './abis.ts'
import { logger } from './log.ts'
import { count, runEvery, status, statuses } from './loop.ts'

const log = logger('relayer')

export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'expired'

export interface OrderRecord extends SignedOrder {
  status: OrderStatus
  maker: Address
  makerAsset: Address
  takerAsset: Address
  makingAmount: string
  minTakingAmount: string
  auctionStart: number
  auctionEnd: number
  deadline: number
  nonce: string
  createdAt: number
  updatedAt: number
  fillTx?: Hex
  report?: { route: string; profit: string; profitToken: Address; tx: Hex }
}

class ValidationError extends Error {}

export class OrderStore {
  private orders = new Map<Hex, OrderRecord>()
  private dirty = false
  lastBlock = 0n

  constructor(private file: string) {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { lastBlock: string; orders: OrderRecord[] }
      this.lastBlock = BigInt(saved.lastBlock)
      for (const o of saved.orders) this.orders.set(o.orderHash, o)
      log.info('loaded order store', { orders: this.orders.size, lastBlock: this.lastBlock })
    }
  }

  get(hash: Hex) {
    return this.orders.get(hash.toLowerCase() as Hex) ?? this.orders.get(hash)
  }
  all() {
    return [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt)
  }
  put(o: OrderRecord) {
    o.updatedAt = Date.now()
    this.orders.set(o.orderHash, o)
    this.dirty = true
  }
  touch() {
    this.dirty = true
  }

  /** Atomic write (tmp + rename) so a crash never leaves a truncated store. */
  flush() {
    if (!this.dirty) return
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ lastBlock: this.lastBlock.toString(), orders: this.all() }))
    renameSync(tmp, this.file)
    this.dirty = false
  }
}

export async function validateOrder(ctx: Context, body: unknown): Promise<OrderRecord> {
  const s = body as Partial<SignedOrder>
  if (!s || typeof s !== 'object' || !s.order || !s.extension || !s.signature || !s.orderHash) {
    throw new ValidationError('body must be a SignedOrder {orderHash, order, extension, signature}')
  }
  let order
  try {
    order = decodeOrder({ order: s.order, extension: s.extension })
  } catch (err) {
    throw new ValidationError(`cannot decode order/extension: ${(err as Error).message}`)
  }

  const domain = await lopDomain(ctx)
  const hash = orderHash(domain, order)
  if (hash.toLowerCase() !== s.orderHash.toLowerCase()) throw new ValidationError(`orderHash mismatch, expected ${hash}`)

  const td = buildOrderTypedData(domain.chainId, domain.verifyingContract, domain.name, domain.version, order.build())
  const signer = await recoverTypedDataAddress({
    domain: td.domain as any,
    types: { Order: td.types.Order } as any,
    primaryType: 'Order',
    message: td.message as any,
    signature: s.signature,
  })
  const maker = getAddress(order.maker.toString())
  if (signer !== maker) throw new ValidationError(`signature is from ${signer}, not maker ${maker}`)

  const settlement = getAddress(order.settlementExtensionContract.toString())
  if (settlement !== getAddress(ctx.d.fusionSettlement)) throw new ValidationError(`unknown settlement ${settlement}`)
  if (!order.fusionExtension.whitelist.isWhitelisted(new OneInchAddress(ctx.d.resolver))) {
    throw new ValidationError('order whitelist does not include the YieldSolver resolver')
  }
  if (order.partialFillAllowed || order.multipleFillsAllowed) throw new ValidationError('partial fills are not supported')

  const now = (await ctx.client.getBlock()).timestamp
  if (order.deadline <= now) throw new ValidationError('order already expired')

  const makerAsset = getAddress(order.makerAsset.toString())
  // Re-read a few times before rejecting: makers often approve/fund right before posting, and a load-balanced RPC
  // can still answer from a node that hasn't seen that block.
  for (let attempt = 1; ; attempt++) {
    const [balance, allowance] = await Promise.all([
      ctx.client.readContract({ address: makerAsset, abi: erc20Abi, functionName: 'balanceOf', args: [maker] }),
      ctx.client.readContract({
        address: makerAsset,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [maker, ctx.d.limitOrderProtocol],
      }),
    ])
    if (balance >= order.makingAmount && allowance >= order.makingAmount) break
    if (attempt >= 3) {
      if (balance < order.makingAmount) throw new ValidationError('maker balance below makingAmount')
      throw new ValidationError('maker has not approved the LimitOrderProtocol')
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }

  const t = Date.now()
  return {
    orderHash: hash,
    order: s.order,
    extension: s.extension,
    signature: s.signature,
    status: 'pending',
    maker,
    makerAsset,
    takerAsset: getAddress(order.takerAsset.toString()),
    makingAmount: order.makingAmount.toString(),
    minTakingAmount: order.takingAmount.toString(),
    auctionStart: Number(order.auctionStartTime),
    auctionEnd: Number(order.auctionEndTime),
    deadline: Number(order.deadline),
    nonce: order.nonce.toString(),
    createdAt: t,
    updatedAt: t,
  }
}

/** Applies LOP events and expiry to the store. */
async function syncChain(ctx: Context, store: OrderStore) {
  const head = await ctx.client.getBlockNumber()
  if (store.lastBlock === 0n) store.lastBlock = BigInt(ctx.d.deployBlock || Number(head))
  let from = store.lastBlock + 1n
  while (from <= head) {
    const to = from + ctx.cfg.logBlockRange - 1n < head ? from + ctx.cfg.logBlockRange - 1n : head
    const logs = await ctx.client.getLogs({ address: ctx.d.limitOrderProtocol, fromBlock: from, toBlock: to })
    for (const ev of parseEventLogs({ abi: limitOrderProtocolAbi, logs, eventName: ['OrderFilled', 'OrderCancelled'] })) {
      const o = store.get(ev.args.orderHash)
      if (!o || o.status !== 'pending') continue
      if (ev.eventName === 'OrderFilled' && ev.args.remainingAmount === 0n) {
        o.status = 'filled'
        o.fillTx = ev.transactionHash
        count('relayer', 'filled')
        log.info('order filled', { order: o.orderHash.slice(0, 10), tx: ctx.txUrl(ev.transactionHash) })
      } else if (ev.eventName === 'OrderCancelled') {
        o.status = 'cancelled'
        count('relayer', 'cancelled')
      }
      store.put(o)
    }
    store.lastBlock = to
    store.touch()
    from = to + 1n
  }

  const now = Number((await ctx.client.getBlock({ blockNumber: head })).timestamp)
  for (const o of store.all()) {
    if (o.status !== 'pending') continue
    if (o.deadline <= now) {
      o.status = 'expired'
      count('relayer', 'expired')
      store.put(o)
      continue
    }
    // Nonce-based cancellation (bit invalidator) emits no OrderCancelled.
    const nonce = BigInt(o.nonce)
    const slot = await ctx.client.readContract({
      address: ctx.d.limitOrderProtocol,
      abi: limitOrderProtocolAbi,
      functionName: 'bitInvalidatorForOrder',
      args: [o.maker, nonce >> 8n],
    })
    if ((slot >> (nonce & 0xffn)) & 1n && !o.fillTx) {
      o.status = 'cancelled'
      store.put(o)
    }
  }
  store.flush()
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64_000) throw new ValidationError('body too large')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new ValidationError('invalid JSON')
  }
}

export async function startRelayer(ctx: Context, signal: AbortSignal) {
  const { cfg } = ctx
  mkdirSync(cfg.stateDir, { recursive: true })
  const store = new OrderStore(join(cfg.stateDir, `relayer-${ctx.chain.id}.json`))
  const domain = await lopDomain(ctx)
  const snapshot = new Snapshotter(ctx)
  status('relayer')

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '')
    try {
      if (req.method === 'OPTIONS') return send(res, 204, {})
      if (req.method === 'GET' && (path === '/health' || path === '')) {
        return send(res, 200, { ok: true, chainId: ctx.chain.id, lastBlock: store.lastBlock })
      }
      if (req.method === 'GET' && path === '/v1/settings') {
        return send(res, 200, {
          chainId: ctx.chain.id,
          domain,
          limitOrderProtocol: ctx.d.limitOrderProtocol,
          settlement: ctx.d.fusionSettlement,
          resolvers: ctx.d.walletResolver ? [ctx.d.resolver, ctx.d.walletResolver] : [ctx.d.resolver],
          tokens: { usdc: ctx.d.usdc, weth: ctx.d.weth },
        })
      }
      if (req.method === 'POST' && path === '/v1/orders') {
        const record = await validateOrder(ctx, await readBody(req))
        if (store.get(record.orderHash)) return send(res, 409, { error: 'order already known' })
        store.put(record)
        store.flush()
        count('relayer', 'accepted')
        log.info('order accepted', {
          order: record.orderHash.slice(0, 10),
          maker: record.maker.slice(0, 8),
          making: record.makingAmount,
        })
        return send(res, 201, { orderHash: record.orderHash })
      }
      if (req.method === 'GET' && path === '/v1/orders/active') {
        return send(res, 200, { items: store.all().filter((o) => o.status === 'pending') })
      }
      if (req.method === 'GET' && path === '/v1/orders') {
        const maker = url.searchParams.get('maker')
        const st = url.searchParams.get('status')
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500)
        const items = store
          .all()
          .filter((o) => (!maker || o.maker.toLowerCase() === maker.toLowerCase()) && (!st || o.status === st))
          .slice(0, limit)
        return send(res, 200, { items })
      }
      const m = path.match(/^\/v1\/orders\/(0x[0-9a-fA-F]{64})(\/report)?$/)
      if (m && req.method === 'GET' && !m[2]) {
        const o = store.get(m[1] as Hex)
        return o ? send(res, 200, o) : send(res, 404, { error: 'not found' })
      }
      if (m && req.method === 'POST' && m[2]) {
        const o = store.get(m[1] as Hex)
        if (!o) return send(res, 404, { error: 'not found' })
        const r = (await readBody(req)) as OrderRecord['report']
        if (!r || typeof r.route !== 'string' || !isAddress(r.profitToken ?? '')) {
          throw new ValidationError('report must be {route, profit, profitToken, tx}')
        }
        o.report = { route: r.route.slice(0, 64), profit: String(r.profit), profitToken: r.profitToken, tx: r.tx }
        store.put(o)
        store.flush()
        return send(res, 200, { ok: true })
      }
      if (req.method === 'GET' && path === '/v1/snapshot') {
        return send(res, 200, await snapshot.get())
      }
      if (req.method === 'POST' && path === '/v1/quote') {
        const b = (await readBody(req)) as Record<string, string>
        for (const k of ['maker', 'makerAsset', 'takerAsset']) {
          if (!isAddress(b?.[k] ?? '')) throw new ValidationError(`${k} must be an address`)
        }
        if (!/^\d+$/.test(String(b.makingAmount ?? ''))) throw new ValidationError('makingAmount must be an integer string')
        try {
          const q = await buildQuote(ctx, {
            maker: b.maker as Address,
            makerAsset: b.makerAsset as Address,
            takerAsset: b.takerAsset as Address,
            makingAmount: BigInt(b.makingAmount),
          })
          count('relayer', 'quotes')
          return send(res, 200, {
            orderHash: orderHash(domain, q.order),
            order: q.order.build(),
            extension: q.order.extension.encode(),
            typedData: typedDataFor(domain, q.order),
            quote: {
              fairTaking: q.fairTaking,
              startTaking: q.startTaking,
              minTaking: q.minTaking,
              auctionStart: q.auctionStart,
              auctionEnd: q.auctionEnd,
              ethUsd: q.ethUsd,
            },
          })
        } catch (err) {
          if (err instanceof QuoteError) throw new ValidationError(err.message)
          throw err
        }
      }
      if (req.method === 'GET' && path === '/v1/stats') {
        const byStatus: Record<string, number> = {}
        for (const o of store.all()) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1
        return send(res, 200, { orders: byStatus, lastBlock: store.lastBlock })
      }
      if (req.method === 'GET' && path === '/v1/bots') {
        return send(res, 200, { bots: [...statuses.values()] })
      }
      send(res, 404, { error: 'not found' })
    } catch (err) {
      if (err instanceof ValidationError) {
        count('relayer', 'rejected')
        log.warn('order rejected', { reason: err.message })
        return send(res, 400, { error: err.message })
      }
      log.error('request failed', { path, error: (err as Error).message })
      send(res, 500, { error: 'internal error' })
    }
  })

  await new Promise<void>((resolve) => server.listen(cfg.relayer.port, cfg.relayer.host, resolve))
  log.info('listening', { url: `http://${cfg.relayer.host}:${cfg.relayer.port}`, lop: ctx.d.limitOrderProtocol })
  signal.addEventListener('abort', () => server.close(), { once: true })

  await runEvery('relayer', cfg.relayer.pollMs, signal, async () => {
    await syncChain(ctx, store)
    await snapshot.sync().catch(logSnapshotError)
  })
  store.flush()
}
