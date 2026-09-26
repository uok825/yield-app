export type StrategyId = 'a' | 'b';

const KEY = 'yieldsolver.strategy';
const OPTIONS: { id: StrategyId; name: string; note: string }[] = [
  { id: 'a', name: 'A · Yield + JIT', note: 'USDC · low risk' },
  { id: 'b', name: 'B · Inventory MM', note: 'USDC + ETH · higher risk, inventory exposure' },
];

function load(): StrategyId {
  try {
    return localStorage.getItem(KEY) === 'b' ? 'b' : 'a';
  } catch {
    return 'a';
  }
}

/** Two selectable cards; calls `onChange` with the initial choice and every change after. */
export function mountSwitcher(root: HTMLElement, onChange: (id: StrategyId) => void): void {
  root.innerHTML = OPTIONS.map(
    (o) => `
    <button type="button" class="switch-opt" data-strategy="${o.id}">
      <b>${o.name}</b><small class="muted">${o.note}</small>
    </button>`,
  ).join('');

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
