import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useDocumentState } from '@embedpdf/core/preact';
import type { ImageDataLike } from '@embedpdf/models';

import { engineFor } from './engine-bridge';

import type { LoupeSnapshot } from './loupe-bus';
import { subscribeLoupe } from './loupe-bus';
import { useSnapSettings, type SnapKind } from './snap-settings';
import { LOUPE_COLORS } from './colors';

const LOUPE_SIZE = 160;
const MAGNIFICATION = 4;
const LOUPE_OFFSET = 24;
const GLYPH_HALF = 7;

const SNAP_COLOR = LOUPE_COLORS.snap;
const CROSSHAIR_COLOR = LOUPE_COLORS.crosshair;
const CROSSHAIR_SHADOW = LOUPE_COLORS.crosshairShadow;

export function pageCssToScreen(
  x: number,
  y: number,
  boxW: number,
  boxH: number,
  turns: number,
): { x: number; y: number } {
  switch (((turns % 4) + 4) % 4) {
    case 1:
      return { x: boxW - y, y: x };
    case 2:
      return { x: boxW - x, y: boxH - y };
    case 3:
      return { x: y, y: boxH - x };
    default:
      return { x, y };
  }
}

interface Props {
  documentId: string;
  resolvePageElement: (pageIndex: number) => HTMLElement | null;
}

