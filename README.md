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
│   ├── main.ts                 # Page layout, history seed, simulation loops
│   ├── config.ts               # Markets (APY, trust score), reserve ratio, timings
│   ├── types.ts                # Market, Fill and State types
│   ├── store.ts                # Minimal reactive store (pure updaters)
│   ├── format.ts               # USD / % / number / time formatters, DOM query helper
│   ├── engine/
│   │   ├── vault.ts            # ERC-4626 share math, rebalance (15% reserve), APY drift, draws
│   │   └── resolver.ts         # Simulated Fusion orders: auction → JIT loan → repay + fee
│   ├── components/
│   │   ├── topbar.ts           # Logo, Base pill, demo label, mock wallet
│   │   ├── stats.ts            # TVL, lending APY, JIT fees, orders filled
│   │   ├── allocation.ts       # Stacked bar + market list with sparklines
│   │   ├── fills.ts            # Recent fills (pair, amount, liquidity source, fee, status)
│   │   └── deposit.ts          # Deposit / withdraw card and user position
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
