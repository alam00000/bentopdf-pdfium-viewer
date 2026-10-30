import { h, ComponentChildren, FunctionComponent } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { useDocumentState } from '@embedpdf/core/preact';
import { PdfErrorCode } from '@embedpdf/models';
import { useRenderCapability } from '@embedpdf/plugin-render/preact';
import { useScroll } from '@embedpdf/plugin-scroll/preact';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DndContextProps,
  type DragOverlayProps,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';

import { usePageLabels } from '@/hooks/use-page-labels';
import { isReorderNoOp } from '@/hooks/use-pages-ops';
import {
  PAGES_REORDERED_EVENT,
  remapPageIndex,
  type PagesReorderedDetail,
} from '@/hooks/use-reorder-side-effects';
import { pageSizeLabel } from '@/lib/page-size-label';
import { FadingScrollThumb } from '../ds/fading-scroll-thumb';
import { DotsThreeIcon } from '../ds/icons';
import { dispatchOrganizeSet, useOrganizeContext } from './OrganizeContext';
import {
  carryThumbCacheForDelta,
  pickThumbDisplayUrl,
  thumbBitmapSig,
  type ThumbBitmapEntry,
  type ThumbStructuralDelta,
} from './thumb-sig';

export const PAGES_STRUCTURAL_DELTA_EVENT = 'bento:pages-structural-delta';

interface OrganizeGridProps {
  documentId: string;
  onContextMenu: (e: MouseEvent, pageIndex: number) => void;
  onReorder: (indices: number[], dropIndex: number) => void;
  canModifyContents: boolean;
  columns?: number;
  initialPageIndex?: number;
  onColumnsResolved?: (columns: number, range: { min: number; max: number }) => void;
}

const GRID_PADDING_X = 48;
const NARROW_GRID_PADDING_X = 16;
const GRID_PADDING_Y = 32;
const COL_GAP = 24;
const ROW_GAP = 32;
const THUMB_PADDING = 12;
const INNER_GAP = 10;
const LABEL_HEIGHT = 20;
const SIZE_LABEL_HEIGHT = 16;
const LABEL_STACK_GAP = 2;
const LABEL_STACK_HEIGHT = LABEL_HEIGHT + LABEL_STACK_GAP + SIZE_LABEL_HEIGHT;
const MIN_CELL_WIDTH = 120;
const NARROW_GRID_WIDTH = 640;
const IMG_ASPECT_RATIO = 4 / 3;
const DEFAULT_PAGE_RATIO = 1.294;

const ZERO_OFFSET = Object.freeze({ x: 0, y: 0 });

type WithChildren<P> = Omit<P, 'children'> & { children?: ComponentChildren };
const Dnd = DndContext as unknown as FunctionComponent<WithChildren<DndContextProps>>;
const Overlay = DragOverlay as unknown as FunctionComponent<WithChildren<DragOverlayProps>>;

type DocumentState = ReturnType<typeof useDocumentState>;
type DocPage = NonNullable<NonNullable<DocumentState>['document']>['pages'][number];

function pageUid(page: DocPage | undefined): string | undefined {
  return page && 'uid' in page && typeof page.uid === 'string' ? page.uid : undefined;
}

function visibleHeightFor(page: DocPage | null | undefined, innerW: number): number {
  const ratio =
    page && page.size.width > 0 ? page.size.height / page.size.width : DEFAULT_PAGE_RATIO;
  return page != null && page.rotation % 2 === 1
    ? Math.round(innerW / ratio)
    : Math.round(innerW * ratio);
}

