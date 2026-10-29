export const SURFACE_FADE_MS = 420;
export const SURFACE_FADE_EASE = 'cubic-bezier(0.33, 0, 0.67, 1)';

const FADE_ID = 'bento-surface-fade';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function fadeInElements(elements: Iterable<Element | null | undefined>): number {
  if (prefersReducedMotion()) return 0;
  let count = 0;
  for (const el of elements) {
    if (!(el instanceof HTMLElement) || typeof el.animate !== 'function') continue;
    for (const running of el.getAnimations?.() ?? []) {
      if (running.id === FADE_ID) running.cancel();
    }
    const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: SURFACE_FADE_MS,
      easing: SURFACE_FADE_EASE,
    });
    fade.id = FADE_ID;
    count += 1;
  }
  return count;
}

export const VIEWER_SURFACE_SELECTOR = '[data-viewer-surface]';

export function fadeInViewerSurface(root: ParentNode): number {
  return fadeInElements(root.querySelectorAll(VIEWER_SURFACE_SELECTOR));
}
