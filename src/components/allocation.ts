import { totalAssets } from '../engine/vault.ts';
import { $, pct, usd } from '../format.ts';
import { store } from '../store.ts';
import type { Market, State } from '../types.ts';

interface Row {
  id: string;
  name: string;
  note: string;
  amount: number;
  apy: number | null;
  history: number[];
}

function sparkline(data: number[]): string {
  if (data.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
  const w = 72;
  const h = 22;
  const min = Math.min(...data);
  const range = Math.max(...data) - min || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / range) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(' ')}" /></svg>`;
}

const marketRow = (m: Market): Row => ({ id: m.id, name: m.name, note: 'Lending market', amount: m.balance, apy: m.apy, history: m.history });

function rows(s: State): Row[] {
  const reserve: Row = { id: 'reserve', name: 'Liquid reserve', note: 'Lent just-in-time to fills', amount: s.reserve, apy: null, history: [] };
  const lent: Row[] = s.inFlight > 0.005 ? [{ id: 'inflight', name: 'Lent to resolver', note: 'Repaid in the same tx', amount: s.inFlight, apy: null, history: [] }] : [];
  return [...s.markets.map(marketRow), reserve, ...lent];
}

export function mountAllocation(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head">
      <div>
        <h2>Allocation</h2>
        <p class="muted">Weighted by APY × trust score. 15% stays liquid for fills.</p>
      </div>
    </header>
    <div class="bar" role="img" aria-label="Allocation by market"></div>
    <div class="alloc-list" role="table" aria-label="Allocation by market">
      <div class="alloc-row alloc-headrow" role="row">
        <span role="columnheader">Market</span>
        <span role="columnheader" class="hide-sm">APY trend</span>
        <span role="columnheader" class="r">APY</span>
        <span role="columnheader" class="r hide-sm">Share</span>
        <span role="columnheader" class="r">Amount</span>
      </div>
      <div class="alloc-body"></div>
    </div>`;

  const bar = $(root, '.bar');
  const body = $(root, '.alloc-body');

  store.subscribe((s) => {
    const total = totalAssets(s) || 1;
    const list = rows(s);
    const share = (r: Row) => (r.amount / total) * 100;

    bar.innerHTML = list
      .map((r) => `<span class="seg c-${r.id}" style="flex-grow:${Math.max(0, r.amount)}" title="${r.name}: ${usd(r.amount)} (${pct(share(r), 1)})"></span>`)
      .join('');
    bar.setAttribute('aria-label', list.map((r) => `${r.name} ${pct(share(r), 1)}`).join(', '));

    body.innerHTML = list
      .map(
        (r) => `
      <div class="alloc-row" role="row">
        <span role="cell" class="alloc-name">
          <i class="swatch c-${r.id}"></i>
          <span><b>${r.name}</b><small class="muted">${r.note}</small></span>
        </span>
        <span role="cell" class="hide-sm c-${r.id}">${sparkline(r.history)}</span>
        <span role="cell" class="r num">${r.apy === null ? '<span class="muted">—</span>' : pct(r.apy)}</span>
        <span role="cell" class="r num hide-sm muted">${pct(share(r), 1)}</span>
        <span role="cell" class="r num">${usd(r.amount, 0)}</span>
      </div>`,
      )
      .join('');
  });
}
