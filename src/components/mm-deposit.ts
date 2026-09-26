import type { Address } from 'viem';
import { inventoryVaultAbi } from '../../bots/src/abis.ts';
import type { InventoryVault } from '../api.ts';
import { account, ensureAllowance, publicClient, refreshBalances, write } from '../chain.ts';
import { PROFILE_NAMES } from '../config.ts';
import { $, num, parseAmount, pct, toInput, tok, units, usd } from '../format.ts';
import { store } from '../store.ts';
import { txStatus } from './tx.ts';

type Mode = 'deposit' | 'withdraw';
type FieldId = 'b-usdc' | 'b-weth' | 'b-shares';

const field = (id: FieldId, label: string, unit: string, extra = '') => `
  <div class="field-head"><label for="${id}">${label}</label><span class="muted num" data-avail="${id}"></span></div>
  <div class="field">
    <input id="${id}" class="num" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" />
    <span class="muted">${unit}</span>${extra}
    <button type="button" class="link-btn" data-max="${id}">Max</button>
  </div>`;

const DEC: Record<FieldId, number> = { 'b-usdc': 6, 'b-weth': 18, 'b-shares': 18 };

/** Client-side band check mirroring InventoryVault.deposit: accept if in band after, or strictly closer to target. */
function bandCheck(v: InventoryVault, price: number, usdcIn: bigint, wethIn: bigint) {
  const ratio = (s: number, w: number) => (s + w * price > 0 ? (s / (s + w * price)) * 1e4 : v.targetStableBps);
  const s0 = units(v.stable, 6);
  const w0 = units(v.volatile, 18);
  const before = ratio(s0, w0);
  const after = ratio(s0 + units(usdcIn, 6), w0 + units(wethIn, 18));
  const inBand = Math.abs(after - v.targetStableBps) <= v.bandBps;
  const improves = Math.abs(after - v.targetStableBps) < Math.abs(before - v.targetStableBps);
  return { after, inBand, ok: inBand || improves };
}

