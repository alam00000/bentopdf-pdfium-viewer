export function thumbBitmapSig(opts: {
  uid: string | undefined;
  pageIndex: number;
  cellWidth: number;
  pageWidth: number;
  pageHeight: number;
  rotation: number;
  refreshVersion: number;
}): string {
  const id = opts.uid ?? `idx${opts.pageIndex}`;
  return `${id}|${opts.cellWidth}|${opts.pageWidth}|${opts.pageHeight}|${opts.rotation}|${opts.refreshVersion}`;
}

export interface ThumbBitmapEntry {
  readonly url: string;
  readonly sig: string;
  readonly uid: string;
}

export function pickThumbDisplayUrl(opts: {
  entry: ThumbBitmapEntry | undefined;
  sig: string;
  pageUid: string | undefined;
}): string | null {
  const { entry, sig, pageUid } = opts;
  if (!entry) return null;
  if (entry.sig === sig) return entry.url;
  if (pageUid != null && entry.uid === pageUid) return entry.url;
  return null;
}

export type ThumbStructuralDelta =
  | { kind: 'insert'; at: number; uids: string[] }
  | { kind: 'delete'; indices: number[]; uids: string[] }
  | { kind: 'reorder'; order: number[] };

function withSigVersion(sig: string, version: number): string {
  const i = sig.lastIndexOf('|');
  return i < 0 ? sig : `${sig.slice(0, i)}|${version}`;
}

export function carryThumbCacheForDelta(
  prev: ReadonlyMap<number, ThumbBitmapEntry>,
  delta: ThumbStructuralDelta,
  versionAt: (slot: number) => number,
): Map<number, ThumbBitmapEntry> {
  const next = new Map<number, ThumbBitmapEntry>();
  const put = (newKey: number, entry: ThumbBitmapEntry) => {
    next.set(newKey, { ...entry, sig: withSigVersion(entry.sig, versionAt(newKey)) });
  };
  if (delta.kind === 'insert') {
    const count = delta.uids.length;
    for (const [oldKey, entry] of prev) {
      put(oldKey < delta.at ? oldKey : oldKey + count, entry);
    }
  } else if (delta.kind === 'delete') {
    const deleted = new Set(delta.indices);
    for (const [oldKey, entry] of prev) {
      if (deleted.has(oldKey)) continue;
      let below = 0;
      for (const di of deleted) if (di < oldKey) below++;
      put(oldKey - below, entry);
    }
  } else {
    const oldToNew = new Array<number>(delta.order.length).fill(-1);
    for (let newIdx = 0; newIdx < delta.order.length; newIdx++) {
      const oldIdx = delta.order[newIdx]!;
      if (oldIdx >= 0) oldToNew[oldIdx] = newIdx;
    }
    for (const [oldKey, entry] of prev) {
      const newKey = oldToNew[oldKey];
      if (newKey !== undefined && newKey >= 0) put(newKey, entry);
    }
  }
  return next;
}
