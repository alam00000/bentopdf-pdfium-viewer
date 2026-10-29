import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useRegistry } from '@embedpdf/core/preact';
import { refreshDocument, refreshPages } from '@embedpdf/core';
import {
  PdfActionType,
  PdfErrorCode,
  type PdfBookmarkObject,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfPageMutation,
  type PdfPageMutationResult,
  type Rotation,
} from '@embedpdf/models';
import type { Command } from '@embedpdf/plugin-history';
import { useHistoryCapability } from '@embedpdf/plugin-history/preact';
import { ANNOTATION_PLUGIN_ID, type AnnotationPlugin } from '@embedpdf/plugin-annotation';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';

import type {
  InsertBatchPasswordFile,
  InsertBatchPasswordRequest,
  OutlineNode,
  PageLabelStyle,
  PagesOps,
} from './pages-ops-types';
import {
  isPagesClipboardPending,
  setPagesClipboard,
  settledPagesClipboard,
  trackPagesClipboardWrite,
  usePagesClipboard,
} from './use-pages-clipboard';
import { invalidatePostReorder } from './use-reorder-side-effects';
import { PAGE_LABELS_CHANGED_EVENT } from './use-page-labels';
import { emitOpCompleted } from '@/components/op-toast';
import { PAGES_STRUCTURAL_DELTA_EVENT } from '@/components/organize/OrganizeGrid';
import type { ThumbStructuralDelta } from '@/components/organize/thumb-sig';
import { downloadBlob, downloadBytes } from '@/lib/download';
import { makeZip, type ZipEntry } from '@/lib/zip';
import { imageFileToPdf, isImageFile } from '@/lib/image-pdf';

export class OpLock {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(
      () => fn(),
      () => fn(),
    );
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const locksByDoc = new Map<string, OpLock>();
export function getOpLock(documentId: string): OpLock {
  let lock = locksByDoc.get(documentId);
  if (!lock) {
    lock = new OpLock();
    locksByDoc.set(documentId, lock);
  }
  return lock;
}

export function clearOpLockForDoc(documentId: string): void {
  locksByDoc.delete(documentId);
}

type PageLabelRule = {
  pageIndex: number;
  style?: string;
  start?: number;
  prefix?: string;
};

function parseLabelRules(json: string): PageLabelRule[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown): PageLabelRule[] => {
      if (typeof entry !== 'object' || entry === null || !('pageIndex' in entry)) return [];
      if (typeof entry.pageIndex !== 'number') return [];
      const rule: PageLabelRule = { pageIndex: entry.pageIndex };
      if ('style' in entry && typeof entry.style === 'string' && entry.style) {
        rule.style = entry.style;
      }
      if ('start' in entry && typeof entry.start === 'number') rule.start = entry.start;
      if ('prefix' in entry && typeof entry.prefix === 'string' && entry.prefix) {
        rule.prefix = entry.prefix;
      }
      return [rule];
    });
  } catch {
    return [];
  }
}

export function remapPageLabelsForDelete(
  rules: PageLabelRule[],
  deletedIndices: number[],
): PageLabelRule[] {
  if (rules.length === 0) return [];
  const deletedSet = new Set(deletedIndices);
  const sorted = [...deletedIndices].sort((a, b) => a - b);
  const out: PageLabelRule[] = [];
  for (const r of rules) {
    if (deletedSet.has(r.pageIndex)) continue;
    let shift = 0;
    for (const d of sorted) {
      if (d < r.pageIndex) shift++;
      else break;
    }
    out.push({ ...r, pageIndex: r.pageIndex - shift });
  }
  return out;
}

export function remapPageLabelsForInsert(
  rules: PageLabelRule[],
  insertAt: number,
  count: number,
): PageLabelRule[] {
  if (rules.length === 0 || count <= 0) return rules.slice();
  return rules.map((r) => (r.pageIndex >= insertAt ? { ...r, pageIndex: r.pageIndex + count } : r));
}

function rangeIndices(start: number, end: number): number[] {
  if (start > end) return [];
  const out: number[] = new Array(end - start + 1);
  for (let i = 0; i <= end - start; i++) out[i] = start + i;
  return out;
}

export function isReorderNoOp(indices: number[], dropIndex: number): boolean {
  if (indices.length === 0) return true;
  const sorted = [...indices].sort((a, b) => a - b);
  if (new Set(sorted).has(dropIndex)) return true;
  if (sorted.length === 1 && (dropIndex === sorted[0] || dropIndex === sorted[0]! + 1)) {
    return true;
  }
  return false;
}

function rejectionCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('reason' in err)) return undefined;
  const reason = err.reason;
  if (typeof reason !== 'object' || reason === null || !('code' in reason)) return undefined;
  return typeof reason.code === 'number' ? reason.code : undefined;
}

type ProbeResult =
  | { status: 'ok'; pageCount: number }
  | { status: 'password' }
  | { status: 'unreadable' };

let probeSeq = 0;