/** Strategy B · two-asset deposit into one profile, in-kind redeem. */
export function mountMmDeposit(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head card-head-row"><h2>Inventory vault</h2><span class="muted small">USDC + WETH</span></header>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-mode="deposit">Deposit</button>
      <button type="button" role="tab" data-mode="withdraw">Withdraw</button>
    </div>
    <form class="deposit-form" novalidate>
      <div class="field-head"><span class="label">Profile</span><span class="muted num" data-target></span></div>
      <div class="tabs tabs-3" role="radiogroup" aria-label="Profile">
        ${PROFILE_NAMES.map((n, i) => `<button type="button" role="radio" data-profile="${i}">${n}</button>`).join('')}
      </div>
      <div data-group="deposit" class="stack">
        ${field('b-usdc', 'USDC', 'USDC')}
        ${field('b-weth', 'WETH', 'WETH', '<button type="button" class="link-btn" data-match title="Fill WETH so this deposit matches the profile’s target ratio">Match</button>')}
      </div>
      <div data-group="withdraw" class="stack">${field('b-shares', 'Shares to redeem', 'shares')}</div>
      <dl class="kv" data-kv></dl>
      <button type="submit" class="btn btn-primary btn-block" data-submit></button>
      <p class="tx-msg" data-msg aria-live="polite"></p>
    </form>`;

  let mode: Mode = 'deposit';
  let profile = 1; // Balanced
  let useMax = false;
  let preview: { key: string; shares?: bigint; out?: readonly [bigint, bigint] } = { key: '' };
  let timer = 0;
  const inputs: Record<FieldId, HTMLInputElement> = {
    'b-usdc': $(root, '#b-usdc'),
    'b-weth': $(root, '#b-weth'),
    'b-shares': $(root, '#b-shares'),
  };
  const submit = $<HTMLButtonElement>(root, '[data-submit]');
  const kv = $(root, '[data-kv]');
  const msg = txStatus($(root, '[data-msg]'));
  const idleText = () => (mode === 'deposit' ? 'Accepted if the ratio ends in band or moves toward target.' : 'In-kind: pays your pro-rata USDC and WETH.');

  const read = (id: FieldId) => parseAmount(inputs[id].value, DEC[id]) ?? 0n;
  const vault = (): InventoryVault | undefined => store.get().snapshot?.strategyB.vaults[profile];
  const caps = (): Record<FieldId, bigint> => {
    const b = store.get().balances;
    return { 'b-usdc': b?.usdc ?? 0n, 'b-weth': b?.weth ?? 0n, 'b-shares': b?.b[profile]?.shares ?? 0n };
  };
  const inputKey = () => `${mode}:${profile}:${read('b-usdc')}:${read('b-weth')}:${read('b-shares')}`;

  /** Debounced on-chain preview (previewDeposit / previewRedeem) for the current inputs. */
  function schedulePreview(): void {
    clearTimeout(timer);
    const key = inputKey();
    const v = vault();
    if (!v) return;
    timer = window.setTimeout(async () => {
      try {
        if (mode === 'deposit') {
          const [u, w] = [read('b-usdc'), read('b-weth')];
          if (u + w === 0n) return;
          const shares = await publicClient.readContract({ address: v.address, abi: inventoryVaultAbi, functionName: 'previewDeposit', args: [u, w] });
          if (key === inputKey()) preview = { key, shares };
        } else {
          const sh = read('b-shares');
          if (sh === 0n) return;
          const out = await publicClient.readContract({ address: v.address, abi: inventoryVaultAbi, functionName: 'previewRedeem', args: [sh] });
          if (key === inputKey()) preview = { key, out };
        }
        render();
      } catch {
        /* preview is best-effort; the contract is the arbiter */
      }
    }, 450);
  }

  function render(): void {
    const { snapshot, balances, wallet } = store.get();
    const v = vault();
    const cap = caps();
    const price = snapshot?.oracle.price ?? 0;
    root.querySelectorAll<HTMLElement>('[data-mode]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
    root.querySelectorAll<HTMLElement>('[data-profile]').forEach((t) => t.setAttribute('aria-checked', String(Number(t.dataset.profile) === profile)));
    root.querySelectorAll<HTMLElement>('[data-group]').forEach((g) => (g.hidden = g.dataset.group !== mode));
    if (v) $(root, '[data-target]').textContent = `Target ${v.targetStableBps / 100} / ${100 - v.targetStableBps / 100} ± ${v.bandBps / 100}pp`;
    $(root, '[data-avail="b-usdc"]').textContent = balances ? `Wallet ${tok(cap['b-usdc'], 'USDC', false)}` : '';
    $(root, '[data-avail="b-weth"]').textContent = balances ? `Wallet ${tok(cap['b-weth'], 'WETH', false)}` : '';
    $(root, '[data-avail="b-shares"]').textContent = balances ? `Yours ${num(units(cap['b-shares'], 18), 4)}` : '';

    const fresh = preview.key === inputKey();
    let problem = '';
    let empty = false;
    if (mode === 'deposit') {
      const [u, w] = [read('b-usdc'), read('b-weth')];
      const value = units(u, 6) + units(w, 18) * price;
      const band = v ? bandCheck(v, price, u, w) : null;
      const lo = v ? (v.targetStableBps - v.bandBps) / 100 : 0;
      const hi = v ? (v.targetStableBps + v.bandBps) / 100 : 0;
      const bandNote = !band || value === 0 ? '' : band.inBand ? ' · in band' : band.ok ? ' · toward target' : ` · outside ${lo}–${hi}%`;
      kv.innerHTML = `
        <div><dt>Deposit value</dt><dd class="num">${usd(value)}</dd></div>
        <div><dt>Shares received ≈</dt><dd class="num">${fresh && preview.shares !== undefined ? num(units(preview.shares, 18), 4) : value > 0 ? '<span class="muted">…</span>' : '0.0000'}</dd></div>
        <div><dt>USDC ratio after</dt><dd class="num ${band && !band.ok && value > 0 ? 'neg' : ''}">${band && value > 0 ? pct(band.after / 100, 1) : '—'}${bandNote}</dd></div>`;
      if (balances && (u > cap['b-usdc'] || w > cap['b-weth'])) problem = 'Insufficient balance';
      else if (band && !band.ok && value > 0) problem = 'Outside band';
      else empty = u + w === 0n;
    } else {
      const sh = read('b-shares');
      const out = fresh ? preview.out : undefined;
      kv.innerHTML = `
        <div><dt>You receive ≈</dt><dd class="num">${out ? tok(out[0], 'USDC') : sh > 0n ? '<span class="muted">…</span>' : '0.00 USDC'}</dd></div>
        <div><dt></dt><dd class="num">+ ${out ? tok(out[1], 'WETH') : '0.0000 WETH'}</dd></div>
        <div><dt>Value at oracle</dt><dd class="num">${out ? usd(units(out[0], 6) + units(out[1], 18) * price) : '—'}</dd></div>`;
      if (balances && sh > cap['b-shares']) problem = 'Exceeds your shares';
      else empty = sh === 0n;
    }
    let label = mode === 'deposit' ? `Deposit into ${PROFILE_NAMES[profile]}` : `Withdraw from ${PROFILE_NAMES[profile]}`;
    if (wallet.status !== 'connected') label = 'Connect wallet to deposit';
    else if (problem) label = problem;
    if (msg.busy) label = 'Working…';
    submit.textContent = label;
    submit.disabled = msg.busy || wallet.status !== 'connected' || problem !== '' || empty;
  }

  const clear = () => {
    Object.values(inputs).forEach((el) => (el.value = ''));
    useMax = false;
    preview = { key: '' };
    msg.idle(idleText());
  };
  const changed = () => {
    if (!msg.busy) msg.idle(idleText());
    render();
    schedulePreview();
  };

  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((t) =>
    t.addEventListener('click', () => {
      if (msg.busy) return;
      mode = t.dataset.mode as Mode;
      clear();
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach((t) =>
    t.addEventListener('click', () => {
      if (msg.busy) return;
      profile = Number(t.dataset.profile);
      clear();
      render();
    }),
  );
  Object.values(inputs).forEach((el) =>
    el.addEventListener('input', () => {
      useMax = false;
      changed();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-max]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.max as FieldId;
      inputs[id].value = toInput(caps()[id], DEC[id], id === 'b-usdc' ? 2 : 6);
      useMax = id === 'b-shares';
      changed();
      inputs[id].focus();
    }),
  );
  // WETH amount that keeps this deposit at the profile's target ratio for the typed USDC.
  $(root, '[data-match]').addEventListener('click', () => {
    const v = vault();
    const price = store.get().snapshot?.oracle.price ?? 0;
    const u = units(read('b-usdc'), 6);
    if (!v || !price || u <= 0) return;
    const t = v.targetStableBps / 1e4;
    inputs['b-weth'].value = ((u * (1 - t)) / t / price).toFixed(6);
    changed();
  });

  $(root, 'form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const snap = store.get().snapshot;
    const v = vault();
    if (!snap || !v || msg.busy) return;
    const addr: Address = v.address;
    const name = PROFILE_NAMES[profile];
    msg.busy = true;
    render();
    try {
      const user = account();
      if (mode === 'deposit') {
        const [u, w] = [read('b-usdc'), read('b-weth')];
        if (u > 0n) await ensureAllowance(snap.contracts.usdc, addr, u, 'USDC', msg.step);
        if (w > 0n) await ensureAllowance(snap.contracts.weth, addr, w, 'WETH', msg.step);
        const shares = await publicClient.readContract({ address: addr, abi: inventoryVaultAbi, functionName: 'previewDeposit', args: [u, w] });
        const minShares = (shares * 99n) / 100n;
        const r = await write({ address: addr, abi: inventoryVaultAbi, functionName: 'deposit', args: [u, w, user, minShares] }, 'Deposit', msg.step);
        msg.done(`Deposited into ${name}`, r.transactionHash);
      } else {
        const shares = useMax
          ? await publicClient.readContract({ address: addr, abi: inventoryVaultAbi, functionName: 'balanceOf', args: [user] })
          : read('b-shares');
        const [s, w] = await publicClient.readContract({ address: addr, abi: inventoryVaultAbi, functionName: 'previewRedeem', args: [shares] });
        const r = await write(
          { address: addr, abi: inventoryVaultAbi, functionName: 'redeem', args: [shares, user, user, (s * 99n) / 100n, (w * 99n) / 100n] },
          'Withdraw',
          msg.step,
        );
        msg.done(`Received ${tok(s, 'USDC')} + ${tok(w, 'WETH')}`, r.transactionHash);
      }
      Object.values(inputs).forEach((el) => (el.value = ''));
      useMax = false;
      await refreshBalances();
      setTimeout(() => void refreshBalances(), 4_000);
    } catch (err) {
      msg.fail(err);
    }
    render();
  });

  msg.idle(idleText());
  store.subscribe(render);
}