export function Loupe({ documentId, resolvePageElement }: Props) {
  const snapSettings = useSnapSettings(documentId);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const coordsRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  const docState = useDocumentState(documentId);
  const docStateRef = useRef(docState);
  docStateRef.current = docState;
  const pageTurnsOf = (pageIndex: number): number => {
    const st = docStateRef.current;
    const page = st?.document?.pages?.[pageIndex];
    return ((((page?.rotation ?? 0) + (st?.rotation ?? 0)) % 4) + 4) % 4;
  };

  const latest = useRef<LoupeSnapshot | null>(null);
  const lastNativeKey = useRef<string>('');
  const rafHandle = useRef<number | null>(null);
  const inflight = useRef<boolean>(false);

  useEffect(() => {
    const unsub = subscribeLoupe((snap) => {
      if (snap && snap.documentId !== documentId) return;
      latest.current = snap;
      if (snap) {
        if (!mounted) setMounted(true);
      } else if (mounted) {
        setMounted(false);
      }
    });
    return () => {
      unsub();
      latest.current = null;
    };
  }, [documentId, mounted]);

  useEffect(() => {
    if (!mounted) return;

    const tick = () => {
      rafHandle.current = requestAnimationFrame(tick);
      const snap = latest.current;
      if (!snap) return;
      const root = rootRef.current;
      if (!root) return;

      const pageEl = resolvePageElement(snap.pageIndex);
      if (!pageEl) return;
      const pageRect = pageEl.getBoundingClientRect();
      const { x: onScreenX, y: onScreenY } = pageCssToScreen(
        snap.pageCssX,
        snap.pageCssY,
        pageRect.width,
        pageRect.height,
        pageTurnsOf(snap.pageIndex),
      );
      const cursorViewportX = pageRect.left + onScreenX;
      const cursorViewportY = pageRect.top + onScreenY;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const wantsLeft = cursorViewportX + LOUPE_OFFSET + LOUPE_SIZE > vw;
      const wantsAbove = cursorViewportY + LOUPE_OFFSET + LOUPE_SIZE > vh;
      const px = wantsLeft
        ? cursorViewportX - LOUPE_OFFSET - LOUPE_SIZE
        : cursorViewportX + LOUPE_OFFSET;
      const py = wantsAbove
        ? cursorViewportY - LOUPE_OFFSET - LOUPE_SIZE
        : cursorViewportY + LOUPE_OFFSET;
      root.style.transform = `translate3d(${px}px, ${py}px, 0)`;

      const targetX = snap.snap ? snap.snap.pdfX : snap.pdfX;
      const targetY = snap.snap ? snap.snap.pdfY : snap.pdfY;
      if (labelRef.current) {
        labelRef.current.textContent = snap.snap ? snap.snap.label : '';
        labelRef.current.style.opacity = snap.snap ? '1' : '0';
      }
      if (coordsRef.current) {
        coordsRef.current.textContent = `${targetX.toFixed(2)}, ${targetY.toFixed(2)}`;
      }

      drawOverlay(snap);

      maybeRenderNativeBitmap(snap);
    };

    rafHandle.current = requestAnimationFrame(tick);
    return () => {
      if (rafHandle.current !== null) {
        cancelAnimationFrame(rafHandle.current);
        rafHandle.current = null;
      }
    };
  }, [mounted, documentId, resolvePageElement]);

  function drawOverlay(snap: LoupeSnapshot): void {
    const cv = overlayRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(LOUPE_SIZE * dpr) || cv.height !== Math.round(LOUPE_SIZE * dpr)) {
      cv.width = Math.round(LOUPE_SIZE * dpr);
      cv.height = Math.round(LOUPE_SIZE * dpr);
      cv.style.width = LOUPE_SIZE + 'px';
      cv.style.height = LOUPE_SIZE + 'px';
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);

    const cx = LOUPE_SIZE / 2;
    const cy = LOUPE_SIZE / 2;
    drawCrosshair(ctx, cx, cy);

    if (snap.snap) {
      drawSnapGlyph(ctx, cx, cy, snap.snap.kind);
    }
  }

  function drawCrosshair(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = CROSSHAIR_SHADOW;
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy);
    ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx, cy - 14);
    ctx.lineTo(cx, cy + 14);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = CROSSHAIR_COLOR;
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy);
    ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx, cy - 14);
    ctx.lineTo(cx, cy + 14);
    ctx.stroke();
  }

  function drawSnapGlyph(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    kind: SnapKind,
  ): void {
    ctx.fillStyle = SNAP_COLOR;
    ctx.strokeStyle = SNAP_COLOR;
    ctx.lineWidth = 2;
    switch (kind) {
      case 'endpoint': {
        ctx.beginPath();
        ctx.arc(cx, cy, GLYPH_HALF, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'midpoint': {
        ctx.beginPath();
        ctx.moveTo(cx, cy - GLYPH_HALF);
        ctx.lineTo(cx + GLYPH_HALF, cy + GLYPH_HALF);
        ctx.lineTo(cx - GLYPH_HALF, cy + GLYPH_HALF);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'intersection': {
        ctx.beginPath();
        ctx.moveTo(cx - GLYPH_HALF, cy - GLYPH_HALF);
        ctx.lineTo(cx + GLYPH_HALF, cy + GLYPH_HALF);
        ctx.moveTo(cx - GLYPH_HALF, cy + GLYPH_HALF);
        ctx.lineTo(cx + GLYPH_HALF, cy - GLYPH_HALF);
        ctx.stroke();
        break;
      }
      case 'path': {
        ctx.fillRect(cx - GLYPH_HALF, cy - GLYPH_HALF, GLYPH_HALF * 2, GLYPH_HALF * 2);
        break;
      }
    }
  }

  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);

  function maybeRenderNativeBitmap(snap: LoupeSnapshot): void {
    if (inflight.current) return;
    const cv = canvasRef.current;
    if (!cv) return;

    const targetX = snap.snap ? snap.snap.pdfX : snap.pdfX;
    const targetY = snap.snap ? snap.snap.pdfY : snap.pdfY;
    const pageCssScale = snap.pageCssScale;
    if (pageCssScale <= 0) return;

    const csMag = pageCssScale * MAGNIFICATION;
    const keyX = Math.round(targetX * csMag);
    const keyY = Math.round(targetY * csMag);
    const turns = pageTurnsOf(snap.pageIndex);
    const key = `${snap.pageIndex}:${keyX},${keyY}:${csMag.toFixed(2)}:${turns}`;
    if (key === lastNativeKey.current) return;
    lastNativeKey.current = key;

    const target = engineFor(snap.documentId);
    const page = target?.doc.pages[snap.pageIndex];
    if (!target || !page) return;
    const pageHeightPdf = page.size.height;
    if (!Number.isFinite(pageHeightPdf) || pageHeightPdf <= 0) return;

    const regionPdf = LOUPE_SIZE / csMag;
    const halfPdf = regionPdf / 2;
    const targetTopDownY = pageHeightPdf - targetY;
    const regionX = targetX - halfPdf;
    const regionY = targetTopDownY - halfPdf;
    const dpr = window.devicePixelRatio || 1;

    inflight.current = true;
    void target.engine
      .renderPageRectRaw(
        target.doc,
        page,
        { origin: { x: regionX, y: regionY }, size: { width: regionPdf, height: regionPdf } },
        { scaleFactor: csMag, dpr, withAnnotations: true, withForms: true },
      )
      .toPromise()
      .then((rendered) => {
        inflight.current = false;
        if (latest.current === null) return;
        paintNativeIntoCanvas(rendered, turns);
      })
      .catch(() => {
        inflight.current = false;
      });
  }

  function paintNativeIntoCanvas(rendered: ImageDataLike, turns: number): void {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const targetCssSize = LOUPE_SIZE;
    const targetDevSize = Math.round(targetCssSize * dpr);
    if (cv.width !== targetDevSize || cv.height !== targetDevSize) {
      cv.width = targetDevSize;
      cv.height = targetDevSize;
      cv.style.width = targetCssSize + 'px';
      cv.style.height = targetCssSize + 'px';
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    let src = srcCanvasRef.current;
    if (!src) {
      src = document.createElement('canvas');
      srcCanvasRef.current = src;
    }
    if (src.width !== rendered.width) src.width = rendered.width;
    if (src.height !== rendered.height) src.height = rendered.height;
    const sctx = src.getContext('2d');
    if (!sctx) return;
    const id = sctx.createImageData(rendered.width, rendered.height);
    id.data.set(rendered.data);
    sctx.putImageData(id, 0, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (turns) {
      ctx.translate(targetDevSize / 2, targetDevSize / 2);
      ctx.rotate((turns * Math.PI) / 2);
      ctx.translate(-targetDevSize / 2, -targetDevSize / 2);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, rendered.width, rendered.height, 0, 0, targetDevSize, targetDevSize);
  }

  if (!mounted || !snapSettings.loupe) return null;
  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: LOUPE_SIZE,
        height: LOUPE_SIZE,
        pointerEvents: 'none',
        zIndex: 200,
        background: LOUPE_COLORS.panel,
        border: `2px solid ${LOUPE_COLORS.edge}`,
        borderRadius: '50%',
        boxShadow: LOUPE_COLORS.shadow,
        overflow: 'hidden',
        userSelect: 'none',
        willChange: 'transform',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      <canvas
        ref={overlayRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />
      <div
        ref={labelRef}
        style={{
          position: 'absolute',
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '2px 8px',
          font: '500 10px/1 ui-sans-serif, system-ui, sans-serif',
          color: LOUPE_COLORS.snapPillText,
          background: LOUPE_COLORS.snapPill,
          borderRadius: '10px',
          opacity: 0,
          transition: 'opacity 80ms ease',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      />
      <div
        ref={coordsRef}
        style={{
          position: 'absolute',
          bottom: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '2px 8px',
          font: '500 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
          color: LOUPE_COLORS.coordsText,
          background: LOUPE_COLORS.coordsPill,
          borderRadius: '10px',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      />
    </div>
  );
}
