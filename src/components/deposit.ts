import { deposit, maxWithdraw, sharePrice, sharesForDeposit, userAssets, withdraw } from '../engine/vault.ts';
import { $, num, pct, usd } from '../format.ts';
import { store } from '../store.ts';
import type { State } from '../types.ts';

type Mode = 'deposit' | 'withdraw';

export function mountDeposit(root: HTMLElement): void {
  root.innerHTML = `
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-mode="deposit">Deposit</button>
      <button type="button" role="tab" data-mode="withdraw">Withdraw</button>
    </div>
    <form class="deposit-form" novalidate>
      <div class="field-head">
        <label for="amount">Amount</label>
        <span class="muted num" data-avail></span>
      </div>
      <div class="field">
        <input id="amount" class="num" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" />
        <span class="muted">USDC</span>
        <button type="button" class="link-btn" data-max>Max</button>
      </div>
      <dl class="kv">
        <div><dt data-out-label></dt><dd class="num" data-out></dd></div>
        <div><dt>Share price</dt><dd class="num" data-price></dd></div>
      </dl>
      <button type="submit" class="btn btn-primary btn-block" data-submit></button>
      <p class="form-msg muted" data-msg aria-live="polite"></p>
    </form>
    <div class="position">
      <h3>Your position</h3>
      <div class="position-value num" data-pos></div>
      <dl class="kv">
        <div><dt>Shares</dt><dd class="num" data-shares></dd></div>
        <div><dt>Share of vault</dt><dd class="num" data-own></dd></div>
      </dl>
    </div>`;

  let mode: Mode = 'deposit';
  let msg = '';
  const input = $<HTMLInputElement>(root, '#amount');
  const submit = $<HTMLButtonElement>(root, '[data-submit]');
  const tabs = root.querySelectorAll<HTMLButtonElement>('[data-mode]');

  const amount = () => {
    const v = parseFloat(input.value.replace(/,/g, ''));
    return Number.isFinite(v) ? v : 0;
  };
  const available = (s: State) => (mode === 'deposit' ? s.walletUsdc : maxWithdraw(s));

  function render(s: State): void {
    const a = amount();
    const avail = available(s);
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
    $(root, '[data-avail]').textContent = `${mode === 'deposit' ? 'Wallet' : 'Available'} ${num(avail)} USDC`;
    $(root, '[data-out-label]').textContent = mode === 'deposit' ? 'You receive' : 'Shares burned';
    const shares = mode === 'deposit' ? sharesForDeposit(s, a) : a / sharePrice(s);
    $(root, '[data-out]').textContent = `${num(Math.max(0, shares), 4)} ysUSDC`;
    $(root, '[data-price]').textContent = `${num(sharePrice(s), 5)} USDC`;

    let label = mode === 'deposit' ? 'Deposit' : 'Withdraw';
    let disabled = false;
    if (!s.walletConnected) label = 'Connect wallet';
    else if (a <= 0) disabled = true;
    else if (a > avail + 1e-9) {
      label = mode === 'deposit' ? 'Insufficient balance' : 'Exceeds available';
      disabled = true;
    }
    submit.textContent = label;
    submit.disabled = disabled;
    $(root, '[data-msg]').textContent = msg || 'Simulated — no transaction is sent.';

    $(root, '[data-pos]').textContent = usd(userAssets(s));
    $(root, '[data-shares]').textContent = num(s.userShares, 4);
    $(root, '[data-own]').textContent = pct(s.totalShares > 0 ? (s.userShares / s.totalShares) * 100 : 0);
  }

  tabs.forEach((t) =>
    t.addEventListener('click', () => {
      mode = t.dataset.mode as Mode;
      input.value = '';
      msg = '';
      render(store.get());
    }),
  );

  input.addEventListener('input', () => {
    msg = '';
    render(store.get());
  });

  $(root, '[data-max]').addEventListener('click', () => {
    input.value = String(Math.floor(available(store.get()) * 100) / 100);
    render(store.get());
    input.focus();
  });

  $(root, 'form').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = store.get();
    if (!s.walletConnected) {
      store.update(() => ({ walletConnected: true }));
      return;
    }
    const a = amount();
    const patch = mode === 'deposit' ? deposit(s, a) : withdraw(s, a);
    if (Object.keys(patch).length === 0) return;
    msg = `${mode === 'deposit' ? 'Deposited' : 'Withdrew'} ${usd(a)}.`;
    input.value = '';
    store.update(() => patch);
  });

  store.subscribe(render);
}
