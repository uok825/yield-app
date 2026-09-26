/**
 * End-to-end run on a local chain:
 *   anvil (1s blocks) → forge Deploy (mock mode, separate keeper/operator keys) → setup + seed
 *   → relayer, sim, keeper, resolver and maker bots for E2E_SECONDS → assertions → teardown.
 *
 *   npm run e2e                  (needs anvil + forge on PATH or in ~/.foundry/bin)
 *   E2E_SECONDS=180 npm run e2e
 *   E2E_FORK_URL=https://sepolia.base.org PRICE_SOURCE_RPC_URL=https://mainnet.base.org npm run e2e
 *                                (fork Base Sepolia: real chain id 84532, oracle mirrors Chainlink on Base)
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, formatUnits, http } from 'viem'
import { english, generateMnemonic } from 'viem/accounts'

const here = dirname(fileURLToPath(import.meta.url))
const contracts = join(here, '../../contracts')
const foundryBin = (name: string) => {
  const local = join(homedir(), '.foundry/bin', name)
  return spawnSync('test', ['-x', local]).status === 0 ? local : name
}

const PORT = Number(process.env.E2E_ANVIL_PORT ?? 8555)
const RELAYER_PORT = Number(process.env.E2E_RELAYER_PORT ?? 8095)
const SECONDS = Number(process.env.E2E_SECONDS ?? 120)
const RPC = `http://127.0.0.1:${PORT}`
const FORK_URL = process.env.E2E_FORK_URL ?? ''
let deploymentFile = ''
let broadcastDir = ''
const startedAt = Date.now()
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  keeper: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  operator: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
}
const ADDR = { keeper: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', operator: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }

const children: ChildProcess[] = []
const stateDir = mkdtempSync(join(tmpdir(), 'yieldsolver-e2e-'))

function cleanup() {
  for (const c of children) c.kill('SIGTERM')
  rmSync(stateDir, { recursive: true, force: true })
  // A forked run writes deployments/<real chain id>.json — never leave fork addresses behind for that network.
  if (FORK_URL && deploymentFile && existsSync(deploymentFile)) rmSync(deploymentFile)
  // …nor fork broadcast logs, which would look like real deployments.
  if (FORK_URL && broadcastDir && existsSync(broadcastDir)) {
    for (const f of readdirSync(broadcastDir)) {
      const path = join(broadcastDir, f)
      if (statSync(path).mtimeMs >= startedAt) rmSync(path)
    }
  }
}
process.on('exit', cleanup)

function step(msg: string) {
  console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`)
}

async function waitForRpc() {
  const client = createPublicClient({ transport: http(RPC) })
  for (let i = 0; i < 60; i++) {
    try {
      return await client.getChainId()
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('anvil did not start')
}

async function main() {
  step(`anvil on ${RPC} (${FORK_URL ? `automine, fork of ${FORK_URL}` : '1s blocks'})`)
  // Local: 1s blocks like a real chain. Fork: automine — interval mining makes every forge/anvil state read hit the
  // (slow, rate-limited) upstream RPC for a moving block, which times out on public endpoints.
  const anvilArgs = ['--port', String(PORT), '--silent']
  if (FORK_URL) anvilArgs.push('--fork-url', FORK_URL, '--timeout', '120000', '--retries', '10')
  else anvilArgs.push('--block-time', '1')
  const anvil = spawn(foundryBin('anvil'), anvilArgs, { stdio: 'inherit' })
  children.push(anvil)
  const chainId = await waitForRpc()
  deploymentFile = join(contracts, 'deployments', `${chainId}.json`)
  broadcastDir = join(contracts, 'broadcast', 'Deploy.s.sol', String(chainId))
  if (FORK_URL && existsSync(deploymentFile)) {
    throw new Error(`${deploymentFile} exists (a real deployment?) — refusing to overwrite it with a fork run`)
  }

  step('deploy contracts (forge script, --slow)')
  for (const script of ['Deploy.s.sol', 'DeployWallet.s.sol', 'DeployCarry.s.sol', 'DeploySwapVM.s.sol']) {
    const deploy = spawnSync(
      foundryBin('forge'),
      ['script', `script/${script}`, '--rpc-url', RPC, '--private-key', KEYS.deployer, '--broadcast', '--slow'],
      { cwd: contracts, env: { ...process.env, KEEPER: ADDR.keeper, OPERATOR: ADDR.operator }, encoding: 'utf8' },
    )
    if (deploy.status !== 0) {
      console.error(deploy.stdout, deploy.stderr)
      throw new Error(`${script} failed`)
    }
    console.log(deploy.stdout.split('\n').filter((l) => /\[A\]|\[B\]|LimitOrder|Fusion|Resolver|AquaYield/.test(l)).join('\n'))
  }

  Object.assign(process.env, {
    RPC_URL: RPC,
    STATE_DIR: stateDir,
    DEPLOYER_PRIVATE_KEY: KEYS.deployer,
    KEEPER_PRIVATE_KEY: KEYS.keeper,
    OPERATOR_PRIVATE_KEY: KEYS.operator,
    // Maker wallets: a fresh mnemonic — anvil's well-known one is EIP-7702-swept on public testnets (matters on forks).
    MAKER_MNEMONIC: generateMnemonic(english),
    MAKER_COUNT: '3',
    RELAYER_PORT: String(RELAYER_PORT),
    RELAYER_URL: `http://127.0.0.1:${RELAYER_PORT}`,
    RELAYER_POLL_MS: '2000',
    RESOLVER_POLL_MS: '1000',
    KEEPER_INTERVAL_MS: '8000',
    KEEPER_APY_WINDOW_SEC: '16',
    KEEPER_WALLET_COOLDOWN_SEC: '20',
    SIM_INTERVAL_MS: '4000',
    MAKER_INTERVAL_MS: '3000',
    MAKER_AUCTION_DURATION_SEC: '40',
    MAKER_AUCTION_DELAY_SEC: '1',
    MAKER_ORDER_MAX_USD: '4000',
    ...process.env.E2E_ENV_OVERRIDES ? JSON.parse(process.env.E2E_ENV_OVERRIDES) : {},
  })

  const { createContext } = await import('../src/chain.ts')
  const { setupMakers } = await import('../src/maker.ts')
  const { seed } = await import('../src/seed.ts')
  const { startRelayer } = await import('../src/relayer.ts')
  const { startSim } = await import('../src/sim.ts')
  const { startKeeper } = await import('../src/keeper.ts')
  const { startResolver } = await import('../src/resolver.ts')
  const { startMaker } = await import('../src/maker.ts')
  const { printStatus } = await import('../src/status.ts')
  const { relayerClient } = await import('../src/relayer-client.ts')
  const { yieldVaultAbi, inventoryVaultAbi } = await import('../src/abis.ts')

  const ctx = await createContext()

  step('setup makers + seed LP liquidity')
  await setupMakers(ctx)
  await seed(ctx)

  step(`run all bots for ${SECONDS}s`)
  const controller = new AbortController()
  const bots = [startRelayer(ctx, controller.signal)]
  await new Promise((r) => setTimeout(r, 1500))
  bots.push(
    startSim(ctx, controller.signal),
    startKeeper(ctx, controller.signal),
    startResolver(ctx, controller.signal),
    startMaker(ctx, controller.signal),
  )
  await new Promise((r) => setTimeout(r, SECONDS * 1000))

  step('results')
  await printStatus(ctx)
  const relayer = relayerClient(process.env.RELAYER_URL!)
  const orders = await relayer.orders('?limit=500')
  const filled = orders.filter((o) => o.status === 'filled')
  const byRoute: Record<string, number> = {}
  for (const o of filled) byRoute[o.report?.route?.split(':')[0] ?? 'unreported'] = (byRoute[o.report?.route?.split(':')[0] ?? 'unreported'] ?? 0) + 1
  console.log('orders:', orders.length, 'filled:', filled.length, 'by route:', byRoute)

  const [, assets] = await ctx.client.readContract({ address: ctx.d.vault, abi: yieldVaultAbi, functionName: 'positions' })
  const allocated = assets.reduce((a, b) => a + b, 0n)
  const values = await Promise.all(
    ctx.d.inventoryVaults.map((v) => ctx.client.readContract({ address: v, abi: inventoryVaultAbi, functionName: 'totalValue' })),
  )

  const marketsUsed = Object.keys(byRoute).filter((r) => r !== 'unreported')
  const snap = (await (await fetch(`${process.env.RELAYER_URL}/v1/snapshot`)).json()) as any
  const sc = snap.selfCustody
  const carry = snap.carry
  const swapvm = snap.swapvm
  controller.abort()
  await Promise.allSettled(bots)
  console.log('swapvm:', JSON.stringify(swapvm?.totals), swapvm?.orders?.map((o: any) => `${o.maker.slice(0, 8)} ${o.stable?.name}/${o.volatile?.name} ${o.program.map((i: any) => i.name).join('→')} fills ${o.fills}`))
  console.log('carry:', JSON.stringify({ status: carry?.status, ltv: carry?.ltvPct, debt: carry?.debtUsd, pnl: carry?.carryPnlUsd, borrowApr: carry?.borrowApr, counts: carry?.counts, decision: carry?.decision?.reason }))
  console.log('self-custody:', JSON.stringify(sc?.totals), sc?.strategies?.map((x: any) => `${x.maker.slice(0, 8)} $${x.valueUsd} earned $${x.earned.totalUsd} rebalances ${x.counts.rebalances} in ${x.positions.map((p: any) => p.name + '/' + p.asset).join(',')}`))
  const checks: [string, boolean][] = [
    ['makers posted orders', orders.length >= 5],
    ['resolver filled most orders', filled.length >= Math.max(3, Math.floor(orders.length * 0.5))],
    ['every filled order has a route report', filled.every((o) => !!o.report)],
    ['keeper allocated strategy A capital', allocated > 0n],
    ['both strategies filled orders (jit + inventory)', marketsUsed.includes('jit') && marketsUsed.includes('inventory')],
    ['inventory vaults hold value', values.every((v) => v > 0n)],
    ['self-custody strategies shipped from wallets', (sc?.totals?.wallets ?? 0) >= 2],
    ['orders filled from wallet liquidity', marketsUsed.some((r) => r.startsWith('wallet-'))],
    ['keeper moved wallet shares to a better market', (sc?.totals?.rebalances ?? 0) >= 1],
    ['self-custody LPs earned', (sc?.totals?.earnedUsd ?? 0) > 0],
    ['wallets shipped SwapVM orders over the same shares', (swapvm?.totals?.orders ?? 0) >= 2 && (swapvm?.orders ?? []).every((o: any) => o.program.some((i: any) => i.name === 'YieldOracleSwap'))],
    ['orders filled through SwapVM (YieldOracleSwap)', marketsUsed.includes('swapvm') && (swapvm?.totals?.fills ?? 0) >= 1],
    ['SwapVM makers earned the spread', (swapvm?.totals?.spreadUsd ?? 0) > 0],
    ['carry keeper decided with live rates', !!carry?.decision && carry.decision.spreadPct !== null],
    ['carry opened only on positive spread', (carry?.counts?.Opened ?? 0) >= 1 && carry.ltvPct <= carry.maxLtvPct],
    ['carry position earned more than its debt', carry?.status !== 'on' || carry.carryPnlUsd >= 0],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`${pass ? '\x1b[32m✓' : '\x1b[31m✗'} ${name}\x1b[0m`)
    ok &&= pass
  }
  console.log(`A allocated: ${formatUnits(allocated, 6)} USDC`)
  process.exitCode = ok ? 0 : 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    cleanup()
    setTimeout(() => process.exit(), 500)
  })
