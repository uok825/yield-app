import { carryVaultAbi } from '../../bots/src/abis.ts';
import { account, ensureAllowance, publicClient, refreshBalances, write } from '../chain.ts';
import { $, parseAmount, toInput, tok, units, usd } from '../format.ts';
import { store } from '../store.ts';
import { txStatus } from './tx.ts';

type Mode = 'deposit' | 'withdraw';

/** Carry · ERC-4626 over WETH: approve + deposit, and withdraw up to the contract's maxWithdraw (Max redeems maxRedeem). */
export function mountCarryDeposit(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head card-head-row"><h2>Carry vault</h2><span class="muted small">ERC-4626 · ycWETH</span></header>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-mode="deposit">Deposit</button>
      <button type="button" role="tab" data-mode="withdraw">Withdraw</button>
    </div>
    <form class="deposit-form" novalidate>
      <div class="field-head">
        <label for="c-amount" data-label>Amount</label>
        <span class="muted num" data-avail></span>
      </div>
      <div class="field">
        <input id="c-amount" class="num" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" />
        <span class="muted">WETH</span>
        <button type="button" class="link-btn" data-max>Max</button>
      </div>
      <dl class="kv">
        <div><dt>Value ≈</dt><dd class="num" data-out></dd></div>
        <div><dt>Your position</dt><dd class="num" data-pos></dd></div>
        <div data-limit-row><dt>Withdrawable now</dt><dd class="num" data-limit></dd></div>
      </dl>
      <button type="submit" class="btn btn-primary btn-block" data-submit></button>
      <p class="tx-msg" data-msg aria-live="polite"></p>
    </form>`;

  let mode: Mode = 'deposit';
  let useMax = false; // withdraw: redeem maxRedeem() at submit time
  const input = $<HTMLInputElement>(root, '#c-amount');
  const submit = $<HTMLButtonElement>(root, '[data-submit]');
  const tabs = root.querySelectorAll<HTMLButtonElement>('[data-mode]');
  const msg = txStatus($(root, '[data-msg]'));
  const idleText = () =>
    mode === 'deposit'
      ? `Approve WETH once, then deposit. It stays as Aave collateral.${store.get().snapshot?.mock ? ' Test WETH: “Get test tokens” in the wallet card.' : ''}`
      : 'Limited to the ETH collateral the vault can release; carry profit counts once the keeper harvests it into ETH.';

  const amount = () => parseAmount(input.value, 18) ?? 0n;
  const available = () => {
    const b = store.get().balances;
    return b ? (mode === 'deposit' ? b.weth : (b.carry?.maxWithdraw ?? 0n)) : 0n;
  };

  function render(): void {
    const { snapshot, balances, wallet } = store.get();
    const c = snapshot?.carry;
    const price = snapshot?.oracle.price ?? 0;
    const pos = balances?.carry ?? null;
    const a = amount();
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
    $(root, '[data-label]').textContent = mode === 'deposit' ? 'Deposit amount' : 'Withdraw amount';
    $(root, '[data-avail]').textContent = balances
      ? mode === 'deposit' ? `Wallet ${tok(balances.weth, 'WETH', false)}` : `Withdrawable ${tok(pos?.maxWithdraw ?? 0n, 'WETH', false)}`
      : '';
    $(root, '[data-out]').textContent = usd(units(a, 18) * price);
    $(root, '[data-pos]').textContent = pos && pos.shares > 0n ? `${tok(pos.assets, 'WETH')} · ${usd(units(pos.assets, 18) * price)}` : '—';
    const limitRow = $(root, '[data-limit-row]');
    limitRow.hidden = mode !== 'withdraw';
    $(root, '[data-limit]').textContent = pos ? tok(pos.maxWithdraw, 'WETH') : '—';

    let label = mode === 'deposit' ? 'Deposit' : 'Withdraw';
    let disabled = msg.busy || !c;
    if (wallet.status !== 'connected') {
      label = 'Connect wallet to deposit';
      disabled = true;
    } else if (a <= 0n) disabled = true;
    else if (balances && a > available()) {
      label = mode === 'deposit' ? 'Insufficient WETH' : 'Exceeds withdrawable';
      disabled = true;
    }
    if (msg.busy) label = 'Working…';
    submit.textContent = label;
    submit.disabled = disabled;
  }

  const reset = () => {
    input.value = '';
    useMax = false;
    msg.idle(idleText());
  };

  tabs.forEach((t) =>
    t.addEventListener('click', () => {
      if (msg.busy) return;
      mode = t.dataset.mode as Mode;
      reset();
      render();
    }),
  );
  input.addEventListener('input', () => {
    useMax = false;
    if (!msg.busy) msg.idle(idleText());
    render();
  });
  $(root, '[data-max]').addEventListener('click', () => {
    input.value = toInput(available(), 18, 6);
    useMax = mode === 'withdraw';
    render();
    input.focus();
  });

  $(root, 'form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const snap = store.get().snapshot;
    if (!snap?.carry || msg.busy) return;
    const vault = snap.carry.vault;
    msg.busy = true;
    render();
    try {
      const user = account();
      if (mode === 'deposit') {
        const assets = amount();
        await ensureAllowance(snap.contracts.weth, vault, assets, 'WETH', msg.step);
        const r = await write({ address: vault, abi: carryVaultAbi, functionName: 'deposit', args: [assets, user] }, 'Deposit', msg.step);
        msg.done(`Deposited ${tok(assets, 'WETH')}`, r.transactionHash);
      } else if (useMax) {
        const shares = await publicClient.readContract({ address: vault, abi: carryVaultAbi, functionName: 'maxRedeem', args: [user] });
        const r = await write({ address: vault, abi: carryVaultAbi, functionName: 'redeem', args: [shares, user, user] }, 'Withdraw', msg.step);
        msg.done(`Withdrew ≈ ${tok(store.get().balances?.carry?.maxWithdraw ?? 0n, 'WETH')} (all withdrawable)`, r.transactionHash);
      } else {
        const assets = amount();
        const r = await write({ address: vault, abi: carryVaultAbi, functionName: 'withdraw', args: [assets, user, user] }, 'Withdraw', msg.step);
        msg.done(`Withdrew ${tok(assets, 'WETH')}`, r.transactionHash);
      }
      input.value = '';
      useMax = false;
      await refreshBalances();
      setTimeout(() => void refreshBalances(), 4_000); // the public RPC can lag a block
    } catch (err) {
      msg.fail(err);
    }
    render();
  });

  msg.idle(idleText());
  store.subscribe(render);
  // The faucet hint depends on the snapshot, which arrives after mount.
  let mock: boolean | undefined;
  store.subscribe(({ snapshot }) => {
    if (!snapshot || snapshot.mock === mock) return;
    mock = snapshot.mock;
    if (!msg.busy && !input.value) msg.idle(idleText());
  });
}
