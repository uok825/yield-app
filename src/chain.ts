/** viem clients, the injected wallet, balance reads and a transaction helper with readable revert messages. */
import {
  type Abi,
  type ContractFunctionParameters,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  http,
  keccak256,
  maxUint256,
  numberToHex,
  parseEventLogs,
} from 'viem';
import { aave4626Abi, aquaAbi, aquaYieldAppAbi, inventoryVaultAbi, mockERC20Abi, yieldVaultAbi } from '../bots/src/abis.ts';
import type { SelfCustody, Snapshot } from './api.ts';
import { CHAIN, CHAIN_ID, RPC_URL } from './config.ts';
import { units } from './format.ts';
import { type Balances, type ScCommit, type ScHolding, type WalletState, store } from './store.ts';

export const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL, { batch: true, retryCount: 2 }) });

const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
export const walletClient = provider ? createWalletClient({ chain: CHAIN, transport: custom(provider) }) : null;

const FORGET_KEY = 'yieldsolver.disconnected';
const setWallet = (patch: Partial<WalletState>) => store.update((s) => ({ wallet: { ...s.wallet, ...patch } }));

/* ── Wallet ─────────────────────────────── */

function onAccounts(accounts: readonly string[]): void {
  const address = (accounts[0] as Address | undefined) ?? null;
  const prev = store.get().wallet.address;
  setWallet({ address, status: address ? 'connected' : 'disconnected' });
  if (address?.toLowerCase() !== prev?.toLowerCase()) store.update({ balances: null, myOrders: [] });
}

/** Restores a previous connection silently and listens for account / network changes. */
export async function initWallet(): Promise<void> {
  if (!provider) {
    setWallet({ status: 'none' });
    return;
  }
  provider.on?.('accountsChanged', (a) => onAccounts(a));
  provider.on?.('chainChanged', (id) => setWallet({ chainId: Number(id) }));
  try {
    setWallet({ chainId: Number(await provider.request({ method: 'eth_chainId' })) });
    if (!localStorage.getItem(FORGET_KEY)) onAccounts(await provider.request({ method: 'eth_accounts' }));
  } catch {
    /* wallet locked or storage blocked: stay disconnected */
  }
}

export async function connect(): Promise<void> {
  if (!provider) return;
  setWallet({ status: 'connecting' });
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    setWallet({ chainId: Number(await provider.request({ method: 'eth_chainId' })) });
    try {
      localStorage.removeItem(FORGET_KEY);
    } catch {
      /* ignore */
    }
    onAccounts(accounts);
  } catch {
    setWallet({ status: 'disconnected' });
  }
}

/** Wallets can't be disconnected programmatically; forget the account locally instead. */
export function disconnect(): void {
  try {
    localStorage.setItem(FORGET_KEY, '1');
  } catch {
    /* ignore */
  }
  onAccounts([]);
}

export async function switchNetwork(): Promise<void> {
  if (!provider) return;
  const chainId = numberToHex(CHAIN_ID);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code === 4001) throw e;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: 'Base Sepolia',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [RPC_URL.startsWith('http') ? RPC_URL : 'https://sepolia.base.org'],
          blockExplorerUrls: ['https://sepolia.basescan.org'],
        },
      ],
    });
  }
  setWallet({ chainId: Number(await provider.request({ method: 'eth_chainId' })) });
}

/** The connected account on the right chain, or throws a readable error. */
export function account(): Address {
  const w = store.get().wallet;
  if (!w.address || !walletClient) throw new Error('Connect a wallet first.');
  if (w.chainId !== CHAIN_ID) throw new Error('Switch your wallet to Base Sepolia.');
  return w.address;
}

/* ── Reads ──────────────────────────────── */

let reading: Promise<void> | null = null;

/** Wallet balances and strategy positions in two batched multicalls. Concurrent calls share one read. */
export function refreshBalances(): Promise<void> {
  const { wallet, snapshot } = store.get();
  if (!wallet.address || !snapshot) return Promise.resolve();
  reading ??= readBalances(wallet.address, snapshot)
    .then((balances) => {
      if (store.get().wallet.address === wallet.address) store.update({ balances });
    })
    .catch(() => undefined)
    .finally(() => (reading = null));
  return reading;
}

