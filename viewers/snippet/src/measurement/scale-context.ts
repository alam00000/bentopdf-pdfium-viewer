import type { Position } from '@embedpdf/models';

import type { MeasurementToolId, PreviewSnapshot, ScalePreset } from './types';
import { getActivePreset } from './scale-store';
import { getScaleAreas, getUserUnit, type ScaleArea } from './scale-areas';
import { presetFromMeasureJson } from './embedded-preset';
import { sameScale, verticalRatio } from './formatter';
import { getPageMeta } from './page-meta-registry';

export interface ScaleContext {
  preset: ScalePreset;
  userUnit: number;
  area: ScaleArea | null;
}

export function toUserSpace(
  documentId: string,
  pageIndex: number,
  point: Position,
): { x: number; y: number } | null {
  const meta = getPageMeta(documentId, pageIndex);
  if (!meta) return null;
  return { x: point.x, y: meta.pageHeightPdf - point.y };
}

export function toPageRect(
  documentId: string,
  pageIndex: number,
  box: { left: number; bottom: number; right: number; top: number },
  pageHeight?: number,
): { x: number; y: number; w: number; h: number } | null {
  const h = pageHeight ?? getPageMeta(documentId, pageIndex)?.pageHeightPdf;
  if (h == null) return null;
  return {
    x: box.left,
    y: h - box.top,
    w: box.right - box.left,
    h: box.top - box.bottom,
  };
}

export function toUserBox(
  documentId: string,
  pageIndex: number,
  rect: { x: number; y: number; w: number; h: number },
  pageHeight?: number,
): { left: number; bottom: number; right: number; top: number } | null {
  const h = pageHeight ?? getPageMeta(documentId, pageIndex)?.pageHeightPdf;
  if (h == null) return null;
  const top = h - rect.y;
  return {
    left: rect.x,
    bottom: top - rect.h,
    right: rect.x + rect.w,
    top,
  };
}

export function areaAt(
  documentId: string,
  pageIndex: number,
  point: Position | null | undefined,
): ScaleArea | null {
  if (!point) return null;
  const areas = getScaleAreas(documentId, pageIndex);
  if (areas.length === 0) return null;
  const p = toUserSpace(documentId, pageIndex, point);
  if (!p) return null;
  for (let i = areas.length - 1; i >= 0; i--) {
    const a = areas[i]!;
    if (p.x >= a.box.left && p.x <= a.box.right && p.y >= a.box.bottom && p.y <= a.box.top) {
      return a;
    }
  }
  return null;
}

export function scaleAt(
  documentId: string,
  pageIndex: number,
  point: Position | null | undefined,
): ScaleContext {
  const userUnit = getUserUnit(documentId, pageIndex);
  const area = areaAt(documentId, pageIndex, point);
  if (area?.kind === 'scale' && area.preset) {
    return { preset: area.preset, userUnit, area };
  }
  return { preset: getActivePreset(documentId), userUnit, area: null };
}

export function firstPoint(annotation: {
  linePoints?: { start: Position; end: Position };
  vertices?: ReadonlyArray<Position>;
}): Position | null {
  return annotation.linePoints?.start ?? annotation.vertices?.[0] ?? null;
}

export function ownScale(
  annotation: { embeddedPreset?: ScalePreset; measureJson?: string },
  userUnit: number,
): ScalePreset | null {
  return annotation.embeddedPreset ?? presetFromMeasureJson(annotation.measureJson, userUnit);
}

export function annotationScale(
  documentId: string,
  annotation: {
    pageIndex?: number;
    embeddedPreset?: ScalePreset;
    measureJson?: string;
    linePoints?: { start: Position; end: Position };
    vertices?: ReadonlyArray<Position>;
  },
): ScaleContext {
  const pageIndex = annotation.pageIndex ?? 0;
  const userUnit = getUserUnit(documentId, pageIndex);
  const at = scaleAt(documentId, pageIndex, firstPoint(annotation));
  const own = ownScale(annotation, userUnit);
  if (!own) return at;
  return {
    preset: own,
    userUnit,
    area: at.area && sameScale(own, at.preset) ? at.area : null,
  };
}

export function scaledDelta(dx: number, dy: number, ctx: ScaleContext): { dx: number; dy: number } {
  const uu = ctx.userUnit;
  return { dx: dx * uu, dy: dy * uu * verticalRatio(ctx.preset) };
}

export function scaledLength(points: ReadonlyArray<Position>, ctx: ScaleContext): number {
  const ry = verticalRatio(ctx.preset);
  const uu = ctx.userUnit;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = (points[i]!.x - points[i - 1]!.x) * uu;
    const dy = (points[i]!.y - points[i - 1]!.y) * uu * ry;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

export function scaledArea(points: ReadonlyArray<Position>, ctx: ScaleContext): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  const uu = ctx.userUnit;
  return (Math.abs(twice) / 2) * uu * uu * verticalRatio(ctx.preset);
}

export function measureSnapshot(
  toolId: MeasurementToolId,
  points: ReadonlyArray<Position>,
  ctx: ScaleContext,
): PreviewSnapshot | null {
  const base = {
    preset: ctx.preset,
    ...(ctx.area ? { areaName: ctx.area.name } : {}),
  };
  if (toolId === 'area') {
    if (points.length < 3) return null;
    return { toolId, rawPdfUnits: scaledArea(points, ctx), ...base };
  }
  if (points.length < 2) return null;
  if (toolId === 'perimeter') {
    return { toolId, rawPdfUnits: scaledLength(points, ctx), ...base };
  }
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const d = scaledDelta(b.x - a.x, b.y - a.y, ctx);
  return {
    toolId,
    rawPdfUnits: Math.sqrt(d.dx * d.dx + d.dy * d.dy),
    angleDeg: (Math.atan2(d.dy, d.dx) * 180) / Math.PI,
    deltaX: Math.abs(d.dx),
    deltaY: Math.abs(d.dy),
    ...base,
  };
}