export function OrganizeGrid({
  documentId,
  onContextMenu,
  onReorder,
  canModifyContents,
  columns,
  initialPageIndex,
  onColumnsResolved,
}: OrganizeGridProps) {
  const requestedColumns = Math.max(1, Math.min(6, Math.floor(columns ?? 4)));
  const { provides: scrollProvides } = useScroll(documentId);
  const documentState = useDocumentState(documentId);
  const totalPages = documentState?.document?.pageCount ?? 0;
  const { labelFor } = usePageLabels(documentId);

  const {
    selected,
    lead,
    standalone,
    toggleSelected,
    replaceSelection,
    rangeSelect,
    clearSelection,
    setDragActive,
  } = useOrganizeContext();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const docPages = documentState?.document?.pages;
  const maxThumbRatio = useMemo(() => {
    if (!docPages || docPages.length === 0) return IMG_ASPECT_RATIO;
    let max = IMG_ASPECT_RATIO;
    for (const p of docPages) {
      if (!p || p.size.width <= 0 || p.size.height <= 0) continue;
      const ratio =
        p.rotation % 2 === 1 ? p.size.width / p.size.height : p.size.height / p.size.width;
      if (ratio > max) max = ratio;
    }
    return max;
  }, [docPages]);

  const narrow = containerWidth > 0 && containerWidth < NARROW_GRID_WIDTH;
  const paddingX = narrow ? NARROW_GRID_PADDING_X : GRID_PADDING_X;
  const available =
    containerWidth > 0 ? Math.max(0, containerWidth - 2 * paddingX) : 1280 - 2 * GRID_PADDING_X;
  const fitColumns = Math.max(1, Math.floor((available + COL_GAP) / (MIN_CELL_WIDTH + COL_GAP)));
  const maxColumns = Math.min(narrow ? 2 : 6, fitColumns);
  const minColumns = Math.min(narrow ? 1 : 2, maxColumns);
  const columnCount = Math.max(minColumns, Math.min(requestedColumns, maxColumns));

  useEffect(() => {
    onColumnsResolved?.(columnCount, { min: minColumns, max: maxColumns });
  }, [columnCount, minColumns, maxColumns, onColumnsResolved]);

  const layout = useMemo(() => {
    const derived = (available - (columnCount - 1) * COL_GAP) / columnCount;
    const cellWidth = Math.max(MIN_CELL_WIDTH, derived);
    const innerW = cellWidth - 2 * THUMB_PADDING;
    const thumbHeight = Math.round(innerW * maxThumbRatio);
    const cellHeight = 2 * THUMB_PADDING + thumbHeight + INNER_GAP + LABEL_STACK_HEIGHT;
    return { cellWidth, innerW, thumbHeight, cellHeight };
  }, [available, maxThumbRatio, columnCount]);

  const rowCount = totalPages > 0 ? Math.ceil(totalPages / columnCount) : 0;

  const scrollParentRef = useRef<HTMLDivElement | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => layout.cellHeight + ROW_GAP,
    overscan: 2,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [layout.cellHeight, rowVirtualizer]);

  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    if (initialScrollDoneRef.current) return;
    if (initialPageIndex == null || initialPageIndex < 0) return;
    if (layout.cellHeight <= 0 || rowCount <= 0) return;
    if (!scrollParentRef.current) return;
    const targetRow = Math.min(rowCount - 1, Math.floor(initialPageIndex / columnCount));
    const rowH = layout.cellHeight + ROW_GAP;
    initialScrollDoneRef.current = true;
    const raf = requestAnimationFrame(() => {
      const el = scrollParentRef.current;
      if (!el) return;
      const viewportH = el.clientHeight;
      const desired = targetRow * rowH + rowH / 2 - viewportH / 2;
      const maxScroll = Math.max(0, el.scrollHeight - viewportH);
      el.scrollTop = Math.max(0, Math.min(maxScroll, desired));
    });
    return () => cancelAnimationFrame(raf);
  }, [initialPageIndex, layout.cellHeight, rowCount, columnCount]);

  const prevLeadRef = useRef<number | null>(null);
  useEffect(() => {
    if (lead == null || lead < 0) {
      prevLeadRef.current = lead;
      return;
    }
    if (prevLeadRef.current === lead) return;
    prevLeadRef.current = lead;
    if (layout.cellHeight <= 0 || rowCount <= 0) return;
    if (!scrollParentRef.current) return;
    const targetRow = Math.min(rowCount - 1, Math.floor(lead / columnCount));
    const rowH = layout.cellHeight + ROW_GAP;
    const rowTop = GRID_PADDING_Y + targetRow * rowH;
    const rowBottom = rowTop + layout.cellHeight;
    const raf = requestAnimationFrame(() => {
      const node = scrollParentRef.current;
      if (!node) return;
      const viewTop = node.scrollTop;
      const viewBottom = viewTop + node.clientHeight;
      const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
      let nextTop = viewTop;
      if (rowTop < viewTop) nextTop = rowTop - GRID_PADDING_Y;
      else if (rowBottom > viewBottom) nextTop = rowBottom - node.clientHeight + GRID_PADDING_Y;
      nextTop = Math.max(0, Math.min(maxScroll, nextTop));
      if (nextTop !== viewTop) node.scrollTop = nextTop;
    });
    return () => cancelAnimationFrame(raf);
  }, [lead, layout.cellHeight, rowCount, columnCount]);

  useEffect(() => {
    const onReordered = (e: Event) => {
      const detail = (e as CustomEvent<PagesReorderedDetail>).detail;
      if (!detail || detail.documentId !== documentId) return;
      prevLeadRef.current = remapPageIndex(prevLeadRef.current, detail.oldToNew);
    };
    window.addEventListener(PAGES_REORDERED_EVENT, onReordered);
    return () => window.removeEventListener(PAGES_REORDERED_EVENT, onReordered);
  }, [documentId]);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const scrollProvidesRef = useRef(scrollProvides);
  scrollProvidesRef.current = scrollProvides;

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (!(e.currentTarget instanceof HTMLElement)) return;
      const pageIndex = Number(e.currentTarget.dataset.pageIndex);
      if (!Number.isFinite(pageIndex)) return;
      if (e.shiftKey) {
        rangeSelect(pageIndex);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        toggleSelected(pageIndex);
        return;
      }
      const sel = selectedRef.current;
      if (sel.size === 1 && sel.has(pageIndex)) {
        clearSelection();
        return;
      }
      replaceSelection([pageIndex], pageIndex);
    },
    [rangeSelect, toggleSelected, clearSelection, replaceSelection],
  );

  const handleDoubleClick = useCallback(
    (e: MouseEvent) => {
      if (standalone || !(e.currentTarget instanceof HTMLElement)) return;
      const pageIndex = Number(e.currentTarget.dataset.pageIndex);
      if (!Number.isFinite(pageIndex)) return;
      dispatchOrganizeSet(false, documentId);
      setTimeout(() => {
        try {
          scrollProvidesRef.current?.scrollToPage({
            pageNumber: pageIndex + 1,
            behavior: 'instant',
          });
        } catch {}
      }, 60);
    },
    [documentId, standalone],
  );

  const lastPointerTypeRef = useRef('mouse');

  const openPageMenu = useCallback((e: MouseEvent) => {
    if (!(e.currentTarget instanceof HTMLElement)) return;
    const pageIndex = Number(e.currentTarget.dataset.pageIndex);
    if (!Number.isFinite(pageIndex)) return;
    e.preventDefault();
    onContextMenuRef.current(e, pageIndex);
  }, []);

  const handleCellContextMenu = useCallback(
    (e: MouseEvent) => {
      if (lastPointerTypeRef.current === 'touch') {
        e.preventDefault();
        return;
      }
      openPageMenu(e);
    },
    [openPageMenu],
  );

  const handleMoreClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      openPageMenu(e);
    },
    [openPageMenu],
  );

  const [activeDragSet, setActiveDragSet] = useState<number[] | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragScrollRectRef = useRef<DOMRect | null>(null);
  const fixedProbeRef = useRef<HTMLDivElement>(null);
  const fixedOriginRef = useRef({ x: 0, y: 0 });
  const overlayModifiers = useMemo<Modifier[]>(
    () => [
      ({ transform }) => ({
        ...transform,
        x: transform.x - fixedOriginRef.current.x,
        y: transform.y - fixedOriginRef.current.y,
      }),
    ],
    [],
  );
  const [pageOrder, setPageOrder] = useState<number[] | null>(null);
  const pendingDropRef = useRef(false);
  const [bitmaps, setBitmaps] = useState<Map<number, ThumbBitmapEntry>>(() => new Map());
  const pendingPermRef = useRef<number[] | null>(null);

  const shuffleCache = useCallback(
    (perm: readonly number[]) => (prev: Map<number, ThumbBitmapEntry>) => {
      const next = new Map<number, ThumbBitmapEntry>();
      for (let k = 0; k < perm.length; k++) {
        const entry = prev.get(perm[k]!);
        if (entry) next.set(k, entry);
      }
      for (const [k, entry] of prev) {
        if (k >= perm.length) next.set(k, entry);
      }
      return next;
    },
    [],
  );

  const setBitmap = useCallback((pageIndex: number, entry: ThumbBitmapEntry) => {
    setBitmaps((prev) => {
      const old = prev.get(pageIndex);
      if (old && old.url !== entry.url) URL.revokeObjectURL(old.url);
      const next = new Map(prev);
      next.set(pageIndex, entry);
      return next;
    });
  }, []);

  useEffect(
    () => () => {
      setBitmaps((prev) => {
        for (const entry of prev.values()) URL.revokeObjectURL(entry.url);
        return new Map();
      });
    },
    [documentId],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const { setNodeRef: setGridDroppableRef } = useDroppable({ id: 'organize-grid' });

  const setScrollParentEl = useCallback(
    (el: HTMLDivElement | null) => {
      scrollParentRef.current = el;
      setGridDroppableRef(el);
    },
    [setGridDroppableRef],
  );

  const collisionDetection: CollisionDetection = useCallback(
    ({ collisionRect, pointerCoordinates }) => {
      const cx = collisionRect
        ? collisionRect.left + collisionRect.width / 2
        : pointerCoordinates?.x;
      const cy = collisionRect
        ? collisionRect.top + collisionRect.height / 2
        : pointerCoordinates?.y;
      if (cx == null || cy == null) return [];
      const scrollEl = scrollParentRef.current;
      if (!scrollEl || layout.cellHeight <= 0 || layout.cellWidth <= 0) return [];
      const rect = dragScrollRectRef.current ?? scrollEl.getBoundingClientRect();
      const yInScroll = cy - rect.top + scrollEl.scrollTop - GRID_PADDING_Y;
      const rowH = layout.cellHeight + ROW_GAP;
      const lastRow = Math.max(0, Math.ceil(totalPages / columnCount) - 1);
      const row = Math.max(0, Math.min(lastRow, Math.floor(yInScroll / rowH)));
      const startOfRow = row * columnCount;
      const cellsInRow = Math.max(1, Math.min(columnCount, totalPages - startOfRow));
      const totalRowWidth = cellsInRow * layout.cellWidth + (cellsInRow - 1) * COL_GAP;
      const rowStartX = (rect.width - totalRowWidth) / 2;
      const xInRow = cx - rect.left - rowStartX;
      const colW = layout.cellWidth + COL_GAP;
      const cellIdx = Math.max(0, Math.min(cellsInRow - 1, Math.floor(xInRow / colW)));
      const within = xInRow - cellIdx * colW;
      const col = within < layout.cellWidth / 2 ? cellIdx : cellIdx + 1;
      const idx = Math.max(0, Math.min(totalPages, startOfRow + col));
      if (idx !== dropIndexRef.current) {
        dropIndexRef.current = idx;
        setDropIndex(idx);
      }
      return [{ id: 'organize-grid' }];
    },
    [layout.cellHeight, layout.cellWidth, totalPages, columnCount],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const draggedPageIndex = event.active.data.current?.pageIndex;
      if (typeof draggedPageIndex !== 'number') return;
      const dragSet =
        selected.has(draggedPageIndex) && selected.size > 1
          ? [...selected].sort((a, b) => a - b)
          : [draggedPageIndex];
      dragScrollRectRef.current = scrollParentRef.current?.getBoundingClientRect() ?? null;
      const origin = fixedProbeRef.current?.getBoundingClientRect();
      fixedOriginRef.current = { x: origin?.left ?? 0, y: origin?.top ?? 0 };
      setActiveDragSet(dragSet);
      setDragActive(true);
      dropIndexRef.current = draggedPageIndex;
      setDropIndex(draggedPageIndex);
    },
    [selected, setDragActive],
  );

  const handleDragEnd = useCallback(() => {
    const liveDragging = activeDragSet;
    const liveDropAt = dropIndexRef.current;
    setActiveDragSet(null);
    setDragActive(false);
    dropIndexRef.current = null;
    setDropIndex(null);

    if (!liveDragging || liveDropAt == null || isReorderNoOp(liveDragging, liveDropAt)) {
      setPageOrder(null);
      return;
    }
    pendingDropRef.current = true;
    const sortedDragged = [...liveDragging].sort((a, b) => a - b);
    const draggedSet = new Set(sortedDragged);
    const finalDrop = liveDropAt - sortedDragged.filter((i) => i < liveDropAt).length;
    const remaining: number[] = [];
    for (let i = 0; i < totalPages; i++) {
      if (!draggedSet.has(i)) remaining.push(i);
    }
    const newOrder = [
      ...remaining.slice(0, finalDrop),
      ...sortedDragged,
      ...remaining.slice(finalDrop),
    ];
    pendingPermRef.current = newOrder;
    setPageOrder(newOrder);
    onReorder(liveDragging, liveDropAt);
  }, [activeDragSet, onReorder, totalPages, setDragActive]);

  const handleDragCancel = useCallback(() => {
    setActiveDragSet(null);
    setDragActive(false);
    dropIndexRef.current = null;
    setDropIndex(null);
  }, [setDragActive]);

  const lastDocRef = useRef(documentState?.document);
  useLayoutEffect(() => {
    const currentDoc = documentState?.document;
    if (currentDoc === lastDocRef.current) return;
    lastDocRef.current = currentDoc;
    if (!pendingDropRef.current) return;
    pendingDropRef.current = false;
    const perm = pendingPermRef.current;
    if (perm) setBitmaps(shuffleCache(perm));
    pendingPermRef.current = null;
    setPageOrder(null);
  }, [documentState?.document, shuffleCache]);

  const versionsRef = useRef<Record<number, number>>({});
  versionsRef.current = documentState?.pageRefreshVersions ?? {};

  useEffect(() => {
    const onDelta = (e: Event) => {
      const detail = (e as CustomEvent<{ documentId: string; delta: ThumbStructuralDelta }>).detail;
      if (!detail || detail.documentId !== documentId) return;
      const versions = versionsRef.current;
      setBitmaps((prev) =>
        carryThumbCacheForDelta(prev, detail.delta, (slot) => versions[slot] ?? 0),
      );
    };
    window.addEventListener(PAGES_STRUCTURAL_DELTA_EVENT, onDelta);
    return () => window.removeEventListener(PAGES_STRUCTURAL_DELTA_EVENT, onDelta);
  }, [documentId]);

  const docJustCommitted = documentState?.document !== lastDocRef.current && pendingDropRef.current;
  const visibleBitmaps =
    docJustCommitted && pendingPermRef.current
      ? shuffleCache(pendingPermRef.current)(bitmaps)
      : bitmaps;
  const visibleActiveDragSet = docJustCommitted ? null : activeDragSet;
  const visibleDropIndex = docJustCommitted ? null : dropIndex;
  const visiblePageOrder = docJustCommitted ? null : pageOrder;

  const getCellOffset = useCallback(
    (pageIndex: number) => {
      if (!visibleActiveDragSet || visibleDropIndex == null) return ZERO_OFFSET;
      if (visibleActiveDragSet.includes(pageIndex)) return ZERO_OFFSET;
      const finalDrop =
        visibleDropIndex - visibleActiveDragSet.filter((i) => i < visibleDropIndex).length;
      const posAfterRemoval = pageIndex - visibleActiveDragSet.filter((i) => i < pageIndex).length;
      const effectiveIndex =
        posAfterRemoval >= finalDrop
          ? posAfterRemoval + visibleActiveDragSet.length
          : posAfterRemoval;
      return {
        x:
          ((effectiveIndex % columnCount) - (pageIndex % columnCount)) *
          (layout.cellWidth + COL_GAP),
        y:
          (Math.floor(effectiveIndex / columnCount) - Math.floor(pageIndex / columnCount)) *
          (layout.cellHeight + ROW_GAP),
      };
    },
    [visibleActiveDragSet, visibleDropIndex, layout.cellWidth, layout.cellHeight, columnCount],
  );

  const virtualRows = rowVirtualizer.getVirtualItems();
  const winFirstRow = virtualRows.length ? virtualRows[0]!.index : -1;
  const winLastRow = virtualRows.length ? virtualRows[virtualRows.length - 1]!.index : -1;

  useEffect(() => {
    if (docJustCommitted || pendingDropRef.current || activeDragSet) return;
    if (winFirstRow < 0) return;
    const pad = columnCount * 2;
    const lo = Math.max(0, winFirstRow * columnCount - pad);
    const hi = Math.min(totalPages - 1, (winLastRow + 1) * columnCount - 1 + pad);
    setBitmaps((prev) => {
      let next: Map<number, ThumbBitmapEntry> | null = null;
      for (const [k, entry] of prev) {
        if (k >= lo && k <= hi) continue;
        next ??= new Map(prev);
        URL.revokeObjectURL(entry.url);
        next.delete(k);
      }
      return next ?? prev;
    });
  }, [winFirstRow, winLastRow, columnCount, totalPages, docJustCommitted, activeDragSet]);

  const overlayPageIndex = activeDragSet?.[0] ?? null;
  const overlayCellPage =
    overlayPageIndex != null ? documentState?.document?.pages?.[overlayPageIndex] : null;

  return (
    <Dnd
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div ref={containerRef} class="relative min-h-0 flex-auto overflow-hidden">
        <div
          ref={setScrollParentEl}
          class="box-border h-full w-full overflow-y-auto pt-8 pb-12 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ paddingLeft: paddingX, paddingRight: paddingX }}
          onPointerDownCapture={(e) => {
            lastPointerTypeRef.current = e.pointerType;
          }}
          onClick={(e) => {
            if (e.target instanceof Element && !e.target.closest('[data-page-index]')) {
              clearSelection();
            }
          }}
        >
          <div class="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
            {virtualRows.map((virtualRow) => {
              const startPage = virtualRow.index * columnCount;
              const endPage = Math.min(startPage + columnCount, totalPages);
              return (
                <div
                  key={virtualRow.key}
                  class="absolute inset-x-0 top-0 flex flex-nowrap items-start justify-center"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: layout.cellHeight,
                    gap: `${COL_GAP}px`,
                  }}
                >
                  {Array.from({ length: endPage - startPage }, (_, i) => {
                    const pageIndex = startPage + i;
                    const sourceIdx = visiblePageOrder ? visiblePageOrder[pageIndex]! : pageIndex;
                    return (
                      <OrganizeCell
                        key={pageIndex}
                        pageIndex={pageIndex}
                        sourceIdx={sourceIdx}
                        documentId={documentId}
                        documentState={documentState}
                        canModifyContents={canModifyContents}
                        cellWidth={layout.cellWidth}
                        cellHeight={layout.cellHeight}
                        innerW={layout.innerW}
                        offset={getCellOffset(pageIndex)}
                        cellIsDragging={visibleActiveDragSet?.includes(pageIndex) ?? false}
                        anyDragActive={visibleActiveDragSet != null}
                        isSelected={selected.has(pageIndex)}
                        isLead={lead === pageIndex}
                        labelFor={labelFor}
                        bitmapEntry={visibleBitmaps.get(sourceIdx)}
                        setBitmap={setBitmap}
                        onClick={handleClick}
                        onDblClick={handleDoubleClick}
                        onContextMenu={handleCellContextMenu}
                        onMore={handleMoreClick}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <FadingScrollThumb scrollRef={scrollParentRef} />
      </div>
      <div
        ref={fixedProbeRef}
        aria-hidden="true"
        class="pointer-events-none invisible fixed top-0 left-0 h-0 w-0"
      />
      <Overlay dropAnimation={null} modifiers={overlayModifiers}>
        {overlayPageIndex != null && overlayCellPage ? (
          <div
            class="bg-bg-elevated pointer-events-none relative box-border flex scale-[1.04] cursor-grabbing flex-col items-center justify-center rounded-2xl shadow-md"
            style={{
              width: layout.cellWidth,
              height: layout.cellHeight,
              padding: `${THUMB_PADDING}px`,
              gap: `${INNER_GAP}px`,
            }}
          >
            <div
              class="flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white shadow-sm"
              style={{
                width: layout.innerW,
                height: visibleHeightFor(overlayCellPage, layout.innerW),
              }}
            >
              <OrganizeThumb
                documentId={documentId}
                pageIndex={overlayPageIndex}
                width={layout.innerW}
                entry={visibleBitmaps.get(overlayPageIndex)}
                setBitmap={setBitmap}
              />
            </div>
            <CellLabels
              label={labelFor(overlayPageIndex + 1)}
              sizeLabel={pageSizeLabel(overlayCellPage)}
            />
            {activeDragSet && activeDragSet.length > 1 && (
              <span class="bg-accent text-fg-on-accent absolute -top-2 -right-2 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold shadow-sm">
                {activeDragSet.length}
              </span>
            )}
          </div>
        ) : null}
      </Overlay>
    </Dnd>
  );
}

function CellLabels({ label, sizeLabel }: { label: string; sizeLabel: string | null }) {
  return (
    <div
      class="flex max-w-full shrink-0 flex-col items-center gap-0.5"
      style={{ height: LABEL_STACK_HEIGHT }}
    >
      <div
        class="text-fg-primary text-sm font-medium tabular-nums"
        style={{ height: LABEL_HEIGHT, lineHeight: `${LABEL_HEIGHT}px` }}
      >
        {label}
      </div>
      {sizeLabel != null && (
        <div
          class="text-fg-secondary max-w-full truncate text-xs tabular-nums"
          style={{ height: SIZE_LABEL_HEIGHT, lineHeight: `${SIZE_LABEL_HEIGHT}px` }}
        >
          {sizeLabel}
        </div>
      )}
    </div>
  );
}

interface OrganizeCellProps {
  pageIndex: number;
  sourceIdx: number;
  documentId: string;
  documentState: DocumentState;
  canModifyContents: boolean;
  cellWidth: number;
  cellHeight: number;
  innerW: number;
  offset: { x: number; y: number };
  cellIsDragging: boolean;
  anyDragActive: boolean;
  isSelected: boolean;
  isLead: boolean;
  labelFor: (pageOneBased: number) => string;
  bitmapEntry: ThumbBitmapEntry | undefined;
  setBitmap: (pageIndex: number, entry: ThumbBitmapEntry) => void;
  onClick: (e: MouseEvent) => void;
  onDblClick: (e: MouseEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
  onMore: (e: MouseEvent) => void;
}

const OrganizeCell = memo(function OrganizeCell({
  pageIndex,
  sourceIdx,
  documentId,
  documentState,
  canModifyContents,
  cellWidth,
  cellHeight,
  innerW,
  offset,
  cellIsDragging,
  anyDragActive,
  isSelected,
  isLead,
  labelFor,
  bitmapEntry,
  setBitmap,
  onClick,
  onDblClick,
  onContextMenu,
  onMore,
}: OrganizeCellProps) {
  const { setNodeRef, attributes, listeners } = useDraggable({
    id: `page-${pageIndex}`,
    disabled: !canModifyContents,
    data: { pageIndex },
  });

  const cellPage = documentState?.document?.pages?.[sourceIdx];

  const motion = cellIsDragging
    ? 'opacity-35 transition-none'
    : anyDragActive
      ? 'transition-[transform,background-color,box-shadow] duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)]'
      : 'transition-[background-color,box-shadow] duration-[90ms]';
  const ring =
    isSelected || isLead
      ? 'outline-accent outline-2 outline-offset-0'
      : 'focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2';

  return (
    <div class="group relative shrink-0" style={{ width: cellWidth, height: cellHeight }}>
      <button
        ref={setNodeRef}
        type="button"
        data-page-index={pageIndex}
        class={`hover:bg-interactive-hover box-border flex shrink-0 cursor-pointer touch-manipulation flex-col items-center justify-center rounded-2xl border-none select-none [-webkit-touch-callout:none] ${
          isSelected ? 'bg-interactive-selected' : 'bg-transparent'
        } ${motion} ${ring}`}
        style={{
          width: cellWidth,
          height: cellHeight,
          padding: `${THUMB_PADDING}px`,
          gap: `${INNER_GAP}px`,
          transform:
            offset.x !== 0 || offset.y !== 0
              ? `translate(${offset.x}px, ${offset.y}px)`
              : undefined,
        }}
        {...(attributes as unknown as Record<string, unknown>)}
        {...(listeners as unknown as Record<string, unknown>)}
        onClick={onClick}
        onDblClick={onDblClick}
        onContextMenu={onContextMenu}
        aria-pressed={isSelected}
        aria-label={`Page ${pageIndex + 1}`}
      >
        <div
          class="flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white shadow-sm"
          style={{ width: innerW, height: visibleHeightFor(cellPage, innerW) }}
        >
          <OrganizeThumb
            documentId={documentId}
            pageIndex={sourceIdx}
            width={innerW}
            entry={bitmapEntry}
            setBitmap={setBitmap}
          />
        </div>
        <CellLabels
          label={labelFor(sourceIdx + 1)}
          sizeLabel={cellPage ? pageSizeLabel(cellPage) : null}
        />
      </button>
      {!anyDragActive && (
        <button
          type="button"
          data-page-index={pageIndex}
          tabIndex={-1}
          aria-label={`Page ${pageIndex + 1} actions`}
          aria-haspopup="menu"
          onClick={onMore}
          class="absolute top-2 right-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-none bg-black/60 text-white opacity-0 backdrop-blur-md transition-opacity duration-150 group-hover:opacity-100 pointer-coarse:opacity-100"
        >
          <DotsThreeIcon size={16} weight="bold" />
        </button>
      )}
    </div>
  );
});

interface OrganizeThumbProps {
  documentId: string;
  pageIndex: number;
  width: number;
  entry: ThumbBitmapEntry | undefined;
  setBitmap: (pageIndex: number, entry: ThumbBitmapEntry) => void;
}

const OrganizeThumb = memo(function OrganizeThumb({
  documentId,
  pageIndex,
  width,
  entry,
  setBitmap,
}: OrganizeThumbProps) {
  const { provides: renderProvides } = useRenderCapability();
  const documentState = useDocumentState(documentId);
  const page = documentState?.document?.pages?.[pageIndex];
  const refreshVersion = documentState?.pageRefreshVersions?.[pageIndex] ?? 0;

  const uid = pageUid(page);
  const sig = thumbBitmapSig({
    uid,
    pageIndex,
    cellWidth: width,
    pageWidth: page?.size.width ?? 0,
    pageHeight: page?.size.height ?? 0,
    rotation: page?.rotation ?? 0,
    refreshVersion,
  });

  const cachedUrl = entry && entry.sig === sig ? entry.url : null;
  const displayUrl = pickThumbDisplayUrl({ entry, sig, pageUid: uid });

  useEffect(() => {
    if (cachedUrl) return;
    if (!renderProvides || !page || page.size.width <= 0) return;
    const visibleW = page.rotation % 2 === 1 ? page.size.height : page.size.width;
    const task = renderProvides.forDocument(documentId).renderPageRect({
      pageIndex,
      rect: { origin: { x: 0, y: 0 }, size: page.size },
      options: {
        scaleFactor: width / visibleW,
        dpr: window.devicePixelRatio || 1,
        rotation: page.rotation,
        withAnnotations: true,
      },
    });
    let cancelled = false;
    task.wait(
      (blob) => {
        if (cancelled) return;
        setBitmap(pageIndex, {
          url: URL.createObjectURL(blob),
          sig,
          uid: uid ?? `idx${pageIndex}`,
        });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      try {
        task.abort({ code: PdfErrorCode.Cancelled, message: 'unmount' });
      } catch {}
    };
  }, [
    cachedUrl,
    renderProvides,
    documentId,
    pageIndex,
    width,
    page?.size.width,
    page?.size.height,
    page?.rotation,
    refreshVersion,
    sig,
    setBitmap,
  ]);

  if (!displayUrl || !page) return null;
  const rotated = page.rotation % 2 === 1;
  const visibleW = rotated ? page.size.height : page.size.width;
  const visibleH = rotated ? page.size.width : page.size.height;
  const imgCssH = visibleH * (width / visibleW);
  return (
    <img
      src={displayUrl}
      alt={`Page ${pageIndex + 1}`}
      draggable={false}
      class="block max-h-none max-w-none"
      style={{ width, height: imgCssH }}
      width={width}
      height={imgCssH}
    />
  );
});
