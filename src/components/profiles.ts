import type { InventoryVault } from '../api.ts';
import { addrUrl } from '../chain.ts';
import { PROFILE_NAMES } from '../config.ts';
import { $, apyPct, bps, num, pct, units, usd } from '../format.ts';
import { store } from '../store.ts';
import { apyBasis, apyHtml, extrapolatedTitle, isExtrapolated, signedHtml, sparkLegend, sparkline } from './yield.ts';

/** Track 0–100% USDC by value, shaded target band, target tick and a marker for the current ratio. */
function ratioBar(v: InventoryVault, ok: boolean): string {
  const t = v.targetStableBps / 100;
  const band = v.bandBps / 100;
  const r = Math.min(100, Math.max(0, v.stableRatioBps / 100));
  return `
    <span class="ratio${ok ? '' : ' is-out'}" role="img" aria-label="USDC ${r.toFixed(1)}%, band ${t - band}–${t + band}%">
      <i class="ratio-band" style="left:${t - band}%;width:${2 * band}%"></i>
      <i class="ratio-target" style="left:${t}%"></i>
      <i class="ratio-mark" style="left:${r}%"></i>
    </span>
    <small class="ratio-legend muted num"><span>USDC ${r.toFixed(1)}%</span><span>ETH ${(100 - r).toFixed(1)}%</span></small>`;
}

/** bid/ask are USDC units per WETH × 1e18 → dollars. */
const px = (v: bigint) => units(v, 24);

function row(v: InventoryVault, i: number): string {
  const ok = Math.abs(v.stableRatioBps - v.targetStableBps) <= v.bandBps;
  const t = v.targetStableBps / 100;
  const status = ok ? '<span class="status is-done">In band</span>' : '<span class="status is-warn">Out of band</span>';
  return `
    <div class="prof-row" role="row">
      <span role="cell" class="prof-name"><a href="${addrUrl(v.address)}" target="_blank" rel="noopener"><b>${PROFILE_NAMES[i] ?? v.symbol}</b></a><small class="muted"><span class="hide-sm">Target </span>${t} / ${100 - t}</small></span>
      <span role="cell" class="prof-ratio">${ratioBar(v, ok)}</span>
      <span role="cell" class="prof-quote r num"><small><span class="muted">Bid</span> ${num(px(v.bid))}</small><small><span class="muted">Ask</span> ${num(px(v.ask))}</small></span>
      <span role="cell" class="prof-skew r num"><small class="sm-only muted">Skew</small>${bps(v.skewBps)}</span>
      <span role="cell" class="prof-tvl r num">${usd(units(v.value, 6), 0)}</span>
      <span role="cell" class="prof-status r">${status}</span>
    </div>`;
}

const name = (v: InventoryVault, i: number) => PROFILE_NAMES[i] ?? v.symbol;

/** Yield row: share-vs-HODL trend, vs HODL, earned, net APY (lending + spread). */
function yieldRow(v: InventoryVault, i: number): string {
  const p = v.performance;
  const part = (x: number | null | undefined) => (x == null ? '—' : apyPct(x));
  const trend = sparkline(p?.history ?? [], {
    hodl: true,
    label: `${name(v, i)}: share price ${p?.sharePrice == null ? '—' : num(p.sharePrice, 4)} vs HODL basket ${
      p?.history.at(-1)?.hodl == null ? '—' : num(p.history.at(-1)!.hodl!, 4)
    } since first deposit`,
  });
  const breakdown = p?.netApy == null ? '' : `<small class="muted y-break"><span><span class="num">${part(p.lendingApy)}</span> lend</span> <span>+ <span class="num">${part(p.incomeApy)}</span> spread</span></small>`;
  const earned = p?.earnedUsd ?? units(v.spreadIncome, 6);
  return `
    <div class="yield-row" role="row">
      <span role="cell" class="y-name"><b>${name(v, i)}</b><small class="muted num">${usd(units(v.value, 6), 0)}</small></span>
      <span role="cell" class="y-trend">${trend}</span>
      <span role="cell" class="y-hodl r"><small class="sm-only muted">vs HODL</small>${signedHtml(p?.vsHodlPct ?? null)}</span>
      <span role="cell" class="y-earned r num"><small class="sm-only muted">Earned</small><span class="pos">${usd(earned)}</span><small class="muted hide-sm">${num(v.swaps, 0)} swaps</small></span>
      <span role="cell" class="y-apy r"><small class="sm-only muted">Net APY</small>${apyHtml(p?.netApy ?? null, p?.spanSec ?? null)}${breakdown}</span>
    </div>`;
}

export function mountProfiles(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head">
      <div>
        <h2>Inventory profiles</h2>
        <p class="muted" data-note></p>
      </div>
    </header>
    <div class="prof-list" role="table" aria-label="Inventory profiles">
      <div class="prof-row prof-headrow" role="row">
        <span role="columnheader">Profile</span>
        <span role="columnheader">USDC / ETH by value</span>
        <span role="columnheader" class="r">Bid / Ask</span>
        <span role="columnheader" class="r">Skew</span>
        <span role="columnheader" class="r">Value</span>
        <span role="columnheader" class="r">Status</span>
      </div>
      <div class="prof-body"></div>
    </div>
    <div class="yield-sec">
      <div class="yield-head">
        <h3>Yield by profile</h3>
        <p class="muted" data-basis></p>
      </div>
      <div class="yield-list" role="table" aria-label="Yield by profile">
        <div class="yield-row yield-headrow" role="row">
          <span role="columnheader">Profile</span>
          <span role="columnheader">Share price vs HODL ${sparkLegend}</span>
          <span role="columnheader" class="r" title="Share value vs holding the same USDC/WETH basket at today’s ETH price">vs HODL</span>
          <span role="columnheader" class="r" title="Spread income since the first deposit">Earned</span>
          <span role="columnheader" class="r">Net APY</span>
        </div>
        <div class="yield-body"></div>
      </div>
    </div>`;

  const body = $(root, '.prof-body');
  const note = $(root, '[data-note]');
  const ybody = $(root, '.yield-body');
  const basis = $(root, '[data-basis]');
  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const b = snapshot.strategyB;
    const lend = (x: number | null) => (x === null ? 'measuring…' : pct(x));
    const band = (b.vaults[0]?.bandBps ?? 500) / 100;
    note.textContent = `Each profile is its own pool, quoting the oracle ± ${b.spreadBps} bps with up to ${b.skewBps} bps skew toward its target. A keeper swaps back if the ratio leaves the ±${band}pp band. Idle inventory is lent out (USDC ${lend(b.lendingApy.usdc)} · WETH ${lend(b.lendingApy.weth)} APY).`;
    body.innerHTML = b.vaults.map(row).join('');
    ybody.innerHTML = b.vaults.map(yieldRow).join('');
    const spans = b.vaults.map((v) => v.performance?.spanSec).filter((x): x is number => x != null);
    const spanSec = spans.length ? Math.max(...spans) : null;
    basis.textContent = `Earned and vs HODL are measured since each profile’s first deposit. Net APY is ${apyBasis(spanSec)}${
      isExtrapolated(spanSec) ? ', so treat it as an extrapolation, not a forecast' : ''
    }.`;
    basis.title = isExtrapolated(spanSec) ? extrapolatedTitle(spanSec) : '';
  });
}
