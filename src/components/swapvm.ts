/**
 * 1inch SwapVM over self-custody liquidity: the same wallet shares, shipped through the same Aqua, as SwapVM orders
 * whose bytecode runs our YieldOracleSwap instruction. Figures, the instruction pipeline, orders and recent fills.
 */
import type { Snapshot, SwapVM, SwapVMOrder } from '../api.ts';
import { addrUrl, txUrl } from '../chain.ts';
import { $, esc, num, pct, short, span, usd } from '../format.ts';
import { copyBtn, emptyState, ext, icon, type IconName, sectionHead } from '../icons.ts';
import { store } from '../store.ts';
import { marketKey, splitLabel } from './self-custody.ts';

const OP = { salt: 20, yieldOracleSwap: 64, sequencerGuard: 65 } as const;

/** What each instruction does, in one line (shown under the decoded args). */
const OP_NOTE: Record<number, string> = {
  [OP.yieldOracleSwap]:
    'Quotes the Chainlink price ± spread, skews toward the target ratio and stays inside the band. Priced in underlying assets, settled in ERC-4626 shares; rounding always favours the maker.',
  [OP.sequencerGuard]: 'Refuses every trade while the Base sequencer is down or still inside its grace period after coming back.',
};

/** A share token as a market: "Morpho USDC" plus its colour key (falls back to the name the order carries). */
function shareMarket(share: string, snap: Snapshot, fallback?: string): { label: string; key: string } {
  const m = snap.selfCustody?.markets.find((x) => x.address.toLowerCase() === share.toLowerCase());
  if (m) return { label: `${m.name} ${m.asset}`, key: marketKey(m.name) };
  return fallback ? { label: fallback, key: marketKey(fallback) } : { label: short(share), key: 'reserve' };
}

/** Name of a share as an order side knows it (for events whose tokens may not be listed markets). */
function sideName(share: string, sv: SwapVM): string | undefined {
  const a = share.toLowerCase();
  for (const o of sv.orders) {
    if (o.stable?.share.toLowerCase() === a) return `${o.stable.name} USDC`;
    if (o.volatile?.share.toLowerCase() === a) return `${o.volatile.name} WETH`;
  }
  return undefined;
}

/** "1h", "5m", "365d" for a max price age in seconds. */
const ageLabel = (sec: number) => (sec < 60 ? `${sec}s` : span(sec).replace(/ 0[mh]$/, ''));

/** Bytecode split into tokenA | tokenB | [opcode len args]… so the program reads at a glance. */
function bytecodeHtml(hex: string): string {
  const b = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (b.length < 80) return `0x${esc(b)}`;
  const parts = [`<span class="b-tok" title="tokenA">${b.slice(0, 40)}</span>`, `<span class="b-tok" title="tokenB">${b.slice(40, 80)}</span>`];
  let pc = 80;
  while (pc + 4 <= b.length) {
    const op = parseInt(b.slice(pc, pc + 2), 16);
    const len = parseInt(b.slice(pc + 2, pc + 4), 16) * 2;
    parts.push(`<span class="b-op" title="opcode ${op} · ${len / 2} bytes">${b.slice(pc, pc + 4)}</span><span class="b-arg">${b.slice(pc + 4, pc + 4 + len)}</span>`);
    pc += 4 + len;
  }
  if (pc < b.length) parts.push(`<span class="b-arg">${b.slice(pc)}</span>`);
  return `0x${parts.join('')}`;
}

/** Decoded arguments of one instruction as a key/value grid. */
function argsHtml(opcode: number, o: SwapVMOrder, snap: Snapshot): string {
  const cell = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const n = (v: string) => `<span class="num">${v}</span>`;
  if (opcode === OP.yieldOracleSwap && o.params) {
    const p = o.params;
    const settle = [p.stableShare, p.volatileShare].map((a) => esc(snap.selfCustody?.markets.find((m) => m.address.toLowerCase() === a.toLowerCase())?.symbol ?? short(a))).join(' · ');
    return [
      cell('Spread', `±${n(num(p.spreadBps, 0))} bps`),
      cell('Inventory skew', `up to ${n(num(p.skewBps, 0))} bps`),
      cell('Max trade', `${n(pct(p.maxTradeBps / 100, p.maxTradeBps % 100 ? 1 : 0))} of budget`),
      cell('Target', `${n(splitLabel(p.targetStableBps))} USDC/ETH`),
      cell('Band', `±${n(pct(p.bandBps / 100, p.bandBps % 100 ? 1 : 0))}`),
      cell('Max price age', n(ageLabel(p.maxPriceAge))),
      cell('Oracle', ext(addrUrl(p.oracle), short(p.oracle), 'mono')),
      cell('Settles in', settle),
    ].join('');
  }
  if (opcode === OP.sequencerGuard && o.sequencerFeed) {
    return [
      cell('Sequencer feed', ext(addrUrl(o.sequencerFeed), short(o.sequencerFeed), 'mono')),
      cell('While down', 'reverts'),
      cell('Grace period', 'reverts'),
      cell('Network', 'Base mainnet'),
    ].join('');
  }
  const ins = o.program.find((i) => i.opcode === opcode);
  return cell('Arguments', ins ? `${n(num(ins.bytes, 0))} bytes` : '—');
}

