import './style.css';
import { type OrderRecord, getOrders, getSnapshot } from './api.ts';
import { addrUrl, initWallet, refreshBalances } from './chain.ts';
import { mountAllocation } from './components/allocation.ts';
import { mountCarryActivity, mountCarryDecision, mountCarryExplainer, mountCarryPosition } from './components/carry.ts';
import { mountCarryDeposit } from './components/carry-deposit.ts';
import { mountDeposit } from './components/deposit.ts';
import { mountFills } from './components/fills.ts';
import { mountIntent } from './components/intent.ts';
import { mountMmDeposit } from './components/mm-deposit.ts';
import { mountProfiles } from './components/profiles.ts';
import { mountScWallet } from './components/sc-wallet.ts';
import { mountScExplainer, mountScMarkets, mountScStrategies } from './components/self-custody.ts';
import { mountCarryStats, mountMmStats, mountScStats, mountStats } from './components/stats.ts';
import { mountSwitcher } from './components/switcher.ts';
import { mountTopbar } from './components/topbar.ts';
import { mountWallet } from './components/wallet.ts';
import { POLL, PROFILE_NAMES } from './config.ts';
import { $, esc, short } from './format.ts';
import { store } from './store.ts';

/* ── Layout ─────────────────────────────── */

const app = $(document, '#app');
app.innerHTML = `
  <header class="topbar"></header>
  <main class="page" data-strategy="sc">
    <div class="boot" data-boot role="status"></div>
    <div class="app-body" data-body hidden>
      <div class="banner" data-banner role="status" hidden></div>
      <nav class="switcher" aria-label="Strategy"></nav>
      <section class="card sc-hero" data-only="sc" data-mount="sc-hero" aria-label="How self-custody works"></section>
      <section class="stats" data-only="sc" aria-label="Self-custody overview"></section>
      <section class="stats" data-only="a" aria-label="Strategy A overview"></section>
      <section class="stats" data-only="b" aria-label="Strategy B overview"></section>
      <section class="card sc-hero carry-hero" data-only="carry" data-mount="carry-hero" aria-label="How conditional carry works"></section>
      <section class="stats stats-6" data-only="carry" aria-label="Carry overview"></section>
      <div class="grid">
        <div class="col-main">
          <section class="card o-alloc" data-only="sc" data-mount="sc-markets"></section>
          <section class="card o-strat" data-only="sc" data-mount="sc-strategies"></section>
          <section class="card o-fills" data-only="sc" data-mount="fills-sc"></section>
          <section class="card o-alloc" data-only="a" data-mount="alloc-a"></section>
          <section class="card o-alloc" data-only="b" data-mount="alloc-b"></section>
          <section class="card o-fills" data-only="a" data-mount="fills-a"></section>
          <section class="card o-fills" data-only="b" data-mount="fills-b"></section>
          <section class="card o-alloc" data-only="carry" data-mount="carry-decision"></section>
          <section class="card o-alloc" data-only="carry" data-mount="carry-position"></section>
          <section class="card o-fills" data-only="carry" data-mount="carry-activity"></section>
        </div>
        <div class="col-side">
          <section class="card o-sc area-wallet" data-only="sc" data-mount="sc-wallet"></section>
          <section class="card o-intent" data-mount="intent"></section>
          <section class="card o-deposit" data-only="a" data-mount="deposit-a"></section>
          <section class="card o-deposit" data-only="b" data-mount="deposit-b"></section>
          <section class="card o-deposit" data-only="carry" data-mount="deposit-carry"></section>
          <section class="card o-wallet area-wallet" data-mount="wallet"></section>
        </div>
      </div>
      <footer class="foot muted" data-foot></footer>
    </div>
  </main>`;

const page = $(app, '.page');
const boot = $(app, '[data-boot]');
const body = $(app, '[data-body]');
const banner = $(app, '[data-banner]');
const m = (id: string) => $(app, `[data-mount="${id}"]`);

/* ── Live data ──────────────────────────── */

let snapTimer = 0;
async function pollSnapshot(): Promise<void> {
  clearTimeout(snapTimer);
  try {
    const snapshot = await getSnapshot();
    const first = !store.get().snapshot;
    store.update({ snapshot, snapshotError: null });
    if (first) {
      void refreshBalances();
      void pollOrders();
    }
  } catch (e) {
    store.update({ snapshotError: e instanceof Error ? e.message : String(e) });
  }
  snapTimer = window.setTimeout(pollSnapshot, POLL.snapshot);
}

let ordersTimer = 0;
let backfilled = false;
async function pollOrders(): Promise<void> {
  clearTimeout(ordersTimer);
  const maker = store.get().wallet.address ?? undefined;
  try {
    // One deep backfill (JIT fills are rarer), then small incremental pages merged by hash.
    const [fills, mine] = await Promise.all([
      getOrders({ status: 'filled', limit: backfilled ? 40 : 500 }),
      maker ? getOrders({ maker, limit: 8 }) : Promise.resolve([] as OrderRecord[]),
    ]);
    backfilled = true;
    const byHash = new Map(store.get().fills.map((o) => [o.orderHash, o]));
    for (const o of fills) if (o.report) byHash.set(o.orderHash, o);
    const merged = [...byHash.values()].sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 500);
    store.update({ fills: merged, myOrders: store.get().wallet.address === maker ? mine : store.get().myOrders });
  } catch {
    /* the snapshot poll surfaces relayer outages */
  }
  ordersTimer = window.setTimeout(pollOrders, POLL.orders);
}

