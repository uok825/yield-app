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
const TRANSIENT = /nonce too low|replacement transaction underpriced|already known|timeout|ECONNRESET|fetch failed|HTTP request failed|rate limit|429|503/i

/**
 * Simulates, sends and waits for a contract write. Reverts surface as decoded errors before anything is broadcast.
 * Transient RPC / nonce errors are retried with a fresh nonce.
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
    try {
      // Headroom over the estimate: a lagging RPC node can estimate against older state (e.g. a storage slot that is
      // still zero there costs 20k more to write). Gas on Base is cheap; out-of-gas reverts are not.
      if (params.gas === undefined) {
        const estimate = await ctx.client.estimateContractGas({ ...(params as any), account: wallet.account })
        ;(request as any).gas = (estimate * 13n) / 10n + 25_000n
      }
      const hash = await wallet.writeContract(request as any)
      const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== 'success') throw new Error(`${label} reverted on-chain: ${ctx.txUrl(hash)}`)
      log.debug(`${label} mined`, { tx: ctx.txUrl(hash), gas: receipt.gasUsed })
      return receipt
    } catch (err) {
      const reason = revertReason(err)
      if (attempt < 4 && TRANSIENT.test(reason)) {
        nonceManager.reset({ address: wallet.account.address, chainId: ctx.chain.id })
        log.warn(`${label}: transient error, retrying`, { attempt, reason })
        await sleep(1_000 * attempt)
        continue
      }
      throw new Error(`${label} failed: ${reason}`)
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const
