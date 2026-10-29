let overlay: HTMLDivElement | null = null;
let current: (() => void) | null = null;

function lockGestureCursor(cursor: string): void {
  if (typeof document === 'undefined') return;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.setAttribute('data-epdf-cursor-lock', '');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:transparent;pointer-events:auto;touch-action:none';
  }
  overlay.style.cursor = cursor || 'default';
  if (!overlay.isConnected) document.body.appendChild(overlay);
}

function unlockGestureCursor(): void {
  overlay?.remove();
}

export function pinGestureCursor(cursor: string, pointerId?: number): () => void {
  current?.();
  lockGestureCursor(cursor);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (current === release) current = null;
    window.removeEventListener('pointerup', onEnd, true);
    window.removeEventListener('pointercancel', onEnd, true);
    window.removeEventListener('blur', onBlur, true);
    unlockGestureCursor();
  };
  const onEnd = (e: PointerEvent): void => {
    if (pointerId === undefined || e.pointerId === pointerId) release();
  };
  const onBlur = (e: FocusEvent): void => {
    if (!(e.target instanceof Node)) release();
  };
  window.addEventListener('pointerup', onEnd, true);
  window.addEventListener('pointercancel', onEnd, true);
  window.addEventListener('blur', onBlur, true);
  current = release;
  return release;
}

export function pinCursorOf(el: Element | null | undefined, pointerId?: number): () => void {
  const own = el instanceof HTMLElement ? el.style.cursor : '';
  const shown = own || (el ? getComputedStyle(el).cursor : '') || 'default';
  return pinGestureCursor(shown, pointerId);
}
