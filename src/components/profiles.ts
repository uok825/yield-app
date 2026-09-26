import { MM } from '../config.ts';
import { inBand, quote, usdcRatio, value } from '../engine/mm.ts';
import { $, num, usd } from '../format.ts';
import { mmStore } from '../store.ts';
import type { Profile } from '../types.ts';

const band = MM.bandBps / 100; // percentage points
const p0 = (v: number) => Math.round(v * 100);

/** Track 0–100% USDC by value, shaded target band, target tick and a marker for the current ratio. */
function ratioBar(p: Profile, ratio: number, ok: boolean): string {
  const t = p.target * 100;
  const v = Math.min(100, Math.max(0, ratio * 100));
  return `
    <span class="ratio${ok ? '' : ' is-out'}" role="img" aria-label="USDC ${v.toFixed(1)}%, band ${t - band}–${t + band}%">
      <i class="ratio-band" style="left:${t - band}%;width:${2 * band}%"></i>
      <i class="ratio-target" style="left:${t}%"></i>
      <i class="ratio-mark" style="left:${v}%"></i>
    </span>
    <small class="ratio-legend muted num"><span>USDC ${v.toFixed(1)}%</span><span>ETH ${(100 - v).toFixed(1)}%</span></small>`;
}

function row(p: Profile, price: number): string {
  const ratio = usdcRatio(p, price);
  const ok = inBand(ratio, p.target);
  const q = quote(p, price);
  const status = p.rebalancing || !ok ? '<span class="status is-live">Rebalancing</span>' : '<span class="status is-done">In band</span>';
  return `
    <div class="prof-row" role="row">
      <span role="cell" class="prof-name"><b>${p.name}</b><small class="muted"><span class="hide-sm">Target </span>${p0(p.target)} / ${p0(1 - p.target)}</small></span>
      <span role="cell" class="prof-ratio">${ratioBar(p, ratio, ok)}</span>
      <span role="cell" class="prof-skew r num"><small class="sm-only muted">Skew</small>${q.skew >= 0 ? '+' : '−'}${num(Math.abs(q.skew), 1)}</span>
      <span role="cell" class="prof-quote r num"><small><span class="muted">Bid</span> ${num(q.bid)}</small><small><span class="muted">Ask</span> ${num(q.ask)}</small></span>
      <span role="cell" class="prof-tvl r num">${usd(value(p, price), 0)}</span>
      <span role="cell" class="prof-status r">${status}</span>
    </div>`;
}

export function mountProfiles(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head">
      <div>
        <h2>Inventory profiles</h2>
        <p class="muted">Each profile is its own pool. Quotes skew toward the target ratio; a keeper swaps back if the ratio leaves the ±${band}pp band.</p>
      </div>
    </header>
    <div class="prof-list" role="table" aria-label="Inventory profiles">
      <div class="prof-row prof-headrow" role="row">
        <span role="columnheader">Profile</span>
        <span role="columnheader">USDC / ETH by value</span>
        <span role="columnheader" class="r">Skew bps</span>
        <span role="columnheader" class="r">Bid / Ask</span>
        <span role="columnheader" class="r">TVL</span>
        <span role="columnheader" class="r">Status</span>
      </div>
      <div class="prof-body"></div>
    </div>`;

  const body = $(root, '.prof-body');
  mmStore.subscribe((s) => {
    body.innerHTML = s.profiles.map((p) => row(p, s.price)).join('');
  });
}
