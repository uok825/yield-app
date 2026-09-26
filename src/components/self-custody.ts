/** Self-custody (Aqua-native) overview: explainer, lending markets and the table of wallet strategies. */
import type { ScMarket, ScStrategy, Snapshot } from '../api.ts';
import { addrUrl } from '../chain.ts';
import { $, esc, num, pct, short, usd } from '../format.ts';
import { emptyState, ext, icon, type IconName, sectionHead } from '../icons.ts';
import { store } from '../store.ts';
import { MEASURING } from './yield.ts';

/** Colour key shared with the allocation swatches. */
export const marketKey = (name: string) =>
  /morpho/i.test(name) ? 'morpho' : /fluid/i.test(name) ? 'fluid' : /aave/i.test(name) ? 'aave' : /carry/i.test(name) ? 'carry' : 'reserve';

export const apyText = (apy: number | null) => (apy === null ? MEASURING : `<span class="num">${pct(apy)}</span>`);

/** "70 / 30" for a targetStableBps. */
export const splitLabel = (bps: number) => `${bps / 100} / ${100 - bps / 100}`;

/** One "how it works" step: icon, step number, title and body. Shared with the carry explainer. */
export const stepHtml = (n: number, k: IconName, title: string, body: string) => `
    <li class="sc-step">
      <span class="step-top">${icon(k, 20, 'step-ico')}<span class="step-n">Step ${n}</span></span>
      <b>${title}</b>
      <p>${body}</p>
    </li>`;

/** How it works, in three steps, plus the custody guarantee. Static. */
export function mountScExplainer(root: HTMLElement): void {
  const step = (n: number, k: IconName, title: string, body: string) => stepHtml(n, k, title, body);
  root.innerHTML = `
    <div class="sc-hero-head">
      <span class="eyebrow">${icon('shield')}Self-custody · Aqua-native</span>
      <h1>Your tokens stay in your wallet.</h1>
      <p class="lede">Lend on Morpho, Fluid or Aave the usual way and keep the shares. Commit them through 1inch Aqua and the same liquidity also earns from Fusion fills — without a vault, a deposit or a withdrawal queue.</p>
    </div>
    <ol class="sc-steps">
      ${step(1, 'supply', 'Supply to a market', 'Deposit USDC or WETH into Morpho, Fluid or Aave. The interest-bearing shares land in <em>your</em> wallet.')}
      ${step(2, 'commit', 'Commit via Aqua', 'Approve Aqua once per market, then one <span class="num">ship</span> transaction records a budget. Nothing is transferred.')}
      ${step(3, 'earn', 'Earn on both sides', 'A keeper moves your shares to the best-paying market; the resolver uses them for 1inch Fusion intents, and the same shares back your 1inch SwapVM order; fees come back to your wallet as shares.')}
    </ol>
    <p class="custody-line">${icon('lock', 20)}<span><b>YieldSolver never holds your tokens;</b> Aqua only lets the app move them inside a single transaction that must return them (plus fees) to your wallet. Stop any time with <span class="num">dock</span>; withdraw straight from the market.</span></p>`;
}

/** Listed lending markets with live APYs and how much wallet liquidity sits in each. */
export function mountScMarkets(root: HTMLElement): void {
  root.innerHTML = `
    ${sectionHead({
      icon: 'layers',
      title: 'Lending markets',
      desc: 'ERC-4626 markets a strategy can list. The keeper moves each wallet’s shares between markets of the same asset toward the best APY.',
      aside: '<a class="head-link ext" data-app target="_blank" rel="noopener"></a>',
    })}
    <div class="bar" role="img" aria-label="Wallet liquidity by market"></div>
    <div class="alloc-list" role="table" aria-label="Lending markets">
      <div class="alloc-row alloc-headrow" role="row">
        <span role="columnheader">Market</span>
        <span role="columnheader" class="r">APY</span>
        <span role="columnheader" class="hide-sm">Share of wallet liquidity</span>
        <span role="columnheader" class="r">In wallets</span>
      </div>
      <div class="alloc-body"></div>
    </div>`;

  const bar = $(root, '.bar');
  const body = $(root, '.alloc-body');
  const appLink = $<HTMLAnchorElement>(root, '[data-app]');

  store.subscribe(({ snapshot }) => {
    const sc = snapshot?.selfCustody;
    if (!sc) return;
    appLink.href = addrUrl(sc.app);
    appLink.innerHTML = `AquaYieldApp <span class="mono">${short(sc.app)}</span>${icon('external')}`;
    const held = (m: ScMarket) =>
      sc.strategies.reduce((s, st) => s + st.positions.filter((p) => p.market.toLowerCase() === m.address.toLowerCase()).reduce((x, p) => x + p.usd, 0), 0);
    const rows = sc.markets.map((m) => ({ m, usd: held(m) }));
    const total = rows.reduce((s, r) => s + r.usd, 0) || 1;
    const share = (v: number) => (v / total) * 100;

    bar.innerHTML = rows
      .map((r) => `<span class="seg c-${marketKey(r.m.name)}" style="flex-grow:${Math.max(0, r.usd)}" title="${esc(r.m.name)} ${r.m.asset}: ${usd(r.usd)}"></span>`)
      .join('');
    bar.setAttribute('aria-label', rows.map((r) => `${r.m.name} ${r.m.asset} ${pct(share(r.usd), 1)}`).join(', '));
    body.innerHTML = rows
      .map(
        (r) => `
      <div class="alloc-row" role="row">
        <span role="cell" class="alloc-name">
          <i class="swatch c-${marketKey(r.m.name)}"></i>
          <span><b>${esc(r.m.name)} <span class="asset-tag">${r.m.asset}</span></b><small>${ext(addrUrl(r.m.address), `${esc(r.m.symbol)}<span class="hide-sm mono"> ${short(r.m.address)}</span>`, 'muted')}</small></span>
        </span>
        <span role="cell" class="r num">${apyText(r.m.apy)}</span>
        <span role="cell" class="share-cell c-${marketKey(r.m.name)}"><span class="minibar"><i style="width:${Math.min(100, share(r.usd)).toFixed(2)}%"></i></span><span class="num muted">${pct(share(r.usd), 1)}</span></span>
        <span role="cell" class="r num">${usd(r.usd, 0)}</span>
      </div>`,
      )
      .join('');
  });
}

