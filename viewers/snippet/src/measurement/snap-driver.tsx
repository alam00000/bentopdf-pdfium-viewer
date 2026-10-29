import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

import { useDocumentState } from '@embedpdf/core/preact';
import { usePointerHandlers } from '@embedpdf/plugin-interaction-manager/preact';

import {
  begin as snapBegin,
  end as snapEnd,
  snap as snapSnap,
  cacheMatches as snapCacheMatches,
  updateSettings as snapUpdateSettings,
  type SnapResult,
} from './snap-engine';
import { publishLoupe } from './loupe-bus';
import {
  setLatestSnap,
  getLatestSnap,
  clearLatestSnap,
  recordClickSnap,
  clearClickSnaps,
} from './snap-store';
import { setPageMeta, clearPageMeta } from './page-meta-registry';
import { getSnapSettings, subscribeSnapSettings } from './snap-settings';
import { getPendingMode, setActiveMeasurementDoc } from './scale-store';
import { getMeasurePointer, setMeasurePointer } from './measure-pointer';

interface Props {
  documentId: string;
  pageIndex: number;
}

const SNAP_RADIUS_CSS_PX = 8;

export function MeasurementSnapPageDriver({ documentId, pageIndex }: Props) {
  const { register } = usePointerHandlers({ documentId, pageIndex });

  const docState = useDocumentState(documentId);
  const docPage = docState?.document?.pages?.[pageIndex];
  const naturalSize = docPage?.size ?? { width: 0, height: 0 };
  const pageWidthPdf = naturalSize.width;
  const pageHeightPdf = naturalSize.height;
  const pageCssScale = docState?.scale ?? 1;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const pageElementRef = useRef<HTMLElement | null>(null);

  const gestureActive = useRef<boolean>(false);
  const lastSnapResult = useRef<SnapResult | null>(null);

  const pageCssScaleRef = useRef(pageCssScale);
  pageCssScaleRef.current = pageCssScale;

  useEffect(() => {
    const unsub = subscribeSnapSettings(documentId, () => {
      if (gestureActive.current) {
        snapUpdateSettings(getSnapSettings(documentId));
      }
    });
    return unsub;
  }, [documentId]);

  useEffect(() => {
    const isMeasureMode = (modeId: string) =>
      (modeId === 'line' || modeId === 'polyline' || modeId === 'polygon') &&
      getPendingMode(documentId) !== null;

    const applySnapToPos = (pos: { x: number; y: number }) => {
      runSnap(pos.x, pos.y);
      const s = getLatestSnap();
      if (s && s.pageIndex === pageIndex) {
        (pos as { x: number; y: number }).x = s.topDownX;
        (pos as { x: number; y: number }).y = s.topDownY;
      }
    };

    const unregister = register(
      {
        onHandlerActiveStart: (modeId) => {
          if (!isMeasureMode(modeId)) return;
          setActiveMeasurementDoc(documentId);
          clearClickSnaps();
          if (pageWidthPdf > 0 && pageHeightPdf > 0) {
            void snapBegin({
              documentId,
              pageIndex,
              pageMinX: 0,
              pageMinY: 0,
              pageMaxX: pageWidthPdf,
              pageMaxY: pageHeightPdf,
              settings: getSnapSettings(documentId),
            });
          }
        },
        onPointerDown: (pos, _evt, modeId) => {
          if (!isMeasureMode(modeId)) return;
          gestureActive.current = true;
          if (pageWidthPdf > 0 && pageHeightPdf > 0 && !snapCacheMatches(documentId, pageIndex)) {
            void snapBegin({
              documentId,
              pageIndex,
              pageMinX: 0,
              pageMinY: 0,
              pageMaxX: pageWidthPdf,
              pageMaxY: pageHeightPdf,
              settings: getSnapSettings(documentId),
            });
          }
          applySnapToPos(pos);
          if (modeId === 'line') {
            recordClickSnap();
          }
        },
        onPointerMove: (pos, _evt, modeId) => {
          if (!isMeasureMode(modeId)) return;
          applySnapToPos(pos);
          setMeasurePointer({ documentId, pageIndex, x: pos.x, y: pos.y });
        },
        onPointerUp: (pos, _evt, modeId) => {
          if (!isMeasureMode(modeId)) return;
          gestureActive.current = false;
          applySnapToPos(pos);
          if (modeId === 'line') {
            recordClickSnap();
          }
        },
        onClick: (pos, _evt, modeId) => {
          if (!isMeasureMode(modeId)) return;
          if (modeId === 'polyline' || modeId === 'polygon') {
            applySnapToPos(pos);
            recordClickSnap();
          }
        },
        onPointerCancel: (_pos, _evt, modeId) => {
          if (!isMeasureMode(modeId)) return;
          gestureActive.current = false;
          snapEnd();
          clearLatestSnap();
          clearClickSnaps();
          publishLoupe(null);
        },
        onPointerLeave: (_pos, _evt, modeId) => {
          if (!isMeasureMode(modeId)) return;
          clearLatestSnap();
          publishLoupe(null);
          const p = getMeasurePointer();
          if (p && p.documentId === documentId && p.pageIndex === pageIndex) {
            setMeasurePointer(null);
          }
        },
        onHandlerActiveEnd: (modeId) => {
          setMeasurePointer(null);
          if (!isMeasureMode(modeId)) return;
          snapEnd();
          clearLatestSnap();
          clearClickSnaps();
          publishLoupe(null);
        },
      },
      {},
    );
    return () => {
      if (typeof unregister === 'function') unregister();
    };
  }, [documentId, pageIndex, pageWidthPdf, pageHeightPdf, register]);

  function runSnap(pdfX: number, pdfYTopDown: number) {
    const pageCssScale = pageCssScaleRef.current;
    const pdfY = pageHeightPdf - pdfYTopDown;
    const radiusPdf = SNAP_RADIUS_CSS_PX / Math.max(pageCssScale, 0.001);
    const snap = snapSnap(documentId, pageIndex, pdfX, pdfY, radiusPdf);
    lastSnapResult.current = snap;
    if (snap) {
      setLatestSnap({
        documentId,
        pageIndex,
        kind: snap.kind,
        pdfX: snap.pdfX,
        pdfY: snap.pdfY,
        topDownX: snap.pdfX,
        topDownY: pageHeightPdf - snap.pdfY,
      });
    } else {
      clearLatestSnap();
    }

    const pageCssX = pdfX * pageCssScale;
    const pageCssY = pdfYTopDown * pageCssScale;
    publishLoupe({
      documentId,
      pageIndex,
      pdfX,
      pdfY,
      pageCssX,
      pageCssY,
      pageCssScale,
      snap: snap
        ? {
            kind: snap.kind,
            pdfX: snap.pdfX,
            pdfY: snap.pdfY,
            pageCssX: snap.pdfX * pageCssScale,
            pageCssY: (pageHeightPdf - snap.pdfY) * pageCssScale,
            label: snap.label,
          }
        : null,
    });
  }

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const pageEl = sentinel.parentElement as HTMLElement | null;
    if (!pageEl) return;
    pageElementRef.current = pageEl;
    pageEl.setAttribute('data-page-pdf-height', String(pageHeightPdf));
    pageEl.setAttribute('data-page-index', String(pageIndex));
    pageEl.setAttribute('data-document-id', documentId);
    return () => {
      pageEl.removeAttribute('data-page-pdf-height');
      pageEl.removeAttribute('data-page-index');
      pageEl.removeAttribute('data-document-id');
    };
  }, [documentId, pageIndex, pageHeightPdf]);

  useEffect(() => {
    setPageMeta(documentId, pageIndex, {
      pageWidthPdf,
      pageHeightPdf,
      pageCssScale,
    });
    return () => {
      clearPageMeta(documentId, pageIndex);
    };
  }, [documentId, pageIndex, pageWidthPdf, pageHeightPdf, pageCssScale]);

  return (
    <div
      ref={sentinelRef}
      data-measurement-snap-sentinel
      style={{ width: 0, height: 0, pointerEvents: 'none' }}
    />
  );
}
