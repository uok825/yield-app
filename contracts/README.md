# YieldSolver contracts

Three ways to provide liquidity on 1inch Aqua, all feeding resolvers that fill 1inch Fusion / LOP intents:

- **Self-custody (Aqua-native)** — users keep ERC-4626 lending shares (Morpho / Fluid / Aave-4626) **in their own
  wallet** and ship one `AquaYieldApp` strategy. A keeper moves the shares between the markets they listed toward the
  best APY; resolvers borrow them JIT or buy from them (market making); fees come back to the wallet as shares.
  Tokens only leave the wallet inside a transaction that must return them.

Managed vaults (the pooled variants, tokens held by the vault):

- **A · Yield + JIT** — ERC-4626 USDC vault spread over lending markets. Liquidity is lent just-in-time to the
  resolver and repaid with a fee in the same transaction.
- **B · Inventory MM** — USDC + WETH inventory vaults (profiles 70/30, 50/50, 30/70 USDC/ETH, ±5pp band) that fill
  intents straight from stock at oracle ± spread, skewing prices toward the target ratio. Idle inventory earns
  Aave yield.

| Contract | Role |
|---|---|
| `AquaYieldApp` | Self-custody: Aqua app whose maker is a user wallet holding ERC-4626 shares. `rebalance` (keeper; listed markets of the same asset; value-preserving), `flash` (JIT with fee to the maker), `swapExactOut` (oracle ± spread with skew, band and size limits on the committed budgets). Every payment is deposited and pushed back to the wallet as shares. |
| `Aave4626` | Non-rebasing ERC-4626 wrapper over an Aave V3 reserve, so Aave positions fit fixed Aqua budgets. |
| `WalletResolver` | Taker for `AquaYieldApp` (`executeFlash` / `executeSwap`), same call-whitelist and profit checks as `YieldResolver`. |
| `YieldVault` | ERC-4626 vault (ysUSDC) and Aqua maker. Keeps a 15% idle reserve, lets the keeper allocate to markets, unwinds markets in withdraw-queue order when liquidity is needed, and checks repayment of every JIT loan. |
| `JitLiquidityApp` | Aqua app. `flash()` asks the vault to free liquidity, `AQUA.pull`s it to the taker, calls back, then requires `amount + fee` pushed back to the vault. |
| `InventoryVault` | B: two-asset vault and Aqua maker, one per profile. Deposits valued via oracle (must stay in band or move toward target), withdrawals in kind (no oracle). Checks that every swap leaves it no poorer at the oracle price. Keeper can rebalance through a whitelisted router with a loss cap. |
| `OracleSwapApp` | B: Aqua app. `ask = oracle·(1 + spread − skew)`, `bid = oracle·(1 − spread − skew)`, skew ∝ distance from target (≤ spread, so never worse than oracle). Rejects stale prices, oversized trades and trades that leave the band. |
| `YieldResolver` | Taker for both. `execute` borrows JIT liquidity (A); `executeSwap` buys from inventory (B). Runs calls against whitelisted targets (LOP / Fusion settlement, routers), pays the vault and keeps the profit. Loss-making runs revert. |
| `adapters/ERC4626Adapter` | Morpho (MetaMorpho) vaults and Fluid fTokens. |
| `adapters/AaveV3Adapter` | Aave V3 pool + aToken. |
| `external/FusionContracts.sol` | Pulls the official 1inch LimitOrderProtocol v4 and Fusion `SimpleSettlement` (unmodified submodules, compiled like upstream with via-IR) so they can be deployed where 1inch has none. |
| `mocks/*` | Test USDC/WETH, ERC-4626 market, Aave pool, Chainlink-style oracle, fixed-price router, order book. Deployed only in mock mode (testnets). |

Allocation decisions (APY × trust score) are taken off-chain by the keeper; the contracts enforce the invariants.

## Test

```bash
forge test                                                          # unit, fuzz, invariant (fork tests skipped)
BASE_RPC_URL=https://mainnet.base.org forge test --mc "Base.*Fork"  # real Aqua, Aave, Fluid, Morpho, Chainlink on Base
```

## Deploy to Base Sepolia

Aqua and 1inch Fusion aren't on Base Sepolia, so the script deploys unmodified copies of 1inch Aqua, the Limit Order
Protocol v4 and the Fusion `SimpleSettlement`, plus mock markets, a settable mock ETH/USD oracle (owner = deployer)
and a mock router. Use separate keeper / operator keys: the bots in [`../bots`](../bots) run as those roles.
`--slow` sends one transaction at a time (some RPCs drop parts of large batches).

```bash
cp .env.example .env && source .env
cast wallet import deployer --interactive   # once
KEEPER=<keeper addr> OPERATOR=<operator addr> \
  forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --slow --verify
forge script script/Demo.s.sol   --rpc-url base_sepolia --account deployer --broadcast --slow   # optional one-shot demo
```

Self-custody mode is added on top by `script/DeployWallet.s.sol` (run after `Deploy.s.sol`; `npm run deploy` in
`bots/` runs both). Addresses are written to `deployments/<chainId>.json`. If `OWNER` differs from the deployer, the new owner must call
`acceptOwnership()` on `YieldVault`, each `InventoryVault` and `YieldResolver`.

For Base mainnet, set the live-mode variables in `.env` (addresses are listed there) and use `--rpc-url base`.
The canonical Aqua deployment is detected automatically.
