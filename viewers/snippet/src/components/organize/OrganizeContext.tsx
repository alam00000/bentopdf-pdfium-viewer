import { h, ComponentChildren, createContext } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useScrollCapability } from '@embedpdf/plugin-scroll/preact';

import {
  PAGES_REORDERED_EVENT,
  type PagesReorderedDetail,
  remapPageIndex,
  remapPageIndexSet,
} from '@/hooks/use-reorder-side-effects';

export const ORGANIZE_TOGGLE_EVENT = 'bentopdf:organize:toggle';
export const ORGANIZE_SET_EVENT = 'bentopdf:organize:set';
export const ORGANIZE_INSERT_FILES_EVENT = 'bentopdf:organize:insert-files';

export function dispatchOrganizeToggle(documentId?: string) {
  window.dispatchEvent(new CustomEvent(ORGANIZE_TOGGLE_EVENT, { detail: { documentId } }));
}

export function dispatchOrganizeSet(open: boolean, documentId?: string) {
  window.dispatchEvent(new CustomEvent(ORGANIZE_SET_EVENT, { detail: { open, documentId } }));
}

export interface OrganizeContextValue {
  isOrganizeMode: boolean;
  standalone: boolean;
  setMode: (open: boolean) => void;
  selected: ReadonlySet<number>;
  anchor: number | null;
  lead: number | null;
  toggleSelected: (pageIndex: number) => void;
  replaceSelection: (indices: number[], anchor?: number | null) => void;
  rangeSelect: (pageIndex: number, pivot?: number) => void;
  clearSelection: () => void;
  isDragActive: boolean;
  setDragActive: (active: boolean) => void;
  isMultiSelect: boolean;
}

const OrganizeContext = createContext<OrganizeContextValue | null>(null);

export function useOrganizeContext(): OrganizeContextValue {
  const ctx = useContext(OrganizeContext);
  if (!ctx) {
    throw new Error('useOrganizeContext must be used inside <OrganizeProvider>');
  }
  return ctx;
}

function eventDetail(e: Event): { documentId?: unknown; open?: unknown } | undefined {
  const detail = e instanceof CustomEvent ? e.detail : undefined;
  return detail && typeof detail === 'object' ? detail : undefined;
}

