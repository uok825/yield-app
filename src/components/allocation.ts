import { addrUrl } from '../chain.ts';
import { MARKET_NAMES } from '../config.ts';
import { $, esc, pct, short, units, usd } from '../format.ts';
import { icon, sectionHead } from '../icons.ts';
import { store } from '../store.ts';

interface Row {
  id: string; // color key
  name: string;
  note: string;
  href: string | null;
  amount: number;
  apy: number | null | 'reserve';
}

export function mountAllocation(root: HTMLElement): void {
  root.innerHTML = `
    ${sectionHead({
      icon: 'pie',
      title: 'Markets',
      desc: 'Capital is spread across lending markets by the keeper; a liquid reserve funds just-in-time loans to the resolver.',
      aside: '<a class="head-link ext" data-vault target="_blank" rel="noopener"></a>',
    })}
    <div class="bar" role="img" aria-label="Allocation by market"></div>
    <div class="alloc-list" role="table" aria-label="Allocation by market">
      <div class="alloc-row alloc-headrow" role="row">
        <span role="columnheader">Market</span>
        <span role="columnheader" class="r">APY</span>
        <span role="columnheader" class="hide-sm">Share of TVL</span>
        <span role="columnheader" class="r">Amount</span>
      </div>
      <div class="alloc-body"></div>
    </div>`;

  const bar = $(root, '.bar');
  const body = $(root, '.alloc-body');
  const vaultLink = $<HTMLAnchorElement>(root, '[data-vault]');

  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const a = snapshot.strategyA;
    vaultLink.href = addrUrl(a.vault);
    vaultLink.innerHTML = `YieldVault <span class="mono">${short(a.vault)}</span>${icon('external')}`;

    const rows: Row[] = [
      ...[...a.markets]
        .sort((x, y) => (y.assets > x.assets ? 1 : -1))
        .map((m) => ({
          id: m.name in MARKET_NAMES ? m.name : 'reserve',
          name: MARKET_NAMES[m.name] ?? m.name,
          note: `Adapter <span class="mono">${short(m.adapter)}</span>`,
          href: addrUrl(m.adapter),
          amount: units(m.assets, 6),
          apy: m.apy,
        })),
      { id: 'reserve', name: 'Liquid reserve', note: `Target ${pct(a.reserveBps / 100, 0)} · lent JIT to fills`, href: null, amount: units(a.idle, 6), apy: 'reserve' },
    ];
    const total = units(a.tvl, 6) || 1;
    const share = (r: Row) => (r.amount / total) * 100;

    bar.innerHTML = rows
      .map((r) => `<span class="seg c-${r.id}" style="flex-grow:${Math.max(0, r.amount)}" title="${esc(r.name)}: ${usd(r.amount)} (${pct(share(r), 1)})"></span>`)
      .join('');
    bar.setAttribute('aria-label', rows.map((r) => `${r.name} ${pct(share(r), 1)}`).join(', '));

    body.innerHTML = rows
      .map((r) => {
        const apy = r.apy === 'reserve' ? '<span class="muted">—</span>' : r.apy === null ? '<span class="muted measuring">measuring…</span>' : pct(r.apy);
        const note = r.href ? `<a class="muted ext" href="${r.href}" target="_blank" rel="noopener">${r.note}${icon('external')}</a>` : `<small class="muted">${r.note}</small>`;
        return `
      <div class="alloc-row" role="row">
        <span role="cell" class="alloc-name">
          <i class="swatch c-${r.id}"></i>
          <span><b>${esc(r.name)}</b>${r.href ? `<small>${note}</small>` : note}</span>
        </span>
        <span role="cell" class="r num">${apy}</span>
        <span role="cell" class="share-cell c-${r.id}"><span class="minibar"><i style="width:${Math.min(100, share(r)).toFixed(2)}%"></i></span><span class="num muted">${pct(share(r), 1)}</span></span>
        <span role="cell" class="r num">${usd(r.amount, 0)}</span>
      </div>`;
      })
      .join('');
  });
}
