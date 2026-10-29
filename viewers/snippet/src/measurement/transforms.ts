import { patching } from '@embedpdf/plugin-annotation';
import type {
  PdfAnnotationObject,
  PdfLineAnnoObject,
  PdfPolylineAnnoObject,
  PdfPolygonAnnoObject,
  Position,
  Rect,
} from '@embedpdf/models';

import { buildAreaChain, buildDistanceChain, formatMeasurement } from './formatter';
import { getActiveMeasurementDoc } from './scale-store';
import {
  annotationScale,
  ownScale,
  scaledArea,
  scaledLength,
  type ScaleContext,
} from './scale-context';
import type { ScalePreset } from './types';
import { snap as snapSnap, type SnapResult } from './snap-engine';
import { getSnapSettings } from './snap-settings';
import { getPageMeta } from './page-meta-registry';
import { publishLoupe } from './loupe-bus';

const VERTEX_EDIT_SNAP_RADIUS_CSS_PX = 8;

function applyVertexEditSnap(documentId: string, pageIndex: number, p: Position): Position | null {
  const meta = getPageMeta(documentId, pageIndex);
  if (!meta) return null;
  if (!getSnapSettings(documentId).enabled) {
    publishLoupe(null);
    return null;
  }
  const pdfX = p.x;
  const pdfY = meta.pageHeightPdf - p.y;
  const radiusPdf = VERTEX_EDIT_SNAP_RADIUS_CSS_PX / Math.max(meta.pageCssScale, 0.001);
  const result: SnapResult | null = snapSnap(documentId, pageIndex, pdfX, pdfY, radiusPdf);

  publishLoupe({
    documentId,
    pageIndex,
    pdfX,
    pdfY,
    pageCssX: p.x * meta.pageCssScale,
    pageCssY: p.y * meta.pageCssScale,
    pageCssScale: meta.pageCssScale,
    snap: result
      ? {
          kind: result.kind,
          pdfX: result.pdfX,
          pdfY: result.pdfY,
          pageCssX: result.pdfX * meta.pageCssScale,
          pageCssY: (meta.pageHeightPdf - result.pdfY) * meta.pageCssScale,
          label: result.label,
        }
      : null,
  });

  if (!result) return null;
  return {
    x: result.pdfX,
    y: meta.pageHeightPdf - result.pdfY,
  };
}

function snapEditedVertices(
  documentId: string,
  pageIndex: number,
  origVertices: ReadonlyArray<Position>,
  newVertices: ReadonlyArray<Position>,
  hintIndex: number | undefined,
): ReadonlyArray<Position> {
  let snappedAny = false;
  const out: Position[] = newVertices.map((v, i) => {
    const orig = origVertices[i];
    const moved =
      !orig || Math.abs(v.x - orig.x) > 1e-6 || Math.abs(v.y - orig.y) > 1e-6 || i === hintIndex;
    if (!moved) return v;
    const snapped = applyVertexEditSnap(documentId, pageIndex, v);
    if (snapped) {
      snappedAny = true;
      return snapped;
    }
    return v;
  });
  return snappedAny ? out : newVertices;
}

type PatchContext<A extends PdfAnnotationObject> = Parameters<typeof patching.patchLine>[1] & {
  changes: Partial<A>;
};

interface MeasureExtra {
  contents?: string;
  intent?: string;
  leaderLength?: number;
}

type ScaledAnnotation = {
  pageIndex: number;
  embeddedPreset?: ScalePreset;
  measureJson?: string;
  linePoints?: { start: Position; end: Position };
  vertices?: ReadonlyArray<Position>;
};

function scaleForAnnotation(orig: ScaledAnnotation): ScaleContext | null {
  const docId = getActiveMeasurementDoc();
  if (docId) return annotationScale(docId, orig);
  const own = ownScale(orig, 1);
  return own ? { preset: own, userUnit: 1, area: null } : null;
}

function withPatchedScale<T extends ScaledAnnotation>(orig: T, changes: unknown): T {
  const c = (changes ?? {}) as { embeddedPreset?: ScalePreset; measureJson?: string };
  const out: T = { ...orig };
  if ('embeddedPreset' in c) out.embeddedPreset = c.embeddedPreset;
  if ('measureJson' in c) out.measureJson = c.measureJson;
  return out;
}

