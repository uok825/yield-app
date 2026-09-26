/**
 * Self-custody · "Your wallet": share balances per listed market, supply / withdraw directly on the ERC-4626 market,
 * commit the shares via Aqua (approve + ship), and the active strategy with Stop (dock).
 */
import { type Address, type Hex, maxUint256, toHex } from 'viem';
import { aave4626Abi, aquaAbi, mockERC20Abi } from '../../bots/src/abis.ts';
import type { ScMarket, ScStrategy, SelfCustody, Snapshot } from '../api.ts';
import { account, addrUrl, connect, encodeStrategy, ensureAllowance, refreshBalances, switchNetwork, write } from '../chain.ts';
import { CHAIN_ID, GAS_FAUCET_URL, PROFILE_NAMES } from '../config.ts';
import { $, esc, num, parseAmount, short, type Token, TOKEN_DEC, TOKEN_DP, toInput, tok, units, usd } from '../format.ts';
import { type ScCommit, type ScHolding, store } from '../store.ts';
import { apyText, icon, marketKey, splitLabel, strategyFlags } from './self-custody.ts';
import { txLink, txStatus } from './tx.ts';

type Mode = 'supply' | 'withdraw';

/** Approvals at or above this are treated as "max" and skipped. */
const MAX_ISH = maxUint256 / 2n;

const lc = (a: string) => a.toLowerCase();
const same = (a: string, b: string) => lc(a) === lc(b);

/** Oracle USD value of an underlying amount. */
const toUsd = (asset: Token, v: bigint, snap: Snapshot) => (asset === 'WETH' ? units(v, 18) * snap.oracle.price : units(v, 6));

/** Listed markets in ship order: stable (USDC) markets, then volatile (WETH) markets. */
const shipOrder = (sc: SelfCustody) => [...sc.markets.filter((m) => m.asset === 'USDC'), ...sc.markets.filter((m) => m.asset === 'WETH')];

