import { apys, tvl } from '../engine/mm.ts';
import { lendingApy, sharePrice, totalAssets } from '../engine/vault.ts';
import { $, num, pct, usd } from '../format.ts';
import { mmStore, store } from '../store.ts';

/** Renders a row of stat tiles and returns a setter for their value / subline. */
function tiles(root: HTMLElement, defs: { key: string; label: string }[]) {
  root.innerHTML = defs
    .map(
      (t) => `
    <div class="stat">
      <div class="stat-label">${t.label}</div>
      <div class="stat-value num" data-v="${t.key}"></div>
      <div class="stat-sub" data-s="${t.key}"></div>
    </div>`,
    )
    .join('');
  return (key: string, value: string, sub: string, subClass = '') => {
    $(root, `[data-v="${key}"]`).textContent = value;
    const el = $(root, `[data-s="${key}"]`);
    el.textContent = sub;
    el.className = `stat-sub ${subClass}`;
  };
}

export function mountStats(root: HTMLElement): void {
  const set = tiles(root, [
    { key: 'tvl', label: 'Total value locked' },
    { key: 'apy', label: 'Lending APY' },
    { key: 'fees', label: 'Fees from JIT fills' },
    { key: 'orders', label: 'Orders filled' },
  ]);
  store.subscribe((s) => {
    const reserveShare = totalAssets(s) > 0 ? (s.reserve / totalAssets(s)) * 100 : 0;
    set('tvl', usd(totalAssets(s)), `Share price ${num(sharePrice(s), 5)}`);
    set('apy', pct(lendingApy(s)), `Blended, ${pct(reserveShare, 0)} held idle`);
    set('fees', usd(s.feesEarned), 'Paid back to the vault');
    set('orders', num(s.filledCount, 0), `${usd(s.volume, 0)} volume`);
  });
}

export function mountMmStats(root: HTMLElement): void {
  const set = tiles(root, [
    { key: 'tvl', label: 'Total value locked' },
    { key: 'apy', label: 'Net APY' },
    { key: 'price', label: 'ETH oracle price' },
    { key: 'fills', label: 'Intents filled' },
  ]);
  mmStore.subscribe((s) => {
    const total = tvl(s);
    const usdcShare = total > 0 ? (s.profiles.reduce((a, p) => a + p.usdc, 0) / total) * 100 : 0;
    const a = apys(s);
    // Change vs ~1 minute ago (30 ticks of 2s).
    const ref = s.history[Math.max(0, s.history.length - 31)];
    const change = ref > 0 ? (s.price / ref - 1) * 100 : 0;
    set('tvl', usd(total), `3 profiles · ${pct(usdcShare, 0)} USDC`);
    set('apy', pct(a.net), `Lending ${pct(a.lending)} + spread ${pct(a.spread)}`);
    set('price', usd(s.price), `${change >= 0 ? '▲' : '▼'} ${pct(Math.abs(change))} · 1m`, change >= 0 ? 'pos' : 'neg');
    set('fills', num(s.fillCount, 0), `${usd(s.volume, 0)} volume · ${s.rejectedCount} rejected`);
  });
}
