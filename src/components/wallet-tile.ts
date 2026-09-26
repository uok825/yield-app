import { connect, switchNetwork } from '../chain.ts';
import { CHAIN_ID } from '../config.ts';
import { short } from '../format.ts';
import { icon } from '../icons.ts';
import { store } from '../store.ts';

/**
 * Wallet connect as a tile next to the strategy options (same size), with the network status as its subtitle:
 * connect → switch network → jump to the wallet card once connected.
 */
export function mountWalletTile(root: HTMLElement): void {
  root.innerHTML = `
    <span class="switch-caption">Wallet</span>
    <button type="button" class="switch-opt wallet-tile">
      <span class="switch-top" data-top></span>
      <small class="wallet-net"><span class="dot" data-dot></span><span data-net>Base Sepolia</span></small>
    </button>`;

  const btn = root.querySelector<HTMLButtonElement>('.wallet-tile')!;
  const top = root.querySelector<HTMLElement>('[data-top]')!;
  const dot = root.querySelector<HTMLElement>('[data-dot]')!;
  const net = root.querySelector<HTMLElement>('[data-net]')!;
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
    dot.classList.toggle('is-live', live);
    dot.classList.toggle('is-down', !!snapshotError);
    net.textContent = snapshotError
      ? 'Base Sepolia · reconnecting'
      : snapshot
        ? `Base Sepolia · #${snapshot.block.toLocaleString('en-US')}`
        : 'Base Sepolia · connecting';
    btn.title = snapshotError ?? 'Live contract state from Base Sepolia (chain 84532)';
    if (snapshot && snapshot.block !== lastBlock) {
      lastBlock = snapshot.block;
      dot.classList.remove('pulse');
      void dot.offsetWidth; // restart the pulse animation
      dot.classList.add('pulse');
    }

    const wrongChain = wallet.status === 'connected' && wallet.chainId !== CHAIN_ID;
    const connected = wallet.status === 'connected' && !wrongChain;
    btn.classList.toggle('is-warn', wrongChain);
    btn.classList.toggle('is-connected', connected);
    btn.disabled = wallet.status === 'connecting';
    const label =
      wallet.status === 'none' ? 'No wallet'
      : wallet.status === 'connecting' ? 'Connecting…'
      : wallet.status === 'disconnected' ? 'Connect wallet'
      : wrongChain ? 'Switch network'
      : short(wallet.address!);
    top.innerHTML = `${icon(wrongChain ? 'alert' : 'wallet', 16, 'switch-ico')}<b class="${connected ? 'mono' : ''}">${label}</b>`;
  });
}