/** The wallet's orders side by side: "Morpho USDC" over "Aave V3 WETH", with budgets on matching lines. */
function sideLines(o: SwapVMOrder, snap: Snapshot): { pair: string; budgets: string } {
  const sides = [o.stable, o.volatile].filter((x): x is NonNullable<typeof x> => !!x);
  if (!sides.length) return { pair: '<span class="muted">Undecoded program</span>', budgets: '<span class="muted">—</span>' };
  const pair = sides
    .map((x, i) => {
      const m = shareMarket(x.share, snap, `${x.name} ${i === 0 && o.stable ? 'USDC' : 'WETH'}`);
      return `<span class="sv-side"><i class="swatch c-${m.key}"></i><span>${esc(m.label)}</span></span>`;
    })
    .join('');
  const budgets = sides.map((x) => `<span class="num">${usd(x.budgetUsd, 0)}</span>`).join('');
  return { pair, budgets };
}

export function mountScSwapVM(root: HTMLElement): void {
  root.innerHTML = `
    ${sectionHead({
      icon: 'code',
      title: '1inch SwapVM',
      desc: 'Same shares, second app. Every wallet also runs its shares as 1inch SwapVM orders through the same Aqua, so one position backs both. Any SwapVM taker can fill them; our resolver routes Fusion intents to them.',
      aside: '<a class="head-link ext" data-router target="_blank" rel="noopener"></a>',
    })}
    <dl class="carry-figs sv-figs" data-figs></dl>
    <div class="sv-sec">
      <div class="yield-head">
        <h3>${icon('cpu')}<span>Program</span></h3>
        <p class="sv-sub-desc">Each order’s bytecode runs on our SwapVM router. Hover or select an instruction to see the arguments it was shipped with.</p>
      </div>
      <div class="sv-chain" role="group" aria-label="Instruction pipeline" data-chain></div>
      <div class="sv-args-wrap">
        <dl class="sv-args" data-args></dl>
        <p class="sv-op-note" data-note></p>
      </div>
      <div class="sv-code" data-code></div>
    </div>
    <div class="sv-sec">
      <div class="yield-head"><h3>${icon('users')}<span>Orders</span></h3></div>
      <div class="sv-list" role="table" aria-label="SwapVM orders">
        <div class="sv-row sv-headrow" role="row">
          <span role="columnheader">Wallet</span>
          <span role="columnheader">Pair</span>
          <span role="columnheader" class="r">Budget</span>
          <span role="columnheader" class="r">Spread</span>
          <span role="columnheader" class="r">Fills</span>
          <span role="columnheader" class="r sv-vol">Volume</span>
          <span role="columnheader" class="r">Earned</span>
        </div>
        <div class="sv-body"></div>
      </div>
    </div>
    <div class="sv-sec">
      <div class="yield-head"><h3>${icon('history')}<span>Recent SwapVM fills</span></h3></div>
      <div class="svf svf-head"><span>Shares in → out</span><span class="r">In / out</span><span class="r">Spread</span><span class="r">Tx</span></div>
      <ul class="svf-list"></ul>
    </div>
    <p class="sv-contracts" data-contracts></p>`;

  const router = $<HTMLAnchorElement>(root, '[data-router]');
  const figs = $(root, '[data-figs]');
  const chain = $(root, '[data-chain]');
  const args = $(root, '[data-args]');
  const note = $(root, '[data-note]');
  const code = $(root, '[data-code]');
  const body = $(root, '.sv-body');
  const events = $(root, '.svf-list');
  const contracts = $(root, '[data-contracts]');

  // Program panel state survives re-renders: the pinned (clicked) instruction, a hovered one, and the expanded bytecode.
  let example: SwapVMOrder | null = null;
  let pinned: number = OP.yieldOracleSwap;
  let open = false;
  let programKey = '';

  const showArgs = (opcode: number) => {
    const snap = store.get().snapshot;
    if (!example || !snap) return;
    args.innerHTML = argsHtml(opcode, example, snap);
    note.textContent = OP_NOTE[opcode] ?? '';
    for (const b of chain.querySelectorAll<HTMLElement>('[data-op]')) b.classList.toggle('is-shown', Number(b.dataset.op) === opcode);
  };

  chain.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-op]');
    if (!b) return;
    pinned = Number(b.dataset.op);
    for (const x of chain.querySelectorAll('button[data-op]')) x.setAttribute('aria-pressed', String(x === b));
    showArgs(pinned);
  });
  chain.addEventListener('pointerover', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
    if (b) showArgs(Number(b.dataset.op));
  });
  chain.addEventListener('pointerleave', () => showArgs(pinned));
  chain.addEventListener('focusin', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
    if (b) showArgs(Number(b.dataset.op));
  });
  chain.addEventListener('focusout', () => showArgs(pinned));
  code.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-expand]')) return;
    open = !open;
    renderCode();
  });

  function renderCode(): void {
    if (!example) return;
    const bytes = (example.bytecode.length - 2) / 2;
    code.classList.toggle('is-open', open);
    code.innerHTML = `
      <span class="sv-code-label">order.data <span class="num">· ${num(bytes, 0)} bytes</span></span>
      <code class="mono sv-bytes" title="tokenA | tokenB | program">${bytecodeHtml(example.bytecode)}</code>
      <span class="sv-code-act">
        <button type="button" class="link-btn" data-expand aria-expanded="${open}">${open ? 'Collapse' : 'Expand'}</button>
        ${copyBtn(example.bytecode, 'Copy bytecode')}
      </span>`;
  }

  function renderProgram(sv: SwapVM): void {
    const orders = sv.orders;
    example = orders.find((o) => o.params && o.sequencerFeed) ?? orders.find((o) => o.params) ?? orders[0] ?? null;
    const key = example ? `${example.hash}:${example.bytecode.length}` : '';
    if (key === programKey) return;
    programKey = key;
    root.querySelector('.sv-sec')!.toggleAttribute('hidden', !example);
    if (!example) return;

    // Every distinct instruction across orders (Salt only makes hashes unique, so it is left out).
    const seen = new Map<number, string>();
    for (const o of [example, ...orders]) for (const i of o.program) if (i.opcode !== OP.salt && !seen.has(i.opcode)) seen.set(i.opcode, i.name);
    const ops = [...seen].sort(([a], [b]) => (a === OP.sequencerGuard ? -1 : b === OP.sequencerGuard ? 1 : 0));
    if (!ops.some(([op]) => op === pinned)) pinned = ops.find(([op]) => op === OP.yieldOracleSwap)?.[0] ?? ops[0]?.[0] ?? OP.yieldOracleSwap;
    const guard = seen.has(OP.sequencerGuard);
    const node = ([op, name]: [number, string]) =>
      `<button type="button" class="sv-op" data-op="${op}" aria-pressed="${op === pinned}"><span class="sv-op-n mono">${op}</span><b>${esc(name)}</b></button>`;
    const arrow = `<span class="sv-arrow" aria-hidden="true">${icon('arrow')}</span>`;
    const parts = ops.map(node);
    if (!guard)
      parts.unshift(
        `<span class="sv-op is-ghost" title="Mainnet orders prepend SequencerGuard (opcode 65): no trades while the Base sequencer is down or in its grace period. Testnet orders leave it out."><span class="sv-op-n mono">65</span><span>SequencerGuard on mainnet</span></span>`,
      );
    chain.innerHTML = `${parts.join(arrow)}<span class="sv-version muted">${esc(sv.version)}</span>`;
    showArgs(pinned);
    renderCode();
  }

  store.subscribe(({ snapshot, wallet }) => {
    const sv = snapshot?.swapvm ?? null;
    root.hidden = !sv;
    if (!sv || !snapshot) return;
    const sc = snapshot.selfCustody;
    const t = sv.totals;

    router.href = addrUrl(sv.router);
    router.innerHTML = `YieldSwapVMRouter <span class="mono">${short(sv.router)}</span>${icon('external')}`;

    const walletsTotal = sc?.totals.wallets ?? 0;
    figs.innerHTML = `
      <div><dt>Orders</dt><dd class="num">${num(t.orders, 0)}</dd><dd class="muted">${
        walletsTotal ? `<span class="num">${num(t.wallets, 0)}</span> of <span class="num">${num(walletsTotal, 0)}</span> wallets` : `<span class="num">${num(t.wallets, 0)}</span> wallets`
      }</dd></div>
      <div><dt>Fills</dt><dd class="num">${num(t.fills, 0)}</dd><dd class="muted">via the SwapVM router</dd></div>
      <div><dt>Volume</dt><dd class="num">${usd(t.volumeUsd, 0)}</dd><dd class="muted">paid out in shares</dd></div>
      <div><dt>Maker spread</dt><dd class="num pos">${usd(t.spreadUsd)}</dd><dd class="muted">kept by the wallets</dd></div>`;

    renderProgram(sv);

    // Orders, grouped by wallet (yours first, then by volume).
    const me = wallet.address?.toLowerCase();
    const groups = new Map<string, SwapVMOrder[]>();
    for (const o of sv.orders) {
      const k = o.maker.toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), o]);
    }
    const vol = (os: SwapVMOrder[]) => os.reduce((a, o) => a + o.volumeUsd, 0);
    const sorted = [...groups.entries()].sort(([a, x], [b, y]) => Number(b === me) - Number(a === me) || vol(y) - vol(x));
    body.innerHTML = sorted.length
      ? sorted
          .map(([maker, os]) => {
            const mine = maker === me;
            const rows = os
              .map((o, i) => {
                const { pair, budgets } = sideLines(o, snapshot);
                const who =
                  i === 0
                    ? `${ext(addrUrl(o.maker), short(o.maker), 'mono')}${mine ? ' <span class="pill pill-accent">You</span>' : ''}`
                    : '';
                return `
        <div class="sv-row${i ? ' is-cont' : ''}" role="row">
          <span role="cell" class="sv-wallet">${who}<small class="muted" title="${o.hash}">order <span class="mono">${short(o.hash)}</span></small></span>
          <span role="cell" class="sv-pair">${pair}</span>
          <span role="cell" class="sv-budget r">${budgets}</span>
          <span role="cell" class="sv-spread r num"><small class="sm-only muted">Spread</small>${o.params ? `±${num(o.params.spreadBps, 0)} bps` : '—'}</span>
          <span role="cell" class="sv-fills r num"><small class="sm-only muted">Fills</small>${num(o.fills, 0)}</span>
          <span role="cell" class="sv-vol r num">${usd(o.volumeUsd, 0)}</span>
          <span role="cell" class="sv-earned r num"><small class="sm-only muted">Earned</small><span class="pos">${usd(o.spreadUsd)}</span></span>
        </div>`;
              })
              .join('');
            return `<div class="sv-group${mine ? ' is-mine' : ''}" role="rowgroup">${rows}</div>`;
          })
          .join('')
      : emptyState('No SwapVM orders yet. A wallet ships one over the shares it already committed.', 'code');

    // Recent fills, newest first.
    const name = (a: string) => shareMarket(a, snapshot, sideName(a, sv));
    events.innerHTML = sv.events.length
      ? sv.events
          .map((e) => {
            const a = name(e.tokenIn);
            const b = name(e.tokenOut);
            const spread = e.inUsd - e.outUsd;
            return `
      <li class="svf">
        <span class="svf-dir"><b title="The taker paid ${esc(a.label)} into the wallet and received ${esc(b.label)}">${esc(a.label)} <span class="muted">→</span> ${esc(b.label)}</b><small class="muted">wallet ${ext(
          addrUrl(e.maker),
          short(e.maker),
          'mono muted',
        )}<span class="hide-sm"> · block <span class="num">${esc(Number(e.block).toLocaleString('en-US'))}</span></span></small></span>
        <span class="svf-amt r num">${usd(e.inUsd)}<small class="muted">${usd(e.outUsd)} out</small></span>
        <span class="svf-spread r num ${spread >= 0 ? 'pos' : 'neg'}">${spread >= 0 ? '+' : '−'}${usd(Math.abs(spread))}</span>
        <a class="tx-link svf-tx" href="${txUrl(e.tx)}" target="_blank" rel="noopener" aria-label="View SwapVM fill transaction" title="View on Basescan">Tx${icon('external')}</a>
      </li>`;
          })
          .join('')
      : emptyState('No SwapVM fills yet. They appear here when a taker or our resolver swaps against a wallet’s order.', 'inbox', 'li');
    $(root, '.svf-head').hidden = !sv.events.length;

    const link = (k: IconName, label: string, a: string) => `<span>${icon(k)}${ext(addrUrl(a), `${label} <span class="mono">${short(a)}</span>`)}</span>`;
    contracts.innerHTML = [
      link('code', 'Router', sv.router),
      link('zap', 'SwapVMResolver', sv.resolver),
      link('file', 'Order builder', sv.builder),
      link('layers', 'Aqua · shared with AquaYieldApp', sv.aqua),
    ].join('');
  });
}
