/** Shared yield presentation: honest APY labels and inline SVG sparklines. */
import { apyPct, esc, signedPct, span } from '../format.ts';

/** Below a full day of data, annualised figures are extrapolations and are marked as such. */
export const FULL_WINDOW_SEC = 86_400;

export const MEASURING = '<span class="muted measuring">measuring…</span>';

export const isExtrapolated = (spanSec: number | null) => spanSec === null || spanSec < FULL_WINDOW_SEC;

/**
 * Realised return, shown instead of an annualised APY until a full day of data exists: "+0.43%" plus the elapsed time.
 * Annualising a few hours of synthetic testnet flow produces meaningless triple-digit APYs.
 */
export function realisedHtml(returnPct: number | null): string {
  return returnPct === null ? MEASURING : signedHtml(returnPct);
}

/** "annualised from 1h 23m of testnet flow" — the basis every APY is shown with. */
export const apyBasis = (spanSec: number | null) =>
  spanSec === null ? 'annualised once enough flow is sampled' : `annualised from ${span(spanSec)} of testnet flow`;

export const extrapolatedTitle = (spanSec: number | null) =>
  `Extrapolated: income from ${spanSec === null ? 'a short window' : span(spanSec)} of synthetic testnet order flow, annualised. Not a forecast; it swings widely until a full 24h window is sampled.`;

/** An APY number (or "measuring…"), with a dotted underline + tooltip when it is extrapolated. */
export function apyHtml(v: number | null, spanSec: number | null, extra = ''): string {
  if (v === null) return MEASURING;
  const text = apyPct(v);
  if (!isExtrapolated(spanSec)) return `<span class="num">${text}</span>`;
  return `<span class="num extrap" title="${esc(extrapolatedTitle(spanSec) + extra)}">${text}</span>`;
}

/** Signed percentage coloured by sign, or "measuring…". */
export const signedHtml = (v: number | null, dp = 2) =>
  v === null ? MEASURING : `<span class="num ${v > 0.0049 ? 'pos' : v < -0.0049 ? 'neg' : ''}">${signedPct(v, dp)}</span>`;

interface SparkPoint {
  t: number;
  sharePrice: number;
  hodl?: number;
}

/**
 * Inline sparkline of share price (accent, solid) and optionally the HODL basket (muted, dashed).
 * Fluid width: the viewBox is stretched and strokes stay 1.5px via non-scaling-stroke. x is time, not index.
 */
export function sparkline(history: SparkPoint[], opts: { hodl?: boolean; label: string }): string {
  const pts = history.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.sharePrice));
  if (pts.length < 2) return `<span class="spark spark-empty muted measuring" role="img" aria-label="${esc(opts.label)}: not enough samples yet">measuring…</span>`;
  const W = 100;
  const H = 32;
  const pad = 3;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const vals = pts.flatMap((p) => (opts.hodl && p.hodl !== undefined ? [p.sharePrice, p.hodl] : [p.sharePrice]));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-9) {
    lo -= 1e-6;
    hi += 1e-6;
  }
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * W : 0).toFixed(2);
  const y = (v: number) => (pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad)).toFixed(2);
  const line = (get: (p: SparkPoint) => number | undefined) =>
    pts
      .filter((p) => get(p) !== undefined)
      .map((p) => `${x(p.t)},${y(get(p)!)}`)
      .join(' ');
  const hodlLine = opts.hodl && pts.some((p) => p.hodl !== undefined) ? `<polyline class="spark-hodl" points="${line((p) => p.hodl)}"/>` : '';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label)}"><title>${esc(opts.label)}</title>${hodlLine}<polyline class="spark-share" points="${line((p) => p.sharePrice)}"/></svg>`;
}

/** Legend for the two-line sparkline (identity never by colour alone: solid vs dashed). */
export const sparkLegend = `<span class="spark-legend"><i class="lg-share"></i>Share<i class="lg-hodl"></i>HODL</span>`;
