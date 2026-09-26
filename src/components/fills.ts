import { type OrderRecord, type Route, type Snapshot, parseRoute } from '../api.ts';
import { addrUrl, txUrl, usdValue } from '../chain.ts';
import { PROFILE_NAMES } from '../config.ts';
import { $, ago, short, type Token, tok, usd } from '../format.ts';
import { emptyState, ext, icon, sectionHead } from '../icons.ts';
import { store } from '../store.ts';

const MAX_ROWS = 10;

export function symbolOf(token: string, snap: Snapshot): Token {
  return token.toLowerCase() === snap.contracts.weth.toLowerCase() ? 'WETH' : 'USDC';
}

export const pairOf = (o: OrderRecord, snap: Snapshot) => `${symbolOf(o.makerAsset, snap)} → ${symbolOf(o.takerAsset, snap)}`;

export function routeLabel(route: string | undefined): string {
  const r = parseRoute(route);
  if (!r) return '';
  if (r.kind === 'wallet') return `a self-custody wallet (${r.mode === 'mm' ? 'market making' : 'JIT'})`;
  return r.kind === 'jit' ? 'Strategy A (JIT)' : `Strategy B · ${PROFILE_NAMES[r.index] ?? `profile ${r.index}`}`;
}

/** Full maker address for a wallet route (the route only carries a prefix), if the relayer lists that strategy. */
function walletMaker(r: Extract<Route, { kind: 'wallet' }>, snap: Snapshot): string | null {
  return snap.selfCustody?.strategies.find((s) => s.maker.toLowerCase().startsWith(r.makerPrefix))?.maker ?? null;
}

function walletSource(r: Extract<Route, { kind: 'wallet' }>, snap: Snapshot): string {
  const maker = walletMaker(r, snap);
  const who = maker
    ? ext(addrUrl(maker), short(maker), 'mono')
    : `<span class="mono">${r.makerPrefix}…</span>`;
  return `${r.mode === 'mm' ? 'Market-made' : 'JIT loan'} · ${who}`;
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
      <span class="fill-status r">${hash ? `<a class="tx-link" href="${txUrl(hash)}" target="_blank" rel="noopener" aria-label="View fill transaction" title="View on Basescan">Tx${icon('external')}</a>` : ''}</span>
    </li>`;
}

const COPY: Record<Route['kind'], string> = {
  jit: 'Fusion intents the resolver filled with a just-in-time loan from the vault, repaid in the same transaction with a fee.',
  inventory: 'Fusion intents filled straight from a profile’s inventory at the oracle price ± spread.',
  wallet:
    'Fusion intents filled from shares committed by self-custody wallets. The shares leave the wallet only inside the fill transaction and come back, with the payment or fee, as shares.',
};

const EMPTY: Record<Route['kind'], string> = {
  jit: 'No JIT fills yet. The resolver lends from the vault when inventory can’t cover an intent.',
  inventory: 'Waiting for intents…',
  wallet: 'No fills from wallet liquidity yet. Commit shares and sign an intent to see one here.',
};

/** Recent fills for one source: 'jit' routes for A, 'inventory:i' for B, 'wallet-*' for self-custody wallets. */
export function mountFills(root: HTMLElement, kind: Route['kind']): void {
  const copy = COPY[kind];
  root.innerHTML = `
    ${sectionHead({ icon: 'history', title: 'Recent fills', desc: copy })}
    <div class="fills-head">
      <span>Intent</span><span class="r">Sold</span><span>${kind === 'jit' ? 'Liquidity' : kind === 'wallet' ? 'Wallet' : 'Profile'}</span><span class="r"${
        kind === 'wallet' ? ' title="The resolver’s margin on the fill. The wallet’s own spread or JIT fee is under Earned in the strategies table."' : ''
      }>${kind === 'wallet' ? 'Margin' : 'Profit'}</span><span class="r">Tx</span>
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
            const source =
              r?.kind === 'inventory' ? `<b class="prof-tag">${PROFILE_NAMES[r.index] ?? r.index}</b>`
              : r?.kind === 'wallet' ? walletSource(r, snapshot)
              : 'Vault loan · repaid + fee';
            return row(o, snapshot, now, source);
          })
          .join('')
      : emptyState(EMPTY[kind], 'inbox', 'li');
  });
}
