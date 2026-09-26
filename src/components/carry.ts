/** Conditional carry: explainer, the keeper's decision, where the money sits (LTV + sinks) and on-chain activity. */
import type { Carry, CarryEvent, CarryEventKind, CarrySink, Snapshot } from '../api.ts';
import { addrUrl, txUrl } from '../chain.ts';
import { $, ago, esc, num, pct, short, usd } from '../format.ts';
import { store } from '../store.ts';
import { emptyState, ext, icon, type IconName, sectionHead } from '../icons.ts';
import { apyText, marketKey, stepHtml } from './self-custody.ts';
import { MEASURING } from './yield.ts';

/* ── Shared helpers ─────────────────────── */

/** Percentage points with a true minus sign: "+0.35 pp", "−0.12 pp". */
export function signedPp(v: number, dp = 2): string {
  const r = Number(v.toFixed(dp));
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${num(Math.abs(v), dp)} pp`;
}

/** Green at or above the entry threshold, red below the exit threshold, amber in between (hysteresis zone). */
export const spreadClass = (v: number, enter: number, exit: number) => (v >= enter ? 'pos' : v < exit ? 'neg' : 'tone-warn');

/** The sink with the best net APY and its spread over the borrow APR (null while measuring). */
export function carryBest(c: Carry): { sink: CarrySink | null; spread: number | null } {
  const sink = c.sinks.filter((s) => s.netApy !== null).sort((x, y) => y.netApy! - x.netApy!)[0] ?? null;
  return { sink, spread: sink && c.borrowApr !== null ? sink.netApy! - c.borrowApr : null };
}

/** "Morpho" for a sink that is also a listed self-custody market, else its share symbol. */
function sinkTitle(address: string, snap: Snapshot): string {
  const a = address.toLowerCase();
  const m = snap.selfCustody?.markets.find((x) => x.address.toLowerCase() === a);
  return m?.name ?? snap.carry?.sinks.find((s) => s.address.toLowerCase() === a)?.name ?? short(address);
}

/* ── Explainer ──────────────────────────── */

/** How carry works in three steps, plus the guardrails the contract enforces (thresholds from the snapshot). */
export function mountCarryExplainer(root: HTMLElement): void {
  const step = (n: number, k: IconName, title: string, body: string) => stepHtml(n, k, title, body);
  root.innerHTML = `
    <div class="sc-hero-head">
      <span class="eyebrow">${icon('earn')}Conditional carry · ETH</span>
      <h1>ETH that borrows only when it pays.</h1>
      <p class="lede">Deposit ETH and it stays as Aave collateral. The keeper borrows USDC against it only while the best sink APY minus the borrow APR beats the cost of getting in and out — and unwinds on its own when that spread disappears.</p>
    </div>
    <ol class="sc-steps">
      ${step(1, 'supply', 'Deposit ETH', 'WETH is supplied to Aave as collateral and stays there. You hold <em>ycWETH</em> vault shares.')}
      ${step(2, 'earn', 'Borrow only when it pays', 'While <em>best sink APY − borrow APR</em> clears the entry bar and the expected profit covers gas several times over, USDC is borrowed up to the target LTV and parked in the best sink.')}
      ${step(3, 'exit', 'Exit automatically', 'When the spread drops below the exit bar for several checks in a row, the keeper withdraws, repays and harvests the profit back into ETH.')}
    </ol>
    <p class="custody-line carry-guard">${icon('shield', 20)}<span data-guard></span></p>`;

  const guard = $(root, '[data-guard]');
  let key = '';
  store.subscribe(({ snapshot }) => {
    const c = snapshot?.carry;
    if (!c) return;
    const next = `${c.maxLtvPct}/${c.deleverageLtvPct}`;
    if (next === key) return;
    key = next;
    guard.innerHTML = `<b>Guardrails in the contract, not the keeper:</b> LTV is hard-capped at <span class="num">${pct(c.maxLtvPct, 0)}</span>; above <span class="num">${pct(
      c.deleverageLtvPct,
      0,
    )}</span> anyone can call <span class="num">deleverage</span>; USDC only goes to whitelisted ERC-4626 sinks; every swap is checked against the oracle price.`;
  });
}

/* ── Decision ───────────────────────────── */

/** The keeper's latest decision and the rules it applies. */
export function mountCarryDecision(root: HTMLElement): void {
  root.innerHTML = `
    ${sectionHead({
      icon: 'cpu',
      title: 'Keeper decision',
      desc: 'Re-evaluated every tick. The position only changes when these rules say so.',
      aside: `<span class="head-meta">${icon('clock')}<span data-ago></span></span>`,
    })}
    <div class="dec-now">
      <span class="status" data-status></span>
      <p class="dec-reason" data-reason></p>
    </div>
    <div class="dec-exit" data-exit></div>
    <dl class="kv dec-rules" data-rules></dl>`;

  const status = $(root, '[data-status]');
  const reason = $(root, '[data-reason]');
  const agoEl = $(root, '[data-ago]');
  const exit = $(root, '[data-exit]');
  const rules = $(root, '[data-rules]');

  store.subscribe(({ snapshot }) => {
    const c = snapshot?.carry;
    if (!c) return;
    const d = c.decision;
    const on = (d?.status ?? c.status) === 'on';
    status.className = `status ${on ? 'is-live' : ''}`;
    status.textContent = on ? 'On' : 'Off · waiting';
    reason.innerHTML = d
      ? `${esc(d.reason)}${d.executed.length ? ` <span class="muted">· executed ${esc(d.executed.join(', '))}</span>` : ''}`
      : '<span class="muted">No decision yet: the keeper hasn’t run a carry tick.</span>';
    agoEl.textContent = d ? `checked ${ago(Date.now() - d.t * 1000)}` : '';

    const r = c.rules;
    const n = Math.max(1, r.exitConfirmations);
    const k = Math.min(n, d?.exitCounter ?? 0);
    exit.hidden = !on && k === 0;
    exit.innerHTML = `
      <span class="muted">Exit confirmations</span>
      <span class="dec-dots" role="img" aria-label="${k} of ${n}">${Array.from({ length: n }, (_, i) => `<i class="${i < k ? 'is-on' : ''}"></i>`).join('')}</span>
      <span class="num">${k} / ${n}</span>`;

    rules.innerHTML = `
      <div><dt>Enter when</dt><dd>spread ≥ <span class="num">${num(r.enterSpreadPct, 2)}</span> pp</dd></div>
      <div><dt>Exit when</dt><dd>spread &lt; <span class="num">${num(r.exitSpreadPct, 2)}</span> pp for <span class="num">${n}</span> ticks in a row</dd></div>
      <div><dt>Only if</dt><dd>profit over <span class="num">${num(r.horizonHours, 0)}h</span> ≥ <span class="num">${num(r.costMultiple, 0)}×</span> round-trip gas</dd></div>
      <div><dt>Size</dt><dd>target LTV <span class="num">${pct(c.targetLtvPct, 0)}</span> · ≤ <span class="num">${pct(r.maxSinkSharePct, 0)}</span> of a sink’s TVL</dd></div>`;
  });
}

/* ── Where the money is ─────────────────── */

/** LTV meter (current vs target / max / deleverage) and the sinks table with the borrow APR as reference. */
export function mountCarryPosition(root: HTMLElement): void {
  root.innerHTML = `
    ${sectionHead({
      icon: 'gauge',
      title: 'Where the money is',
      desc: 'ETH sits on Aave as collateral. Borrowed USDC only ever goes to a whitelisted ERC-4626 sink.',
      aside: '<a class="head-link ext" data-vault target="_blank" rel="noopener"></a>',
    })}
    <div class="ltv-head"><span class="muted">Loan-to-value</span><span class="num" data-ltv></span></div>
    <div class="ltv" role="img" data-meter>
      <i class="ltv-fill" data-fill></i>
      <i class="ltv-mark is-target" data-mark="target"></i>
      <i class="ltv-mark is-max" data-mark="max"></i>
      <i class="ltv-mark is-delev" data-mark="delev"></i>
    </div>
    <div class="ltv-legend muted" data-legend></div>
    <dl class="carry-figs" data-figs></dl>
    <div class="sink-list" role="table" aria-label="Carry sinks">
      <div class="sink-row sink-headrow" role="row">
        <span role="columnheader">Sink</span>
        <span role="columnheader" class="r">Position</span>
        <span role="columnheader" class="r hide-sm">APY</span>
        <span role="columnheader" class="r hide-sm">Reward</span>
        <span role="columnheader" class="r">Net APY</span>
        <span role="columnheader" class="r">vs borrow</span>
      </div>
      <div class="sink-body"></div>
    </div>`;

  const vault = $<HTMLAnchorElement>(root, '[data-vault]');
  const meter = $(root, '[data-meter]');
  const body = $(root, '.sink-body');

  store.subscribe(({ snapshot }) => {
    const c = snapshot?.carry;
    if (!c) return;
    vault.href = addrUrl(c.vault);
    vault.innerHTML = `CarryVault <span class="mono">${short(c.vault)}</span>${icon('external')}`;

    // LTV meter on a 0 … (deleverage + margin) scale.
    const scale = Math.max(50, Math.ceil((Math.max(c.deleverageLtvPct, c.ltvPct) + 10) / 10) * 10);
    const at = (v: number) => `${Math.min(100, Math.max(0, (v / scale) * 100)).toFixed(2)}%`;
    $(root, '[data-ltv]').innerHTML = `${pct(c.ltvPct, 1)}`;
    $(root, '[data-fill]').style.width = at(c.ltvPct);
    $(root, '[data-mark="target"]').style.left = at(c.targetLtvPct);
    $(root, '[data-mark="max"]').style.left = at(c.maxLtvPct);
    $(root, '[data-mark="delev"]').style.left = at(c.deleverageLtvPct);
    meter.classList.toggle('is-high', c.ltvPct > c.maxLtvPct);
    meter.setAttribute('aria-label', `LTV ${pct(c.ltvPct, 1)}; target ${pct(c.targetLtvPct, 0)}, max ${pct(c.maxLtvPct, 0)}, anyone can deleverage above ${pct(c.deleverageLtvPct, 0)}`);
    $(root, '[data-legend]').innerHTML = `
      <span><i class="lg is-target"></i>target <span class="num">${pct(c.targetLtvPct, 0)}</span></span>
      <span><i class="lg is-max"></i>max <span class="num">${pct(c.maxLtvPct, 0)}</span></span>
      <span><i class="lg is-delev"></i>anyone deleverages <span class="num">${pct(c.deleverageLtvPct, 0)}</span></span>`;

    $(root, '[data-figs]').innerHTML = `
      <div><dt>ETH collateral</dt><dd class="num">${num(c.collateralWeth, 4)} ETH</dd><dd class="muted num">${usd(c.collateralUsd, 0)}</dd></div>
      <div><dt>USDC debt</dt><dd class="num">${usd(c.debtUsd, 0)}</dd><dd class="muted">${c.borrowApr === null ? 'APR measuring…' : `<span class="num">${pct(c.borrowApr)}</span> APR`}</dd></div>
      <div><dt>USDC in sinks</dt><dd class="num">${usd(c.stableUsd, 0)}</dd><dd class="muted">${c.sinks.filter((s) => s.valueUsd > 0).length} of ${c.sinks.length} sinks</dd></div>
      <div><dt>Health factor</dt><dd class="num">${c.healthFactor === null ? '∞' : num(c.healthFactor, 2)}</dd><dd class="muted">${c.healthFactor === null ? 'no debt' : 'Aave liquidates < 1'}</dd></div>`;

    const { sink: best } = carryBest(c);
    const r = c.rules;
    const rows = c.sinks
      .map((s) => {
        const title = sinkTitle(s.address, snapshot!);
        const isBest = best?.address === s.address;
        const held = s.valueUsd > 0;
        return `
      <div class="sink-row${isBest ? ' is-best' : ''}" role="row">
        <span role="cell" class="alloc-name">
          <i class="swatch c-${marketKey(title)}"></i>
          <span><b>${esc(title)}${isBest ? ' <span class="pill pill-accent">Best</span>' : ''}</b><small>${ext(addrUrl(s.address), `${esc(s.name)}<span class="hide-sm mono"> ${short(s.address)}</span>`, 'muted')}</small></span>
        </span>
        <span role="cell" class="r num${held ? '' : ' muted'}">${usd(s.valueUsd, 0)}<small class="muted hide-sm">cap ${usd(s.capUsd, 0)}</small></span>
        <span role="cell" class="r num hide-sm">${apyText(s.apy)}</span>
        <span role="cell" class="r num hide-sm${s.rewardApr ? '' : ' muted'}">${s.rewardApr ? `+${pct(s.rewardApr)}` : '—'}</span>
        <span role="cell" class="r num">${apyText(s.netApy)}</span>
        <span role="cell" class="r num">${s.spreadPct === null ? MEASURING : `<span class="${spreadClass(s.spreadPct, r.enterSpreadPct, r.exitSpreadPct)}">${signedPp(s.spreadPct)}</span>`}</span>
      </div>`;
      })
      .join('');
    const lender = c.creditMarket ? 'credit market' : 'Aave V3';
    body.innerHTML = `${rows || emptyState('No sinks whitelisted yet.')}
      <div class="sink-row sink-ref" role="row">
        <span role="cell" class="alloc-name"><i class="swatch c-reserve"></i><span><b>Borrow APR</b><small class="muted">USDC · ${lender}<span class="hide-sm"> · what the carry pays</span></small></span></span>
        <span role="cell" class="r num muted">−${usd(c.debtUsd, 0)}</span>
        <span role="cell" class="r hide-sm"></span>
        <span role="cell" class="r hide-sm"></span>
        <span role="cell" class="r num">${c.borrowApr === null ? MEASURING : `−${pct(c.borrowApr)}`}</span>
        <span role="cell" class="r"></span>
      </div>`;
  });
}

/* ── Activity ───────────────────────────── */

const KIND_CLASS: Record<CarryEventKind, string> = {
  Opened: 'is-live',
  Closed: '',
  Rotated: '',
  Deleveraged: 'is-warn',
  Harvested: 'is-done',
  ShortfallRepaid: 'is-warn',
};

const KIND_LABEL: Record<CarryEventKind, string> = {
  Opened: 'Opened',
  Closed: 'Closed',
  Rotated: 'Rotated',
  Deleveraged: 'Deleveraged',
  Harvested: 'Harvested',
  ShortfallRepaid: 'Shortfall repaid',
};

function eventDetail(e: CarryEvent, snap: Snapshot): string {
  const d = e.detail;
  const n = (k: string) => Number(d[k] ?? 0);
  const $u = (k: string) => `<span class="num">${usd(n(k))}</span>`;
  const sink = (k: string) => (d[k] ? esc(sinkTitle(d[k], snap)) : 'sink');
  const ltv = d.ltvPct !== undefined ? ` · LTV <span class="num">${pct(n('ltvPct'), 1)}</span>` : '';
  switch (e.kind) {
    case 'Opened':
      return `Borrowed ${$u('borrowedUsd')} → ${sink('sink')}${ltv}`;
    case 'Closed':
      return `${sink('sink')} → repaid ${$u('repaidUsd')} (received ${$u('receivedUsd')})${ltv}`;
    case 'Rotated':
      return `${$u('usd')} ${sink('from')} → ${sink('to')}`;
    case 'Deleveraged':
      return `Repaid ${$u('repaidUsd')}${ltv}`;
    case 'Harvested':
      return `${$u('stableInUsd')} profit → <span class="num">${num(n('wethOut'), 5)}</span> ETH`;
    case 'ShortfallRepaid':
      return `Sold <span class="num">${num(n('wethIn'), 5)}</span> ETH → repaid ${$u('repaidUsd')}`;
    default:
      return esc(Object.entries(d).map(([k, v]) => `${k} ${v}`).join(' · '));
  }
}

/** Recent CarryVault events with explorer links. */
export function mountCarryActivity(root: HTMLElement): void {
  root.innerHTML = `
    ${sectionHead({
      icon: 'history',
      title: 'Carry activity',
      desc: 'Every move the vault made on-chain: opening and closing the carry, rotating sinks, deleveraging and harvesting profit into ETH.',
      aside: '<span class="head-meta" data-counts></span>',
    })}
    <ul class="ev-list"></ul>`;

  const list = $(root, '.ev-list');
  const counts = $(root, '[data-counts]');
  store.subscribe(({ snapshot }) => {
    const c = snapshot?.carry;
    if (!c) return;
    const k = c.counts;
    counts.innerHTML = `<span class="num">${k.Opened}</span> opened · <span class="num">${k.Harvested}</span> harvested`;
    list.innerHTML = c.events.length
      ? c.events
          .map(
            (e) => `
      <li class="ev">
        <span class="status ${KIND_CLASS[e.kind] ?? ''}">${KIND_LABEL[e.kind] ?? esc(e.kind)}</span>
        <span class="ev-detail">${eventDetail(e, snapshot!)}</span>
        <span class="ev-block muted num">${esc(Number(e.block).toLocaleString('en-US'))}</span>
        <a class="tx-link" href="${txUrl(e.tx)}" target="_blank" rel="noopener" aria-label="View ${esc(e.kind)} transaction" title="View on Basescan">Tx${icon('external')}</a>
      </li>`,
          )
          .join('')
      : emptyState('No carry moves yet. The keeper only borrows once the spread beats the costs.', 'inbox', 'li');
  });
}
