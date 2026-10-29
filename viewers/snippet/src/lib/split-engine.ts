import type { OutlineNode } from '@/hooks/pages-ops-types';
import { downloadBlob, downloadBytes } from '@/lib/download';
import { makeZip, type ZipEntry } from '@/lib/zip';

export type SplitMode = 'page-range' | 'even-odd' | 'each-page' | 'bookmarks' | 'by-n' | 'by-size';

export type BookmarkDepth = 0 | 1 | 2 | -1;

export type SizeUnit = 'KB' | 'MB';

export type RangeOutput = 'separate' | 'combined';

export interface SplitBookmarkEntry {
  level: number;
  text: string;
  page: number;
}

export interface SplitConfig {
  mode: SplitMode;
  rangeText: string;
  rangeOutput: RangeOutput;
  nChunk: number;
  includeUnbookmarked: boolean;
  bookmarkDepth: BookmarkDepth;
  sizeValue: number;
  sizeUnit: SizeUnit;
}

export interface SplitInput {
  pageCount: number;
  baseName: string;
  bookmarkEntries?: SplitBookmarkEntry[];
  extract: (pageIndices: number[]) => Promise<Uint8Array | null>;
}

export type SplitRunResult =
  | { status: 'done'; count: number }
  | { status: 'error'; message: string };

interface SplitPart {
  range: string;
  basename: string;
  bytes?: Uint8Array;
}

const RANGE_SECTION = /^(\d+)(?:-(\d+|end|~\d+))?$/i;

function sizeToBytes(value: number, unit: SizeUnit): number {
  return Math.floor(value * (unit === 'KB' ? 1024 : 1024 * 1024));
}