async function readBalances(user: Address, snap: Snapshot): Promise<Balances> {
  const c = snap.contracts;
  const [eth, first] = await Promise.all([
    publicClient.getBalance({ address: user }),
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: c.usdc, abi: mockERC20Abi, functionName: 'balanceOf', args: [user] },
        { address: c.weth, abi: mockERC20Abi, functionName: 'balanceOf', args: [user] },
        { address: c.vault, abi: yieldVaultAbi, functionName: 'balanceOf', args: [user] },
        { address: c.vault, abi: yieldVaultAbi, functionName: 'maxRedeem', args: [user] },
        ...c.inventoryVaults.map((v) => ({ address: v, abi: inventoryVaultAbi, functionName: 'balanceOf', args: [user] })),
      ] as ContractFunctionParameters[],
    }),
  ]);
  const [usdc, weth, aShares, maxRedeem, ...bShares] = first as bigint[];
  const second = (await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: c.vault, abi: yieldVaultAbi, functionName: 'previewRedeem', args: [aShares] },
      ...c.inventoryVaults.map((v, i) => ({ address: v, abi: inventoryVaultAbi, functionName: 'previewRedeem', args: [bShares[i]] })),
    ] as ContractFunctionParameters[],
  })) as unknown as [bigint, ...(readonly [bigint, bigint])[]];
  const [aAssets, ...bOut] = second;
  return {
    eth,
    usdc,
    weth,
    a: { shares: aShares, assets: aAssets, maxRedeem },
    b: bShares.map((shares, i) => ({ shares, stable: bOut[i][0], volatile: bOut[i][1] })),
    sc: snap.selfCustody ? await readSelfCustody(user, snap.selfCustody) : null,
  };
}

/** Aqua stores a docked token with this tokens-count marker. */
const DOCKED = 0xff;

/**
 * Self-custody reads: share balances (+ value, decimals, Aqua allowance) in every listed market, and for each of the
 * wallet's strategy hashes (relayer-known + shipped this session) the committed budgets from Aqua.rawBalances.
 */
async function readSelfCustody(user: Address, sc: SelfCustody): Promise<{ holdings: ScHolding[]; commits: ScCommit[] }> {
  const markets = sc.markets.map((m) => m.address);
  const hashes = [
    ...new Set([
      ...sc.strategies.filter((s) => s.maker.toLowerCase() === user.toLowerCase()).map((s) => s.hash),
      ...(Object.keys(store.get().scLocal) as Hex[]),
    ]),
  ];
  const first = (await publicClient.multicall({
    allowFailure: false,
    contracts: markets.flatMap((m) => [
      { address: m, abi: aave4626Abi, functionName: 'balanceOf', args: [user] },
      { address: m, abi: aave4626Abi, functionName: 'decimals', args: [] },
      { address: m, abi: aave4626Abi, functionName: 'allowance', args: [user, sc.aqua] },
    ]) as ContractFunctionParameters[],
  })) as unknown as (bigint | number)[];
  const second = (await publicClient.multicall({
    allowFailure: false,
    contracts: [
      ...markets.map((m, i) => ({ address: m, abi: aave4626Abi, functionName: 'convertToAssets', args: [first[i * 3] as bigint] })),
      ...hashes.flatMap((h) => markets.map((m) => ({ address: sc.aqua, abi: aquaAbi, functionName: 'rawBalances', args: [user, sc.app, h, m] }))),
    ] as ContractFunctionParameters[],
  })) as unknown as unknown[];
  const holdings = markets.map((address, i) => ({
    address,
    shares: first[i * 3] as bigint,
    decimals: Number(first[i * 3 + 1]),
    aquaAllowance: first[i * 3 + 2] as bigint,
    assets: second[i] as bigint,
  }));
  const commits = hashes.map((hash, h) => {
    const raw = markets.map((market, i) => {
      const [budget, count] = second[markets.length + h * markets.length + i] as readonly [bigint, number];
      return { market, budget, count: Number(count) };
    });
    const live = raw.filter((r) => r.count > 0 && r.count !== DOCKED);
    return { hash, active: live.length > 0, tokens: live.map(({ market, budget }) => ({ market, budget })) };
  });
  return { holdings, commits };
}

/* ── Self-custody strategy encoding ─────── */

const strategyParam = aquaYieldAppAbi.find((x) => x.type === 'function' && x.name === 'strategyHash')!.inputs[0];

export interface ScStrategyParams {
  maker: Address;
  stable: Address;
  volatileAsset: Address;
  stableMarkets: readonly Address[];
  volatileMarkets: readonly Address[];
  keeper: Address;
  taker: Address;
  flashFeeBps: number;
  mm: { oracle: Address; maxPriceAge: number; spreadBps: number; skewBps: number; maxTradeBps: number; targetStableBps: number; bandBps: number };
  salt: Hex;
}

/** ABI-encodes an AquaYieldApp.Strategy exactly like `abi.encode(s)`; the Aqua strategy hash is keccak256 of it. */
export function encodeStrategy(s: ScStrategyParams): { bytes: Hex; hash: Hex } {
  const bytes = encodeAbiParameters([strategyParam], [s as never]);
  return { bytes, hash: keccak256(bytes) };
}

export const allowance = (token: Address, owner: Address, spender: Address) =>
  publicClient.readContract({ address: token, abi: mockERC20Abi, functionName: 'allowance', args: [owner, spender] });

/** Sum of `token` transferred to `to` in a transaction (e.g. what a Fusion fill paid the maker). */
export async function received(hash: Hex, token: Address, to: Address): Promise<bigint> {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  return parseEventLogs({ abi: mockERC20Abi, eventName: 'Transfer', logs: receipt.logs })
    .filter((l) => l.address.toLowerCase() === token.toLowerCase() && l.args.to.toLowerCase() === to.toLowerCase())
    .reduce((s, l) => s + l.args.value, 0n);
}

