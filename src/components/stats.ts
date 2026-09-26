import { $, ago, apyPct, esc, num, pct, units, usd } from '../format.ts';
import { store } from '../store.ts';
import { carryBest, signedPp, spreadClass } from './carry.ts';
import { MEASURING, apyBasis, extrapolatedTitle, isExtrapolated, signedHtml, sparkline } from './yield.ts';

interface TileDef {
  key: string;
  label: string;
  /** Tooltip on the label explaining what the number means. */
  hint?: string;
}

interface TileValue {
  /** Trusted HTML (built from our own formatted numbers). */
  value: string;
  sub: string;
  /** Optional second, quieter line (e.g. the basis of an APY). */
  note?: string;
  /** Optional inline visual to the right of the value (e.g. a sparkline). */
  aside?: string;
  subClass?: string;
  title?: string;
}

/** Renders a row of stat tiles and returns a setter for their contents. */
function tiles(root: HTMLElement, defs: TileDef[]) {
  root.innerHTML = defs
    .map(
      (t) => `
    <div class="stat" data-t="${t.key}">
      <div class="stat-label"${t.hint ? ` title="${esc(t.hint)}"` : ''}>${t.label}</div>
      <div class="stat-main"><div class="stat-value num" data-v></div><div class="stat-aside" data-x></div></div>
      <div class="stat-sub" data-s></div>
      <div class="stat-note" data-n hidden></div>
    </div>`,
    )
    .join('');
  return (key: string, v: TileValue) => {
    const tile = $(root, `[data-t="${key}"]`);
    $(tile, '[data-v]').innerHTML = v.value;
    const aside = $(tile, '[data-x]');
    aside.innerHTML = v.aside ?? '';
    aside.hidden = !v.aside;
    const sub = $(tile, '[data-s]');
    sub.innerHTML = v.sub;
    sub.className = `stat-sub ${v.subClass ?? ''}`;
    const note = $(tile, '[data-n]');
    note.hidden = !v.note;
    note.innerHTML = v.note ?? '';
    if (v.title) tile.title = v.title;
    else tile.removeAttribute('title');
  };
}

/** "extrapolated" tag next to an annualised headline number when the window is short. */
const tag = (spanSec: number | null) =>
  isExtrapolated(spanSec) ? ` <span class="tag" title="${esc(extrapolatedTitle(spanSec))}">extrapolated</span>` : '';

/** Net APY tile contents shared by both strategies. */
function netApyTile(
  p: { netApy: number | null; lendingApy: number | null; incomeApy: number | null } | null,
  spanSec: number | null,
  incomeName: string,
): TileValue {
  const part = (v: number | null) => (v === null ? '—' : apyPct(v));
  return {
    value: p?.netApy == null ? MEASURING : `${apyPct(p.netApy)}${tag(spanSec)}`,
    sub: p ? `<span class="num">${part(p.lendingApy)}</span> lending + <span class="num">${part(p.incomeApy)}</span> ${incomeName}` : 'lending + ' + incomeName,
    note: apyBasis(spanSec),
    title: `Net APY = lending APY (measured from market indices) + ${incomeName} income over the trailing window, annualised. ${
      isExtrapolated(spanSec) ? extrapolatedTitle(spanSec) : ''
    }`.trim(),
  };
}

export function mountStats(root: HTMLElement): void {
  const set = tiles(root, [
    { key: 'tvl', label: 'Total value locked' },
    { key: 'earned', label: 'Earned since launch', hint: 'JIT flash-loan fees paid to the vault by the resolver. Measured, not annualised.' },
    { key: 'price', label: 'Share price', hint: 'USDC per ysUSDC. Rises as lending interest and JIT fees accrue.' },
    { key: 'apy', label: 'Net APY' },
  ]);
  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const a = snapshot.strategyA;
    const p = a.performance;
    const tvl = units(a.tvl, 6);
    const idleShare = tvl > 0 ? (units(a.idle, 6) / tvl) * 100 : 0;
    const target = a.reserveBps / 100;

    set('tvl', {
      value: usd(tvl),
      sub: `${pct(idleShare, 1)} liquid reserve · target ${pct(target, 0)}`,
      subClass: Math.abs(idleShare - target) > 5 ? 'warn' : '',
    });

    const earned = p?.earnedUsd ?? units(a.jitFees, 6);
    set('earned', {
      value: `<span class="pos">${usd(earned)}</span>`,
      sub: `JIT fees · ${num(a.jitFills, 0)} fills · ${a.flashFeeBps} bps`,
    });

    const price = p?.sharePrice ?? units(a.sharePrice, 6);
    set('price', {
      value: num(price, 6),
      aside: sparkline(p?.history ?? [], { label: `ysUSDC share price since first deposit, now ${num(price, 6)} USDC` }),
      sub: p?.sharePriceChangePct == null ? 'change since launch: measuring…' : `${signedHtml(p.sharePriceChangePct)} since first deposit`,
    });

    set('apy', netApyTile(p, p?.spanSec ?? null, 'JIT fees'));
  });
}

