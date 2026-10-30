import { h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useDocumentState } from '@embedpdf/core/preact';
import { useScrollCapability } from '@embedpdf/plugin-scroll/preact';

import { useEffectivePermissions } from '@/hooks/use-effective-permissions';
import { usePagesOps } from '@/hooks/use-pages-ops';
import {
  flattenOutlineToBookmarkEntries,
  runSplitToOutput,
  type SplitBookmarkEntry,
  type SplitConfig,
} from '@/lib/split-engine';
import { useEscapeKey } from '@/measurement/escape-key';
import { ConfirmDialog } from '../confirm-dialog';
import { DropOverlay } from '../ds/controls';
import { ExtractModal } from '../extract-modal';
import { InsertPdfBatchPasswordPrompt } from '../insert-pdf-batch-password-prompt';
import { InvalidFileDropModal } from '../invalid-file-drop-modal';
import { MixedSizeBanner } from '../mixed-size-banner';
import { emitOpCompleted, OpToast } from '../op-toast';
import { PageLabelsModal } from '../page-labels-modal';
import { PageSizeModal } from '../page-size-modal';
import { ThumbnailContextMenu, type ThumbnailContextMenuState } from '../thumbnail-context-menu';
import { homeEndTarget, nextLeadIndex, type ArrowDir, type HomeEndKind } from './grid-nav';
import { InterleaveDialog } from './InterleaveDialog';
import { ORGANIZE_INSERT_FILES_EVENT, useOrganizeContext } from './OrganizeContext';
import { OrganizeGrid } from './OrganizeGrid';
import { OrganizeToolbar } from './OrganizeToolbar';
import { SplitDialog } from './SplitDialog';

const COLUMNS_KEY = 'bentopdf_organize_columns';

const INSERTABLE_FILE =
  /\.(pdf|png|jpe?g|gif|bmp|tiff?|webp|heic|heif|jp2|j2k|jpx|pnm|pbm|pgm|ppm|tga|ico)$/i;

const IMG_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
};

function isTextEntry(e: Event): boolean {
  const origin = e.composedPath()[0];
  if (!(origin instanceof HTMLElement)) return false;
  return (
    origin.tagName === 'INPUT' ||
    origin.tagName === 'TEXTAREA' ||
    origin.tagName === 'SELECT' ||
    origin.isContentEditable
  );
}

function dragHasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

function readColumns(): number {
  try {
    const n = parseInt(localStorage.getItem(COLUMNS_KEY) ?? '', 10);
    if (Number.isFinite(n)) return Math.max(1, Math.min(6, n));
  } catch {}
  return 4;
}

