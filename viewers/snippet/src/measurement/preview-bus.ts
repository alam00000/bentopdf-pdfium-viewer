import type { PreviewSnapshot } from './types';

let current: PreviewSnapshot | null = null;
const listeners = new Set<(s: PreviewSnapshot | null) => void>();

export function publishPreview(snap: PreviewSnapshot | null): void {
  current = snap;
  listeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (err) {
      console.error('[measurement preview-bus] listener threw:', err);
    }
  });
}

export function getPreview(): PreviewSnapshot | null {
  return current;
}

export function subscribePreview(fn: (s: PreviewSnapshot | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
