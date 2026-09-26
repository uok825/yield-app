import { $, ago, num, pct, units, usd } from '../format.ts';
import { store } from '../store.ts';

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
    { key: 'price', label: 'Share price' },
    { key: 'fees', label: 'JIT fees earned' },
    { key: 'reserve', label: 'Liquid reserve' },
  ]);
  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const a = snapshot.strategyA;
    const tvl = units(a.tvl, 6);
    const idleShare = tvl > 0 ? (units(a.idle, 6) / tvl) * 100 : 0;
    const target = a.reserveBps / 100;
    const growth = (units(a.sharePrice, 6) - 1) * 100;
    set('tvl', usd(tvl), `${num(units(a.totalSupply, 12), 0)} ysUSDC outstanding`);
    set('price', num(units(a.sharePrice, 6), 6), `USDC per ysUSDC · ${growth >= 0 ? '+' : ''}${pct(growth, 3)} since launch`);
    set('fees', usd(units(a.jitFees, 6)), `${num(a.jitFills, 0)} JIT fills since launch · ${a.flashFeeBps} bps fee`);
    set(
      'reserve',
      pct(idleShare, 1),
      `Target ${pct(target, 0)} · ${usd(units(a.idle, 6), 0)} idle`,
      Math.abs(idleShare - target) > 5 ? 'warn' : '',
    );
  });
}

export function mountMmStats(root: HTMLElement): void {
  const set = tiles(root, [
    { key: 'tvl', label: 'Total value locked' },
    { key: 'price', label: 'ETH oracle price' },
    { key: 'income', label: 'Spread income' },
    { key: 'apy', label: 'Lending APY on idle' },
  ]);
  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const b = snapshot.strategyB;
    const tvl = b.vaults.reduce((s, v) => s + units(v.value, 6), 0);
    const stable = b.vaults.reduce((s, v) => s + units(v.stable, 6), 0);
    const income = b.vaults.reduce((s, v) => s + units(v.spreadIncome, 6), 0);
    const swaps = b.vaults.reduce((s, v) => s + v.swaps, 0);
    const apy = (v: number | null) => (v === null ? 'measuring…' : pct(v));
    set('tvl', usd(tvl), `${b.vaults.length} profiles · ${pct(tvl > 0 ? (stable / tvl) * 100 : 0, 0)} USDC`);
    const age = Date.now() - snapshot.oracle.updatedAt * 1000;
    set('price', usd(snapshot.oracle.price), `Updated ${ago(age)} · ±${b.spreadBps} bps spread`, age > 10 * 60_000 ? 'warn' : '');
    set('income', usd(income), `${num(swaps, 0)} swaps filled from inventory`);
    set('apy', b.lendingApy.usdc === null ? 'Measuring…' : pct(b.lendingApy.usdc), `USDC ${apy(b.lendingApy.usdc)} · WETH ${apy(b.lendingApy.weth)}`);
  });
}
