const fmt = (v: number, min: number, max = min) =>
  (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });

export const usd = (v: number, dp = 2) => '$' + fmt(v, dp);
export const num = (v: number, dp = 2) => fmt(v, dp);
export const pct = (v: number, dp = 2) => fmt(v, dp) + '%';

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/** Tiny helper: first element matching `sel` inside `root` (throws if missing). */
export function $<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