/* ── Writes ─────────────────────────────── */

export type TxStep =
  | { kind: 'wallet'; label: string } // waiting for the wallet
  | { kind: 'pending'; label: string; hash: Hex } // broadcast, waiting for a receipt
  | { kind: 'info'; label: string };

export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** Simulates (for a decoded revert), sends through the wallet, and waits for the receipt. */
export async function write(call: Call, label: string, on: (s: TxStep) => void): Promise<TransactionReceipt> {
  const from = account();
  on({ kind: 'info', label: `${label}: checking…` });
  const { request } = await publicClient.simulateContract({ ...call, account: from } as never);
  on({ kind: 'wallet', label: `${label}: confirm in your wallet` });
  const hash = await walletClient!.writeContract(request as never);
  on({ kind: 'pending', label: `${label}: pending`, hash });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_500 });
  if (receipt.status !== 'success') throw new Error(`${label} reverted on-chain.`);
  return receipt;
}

/** Approves `spender` if needed, then waits until the public RPC also reports the new allowance. */
export async function ensureAllowance(token: Address, spender: Address, amount: bigint, symbol: string, on: (s: TxStep) => void, max = false): Promise<void> {
  const owner = account();
  if ((await allowance(token, owner, spender)) >= amount) return;
  await write({ address: token, abi: mockERC20Abi, functionName: 'approve', args: [spender, max ? maxUint256 : amount] }, `Approve ${symbol}`, on);
  on({ kind: 'info', label: `Approve ${symbol}: waiting for the RPC to catch up…` });
  for (let i = 0; i < 20; i++) {
    if ((await allowance(token, owner, spender)) >= amount) return;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error('Approval confirmed but not yet visible on the RPC. Try again in a moment.');
}

/* ── Errors ─────────────────────────────── */

const REVERTS: Record<string, (args: readonly unknown[]) => string> = {
  OutOfBand: ([r]) => `That deposit would leave the profile at ${(Number(r) / 100).toFixed(1)}% USDC — outside its band. Add more of the other token.`,
  Slippage: () => 'The price moved since the preview. Try again.',
  ZeroShares: () => 'Amount too small to mint any shares.',
  ZeroAddress: () => 'Invalid address.',
  InsufficientLiquidity: () => 'Not enough idle liquidity right now. Try a smaller amount.',
  ReserveBreached: () => 'That would breach the liquid reserve. Try a smaller amount.',
  SwapActive: () => 'The vault is settling a fill. Try again in a few seconds.',
  LendingActive: () => 'The vault is lending to a fill. Try again in a few seconds.',
  StalePrice: () => 'The ETH oracle price is stale. Try again shortly.',
  EnforcedPause: () => 'The vault is paused.',
  ERC20InsufficientBalance: () => 'Insufficient token balance.',
  ERC20InsufficientAllowance: () => 'Allowance too low (the approval may not be visible yet). Try again.',
  ERC4626ExceededMaxRedeem: () => 'More than can be withdrawn right now. Use Max.',
  ERC4626ExceededMaxDeposit: () => 'Deposits are currently closed.',
  ERC4626ExceededMaxWithdraw: () => 'More than can be withdrawn right now. Use Max.',
  StrategiesMustBeImmutable: () => 'This exact strategy was already shipped. Reload and try again (a new salt is used each time).',
  DockingShouldCloseAllTokens: () => 'Dock must list every token of the strategy. Reload the page and try again.',
  MaxNumberOfTokensExceeded: () => 'Too many markets in one strategy.',
  SafeTransferFromFailed: () => 'A share transfer failed (balance or Aqua approval too low).',
};

export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return 'Rejected in your wallet.';
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert) {
      const name = revert.data?.errorName;
      if (name) return REVERTS[name]?.(revert.data?.args ?? []) ?? `Reverted: ${name}.`;
      return revert.reason ? `Reverted: ${revert.reason}` : 'The transaction would revert.';
    }
    if (/insufficient funds/i.test(e.message)) return 'Not enough Base Sepolia ETH for gas.';
    if (/429|rate limit|unknown RPC error/i.test(e.message)) return 'The RPC is busy (rate-limited). Nothing was sent; try again in a moment.';
    return e.shortMessage;
  }
  if ((e as { code?: number })?.code === 4001) return 'Rejected in your wallet.';
  return e instanceof Error ? e.message : String(e);
}

/* ── Links ──────────────────────────────── */

const explorer = () => store.get().snapshot?.explorer ?? CHAIN.blockExplorers.default.url;
export const txUrl = (hash: string) => `${explorer()}/tx/${hash}`;
export const addrUrl = (a: string) => `${explorer()}/address/${a}`;

/** Oracle-priced USD value of a token amount. */
export function usdValue(v: bigint, token: Address, snap: Snapshot): number {
  return token.toLowerCase() === snap.contracts.weth.toLowerCase() ? units(v, 18) * snap.oracle.price : units(v, 6);
}