function recomputeDistanceContents(orig: ScaledAnnotation, start: Position, end: Position): string {
  const ctx = scaleForAnnotation({ ...orig, linePoints: { start, end } });
  if (!ctx) return '';
  return formatMeasurement(scaledLength([start, end], ctx), buildDistanceChain(ctx.preset));
}

function recomputePerimeterContents(
  orig: ScaledAnnotation,
  vertices: ReadonlyArray<Position>,
): string {
  if (vertices.length < 2) return '';
  const ctx = scaleForAnnotation({ ...orig, vertices });
  if (!ctx) return '';
  return formatMeasurement(scaledLength(vertices, ctx), buildDistanceChain(ctx.preset));
}

function recomputeAreaContents(orig: ScaledAnnotation, vertices: ReadonlyArray<Position>): string {
  if (vertices.length < 3) return '';
  const ctx = scaleForAnnotation({ ...orig, vertices });
  if (!ctx) return '';
  return formatMeasurement(scaledArea(vertices, ctx), buildAreaChain(ctx.preset));
}

export const DIMENSION_TICK_HALF = 4;

function computeDistanceRect(
  linePoints: { start: Position; end: Position },
  leaderLength: number,
  strokeWidth: number,
  lineEndings: PdfLineAnnoObject['lineEndings'],
): Rect {
  const { start, end } = linePoints;
  const baseRect = patching.lineRectWithEndings([start, end], strokeWidth, lineEndings);

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const L = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dy / L;
  const ny = -dx / L;

  let minX = baseRect.origin.x;
  let minY = baseRect.origin.y;
  let maxX = baseRect.origin.x + baseRect.size.width;
  let maxY = baseRect.origin.y + baseRect.size.height;

  if (leaderLength) {
    const offS: Position = {
      x: start.x + nx * leaderLength,
      y: start.y + ny * leaderLength,
    };
    const offE: Position = {
      x: end.x + nx * leaderLength,
      y: end.y + ny * leaderLength,
    };
    const offsetRect = patching.lineRectWithEndings([offS, offE], strokeWidth, lineEndings);
    minX = Math.min(minX, offsetRect.origin.x);
    minY = Math.min(minY, offsetRect.origin.y);
    maxX = Math.max(maxX, offsetRect.origin.x + offsetRect.size.width);
    maxY = Math.max(maxY, offsetRect.origin.y + offsetRect.size.height);
  }

  const padX = Math.abs(nx) * DIMENSION_TICK_HALF;
  const padY = Math.abs(ny) * DIMENSION_TICK_HALF;
  return {
    origin: { x: minX - padX, y: minY - padY },
    size: { width: maxX - minX + 2 * padX, height: maxY - minY + 2 * padY },
  };
}

export const distanceTransform = (
  orig: PdfLineAnnoObject,
  ctx: PatchContext<PdfLineAnnoObject>,
): Partial<PdfLineAnnoObject> & MeasureExtra => {
  let workingCtx = ctx;
  if (ctx.type === 'vertex-edit') {
    const newLp = (ctx.changes as Partial<PdfLineAnnoObject>).linePoints;
    if (newLp && orig.linePoints) {
      const docId = getActiveMeasurementDoc();
      const startMoved =
        Math.abs(newLp.start.x - orig.linePoints.start.x) > 1e-6 ||
        Math.abs(newLp.start.y - orig.linePoints.start.y) > 1e-6;
      const endMoved =
        Math.abs(newLp.end.x - orig.linePoints.end.x) > 1e-6 ||
        Math.abs(newLp.end.y - orig.linePoints.end.y) > 1e-6;
      let snappedStart = newLp.start;
      let snappedEnd = newLp.end;
      if (docId && startMoved) {
        snappedStart = applyVertexEditSnap(docId, orig.pageIndex, newLp.start) ?? newLp.start;
      }
      if (docId && endMoved) {
        snappedEnd = applyVertexEditSnap(docId, orig.pageIndex, newLp.end) ?? newLp.end;
      }
      if (snappedStart !== newLp.start || snappedEnd !== newLp.end) {
        workingCtx = {
          ...ctx,
          changes: {
            ...ctx.changes,
            linePoints: { start: snappedStart, end: snappedEnd },
          },
        };
      }
    }
  }

  const base = patching.patchLine(orig, workingCtx) as Partial<PdfLineAnnoObject> & {
    leaderLength?: number;
  };
  const lp = base.linePoints ?? orig.linePoints;
  if (!lp) return base as Partial<PdfLineAnnoObject> & MeasureExtra;

  const contents = recomputeDistanceContents(
    withPatchedScale(orig as PdfLineAnnoObject & ScaledAnnotation, ctx.changes),
    lp.start,
    lp.end,
  );

  const strokeWidth = base.strokeWidth ?? orig.strokeWidth;
  const lineEndings = base.lineEndings ?? orig.lineEndings;
  const leaderLength =
    base.leaderLength ??
    (ctx.changes as { leaderLength?: number }).leaderLength ??
    (orig as PdfLineAnnoObject & { leaderLength?: number }).leaderLength ??
    0;

  const result = { ...base, contents } as Partial<PdfLineAnnoObject> & MeasureExtra;

  const llInThisPatch = (ctx.changes as { leaderLength?: number }).leaderLength !== undefined;
  if (base.rect || llInThisPatch) {
    const expanded = computeDistanceRect(lp, leaderLength, strokeWidth, lineEndings);
    result.rect = expanded;
    if (orig.unrotatedRect || base.unrotatedRect) {
      result.unrotatedRect = expanded;
    }
  }

  return result;
};

