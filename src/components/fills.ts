import { $, ago, usd } from '../format.ts';
import { store } from '../store.ts';
import type { Fill, State } from '../types.ts';

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
