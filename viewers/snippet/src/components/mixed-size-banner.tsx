import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useDocumentState } from '@embedpdf/core/preact';

import { Button, IconButton } from './ds/controls';
import { XIcon } from './ds/icons';

export interface MixedSizeAutoResize {
  newWidthPt: number;
  newHeightPt: number;
  indices: number[];
}

function sizeKey(wPt: number, hPt: number): string {
  if (!Number.isFinite(wPt) || !Number.isFinite(hPt)) return '';
  if (wPt <= 0 || hPt <= 0) return '';
  const minD = Math.round(Math.min(wPt, hPt) / 3) * 3;
  const maxD = Math.round(Math.max(wPt, hPt) / 3) * 3;
  return `${minD}x${maxD}`;
}

const STANDARD_NAMES: ReadonlyArray<{ name: string; w: number; h: number }> = [
  { name: 'US Letter', w: 612, h: 792 },
  { name: 'US Legal', w: 612, h: 1008 },
  { name: 'Tabloid', w: 792, h: 1224 },
  { name: 'Executive', w: 522, h: 756 },
  { name: 'A0', w: 2384, h: 3370 },
  { name: 'A1', w: 1684, h: 2384 },
  { name: 'A2', w: 1191, h: 1684 },
  { name: 'A3', w: 842, h: 1191 },
  { name: 'A4', w: 595, h: 842 },
  { name: 'A5', w: 420, h: 595 },
  { name: 'A6', w: 297, h: 420 },
  { name: 'B4', w: 709, h: 1001 },
  { name: 'B5', w: 499, h: 709 },
];

function describeSize(wPt: number, hPt: number): string {
  const TOL = 3;
  const minD = Math.min(wPt, hPt);
  const maxD = Math.max(wPt, hPt);
  const match = STANDARD_NAMES.find(
    (s) => Math.abs(Math.min(s.w, s.h) - minD) <= TOL && Math.abs(Math.max(s.w, s.h) - maxD) <= TOL,
  );
  if (match) return match.name;
  const wMm = Math.round((wPt * 25.4) / 72);
  const hMm = Math.round((hPt * 25.4) / 72);
  return `${wMm} × ${hMm} mm`;
}

interface Bucket {
  count: number;
  areaSum: number;
  sample: { w: number; h: number };
}

function chooseTarget(
  pages: ReadonlyArray<{ size: { width: number; height: number } }>,
): MixedSizeAutoResize | null {
  if (pages.length < 2) return null;

  const buckets = new Map<string, Bucket>();
  for (const p of pages) {
    const k = sizeKey(p.size.width, p.size.height);
    if (!k) continue;
    const area = p.size.width * p.size.height;
    const e = buckets.get(k);
    if (e) {
      e.count += 1;
      e.areaSum += area;
    } else {
      buckets.set(k, { count: 1, areaSum: area, sample: { w: p.size.width, h: p.size.height } });
    }
  }
  if (buckets.size <= 1) return null;

  let bestKey: string | null = null;
  let best: Bucket | null = null;
  for (const [k, v] of buckets) {
    if (
      best === null ||
      v.count > best.count ||
      (v.count === best.count && v.areaSum / v.count > best.areaSum / best.count)
    ) {
      best = v;
      bestKey = k;
    }
  }
  if (!best || !bestKey) return null;

  const indices: number[] = [];
  pages.forEach((p, i) => {
    if (sizeKey(p.size.width, p.size.height) !== bestKey) indices.push(i);
  });
  if (indices.length === 0) return null;

  return { newWidthPt: best.sample.w, newHeightPt: best.sample.h, indices };
}

function dismissalKey(docId: string): string {
  return `bento.mixedSizeBanner.dismissed.${docId}`;
}

function readDismissed(docId: string): boolean {
  try {
    return sessionStorage.getItem(dismissalKey(docId)) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(docId: string): void {
  try {
    sessionStorage.setItem(dismissalKey(docId), '1');
  } catch {}
}

export function MixedSizeBanner({
  documentId,
  onAutoResize,
}: {
  documentId: string;
  onAutoResize: (payload: MixedSizeAutoResize) => void;
}) {
  const documentState = useDocumentState(documentId);
  const pages = documentState?.document?.pages;
  const [dismissed, setDismissed] = useState(() => readDismissed(documentId));

  useEffect(() => {
    setDismissed(readDismissed(documentId));
  }, [documentId]);

  const target = useMemo(() => (pages ? chooseTarget(pages) : null), [pages]);

  if (!target || dismissed) return null;

  const offCount = target.indices.length;
  const targetName = describeSize(target.newWidthPt, target.newHeightPt);
  const label =
    offCount === 1
      ? `1 page is a different size. Resize it to ${targetName}?`
      : `${offCount} pages are different sizes. Resize them to ${targetName}?`;

  return (
    <div
      class="pointer-events-none flex justify-center px-4 pt-3 pb-1"
      role="region"
      aria-label="Mixed page sizes detected"
    >
      <div class="bg-bg-elevated border-border-subtle pointer-events-auto inline-flex max-w-[min(640px,100%)] items-center gap-3 rounded-[14px] border py-1.5 pr-1.5 pl-3.5 shadow-md">
        <span
          class="bg-accent before:bg-accent relative h-3 w-3 shrink-0 rounded-full before:absolute before:-inset-1.5 before:animate-ping before:rounded-full before:opacity-40 before:content-[''] motion-reduce:before:animate-none"
          aria-hidden="true"
        />
        <span class="text-fg-primary truncate text-sm">{label}</span>
        <Button variant="brand" size="sm" class="min-w-[80px]" onClick={() => onAutoResize(target)}>
          Resize
        </Button>
        <IconButton
          variant="ghost"
          size="sm"
          class="shrink-0"
          aria-label="Dismiss"
          onClick={() => {
            writeDismissed(documentId);
            setDismissed(true);
          }}
        >
          <XIcon size={12} weight="bold" />
        </IconButton>
      </div>
    </div>
  );
}
