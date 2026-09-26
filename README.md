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
│   ├── main.ts                 # Page layout (A/B views), history seed, simulation loops
│   ├── config.ts               # A: markets, reserve ratio · B: profiles, spread/skew/band · timings
│   ├── types.ts                # A: Market, Fill, State · B: Profile, MmEvent, MmState
│   ├── store.ts                # Minimal reactive stores for A and B (pure updaters)
│   ├── format.ts               # USD / % / number / time formatters, DOM query helper
│   ├── engine/
│   │   ├── vault.ts            # ERC-4626 share math, rebalance (15% reserve), APY drift, draws
│   │   ├── resolver.ts         # Simulated Fusion orders: auction → JIT loan → repay + fee
│   │   └── mm.ts               # B: oracle walk, skewed bid/ask, routing, band checks, keeper, in-kind shares
│   ├── components/
│   │   ├── topbar.ts           # Logo, Base pill, demo label, mock wallet
│   │   ├── switcher.ts         # Strategy A / B selector (remembered in localStorage)
│   │   ├── stats.ts            # Stat rows: A (TVL, APY, JIT fees) and B (TVL, net APY, oracle, fills)
│   │   ├── allocation.ts       # A: stacked bar + market list with sparklines
│   │   ├── profiles.ts         # B: per-profile ratio bar with band, skew, bid/ask, status
│   │   ├── fills.ts            # Recent fills: A (JIT loans) and B (inventory fills, rejects, keeper)
│   │   ├── deposit.ts          # A: deposit / withdraw card and user position
│   │   └── mm-deposit.ts       # B: USDC + ETH deposit with band check, in-kind withdraw
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