export function OrganizeProvider({
  documentId,
  standalone = false,
  children,
}: {
  documentId: string;
  standalone?: boolean;
  children: ComponentChildren;
}) {
  const [organizeOpen, setIsOrganizeMode] = useState(standalone);
  const isOrganizeMode = standalone || organizeOpen;
  const isOrganizeModeRef = useRef(isOrganizeMode);
  isOrganizeModeRef.current = isOrganizeMode;

  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const selectedRef = useRef<ReadonlySet<number>>(selected);
  selectedRef.current = selected;
  const [anchor, setAnchorState] = useState<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  anchorRef.current = anchor;
  const [isDragActive, setIsDragActive] = useState(false);
  const [lead, setLeadState] = useState<number | null>(null);

  useEffect(() => {
    setSelected(new Set());
    setAnchorState(null);
    setLeadState(null);
  }, [documentId]);

  useEffect(() => {
    const onReorder = (e: Event) => {
      const detail = (e as CustomEvent<PagesReorderedDetail>).detail;
      if (!detail || detail.documentId !== documentId) return;
      setSelected((prev) => (prev.size === 0 ? prev : remapPageIndexSet(prev, detail.oldToNew)));
      setAnchorState((prev) => remapPageIndex(prev, detail.oldToNew));
      setLeadState((prev) => remapPageIndex(prev, detail.oldToNew));
    };
    window.addEventListener(PAGES_REORDERED_EVENT, onReorder);
    return () => window.removeEventListener(PAGES_REORDERED_EVENT, onReorder);
  }, [documentId]);

  useEffect(() => {
    if (standalone) return;
    const matchesDoc = (detail: { documentId?: unknown } | undefined): boolean =>
      detail?.documentId == null || detail.documentId === documentId;
    const onToggle = (e: Event) => {
      if (!matchesDoc(eventDetail(e))) return;
      setIsOrganizeMode(!isOrganizeModeRef.current);
    };
    const onSet = (e: Event) => {
      const detail = eventDetail(e);
      if (!matchesDoc(detail) || typeof detail?.open !== 'boolean') return;
      setIsOrganizeMode(detail.open);
    };
    window.addEventListener(ORGANIZE_TOGGLE_EVENT, onToggle);
    window.addEventListener(ORGANIZE_SET_EVENT, onSet);
    return () => {
      window.removeEventListener(ORGANIZE_TOGGLE_EVENT, onToggle);
      window.removeEventListener(ORGANIZE_SET_EVENT, onSet);
    };
  }, [documentId, standalone]);

  const { provides: scrollCap } = useScrollCapability();
  const scrollCapRef = useRef(scrollCap);
  scrollCapRef.current = scrollCap;
  useEffect(() => {
    let initialIndex: number | null = null;
    const cap = scrollCapRef.current;
    if (isOrganizeMode && !standalone && cap) {
      try {
        const cur = cap.forDocument(documentId).getCurrentPage();
        if (typeof cur === 'number' && cur >= 1) initialIndex = cur - 1;
      } catch {
        initialIndex = null;
      }
    }
    setSelected(initialIndex == null ? new Set() : new Set([initialIndex]));
    setAnchorState(initialIndex);
    setLeadState(initialIndex);
  }, [isOrganizeMode, documentId, standalone]);

  const setMode = useCallback(
    (open: boolean) => {
      if (!standalone) setIsOrganizeMode(open);
    },
    [standalone],
  );

  const toggleSelected = useCallback((pageIndex: number) => {
    const cur = selectedRef.current;
    const wasSelected = cur.has(pageIndex);
    const next = new Set(cur);
    if (wasSelected) next.delete(pageIndex);
    else next.add(pageIndex);
    setSelected(next);
    setAnchorState(pageIndex);
    if (wasSelected) setLeadState(next.size > 0 ? Math.max(...next) : null);
    else setLeadState(pageIndex);
  }, []);

  const setDragActive = useCallback((active: boolean) => {
    setIsDragActive(active);
  }, []);

  const replaceSelection = useCallback((indices: number[], nextAnchor: number | null = null) => {
    setSelected(new Set(indices));
    const a = nextAnchor ?? (indices.length > 0 ? indices[0]! : null);
    setAnchorState(a);
    setLeadState(a);
  }, []);

  const rangeSelect = useCallback((pageIndex: number, pivot?: number) => {
    const start = pivot ?? anchorRef.current ?? pageIndex;
    const lo = Math.min(start, pageIndex);
    const hi = Math.max(start, pageIndex);
    const next = new Set<number>();
    for (let i = lo; i <= hi; i++) next.add(i);
    setSelected(next);
    if (pivot != null) {
      anchorRef.current = pivot;
      setAnchorState(pivot);
    }
    setLeadState(pageIndex);
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAnchorState(null);
    setLeadState(null);
  }, []);

  const value = useMemo<OrganizeContextValue>(
    () => ({
      isOrganizeMode,
      standalone,
      setMode,
      selected,
      anchor,
      lead,
      toggleSelected,
      replaceSelection,
      rangeSelect,
      clearSelection,
      isDragActive,
      setDragActive,
      isMultiSelect: selected.size > 1,
    }),
    [
      isOrganizeMode,
      standalone,
      setMode,
      selected,
      anchor,
      lead,
      toggleSelected,
      replaceSelection,
      rangeSelect,
      clearSelection,
      isDragActive,
      setDragActive,
    ],
  );

  return <OrganizeContext.Provider value={value}>{children}</OrganizeContext.Provider>;
}
