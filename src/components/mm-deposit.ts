import { MM, PROFILES } from '../config.ts';
import { deposit, previewDeposit, previewWithdraw, userValue, withdraw } from '../engine/mm.ts';
import { $, num, pct, usd } from '../format.ts';
import { mmStore, store } from '../store.ts';
import type { ProfileId } from '../types.ts';

type Mode = 'deposit' | 'withdraw';

const field = (id: string, label: string, unit: string) => `
  <div class="field-head"><label for="${id}">${label}</label><span class="muted num" data-avail="${id}"></span></div>
  <div class="field">
    <input id="${id}" class="num" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" />
    <span class="muted">${unit}</span>
    <button type="button" class="link-btn" data-max="${id}">Max</button>
  </div>`;

export function mountMmDeposit(root: HTMLElement): void {
  root.innerHTML = `
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-mode="deposit">Deposit</button>
      <button type="button" role="tab" data-mode="withdraw">Withdraw</button>
    </div>
    <form class="deposit-form" novalidate>
      <div class="field-head"><span class="label">Profile</span></div>
      <div class="tabs tabs-3" role="radiogroup" aria-label="Profile">
        ${PROFILES.map((p) => `<button type="button" role="radio" data-profile="${p.id}">${p.name}</button>`).join('')}
      </div>
      <div data-group="deposit" class="stack">${field('b-usdc', 'USDC', 'USDC')}${field('b-eth', 'ETH', 'ETH')}</div>
      <div data-group="withdraw" class="stack">${field('b-shares', 'Shares to burn', 'shares')}</div>
      <dl class="kv" data-kv></dl>
      <button type="submit" class="btn btn-primary btn-block" data-submit></button>
      <p class="form-msg muted" data-msg aria-live="polite"></p>
    </form>
    <div class="position">
      <h3>Your positions</h3>
      <div class="position-value num" data-pos></div>
      <ul class="pos-list" data-pos-list></ul>
    </div>`;

  let mode: Mode = 'deposit';
  let profile: ProfileId = 'balanced';
  let msg = '';
  const inputs = { usdc: $<HTMLInputElement>(root, '#b-usdc'), eth: $<HTMLInputElement>(root, '#b-eth'), shares: $<HTMLInputElement>(root, '#b-shares') };
  const submit = $<HTMLButtonElement>(root, '[data-submit]');
  const read = (el: HTMLInputElement) => {
    const v = parseFloat(el.value.replace(/,/g, ''));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };

  /** Wallet balances / position caps for each input. */
  const caps = () => {
    const p = mmStore.get().profiles.find((x) => x.id === profile)!;
    return { 'b-usdc': store.get().walletUsdc, 'b-eth': mmStore.get().walletEth, 'b-shares': p.userShares };
  };

  function render(): void {
    const s = mmStore.get();
    const connected = store.get().walletConnected;
    const p = s.profiles.find((x) => x.id === profile)!;
    const cap = caps();
    const [u, e, sh] = [read(inputs.usdc), read(inputs.eth), read(inputs.shares)];

    root.querySelectorAll<HTMLElement>('[data-mode]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
    root.querySelectorAll<HTMLElement>('[data-profile]').forEach((t) => t.setAttribute('aria-checked', String(t.dataset.profile === profile)));
    root.querySelectorAll<HTMLElement>('[data-group]').forEach((g) => (g.hidden = g.dataset.group !== mode));
    $(root, '[data-avail="b-usdc"]').textContent = `Wallet ${num(cap['b-usdc'])}`;
    $(root, '[data-avail="b-eth"]').textContent = `Wallet ${num(cap['b-eth'], 4)}`;
    $(root, '[data-avail="b-shares"]').textContent = `Yours ${num(cap['b-shares'], 2)}`;

    let label = mode === 'deposit' ? 'Deposit' : 'Withdraw';
    let problem = ''; // replaces the button label when set
    let empty = false;
    const [lo, hi] = [p.target * 100 - MM.bandBps / 100, p.target * 100 + MM.bandBps / 100];
    if (mode === 'deposit') {
      const d = previewDeposit(s, profile, u, e);
      const bandNote = d.ok ? (Math.abs(d.after - p.target) <= MM.bandBps / 1e4 ? 'in band' : 'toward target') : `outside ${lo}–${hi}%`;
      $(root, '[data-kv]').innerHTML = `
        <div><dt>Deposit value</dt><dd class="num">${usd(d.value)}</dd></div>
        <div><dt>Shares received</dt><dd class="num">${num(d.shares, 4)}</dd></div>
        <div><dt>USDC ratio after</dt><dd class="num ${d.ok ? '' : 'neg'}">${pct(d.after * 100, 1)} · ${bandNote}</dd></div>`;
      if (u > cap['b-usdc'] + 1e-9 || e > cap['b-eth'] + 1e-12) problem = 'Insufficient balance';
      else if (!d.ok && d.value > 0) problem = 'Outside band';
      else empty = d.value <= 0;
    } else {
      const w = previewWithdraw(s, profile, sh);
      $(root, '[data-kv]').innerHTML = `
        <div><dt>You receive</dt><dd class="num">${num(w.usdc)} USDC</dd></div>
        <div><dt></dt><dd class="num">+ ${num(w.eth, 5)} ETH</dd></div>
        <div><dt>Value at oracle</dt><dd class="num">${usd(w.value)}</dd></div>`;
      if (sh > cap['b-shares'] + 1e-9) problem = 'Exceeds your shares';
      else empty = sh <= 0;
    }
    if (!connected) label = 'Connect wallet';
    else if (problem) label = problem;
    submit.textContent = label;
    submit.disabled = connected && (problem !== '' || empty);
    $(root, '[data-msg]').textContent =
      msg || (mode === 'deposit' ? 'Accepted if the ratio stays in band or moves toward target.' : 'In-kind: pays your pro-rata USDC and ETH.');

    const total = s.profiles.reduce((a, x) => a + userValue(x, s.price), 0);
    $(root, '[data-pos]').textContent = usd(total);
    $(root, '[data-pos-list]').innerHTML = s.profiles
      .map((x) => {
        const w = previewWithdraw(s, x.id, x.userShares);
        return `<li><span>${x.name}</span><span class="r"><span class="num">${usd(w.value)}</span><small class="muted num">${num(w.usdc, 0)} USDC + ${num(w.eth, 3)} ETH</small></span></li>`;
      })
      .join('');
  }

  const clear = () => {
    Object.values(inputs).forEach((el) => (el.value = ''));
    msg = '';
  };

  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((t) =>
    t.addEventListener('click', () => {
      mode = t.dataset.mode as Mode;
      clear();
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach((t) =>
    t.addEventListener('click', () => {
      profile = t.dataset.profile as ProfileId;
      clear();
      render();
    }),
  );
  Object.values(inputs).forEach((el) =>
    el.addEventListener('input', () => {
      msg = '';
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-max]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.max as keyof ReturnType<typeof caps>;
      const dp = id === 'b-usdc' ? 100 : 1e6;
      const el = $<HTMLInputElement>(root, `#${id}`);
      el.value = String(Math.floor(caps()[id] * dp) / dp);
      render();
      el.focus();
    }),
  );

  $(root, 'form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!store.get().walletConnected) {
      store.update(() => ({ walletConnected: true }));
      return;
    }
    const s = mmStore.get();
    const name = s.profiles.find((x) => x.id === profile)!.name;
    if (mode === 'deposit') {
      const [u, e] = [read(inputs.usdc), read(inputs.eth)];
      if (u > store.get().walletUsdc + 1e-9) return;
      const patch = deposit(s, profile, u, e);
      if (!patch.profiles) return;
      clear();
      msg = `Deposited ${usd(u + e * s.price)} into ${name}.`;
      store.update((a) => ({ walletUsdc: a.walletUsdc - u }));
      mmStore.update(() => patch);
    } else {
      const p = s.profiles.find((x) => x.id === profile)!;
      // Within 0.01 of the whole position ("Max" rounds down): burn everything.
      const sh = read(inputs.shares) >= p.userShares - 0.01 ? p.userShares : read(inputs.shares);
      const out = previewWithdraw(s, profile, sh);
      const patch = withdraw(s, profile, sh);
      if (!patch.profiles) return;
      clear();
      msg = `Withdrew ${num(out.usdc)} USDC + ${num(out.eth, 5)} ETH.`;
      store.update((a) => ({ walletUsdc: a.walletUsdc + out.usdc }));
      mmStore.update(() => patch);
    }
  });

  mmStore.subscribe(render);
  store.subscribe(render);
}
