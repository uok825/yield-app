import { parseEther, parseUnits } from 'viem';
import { mockERC20Abi } from '../../bots/src/abis.ts';
import { account, addrUrl, connect, disconnect, refreshBalances, switchNetwork, write } from '../chain.ts';
import { CHAIN_ID, FAUCET, GAS_FAUCET_URL, PROFILE_NAMES } from '../config.ts';
import { $, num, short, tok, units, usd } from '../format.ts';
import { store } from '../store.ts';
import { txStatus } from './tx.ts';
import { signedHtml } from './yield.ts';

const LOW_GAS = parseEther('0.0005');

/** Connection state, balances, positions and the test-token faucet. */
export function mountWallet(root: HTMLElement): void {
  root.innerHTML = `
    <header class="card-head card-head-row">
      <h2>Wallet</h2>
      <a class="head-link num" data-addr target="_blank" rel="noopener"></a>
    </header>
    <div data-pane="none" hidden>
      <p class="note">No browser wallet detected. Install an EIP-1193 wallet such as MetaMask, Rabby or Coinbase Wallet to trade and deposit. Live data works without one.</p>
    </div>
    <div data-pane="disconnected" hidden>
      <p class="note">Connect a wallet on Base Sepolia to sign Fusion intents, deposit and get test tokens.</p>
      <button type="button" class="btn btn-primary btn-block" data-connect>Connect wallet</button>
    </div>
    <div data-pane="wrong" hidden>
      <p class="note">Your wallet is on another network. YieldSolver runs on Base Sepolia (84532).</p>
      <button type="button" class="btn btn-primary btn-block" data-switch>Switch to Base Sepolia</button>
      <p class="tx-msg is-error" data-switch-msg hidden></p>
    </div>
    <div data-pane="connected" hidden>
      <dl class="kv kv-tight">
        <div><dt>ETH <span class="muted">gas</span></dt><dd class="num" data-bal="eth">—</dd></div>
        <div><dt>USDC</dt><dd class="num" data-bal="usdc">—</dd></div>
        <div><dt>WETH</dt><dd class="num" data-bal="weth">—</dd></div>
      </dl>
      <p class="note warn-note" data-gas hidden>Transactions need Base Sepolia ETH for gas. <a href="${GAS_FAUCET_URL}" target="_blank" rel="noopener">Get some from a faucet ↗</a></p>
      <div class="faucet" data-faucet hidden>
        <button type="button" class="btn btn-secondary btn-block" data-mint>Get test tokens</button>
        <p class="tx-msg" data-mint-msg></p>
      </div>
      <div class="position">
        <div class="pos-head"><h3>Positions</h3><span class="num" data-pos-total></span></div>
        <ul class="pos-list" data-pos-list></ul>
      </div>
      <button type="button" class="link-btn disconnect" data-disconnect>Disconnect</button>
    </div>`;

  const panes = root.querySelectorAll<HTMLElement>('[data-pane]');
  const addr = $<HTMLAnchorElement>(root, '[data-addr]');
  const mintBtn = $<HTMLButtonElement>(root, '[data-mint]');
  const mintMsg = txStatus($(root, '[data-mint-msg]'), `Mints ${num(Number(FAUCET.usdc), 0)} USDC + ${FAUCET.weth} WETH (mock tokens). Gas is paid in Base Sepolia ETH.`);
  const switchMsg = $(root, '[data-switch-msg]');

  $(root, '[data-connect]').addEventListener('click', () => void connect());
  $(root, '[data-disconnect]').addEventListener('click', disconnect);
  $(root, '[data-switch]').addEventListener('click', async () => {
    switchMsg.hidden = true;
    try {
      await switchNetwork();
    } catch (e) {
      switchMsg.hidden = false;
      switchMsg.textContent = (e as { code?: number }).code === 4001 ? 'Rejected in your wallet.' : 'Could not switch automatically. Select Base Sepolia in your wallet.';
    }
  });

  mintBtn.addEventListener('click', async () => {
    const snap = store.get().snapshot;
    if (!snap || mintMsg.busy) return;
    mintBtn.disabled = true;
    try {
      const to = account();
      const c = snap.contracts;
      await write({ address: c.usdc, abi: mockERC20Abi, functionName: 'mint', args: [to, parseUnits(String(FAUCET.usdc), 6)] }, 'Mint USDC', mintMsg.step);
      const r = await write({ address: c.weth, abi: mockERC20Abi, functionName: 'mint', args: [to, parseEther(String(FAUCET.weth))] }, 'Mint WETH', mintMsg.step);
      mintMsg.done(`Minted ${num(Number(FAUCET.usdc), 0)} USDC + ${FAUCET.weth} WETH`, r.transactionHash);
      void refreshBalances();
    } catch (e) {
      mintMsg.fail(e);
    } finally {
      mintBtn.disabled = false;
    }
  });

  store.subscribe(({ wallet, balances, snapshot }) => {
    const pane = wallet.status === 'none' ? 'none' : wallet.status !== 'connected' ? 'disconnected' : wallet.chainId !== CHAIN_ID ? 'wrong' : 'connected';
    panes.forEach((p) => (p.hidden = p.dataset.pane !== pane));
    addr.hidden = !wallet.address;
    if (wallet.address) {
      addr.href = addrUrl(wallet.address);
      addr.textContent = `${short(wallet.address)} ↗`;
    }
    $<HTMLButtonElement>(root, '[data-connect]').disabled = wallet.status === 'connecting';
    $(root, '[data-faucet]').hidden = !snapshot?.mock;
    if (pane !== 'connected' || !balances || !snapshot) return;

    $(root, '[data-bal="eth"]').textContent = num(units(balances.eth, 18), 5);
    $(root, '[data-bal="usdc"]').textContent = tok(balances.usdc, 'USDC', false);
    $(root, '[data-bal="weth"]').textContent = tok(balances.weth, 'WETH', false);
    $(root, '[data-gas]').hidden = balances.eth >= LOW_GAS;

    const price = snapshot.oracle.price;
    const sc = snapshot.selfCustody;
    // The carry vault is also a listed self-custody market; its shares are shown on their own row.
    const carryVault = snapshot.carry?.vault.toLowerCase();
    const scHold = (balances.sc?.holdings ?? []).filter((h) => h.address.toLowerCase() !== carryVault);
    const scValue = scHold.reduce((sum, h) => {
      const m = sc?.markets.find((x) => x.address.toLowerCase() === h.address.toLowerCase());
      return sum + (m?.asset === 'WETH' ? units(h.assets, 18) * price : units(h.assets, 6));
    }, 0);
    const scCount = scHold.filter((h) => h.shares > 0n).length;
    const rows = [
      ...(sc
        ? [
            {
              name: 'Self-custody',
              value: scValue,
              detail: `${scCount} market${scCount === 1 ? '' : 's'} · shares in your wallet`,
              extra: '',
              has: scCount > 0,
            },
          ]
        : []),
      { name: 'A · Yield + JIT', value: units(balances.a.assets, 6), detail: `${num(units(balances.a.shares, 12), 2)} ysUSDC`, extra: '', has: balances.a.shares > 0n },
      ...balances.b.map((p, i) => {
        const hodl = snapshot.strategyB.vaults[i]?.performance?.vsHodlPct ?? null;
        return {
          name: `B · ${PROFILE_NAMES[i]}`,
          value: units(p.stable, 6) + units(p.volatile, 18) * price,
          detail: `${tok(p.stable, 'USDC')} + ${tok(p.volatile, 'WETH')}`,
          extra: hodl === null ? '' : `<small class="muted" title="This profile’s share value vs holding the same USDC/WETH basket since launch">${signedHtml(hodl)} vs HODL</small>`,
          has: p.shares > 0n,
        };
      }),
      ...(balances.carry
        ? [
            {
              name: 'C · ETH Carry',
              value: units(balances.carry.assets, 18) * price,
              detail: tok(balances.carry.assets, 'WETH'),
              extra: '',
              has: balances.carry.shares > 0n,
            },
          ]
        : []),
    ];
    $(root, '[data-pos-total]').textContent = usd(rows.reduce((s, r) => s + r.value, 0));
    $(root, '[data-pos-list]').innerHTML = rows
      .map(
        (r) => `<li class="${r.has ? '' : 'is-empty'}"><span>${r.name}</span><span class="r">${r.has ? `<span class="num">${usd(r.value)}</span><small class="muted num">${r.detail}</small>${r.extra}` : '<span class="muted">—</span>'}</span></li>`,
      )
      .join('');
  });
}