function startWalletPoll(): void {
  setInterval(() => {
    if (!document.hidden) void refreshBalances();
  }, POLL.wallet);
}

function retry(): void {
  boot.innerHTML = loadingHtml;
  void pollSnapshot();
}

/* ── Boot / error states ────────────────── */

const loadingHtml = `<div class="boot-card"><i class="spinner spinner-lg" aria-hidden="true"></i><p>Connecting to Base Sepolia…</p><small class="muted">Reading vaults, markets and the order book.</small></div>`;
boot.innerHTML = loadingHtml;

store.subscribe(({ snapshot, snapshotError }) => {
  const ready = !!snapshot;
  body.hidden = !ready;
  boot.hidden = ready;
  if (!ready && snapshotError) {
    boot.innerHTML = `
      <div class="boot-card">
        <p><b>Can’t reach the live system</b></p>
        <small class="muted">${esc(snapshotError)}. The relayer or RPC may be restarting.</small>
        <button type="button" class="btn btn-secondary" data-retry>Retry</button>
      </div>`;
    $(boot, '[data-retry]').addEventListener('click', retry);
  }
  banner.hidden = !(ready && snapshotError);
  if (ready && snapshotError && !banner.childElementCount) {
    banner.innerHTML = `<span>Live data paused: ${esc(snapshotError)}. Showing the last snapshot.</span><button type="button" class="link-btn" data-retry>Retry now</button>`;
    $(banner, '[data-retry]').addEventListener('click', () => void pollSnapshot());
  } else if (!snapshotError) banner.innerHTML = '';
});

/* ── Footer: every contract, linked ─────── */

let footKey = '';
store.subscribe(({ snapshot }) => {
  if (!snapshot || footKey === snapshot.contracts.vault) return;
  footKey = snapshot.contracts.vault;
  const c = snapshot.contracts;
  const sc = snapshot.selfCustody;
  const items: [string, string][] = [
    ...(sc ? ([['Aqua', sc.aqua], ['AquaYieldApp', sc.app], ['Wallet resolver', sc.resolver]] as [string, string][]) : []),
    ...(snapshot.carry ? ([['CarryVault', snapshot.carry.vault]] as [string, string][]) : []),
    ['YieldVault', c.vault],
    ...c.inventoryVaults.map((a, i): [string, string] => [`Inventory · ${PROFILE_NAMES[i]}`, a]),
    ['Resolver', c.resolver],
    ['Limit Order Protocol v4', c.limitOrderProtocol],
    ['Fusion settlement', c.fusionSettlement],
    ['Oracle', c.oracle],
    ['USDC', c.usdc],
    ['WETH', c.weth],
  ];
  $(app, '[data-foot]').innerHTML = `
    <div class="contracts">${items.map(([n, a]) => `<a href="${addrUrl(a)}" target="_blank" rel="noopener"><span>${n}</span> <span class="num">${short(a)}</span></a>`).join('')}</div>
    <p>Base Sepolia testnet${snapshot.mock ? ' · mock tokens and lending markets' : ''} · 1inch Fusion intents settled on-chain by the YieldSolver resolvers · self-custody via 1inch Aqua${snapshot.carry ? ' · conditional ETH carry on Aave' : ''}.</p>`;
});

/* ── Mount ──────────────────────────────── */

mountTopbar($(app, '.topbar'));
mountScExplainer(m('sc-hero'));
mountScStats($(app, '.stats[data-only="sc"]'));
mountScMarkets(m('sc-markets'));
mountScStrategies(m('sc-strategies'));
mountFills(m('fills-sc'), 'wallet');
mountScWallet(m('sc-wallet'));
mountStats($(app, '.stats[data-only="a"]'));
mountMmStats($(app, '.stats[data-only="b"]'));
mountAllocation(m('alloc-a'));
mountProfiles(m('alloc-b'));
mountFills(m('fills-a'), 'jit');
mountFills(m('fills-b'), 'inventory');
mountCarryExplainer(m('carry-hero'));
mountCarryStats($(app, '.stats[data-only="carry"]'));
mountCarryDecision(m('carry-decision'));
mountCarryPosition(m('carry-position'));
mountCarryActivity(m('carry-activity'));
mountIntent(m('intent'));
mountDeposit(m('deposit-a'));
mountMmDeposit(m('deposit-b'));
mountCarryDeposit(m('deposit-carry'));
mountWallet(m('wallet'));
mountSwitcher($(app, '.switcher'), (id) => (page.dataset.strategy = id));

// Wallet changes refresh balances and the user's own intents right away.
let lastAddr: string | null = null;
store.subscribe(({ wallet }) => {
  if (wallet.address === lastAddr) return;
  lastAddr = wallet.address;
  if (wallet.address) {
    void refreshBalances();
    if (store.get().snapshot) void pollOrders();
  }
});

void initWallet();
void pollSnapshot();
startWalletPoll();
