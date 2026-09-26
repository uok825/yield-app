import type { Address, Hex } from 'viem';
import { type OrderRecord, type QuoteResponse, getOrder, postOrder, postQuote } from '../api.ts';
import { account, ensureAllowance, received, refreshBalances, txUrl, walletClient } from '../chain.ts';
import { POLL } from '../config.ts';
import { $, ago, num, parseAmount, short, type Token, TOKEN_DEC, TOKEN_DP, toInput, tok, units, usd } from '../format.ts';
import { store } from '../store.ts';
import { pairOf, routeLabel, symbolOf } from './fills.ts';
import { txStatus } from './tx.ts';

type Dir = 'USDC' | 'WETH'; // the token the user sells (maker asset)
const other = (t: Token): Token => (t === 'USDC' ? 'WETH' : 'USDC');
const KEY = 'yieldsolver.intent';
const QUOTE_TTL = 15_000; // re-quote before signing if the auction start drifted

const statusPill = (o: OrderRecord) =>
  ({
    pending: '<span class="status is-live">Auction</span>',
    filled: '<span class="status is-done">Filled</span>',
    expired: '<span class="status">Expired</span>',
    cancelled: '<span class="status">Cancelled</span>',
  })[o.status];

/** The headline demo: quote → approve → sign a 1inch Fusion order → watch the resolver fill it. */
export function mountIntent(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head card-head-row">
      <div><h2>Fusion intent</h2><p class="muted">Sign a gasless 1inch Fusion order. YieldSolver’s resolver fills it from strategy liquidity.</p></div>
    </header>
    <div data-form>
      <div class="tabs" role="radiogroup" aria-label="Direction">
        <button type="button" role="radio" data-dir="USDC">USDC → WETH</button>
        <button type="button" role="radio" data-dir="WETH">WETH → USDC</button>
      </div>
      <div class="field-head"><label for="i-amount">You sell</label><span class="muted num" data-avail></span></div>
      <div class="field">
        <input id="i-amount" class="num" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" />
        <span class="muted" data-unit></span>
        <button type="button" class="link-btn" data-max>Max</button>
      </div>
      <p class="est muted num" data-est></p>
      <dl class="kv review" data-review hidden></dl>
      <button type="button" class="btn btn-primary btn-block" data-go></button>
      <p class="tx-msg" data-msg aria-live="polite"></p>
    </div>
    <div class="track" data-track hidden aria-live="polite">
      <div class="track-head"><span data-t-status></span><span class="num muted" data-t-clock></span></div>
      <div class="progress" data-t-progress><i></i></div>
      <dl class="kv" data-t-kv></dl>
      <p class="track-result" data-t-result></p>
      <button type="button" class="btn btn-secondary btn-block" data-new>New intent</button>
    </div>
    <div class="mine">
      <h3>Your intents</h3>
      <ul class="mine-list" data-mine></ul>
    </div>`;

  let dir: Dir = 'USDC';
  let quote: { res: QuoteResponse; at: number; making: bigint } | null = null;
  let quoting = false;
  let tracking: { hash: Hex; order: OrderRecord | null; got: bigint | null } | null = null;
  let pollTimer = 0;
  let clockTimer = 0;

  const input = $<HTMLInputElement>(root, '#i-amount');
  const go = $<HTMLButtonElement>(root, '[data-go]');
  const review = $(root, '[data-review]');
  const msg = txStatus($(root, '[data-msg]'), 'You sign a message, not a transaction: no gas for the swap itself.');
  const making = () => parseAmount(input.value, TOKEN_DEC[dir]) ?? 0n;
  const addrs = () => {
    const c = store.get().snapshot!.contracts;
    return dir === 'USDC' ? { maker: c.usdc, taker: c.weth } : { maker: c.weth, taker: c.usdc };
  };

  function renderReview(): void {
    review.hidden = !quote;
    if (!quote) return;
    const q = quote.res.quote;
    const recv = other(dir);
    review.innerHTML = `
      <div><dt>You pay</dt><dd class="num">${tok(quote.making, dir)}</dd></div>
      <div><dt>You receive</dt><dd class="num">${tok(q.startTaking, recv, false)} → ${tok(q.minTaking, recv)}</dd></div>
      <div><dt>Dutch auction</dt><dd class="num">${q.auctionEnd - q.auctionStart}s · best price first</dd></div>
      <div><dt>ETH price (oracle)</dt><dd class="num">${usd(q.ethUsd)}</dd></div>`;
  }

  function renderForm(): void {
    const { snapshot, balances, wallet } = store.get();
    root.querySelectorAll<HTMLElement>('[data-dir]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.dir === dir)));
    $(root, '[data-unit]').textContent = dir;
    const bal = balances ? (dir === 'USDC' ? balances.usdc : balances.weth) : null;
    $(root, '[data-avail]').textContent = bal === null ? '' : `Wallet ${tok(bal, dir, false)}`;
    const a = making();
    const price = snapshot?.oracle.price ?? 0;
    const est = dir === 'USDC' ? units(a, 6) / price : units(a, 18) * price;
    $(root, '[data-est]').textContent = a > 0n && price ? `≈ ${num(est, TOKEN_DP[other(dir)])} ${other(dir)} at the oracle price of ${usd(price)}` : '';
    const usdValue = dir === 'USDC' ? units(a, 6) : units(a, 18) * price;

    let label = quote ? 'Sign & submit intent' : 'Review intent';
    let disabled = msg.busy || quoting;
    if (wallet.status !== 'connected') {
      label = 'Connect wallet to trade';
      disabled = true;
    } else if (a === 0n) disabled = true;
    else if (bal !== null && a > bal) {
      label = `Insufficient ${dir}`;
      disabled = true;
    } else if (usdValue < 1 || usdValue > 50_000) {
      label = 'Between $1 and $50,000';
      disabled = true;
    }
    if (quoting) label = 'Fetching quote…';
    else if (msg.busy) label = 'Working…';
    go.textContent = label;
    go.disabled = disabled;
  }

  function renderMine(): void {
    const { snapshot, myOrders, wallet } = store.get();
    const list = $(root, '[data-mine]');
    $(root, '.mine').hidden = wallet.status !== 'connected';
    if (!snapshot) return;
    const now = Date.now();
    list.innerHTML = myOrders.length
      ? myOrders
          .slice(0, 5)
          .map((o) => {
            const route = o.status === 'filled' ? routeLabel(o.report?.route) : '';
            const tx = o.fillTx ? ` · <a href="${txUrl(o.fillTx)}" target="_blank" rel="noopener">tx ↗</a>` : '';
            return `<li><span><b>${pairOf(o, snapshot)}</b><small class="muted">${tok(o.makingAmount, symbolOf(o.makerAsset, snapshot))} · ${ago(now - o.createdAt)}${route ? ` · ${route}` : ''}${tx}</small></span>${statusPill(o)}</li>`;
          })
          .join('')
      : '<li class="muted empty-sm">No intents yet.</li>';
  }

  /* ── Tracking ─────────────────────────── */

  function renderTrack(): void {
    const snapshot = store.get().snapshot;
    const t = tracking;
    $(root, '[data-form]').hidden = !!t;
    $(root, '[data-track]').hidden = !t;
    if (!t || !snapshot) return;
    const o = t.order;
    const now = Date.now() / 1000;
    const statusEl = $(root, '[data-t-status]');
    const clock = $(root, '[data-t-clock]');
    const bar = $(root, '[data-t-progress]');
    const result = $(root, '[data-t-result]');
    if (!o) {
      statusEl.innerHTML = '<span class="status is-live">Submitted</span>';
      return;
    }
    const pay = symbolOf(o.makerAsset, snapshot);
    const recv = symbolOf(o.takerAsset, snapshot);
    const start = quote?.res.orderHash === o.orderHash ? quote.res.quote.startTaking : null;
    const span = Math.max(1, o.auctionEnd - o.auctionStart);
    const progress = Math.min(1, Math.max(0, (now - o.auctionStart) / span));
    statusEl.innerHTML = statusPill(o);
    bar.classList.toggle('is-done', o.status === 'filled');
    bar.classList.toggle('is-off', o.status === 'expired' || o.status === 'cancelled');
    (bar.firstElementChild as HTMLElement).style.width = `${(o.status === 'filled' ? 1 : progress) * 100}%`;

    if (o.status === 'pending') {
      clock.textContent = now < o.auctionStart ? `Starts in ${Math.ceil(o.auctionStart - now)}s` : now < o.auctionEnd ? `${Math.ceil(o.auctionEnd - now)}s left` : `Deadline in ${Math.max(0, Math.ceil(o.deadline - now))}s`;
      const current = start !== null ? start - ((start - o.minTakingAmount) * BigInt(Math.round(progress * 1000))) / 1000n : null;
      result.innerHTML = `<i class="spinner" aria-hidden="true"></i> Waiting for a resolver to fill${current !== null ? ` · current price ≈ <span class="num">${tok(current, recv)}</span>` : ''}`;
      result.className = 'track-result is-live';
    } else if (o.status === 'filled') {
      clock.textContent = ago(Date.now() - o.updatedAt);
      const via = o.report ? routeLabel(o.report.route) : '';
      const tx = o.fillTx ? ` <a href="${txUrl(o.fillTx)}" target="_blank" rel="noopener">View fill ↗</a>` : '';
      result.innerHTML = `✓ Filled by YieldSolver${via ? ` via ${via}` : ''}.${tx}`;
      result.className = 'track-result is-done';
    } else {
      clock.textContent = '';
      result.textContent =
        o.status === 'expired' ? 'Expired: no fill before the deadline. Your tokens never left your wallet.' : 'Cancelled. Your tokens never left your wallet.';
      result.className = 'track-result muted';
    }
    $(root, '[data-t-kv]').innerHTML = `
      <div><dt>${o.status === 'filled' ? 'You paid' : 'You pay'}</dt><dd class="num">${tok(o.makingAmount, pay)}</dd></div>
      <div><dt>${o.status === 'filled' ? 'You received' : 'You receive'}</dt><dd class="num">${
        o.status === 'filled' && t.got !== null
          ? `<b class="pos">${tok(t.got, recv)}</b>`
          : o.status === 'filled'
            ? '<span class="muted">reading…</span>'
            : `${start !== null ? `${tok(start, recv, false)} → ` : '≥ '}${tok(o.minTakingAmount, recv)}`
      }</dd></div>
      <div><dt>Order</dt><dd class="num muted">${short(o.orderHash)}</dd></div>`;
  }

  async function poll(): Promise<void> {
    const t = tracking;
    if (!t) return;
    try {
      const o = await getOrder(t.hash);
      if (tracking !== t) return;
      t.order = o;
      if (o.status === 'filled' && o.fillTx && t.got === null) {
        t.got = await received(o.fillTx, o.takerAsset, o.maker).catch(() => null);
        void refreshBalances();
      }
    } catch {
      /* keep polling */
    }
    renderTrack();
    const o = t.order;
    // Keep polling while pending, and briefly after a fill until the resolver's route report lands.
    const settled = o && o.status !== 'pending' && (o.status !== 'filled' || (o.report && t.got !== null) || Date.now() - o.updatedAt > 60_000);
    if (tracking === t && !settled) pollTimer = window.setTimeout(poll, POLL.order);
  }

  function track(hash: Hex | null): void {
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    tracking = hash ? { hash, order: null, got: null } : null;
    try {
      if (hash) localStorage.setItem(KEY, JSON.stringify({ hash, at: Date.now() }));
      else localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    renderTrack();
    if (!hash) return;
    clockTimer = window.setInterval(renderTrack, 1_000);
    void poll();
  }

  /* ── Actions ──────────────────────────── */

  async function fetchQuote(): Promise<void> {
    const user = account();
    const a = making();
    const { maker, taker } = addrs();
    const res = await postQuote({ maker: user, makerAsset: maker, takerAsset: taker, makingAmount: a });
    quote = { res, at: Date.now(), making: a };
    renderReview();
  }

  async function submit(): Promise<void> {
    const snap = store.get().snapshot!;
    const user = account();
    const { maker } = addrs();
    const lop = snap.contracts.limitOrderProtocol as Address;
    await ensureAllowance(maker, lop, quote!.making, dir, msg.step, true);
    if (Date.now() - quote!.at > QUOTE_TTL) {
      msg.step({ kind: 'info', label: 'Refreshing quote…' });
      await fetchQuote();
    }
    const { res } = quote!;
    msg.step({ kind: 'wallet', label: 'Sign the intent in your wallet' });
    const td = res.typedData;
    // Passed through exactly as the relayer built it (EIP-712 Order for the Limit Order Protocol v4).
    const signature = await walletClient!.signTypedData({
      account: user,
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    } as Parameters<NonNullable<typeof walletClient>['signTypedData']>[0]);
    msg.step({ kind: 'info', label: 'Submitting to the relayer…' });
    const hash = await postOrder({ orderHash: res.orderHash, order: res.order, extension: res.extension, signature });
    msg.idle();
    track(hash);
    void refreshBalances();
  }

  go.addEventListener('click', async () => {
    if (msg.busy || quoting) return;
    try {
      if (!quote) {
        quoting = true;
        renderForm();
        msg.idle();
        await fetchQuote();
      } else {
        msg.busy = true;
        renderForm();
        await submit();
      }
    } catch (e) {
      msg.fail(e);
    } finally {
      quoting = false;
      msg.busy = false;
      renderForm();
    }
  });

  const invalidate = () => {
    if (msg.busy) return;
    quote = null;
    renderReview();
    msg.idle();
    renderForm();
  };
  root.querySelectorAll<HTMLButtonElement>('[data-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      if (msg.busy || dir === b.dataset.dir) return;
      dir = b.dataset.dir as Dir;
      input.value = '';
      invalidate();
    }),
  );
  input.addEventListener('input', invalidate);
  $(root, '[data-max]').addEventListener('click', () => {
    const b = store.get().balances;
    if (!b) return;
    input.value = toInput(dir === 'USDC' ? b.usdc : b.weth, TOKEN_DEC[dir], TOKEN_DP[dir]);
    invalidate();
    input.focus();
  });
  $(root, '[data-new]').addEventListener('click', () => {
    track(null);
    input.value = '';
    invalidate();
  });

  store.subscribe(() => {
    renderForm();
    renderMine();
  });

  try {
    // Resume tracking an intent from the last few minutes (e.g. after a reload).
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { hash: Hex; at: number } | null;
    if (saved && Date.now() - saved.at < 10 * 60_000) track(saved.hash);
  } catch {
    /* ignore */
  }
}
