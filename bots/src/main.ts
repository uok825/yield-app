/**
 * Entry point:  tsx src/main.ts <command>
 *
 *   relayer | resolver | keeper | maker | sim   run one bot
 *   all                                         run every bot in this process (relayer first)
 *   setup                                       fund maker wallets with gas (needs DEPLOYER_PRIVATE_KEY)
 *   seed                                        mock only: deposit initial LP liquidity into every vault
 *   order --side buy-eth|sell-eth --usd 1000     post one intent from maker #0
 *   status                                      print both strategies' on-chain state
 */
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'

import { createContext } from './chain.ts'
import { startKeeper } from './keeper.ts'
import { logger } from './log.ts'
import { statuses } from './loop.ts'
import { makers, placeOrder, setupMakers, startMaker, type Side } from './maker.ts'
import { startRelayer } from './relayer.ts'
import { relayerClient } from './relayer-client.ts'
import { startResolver } from './resolver.ts'
import { startSim } from './sim.ts'
import { printStatus } from './status.ts'
import { seed } from './seed.ts'
import { sleep } from './chain.ts'

const log = logger('main')
const BOTS = { relayer: startRelayer, sim: startSim, keeper: startKeeper, resolver: startResolver, maker: startMaker }

async function waitForRelayer(url: string, signal: AbortSignal) {
  for (let i = 0; !signal.aborted; i++) {
    try {
      await relayerClient(url).health()
      return
    } catch {
      if (i % 10 === 0) log.info('waiting for relayer', { url })
      await sleep(1_000)
    }
  }
}

/** Optional per-process health endpoint for container orchestration. */
function serveHealth(port: number) {
  createServer((_, res) => {
    const bots = [...statuses.values()]
    const healthy = bots.every((b) => !b.lastError || (b.lastOkAt ?? 0) > Date.now() - 5 * 60_000)
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ healthy, bots }))
  }).listen(port)
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const controller = new AbortController()
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      log.info(`${sig} received, shutting down`)
      controller.abort()
      setTimeout(() => process.exit(0), 5_000).unref()
    })
  }
  const { signal } = controller

  if (command === 'help' || !(command in BOTS || ['all', 'setup', 'seed', 'order', 'status'].includes(command))) {
    console.log('usage: tsx src/main.ts <relayer|resolver|keeper|maker|sim|all|setup|seed|order|status>')
    process.exitCode = command === 'help' ? 0 : 1
    return
  }

  const ctx = await createContext()
  log.info('connected', { chain: ctx.chain.id, mock: ctx.d.mock, resolver: ctx.d.resolver })
  if (process.env.HEALTH_PORT) serveHealth(Number(process.env.HEALTH_PORT))

  switch (command) {
    case 'setup':
      return setupMakers(ctx)
    case 'status':
      return printStatus(ctx)
    case 'seed':
      return seed(ctx)
    case 'order': {
      const { values } = parseArgs({
        args: rest,
        options: { side: { type: 'string', default: 'buy-eth' }, usd: { type: 'string', default: '1000' }, maker: { type: 'string', default: '0' } },
      })
      const m = makers(ctx)[Number(values.maker)]
      const hash = await placeOrder(ctx, m, values.side as Side, Number(values.usd))
      console.log(`posted ${hash} — follow it at ${ctx.cfg.relayer.url}/v1/orders/${hash}`)
      return
    }
    case 'all': {
      const relayer = startRelayer(ctx, signal)
      await waitForRelayer(ctx.cfg.relayer.url, signal)
      await Promise.all([relayer, startSim(ctx, signal), startKeeper(ctx, signal), startResolver(ctx, signal), startMaker(ctx, signal)])
      return
    }
    default: {
      if (command !== 'relayer' && command !== 'sim' && command !== 'keeper') await waitForRelayer(ctx.cfg.relayer.url, signal)
      await BOTS[command as keyof typeof BOTS](ctx, signal)
    }
  }
}

main().catch((err) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
