export interface PageMeta {
  pageWidthPdf: number;
  pageHeightPdf: number;
  pageCssScale: number;
}

const meta = new Map<string, PageMeta>();

function key(documentId: string, pageIndex: number): string {
  return documentId + ':' + pageIndex;
}

export function setPageMeta(documentId: string, pageIndex: number, m: PageMeta): void {
  if (m.pageWidthPdf <= 0 || m.pageHeightPdf <= 0) return;
  meta.set(key(documentId, pageIndex), m);
}

export function getPageMeta(documentId: string, pageIndex: number): PageMeta | null {
  return meta.get(key(documentId, pageIndex)) ?? null;
}

export function clearPageMeta(documentId: string, pageIndex: number): void {
  meta.delete(key(documentId, pageIndex));
}