async function probePdf(
  engine: PdfEngine,
  bytes: ArrayBuffer,
  password: string,
): Promise<ProbeResult> {
  try {
    const doc = await engine
      .openDocumentBuffer({ id: `pages-probe-${++probeSeq}`, content: bytes }, { password })
      .toPromise();
    const pageCount = doc.pageCount;
    await engine
      .closeDocument(doc)
      .toPromise()
      .catch(() => undefined);
    return pageCount > 0 ? { status: 'ok', pageCount } : { status: 'unreadable' };
  } catch (err) {
    return rejectionCode(err) === PdfErrorCode.Password
      ? { status: 'password' }
      : { status: 'unreadable' };
  }
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

function outlineFromBookmarks(bookmarks: PdfBookmarkObject[]): OutlineNode[] {
  return bookmarks.map((b) => {
    const target = b.target;
    let pageIndex = -1;
    if (target?.type === 'destination') pageIndex = target.destination.pageIndex;
    else if (
      target?.type === 'action' &&
      (target.action.type === PdfActionType.Goto ||
        target.action.type === PdfActionType.RemoteGoto)
    ) {
      pageIndex = target.action.destination.pageIndex;
    }
    return {
      title: b.title,
      pageIndex,
      children: b.children?.length ? outlineFromBookmarks(b.children) : undefined,
    };
  });
}

function runsOf(sorted: number[]): Array<{ from: number; sourceIndices: number[] }> {
  const runs: Array<{ from: number; sourceIndices: number[] }> = [];
  let k = 0;
  while (k < sorted.length) {
    let end = k;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    runs.push({ from: sorted[k]!, sourceIndices: rangeIndices(k, end) });
    k = end + 1;
  }
  return runs;
}

type ChangeRange = number[] | { from: number; to?: number };

export type PagesCommandMetadata =
  | { kind: 'rotate'; indices: number[]; delta: 90 | -90 }
  | { kind: 'insert-blank'; insertedAt: number }
  | { kind: 'insert-from-file'; insertedAt: number; count: number }
  | { kind: 'replace'; index: number }
  | { kind: 'cut'; indices: number[] }
  | { kind: 'paste'; insertedAt: number; count: number }
  | { kind: 'duplicate'; indices: number[]; count: number }
  | { kind: 'delete'; indices: number[] }
  | { kind: 'split'; indices: number[] }
  | { kind: 'reorder'; from: number[]; to: number }
  | { kind: 'reverse' }
  | { kind: 'interleave'; insertedAt: number; count: number }
  | { kind: 'page-labels' }
  | { kind: 'page-size'; count: number };

export function usePagesOps(documentId: string): PagesOps {
  const { registry } = useRegistry();
  const { provides: history } = useHistoryCapability();
  const clipboard = usePagesClipboard();
  const opLock = useMemo(() => getOpLock(documentId), [documentId]);

  const historyScope = useMemo(
    () => (history && documentId ? history.forDocument(documentId) : null),
    [history, documentId],
  );

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!historyScope) return;
    return historyScope.onHistoryChange(() => setTick((t) => t + 1));
  }, [historyScope]);

  const [insertBatchPasswordRequest, setInsertBatchPasswordRequest] =
    useState<InsertBatchPasswordRequest | null>(null);

  const engine = useMemo(() => registry?.getEngine() ?? null, [registry]);

  const currentDoc = useCallback((): PdfDocumentObject | null => {
    return registry?.getStore().getState().core.documents[documentId]?.document ?? null;
  }, [registry, documentId]);

  const toast = useCallback(
    (message: string, severity?: 'success' | 'error') =>
      emitOpCompleted({ documentId, message, severity }),
    [documentId],
  );

  const mutate = useCallback(
    async (
      mutation: PdfPageMutation,
      changed: ChangeRange,
      delta?: (before: PdfDocumentObject, result: PdfPageMutationResult) => ThumbStructuralDelta,
    ): Promise<PdfPageMutationResult> => {
      const doc = currentDoc();
      const store = registry?.getStore();
      if (!doc || !store || !engine?.mutatePages) throw new Error('page operations unavailable');
      const result = await engine.mutatePages(doc, mutation).toPromise();
      store.dispatch(refreshDocument(documentId, result.document));
      const count = result.document.pageCount;
      const pages = Array.isArray(changed)
        ? changed.filter((i) => i >= 0 && i < count)
        : rangeIndices(Math.max(0, changed.from), Math.min(changed.to ?? count - 1, count - 1));
      if (pages.length > 0) store.dispatch(refreshPages(documentId, pages));
      if (delta) {
        window.dispatchEvent(
          new CustomEvent(PAGES_STRUCTURAL_DELTA_EVENT, {
            detail: { documentId, delta: delta(doc, result) },
          }),
        );
      }
      return result;
    },
    [registry, engine, documentId, currentDoc],
  );

  const insertDelta =
    (at: number) =>
    (_before: PdfDocumentObject, result: PdfPageMutationResult): ThumbStructuralDelta => ({
      kind: 'insert',
      at,
      uids: result.document.pages.slice(at, at + result.inserted).map((p) => p.uid ?? ''),
    });

  const deleteDelta =
    (indices: number[]) =>
    (before: PdfDocumentObject): ThumbStructuralDelta => ({
      kind: 'delete',
      indices,
      uids: indices.map((i) => before.pages[i]?.uid ?? ''),
    });

  const reorderDelta = (order: number[]) => (): ThumbStructuralDelta => ({
    kind: 'reorder',
    order,
  });

  const readLabels = useCallback(async (): Promise<PageLabelRule[]> => {
    const doc = currentDoc();
    if (!doc || !engine?.getPageLabelRules) return [];
    try {
      return parseLabelRules(await engine.getPageLabelRules(doc).toPromise());
    } catch {
      return [];
    }
  }, [engine, currentDoc]);

  const writeLabels = useCallback(
    async (rules: PageLabelRule[]) => {
      const doc = currentDoc();
      if (!doc || !engine?.setPageLabelRules) return;
      try {
        await engine.setPageLabelRules(doc, JSON.stringify(rules)).toPromise();
      } catch {}
      window.dispatchEvent(
        new CustomEvent(PAGE_LABELS_CHANGED_EVENT, { detail: { documentId } }),
      );
    },
    [engine, documentId, currentDoc],
  );

  const extract = useCallback(
    async (indices: number[]): Promise<ArrayBuffer> => {
      const doc = currentDoc();
      if (!doc || !engine) throw new Error('document unavailable');
      return engine.extractPages(doc, indices).toPromise();
    },
    [engine, currentDoc],
  );

  const restorePages = useCallback(
    async (source: ArrayBuffer, originals: number[]) => {
      for (const run of runsOf(originals)) {
        await mutate(
          { kind: 'import', source, pageIndices: run.sourceIndices, at: run.from },
          { from: run.from },
          insertDelta(run.from),
        );
      }
    },
    [mutate],
  );

  const commitAnnotations = useCallback(async () => {
    const scope = registry
      ?.getPlugin<AnnotationPlugin>(ANNOTATION_PLUGIN_ID)
      ?.provides()
      ?.forDocument(documentId);
    if (!scope) return;
    try {
      await scope.commit().toPromise();
    } catch {}
  }, [registry, documentId]);

  const canUndo = historyScope?.canUndo('pages') ?? false;
  const canRedo = historyScope?.canRedo('pages') ?? false;

  const runOp = useCallback(
    async (opts: {
      forward: () => Promise<void>;
      undo: () => Promise<void>;
      metadata: PagesCommandMetadata;
    }): Promise<void> => {
      if (!engine || !currentDoc() || !historyScope) return;
      await opLock.run(async () => {
        await commitAnnotations();
        await opts.forward();
        let firstCall = true;
        const cmd: Command<PagesCommandMetadata> = {
          execute: () => {
            if (firstCall) {
              firstCall = false;
              return;
            }
            opLock.run(opts.forward).catch((err) => console.error('pages redo failed', err));
          },
          undo: () => {
            opLock.run(opts.undo).catch((err) => console.error('pages undo failed', err));
          },
          metadata: opts.metadata,
        };
        historyScope.register(cmd, 'pages');
      });
    },
    [engine, historyScope, opLock, currentDoc, commitAnnotations],
  );

  const rotate = useCallback(
    async (indices: number[], delta: 90 | -90) => {
      const doc = currentDoc();
      if (!doc || indices.length === 0) return;
      const valid = indices.filter((i) => !!doc.pages[i]);
      if (valid.length === 0) return;
      const oldRot = valid.map((i) => doc.pages[i]!.rotation);
      const step = delta === 90 ? 1 : 3;
      const newRot = oldRot.map((r) => ((r + step) % 4) as Rotation);
      const apply = async (rotations: Rotation[]) => {
        await mutate({ kind: 'rotate', indices: valid, rotations }, valid);
      };
      await runOp({
        forward: () => apply(newRot),
        undo: () => apply(oldRot),
        metadata: { kind: 'rotate', indices: [...valid], delta },
      });
    },
    [currentDoc, mutate, runOp],
  );

  const insertBlankAfter = useCallback(
    async (anchorIdx: number) => {
      const doc = currentDoc();
      if (!doc) return;
      const insertAt = Math.min(anchorIdx + 1, doc.pages.length);
      const anchorPage = doc.pages[anchorIdx];
      const width = anchorPage?.size.width ?? 612;
      const height = anchorPage?.size.height ?? 792;
      const labelSnapshot = await readLabels();

      await runOp({
        forward: async () => {
          await mutate(
            { kind: 'insertBlank', at: insertAt, width, height },
            { from: insertAt },
            insertDelta(insertAt),
          );
          if (labelSnapshot.length > 0) {
            await writeLabels(remapPageLabelsForInsert(labelSnapshot, insertAt, 1));
          }
        },
        undo: async () => {
          await mutate(
            { kind: 'delete', indices: [insertAt] },
            { from: insertAt },
            deleteDelta([insertAt]),
          );
          if (labelSnapshot.length > 0) await writeLabels(labelSnapshot);
        },
        metadata: { kind: 'insert-blank', insertedAt: insertAt },
      });
    },
    [currentDoc, mutate, readLabels, writeLabels, runOp],
  );

  const insertFilesAfter = useCallback(
    async (anchorIdx: number, files: File[]) => {
      const eng = engine;
      if (!currentDoc() || !eng || files.length === 0) return;

      type Source = {
        key: string;
        fileName: string;
        bytes: ArrayBuffer;
        pageCount: number;
        needsPassword: boolean;
        unreadable: boolean;
      };
      const sources: Source[] = [];
      for (const [i, file] of files.entries()) {
        const bytes = isImageFile(file)
          ? await imageFileToPdf(file)
          : await file.arrayBuffer().catch(() => null);
        const key = `${i}:${file.name}`;
        if (!bytes) {
          sources.push({
            key,
            fileName: file.name,
            bytes: new ArrayBuffer(0),
            pageCount: 0,
            needsPassword: false,
            unreadable: true,
          });
          continue;
        }
        const probe = await probePdf(eng, bytes, '');
        sources.push({
          key,
          fileName: file.name,
          bytes,
          pageCount: probe.status === 'ok' ? probe.pageCount : 0,
          needsPassword: probe.status === 'password',
          unreadable: probe.status === 'unreadable',
        });
      }

      const passwordMap = new Map<string, string>();
      const userSkipped = new Set<string>();
      const initialLocked: InsertBatchPasswordFile[] = sources
        .filter((s) => s.needsPassword)
        .map((s) => ({ path: s.key, fileName: s.fileName }));

      const proceeded =
        initialLocked.length === 0 ||
        (await new Promise<boolean>((resolveOuter) => {
          let currentLocked: InsertBatchPasswordFile[] = initialLocked;
          const renderRequest = () => {
            setInsertBatchPasswordRequest({
              files: currentLocked,
              isProcessing: false,
              onCancel: () => {
                setInsertBatchPasswordRequest(null);
                resolveOuter(false);
              },
              onSubmit: async (result) => {
                setInsertBatchPasswordRequest((prev) =>
                  prev ? { ...prev, isProcessing: true } : null,
                );
                for (const [p, pw] of result.passwords) passwordMap.set(p, pw);
                for (const p of result.skipped) userSkipped.add(p);
                const stillFailed: InsertBatchPasswordFile[] = [];
                for (const f of currentLocked) {
                  if (userSkipped.has(f.path)) continue;
                  const pw = passwordMap.get(f.path);
                  const source = sources.find((s) => s.key === f.path);
                  if (!pw || !source) continue;
                  const probe = await probePdf(eng, source.bytes, pw);
                  if (probe.status === 'ok') {
                    source.pageCount = probe.pageCount;
                    continue;
                  }
                  if (probe.status === 'password') {
                    stillFailed.push({ path: f.path, fileName: f.fileName, invalid: true });
                    passwordMap.delete(f.path);
                  } else {
                    userSkipped.add(f.path);
                  }
                }
                if (stillFailed.length === 0) {
                  setInsertBatchPasswordRequest(null);
                  resolveOuter(true);
                } else {
                  currentLocked = stillFailed;
                  renderRequest();
                }
              },
            });
          };
          renderRequest();
        }));
      if (!proceeded) return;

      let cursor = anchorIdx + 1;
      for (const source of sources) {
        if (source.unreadable || userSkipped.has(source.key)) continue;
        if (source.needsPassword && !passwordMap.has(source.key)) continue;
        const password = passwordMap.get(source.key);
        const at = Math.min(cursor, currentDoc()?.pages.length ?? cursor);
        let inserted = 0;
        try {
          await runOp({
            forward: async () => {
              const result = await mutate(
                { kind: 'import', source: source.bytes, password, at },
                { from: at },
                insertDelta(at),
              );
              inserted = result.inserted;
            },
            undo: async () => {
              if (inserted <= 0) return;
              const indices = rangeIndices(at, at + inserted - 1);
              await mutate({ kind: 'delete', indices }, { from: at }, deleteDelta(indices));
            },
            metadata: { kind: 'insert-from-file', insertedAt: at, count: source.pageCount },
          });
        } catch {
          continue;
        }
        cursor = at + inserted;
      }
    },
    [engine, currentDoc, mutate, runOp],
  );

  const insertFromFileAfter = useCallback(
    async (anchorIdx: number) => {
      const files = await pickFiles('application/pdf,.pdf,image/*', true);
      if (files.length === 0) return;
      await insertFilesAfter(anchorIdx, files);
    },
    [insertFilesAfter],
  );

  const replace = useCallback(
    async (idx: number) => {
      const doc = currentDoc();
      if (!doc || !doc.pages[idx]) return;
      const oldBytes = await extract([idx]);
      const [file] = await pickFiles('application/pdf,.pdf', false);
      if (!file) return;
      const newBytes = await file.arrayBuffer().catch(() => null);
      if (!newBytes) return;

      const swapIn = async (source: ArrayBuffer) => {
        await mutate(
          { kind: 'import', source, pageIndices: [0], at: idx + 1 },
          { from: idx + 1 },
          insertDelta(idx + 1),
        );
        await mutate({ kind: 'delete', indices: [idx] }, [idx], deleteDelta([idx]));
      };

      try {
        await runOp({
          forward: () => swapIn(newBytes),
          undo: () => swapIn(oldBytes),
          metadata: { kind: 'replace', index: idx },
        });
      } catch {}
    },
    [currentDoc, extract, mutate, runOp],
  );

  const extractAsPdf = useCallback(
    async (indices: number[], options?: { combine?: boolean }) => {
      if (indices.length === 0 || !currentDoc()) return;
      const sorted = [...indices].sort((a, b) => a - b);
      const combine = options?.combine ?? true;
      try {
        if (combine || sorted.length === 1) {
          const name =
            sorted.length === 1
              ? `Extract-page-${sorted[0]! + 1}.pdf`
              : `Extract-${sorted.length}-pages.pdf`;
          downloadBytes(new Uint8Array(await extract(sorted)), name, 'application/pdf');
          return;
        }
        const stem = `Extract-${sorted.length}-pages`;
        const width = String(sorted[sorted.length - 1]! + 1).length;
        const entries: ZipEntry[] = [];
        for (const idx of sorted) {
          entries.push({
            name: `${stem}-${String(idx + 1).padStart(width, '0')}.pdf`,
            data: new Uint8Array(await extract([idx])),
          });
        }
        downloadBlob(makeZip(entries), `${stem}.zip`);
      } catch {
        toast('Extract failed', 'error');
      }
    },
    [currentDoc, extract, toast],
  );

  const extractAsImage = useCallback(
    async (indices: number[]) => {
      const doc = currentDoc();
      const eng = engine;
      if (indices.length === 0 || !doc || !eng) return;
      const sorted = [...indices].sort((a, b) => a - b);

      const renderImage = async (idx: number): Promise<Uint8Array | null> => {
        const page = doc.pages[idx];
        if (!page) return null;
        const blob = await eng
          .renderPage(doc, page, {
            scaleFactor: 2,
            dpr: 1,
            imageType: 'image/png',
            rotation: page.rotation,
            withAnnotations: true,
          })
          .toPromise();
        return new Uint8Array(await blob.arrayBuffer());
      };

      try {
        if (sorted.length === 1) {
          const idx = sorted[0]!;
          const bytes = await renderImage(idx);
          if (bytes) downloadBytes(bytes, `Page-${idx + 1}.png`, 'image/png');
          return;
        }
        const stem = `Extract-${sorted.length}-pages`;
        const width = String(sorted[sorted.length - 1]! + 1).length;
        const rendered: Array<{ idx: number; bytes: Uint8Array }> = [];
        let cursor = 0;
        const worker = async () => {
          while (cursor < sorted.length) {
            const idx = sorted[cursor++]!;
            try {
              const bytes = await renderImage(idx);
              if (bytes) rendered.push({ idx, bytes });
            } catch {}
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, sorted.length) }, worker));
        rendered.sort((a, b) => a.idx - b.idx);
        downloadBlob(
          makeZip(
            rendered.map(({ idx, bytes }) => ({
              name: `${stem}-${String(idx + 1).padStart(width, '0')}.png`,
              data: bytes,
            })),
          ),
          `${stem}.zip`,
        );
      } catch {
        toast('Extract failed', 'error');
      }
    },
    [engine, currentDoc, toast],
  );

  const extractBytes = useCallback(
    async (indices: number[]): Promise<Uint8Array | null> => {
      if (indices.length === 0) return null;
      try {
        return new Uint8Array(await extract(indices));
      } catch {
        return null;
      }
    },
    [extract],
  );

  const setPageLabels = useCallback(
    async (opts: {
      style: PageLabelStyle;
      prefix: string;
      start: number;
      rangeStart: number;
      rangeEnd: number;
    }) => {
      const doc = currentDoc();
      if (!doc) return;
      const totalPages = doc.pages.length;
      if (totalPages === 0) return;
      const rangeStart = Math.max(0, Math.min(opts.rangeStart, totalPages - 1));
      const rangeEnd = Math.max(rangeStart, Math.min(opts.rangeEnd, totalPages - 1));
      const prevRules = await readLabels();

      const nextRules: PageLabelRule[] = [];
      if (rangeStart > 0) nextRules.push({ pageIndex: 0, style: 'D', start: 1 });
      const userRule: PageLabelRule = { pageIndex: rangeStart };
      if (opts.style !== '') userRule.style = opts.style;
      if (opts.prefix.length > 0) userRule.prefix = opts.prefix;
      if (opts.style !== '') userRule.start = Math.max(1, Math.floor(opts.start || 1));
      nextRules.push(userRule);
      if (rangeEnd < totalPages - 1) {
        nextRules.push({ pageIndex: rangeEnd + 1, style: 'D', start: rangeEnd + 2 });
      }

      await runOp({
        forward: async () => {
          await writeLabels(nextRules);
          toast('Page numbering updated');
        },
        undo: () => writeLabels(prevRules),
        metadata: { kind: 'page-labels' },
      });
    },
    [currentDoc, readLabels, writeLabels, runOp, toast],
  );

  const removeWithUndo = useCallback(
    async (sorted: number[], bytes: ArrayBuffer, metadata: PagesCommandMetadata) => {
      const labelSnapshot = await readLabels();
      await runOp({
        forward: async () => {
          await mutate(
            { kind: 'delete', indices: sorted },
            { from: sorted[0]! },
            deleteDelta(sorted),
          );
          if (labelSnapshot.length > 0) {
            await writeLabels(remapPageLabelsForDelete(labelSnapshot, sorted));
          }
        },
        undo: async () => {
          await restorePages(bytes, sorted);
          if (labelSnapshot.length > 0) await writeLabels(labelSnapshot);
        },
        metadata,
      });
    },
    [readLabels, writeLabels, mutate, restorePages, runOp],
  );

  const cut = useCallback(
    (indices: number[]) =>
      trackPagesClipboardWrite(
        (async () => {
          const doc = currentDoc();
          if (indices.length === 0 || !doc) return;
          if (indices.length >= doc.pages.length) return;
          const sorted = [...new Set(indices)].sort((a, b) => a - b);
          const bytes = await extract(sorted);
          setPagesClipboard({
            tempDocId: `pages-cut-${Date.now()}`,
            count: sorted.length,
            bytes: new Uint8Array(bytes),
            mode: 'cut',
          });
          await removeWithUndo(sorted, bytes, { kind: 'cut', indices: [...sorted] });
        })(),
      ),
    [currentDoc, extract, removeWithUndo],
  );

  const copy = useCallback(
    (indices: number[]) =>
      trackPagesClipboardWrite(
        (async () => {
          if (indices.length === 0 || !currentDoc()) return;
          const sorted = [...new Set(indices)].sort((a, b) => a - b);
          const bytes = await extract(sorted);
          setPagesClipboard({
            tempDocId: `pages-copy-${Date.now()}`,
            count: sorted.length,
            bytes: new Uint8Array(bytes),
            mode: 'copy',
          });
        })(),
      ),
    [currentDoc, extract],
  );

  const paste = useCallback(
    async (afterIdx: number) => {
      const doc = currentDoc();
      if (!doc) return;
      const cb = await settledPagesClipboard();
      if (!cb) return;
      const insertAt = Math.min(Math.max(0, afterIdx + 1), doc.pages.length);
      const source = cb.bytes.slice().buffer;
      let inserted = 0;
      try {
        await runOp({
          forward: async () => {
            const result = await mutate(
              { kind: 'import', source, at: insertAt },
              { from: insertAt },
              insertDelta(insertAt),
            );
            inserted = result.inserted;
          },
          undo: async () => {
            if (inserted <= 0) return;
            const indices = rangeIndices(insertAt, insertAt + inserted - 1);
            await mutate({ kind: 'delete', indices }, { from: insertAt }, deleteDelta(indices));
          },
          metadata: { kind: 'paste', insertedAt: insertAt, count: cb.count },
        });
      } catch {
        toast('Paste failed', 'error');
      }
    },
    [currentDoc, mutate, runOp, toast],
  );

  const duplicate = useCallback(
    async (indices: number[]) => {
      const doc = currentDoc();
      if (indices.length === 0 || !doc) return;
      const sorted = [...new Set(indices)]
        .filter((i) => i >= 0 && i < doc.pages.length)
        .sort((a, b) => a - b);
      if (sorted.length === 0) return;
      const insertAt = sorted[sorted.length - 1]! + 1;
      const labelSnapshot = await readLabels();
      let inserted = 0;
      await runOp({
        forward: async () => {
          const result = await mutate(
            { kind: 'duplicate', indices: sorted, at: insertAt },
            { from: insertAt },
            insertDelta(insertAt),
          );
          inserted = result.inserted;
        },
        undo: async () => {
          if (inserted <= 0) return;
          const indices = rangeIndices(insertAt, insertAt + inserted - 1);
          await mutate({ kind: 'delete', indices }, { from: insertAt }, deleteDelta(indices));
          if (labelSnapshot.length > 0) await writeLabels(labelSnapshot);
        },
        metadata: { kind: 'duplicate', indices: [...sorted], count: sorted.length },
      });
    },
    [currentDoc, readLabels, writeLabels, mutate, runOp],
  );

  const remove = useCallback(
    async (indices: number[]) => {
      const doc = currentDoc();
      if (indices.length === 0 || !doc) return;
      if (indices.length >= doc.pages.length) return;
      const sorted = [...new Set(indices)].sort((a, b) => a - b);
      const bytes = await extract(sorted);
      await removeWithUndo(sorted, bytes, { kind: 'delete', indices: [...sorted] });
    },
    [currentDoc, extract, removeWithUndo],
  );

  const splitPages = useCallback(
    async (indices: number[], axis: 0 | 1, fraction: number, rightFirst: boolean) => {
      const doc = currentDoc();
      if (indices.length === 0 || !doc) return;
      const sorted = [...new Set(indices)]
        .filter((i) => i >= 0 && i < doc.pages.length)
        .sort((a, b) => a - b);
      if (sorted.length === 0) return;
      const bytes = await extract(sorted);
      const halves = sorted.flatMap((p, k) => [p + k, p + k + 1]);
      await runOp({
        forward: async () => {
          await mutate(
            { kind: 'split', indices: sorted, axis, fraction, rightFirst },
            { from: sorted[0]! },
          );
        },
        undo: async () => {
          await mutate({ kind: 'delete', indices: halves }, { from: sorted[0]! });
          await restorePages(bytes, sorted);
        },
        metadata: { kind: 'split', indices: [...sorted] },
      });
    },
    [currentDoc, extract, mutate, restorePages, runOp],
  );

  const exportPdf = useCallback(async (): Promise<{
    bytes: Uint8Array;
    pageCount: number;
  } | null> => {
    await commitAnnotations();
    const doc = currentDoc();
    if (!doc || !engine) return null;
    try {
      const buffer = await engine.saveAsCopy(doc).toPromise();
      return { bytes: new Uint8Array(buffer), pageCount: doc.pageCount };
    } catch {
      return null;
    }
  }, [engine, currentDoc, commitAnnotations]);

  const getOutlines = useCallback(async (): Promise<OutlineNode[]> => {
    const doc = currentDoc();
    if (!doc || !engine) return [];
    try {
      const { bookmarks } = await engine.getBookmarks(doc).toPromise();
      return outlineFromBookmarks(bookmarks);
    } catch {
      return [];
    }
  }, [engine, currentDoc]);

  const interleaveInsert = useCallback(
    async (file: File, side: 'after' | 'before') => {
      const doc = currentDoc();
      if (!doc) return;
      const n = doc.pages.length;
      if (n === 0) return;
      const source = await file.arrayBuffer().catch(() => null);
      if (!source) {
        toast('Interleave failed', 'error');
        return;
      }
      let m = 0;
      let finalOrder: number[] = [];
      let inverse: number[] = [];
      try {
        await runOp({
          forward: async () => {
            const result = await mutate(
              { kind: 'import', source, at: n },
              { from: n },
              insertDelta(n),
            );
            m = result.inserted;
            if (m === 0) throw new Error('nothing to interleave');
            const mn = Math.min(n, m);
            finalOrder = [];
            for (let p = 0; p < mn; p++) {
              if (side === 'after') finalOrder.push(p, n + p);
              else finalOrder.push(n + p, p);
            }
            for (let j = mn; j < n; j++) finalOrder.push(j);
            for (let j = mn; j < m; j++) finalOrder.push(n + j);
            inverse = new Array<number>(finalOrder.length);
            for (let k = 0; k < finalOrder.length; k++) inverse[finalOrder[k]!] = k;
            await mutate({ kind: 'reorder', order: finalOrder }, { from: 0 }, reorderDelta(finalOrder));
          },
          undo: async () => {
            await mutate({ kind: 'reorder', order: inverse }, { from: 0 }, reorderDelta(inverse));
            const indices = rangeIndices(n, n + m - 1);
            await mutate({ kind: 'delete', indices }, { from: n }, deleteDelta(indices));
          },
          metadata: { kind: 'interleave', insertedAt: n, count: m },
        });
      } catch {
        toast('Interleave failed', 'error');
        return;
      }
      toast(`Interleaved ${m} pages`);
    },
    [currentDoc, mutate, runOp, toast],
  );

  const reverse = useCallback(async () => {
    const doc = currentDoc();
    if (!doc) return;
    const n = doc.pages.length;
    if (n <= 1) return;
    const reversed = Array.from({ length: n }, (_, i) => n - 1 - i);
    const labelSnapshot = await readLabels();
    await runOp({
      forward: async () => {
        await mutate({ kind: 'reorder', order: reversed }, { from: 0 }, reorderDelta(reversed));
        if (labelSnapshot.length > 0) await writeLabels([]);
        toast(`Reversed ${n} pages`);
      },
      undo: async () => {
        await mutate({ kind: 'reorder', order: reversed }, { from: 0 }, reorderDelta(reversed));
        if (labelSnapshot.length > 0) await writeLabels(labelSnapshot);
      },
      metadata: { kind: 'reverse' },
    });
  }, [currentDoc, readLabels, writeLabels, mutate, runOp, toast]);

  const setPageSize = useCallback(
    async (
      indices: number[],
      newW: number,
      newH: number,
      opts?: { onProgress?: (done: number, total: number) => void },
    ) => {
      const doc = currentDoc();
      if (!doc || indices.length === 0) return;
      if (!Number.isFinite(newW) || !Number.isFinite(newH)) return;
      if (newW <= 0 || newH <= 0) return;
      const sorted = [...new Set(indices)]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < doc.pages.length)
        .sort((a, b) => a - b);
      if (sorted.length === 0) return;
      const bytes = await extract(sorted);
      await runOp({
        forward: async () => {
          opts?.onProgress?.(0, sorted.length);
          await mutate({ kind: 'resize', indices: sorted, width: newW, height: newH }, sorted);
          opts?.onProgress?.(sorted.length, sorted.length);
          toast(sorted.length === 1 ? 'Resized 1 page' : `Resized ${sorted.length} pages`);
        },
        undo: async () => {
          await mutate({ kind: 'delete', indices: sorted }, { from: sorted[0]! }, deleteDelta(sorted));
          await restorePages(bytes, sorted);
        },
        metadata: { kind: 'page-size', count: sorted.length },
      });
    },
    [currentDoc, extract, mutate, restorePages, runOp, toast],
  );

  const reorder = useCallback(
    async (indices: number[], dropIndex: number) => {
      if (isReorderNoOp(indices, dropIndex)) return;
      const doc = currentDoc();
      if (!doc) return;
      const sorted = [...new Set(indices)].sort((a, b) => a - b);
      const removedBefore = sorted.filter((i) => i < dropIndex).length;
      const finalDrop = dropIndex - removedBefore;
      const pageCount = doc.pageCount;

      let activePageOldIndex: number | null = null;
      try {
        const cur = registry
          ?.getPlugin<ScrollPlugin>('scroll')
          ?.provides()
          ?.forDocument(documentId)
          .getCurrentPage();
        if (typeof cur === 'number' && cur >= 1) activePageOldIndex = cur - 1;
      } catch {}

      const oldToNew: number[] = new Array(pageCount);
      const movedSet = new Set(sorted);
      let cursor = 0;
      for (let i = 0; i < pageCount; i++) {
        if (movedSet.has(i)) continue;
        if (cursor === finalDrop) cursor += sorted.length;
        oldToNew[i] = cursor;
        cursor++;
      }
      for (let k = 0; k < sorted.length; k++) oldToNew[sorted[k]!] = finalDrop + k;
      const newToOld = new Array<number>(pageCount).fill(-1);
      for (let oldIdx = 0; oldIdx < pageCount; oldIdx++) newToOld[oldToNew[oldIdx]!] = oldIdx;

      const from = Math.min(sorted[0]!, finalDrop);
      const to = Math.max(sorted[sorted.length - 1]!, finalDrop + sorted.length - 1);

      await runOp({
        forward: async () => {
          await mutate({ kind: 'reorder', order: newToOld }, { from, to }, reorderDelta(newToOld));
          invalidatePostReorder(registry, documentId, {
            movedIndices: sorted,
            finalDrop,
            pageCount,
            oldToNew,
          });
          if (activePageOldIndex != null) {
            const newIdx = oldToNew[activePageOldIndex];
            if (typeof newIdx === 'number' && newIdx >= 0) {
              try {
                registry
                  ?.getPlugin<ScrollPlugin>('scroll')
                  ?.provides()
                  ?.forDocument(documentId)
                  .scrollToPage({ pageNumber: newIdx + 1, behavior: 'instant' });
              } catch {}
            }
          }
        },
        undo: async () => {
          await mutate({ kind: 'reorder', order: oldToNew }, { from, to }, reorderDelta(oldToNew));
          invalidatePostReorder(registry, documentId, {
            movedIndices: rangeIndices(finalDrop, finalDrop + sorted.length - 1),
            finalDrop: sorted[0]!,
            pageCount,
            oldToNew: newToOld,
          });
        },
        metadata: { kind: 'reorder', from: [...sorted], to: dropIndex },
      });
    },
    [registry, documentId, currentDoc, mutate, runOp],
  );

  const undo = useCallback(() => {
    historyScope?.undo('pages');
  }, [historyScope]);

  const redo = useCallback(() => {
    historyScope?.redo('pages');
  }, [historyScope]);

  return {
    rotate,
    insertBlankAfter,
    insertFromFileAfter,
    insertFilesAfter,
    replace,
    extractAsPdf,
    extractAsImage,
    extractBytes,
    setPageLabels,
    cut,
    copy,
    paste,
    duplicate,
    remove,
    reorder,
    reverse,
    exportPdf,
    getOutlines,
    interleaveInsert,
    setPageSize,
    splitPages,
    undo,
    redo,
    canUndo,
    canRedo,
    clipboardHasContent: clipboard !== null || isPagesClipboardPending(),
    insertBatchPasswordRequest,
  };
}
