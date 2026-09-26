import { $ } from '../format.ts';
import { store } from '../store.ts';

export type StrategyId = 'sc' | 'a' | 'b' | 'carry';

const KEY = 'yieldsolver.strategy';
const IDS: StrategyId[] = ['sc', 'a', 'b', 'carry'];

/** Remembered choice; first-time visitors start on self-custody. */
function load(): StrategyId {
  try {
    const v = localStorage.getItem(KEY) as StrategyId | null;
    return v && IDS.includes(v) ? v : 'sc';
  } catch {
    return 'sc';
  }
}

const shield = `<svg class="switch-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 2.75 3.5v4c0 3.1 2.2 5.9 5.25 7 3.05-1.1 5.25-3.9 5.25-7v-4L8 1.5Z"/><path d="m5.6 8.1 1.7 1.7 3.1-3.3"/></svg>`;

/**
 * Self-custody (primary, full row on small screens) + the managed vaults; calls `onChange` with the initial choice and every change.
 * The carry tab only appears when the snapshot reports a carry vault.
 */
export function mountSwitcher(root: HTMLElement, onChange: (id: StrategyId) => void): void {
  root.innerHTML = `
    <button type="button" class="switch-opt switch-primary" data-strategy="sc">
      <span class="switch-top">${shield}<b>Self-custody · Aqua-native</b><span class="pill pill-pos">Recommended</span></span>
      <small class="muted">Tokens stay in your wallet · earn lending APY + fill fees</small>
    </button>
    <div class="switch-group" role="group" aria-label="Managed vaults">
      <span class="switch-caption muted">Managed vaults · the vault holds your deposit</span>
      <button type="button" class="switch-opt" data-strategy="a">
        <b>A · Yield + JIT</b><small class="muted">USDC · low risk</small>
      </button>
      <button type="button" class="switch-opt" data-strategy="b">
        <b>B · Inventory MM</b><small class="muted">USDC + ETH · inventory exposure</small>
      </button>
      <button type="button" class="switch-opt" data-strategy="carry" hidden>
        <b>C · ETH Carry</b><small class="muted">ETH · borrows only when it pays</small>
      </button>
    </div>`;

  let current: StrategyId = 'sc';
  const group = $(root, '.switch-group');
  const carryBtn = $(root, '[data-strategy="carry"]');

  const select = (id: StrategyId) => {
    current = id;
    root.querySelectorAll<HTMLElement>('[data-strategy]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.strategy === id)));
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* storage unavailable: selection just isn't remembered */
    }
    onChange(id);
  };

  root.querySelectorAll<HTMLElement>('[data-strategy]').forEach((b) => b.addEventListener('click', () => select(b.dataset.strategy as StrategyId)));
  select(load());

  // Show the carry tab once a snapshot has one; fall back to self-custody if it was remembered but isn't deployed.
  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    const has = !!snapshot.carry;
    carryBtn.hidden = !has;
    group.classList.toggle('has-carry', has);
    if (!has && current === 'carry') select('sc');
  });
}
