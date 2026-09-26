import { $, ago, num, usd } from '../format.ts';
import { mmStore, store } from '../store.ts';
import type { Fill, MmEvent, MmState, State } from '../types.ts';

function sourceLabel(f: Fill, s: State): string {
  if (f.status === 'auction') return '<span class="muted">Waiting for auction</span>';
  const names = f.draws.map((d) => (d.source === 'reserve' ? 'Reserve' : s.markets.find((m) => m.id === d.source)?.name ?? d.source));
  const title = f.draws.map((d, i) => `${names[i]}: ${usd(d.amount)}`).join('\n');
  return `<span title="${title}">${names.join(' + ')}</span>`;
}

function status(f: Fill): string {
  if (f.status === 'auction') return `<span class="status">Auction ${Math.round(f.progress)}%</span>`;
  if (f.status === 'lending') return '<span class="status is-live">Filling</span>';
  return '<span class="status is-done">Settled</span>';
}

export function mountFills(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head">
      <div>
        <h2>Recent fills</h2>
        <p class="muted">1inch Fusion orders filled with vault liquidity, repaid with a fee.</p>
      </div>
    </header>
    <div class="fills-head">
      <span>Order</span><span class="r">Amount</span><span>Liquidity from</span><span class="r">Fee</span><span class="r">Status</span>
    </div>
    <ul class="fills"></ul>`;

  const list = $(root, '.fills');

  store.subscribe((s) => {
    const now = Date.now();
    list.innerHTML = s.fills.length
      ? s.fills
          .map(
            (f) => `
      <li class="fill">
        <span class="fill-pair"><b>${f.pair}</b><small class="muted">${ago(now - f.createdAt)}</small></span>
        <span class="fill-amount r num">${usd(f.amount, 0)}</span>
        <span class="fill-src">${sourceLabel(f, s)}</span>
        <span class="fill-fee r num ${f.status === 'settled' ? 'pos' : 'muted'}">${f.status === 'auction' ? '—' : '+' + usd(f.fee)}</span>
        <span class="fill-status r">${status(f)}</span>
      </li>`,
          )
          .join('')
      : '<li class="empty muted">Waiting for Fusion orders…</li>';
  });
}

/* ── Strategy B: intents filled from inventory ── */

const signed = (v: number, text: string) => `${v < 0 ? '−' : '+'}${text}`;

function mmRow(e: MmEvent, s: MmState, now: number): string {
  const name = s.profiles.find((p) => p.id === e.profile)?.name ?? '';
  const src = {
    fill: `${name} <span class="muted">@ ${num(e.price)}</span>`,
    keeper: `${name} <span class="muted">· DEX @ ${num(e.price)}</span>`,
    rejected: '<span class="muted">No profile within band</span>',
  }[e.kind];
  const status = {
    fill: '<span class="status is-done">Settled</span>',
    keeper: '<span class="status is-live">Keeper rebalance</span>',
    rejected: '<span class="status">Rejected · band</span>',
  }[e.kind];
  const none = e.kind === 'rejected';
  return `
    <li class="fill">
      <span class="fill-pair"><b>${e.dir}</b><small class="muted">${ago(now - e.at)}</small></span>
      <span class="fill-amount r num${none ? ' muted' : ''}">${usd(e.usd, 0)}</span>
      <span class="fill-src">${src}</span>
      <span class="fill-edge r num muted">${none ? '—' : signed(e.edgeBps, num(Math.abs(e.edgeBps), 1)) + ' bps'}</span>
      <span class="fill-fee r num ${none ? 'muted' : e.income < 0 ? 'neg' : 'pos'}">${none ? '—' : signed(e.income, usd(Math.abs(e.income)))}</span>
      <span class="fill-status r">${status}</span>
    </li>`;
}

export function mountMmFills(root: HTMLElement): void {
  root.classList.add('fills-b');
  root.innerHTML = `
    <header class="card-head">
      <div>
        <h2>Recent fills</h2>
        <p class="muted">Intents filled straight from inventory at the oracle price ± spread. Edge and income are measured against the oracle.</p>
      </div>
    </header>
    <div class="fills-head">
      <span>Intent</span><span class="r">Amount</span><span>Profile · price</span><span class="r">Edge</span><span class="r">Income</span><span class="r">Status</span>
    </div>
    <ul class="fills"></ul>`;

  const list = $(root, '.fills');
  mmStore.subscribe((s) => {
    const now = Date.now();
    list.innerHTML = s.events.length ? s.events.map((e) => mmRow(e, s, now)).join('') : '<li class="empty muted">Waiting for intents…</li>';
  });
}