export function mountScWallet(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head card-head-row">
      <div><h2>Your wallet</h2><p class="muted">Self-custody position · nothing is deposited with YieldSolver</p></div>
      <a class="head-link num" data-addr target="_blank" rel="noopener"></a>
    </header>
    <div data-pane="off" hidden><p class="note">Self-custody isn’t enabled on this deployment.</p></div>
    <div data-pane="none" hidden>
      <p class="note">No browser wallet detected. Install an EIP-1193 wallet such as MetaMask, Rabby or Coinbase Wallet to supply and commit. Live data works without one.</p>
    </div>
    <div data-pane="disconnected" hidden>
      <p class="note">Connect a wallet on Base Sepolia to supply to a market, commit your shares via Aqua and follow what they earn.</p>
      <button type="button" class="btn btn-primary btn-block" data-connect>Connect wallet</button>
    </div>
    <div data-pane="wrong" hidden>
      <p class="note">Your wallet is on another network. YieldSolver runs on Base Sepolia (84532).</p>
      <button type="button" class="btn btn-primary btn-block" data-switch>Switch to Base Sepolia</button>
      <p class="tx-msg is-error" data-switch-msg hidden></p>
    </div>
    <div data-pane="connected" hidden>
      <section class="sc-sec sc-sec-first">
        <div class="sc-sec-head"><h3>Shares in your wallet</h3><span class="num" data-total></span></div>
        <ul class="sc-hold" data-holdings><li class="muted empty-sm">Reading your positions…</li></ul>
        <p class="note sc-hint" data-faucet-hint hidden>No USDC or WETH yet? Use <b>Get test tokens</b> in the Wallet card (mock tokens).</p>
        <p class="note warn-note" data-gas hidden>Every step is a transaction paid in Base Sepolia ETH. <a href="${GAS_FAUCET_URL}" target="_blank" rel="noopener">Get some from a faucet ↗</a></p>
      </section>

      <section class="sc-sec">
        <div class="sc-sec-head"><h3><span class="step-n">1</span>Supply to a market</h3><span class="muted small">shares → your wallet</span></div>
        <form class="deposit-form" data-supply novalidate>
          <div class="tabs" role="tablist">
            <button type="button" role="tab" data-mode="supply">Supply</button>
            <button type="button" role="tab" data-mode="withdraw">Withdraw</button>
          </div>
          <div class="field-head"><span class="label">Asset</span></div>
          <div class="tabs tabs-sm" role="radiogroup" aria-label="Asset">
            <button type="button" role="radio" data-asset="USDC">USDC</button>
            <button type="button" role="radio" data-asset="WETH">WETH</button>
          </div>
          <div class="field-head"><span class="label">Market</span><span class="muted">APY</span></div>
          <div class="mkt-pick" role="radiogroup" aria-label="Market" data-markets></div>
          <div class="field-head"><label for="sc-amount" data-amount-label>Amount</label><span class="muted num" data-avail></span></div>
          <div class="field">
            <input id="sc-amount" class="num" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" />
            <span class="muted" data-unit>USDC</span>
            <button type="button" class="link-btn" data-max>Max</button>
          </div>
          <p class="note warn-note" data-supply-note hidden></p>
          <button type="submit" class="btn btn-primary btn-block sc-submit" data-submit></button>
          <p class="tx-msg" data-msg aria-live="polite"></p>
        </form>
      </section>

      <section class="sc-sec">
        <div class="sc-sec-head"><h3><span class="step-n">2</span>Commit via Aqua</h3><span class="muted small" data-commit-state></span></div>
        <div data-commit-form>
          <div class="field-head"><span class="label">Inventory target (USDC / ETH by value)</span></div>
          <div class="tabs tabs-3" role="radiogroup" aria-label="Target mix" data-profiles></div>
          <div class="toggles">
            <label class="toggle"><input type="checkbox" data-jit checked /><span class="toggle-ui" aria-hidden="true"></span><span><b>Lend JIT liquidity to the resolver</b><small class="muted" data-jit-note></small></span></label>
            <label class="toggle"><input type="checkbox" data-mm checked /><span class="toggle-ui" aria-hidden="true"></span><span><b>Market-make from my inventory</b><small class="muted" data-mm-note></small></span></label>
            <div class="toggle is-locked" title="Always on: rebalancing is what keeps your shares in the best market"><span class="toggle-ui is-on" aria-hidden="true"></span><span><b>Keeper rebalancing</b><small class="muted">Always on · moves shares between listed markets toward the best APY</small></span></div>
          </div>
          <div class="field-head"><span class="label">Committed budget per market</span><span class="muted">approval</span></div>
          <ul class="sc-budgets" data-budgets></ul>
          <button type="button" class="btn btn-primary btn-block sc-submit" data-commit></button>
          <p class="tx-msg" data-commit-msg aria-live="polite"></p>
        </div>
        <div data-active hidden></div>
        <p class="tx-msg" data-dock-msg aria-live="polite" hidden></p>
      </section>

      <section class="sc-sec">
        <p class="sc-fine">${icon('lock')}<span>Committed shares stay in your wallet and remain yours: redeem them from the market at any time. Redeeming committed shares reduces what the resolver can use — the budget is capped by what your wallet actually holds.</span></p>
      </section>
    </div>`;

  /* ── State ───────────────────────────── */
  let mode: Mode = 'supply';
  let asset: Token = 'USDC';
  let market: Address | null = null;
  let useMax = false;
  let profile = 0;
  let marketsKey = '';

  const panes = root.querySelectorAll<HTMLElement>('[data-pane]');
  const addr = $<HTMLAnchorElement>(root, '[data-addr]');
  const input = $<HTMLInputElement>(root, '#sc-amount');
  const submit = $<HTMLButtonElement>(root, '[data-submit]');
  const commitBtn = $<HTMLButtonElement>(root, '[data-commit]');
  const jitBox = $<HTMLInputElement>(root, '[data-jit]');
  const mmBox = $<HTMLInputElement>(root, '[data-mm]');
  const picker = $(root, '[data-markets]');
  const activeEl = $(root, '[data-active]');
  const commitForm = $(root, '[data-commit-form]');
  const switchMsg = $(root, '[data-switch-msg]');
  const msg = txStatus($(root, '[data-msg]'));
  const commitMsg = txStatus($(root, '[data-commit-msg]'), 'One approval per market (skipped if already approved), then one ship. No tokens move.');
  const dockMsgEl = $(root, '[data-dock-msg]');
  const dockMsg = txStatus(dockMsgEl);
  const idleText = () =>
    mode === 'supply' ? 'Approve once, then deposit. The market mints its shares straight to your wallet.' : 'Redeems your shares on the market itself; the assets come back to your wallet.';

  /* ── Derived data ────────────────────── */
  const sc = () => store.get().snapshot?.selfCustody ?? null;
  const holdings = (): ScHolding[] => store.get().balances?.sc?.holdings ?? [];
  const holdingOf = (m: string) => holdings().find((h) => same(h.address, m));
  const marketOf = (m: string) => sc()?.markets.find((x) => same(x.address, m));
  const activeCommits = (): ScCommit[] => (store.get().balances?.sc?.commits ?? []).filter((c) => c.active);
  const committedBudget = (m: string) => activeCommits().reduce((s, c) => s + (c.tokens.find((t) => same(t.market, m))?.budget ?? 0n), 0n);
  const marketsFor = (a: Token) => sc()?.markets.filter((m) => m.asset === a) ?? [];
  const amount = () => parseAmount(input.value, TOKEN_DEC[asset]) ?? 0n;
  /** Supply: wallet balance of the asset. Withdraw: the position's underlying value. */
  const available = (): bigint => {
    const b = store.get().balances;
    if (!b) return 0n;
    if (mode === 'supply') return asset === 'USDC' ? b.usdc : b.weth;
    return market ? (holdingOf(market)?.assets ?? 0n) : 0n;
  };

  /* ── Market picker (rebuilt only when the asset / market list changes) ─ */
  function buildPicker(): void {
    const list = marketsFor(asset);
    const key = `${asset}:${list.map((m) => m.address).join()}`;
    if (!list.some((m) => market && same(m.address, market))) {
      // Default: the market you already hold (withdraw) or the best APY, else the first listed.
      const held = list.find((m) => (holdingOf(m.address)?.shares ?? 0n) > 0n);
      const best = [...list].filter((m) => m.apy !== null).sort((x, y) => y.apy! - x.apy!)[0];
      market = (mode === 'withdraw' && held ? held : (best ?? list[0]))?.address ?? null;
    }
    if (key !== marketsKey) {
      marketsKey = key;
      picker.innerHTML = list
        .map(
          (m) => `
        <button type="button" role="radio" class="mkt-opt" data-market="${m.address}">
          <i class="swatch c-${marketKey(m.name)}"></i><span class="mkt-name"><b>${esc(m.name)}</b><small class="muted">${esc(m.symbol)}</small></span>
          <span class="mkt-apy r" data-apy></span>
        </button>`,
        )
        .join('');
    }
  }

  /* ── Render ──────────────────────────── */
  function render(): void {
    const { snapshot, balances, wallet } = store.get();
    const s = snapshot?.selfCustody ?? null;
    const pane = !s ? 'off' : wallet.status === 'none' ? 'none' : wallet.status !== 'connected' ? 'disconnected' : wallet.chainId !== CHAIN_ID ? 'wrong' : 'connected';
    panes.forEach((p) => (p.hidden = p.dataset.pane !== pane));
    addr.hidden = !wallet.address;
    if (wallet.address) {
      addr.href = addrUrl(wallet.address);
      addr.textContent = `${short(wallet.address)} ↗`;
    }
    $<HTMLButtonElement>(root, '[data-connect]').disabled = wallet.status === 'connecting';
    if (!s || !snapshot) return;

    buildPicker();
    renderSupply();
    if (pane !== 'connected') return;
    $(root, '[data-gas]').hidden = !balances || balances.eth >= 20_000_000_000_000n; // 0.00002 ETH
    $(root, '[data-faucet-hint]').hidden = !balances || !snapshot.mock || balances.usdc + balances.weth > 0n || (balances.sc?.holdings.some((h) => h.shares > 0n) ?? false);
    renderHoldings(snapshot, s);
    renderCommit(snapshot, s);
  }

  function renderHoldings(snap: Snapshot, s: SelfCustody): void {
    const b = store.get().balances;
    const list = $(root, '[data-holdings]');
    if (!b?.sc) return;
    let total = 0;
    list.innerHTML = s.markets
      .map((m) => {
        const h = holdingOf(m.address);
        const shares = h?.shares ?? 0n;
        const value = h ? toUsd(m.asset, h.assets, snap) : 0;
        total += value;
        const budget = committedBudget(m.address);
        const listed = activeCommits().some((c) => c.tokens.some((t) => same(t.market, m.address)));
        const tag =
          budget > 0n ? '<span class="status is-done">Committed</span>'
          : listed ? '<span class="status" title="Listed in your strategy with no budget: the keeper may move shares here">Listed</span>'
          : shares > 0n ? '<span class="status">In wallet</span>'
          : '';
        const over = budget > 0n && budget > shares ? `<small class="muted num">budget ${num(units(budget, h?.decimals ?? 18), 2)} · usable ${num(units(shares, h?.decimals ?? 18), 2)} shares</small>` : '';
        return `
        <li class="${shares > 0n || budget > 0n ? '' : 'is-empty'}">
          <span class="sc-hold-name"><i class="swatch c-${marketKey(m.name)}"></i><span><b>${esc(m.name)} · ${m.asset}</b><small class="muted">${esc(m.symbol)} · ${apyText(m.apy)} APY</small></span></span>
          <span class="r">${shares > 0n ? `<span class="num">${tok(h!.assets, m.asset)}</span><small class="muted num">${usd(value)}</small>` : '<span class="muted">—</span>'}${tag ? `<span class="sc-tag">${tag}</span>` : ''}${over}</span>
        </li>`;
      })
      .join('');
    $(root, '[data-total]').textContent = usd(total);
  }

  function renderSupply(): void {
    const { balances, wallet } = store.get();
    root.querySelectorAll<HTMLElement>('[data-mode]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
    root.querySelectorAll<HTMLElement>('[data-asset]').forEach((t) => t.setAttribute('aria-checked', String(t.dataset.asset === asset)));
    picker.querySelectorAll<HTMLElement>('[data-market]').forEach((b) => {
      const m = marketOf(b.dataset.market!);
      b.setAttribute('aria-checked', String(!!market && same(b.dataset.market!, market)));
      const h = holdingOf(b.dataset.market!);
      $(b, '[data-apy]').innerHTML = `${m ? apyText(m.apy) : ''}${
        mode === 'withdraw' ? `<small class="muted num">${h && h.shares > 0n ? tok(h.assets, asset, false) : '—'}</small>` : ''
      }`;
    });
    $(root, '[data-unit]').textContent = asset;
    $(root, '[data-amount-label]').textContent = mode === 'supply' ? 'Amount to supply' : 'Amount to withdraw';
    $(root, '[data-avail]').textContent = balances ? `${mode === 'supply' ? 'Wallet' : 'Position'} ${tok(available(), asset, false)}` : '';

    // Honest side effects: supplying doesn't raise a live budget; redeeming committed shares shrinks what the resolver can use.
    const note = $(root, '[data-supply-note]');
    const budget = market ? committedBudget(market) : 0n;
    const m = market ? marketOf(market) : undefined;
    note.hidden = !(budget > 0n && m);
    note.classList.toggle('is-info', mode === 'supply');
    if (m && budget > 0n) {
      note.textContent =
        mode === 'withdraw'
          ? `These ${m.symbol} shares are committed. Redeeming them reduces what the resolver can use; your strategy stays active on what remains.`
          : `Your committed budget on ${m.name} stays as shipped. To commit newly supplied shares, stop (dock) and commit again.`;
    }

    const a = amount();
    let label = mode === 'supply' ? `Supply to ${m?.name ?? 'market'}` : `Withdraw from ${m?.name ?? 'market'}`;
    let disabled = msg.busy || !market;
    if (wallet.status !== 'connected') {
      label = 'Connect wallet';
      disabled = true;
    } else if (a <= 0n) disabled = true;
    else if (balances && a > available()) {
      label = mode === 'supply' ? `Insufficient ${asset}` : 'Exceeds your position';
      disabled = true;
    }
    if (msg.busy) label = 'Working…';
    submit.textContent = label;
    submit.disabled = disabled;
  }

  /* ── Commit / active strategy ────────── */
  function renderCommit(snap: Snapshot, s: SelfCustody): void {
    const d = s.defaults;
    const b = store.get().balances;
    const active = activeCommits();
    const profiles = d.profiles.length ? d.profiles : [7000, 5000, 3000];
    const pBox = $(root, '[data-profiles]');
    if (pBox.childElementCount !== profiles.length) {
      pBox.innerHTML = profiles
        .map((bps, i) => `<button type="button" role="radio" data-profile="${i}"><span class="num">${splitLabel(bps)}</span><small class="muted">${PROFILE_NAMES[i] ?? ''}</small></button>`)
        .join('');
    }
    pBox.querySelectorAll<HTMLElement>('[data-profile]').forEach((t) => t.setAttribute('aria-checked', String(Number(t.dataset.profile) === profile)));
    $(root, '[data-jit-note]').textContent = jitBox.checked ? `Resolver borrows your shares’ assets for one transaction; fee ${d.flashFeeBps} bps → you` : 'Off · your shares are never lent to fills';
    $(root, '[data-mm-note]').textContent = mmBox.checked
      ? `Sells from your committed inventory at the oracle ± ${d.spreadBps} bps, skewed toward your target`
      : 'Off · your inventory is never swapped';

    commitForm.hidden = active.length > 0;
    activeEl.hidden = active.length === 0;
    $(root, '[data-commit-state]').innerHTML = active.length ? '<span class="status is-done">Active</span>' : 'not committed';

    if (!b?.sc) return;
    if (!active.length) {
      const order = shipOrder(s);
      $(root, '[data-budgets]').innerHTML = order
        .map((m) => {
          const h = holdingOf(m.address);
          const shares = h?.shares ?? 0n;
          const approved = (h?.aquaAllowance ?? 0n) >= MAX_ISH;
          return `
          <li class="${shares > 0n ? '' : 'is-empty'}">
            <span class="sc-hold-name"><i class="swatch c-${marketKey(m.name)}"></i><span><b>${esc(m.name)} · ${m.asset}</b><small class="muted num">${
              shares > 0n ? `${num(units(shares, h!.decimals), 2)} ${esc(m.symbol)}` : 'budget 0 · keeper may move shares here'
            }</small></span></span>
            <span class="r"><span class="num">${shares > 0n ? tok(h!.assets, m.asset) : '—'}</span><small class="${approved ? 'pos' : 'muted'}">${approved ? '✓ approved' : 'needs approval'}</small></span>
          </li>`;
        })
        .join('');
      const toApprove = order.filter((m) => (holdingOf(m.address)?.aquaAllowance ?? 0n) < MAX_ISH).length;
      const hasShares = order.some((m) => (holdingOf(m.address)?.shares ?? 0n) > 0n);
      let label = toApprove ? `Approve ${toApprove} & commit · ${toApprove + 1} tx` : 'Commit · 1 tx';
      if (!hasShares) label = 'Supply to a market first';
      if (commitMsg.busy) label = 'Working…';
      commitBtn.textContent = label;
      commitBtn.disabled = commitMsg.busy || !hasShares;
    } else {
      activeEl.innerHTML = active.map((c) => activeHtml(c, snap, s)).join('');
      activeEl.querySelectorAll<HTMLButtonElement>('[data-dock]').forEach((btn) => (btn.disabled = dockMsg.busy));
    }
  }

  function activeHtml(c: ScCommit, snap: Snapshot, s: SelfCustody): string {
    const st: ScStrategy | undefined = s.strategies.find((x) => same(x.hash, c.hash));
    const local = store.get().scLocal[c.hash];
    const flags = st ? strategyFlags(st) : local ? strategyFlags({ flashFeeBps: local.flashFeeBps, mm: { spreadBps: local.spreadBps, targetStableBps: local.profileBps, bandBps: 0 } }) : '';
    const rows = c.tokens
      .map((t) => {
        const m = marketOf(t.market);
        const h = holdingOf(t.market);
        if (!m || !h) return '';
        const perShare = h.shares > 0n ? (h.assets * 10n ** 18n) / h.shares : 0n;
        const committedAssets = perShare ? (t.budget * perShare) / 10n ** 18n : 0n;
        const walletAssets = h.assets;
        const usable = t.budget < h.shares ? committedAssets : walletAssets;
        return `
        <li class="${t.budget > 0n ? '' : 'is-empty'}">
          <span class="sc-hold-name"><i class="swatch c-${marketKey(m.name)}"></i><span><b>${esc(m.name)} · ${m.asset}</b><small class="muted">${
            t.budget > 0n && t.budget > h.shares ? 'usable capped by wallet balance' : t.budget > 0n ? 'committed · in your wallet' : 'listed · budget 0'
          }</small></span></span>
          <span class="r"><span class="num">${t.budget > 0n ? tok(usable, m.asset) : '—'}</span>${t.budget > 0n ? `<small class="muted num">${usd(toUsd(m.asset, usable, snap))}</small>` : ''}</span>
        </li>`;
      })
      .join('');
    const stats = st
      ? `
        <dl class="kv sc-kv">
          <div><dt>Earned</dt><dd class="num"><span class="pos">${usd(st.earned.totalUsd)}</span> <span class="muted">JIT ${usd(st.earned.jitFeesUsd)} · spread ${usd(st.earned.spreadUsd)}</span></dd></div>
          <div><dt>Fills from your liquidity</dt><dd class="num">${num(st.counts.flashes + st.counts.swaps, 0)} <span class="muted">(${num(st.counts.swaps, 0)} MM · ${num(st.counts.flashes, 0)} JIT)</span></dd></div>
          <div><dt>Keeper moves</dt><dd class="num">${num(st.counts.rebalances, 0)}</dd></div>
          <div><dt>Committed value</dt><dd class="num">${usd(st.valueUsd)}</dd></div>
        </dl>`
      : `<p class="note sc-indexing"><i class="spinner" aria-hidden="true"></i>Shipped${local ? ` · ${txLink(local.tx)}` : ''}. The relayer indexes new strategies within a few seconds.</p>`;
    return `
      <div class="sc-active">
        <div class="sc-active-head"><span>${flags ? `<b class="num">${esc(flags)}</b>` : ''}<small class="muted num" title="${c.hash}">Strategy ${short(c.hash)} · keeper on</small></span></div>
        <ul class="sc-budgets">${rows}</ul>
        ${stats}
        <button type="button" class="btn btn-secondary btn-block" data-dock="${c.hash}">Stop (dock)</button>
        <small class="muted sc-dock-note">Dock removes the budgets in one transaction. Your shares stay where they are; withdraw them in step 1 whenever you like.</small>
      </div>`;
  }

  /* ── Events ──────────────────────────── */
  const reset = () => {
    input.value = '';
    useMax = false;
    msg.idle(idleText());
  };
  $(root, '[data-connect]').addEventListener('click', () => void connect());
  $(root, '[data-switch]').addEventListener('click', async () => {
    switchMsg.hidden = true;
    try {
      await switchNetwork();
    } catch (e) {
      switchMsg.hidden = false;
      switchMsg.textContent = (e as { code?: number }).code === 4001 ? 'Rejected in your wallet.' : 'Could not switch automatically. Select Base Sepolia in your wallet.';
    }
  });
  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((t) =>
    t.addEventListener('click', () => {
      if (msg.busy) return;
      mode = t.dataset.mode as Mode;
      reset();
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-asset]').forEach((t) =>
    t.addEventListener('click', () => {
      if (msg.busy || asset === t.dataset.asset) return;
      asset = t.dataset.asset as Token;
      market = null;
      reset();
      render();
    }),
  );
  picker.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-market]');
    if (!b || msg.busy) return;
    market = b.dataset.market as Address;
    useMax = false;
    if (mode === 'withdraw') input.value = '';
    msg.idle(idleText());
    render();
  });
  input.addEventListener('input', () => {
    useMax = false;
    if (!msg.busy) msg.idle(idleText());
    render();
  });
  $(root, '[data-max]').addEventListener('click', () => {
    input.value = toInput(available(), TOKEN_DEC[asset], TOKEN_DP[asset] + 2);
    useMax = mode === 'withdraw';
    render();
    input.focus();
  });
  $(root, '[data-profiles]').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-profile]');
    if (!b || commitMsg.busy) return;
    profile = Number(b.dataset.profile);
    render();
  });
  jitBox.addEventListener('change', render);
  mmBox.addEventListener('change', render);

  const settle = async () => {
    await refreshBalances();
    setTimeout(() => void refreshBalances(), 4_000); // the public RPC can lag a block
  };

  // Supply: approve the asset to the market, deposit(assets, you). Withdraw: redeem(shares, you, you).
  $(root, '[data-supply]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const snap = store.get().snapshot;
    const m = market ? marketOf(market) : undefined;
    if (!snap || !m || msg.busy) return;
    msg.busy = true;
    render();
    try {
      const user = account();
      if (mode === 'supply') {
        const assets = amount();
        const token = asset === 'USDC' ? snap.contracts.usdc : snap.contracts.weth;
        await ensureAllowance(token, m.address, assets, asset, msg.step);
        const r = await write({ address: m.address, abi: aave4626Abi, functionName: 'deposit', args: [assets, user] }, `Supply to ${m.name}`, msg.step);
        msg.done(`Supplied ${tok(assets, asset)} to ${m.name} · ${m.symbol} is in your wallet`, r.transactionHash);
      } else {
        const h = holdingOf(m.address);
        if (!h || h.shares === 0n) throw new Error('No shares in this market.');
        const want = amount();
        let shares = useMax || want >= h.assets ? h.shares : h.assets > 0n ? (want * h.shares) / h.assets : 0n;
        if (shares > h.shares) shares = h.shares;
        if (shares === 0n) throw new Error('Amount too small.');
        const r = await write({ address: m.address, abi: aave4626Abi, functionName: 'redeem', args: [shares, user, user] }, `Withdraw from ${m.name}`, msg.step);
        msg.done(`Redeemed ${num(units(shares, h.decimals), 4)} ${m.symbol} → ${asset} in your wallet`, r.transactionHash);
      }
      input.value = '';
      useMax = false;
      await settle();
    } catch (err) {
      msg.fail(err);
    }
    render();
  });

  // Commit: approve Aqua for every listed share token (skip if already max), then Aqua.ship(app, strategy, tokens, budgets).
  commitBtn.addEventListener('click', async () => {
    const snap = store.get().snapshot;
    const s = snap?.selfCustody;
    if (!snap || !s || commitMsg.busy) return;
    dockMsgEl.hidden = true;
    commitMsg.busy = true;
    render();
    try {
      const user = account();
      const d = s.defaults;
      const order: ScMarket[] = shipOrder(s);
      const tokens = order.map((m) => m.address);
      const pending = order.filter((m) => (holdingOf(m.address)?.aquaAllowance ?? 0n) < MAX_ISH);
      for (const [i, m] of pending.entries()) {
        await write(
          { address: m.address, abi: mockERC20Abi, functionName: 'approve', args: [s.aqua, maxUint256] },
          `Approve ${m.symbol} for Aqua (${i + 1}/${pending.length})`,
          commitMsg.step,
        );
      }
      // Budgets: the current share balance per market, read fresh so the ship matches the wallet.
      await refreshBalances();
      const amounts = order.map((m) => holdingOf(m.address)?.shares ?? 0n);
      if (!amounts.some((a) => a > 0n)) throw new Error('No shares to commit. Supply to a market first.');
      const targetStableBps = (d.profiles.length ? d.profiles : [7000, 5000, 3000])[profile];
      const flashFeeBps = jitBox.checked ? d.flashFeeBps : 0;
      const spreadBps = mmBox.checked ? d.spreadBps : 0;
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const { bytes, hash } = encodeStrategy({
        maker: user,
        stable: snap.contracts.usdc,
        volatileAsset: snap.contracts.weth,
        stableMarkets: order.filter((m) => m.asset === 'USDC').map((m) => m.address),
        volatileMarkets: order.filter((m) => m.asset === 'WETH').map((m) => m.address),
        keeper: d.keeper,
        taker: d.taker,
        flashFeeBps,
        mm: { oracle: d.oracle, maxPriceAge: d.maxPriceAge, spreadBps, skewBps: d.skewBps, maxTradeBps: d.maxTradeBps, targetStableBps, bandBps: d.bandBps },
        salt,
      });
      const r = await write({ address: s.aqua, abi: aquaAbi, functionName: 'ship', args: [s.app, bytes, tokens, amounts] }, 'Commit (ship)', commitMsg.step);
      store.update((st) => ({ scLocal: { ...st.scLocal, [hash]: { profileBps: targetStableBps, flashFeeBps, spreadBps, shippedAt: Date.now(), tx: r.transactionHash } } }));
      commitMsg.done('Committed · your shares stay in your wallet', r.transactionHash);
      await settle();
    } catch (err) {
      commitMsg.fail(err);
    }
    render();
  });

  // Stop: Aqua.dock(app, hash, tokens) with exactly the strategy's tokens (read from Aqua).
  activeEl.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-dock]');
    const s = store.get().snapshot?.selfCustody;
    if (!btn || !s || dockMsg.busy) return;
    const c = activeCommits().find((x) => same(x.hash, btn.dataset.dock!));
    if (!c) return;
    dockMsgEl.hidden = false;
    dockMsg.busy = true;
    render();
    try {
      account();
      const r = await write(
        { address: s.aqua, abi: aquaAbi, functionName: 'dock', args: [s.app, c.hash as Hex, c.tokens.map((t) => t.market)] },
        'Stop (dock)',
        dockMsg.step,
      );
      dockMsg.done('Docked · budgets cleared, shares untouched in your wallet', r.transactionHash);
      commitMsg.idle();
      await settle();
    } catch (err) {
      dockMsg.fail(err);
    }
    render();
  });

  msg.idle(idleText());
  store.subscribe(render);
}
