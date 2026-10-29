import { useEffect, useRef } from 'preact/hooks';

const FLOATING_SELECTOR =
  '[data-floating], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

const handlers = new Set<(e: KeyboardEvent) => void>();

export function isInFloatingLayer(e: Event): boolean {
  return e
    .composedPath()
    .some((node) => node instanceof Element && node.matches(FLOATING_SELECTOR));
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
  if (isInFloatingLayer(e)) return;
  for (const h of Array.from(handlers)) h(e);
}

export function useEscapeKey(handler: (e: KeyboardEvent) => void, enabled = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    const fn = (e: KeyboardEvent) => latest.current(e);
    handlers.add(fn);
    if (handlers.size === 1) window.addEventListener('keydown', onKeyDown);
    return () => {
      handlers.delete(fn);
      if (handlers.size === 0) window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}
