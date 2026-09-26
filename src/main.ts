import './style.css';
import { mountAllocation } from './components/allocation.ts';
import { mountDeposit } from './components/deposit.ts';
import { mountFills, mountMmFills } from './components/fills.ts';
import { mountMmDeposit } from './components/mm-deposit.ts';
import { mountProfiles } from './components/profiles.ts';
import { mountMmStats, mountStats } from './components/stats.ts';
import { mountSwitcher } from './components/switcher.ts';
import { mountTopbar } from './components/topbar.ts';
import { CONFIG, MM } from './config.ts';
import * as mm from './engine/mm.ts';
import { newOrder, tick } from './engine/resolver.ts';
import { drift, rebalance } from './engine/vault.ts';
import { $ } from './format.ts';
import { mmStore, store } from './store.ts';

const { intervals } = CONFIG;

/** Replay simulated history so the page opens with real (simulated) data. */
function seed(): void {
  for (let i = 0; i < 20; i++) store.update(drift);
  const end = Date.now();
  for (let t = end - 40_000; t <= end; t += intervals.tick) {
    if (t % intervals.newOrder < intervals.tick) store.update((s) => newOrder(s, t));
    if (t % intervals.rebalance < intervals.tick) store.update(rebalance);
    store.update((s) => tick(s, t));
  }
  for (let t = end - 120_000; t <= end; t += MM.intervals.tick) {
    mmStore.update((s) => mm.tick(s, t));
    if (t % MM.intervals.intent < MM.intervals.tick) mmStore.update((s) => mm.newIntent(s, t));
  }
}

/** Both strategies keep running whichever view is visible. */
function start(): void {
  setInterval(() => store.update((s) => tick(s, Date.now())), intervals.tick);
  setInterval(() => store.update((s) => newOrder(s, Date.now())), intervals.newOrder);
  setInterval(() => store.update(drift), intervals.drift);
  setInterval(() => store.update(rebalance), intervals.rebalance);
  setInterval(() => mmStore.update((s) => mm.tick(s, Date.now())), MM.intervals.tick);
  setInterval(() => mmStore.update((s) => mm.newIntent(s, Date.now())), MM.intervals.intent);
}

const view = (id: string, label: string, foot: string) => `
  <div class="view" data-view="${id}">
    <section class="stats" aria-label="${label}"></section>
    <div class="grid">
      <section class="card area-alloc"></section>
      <aside class="card area-deposit"></aside>
      <section class="card area-fills"></section>
    </div>
    <footer class="foot muted">${foot}</footer>
  </div>`;

const app = $(document, '#app');
app.innerHTML = `
  <header class="topbar"></header>
  <main class="page">
    <nav class="switcher" aria-label="Strategy"></nav>
    ${view('a', 'Strategy A overview', 'USDC vault on Base · allocates across Morpho, Aave V3 and Fluid · lends just-in-time to a 1inch Fusion resolver via Aqua.')}
    ${view('b', 'Strategy B overview', 'USDC + ETH inventory on Base · fills 1inch Fusion intents from stock at oracle ± spread · idle inventory earns Aave yield. Value moves with ETH.')}
  </main>`;

seed();
const [a, b] = [$(app, '[data-view="a"]'), $(app, '[data-view="b"]')];
mountTopbar($(app, '.topbar'));
mountStats($(a, '.stats'));
mountAllocation($(a, '.area-alloc'));
mountFills($(a, '.area-fills'));
mountDeposit($(a, '.area-deposit'));
mountMmStats($(b, '.stats'));
mountProfiles($(b, '.area-alloc'));
mountMmFills($(b, '.area-fills'));
mountMmDeposit($(b, '.area-deposit'));
mountSwitcher($(app, '.switcher'), (id) => {
  a.hidden = id !== 'a';
  b.hidden = id !== 'b';
});
start();