export function OrganizePanel({
  documentId,
  entering,
}: {
  documentId: string;
  entering?: boolean;
}) {
  const documentState = useDocumentState(documentId);
  const totalPages = documentState?.document?.pageCount ?? 0;
  const { canModifyContents, canCopyContents, canAssembleDocument } =
    useEffectivePermissions(documentId);
  const ops = usePagesOps(documentId);

  const { provides: scrollCap } = useScrollCapability();
  const initialPageIndexRef = useRef<number | null>(null);
  if (initialPageIndexRef.current === null && scrollCap) {
    try {
      const cur = scrollCap.forDocument(documentId).getCurrentPage();
      initialPageIndexRef.current = Math.max(0, (cur ?? 1) - 1);
    } catch {
      initialPageIndexRef.current = 0;
    }
  }
  const initialPageIndex = initialPageIndexRef.current ?? 0;

  const {
    selected,
    anchor,
    lead,
    standalone,
    setMode,
    replaceSelection,
    rangeSelect,
    clearSelection,
    isDragActive,
  } = useOrganizeContext();

  const anyModalOpenRef = useRef(false);

  const selectionArr = useMemo(() => [...selected].sort((a, b) => a - b), [selected]);
  const selectionCoversAll = selectionArr.length >= totalPages && totalPages > 0;
  const canExtract = canCopyContents || canAssembleDocument;
  const canCopyPages = canExtract || canModifyContents;

  const kbdSelRef = useRef({ selected, selectionArr, selectionCoversAll, anchor, lead });
  kbdSelRef.current = { selected, selectionArr, selectionCoversAll, anchor, lead };

  const [contextMenu, setContextMenu] = useState<ThumbnailContextMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ indices: number[] } | null>(null);

  const [gridColumns, setGridColumns] = useState<number>(readColumns);
  const [navColumns, setNavColumns] = useState<number>(gridColumns);
  const [columnRange, setColumnRange] = useState({ min: 2, max: 6 });
  const handleColumnsResolved = useCallback(
    (resolved: number, range: { min: number; max: number }) => {
      setNavColumns(resolved);
      setColumnRange((prev) => (prev.min === range.min && prev.max === range.max ? prev : range));
    },
    [],
  );
  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_KEY, String(gridColumns));
    } catch {}
  }, [gridColumns]);

  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const [interleaveDialogOpen, setInterleaveDialogOpen] = useState(false);
  const [splitBookmarkEntries, setSplitBookmarkEntries] = useState<SplitBookmarkEntry[]>([]);

  const closePanel = useCallback(() => setMode(false), [setMode]);

  useEffect(() => {
    const onInsertFiles = (e: Event) => {
      const detail: unknown = e instanceof CustomEvent ? e.detail : undefined;
      if (typeof detail !== 'object' || detail === null || !('files' in detail)) return;
      if ('documentId' in detail && detail.documentId != null && detail.documentId !== documentId)
        return;
      const files = Array.isArray(detail.files)
        ? detail.files.filter((f: unknown): f is File => f instanceof File)
        : [];
      if (files.length === 0 || !canModifyContents) return;
      void ops.insertFilesAfter(totalPages - 1, files);
    };
    window.addEventListener(ORGANIZE_INSERT_FILES_EVENT, onInsertFiles);
    return () => window.removeEventListener(ORGANIZE_INSERT_FILES_EVENT, onInsertFiles);
  }, [documentId, ops, totalPages, canModifyContents]);

  const actSelection = contextMenu?.selection ?? selectionArr;
  const actAnchor = contextMenu?.anchorPageIndex ?? anchor;

  const runDelete = () => {
    if (!canModifyContents || actSelection.length === 0) return;
    if (actSelection.length >= totalPages) return;
    setConfirmDelete({ indices: actSelection });
  };
  const runDeleteRef = useRef(runDelete);
  runDeleteRef.current = runDelete;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { selected, selectionArr, selectionCoversAll, anchor, lead } = kbdSelRef.current;
      if (isTextEntry(e)) return;
      if (isDragActive || contextMenu || anyModalOpenRef.current || e.defaultPrevented) return;

      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (meta && !e.shiftKey && key === 'a') {
        if (totalPages > 0) {
          replaceSelection(
            Array.from({ length: totalPages }, (_, i) => i),
            0,
          );
          e.preventDefault();
        }
        return;
      }

      if (meta && key === 'z') {
        if (e.shiftKey ? ops.canRedo : ops.canUndo) {
          if (e.shiftKey) ops.redo();
          else ops.undo();
          e.preventDefault();
        }
        return;
      }

      let navDir: ArrowDir | null = null;
      let navHomeEnd: HomeEndKind | null = null;
      switch (e.key) {
        case 'ArrowLeft':
          navDir = 'left';
          break;
        case 'ArrowRight':
          navDir = 'right';
          break;
        case 'ArrowUp':
          navDir = 'up';
          break;
        case 'ArrowDown':
          navDir = 'down';
          break;
        case 'Home':
          navHomeEnd = meta ? 'doc-start' : 'row-start';
          break;
        case 'End':
          navHomeEnd = meta ? 'doc-end' : 'row-end';
          break;
      }
      if (!e.altKey && ((navDir != null && !meta) || navHomeEnd != null)) {
        e.preventDefault();
        if (totalPages > 0) {
          const start = lead ?? anchor ?? initialPageIndex;
          const target =
            navDir != null
              ? nextLeadIndex(start, navDir, navColumns, totalPages)
              : homeEndTarget(start, navHomeEnd ?? 'row-start', navColumns, totalPages);
          if (!e.shiftKey) replaceSelection([target], target);
          else if (anchor == null) rangeSelect(target, start);
          else rangeSelect(target);
        }
        return;
      }

      if (selected.size === 0) return;

      if (key === 'r' && !meta && !e.altKey) {
        if (canModifyContents) {
          void ops.rotate(selectionArr, e.shiftKey ? -90 : 90);
          e.preventDefault();
        }
        return;
      }

      if (meta && !e.shiftKey) {
        if (key === 'x') {
          if (canModifyContents && !selectionCoversAll) {
            void ops.cut(selectionArr);
            e.preventDefault();
          }
          return;
        }
        if (key === 'c') {
          if (canCopyPages) {
            void ops.copy(selectionArr);
            e.preventDefault();
          }
          return;
        }
        if (key === 'v') {
          if (canModifyContents && ops.clipboardHasContent && anchor != null) {
            void ops.paste(anchor);
            e.preventDefault();
          }
          return;
        }
        if (key === 'd') {
          if (canModifyContents) {
            void ops.duplicate(selectionArr);
            e.preventDefault();
          }
          return;
        }
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const origin = e.composedPath()[0];
        if (origin instanceof HTMLElement) origin.blur();
        runDeleteRef.current();
      }
    };
    const onKeyDownFirst = (e: KeyboardEvent) => {
      onKeyDown(e);
      if (e.defaultPrevented) e.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDownFirst, true);
    return () => document.removeEventListener('keydown', onKeyDownFirst, true);
  }, [
    totalPages,
    navColumns,
    initialPageIndex,
    contextMenu,
    isDragActive,
    canModifyContents,
    canCopyPages,
    ops,
    replaceSelection,
    rangeSelect,
  ]);

  useEscapeKey((e) => {
    if (isTextEntry(e) || anyModalOpenRef.current || e.defaultPrevented) return;
    e.preventDefault();
    if (kbdSelRef.current.selected.size > 0) clearSelection();
    else if (!standalone) closePanel();
  }, !isDragActive && !contextMenu);

  const handleContextMenu = useCallback(
    (e: MouseEvent, pageIndex: number) => {
      let effective: ReadonlySet<number> = selected;
      if (!selected.has(pageIndex)) {
        effective = new Set([pageIndex]);
        replaceSelection([pageIndex], pageIndex);
      }
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        anchorPageIndex: pageIndex,
        selection: [...effective].sort((a, b) => a - b),
      });
    },
    [selected, replaceSelection],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleReorder = useCallback(
    (indices: number[], dropIndex: number) => {
      if (!canModifyContents) return;
      void ops.reorder(indices, dropIndex);
    },
    [canModifyContents, ops],
  );

  const runRotate = (delta: 90 | -90) => {
    if (!canModifyContents || actSelection.length === 0) return;
    void ops.rotate(actSelection, delta);
  };
  const runCut = () => {
    if (!canModifyContents || actSelection.length === 0) return;
    if (actSelection.length >= totalPages) return;
    void ops.cut(actSelection);
  };
  const runCopy = () => {
    if (!canCopyPages || actSelection.length === 0) return;
    void ops.copy(actSelection);
  };
  const runPaste = () => {
    if (!canModifyContents || !ops.clipboardHasContent) return;
    void ops.paste(actAnchor != null ? actAnchor : totalPages - 1);
  };
  const runDuplicate = () => {
    if (!canModifyContents || actSelection.length === 0) return;
    void ops.duplicate(actSelection);
  };
  const [extractModal, setExtractModal] = useState<{
    defaultFormat: 'pdf' | 'image';
    preselected: number[];
  } | null>(null);
  const openExtract = (defaultFormat: 'pdf' | 'image') => {
    setExtractModal({ defaultFormat, preselected: actSelection });
  };
  const runInsertBlank = () => {
    if (!canModifyContents) return;
    void ops.insertBlankAfter(actAnchor != null ? actAnchor : totalPages - 1);
  };
  const runAppendFile = () => {
    if (!canModifyContents) return;
    void ops.insertFromFileAfter(totalPages - 1);
  };
  const [pageLabelsOpen, setPageLabelsOpen] = useState(false);
  const runPageLabels = () => {
    if (!canModifyContents) return;
    setPageLabelsOpen(true);
  };
  const [pageSizeOpen, setPageSizeOpen] = useState(false);
  const runPageSize = () => {
    if (!canModifyContents || totalPages === 0) return;
    setPageSizeOpen(true);
  };
  const runReplace = () => {
    if (!canModifyContents || actAnchor == null) return;
    void ops.replace(actAnchor);
  };
  const runInsertFromFileAfter = () => {
    if (!canModifyContents || actAnchor == null) return;
    void ops.insertFromFileAfter(actAnchor);
  };

  const runSplit = useCallback(async () => {
    if (!documentState?.document) return;
    try {
      setSplitBookmarkEntries(flattenOutlineToBookmarkEntries(await ops.getOutlines()));
    } catch {
      setSplitBookmarkEntries([]);
    }
    setSplitDialogOpen(true);
  }, [documentState?.document, ops]);

  const handleSplitSubmit = useCallback(
    async (config: SplitConfig) => {
      if (splitBusy || !documentState?.document) return;
      setSplitBusy(true);
      try {
        const baseName = (documentState.name ?? '').replace(/\.pdf$/i, '') || 'Document';
        const result = await runSplitToOutput(config, {
          pageCount: totalPages,
          baseName,
          bookmarkEntries: splitBookmarkEntries,
          extract: ops.extractBytes,
        });
        if (result.status === 'done') {
          setSplitDialogOpen(false);
          emitOpCompleted({
            documentId,
            message:
              result.count === 1 ? 'Split: 1 PDF written' : `Split into ${result.count} files`,
          });
        } else {
          emitOpCompleted({ documentId, message: `Split failed: ${result.message}` });
        }
      } finally {
        setSplitBusy(false);
      }
    },
    [splitBusy, ops, documentState, documentId, totalPages, splitBookmarkEntries],
  );

  const runInterleave = useCallback(() => {
    if (!canModifyContents) return;
    setInterleaveDialogOpen(true);
  }, [canModifyContents]);

  const handleInterleaveSubmit = useCallback(
    async (opts: { file: File; side: 'after' | 'before' }) => {
      setInterleaveDialogOpen(false);
      await ops.interleaveInsert(opts.file, opts.side);
    },
    [ops],
  );

  const runPasteFromClipboard = useCallback(async () => {
    if (!canModifyContents) return;
    const at = actAnchor ?? totalPages - 1;
    try {
      const items =
        typeof navigator.clipboard?.read === 'function'
          ? await navigator.clipboard.read().catch(() => [])
          : [];
      for (const item of items) {
        if (item.types.includes('application/pdf')) {
          const blob = await item.getType('application/pdf');
          await ops.insertFilesAfter(at, [
            new File([blob], 'clipboard.pdf', { type: 'application/pdf' }),
          ]);
          return;
        }
      }
      for (const item of items) {
        const imgType = item.types.find((t) => t in IMG_MIME);
        if (imgType) {
          const blob = await item.getType(imgType);
          await ops.insertFilesAfter(at, [
            new File([blob], `clipboard${IMG_MIME[imgType]}`, { type: imgType }),
          ]);
          return;
        }
      }
      console.warn('Clipboard has no PDF/image data or copied file.');
    } catch (err) {
      console.warn('Clipboard read failed:', err);
    }
  }, [canModifyContents, actAnchor, totalPages, ops]);

  const menuCaps = useMemo(
    () => ({
      pageCount: totalPages,
      canModifyContents,
      canExtract,
      canCopyPages,
      clipboardHasContent: ops.clipboardHasContent,
    }),
    [totalPages, canModifyContents, canExtract, canCopyPages, ops.clipboardHasContent],
  );

  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [invalidDropFiles, setInvalidDropFiles] = useState<string[] | null>(null);

  anyModalOpenRef.current =
    !!confirmDelete ||
    splitDialogOpen ||
    interleaveDialogOpen ||
    !!extractModal ||
    pageLabelsOpen ||
    pageSizeOpen ||
    !!invalidDropFiles ||
    !!ops.insertBatchPasswordRequest;

  const handlePanelDragEnter = (e: DragEvent) => {
    if (!canModifyContents || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };
  const handlePanelDragOver = (e: DragEvent) => {
    if (!canModifyContents || !dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const handlePanelDragLeave = (e: DragEvent) => {
    if (!dragHasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };
  const handlePanelDrop = (e: DragEvent) => {
    if (!canModifyContents || !dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragOver(false);

    const droppedFiles = Array.from(e.dataTransfer?.files ?? []);
    if (droppedFiles.length === 0) return;
    const valid = droppedFiles.filter((f) => INSERTABLE_FILE.test(f.name));
    const rejected = droppedFiles.filter((f) => !INSERTABLE_FILE.test(f.name)).map((f) => f.name);
    if (rejected.length > 0) {
      setInvalidDropFiles(rejected);
      return;
    }
    void ops.insertFilesAfter(totalPages - 1, valid);
  };

  return (
    <div
      class={`bg-bg-app text-fg-primary @container relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden ${
        entering
          ? '[&>*]:animate-[bento-fade-in_420ms_cubic-bezier(0.33,0,0.67,1)_both] motion-reduce:[&>*]:animate-none'
          : ''
      }`}
      role="region"
      aria-label="Organize Pages"
      onDragEnter={handlePanelDragEnter}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      <OrganizeToolbar
        pageCount={totalPages}
        selectionCount={selectionArr.length}
        canModifyContents={canModifyContents}
        canExtract={canExtract}
        selectionCoversAll={selectionCoversAll}
        onRotate={runRotate}
        onExtract={() => openExtract('pdf')}
        onInsertBlank={runInsertBlank}
        onAppendFile={runAppendFile}
        onPageLabels={runPageLabels}
        onReverse={() => {
          if (canModifyContents) void ops.reverse();
        }}
        onPageSize={runPageSize}
        onSplit={() => void runSplit()}
        onInterleave={runInterleave}
        onPasteFromClipboard={() => void runPasteFromClipboard()}
        onDelete={runDelete}
        columns={navColumns}
        minColumns={columnRange.min}
        maxColumns={columnRange.max}
        onColumnsChange={setGridColumns}
        canUndo={ops.canUndo}
        canRedo={ops.canRedo}
        onUndo={ops.undo}
        onRedo={ops.redo}
        onClose={standalone ? undefined : closePanel}
      />

      {canModifyContents && (
        <MixedSizeBanner
          documentId={documentId}
          onAutoResize={({ indices, newWidthPt, newHeightPt }) => {
            void ops.setPageSize(indices, newWidthPt, newHeightPt);
          }}
        />
      )}

      <OrganizeGrid
        documentId={documentId}
        onContextMenu={handleContextMenu}
        onReorder={handleReorder}
        canModifyContents={canModifyContents}
        columns={gridColumns}
        initialPageIndex={initialPageIndex}
        onColumnsResolved={handleColumnsResolved}
      />

      {contextMenu && (
        <ThumbnailContextMenu
          state={contextMenu}
          caps={menuCaps}
          actions={{
            rotateClockwise: () => runRotate(90),
            rotateCounterClockwise: () => runRotate(-90),
            insertBlankAfter: runInsertBlank,
            insertFromFileAfter: runInsertFromFileAfter,
            replace: runReplace,
            extractAsPdf: () => openExtract('pdf'),
            extractAsImage: () => openExtract('image'),
            cut: runCut,
            copy: runCopy,
            paste: runPaste,
            duplicate: runDuplicate,
            remove: runDelete,
          }}
          onClose={closeContextMenu}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={confirmDelete.indices.length === 1 ? 'Delete page?' : 'Delete pages?'}
          message={
            confirmDelete.indices.length === 1
              ? 'This will remove the selected page from the document.'
              : `This will remove ${confirmDelete.indices.length} pages from the document.`
          }
          destructiveLabel="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const indices = confirmDelete.indices;
            setConfirmDelete(null);
            void ops.remove(indices);
            clearSelection();
          }}
        />
      )}

      {ops.insertBatchPasswordRequest && (
        <InsertPdfBatchPasswordPrompt
          files={ops.insertBatchPasswordRequest.files}
          onSubmit={ops.insertBatchPasswordRequest.onSubmit}
          onCancel={ops.insertBatchPasswordRequest.onCancel}
          isProcessing={ops.insertBatchPasswordRequest.isProcessing}
        />
      )}

      {isDragOver && (
        <DropOverlay hint="PDFs or images are added at the end. Images become pages." />
      )}

      {invalidDropFiles && (
        <InvalidFileDropModal
          fileNames={invalidDropFiles}
          onClose={() => setInvalidDropFiles(null)}
        />
      )}

      {pageSizeOpen && (
        <PageSizeModal
          documentId={documentId}
          totalPages={totalPages}
          preselected={actSelection}
          initialPreviewPage={actAnchor != null ? actAnchor : 0}
          onCancel={() => setPageSizeOpen(false)}
          onSubmit={async (result, onProgress) => {
            await ops.setPageSize(result.indices, result.newWidthPt, result.newHeightPt, {
              onProgress,
            });
            setPageSizeOpen(false);
          }}
        />
      )}

      {pageLabelsOpen && (
        <PageLabelsModal
          totalPages={totalPages}
          preselected={actSelection}
          onCancel={() => setPageLabelsOpen(false)}
          onSubmit={(result) => {
            setPageLabelsOpen(false);
            void ops.setPageLabels(result);
          }}
        />
      )}

      {extractModal && (
        <ExtractModal
          totalPages={totalPages}
          preselected={extractModal.preselected}
          defaultFormat={extractModal.defaultFormat}
          onCancel={() => setExtractModal(null)}
          onSubmit={(result) => {
            setExtractModal(null);
            if (result.indices.length === 0) return;
            if (result.format === 'image') void ops.extractAsImage(result.indices);
            else void ops.extractAsPdf(result.indices, { combine: result.combine === 'combine' });
          }}
        />
      )}

      <SplitDialog
        open={splitDialogOpen}
        onClose={() => setSplitDialogOpen(false)}
        pageCount={totalPages}
        busy={splitBusy}
        onSubmit={(config) => void handleSplitSubmit(config)}
      />

      <InterleaveDialog
        open={interleaveDialogOpen}
        onClose={() => setInterleaveDialogOpen(false)}
        pageCount={totalPages}
        onSubmit={(opts) => void handleInterleaveSubmit(opts)}
      />

      <OpToast documentId={documentId} />
    </div>
  );
}
