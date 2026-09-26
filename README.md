# YieldSolver — Dynamic Yield-Optimized Intent Solver on Aqua

Built for **ETHGlobal Tokyo 2026** (Aqua × 1inch Fusion on Base L2).

---

## 🌊 Architecture Overview

```
Katman 1 — Dynamic Yield Maximizer: Multi-protocol APY tracking (Morpho Blue, Aave V3, Fluid) + gas-aware rebalancing on Base L2
Katman 2 — Aqua Strategy:          LP aggregation via Aqua Maker contract (ship() / dock() + 15% liquid JIT reserve buffer)
Katman 3 — 1inch Fusion Resolver:   Dutch auction intent listener + JIT liquidity withdrawal + atomic SwapVM settlement
```

---

## 📁 Project Skeleton

```
aqua-app/
├── index.html                  # Root HTML entry point
├── package.json                # Project scripts and dependencies
├── tsconfig.json               # Modern TypeScript configuration
├── vite.config.ts              # Vite dev server and build configuration
├── public/
│   └── favicon.svg             # Project branding favicon
├── src/
│   ├── main.ts                 # Layout (A/B views + shared sidebar), boot/error states, live polling loops
│   ├── config.ts               # VITE_RPC_URL / VITE_RELAYER_URL, Base Sepolia chain, poll cadence, display names
│   ├── api.ts                  # Relayer client: snapshot, orders, quote, submit (bigint parsing, route helper)
│   ├── chain.ts                # viem public/wallet clients, injected wallet, batched balance reads, tx + revert decoding
│   ├── store.ts                # Minimal reactive store: snapshot, fills, wallet, balances
│   ├── format.ts               # USD / token / bps / time formatters, amount parsing, DOM query helper
│   ├── components/
│   │   ├── topbar.ts           # Logo, "Base Sepolia · live" pill with block pulse, wallet button
│   │   ├── switcher.ts         # Strategy A / B selector (remembered in localStorage)
│   │   ├── stats.ts            # Stat rows: A (TVL, share price, JIT fees, reserve) and B (TVL, oracle, spread income, APY)
│   │   ├── allocation.ts       # A: markets table with allocation bars and the liquid reserve
│   │   ├── profiles.ts         # B: per-profile ratio bar with band, bid/ask, skew, income, status
│   │   ├── fills.ts            # Recent resolver fills: 'jit' route for A, 'inventory:i' routes for B
│   │   ├── intent.ts           # 1inch Fusion intent: quote → approve → sign → live auction tracking
│   │   ├── deposit.ts          # A: ERC-4626 deposit / redeem
│   │   ├── mm-deposit.ts       # B: USDC + WETH deposit with band pre-check, in-kind redeem
│   │   ├── wallet.ts           # Connection, network switch, balances, positions, test-token faucet
│   │   └── tx.ts               # Shared pending / confirmed / failed transaction status line
│   └── style.css               # Design tokens, dark + light themes
└── aqua.md                     # Hackathon project specification
```

---

## 📥 Clone

Contract dependencies are git submodules:
```bash
git clone --recurse-submodules https://github.com/uok825/yield-app.git
# already cloned? → git submodule update --init
```

Smart contracts, tests and deployment: see [`contracts/README.md`](contracts/README.md).
Relayer, resolver, keeper, maker and simulator bots (Base Sepolia runbook): see [`bots/README.md`](bots/README.md).

Whole stack (bots + dashboard) with Docker: `cd bots && docker compose up -d --build` → dashboard on http://localhost:4173.

## ⚡ Development & Scripts (Using Bun)

Install dependencies:
```bash
bun install
```

Start the Vite development server:
```bash
bun run dev
```
Accessible at: `http://localhost:5173/`

Build for production:
```bash
bun run build
```

Preview production build:
```bash
bun run preview
```
