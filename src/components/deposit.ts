import { yieldVaultAbi } from '../../bots/src/abis.ts';
import { account, ensureAllowance, publicClient, refreshBalances, write } from '../chain.ts';
import { $, num, parseAmount, pct, toInput, tok, units, usd } from '../format.ts';
import { sectionHead } from '../icons.ts';
import { store } from '../store.ts';
import { txStatus } from './tx.ts';

type Mode = 'deposit' | 'withdraw';

/** Strategy A · ERC-4626 deposit (USDC) and redeem (ysUSDC shares). */
export function mountDeposit(root: HTMLElement): void {
  root.innerHTML = `
    ${sectionHead({ icon: 'vault', title: 'Yield vault', aside: '<span class="head-meta">ERC-4626 · ysUSDC</span>' })}
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-mode="deposit">Deposit</button>
      <button type="button" role="tab" data-mode="withdraw">Withdraw</button>
    </div>
    <form class="deposit-form" novalidate>
      <div class="field-head">
        <label for="a-amount" data-label>Amount</label>
        <span class="muted num" data-avail></span>
      </div>
      <div class="field">
        <input id="a-amount" class="num" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" />
        <span class="muted" data-unit>USDC</span>
        <button type="button" class="link-btn" data-max>Max</button>
      </div>
      <dl class="kv">
        <div><dt>You receive ≈</dt><dd class="num" data-out></dd></div>
        <div><dt>Share price</dt><dd class="num" data-price></dd></div>
        <div><dt>Your position</dt><dd class="num" data-pos></dd></div>
      </dl>
      <button type="submit" class="btn btn-primary btn-block" data-submit></button>
      <p class="tx-msg" data-msg aria-live="polite"></p>
    </form>`;

  let mode: Mode = 'deposit';
  let useMax = false; // withdraw: redeem maxRedeem() at submit time
  const input = $<HTMLInputElement>(root, '#a-amount');
  const submit = $<HTMLButtonElement>(root, '[data-submit]');
  const tabs = root.querySelectorAll<HTMLButtonElement>('[data-mode]');
  const msg = txStatus($(root, '[data-msg]'));
  const idleText = () =>
    mode === 'deposit' ? 'Approve USDC once, then deposit. Shares accrue lending yield and JIT fees.' : 'Redeems from the liquid reserve first, then from markets.';

  const decimals = () => (mode === 'deposit' ? 6 : 12);
  const amount = () => parseAmount(input.value, decimals()) ?? 0n;
  const available = () => {
    const b = store.get().balances;
    return b ? (mode === 'deposit' ? b.usdc : b.a.maxRedeem) : 0n;
  };

  function render(): void {
    const { snapshot, balances, wallet } = store.get();
    const a = amount();
    const sp = snapshot?.strategyA.sharePrice ?? 1_000_000n; // USDC units per 1e12 share units
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
    $(root, '[data-label]').textContent = mode === 'deposit' ? 'Deposit amount' : 'Shares to redeem';
    $(root, '[data-unit]').textContent = mode === 'deposit' ? 'USDC' : 'ysUSDC';
    $(root, '[data-avail]').textContent = balances
      ? mode === 'deposit' ? `Wallet ${tok(balances.usdc, 'USDC', false)}` : `Redeemable ${num(units(balances.a.maxRedeem, 12), 4)}`
      : '';
    $(root, '[data-out]').textContent =
      mode === 'deposit' ? `${num(units((a * 10n ** 12n) / sp, 12), 4)} ysUSDC` : `${tok((a * sp) / 10n ** 12n, 'USDC')}`;
    $(root, '[data-price]').textContent = `${num(units(sp, 6), 6)} USDC`;
    const ts = snapshot?.strategyA.totalSupply ?? 0n;
    $(root, '[data-pos]').textContent = balances
      ? `${usd(units(balances.a.assets, 6))}${ts > 0n && balances.a.shares > 0n ? ` · ${pct((units(balances.a.shares, 12) / units(ts, 12)) * 100, 3)}` : ''}`
      : '—';

    let label = mode === 'deposit' ? 'Deposit' : 'Withdraw';
    let disabled = msg.busy;
    if (wallet.status !== 'connected') {
      label = 'Connect wallet to deposit';
      disabled = true;
    } else if (a <= 0n) disabled = true;
    else if (balances && a > available()) {
      label = mode === 'deposit' ? 'Insufficient USDC' : 'Exceeds redeemable';
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
    input.value = toInput(available(), decimals(), mode === 'deposit' ? 2 : 6);
    useMax = mode === 'withdraw';
    render();
    input.focus();
  });

  $(root, 'form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const snap = store.get().snapshot;
    if (!snap || msg.busy) return;
    const vault = snap.contracts.vault;
    msg.busy = true;
    render();
    try {
      const user = account();
      if (mode === 'deposit') {
        const assets = amount();
        await ensureAllowance(snap.contracts.usdc, vault, assets, 'USDC', msg.step);
        const r = await write({ address: vault, abi: yieldVaultAbi, functionName: 'deposit', args: [assets, user] }, 'Deposit', msg.step);
        msg.done(`Deposited ${tok(assets, 'USDC')}`, r.transactionHash);
      } else {
        const shares = useMax
          ? await publicClient.readContract({ address: vault, abi: yieldVaultAbi, functionName: 'maxRedeem', args: [user] })
          : amount();
        const r = await write({ address: vault, abi: yieldVaultAbi, functionName: 'redeem', args: [shares, user, user] }, 'Withdraw', msg.step);
        msg.done(`Redeemed ${num(units(shares, 12), 4)} ysUSDC`, r.transactionHash);
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
}
