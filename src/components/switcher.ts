export type StrategyId = 'sc' | 'a' | 'b';

const KEY = 'yieldsolver.strategy';
const IDS: StrategyId[] = ['sc', 'a', 'b'];

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

/** Self-custody (primary, full row on small screens) + the two managed vaults; calls `onChange` with the initial choice and every change. */
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
    </div>`;

  const select = (id: StrategyId) => {
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
}
