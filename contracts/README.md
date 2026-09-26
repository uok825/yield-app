# YieldSolver contracts

ERC-4626 USDC vault that spreads capital over lending markets and lends it just-in-time, through 1inch Aqua,
to a resolver that fills 1inch Fusion orders. The resolver repays principal + fee in the same transaction.

| Contract | Role |
|---|---|
| `YieldVault` | ERC-4626 vault (ysUSDC) and Aqua maker. Keeps a 15% idle reserve, lets the keeper allocate to markets, unwinds markets in withdraw-queue order when liquidity is needed, and checks repayment of every JIT loan. |
| `JitLiquidityApp` | Aqua app. `flash()` asks the vault to free liquidity, `AQUA.pull`s it to the taker, calls back, then requires `amount + fee` pushed back to the vault. |
| `YieldResolver` | Taker. The operator borrows, runs calls against whitelisted targets (LOP / Fusion settlement, routers), repays and keeps the profit. Loss-making runs revert. |
| `adapters/ERC4626Adapter` | Morpho (MetaMorpho) vaults and Fluid fTokens. |
| `adapters/AaveV3Adapter` | Aave V3 pool + aToken. |
| `mocks/*` | Test USDC/WETH, ERC-4626 market, Aave pool, fixed-price router. Deployed only in mock mode (testnets). |

Allocation decisions (APY × trust score) are taken off-chain by the keeper; the contracts enforce the invariants.

## Test

```bash
forge test                                                          # unit, fuzz, invariant (fork tests skipped)
BASE_RPC_URL=https://mainnet.base.org forge test --mc BaseForkTest  # real Aqua, Aave, Fluid, Morpho on Base
```

## Deploy to Base Sepolia

Aqua isn't on Base Sepolia, so the script deploys an unmodified copy of 1inch Aqua plus mock markets.

```bash
cp .env.example .env && source .env
cast wallet import deployer --interactive   # once
forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify
forge script script/Demo.s.sol   --rpc-url base_sepolia --account deployer --broadcast   # deposit → allocate → JIT fill
```

Addresses are written to `deployments/<chainId>.json`. If `OWNER` differs from the deployer, the new owner must call
`acceptOwnership()` on `YieldVault` and `YieldResolver`.

For Base mainnet, set the live-mode variables in `.env` (addresses are listed there) and use `--rpc-url base`.
The canonical Aqua deployment is detected automatically.
