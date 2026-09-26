import { type TxStep, explain, txUrl } from '../chain.ts';
import { esc } from '../format.ts';

const link = (hash: string, text = 'View tx') => `<a href="${txUrl(hash)}" target="_blank" rel="noopener">${text} ↗</a>`;

/** Drives a one-line transaction status (`<p class="tx-msg">`): progress, success with a basescan link, or a readable error. */
export function txStatus(el: HTMLElement, idle = '') {
  const set = (cls: string, html: string) => {
    el.className = `tx-msg ${cls}`;
    el.innerHTML = html;
  };
  const api = {
    busy: false,
    idle(text = idle): void {
      api.busy = false;
      set('muted', esc(text));
    },
    step(s: TxStep): void {
      api.busy = true;
      const spin = '<i class="spinner" aria-hidden="true"></i>';
      set('is-live', `${spin}<span>${esc(s.label)}${s.kind === 'pending' ? ` · ${link(s.hash)}` : ''}</span>`);
    },
    done(text: string, hash?: string): void {
      api.busy = false;
      set('is-done', `<span>✓ ${esc(text)}${hash ? ` · ${link(hash)}` : ''}</span>`);
    },
    fail(e: unknown): void {
      api.busy = false;
      set('is-error', `<span>${esc(explain(e))}</span>`);
    },
  };
  api.idle();
  return api;
}

export type TxStatus = ReturnType<typeof txStatus>;
export { link as txLink };
