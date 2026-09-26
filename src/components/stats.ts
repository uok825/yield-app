import { lendingApy, sharePrice, totalAssets } from '../engine/vault.ts';
import { $, num, pct, usd } from '../format.ts';
import { store } from '../store.ts';

const TILES = [
  { key: 'tvl', label: 'Total value locked' },
  { key: 'apy', label: 'Lending APY' },
  { key: 'fees', label: 'Fees from JIT fills' },
  { key: 'orders', label: 'Orders filled' },
] as const;

export function mountStats(root: HTMLElement): void {
  root.innerHTML = TILES.map(
    (t) => `
    <div class="stat">
      <div class="stat-label">${t.label}</div>
      <div class="stat-value num" data-v="${t.key}"></div>
      <div class="stat-sub" data-s="${t.key}"></div>
    </div>`,
  ).join('');

  const set = (key: string, value: string, sub: string) => {
    $(root, `[data-v="${key}"]`).textContent = value;
    $(root, `[data-s="${key}"]`).textContent = sub;
  };

  store.subscribe((s) => {
    const reserveShare = totalAssets(s) > 0 ? (s.reserve / totalAssets(s)) * 100 : 0;
    set('tvl', usd(totalAssets(s)), `Share price ${num(sharePrice(s), 5)}`);
    set('apy', pct(lendingApy(s)), `Blended, ${pct(reserveShare, 0)} held idle`);
    set('fees', usd(s.feesEarned), 'Paid back to the vault');
    set('orders', num(s.filledCount, 0), `${usd(s.volume, 0)} volume`);
  });
}
