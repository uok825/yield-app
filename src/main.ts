import './style.css';
import { mountAllocation } from './components/allocation.ts';
import { mountDeposit } from './components/deposit.ts';
import { mountFills } from './components/fills.ts';
import { mountStats } from './components/stats.ts';
import { mountTopbar } from './components/topbar.ts';
import { CONFIG } from './config.ts';
import { newOrder, tick } from './engine/resolver.ts';
import { drift, rebalance } from './engine/vault.ts';
import { $ } from './format.ts';
import { store } from './store.ts';

const { intervals } = CONFIG;

/** Replay ~40s of simulated history so the page opens with real (simulated) data. */
function seed(): void {
  for (let i = 0; i < 20; i++) store.update(drift);
  const end = Date.now();
  for (let t = end - 40_000; t <= end; t += intervals.tick) {
    if (t % intervals.newOrder < intervals.tick) store.update((s) => newOrder(s, t));
    if (t % intervals.rebalance < intervals.tick) store.update(rebalance);
    store.update((s) => tick(s, t));
  }
}

function start(): void {
  setInterval(() => store.update((s) => tick(s, Date.now())), intervals.tick);
  setInterval(() => store.update((s) => newOrder(s, Date.now())), intervals.newOrder);
  setInterval(() => store.update(drift), intervals.drift);
  setInterval(() => store.update(rebalance), intervals.rebalance);
}

const app = $(document, '#app');
app.innerHTML = `
  <header class="topbar"></header>
  <main class="page">
    <section class="stats" aria-label="Vault overview"></section>
    <div class="grid">
      <section class="card area-alloc"></section>
      <aside class="card area-deposit"></aside>
      <section class="card area-fills"></section>
    </div>
    <footer class="foot muted">
      USDC vault on Base · allocates across Morpho, Aave V3 and Fluid · lends just-in-time to a 1inch Fusion resolver via Aqua.
    </footer>
  </main>`;

seed();
mountTopbar($(app, '.topbar'));
mountStats($(app, '.stats'));
mountAllocation($(app, '.area-alloc'));
mountFills($(app, '.area-fills'));
mountDeposit($(app, '.area-deposit'));
start();