export function mountMmStats(root: HTMLElement): void {
  const set = tiles(root, [
    { key: 'tvl', label: 'Total value locked' },
    { key: 'earned', label: 'Earned since launch', hint: 'Spread captured on swaps filled from inventory, all profiles. Measured, not annualised.' },
    {
      key: 'hodl',
      label: 'vs HODL',
      hint: 'Share value vs simply holding the USDC/WETH basket each share started with, at today’s ETH price. Isolates market-making skill from ETH price moves. Value-weighted over profiles.',
    },
    { key: 'apy', label: 'Net APY' },
  ]);
  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const b = snapshot.strategyB;
    const tvl = b.vaults.reduce((s, v) => s + units(v.value, 6), 0);
    const swaps = b.vaults.reduce((s, v) => s + v.swaps, 0);
    const earned = b.vaults.reduce((s, v) => s + (v.performance?.earnedUsd ?? units(v.spreadIncome, 6)), 0);
    const spans = b.vaults.map((v) => v.performance?.spanSec).filter((s): s is number => s != null);
    const spanSec = spans.length ? Math.max(...spans) : null;

    const age = Date.now() - snapshot.oracle.updatedAt * 1000;
    set('tvl', {
      value: usd(tvl),
      sub: `ETH <span class="num">${usd(snapshot.oracle.price)}</span> · oracle ${ago(age)}`,
      subClass: age > 10 * 60_000 ? 'warn' : '',
      title: `ETH/USD oracle price, used to value inventory and to quote ±${b.spreadBps} bps`,
    });
    set('earned', { value: `<span class="pos">${usd(earned)}</span>`, sub: `spread income · ${num(swaps, 0)} swaps` });
    set('hodl', {
      value: signedHtml(b.performance?.vsHodlPct ?? null),
      sub: 'vs holding the same USDC/WETH basket',
    });

    const lend = (v: number | null) => (v === null ? 'measuring…' : pct(v));
    const t = netApyTile(b.performance, spanSec, 'spread');
    t.title += ` Idle inventory lending: USDC ${lend(b.lendingApy.usdc)}, WETH ${lend(b.lendingApy.weth)}.`;
    set('apy', t);
  });
}

/** Self-custody overview: value held in wallets, what wallets earned, keeper moves and the best live lending APY. */
export function mountScStats(root: HTMLElement): void {
  const set = tiles(root, [
    { key: 'value', label: 'In wallets', hint: 'Oracle value of lending-market shares committed via Aqua. Held by the wallets themselves, never by YieldSolver.' },
    { key: 'earned', label: 'Earned by wallets', hint: 'JIT fees and market-making spread paid back to wallets as shares. Measured, not annualised.' },
    { key: 'moves', label: 'Keeper moves', hint: 'Rebalances of wallet shares between listed markets (e.g. Morpho → Aave) toward the best APY.' },
    { key: 'apy', label: 'Best lending APY' },
  ]);
  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const sc = snapshot.selfCustody;
    if (!sc) {
      for (const k of ['value', 'earned', 'moves', 'apy']) set(k, { value: '—', sub: 'not enabled on this deployment' });
      return;
    }
    const t = sc.totals;
    set('value', {
      value: usd(t.valueUsd),
      sub: `<span class="num">${num(t.wallets, 0)}</span> wallet${t.wallets === 1 ? '' : 's'} · shares stay in each wallet`,
    });
    set('earned', {
      value: `<span class="pos">${usd(t.earnedUsd)}</span>`,
      sub: `JIT <span class="num">${usd(t.jitFeesUsd)}</span> · spread <span class="num">${usd(t.spreadUsd)}</span>`,
    });
    set('moves', { value: num(t.rebalances, 0), sub: 'Morpho ↔ Fluid ↔ Aave, toward the best APY' });

    const best = (asset: 'USDC' | 'WETH') =>
      sc.markets.filter((m) => m.asset === asset && m.apy !== null).sort((x, y) => y.apy! - x.apy!)[0] ?? null;
    const u = best('USDC');
    const w = best('WETH');
    const line = (asset: string, count: number, m: typeof u) =>
      m ? `${asset} · ${esc(m.name)} <span class="num">${pct(m.apy!)}</span>` : `${asset} · ${count} market${count === 1 ? '' : 's'} measuring…`;
    set('apy', {
      value: u ? `${pct(u.apy!)}` : MEASURING,
      sub: line('USDC', sc.markets.filter((m) => m.asset === 'USDC').length, u),
      note: line('WETH', sc.markets.filter((m) => m.asset === 'WETH').length, w),
      title: sc.markets.map((m) => `${m.name} ${m.asset}: ${m.apy === null ? 'measuring…' : pct(m.apy)}`).join(' · '),
    });
  });
}

