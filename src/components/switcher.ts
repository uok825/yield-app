import { $ } from '../format.ts';
import { icon } from '../icons.ts';
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

/**
 * Self-custody (primary, full row on small screens) + the managed vaults; calls `onChange` with the initial choice and every change.
 * The carry tab only appears when the snapshot reports a carry vault.
 */
export function mountSwitcher(root: HTMLElement, onChange: (id: StrategyId) => void): void {
  const opt = (id: StrategyId, ico: Parameters<typeof icon>[0], title: string, sub: string, extra = '') => `
      <button type="button" class="switch-opt${id === 'sc' ? ' switch-primary' : ''}" data-strategy="${id}"${id === 'carry' ? ' hidden' : ''}>
        <span class="switch-top">${icon(ico, 16, 'switch-ico')}<b>${title}</b>${extra}</span>
        <small>${sub}</small>
      </button>`;
  root.innerHTML = `
    <div class="switch-lead">
      <span class="switch-caption">Recommended</span>
      ${opt('sc', 'shield', 'Self-custody · Aqua-native', 'Tokens stay in your wallet · APY + fill fees')}
    </div>
    <div class="switch-group" role="group" aria-label="Managed vaults">
      <span class="switch-caption">Managed vaults · the vault holds your deposit</span>
      ${opt('a', 'zap', 'A · Yield + JIT', 'USDC · low risk')}
      ${opt('b', 'scale', 'B · Inventory MM', 'USDC + ETH · inventory exposure')}
      ${opt('carry', 'earn', 'C · ETH Carry', 'ETH · borrows only when it pays')}
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
