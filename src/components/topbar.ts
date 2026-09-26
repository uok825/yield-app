import { store } from '../store.ts';
import { $ } from '../format.ts';

const MOCK_ADDRESS = '0x71C4…4e89';

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
      <span class="pill"><span class="dot"></span>Base</span>
      <span class="demo-label" title="No chain connection. All balances, rates and orders are simulated.">Demo · simulated data</span>
      <button class="btn btn-secondary wallet-btn" type="button"></button>
    </div>`;

  const btn = $<HTMLButtonElement>(root, '.wallet-btn');
  btn.addEventListener('click', () => store.update((s) => ({ walletConnected: !s.walletConnected })));

  store.subscribe((s) => {
    btn.textContent = s.walletConnected ? MOCK_ADDRESS : 'Connect wallet';
    btn.classList.toggle('is-connected', s.walletConnected);
    btn.title = s.walletConnected ? 'Disconnect (mock wallet)' : 'Connect a mock wallet';
  });
}
