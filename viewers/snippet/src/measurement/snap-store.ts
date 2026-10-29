import type { SnapKind } from './snap-settings';

export interface LatestSnap {
  documentId: string;
  pageIndex: number;
  kind: SnapKind;
  pdfX: number;
  pdfY: number;
  topDownX: number;
  topDownY: number;
}

let current: LatestSnap | null = null;

let clicks: (LatestSnap | null)[] = [];

export function setLatestSnap(s: LatestSnap): void {
  current = s;
}

export function getLatestSnap(): LatestSnap | null {
  return current;
}

export function clearLatestSnap(): void {
  current = null;
}

export function recordClickSnap(): void {
  clicks.push(current);
}

export function getClickSnaps(): ReadonlyArray<LatestSnap | null> {
  return clicks;
}

export function clearClickSnaps(): void {
  clicks = [];
}