/** Human summary of a strategy's switches: "70 / 30 · JIT 5 bps · MM ±10 bps". */
export function strategyFlags(st: Pick<ScStrategy, 'flashFeeBps' | 'mm'>): string {
  const parts = [`${splitLabel(st.mm.targetStableBps)} USDC/ETH`];
  parts.push(st.flashFeeBps > 0 ? `JIT ${st.flashFeeBps} bps` : 'JIT off');
  parts.push(st.mm.spreadBps > 0 ? `MM ±${st.mm.spreadBps} bps` : 'MM off');
  return parts.join(' · ');
}

function positionLines(st: ScStrategy, snap: Snapshot): string {
  if (!st.positions.length) return '<span class="muted">No shares committed</span>';
  const price = snap.oracle.price;
  const toUsd = (asset: string, v: bigint) => (asset === 'WETH' ? (Number(v) / 1e18) * price : Number(v) / 1e6);
  return st.positions
    .map((p) => {
      const inWallet = toUsd(p.asset, p.assets);
      const committed = toUsd(p.asset, p.committedAssets);
      const differs = Math.abs(inWallet - committed) >= Math.max(1, committed * 0.001); // ignore share-price rounding
      return `<span class="pos-line"><i class="swatch c-${marketKey(p.name)}"></i><span>${esc(p.name)} · ${p.asset}</span><span class="num">${usd(p.usd, 0)}</span>${
        differs ? `<small class="muted num pos-diff">committed ${usd(committed, 0)} · in wallet ${usd(inWallet, 0)}</small>` : ''
      }</span>`;
    })
    .join('');
}

/** Every wallet that shipped a strategy: where its shares sit, value, earnings and activity. */
export function mountScStrategies(root: HTMLElement): void {
  root.innerHTML = `
    ${sectionHead({ icon: 'users', title: 'Wallet strategies', desc: 'Wallets that committed their shares via Aqua. Every position below is held by the wallet itself.' })}
    <div class="st-list" role="table" aria-label="Wallet strategies">
      <div class="st-row st-headrow" role="row">
        <span role="columnheader">Wallet</span>
        <span role="columnheader">Where the shares sit</span>
        <span role="columnheader" class="r">Value</span>
        <span role="columnheader" class="r">Earned</span>
        <span role="columnheader" class="r">Activity</span>
      </div>
      <div class="st-body"></div>
    </div>`;

  const body = $(root, '.st-body');
  store.subscribe(({ snapshot, wallet }) => {
    const sc = snapshot?.selfCustody;
    if (!sc) return;
    const me = wallet.address?.toLowerCase();
    const list = [...sc.strategies].sort((x, y) => Number(y.maker.toLowerCase() === me) - Number(x.maker.toLowerCase() === me) || y.valueUsd - x.valueUsd);
    body.innerHTML = list.length
      ? list
          .map((st) => {
            const mine = st.maker.toLowerCase() === me;
            const fills = st.counts.flashes + st.counts.swaps;
            const sv = st.swapvmOrders > 0;
            return `
      <div class="st-row${mine ? ' is-mine' : ''}" role="row">
        <span role="cell" class="st-maker">${ext(addrUrl(st.maker), short(st.maker), 'mono')}${mine ? ' <span class="pill pill-accent">You</span>' : ''}${
          sv ? ` <span class="sv-badge" title="The same shares also back ${st.swapvmOrders} 1inch SwapVM order${st.swapvmOrders === 1 ? '' : 's'}">+ SwapVM ×${st.swapvmOrders}</span>` : ''
        }<small class="muted">${strategyFlags(st)}</small></span>
        <span role="cell" class="st-pos">${positionLines(st, snapshot!)}</span>
        <span role="cell" class="st-value r num"><small class="sm-only muted">Value</small>${usd(st.valueUsd, 0)}</span>
        <span role="cell" class="st-earned r num"><small class="sm-only muted">Earned</small><span class="pos">${usd(st.earned.totalUsd)}</span><small class="muted">JIT ${usd(st.earned.jitFeesUsd)} · spread ${usd(st.earned.spreadUsd)}</small>${
          sv || st.earned.swapvmUsd ? `<small class="muted">SwapVM ${usd(st.earned.swapvmUsd)}</small>` : ''
        }</span>
        <span role="cell" class="st-act r"><small class="sm-only muted">Activity</small><span class="num">${num(fills, 0)}</span> fills<small class="muted"><span class="num">${num(st.counts.rebalances, 0)}</span> keeper moves</small>${
          sv || st.counts.swapvmFills ? `<small class="muted"><span class="num">${num(st.counts.swapvmFills, 0)}</span> on SwapVM</small>` : ''
        }</span>
      </div>`;
          })
          .join('')
      : emptyState('No wallet has committed yet. Connect, supply to a market and commit to be the first.', 'users');
  });
}
