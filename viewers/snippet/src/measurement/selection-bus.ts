import type { PreviewSnapshot } from './types';

let current: PreviewSnapshot | null = null;
const listeners = new Set<(s: PreviewSnapshot | null) => void>();

export function publishSelected(snap: PreviewSnapshot | null): void {
  current = snap;
  listeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (err) {
      console.error('[measurement selection-bus] listener threw:', err);
    }
  });
}

export function getSelected(): PreviewSnapshot | null {
  return current;
}

export function subscribeSelected(fn: (s: PreviewSnapshot | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
