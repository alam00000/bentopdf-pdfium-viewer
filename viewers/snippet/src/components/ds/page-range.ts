export type PageScopeMode = 'all' | 'range';

export interface PageScopeValue {
  mode: PageScopeMode;
  text: string;
}

export const PAGE_RANGE_EXAMPLE = '1-3, 5, 8-';

type ParseResult = { ok: true; indices: number[] } | { ok: false; message: string };

function pagesWord(n: number): string {
  return n === 1 ? '1 page' : `${n} pages`;
}

function countOf(total: number): number {
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
}

function readPoint(p: string, total: number): number | string {
  if (/^\d+$/.test(p)) {
    const n = Number(p);
    if (n < 1) return 'Pages start at 1';
    if (n > total) return `There is no page ${p}; this document has ${pagesWord(total)}`;
    return n;
  }
  if (/^end$/i.test(p)) return total < 1 ? 'This document has no pages' : total;
  if (/^~\d+$/.test(p)) {
    const k = Number(p.slice(1));
    if (k < 1) return `"${p}" isn't a page; ~1 is the last page`;
    if (k > total) return `There is no page ${p}; this document has ${pagesWord(total)}`;
    return total - k + 1;
  }
  return `"${p}" isn't a page number`;
}

export function parsePageRanges(text: string, total: number): ParseResult {
  const count = countOf(total);
  const hit = new Uint8Array(count);
  let found = false;
  for (const raw of text.split(',')) {
    const body = raw.trim();
    if (!body) continue;
    const dash = body.indexOf('-');
    if (dash >= 0 && body.indexOf('-', dash + 1) >= 0) {
      return { ok: false, message: `"${body}" isn't a page or a range` };
    }
    const parts = dash < 0 ? [body] : [body.slice(0, dash), body.slice(dash + 1)];
    const points: Array<number | undefined> = [];
    for (const part of parts) {
      const p = part.trim();
      if (!p) {
        points.push(undefined);
        continue;
      }
      const page = readPoint(p, count);
      if (typeof page === 'string') return { ok: false, message: page };
      points.push(page);
    }
    const [first, last] = points;
    if (dash >= 0 && first === undefined && last === undefined) {
      return { ok: false, message: 'A range needs a page on at least one side of the dash' };
    }
    const from = first ?? 1;
    const to = dash < 0 ? from : (last ?? count);
    if (to < from) {
      return { ok: false, message: `"${body}" goes backwards; put the lower page first` };
    }
    hit.fill(1, from - 1, to);
    found = true;
  }
  if (!found) return { ok: false, message: `Enter pages, for example ${PAGE_RANGE_EXAMPLE}` };
  const indices: number[] = [];
  hit.forEach((h, i) => {
    if (h) indices.push(i);
  });
  return { ok: true, indices };
}

export function resolvePageScope(
  value: PageScopeValue,
  ctx: { pageCount: number },
  offered: readonly PageScopeMode[],
): { ok: true; mode: PageScopeMode; indices: number[] } | { ok: false; message: string } {
  const count = countOf(ctx.pageCount);
  if (count < 1) return { ok: false, message: 'This document has no pages' };
  const mode = offered.includes(value.mode) ? value.mode : offered[0];
  if (mode === undefined) return { ok: false, message: 'There are no pages to choose from' };
  if (mode === 'all')
    return { ok: true, mode, indices: Array.from({ length: count }, (_, i) => i) };
  const r = parsePageRanges(value.text, count);
  return r.ok ? { ok: true, mode, indices: r.indices } : r;
}