export function sanitizeFilenameSegment(s: string): string {
  let out = s
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|^+=]/g, '')
    .replace(/\s+/g, '_')
    .trim();
  if (out.startsWith('.')) out = out.slice(1);
  if (out.length === 0) out = 'output';
  return out;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function sections(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseRangeList(
  input: string,
  total: number,
): Array<{ rangeSpec: string; start: number; end: number }> | null {
  const parts = sections(input);
  if (parts.length === 0) return null;
  return parts.map((sec) => {
    const spec = sec.replace(/\s+/g, '');
    const m = spec.match(RANGE_SECTION);
    let start = 1;
    let end = 1;
    if (m) {
      start = parseInt(m[1]!, 10);
      const tail = m[2];
      if (!tail) end = start;
      else if (/^\d+$/.test(tail)) end = parseInt(tail, 10);
      else end = total > 0 ? total : start;
    }
    return { rangeSpec: spec, start, end };
  });
}

export function rangeTextError(text: string, total: number, subject = 'this PDF'): string | null {
  const parts = sections(text);
  if (parts.length === 0) return 'Enter a page range, e.g. 1-3, 5, 9-12';
  const cap = total > 0 ? total : Infinity;
  const pageWord = total === 1 ? 'page' : 'pages';
  const outOfRange = (label: string): string =>
    `${label} is out of range: ${subject} has ${total} ${pageWord}`;
  for (const sec of parts) {
    const spec = sec.replace(/\s+/g, '');
    const m = spec.match(RANGE_SECTION);
    if (!m) return `"${sec}" isn't a valid page or range`;
    const start = parseInt(m[1]!, 10);
    if (start < 1) return `Page numbers start at 1 (got "${sec}")`;
    if (start > cap) return outOfRange(`Page ${start}`);
    const tail = m[2];
    if (tail && /^\d+$/.test(tail)) {
      const end = parseInt(tail, 10);
      if (end < start) return `Range "${sec}" goes backwards`;
      if (end > cap) return outOfRange(`Page ${end}`);
    } else if (tail && tail[0] === '~') {
      const fromEnd = parseInt(tail.slice(1), 10);
      if (fromEnd > cap) return outOfRange(`"${sec}"`);
    }
  }
  return null;
}

export function rangeToIndices(range: string, total: number): number[] {
  const out: number[] = [];
  if (range === 'all' || range === 'odd' || range === 'even') {
    for (let i = 0; i < total; i++) {
      if (range === 'all' || (i % 2 === 0) === (range === 'odd')) out.push(i);
    }
    return out;
  }
  for (const sec of sections(range)) {
    const m = sec.replace(/\s+/g, '').match(RANGE_SECTION);
    if (!m) continue;
    const start = parseInt(m[1]!, 10);
    const tail = m[2];
    const end = !tail
      ? start
      : /^\d+$/.test(tail)
        ? parseInt(tail, 10)
        : tail[0] === '~'
          ? total - parseInt(tail.slice(1), 10) + 1
          : total;
    for (let p = Math.max(1, start); p <= Math.min(total, end); p++) out.push(p - 1);
  }
  return out;
}

export function createDefaultSplitConfig(pageCount?: number): SplitConfig {
  const rangeText = pageCount && pageCount > 0 ? (pageCount === 1 ? '1' : `1-${pageCount}`) : '';
  return {
    mode: 'page-range',
    rangeText,
    rangeOutput: 'separate',
    nChunk: 5,
    includeUnbookmarked: true,
    bookmarkDepth: 0,
    sizeValue: 5,
    sizeUnit: 'MB',
  };
}

export function splitApplyBlocked(
  config: SplitConfig,
  input: { pageCount: number } | null,
  busy: boolean,
): string | null {
  if (busy) return null;
  if (!input) return 'Add a PDF to split';
  if (config.mode === 'page-range') {
    const err = rangeTextError(config.rangeText, input.pageCount);
    if (err) return err;
  }
  if (config.mode === 'by-n' && (!(config.nChunk >= 1) || !Number.isFinite(config.nChunk))) {
    return 'Pages-per-file must be 1 or more';
  }
  if (
    config.mode === 'by-size' &&
    (!(config.sizeValue > 0) || !Number.isFinite(config.sizeValue))
  ) {
    return 'Maximum size must be greater than 0';
  }
  return null;
}

async function planBySize(
  input: SplitInput,
  maxBytes: number,
): Promise<Array<{ start: number; end: number; bytes: Uint8Array }>> {
  const total = input.pageCount;
  const fits = async (start: number, end: number): Promise<Uint8Array | null> => {
    const bytes = await input.extract(Array.from({ length: end - start + 1 }, (_, i) => start + i));
    if (!bytes) throw new Error('Could not plan a size-based split for this PDF');
    return bytes.length <= maxBytes ? bytes : null;
  };
  const chunks: Array<{ start: number; end: number; bytes: Uint8Array }> = [];
  let start = 0;
  while (start < total) {
    let fitBytes = await fits(start, start);
    if (!fitBytes) {
      throw new Error(`Page ${start + 1} is larger than the maximum file size on its own`);
    }
    let fitEnd = start;
    let failEnd = total;
    let step = 1;
    while (fitEnd + 1 < failEnd) {
      const probe =
        failEnd === total ? Math.min(total - 1, fitEnd + step) : (fitEnd + failEnd) >> 1;
      const bytes = await fits(start, probe);
      if (bytes) {
        fitEnd = probe;
        fitBytes = bytes;
        step *= 2;
      } else {
        failEnd = probe;
      }
    }
    chunks.push({ start, end: fitEnd, bytes: fitBytes });
    start = fitEnd + 1;
  }
  return chunks;
}

export async function buildSplitParts(
  config: SplitConfig,
  input: SplitInput,
): Promise<SplitPart[] | null> {
  const baseName = sanitizeFilenameSegment(input.baseName.replace(/\.pdf$/i, ''));
  const total = input.pageCount;
  const out: SplitPart[] = [];

  if (config.mode === 'page-range') {
    const parsed = parseRangeList(config.rangeText, total);
    if (!parsed) return null;
    if (config.rangeOutput === 'combined') {
      out.push({
        range: parsed.map((s) => s.rangeSpec).join(','),
        basename: `${baseName}_extracted.pdf`,
      });
    } else {
      for (const sec of parsed) {
        const span = sec.start === sec.end ? `page_${sec.start}` : `pages_${sec.start}-${sec.end}`;
        out.push({ range: sec.rangeSpec, basename: `${baseName}_${span}.pdf` });
      }
    }
  } else if (config.mode === 'even-odd') {
    out.push({ range: 'odd', basename: `${baseName}_odd.pdf` });
    out.push({ range: 'even', basename: `${baseName}_even.pdf` });
  } else if (config.mode === 'each-page') {
    if (total === 0) throw new Error('Page count unknown. Re-add the file');
    const w = String(total).length;
    for (let p = 1; p <= total; p++) {
      out.push({ range: `${p}`, basename: `${baseName}_page_${pad(p, w)}.pdf` });
    }
  } else if (config.mode === 'by-n') {
    const n = Math.max(1, Math.floor(config.nChunk));
    if (total === 0) throw new Error('Page count unknown. Re-add the file');
    const chunks = Math.ceil(total / n);
    const w = String(chunks).length;
    for (let i = 0; i < chunks; i++) {
      const start = i * n + 1;
      const end = Math.min(total, start + n - 1);
      out.push({
        range: start === end ? `${start}` : `${start}-${end}`,
        basename: `${baseName}_part_${pad(i + 1, w)}.pdf`,
      });
    }
  } else if (config.mode === 'bookmarks') {
    const filtered = (input.bookmarkEntries ?? [])
      .filter((e) => (config.bookmarkDepth === -1 ? true : e.level <= config.bookmarkDepth))
      .sort((a, b) => a.page - b.page);
    if (filtered.length === 0) {
      throw new Error(
        config.bookmarkDepth === 0
          ? 'This PDF has no top-level bookmarks'
          : 'This PDF has no bookmarks at the chosen depth',
      );
    }
    if (config.includeUnbookmarked && filtered[0]!.page > 1) {
      out.push({
        range: `1-${filtered[0]!.page - 1}`,
        basename: `${baseName}_front_matter.pdf`,
      });
    }
    for (let i = 0; i < filtered.length; i++) {
      const start = filtered[i]!.page;
      const next = filtered[i + 1]?.page;
      let range: string;
      if (next != null) {
        const end = Math.max(start, next - 1);
        range = end > start ? `${start}-${end}` : `${start}`;
      } else if (total > 0) {
        range = total > start ? `${start}-${total}` : `${start}`;
      } else {
        range = `${start}-end`;
      }
      const safe = sanitizeFilenameSegment(filtered[i]!.text);
      out.push({ range, basename: `${safe || `bookmark_${i + 1}`}.pdf` });
    }
  } else if (config.mode === 'by-size') {
    const maxBytes = sizeToBytes(config.sizeValue, config.sizeUnit);
    if (!(maxBytes > 0)) throw new Error('Invalid maximum size');
    if (total === 0) throw new Error('Page count unknown. Re-add the file');
    const chunks = await planBySize(input, maxBytes);
    const w = String(chunks.length).length;
    chunks.forEach((c, i) => {
      out.push({
        range: c.start === c.end ? `${c.start + 1}` : `${c.start + 1}-${c.end + 1}`,
        basename: `${baseName}_part_${pad(i + 1, w)}.pdf`,
        bytes: c.bytes,
      });
    });
  }

  return out;
}

function uniqueName(name: string, used: Set<string>): string {
  let next = name;
  for (let n = 2; used.has(next.toLowerCase()); n++) next = name.replace(/(\.pdf)?$/i, `_${n}$1`);
  used.add(next.toLowerCase());
  return next;
}

export async function runSplitToOutput(
  config: SplitConfig,
  input: SplitInput,
): Promise<SplitRunResult> {
  let parts: SplitPart[] | null;
  try {
    parts = await buildSplitParts(config, input);
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  if (!parts || parts.length === 0) {
    return { status: 'error', message: 'No output files would be produced' };
  }

  const files: ZipEntry[] = [];
  const used = new Set<string>();
  try {
    for (const part of parts) {
      let data = part.bytes ?? null;
      if (!data) {
        const indices = rangeToIndices(part.range, input.pageCount);
        if (indices.length === 0) continue;
        data = await input.extract(indices);
        if (!data) return { status: 'error', message: 'Could not split this PDF.' };
      }
      files.push({ name: uniqueName(part.basename, used), data });
    }
  } catch (err) {
    console.error('[split] extract failed:', err);
    return { status: 'error', message: 'Could not split this PDF.' };
  }
  if (files.length === 0) {
    return { status: 'error', message: 'No output files would be produced' };
  }

  if (files.length === 1) {
    downloadBytes(files[0]!.data, files[0]!.name, 'application/pdf');
  } else {
    const baseName = sanitizeFilenameSegment(input.baseName.replace(/\.pdf$/i, ''));
    downloadBlob(makeZip(files), `${baseName}_split.zip`);
  }
  return { status: 'done', count: files.length };
}

export function flattenOutlineToBookmarkEntries(
  nodes: readonly OutlineNode[],
  level = 0,
  acc: SplitBookmarkEntry[] = [],
): SplitBookmarkEntry[] {
  for (const node of nodes) {
    if (typeof node.pageIndex === 'number' && node.pageIndex >= 0) {
      acc.push({ level, text: String(node.title ?? ''), page: node.pageIndex + 1 });
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      flattenOutlineToBookmarkEntries(node.children, level + 1, acc);
    }
  }
  return acc;
}
