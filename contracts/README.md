# YieldSolver contracts

Two strategies on 1inch Aqua, sharing one resolver that fills 1inch Fusion / LOP intents:

- **A · Yield + JIT** — ERC-4626 USDC vault spread over lending markets. Liquidity is lent just-in-time to the
  resolver and repaid with a fee in the same transaction.
- **B · Inventory MM** — USDC + WETH inventory vaults (profiles 70/30, 50/50, 30/70 USDC/ETH, ±5pp band) that fill
  intents straight from stock at oracle ± spread, skewing prices toward the target ratio. Idle inventory earns
  Aave yield.

| Contract | Role |
|---|---|
| `YieldVault` | ERC-4626 vault (ysUSDC) and Aqua maker. Keeps a 15% idle reserve, lets the keeper allocate to markets, unwinds markets in withdraw-queue order when liquidity is needed, and checks repayment of every JIT loan. |
| `JitLiquidityApp` | Aqua app. `flash()` asks the vault to free liquidity, `AQUA.pull`s it to the taker, calls back, then requires `amount + fee` pushed back to the vault. |
| `InventoryVault` | B: two-asset vault and Aqua maker, one per profile. Deposits valued via oracle (must stay in band or move toward target), withdrawals in kind (no oracle). Checks that every swap leaves it no poorer at the oracle price. Keeper can rebalance through a whitelisted router with a loss cap. |
| `OracleSwapApp` | B: Aqua app. `ask = oracle·(1 + spread − skew)`, `bid = oracle·(1 − spread − skew)`, skew ∝ distance from target (≤ spread, so never worse than oracle). Rejects stale prices, oversized trades and trades that leave the band. |
| `YieldResolver` | Taker for both. `execute` borrows JIT liquidity (A); `executeSwap` buys from inventory (B). Runs calls against whitelisted targets (LOP / Fusion settlement, routers), pays the vault and keeps the profit. Loss-making runs revert. |
| `adapters/ERC4626Adapter` | Morpho (MetaMorpho) vaults and Fluid fTokens. |
| `adapters/AaveV3Adapter` | Aave V3 pool + aToken. |
| `mocks/*` | Test USDC/WETH, ERC-4626 market, Aave pool, Chainlink-style oracle, fixed-price router, order book. Deployed only in mock mode (testnets). |

Allocation decisions (APY × trust score) are taken off-chain by the keeper; the contracts enforce the invariants.

## Test

```bash
forge test                                                          # unit, fuzz, invariant (fork tests skipped)
BASE_RPC_URL=https://mainnet.base.org forge test --mc "Base.*Fork"  # real Aqua, Aave, Fluid, Morpho, Chainlink on Base
```

## Deploy to Base Sepolia

Aqua isn't on Base Sepolia, so the script deploys an unmodified copy of 1inch Aqua plus mock markets, a settable
mock ETH/USD oracle (owner = deployer, `setAnswer`) and a mock order book.

```bash
cp .env.example .env && source .env
cast wallet import deployer --interactive   # once
forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify
forge script script/Demo.s.sol   --rpc-url base_sepolia --account deployer --broadcast   # A: JIT fill · B: fills from stock
```

Addresses are written to `deployments/<chainId>.json`. If `OWNER` differs from the deployer, the new owner must call
`acceptOwnership()` on `YieldVault`, each `InventoryVault` and `YieldResolver`.

For Base mainnet, set the live-mode variables in `.env` (addresses are listed there) and use `--rpc-url base`.
The canonical Aqua deployment is detected automatically.
