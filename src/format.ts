import { formatUnits, parseUnits } from 'viem';

const fmt = (v: number, min: number, max = min) =>
  (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });

export const usd = (v: number, dp = 2) => (v < 0 ? '−$' : '$') + fmt(Math.abs(v), dp);
export const num = (v: number, dp = 2) => fmt(v, dp);
export const pct = (v: number, dp = 2) => fmt(v, dp) + '%';

/** Token units → JS number (display only; never feed back into amounts). */
export const units = (v: bigint, decimals: number) => Number(formatUnits(v, decimals));

export type Token = 'USDC' | 'WETH';
export const TOKEN_DP: Record<Token, number> = { USDC: 2, WETH: 4 };
export const TOKEN_DEC: Record<Token, number> = { USDC: 6, WETH: 18 };

/** "1,234.56 USDC" / "0.1234 WETH" from raw units. */
export const tok = (v: bigint, t: Token, withSymbol = true) =>
  num(units(v, TOKEN_DEC[t]), TOKEN_DP[t]) + (withSymbol ? ` ${t}` : '');

/** Parses a user-typed decimal into token units; null when empty or invalid. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const s = text.replace(/[,\s_]/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [i, f = ''] = s.split('.');
  try {
    return parseUnits(`${i || '0'}.${f.slice(0, decimals) || '0'}`, decimals);
  } catch {
    return null;
  }
}

/** Units → a plain string suitable for an input value (trimmed to `dp`, rounded down). */
export function toInput(v: bigint, decimals: number, dp: number): string {
  const s = formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, dp).replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i;
}

export const bps = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Tiny helper: first element matching `sel` inside `root` (throws if missing). */
export function $<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}

/** Signed percentage with a true minus sign: "+0.08%", "−0.05%", "0.00%". */
export function signedPct(v: number, dp = 2): string {
  const r = Number(v.toFixed(dp));
  return (r > 0 ? '+' : r < 0 ? '−' : '') + pct(Math.abs(v), dp);
}

/** APY with precision scaled to magnitude, so "528%" doesn't read as more exact than it is. */
export const apyPct = (v: number) => pct(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);

/** Duration: "45m", "1h 23m", "3d 4h". */
export function span(sec: number): string {
  const m = Math.max(0, Math.floor(sec / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
