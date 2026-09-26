/**
 * Scroll cue: the section under the reading line (40% down the viewport) gets `.is-current`, which lifts its
 * background by a barely visible step, so readers notice when they move into another section.
 */
export function mountSectionFocus(root: HTMLElement): void {
  let current: Element | null = null;
  let queued = false;

  const update = (): void => {
    queued = false;
    const line = window.innerHeight * 0.4;
    let best: Element | null = null;
    let bestDist = Infinity;
    for (const s of root.querySelectorAll('section')) {
      if (!s.getClientRects().length) continue; // hidden (other strategy / not mounted)
      const r = s.getBoundingClientRect();
      const dist = r.top <= line && r.bottom >= line ? 0 : Math.min(Math.abs(r.top - line), Math.abs(r.bottom - line));
      // Prefer the section containing the line; between two (two columns), the one whose middle is closer.
      const score = dist === 0 ? Math.abs((r.top + r.bottom) / 2 - line) / 1e4 : dist;
      if (score < bestDist) (best = s), (bestDist = score);
    }
    if (best === current) return;
    current?.classList.remove('is-current');
    best?.classList.add('is-current');
    current = best;
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  // Strategy switches and async mounts change which sections are visible.
  new MutationObserver(schedule).observe(root, { attributes: true, attributeFilter: ['data-strategy', 'hidden'], subtree: true, childList: true });
  schedule();
}
