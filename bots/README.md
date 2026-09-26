# YieldSolver bots

Off-chain side of YieldSolver: a 1inch Fusion relayer, the resolver that fills intents with vault liquidity, the
keeper that manages both strategies, simulated makers, and a testnet world simulator.

```
 maker ──signed Fusion order──▶ relayer ◀──poll── resolver ──executeSwap / execute──▶ YieldResolver
 (users)       POST /v1/orders    │  ▲                │                                   │
                                  │  └─ OrderFilled ──┘                    LimitOrderProtocol v4 + Fusion
                           LOP events                                      SimpleSettlement (official 1inch)
 keeper ──allocate / reallocate / queue / rebalance──▶ YieldVault (A) · InventoryVault ×3 (B)
 sim ──oracle (Chainlink mirror) · router prices · market interest──▶ mocks        (testnets only)
```

| Bot | Key | What it does |
|---|---|---|
| `relayer` | — | Accepts signed Fusion orders, validates them (hash, EIP-712 signature against the deployed LOP domain, settlement, resolver whitelist, balance/allowance, expiry), serves them to resolvers, tracks `OrderFilled` / `OrderCancelled` and nonce invalidation. JSON store with atomic writes. |
| `resolver` | `OPERATOR` | Also prices **self-custody** routes per wallet strategy: `wallet-mm` (buy from a wallet's committed shares via `AquaYieldApp`) and `wallet-jit` (borrow from them), filled through `WalletResolver`. For each active order, computes the current Dutch-auction amount, simulates **B** (buy from each inventory profile via `OracleSwapApp`) and **A** (JIT USDC from the YieldVault + router leg), and fills with the most profitable route once net profit (after gas) clears the floor. `minProfit` is enforced on-chain. |
| `keeper` | `KEEPER` | **Self-custody:** for every wallet strategy naming this keeper, moves each side's shares to the best listed market (apy × trust) when the gain ≥ `KEEPER_WALLET_MIN_GAIN_PCT`, at most once per `KEEPER_WALLET_COOLDOWN_SEC`; shares stay in the wallet. **A:** measures each market's APY from its supply index over a rolling window, moves capital toward `apy × trust`, keeps the reserve, reorders the withdraw queue (with hysteresis). **B:** keeps an idle buffer per asset, lends the rest on Aave, swaps back to target when a profile leaves its band. |
| `resolver` (SwapVM) | `OPERATOR` | Route `swapvm:<maker>`: for wallets that shipped 1inch SwapVM orders (`src/swapvm.ts` discovers them from Aqua `Shipped` events and decodes their bytecode programs), it picks one candidate per wallet: the order whose output share the wallet holds most. It then simulates `SwapVMResolver.executeSwap` and competes on net profit with the other routes. |
| `keeper` (carry) | `KEEPER` | **Conditional carry** (`src/carry.ts`): each tick reads borrow APR, every sink's measured APY (+ haircut incentives) and the vault's LTV, then: deleverage if LTV nears the cap → otherwise **open** only if spread ≥ `CARRY_ENTER_SPREAD_PCT` *and* expected profit over `CARRY_HORIZON_HOURS` ≥ `CARRY_COST_MULTIPLE` × (entry + exit gas + L1 fee), sized ≤ `CARRY_MAX_SINK_SHARE_BPS` of the sink → **close** after the spread stays below `CARRY_EXIT_SPREAD_PCT` for `CARRY_EXIT_CONFIRMATIONS` ticks → rotate to a clearly better sink, top up toward target LTV, harvest profit into WETH. Each decision is written to `STATE_DIR/carry-decision-<chain>.json` and shown in the snapshot. |
| `maker` | `MAKER_MNEMONIC` | Simulated users posting real Fusion orders (USDC⇄WETH) priced off the oracle, auction from +0.5% to −1%. |
| `sim` | `DEPLOYER` | Mock deployments only: mirrors Chainlink ETH/USD from Base mainnet into the mock oracle, keeps the mock router near oracle, accrues interest on mock markets, and drifts the credit market's USDC borrow APR around `SIM_CARRY_BORROW_APR` so carry turns on and off. |

Fusion orders are built and signed with the official `@1inch/fusion-sdk` / `@1inch/limit-order-sdk` against the
official LOP v4 + `SimpleSettlement` contracts. 1inch has no testnet deployment, so on Base Sepolia the contracts
script deploys them (unmodified) and this relayer stands in for the 1inch order API.

## Run on Base Sepolia

You need Foundry, Node ≥ 22 and Base Sepolia ETH on the **deployer** (~0.03 ETH); `npm run setup` forwards gas to
the keeper, operator and maker wallets. Use fresh keys. Never use anvil/hardhat test keys on a public testnet — they are EIP-7702-delegated to sweepers
(the bots refuse to run with such wallets).

```bash
cd bots
npm ci
cp .env.example .env        # fill RPC_URL, the three keys and a fresh MAKER_MNEMONIC (bots load .env themselves)
npm run deploy              # forge Deploy.s.sol with the .env keys → contracts/deployments/84532.json
npm run setup               # gas ETH from the deployer to keeper, operator and makers
npm run seed                # LP liquidity: markets, strategy A, three inventory profiles, self-custody LP wallets
npm run all                 # every bot in one process — or one per terminal:
#   npm run relayer · npm run sim · npm run keeper · npm run resolver · npm run maker
```

`--slow` sends deploy transactions one at a time; without it some RPCs drop part of a large batch.

### Demo commands

```bash
npm run order -- --side buy-eth --usd 1500     # post one intent as maker #0
npm run order -- --side sell-eth --usd 800
npm run status                                 # both strategies, resolver profit, relayer counts
curl localhost:8080/v1/orders?limit=10          # order history with fill tx + route
curl localhost:8080/v1/bots                     # bot health (all-in-one mode)
```

### Docker

```bash
cd bots
docker compose up -d --build        # 5 bot services + dashboard
docker compose ps                   # all should turn healthy within ~1 min
docker compose logs -f resolver     # JSON logs
```

- Dashboard: http://localhost:4173 (the `web` service proxies `/api` to the relayer) · relayer: http://localhost:8080
- One image for all bots, one service per bot; each uses its own key from `.env`. Values meant for the host
  (`RELAYER_URL`, `STATE_DIR`) are overridden in `docker-compose.yml`.
- State lives in `bots/.state` on the host, so you can switch between `npm run all` and Docker without losing
  order history or APY samples — but never run both at once (shared keys → nonce collisions).
- Containers run as non-root; `.env` and `.state` are excluded from every image.
- If your user isn't in the `docker` group, prefix commands with `sudo`.

## Relayer API

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness + last synced block |
| GET | `/v1/settings` | chain id, LOP EIP-712 domain, settlement, whitelisted resolvers, tokens |
| POST | `/v1/orders` | submit `{orderHash, order, extension, signature}` → 201 / 400 with reason |
| GET | `/v1/orders/active` | pending orders |
| GET | `/v1/orders?maker=&status=&limit=` | history |
| GET | `/v1/orders/:hash` | one order |
| POST | `/v1/orders/:hash/report` | resolver fill report (route, profit) |
| GET | `/v1/stats` · `/v1/bots` | counters · in-process bot status |

CORS is open so a dashboard can read it directly.

## Test

```bash
npm test          # unit: allocation math, APY, Fusion order signing / decoding / auction / calldata
npm run e2e       # local anvil: deploy → setup → seed → all bots for 120s → assertions
E2E_FORK_URL=https://sepolia.base.org PRICE_SOURCE_RPC_URL=https://mainnet.base.org npm run e2e
                  # same on a Base Sepolia fork (chain id 84532, Chainlink mirror)
```

The e2e also asserts SwapVM: wallets ship SwapVM orders over the same shares, orders get filled through SwapVM, and
the makers earn the spread. It also asserts the carry module: the keeper decides from live rates, opens only on a positive spread within the
LTV cap, and the position's stable leg covers its debt. The self-custody assertions: wallets ship strategies, orders get filled from wallet liquidity, the
keeper moves wallet shares to a better market and the wallets earn. It asserts that makers post orders, most orders get filled, **both** routes are used, every fill is reported,
the keeper allocates strategy A and the inventories stay funded.

## Operating notes

- **One key per process.** Nonces are managed in-process; two processes sharing a key will collide.
- **Profit safety.** Every fill is simulated first; the transaction carries `minProfit = simulated × (1 −
  RESOLVER_PROFIT_TOLERANCE_BPS)`, and `YieldResolver` reverts loss-making runs.
- **Live mode (Base mainnet).** Leave `USDC` unset only for testnets. On Base the deploy script wires the canonical
  LOP / Fusion settlement / Chainlink / Aqua. Real 1inch Fusion order flow requires being a whitelisted 1inch resolver;
  route A additionally needs a DEX adapter (the bot only prices the mock router), so on mainnet only route B runs.
- **Carry on Base mainnet.** `npm run deploy -- carry` against Base wires Aave V3 (aWETH collateral, USDC variable
  debt, Aave oracle) and the Steakhouse / Gauntlet Prime / Spark USDC Morpho vaults as sinks. Historically the organic
  Morpho − Aave borrow spread is rarely positive; with incentives (`CARRY_SINK_REWARD_APR`, counted at 50%) it is,
  which is exactly why the module is conditional and usually idle. Set `CARRY_ROUTER` to enable harvest.
- **Regenerate ABIs** after changing contracts: `forge build` in `contracts/`, then `npm run abis`.
