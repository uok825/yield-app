import type { InventoryVault } from '../api.ts';
import { addrUrl } from '../chain.ts';
import { PROFILE_NAMES } from '../config.ts';
import { $, bps, num, units, usd } from '../format.ts';
import { store } from '../store.ts';

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
      <span role="cell" class="prof-income r num"><span class="pos">${usd(units(v.spreadIncome, 6))}</span><small class="muted">${v.swaps} swaps</small></span>
      <span role="cell" class="prof-tvl r num">${usd(units(v.value, 6), 0)}</span>
      <span role="cell" class="prof-status r">${status}</span>
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
        <span role="columnheader" class="r">Income</span>
        <span role="columnheader" class="r">Value</span>
        <span role="columnheader" class="r">Status</span>
      </div>
      <div class="prof-body"></div>
    </div>`;

  const body = $(root, '.prof-body');
  const note = $(root, '[data-note]');
  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const b = snapshot.strategyB;
    const band = (b.vaults[0]?.bandBps ?? 500) / 100;
    note.textContent = `Each profile is its own pool, quoting the oracle ± ${b.spreadBps} bps with up to ${b.skewBps} bps skew toward its target. A keeper swaps back if the ratio leaves the ±${band}pp band.`;
    body.innerHTML = b.vaults.map(row).join('');
  });
}
