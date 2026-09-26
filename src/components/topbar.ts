import { connect, switchNetwork } from '../chain.ts';
import { CHAIN_ID } from '../config.ts';
import { $, short } from '../format.ts';
import { icon } from '../icons.ts';
import { store } from '../store.ts';

export function mountTopbar(root: HTMLElement): void {
  root.innerHTML = `
    <div class="topbar-inner">
      <a class="brand" href="/" aria-label="YieldSolver home">
        <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="1" y="1" width="22" height="22" rx="6" />
          <path d="M6 14.5c2-3 4-3 6 0s4 3 6 0M6 9.5c2-3 4-3 6 0s4 3 6 0" />
        </svg>
        <span>YieldSolver</span>
      </a>
      <span class="topbar-sep" aria-hidden="true"></span>
      <span class="pill live-pill" data-live><span class="dot"></span><span data-live-text>Base Sepolia</span></span>
      <span class="block-label muted" data-block hidden>${icon('block')}<span class="num" data-block-n></span></span>
      <button class="btn btn-secondary wallet-btn" type="button"></button>
    </div>`;

  const btn = $<HTMLButtonElement>(root, '.wallet-btn');
  const pill = $(root, '[data-live]');
  const blockEl = $(root, '[data-block]');
  let lastBlock = 0n;

  btn.addEventListener('click', () => {
    const w = store.get().wallet;
    if (w.status === 'disconnected') void connect();
    else if (w.status === 'connected' && w.chainId !== CHAIN_ID) void switchNetwork().catch(() => undefined);
    else
      [...document.querySelectorAll<HTMLElement>('.area-wallet')]
        .find((el) => el.offsetParent !== null)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  store.subscribe(({ snapshot, snapshotError, wallet }) => {
    const live = !!snapshot && !snapshotError;
    pill.classList.toggle('is-live', live);
    pill.classList.toggle('is-down', !!snapshotError);
    $(pill, '[data-live-text]').textContent = snapshotError ? 'Reconnecting' : live ? 'Base Sepolia' : 'Connecting';
    pill.title = snapshotError ?? 'Reading live contract state from Base Sepolia (chain 84532).';
    if (snapshot && snapshot.block !== lastBlock) {
      lastBlock = snapshot.block;
      blockEl.hidden = false;
      $(blockEl, '[data-block-n]').textContent = snapshot.block.toLocaleString('en-US');
      blockEl.title = 'Latest block seen by the relayer';
      pill.classList.remove('pulse');
      void pill.offsetWidth; // restart the pulse animation
      pill.classList.add('pulse');
    }

    const wrongChain = wallet.status === 'connected' && wallet.chainId !== CHAIN_ID;
    const connected = wallet.status === 'connected' && !wrongChain;
    btn.className = `btn wallet-btn ${wrongChain ? 'btn-warn' : 'btn-secondary'}${connected ? ' is-connected' : ''}`;
    btn.disabled = wallet.status === 'connecting';
    const label =
      wallet.status === 'none' ? 'No wallet'
      : wallet.status === 'connecting' ? 'Connecting…'
      : wallet.status === 'disconnected' ? 'Connect wallet'
      : wrongChain ? 'Switch network'
      : short(wallet.address!);
    btn.innerHTML = `${icon(wrongChain ? 'alert' : 'wallet')}<span class="${connected ? 'mono' : ''}">${label}</span>`;
    btn.title = wallet.status === 'none' ? 'No browser wallet detected' : wrongChain ? 'Switch to Base Sepolia' : '';
  });
}