/** Carry overview: on/off, TVL, the live spread that drives it, LTV, vault APY in ETH terms and the open carry's PnL. */
export function mountCarryStats(root: HTMLElement): void {
  const set = tiles(root, [
    { key: 'status', label: 'Carry', hint: 'ON while USDC is borrowed against the ETH collateral and parked in a sink. OFF: plain ETH collateral, waiting for a spread worth taking.' },
    { key: 'tvl', label: 'Total value locked', hint: 'ETH collateral plus any carry profit (USDC in sinks minus debt), oracle-priced.' },
    { key: 'spread', label: 'Live spread', hint: 'Best sink net APY (supply APY + haircut rewards) minus the USDC borrow APR, in percentage points.' },
    { key: 'ltv', label: 'Loan-to-value', hint: 'USDC debt / ETH collateral value. The contract refuses to borrow past the max; above the deleverage line anyone can force a repay.' },
    { key: 'apy', label: 'Vault APY', hint: 'Share price growth in ETH terms: Aave collateral yield plus harvested carry profit.' },
    { key: 'pnl', label: 'Carry PnL', hint: 'USDC held in sinks minus USDC owed. Harvested into ETH by the keeper.' },
  ]);
  store.subscribe(({ snapshot }) => {
    const c = snapshot?.carry;
    if (!c) return;
    const on = c.status === 'on';
    set('status', {
      value: `<span class="status ${on ? 'is-done' : ''} status-lg">${on ? 'ON' : 'OFF'}</span>`,
      sub: on ? `borrowing <span class="num">${usd(c.debtUsd, 0)}</span> USDC` : 'waiting for a spread',
      note: c.decision ? `checked ${ago(Date.now() - c.decision.t * 1000)}` : undefined,
    });
    set('tvl', {
      value: `${num(c.tvlWeth, 4)} <span class="unit">ETH</span>`,
      sub: `<span class="num">${usd(c.tvlUsd, 0)}</span>${c.harvestedWeth > 0 ? ` · <span class="num">${num(c.harvestedWeth, 4)}</span> ETH harvested` : ''}`,
    });

    const best = carryBest(c);
    const r = c.rules;
    set('spread', {
      value: best.spread === null ? MEASURING : `<span class="${spreadClass(best.spread, r.enterSpreadPct, r.exitSpreadPct)}">${signedPp(best.spread)}</span>`,
      sub:
        best.sink && c.borrowApr !== null
          ? `${esc(best.sink.name)} <span class="num">${pct(best.sink.netApy!)}</span> − borrow <span class="num">${pct(c.borrowApr)}</span>`
          : `borrow APR ${c.borrowApr === null ? 'measuring…' : `<span class="num">${pct(c.borrowApr)}</span>`}`,
      note: `enter ≥ <span class="num">${num(r.enterSpreadPct, 2)}</span> pp · exit &lt; <span class="num">${num(r.exitSpreadPct, 2)}</span> pp`,
    });
    set('ltv', {
      value: pct(c.ltvPct, 1),
      sub: `target <span class="num">${pct(c.targetLtvPct, 0)}</span> · max <span class="num">${pct(c.maxLtvPct, 0)}</span>`,
      subClass: c.ltvPct > c.maxLtvPct ? 'warn' : '',
      note: c.healthFactor === null ? 'no debt · health factor ∞' : `health factor <span class="num">${num(c.healthFactor, 2)}</span>`,
    });
    set('apy', {
      value: c.vaultApy === null ? MEASURING : apyPct(c.vaultApy),
      sub: 'in ETH terms · share price growth',
    });
    set('pnl', {
      value: `<span class="${c.carryPnlUsd > 0.004 ? 'pos' : c.carryPnlUsd < -0.004 ? 'neg' : ''}">${c.carryPnlUsd > 0.004 ? '+' : ''}${usd(c.carryPnlUsd)}</span>`,
      sub: `in sinks <span class="num">${usd(c.stableUsd, 0)}</span> − debt <span class="num">${usd(c.debtUsd, 0)}</span>`,
    });
  });
}
