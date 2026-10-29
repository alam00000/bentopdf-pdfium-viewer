import type { SnapKind } from './snap-settings';

export interface LoupeSnapshot {
  documentId: string;
  pageIndex: number;
  pdfX: number;
  pdfY: number;
  pageCssX: number;
  pageCssY: number;
  pageCssScale: number;
  snap: {
    kind: SnapKind;
    pdfX: number;
    pdfY: number;
    pageCssX: number;
    pageCssY: number;
    label: string;
  } | null;
}

let current: LoupeSnapshot | null = null;
const listeners = new Set<(s: LoupeSnapshot | null) => void>();

export function publishLoupe(snap: LoupeSnapshot | null): void {
  current = snap;
  listeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (err) {
      console.error('[measurement loupe-bus] listener threw:', err);
    }
  });
}

export function getLoupe(): LoupeSnapshot | null {
  return current;
}

export function subscribeLoupe(fn: (s: LoupeSnapshot | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
