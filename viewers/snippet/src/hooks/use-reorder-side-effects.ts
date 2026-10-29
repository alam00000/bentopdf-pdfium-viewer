import type { PluginRegistry } from '@embedpdf/core';
import { RedactionPlugin } from '@embedpdf/plugin-redaction';
import { SearchPlugin } from '@embedpdf/plugin-search';

export const PAGES_REORDERED_EVENT = 'bentopdf:pages-reordered';

export interface PagesReorderedDetail {
  documentId: string;
  movedIndices: readonly number[];
  finalDrop: number;
  pageCount: number;
  oldToNew: readonly number[];
}

export function dispatchPagesReordered(detail: PagesReorderedDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<PagesReorderedDetail>(PAGES_REORDERED_EVENT, { detail }));
  } catch {}
}

export function remapPageIndexSet(
  set: ReadonlySet<number>,
  oldToNew: readonly number[],
): Set<number> {
  const out = new Set<number>();
  for (const oldIdx of set) {
    const newIdx = oldToNew[oldIdx];
    if (typeof newIdx === 'number' && newIdx >= 0) out.add(newIdx);
  }
  return out;
}

export function remapPageIndex(
  oldIdx: number | null | undefined,
  oldToNew: readonly number[],
): number | null {
  if (typeof oldIdx !== 'number') return null;
  const next = oldToNew[oldIdx];
  return typeof next === 'number' && next >= 0 ? next : null;
}

export function invalidatePostReorder(
  registry: PluginRegistry | null | undefined,
  documentId: string,
  detail: Omit<PagesReorderedDetail, 'documentId'>,
  bumpBookmarks?: (documentId: string) => void,
): void {
  try {
    registry
      ?.getPlugin<RedactionPlugin>(RedactionPlugin.id)
      ?.provides()
      .forDocument(documentId)
      .clearPending();
  } catch {}

  try {
    const search = registry?.getPlugin<SearchPlugin>(SearchPlugin.id)?.provides();
    if (search) {
      try {
        search.stopSearch(documentId);
      } catch {}
      try {
        search.searchAllPages('', documentId);
      } catch {}
    }
  } catch {}

  try {
    bumpBookmarks?.(documentId);
  } catch {}

  dispatchPagesReordered({ documentId, ...detail });
}