export const perimeterTransform = (
  orig: PdfPolylineAnnoObject,
  ctx: PatchContext<PdfPolylineAnnoObject>,
): Partial<PdfPolylineAnnoObject> & MeasureExtra => {
  let workingCtx = ctx;
  if (ctx.type === 'vertex-edit') {
    const newVertices = (ctx.changes as Partial<PdfPolylineAnnoObject>).vertices;
    if (newVertices && orig.vertices) {
      const docId = getActiveMeasurementDoc();
      if (docId) {
        const hintIndex = (ctx as { metadata?: { vertexIndex?: number } }).metadata?.vertexIndex;
        const snapped = snapEditedVertices(
          docId,
          orig.pageIndex,
          orig.vertices,
          newVertices,
          hintIndex,
        );
        if (snapped !== newVertices) {
          workingCtx = {
            ...ctx,
            changes: { ...ctx.changes, vertices: snapped as Position[] },
          };
        }
      }
    }
  }

  const base = patching.patchPolyline(orig, workingCtx) as Partial<PdfPolylineAnnoObject>;
  const vertices = base.vertices ?? orig.vertices;
  if (!vertices || vertices.length < 2) {
    return base as Partial<PdfPolylineAnnoObject> & MeasureExtra;
  }
  const contents = recomputePerimeterContents(
    withPatchedScale(orig as PdfPolylineAnnoObject & ScaledAnnotation, ctx.changes),
    vertices,
  );
  return { ...base, contents } as Partial<PdfPolylineAnnoObject> & MeasureExtra;
};

export const areaTransform = (
  orig: PdfPolygonAnnoObject,
  ctx: PatchContext<PdfPolygonAnnoObject>,
): Partial<PdfPolygonAnnoObject> & MeasureExtra => {
  let workingCtx = ctx;
  if (ctx.type === 'vertex-edit') {
    const newVertices = (ctx.changes as Partial<PdfPolygonAnnoObject>).vertices;
    if (newVertices && orig.vertices) {
      const docId = getActiveMeasurementDoc();
      if (docId) {
        const hintIndex = (ctx as { metadata?: { vertexIndex?: number } }).metadata?.vertexIndex;
        const snapped = snapEditedVertices(
          docId,
          orig.pageIndex,
          orig.vertices,
          newVertices,
          hintIndex,
        );
        if (snapped !== newVertices) {
          workingCtx = {
            ...ctx,
            changes: { ...ctx.changes, vertices: snapped as Position[] },
          };
        }
      }
    }
  }

  const base = patching.patchPolygon(orig, workingCtx) as Partial<PdfPolygonAnnoObject>;
  const vertices = base.vertices ?? orig.vertices;
  if (!vertices || vertices.length < 3) {
    return base as Partial<PdfPolygonAnnoObject> & MeasureExtra;
  }
  const contents = recomputeAreaContents(
    withPatchedScale(orig as PdfPolygonAnnoObject & ScaledAnnotation, ctx.changes),
    vertices,
  );
  return { ...base, contents } as Partial<PdfPolygonAnnoObject> & MeasureExtra;
};
