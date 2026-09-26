import { type OrderRecord, type Snapshot, parseRoute } from '../api.ts';
import { txUrl, usdValue } from '../chain.ts';
import { PROFILE_NAMES } from '../config.ts';
import { $, ago, type Token, tok, usd } from '../format.ts';
import { store } from '../store.ts';

const MAX_ROWS = 10;

export function symbolOf(token: string, snap: Snapshot): Token {
  return token.toLowerCase() === snap.contracts.weth.toLowerCase() ? 'WETH' : 'USDC';
}

export const pairOf = (o: OrderRecord, snap: Snapshot) => `${symbolOf(o.makerAsset, snap)} → ${symbolOf(o.takerAsset, snap)}`;

export function routeLabel(route: string | undefined): string {
  const r = parseRoute(route);
  if (!r) return '';
  return r.kind === 'jit' ? 'Strategy A (JIT)' : `Strategy B · ${PROFILE_NAMES[r.index] ?? `profile ${r.index}`}`;
}

function row(o: OrderRecord, snap: Snapshot, now: number, source: string): string {
  const hash = o.report?.tx ?? o.fillTx;
  const profit = o.report ? usdValue(o.report.profit, o.report.profitToken, snap) : 0;
  const profitTitle = o.report ? tok(o.report.profit, symbolOf(o.report.profitToken, snap)) : '';
  return `
    <li class="fill">
      <span class="fill-pair"><b>${pairOf(o, snap)}</b><small class="muted">${ago(now - o.updatedAt)}</small></span>
      <span class="fill-amount r num">${tok(o.makingAmount, symbolOf(o.makerAsset, snap))}</span>
      <span class="fill-src">${source}</span>
      <span class="fill-fee r num pos" title="${profitTitle}">+${usd(profit)}</span>
      <span class="fill-status r">${hash ? `<a class="tx-link" href="${txUrl(hash)}" target="_blank" rel="noopener" aria-label="View fill transaction">Tx ↗</a>` : ''}</span>
    </li>`;
}

/** Recent fills for one strategy: 'jit' routes for A, 'inventory:i' routes for B. */
export function mountFills(root: HTMLElement, kind: 'jit' | 'inventory'): void {
  const copy =
    kind === 'jit'
      ? 'Fusion intents the resolver filled with a just-in-time loan from the vault, repaid in the same transaction with a fee.'
      : 'Fusion intents filled straight from a profile’s inventory at the oracle price ± spread.';
  root.innerHTML = `
    <header class="card-head">
      <div>
        <h2>Recent fills</h2>
        <p class="muted">${copy}</p>
      </div>
    </header>
    <div class="fills-head">
      <span>Intent</span><span class="r">Sold</span><span>${kind === 'jit' ? 'Liquidity' : 'Profile'}</span><span class="r">Profit</span><span class="r">Tx</span>
    </div>
    <ul class="fills"></ul>`;

  const list = $(root, '.fills');
  let key = '';
  store.subscribe(({ snapshot, fills }) => {
    if (!snapshot) return;
    const mine = fills.filter((o) => parseRoute(o.report?.route)?.kind === kind).slice(0, MAX_ROWS);
    const now = Date.now();
    // Re-render when rows change, and at most every ~5s for relative times.
    const next = mine.map((o) => o.orderHash).join() + Math.floor(now / 5000);
    if (next === key) return;
    key = next;
    list.innerHTML = mine.length
      ? mine
          .map((o) => {
            const r = parseRoute(o.report?.route);
            const source = r?.kind === 'inventory' ? `<b class="prof-tag">${PROFILE_NAMES[r.index] ?? r.index}</b>` : 'Vault loan · repaid + fee';
            return row(o, snapshot, now, source);
          })
          .join('')
      : `<li class="empty muted">${kind === 'jit' ? 'No JIT fills yet. The resolver lends from the vault when inventory can’t cover an intent.' : 'Waiting for intents…'}</li>`;
  });
}
