import {
  type Abi,
  type Account,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  type Transport,
  BaseError,
  ContractFunctionRevertedError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from 'viem'
import { nonceManager, privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, foundry } from 'viem/chains'

import { type Config, type Deployment, loadConfig, loadDeployment } from './config.ts'
import { logger } from './log.ts'

const log = logger('chain')
const KNOWN: Record<number, Chain> = { [base.id]: base, [baseSepolia.id]: baseSepolia, [foundry.id]: foundry }
const EXPLORERS: Record<number, string> = {
  [base.id]: 'https://basescan.org',
  [baseSepolia.id]: 'https://sepolia.basescan.org',
}

export type Wallet = WalletClient<Transport, Chain, Account>

export interface Context {
  cfg: Config
  chain: Chain
  client: PublicClient<Transport, Chain>
  d: Deployment
  wallet(role: 'deployer' | 'keeper' | 'operator'): Wallet
  walletFor(key: Hex): Wallet
  txUrl(hash: Hex): string
  /** Block explorer base URL ('' if unknown). */
  explorer: string
}

/** Connects to RPC_URL, detects the chain and loads its deployment file. */
export async function createContext(cfg: Config = loadConfig()): Promise<Context> {
  const probe = createPublicClient({ transport: http(cfg.rpcUrl) })
  const chainId = await probe.getChainId()
  const chain =
    KNOWN[chainId] ??
    defineChain({
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    })
  const transport = http(cfg.rpcUrl, { retryCount: 3, timeout: 20_000 })
  const client = createPublicClient({ chain, transport, pollingInterval: chainId === foundry.id ? 250 : 1_000 })
  const d = loadDeployment(chainId, cfg.deploymentsFile)
  const wallets = new Map<Hex, Wallet>()

  const walletFor = (key: Hex): Wallet => {
    let w = wallets.get(key)
    if (!w) {
      w = createWalletClient({ chain, transport, account: privateKeyToAccount(key, { nonceManager }) })
      wallets.set(key, w)
    }
    return w
  }
  const explorer = cfg.explorerUrl || EXPLORERS[chainId] || ''

  return {
    cfg,
    chain,
    client,
    d,
    walletFor,
    wallet(role) {
      const key = cfg.keys[role]
      if (!key) throw new Error(`${role.toUpperCase()}_PRIVATE_KEY is required for this bot`)
      return walletFor(key)
    },
    txUrl: (hash) => (explorer ? `${explorer}/tx/${hash}` : hash),
    explorer,
  }
}

/** Decodes a revert into "ErrorName(args)" when possible. */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      const data = revert.data
      if (data?.errorName) return `${data.errorName}(${(data.args ?? []).map(String).join(', ')})`
      return revert.reason ?? revert.shortMessage
    }
    return err.shortMessage
  }
  return err instanceof Error ? err.message : String(err)
}

const STALE_READ_RETRIES = 4
const MAX_SENDS = 4
const RECEIPT_TIMEOUT_MS = 60_000
const TRANSIENT = /nonce too low|replacement transaction underpriced|already known|timeout|ECONNRESET|fetch failed|HTTP request failed|rate limit|429|503/i

/**
 * Simulates, sends and waits for a contract write. Reverts surface as decoded errors before anything is broadcast.
 * Transient RPC errors and dropped / unmined transactions are re-sent with a resynced nonce and a bumped fee.
 */
export async function write<
  const abi extends Abi,
  name extends ContractFunctionName<abi, 'nonpayable' | 'payable'>,
  args extends ContractFunctionArgs<abi, 'nonpayable' | 'payable', name>,
>(
  ctx: Context,
  wallet: Wallet,
  params: { address: Address; abi: abi; functionName: name; args?: args; value?: bigint; gas?: bigint },
  label = String(params.functionName),
): Promise<TransactionReceipt> {
  let sends = 0
  for (let attempt = 1; ; attempt++) {
    let request
    try {
      ;({ request } = await ctx.client.simulateContract({ ...(params as any), account: wallet.account }))
    } catch (err) {
      // Load-balanced RPCs can answer from a node a block or two behind our last receipt (e.g. an approval
      // that just mined). Re-simulate a few times before treating the revert as real; nothing is broadcast yet.
      if (attempt < STALE_READ_RETRIES) {
        log.debug(`${label}: simulation failed, retrying in case of a lagging RPC node`, { attempt, reason: revertReason(err) })
        await sleep(1_500 * attempt)
        continue
      }
      throw new Error(`${label} failed: ${revertReason(err)}`)
    }

    let hash: Hex | undefined
    try {
      // Headroom over the estimate: a lagging RPC node can estimate against older state (e.g. a storage slot that is
      // still zero there costs 20k more to write). Gas on Base is cheap; out-of-gas reverts are not.
      if (params.gas === undefined) {
        const estimate = await ctx.client.estimateContractGas({ ...(params as any), account: wallet.account })
        ;(request as any).gas = (estimate * 13n) / 10n + 25_000n
      }
      // Re-sends replace a possibly stuck tx with the same nonce, so they need a higher fee.
      if (sends > 0) {
        const fees = await ctx.client.estimateFeesPerGas()
        const bump = BigInt(100 + 25 * sends)
        ;(request as any).maxFeePerGas = (fees.maxFeePerGas! * bump) / 100n
        ;(request as any).maxPriorityFeePerGas = (fees.maxPriorityFeePerGas! * bump) / 100n
      }
      sends++
      hash = await wallet.writeContract(request as any)
      const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
      if (receipt.status !== 'success') throw new OnChainRevert(`${label} reverted on-chain: ${ctx.txUrl(hash)}`)
      log.debug(`${label} mined`, { tx: ctx.txUrl(hash), gas: receipt.gasUsed })
      return receipt
    } catch (err) {
      if (err instanceof OnChainRevert) throw err
      // Whatever happened after a send attempt (RPC error, dropped tx), the local nonce may now be ahead of the
      // chain; left alone, every later tx waits behind a gap forever. Always resync from the chain.
      nonceManager.reset({ address: wallet.account.address, chainId: ctx.chain.id })
      const timedOut = err instanceof WaitForTransactionReceiptTimeoutError
      if (hash && timedOut) {
        const late = await ctx.client.getTransactionReceipt({ hash }).catch(() => undefined)
        if (late?.status === 'success') return late
        if (late) throw new Error(`${label} reverted on-chain: ${ctx.txUrl(hash)}`)
      }
      const reason = revertReason(err)
      if (sends < MAX_SENDS && (timedOut || TRANSIENT.test(reason))) {
        log.warn(`${label}: ${timedOut ? 'not mined in time' : 'transient error'}, re-sending`, { sends, reason })
        await sleep(1_000 * sends)
        continue
      }
      throw new Error(`${label} failed: ${reason}`)
    }
  }
}

class OnChainRevert extends Error {}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const
