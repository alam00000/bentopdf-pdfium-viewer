import { h, Fragment } from 'preact';
import { pageQuarterTurns, screenDeltaToPage } from './rotation';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PdfAnnotationSubtype, PdfAnnotationLineEnding } from '@embedpdf/models';
import type {
  PdfAnnotationObject,
  PdfLineAnnoObject,
  PdfPolylineAnnoObject,
  PdfPolygonAnnoObject,
  Position,
  LineEndings,
} from '@embedpdf/models';
import {
  createRenderer,
  useAnnotationCapability,
  type AnnotationInteractionEvent,
} from '@embedpdf/plugin-annotation/preact';
import { resolveMeasurementVisual } from './visual';
import { DimensionEnds } from './dimension-ends';

import { buildAreaChain, buildDistanceChain, formatMeasurement } from './formatter';
import { bboxCenter, midpoint, polylineCaptionAnchor, type Point } from './geom';
import { publishPreview } from './preview-bus';
import { publishSelected } from './selection-bus';
import { getActiveMeasurementDoc, getAnyPendingMode } from './scale-store';
import {
  annotationScale,
  measureSnapshot,
  ownScale,
  scaleAt,
  scaledArea,
  scaledLength,
  type ScaleContext,
} from './scale-context';
import { ensureScaleAreas, subscribeScaleAreas } from './scale-areas';
import type { CaptionOffset, ScalePreset } from './types';
import { ANNOTATION_DEFAULTS, MEASUREMENT_COLORS } from './colors';
import { pinCursorOf } from './gesture-cursor';

function captionScaleFor(
  documentId: string | null,
  annotation: MeasureExtra & {
    pageIndex: number;
    linePoints?: { start: Point; end: Point };
    vertices?: ReadonlyArray<Point>;
  },
): ScaleContext | null {
  if (documentId) return annotationScale(documentId, annotation);
  const own = ownScale(annotation, 1);
  return own ? { preset: own, userUnit: 1, area: null } : null;
}

function liveDistanceCaption(
  ctx: ScaleContext | null,
  linePoints: { start: Point; end: Point },
): string {
  if (!ctx) return '';
  const len = scaledLength([linePoints.start, linePoints.end], ctx);
  return formatMeasurement(len, buildDistanceChain(ctx.preset));
}

function livePerimeterCaption(ctx: ScaleContext | null, vertices: ReadonlyArray<Point>): string {
  if (vertices.length < 2 || !ctx) return '';
  return formatMeasurement(scaledLength(vertices, ctx), buildDistanceChain(ctx.preset));
}

function liveAreaCaption(ctx: ScaleContext | null, vertices: ReadonlyArray<Point>): string {
  if (vertices.length < 3 || !ctx) return '';
  return formatMeasurement(scaledArea(vertices, ctx), buildAreaChain(ctx.preset));
}

function useScaleAreasVersion(documentId: string | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!documentId) return;
    ensureScaleAreas(documentId);
    return subscribeScaleAreas(documentId, () => setVersion((v) => v + 1));
  }, [documentId]);
  return version;
}

const CAPTION_FONT = 'Helvetica, Arial, sans-serif';
const CAPTION_FONT_SIZE_PT = 11;

type MeasureExtra = {
  intent?: string;
  contents?: string;
  captionOffset?: CaptionOffset;
  leaderLength?: number;
  embeddedPreset?: ScalePreset;
  measureJson?: string;
};

function hasMeasurementIntent(intent: string | undefined, want: string): boolean {
  return intent === want;
}

interface CaptionProps {
  anchor: Point;
  text: string;
  rotateDeg?: number;
  pageRotation?: number;
  color?: string;
}

function Caption({
  anchor,
  text,
  rotateDeg,
  pageRotation = 0,
  color = MEASUREMENT_COLORS.caption,
}: CaptionProps) {
  if (!text) return null;

  const angle = captionRotationDeg(rotateDeg, pageRotation);
  const baseTransform = `rotate(${angle.toFixed(2)} ${anchor.x.toFixed(2)} ${anchor.y.toFixed(2)})`;

  return (
    <text
      x={anchor.x}
      y={anchor.y + CAPTION_FONT_SIZE_PT * 0.32}
      textAnchor="middle"
      fontFamily={CAPTION_FONT}
      fontSize={CAPTION_FONT_SIZE_PT}
      fontWeight={600}
      fill={color}
      transform={baseTransform}
      style={{ userSelect: 'none', pointerEvents: 'none' }}
    >
      {text}
    </text>
  );
}

export function captionRotationDeg(alongDeg: number | undefined, pageRotation: number): number {
  const turn = Number.isFinite(pageRotation) ? (((Math.round(pageRotation) % 4) + 4) % 4) * 90 : 0;
  if (alongDeg === undefined || !Number.isFinite(alongDeg)) return turn === 0 ? 0 : -turn;
  let screen = ((((alongDeg + turn) % 360) + 540) % 360) - 180;
  if (screen > 90) screen -= 180;
  else if (screen < -90) screen += 180;
  const angle = screen - turn;
  return angle === 0 ? 0 : angle;
}

function captionWidthPdf(text: string): number {
  return text.length * CAPTION_FONT_SIZE_PT * 0.55;
}

const CAPTION_GAP_PAD = 4;
function captionGapHalf(text: string): number {
  if (!text) return 0;
  return captionWidthPdf(text) * 0.5 + CAPTION_GAP_PAD;
}

function shift(p: Point, origin: Position): Point {
  return { x: p.x - origin.x, y: p.y - origin.y };
}
function shiftAll(pts: ReadonlyArray<Position>, origin: Position): Point[] {
  return pts.map((p) => shift(p, origin));
}

function captionOffsetForDistance(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const m = midpoint(start, end);
  return { x: m.x + nx * 10, y: m.y + ny * 10 };
}

function useLeaderDrag({
  annotationId,
  documentId,
  pageIndex,
  nx,
  ny,
  scale,
  initialLL,
  previewLL,
  setPreviewLL,
  pageRotation,
}: {
  annotationId: string;
  documentId: string;
  pageIndex: number;
  nx: number;
  ny: number;
  scale: number;
  pageRotation: number;
  initialLL: number;
  previewLL: number | null;
  setPreviewLL: (v: number | null) => void;
}) {
  const { provides: capability } = useAnnotationCapability();
  const dragRef = useRef<{
    startClientX: number;
    startClientY: number;
    startLL: number;
  } | null>(null);

  const onPointerDown = (pe: PointerEvent) => {
    pe.stopPropagation();
    (pe.target as Element).setPointerCapture(pe.pointerId);
    pinCursorOf(pe.target as Element, pe.pointerId);
    dragRef.current = {
      startClientX: pe.clientX,
      startClientY: pe.clientY,
      startLL: previewLL ?? initialLL,
    };
  };
  const onPointerMove = (pe: PointerEvent) => {
    if (!dragRef.current) return;
    const moved = screenDeltaToPage(
      pe.clientX - dragRef.current.startClientX,
      pe.clientY - dragRef.current.startClientY,
      pageQuarterTurns(pageRotation),
    );
    const dxPdf = moved.dx / scale;
    const dyPdf = moved.dy / scale;
    const perpDelta = dxPdf * nx + dyPdf * ny;
    setPreviewLL(dragRef.current.startLL + perpDelta);
  };
  const onPointerUp = (pe: PointerEvent) => {
    if (!dragRef.current) return;
    try {
      (pe.target as Element).releasePointerCapture(pe.pointerId);
    } catch {}
    const finalLL = previewLL ?? dragRef.current.startLL;
    dragRef.current = null;
    if (capability && Math.abs(finalLL - initialLL) > 0.01) {
      capability.forDocument(documentId).updateAnnotation(pageIndex, annotationId, {
        leaderLength: finalLL,
      } as unknown as Partial<PdfAnnotationObject>);
    } else {
      setPreviewLL(null);
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp, isDragging: dragRef.current !== null };
}

function DistanceRender({
  annotation,
  scale,
  isSelected,
  onClick,
  documentId,
  pageIndex,
  pageRotation = 0,
}: {
  annotation: PdfLineAnnoObject & MeasureExtra;
  scale: number;
  isSelected: boolean;
  onClick?: (e: AnnotationInteractionEvent) => void;
  documentId: string;
  pageIndex: number;
  pageRotation?: number;
}) {
  const {
    rect,
    linePoints,
    strokeColor = ANNOTATION_DEFAULTS.measure,
    strokeWidth = 1.5,
    lineEndings,
    leaderLength: storedLL = 0,
    embeddedPreset,
  } = annotation;

  const [previewLL, setPreviewLL] = useState<number | null>(null);
  useEffect(() => {
    if (previewLL === null) return;
    if (Math.abs((storedLL ?? 0) - previewLL) < 0.01) setPreviewLL(null);
  }, [storedLL, previewLL]);
  const leaderLength = previewLL ?? storedLL;

  const sx = linePoints.start.x;
  const sy = linePoints.start.y;
  const ex = linePoints.end.x;
  const ey = linePoints.end.y;
  const areasVersion = useScaleAreasVersion(documentId);
  const scaleCtx = captionScaleFor(documentId, annotation);
  useEffect(() => {
    if (!isSelected || !scaleCtx) return;
    const snap = measureSnapshot('distance', [linePoints.start, linePoints.end], scaleCtx);
    if (snap) publishSelected(snap);
  }, [isSelected, sx, sy, ex, ey, embeddedPreset, annotation.measureJson, areasVersion]);
  const s = shift(linePoints.start, rect.origin);
  const e = shift(linePoints.end, rect.origin);

  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const segLength = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dy / segLength;
  const ny = -dx / segLength;

  const offS: Point = { x: s.x + nx * leaderLength, y: s.y + ny * leaderLength };
  const offE: Point = { x: e.x + nx * leaderLength, y: e.y + ny * leaderLength };

  const captionBase = midpoint(offS, offE);
  const captionText = liveDistanceCaption(scaleCtx, linePoints);

  const bodyDx = offE.x - offS.x;
  const bodyDy = offE.y - offS.y;
  const bodyLen = Math.sqrt(bodyDx * bodyDx + bodyDy * bodyDy) || 1;
  const ux = bodyDx / bodyLen;
  const uy = bodyDy / bodyLen;

  let captionAngleDeg = Math.atan2(bodyDy, bodyDx) * (180 / Math.PI);
  if (captionAngleDeg > 90) captionAngleDeg -= 180;
  else if (captionAngleDeg < -90) captionAngleDeg += 180;

  const gapHalf = captionGapHalf(captionText);
  const bodyHasGap = captionText.length > 0 && bodyLen > gapHalf * 2 + 4;
  const gapStart = bodyHasGap
    ? { x: captionBase.x - ux * gapHalf, y: captionBase.y - uy * gapHalf }
    : null;
  const gapEnd = bodyHasGap
    ? { x: captionBase.x + ux * gapHalf, y: captionBase.y + uy * gapHalf }
    : null;

  const width = rect.size.width * scale;
  const height = rect.size.height * scale;

  const effectiveEndings: LineEndings = lineEndings ?? {
    start: PdfAnnotationLineEnding.OpenArrow,
    end: PdfAnnotationLineEnding.OpenArrow,
  };

  const hitPointerEvents = onClick && !isSelected ? 'visibleStroke' : 'none';
  const hitStrokeWidth = Math.max(strokeWidth, 12 / Math.max(scale, 0.1));

  const leaderDrag = useLeaderDrag({
    annotationId: annotation.id,
    documentId,
    pageIndex,
    nx,
    ny,
    scale,
    initialLL: storedLL,
    previewLL,
    setPreviewLL,
    pageRotation,
  });

  return (
    <svg
      style={{
        position: 'absolute',
        width,
        height,
        pointerEvents: 'none',
        zIndex: 2,
        overflow: 'visible',
      }}
      width={width}
      height={height}
      viewBox={`0 0 ${rect.size.width} ${rect.size.height}`}
    >
      <line
        x1={offS.x}
        y1={offS.y}
        x2={offE.x}
        y2={offE.y}
        stroke="transparent"
        strokeWidth={hitStrokeWidth}
        onPointerDown={onClick}
        style={{
          pointerEvents: hitPointerEvents,
          cursor: isSelected ? 'move' : onClick ? 'pointer' : 'default',
          strokeLinecap: 'butt',
        }}
      />

      {bodyHasGap && gapStart && gapEnd ? (
        <>
          <line
            x1={offS.x}
            y1={offS.y}
            x2={gapStart.x}
            y2={gapStart.y}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none', strokeLinecap: 'butt' }}
          />
          <line
            x1={gapEnd.x}
            y1={gapEnd.y}
            x2={offE.x}
            y2={offE.y}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none', strokeLinecap: 'butt' }}
          />
        </>
      ) : (
        <line
          x1={offS.x}
          y1={offS.y}
          x2={offE.x}
          y2={offE.y}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'none', strokeLinecap: 'butt' }}
        />
      )}

      {Math.abs(leaderLength) > 0.01 && (
        <>
          <line
            x1={s.x}
            y1={s.y}
            x2={offS.x}
            y2={offS.y}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none', strokeLinecap: 'butt' }}
          />
          <line
            x1={e.x}
            y1={e.y}
            x2={offE.x}
            y2={offE.y}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none', strokeLinecap: 'butt' }}
          />
        </>
      )}

      <DimensionEnds
        a={offS}
        b={offE}
        endings={effectiveEndings}
        strokeWidth={strokeWidth}
        color={strokeColor}
      />

      <Caption
        anchor={captionBase}
        text={captionText}
        rotateDeg={captionAngleDeg}
        pageRotation={pageRotation}
      />

      {isSelected && (
        <circle
          cx={(offS.x + offE.x) / 2}
          cy={(offS.y + offE.y) / 2}
          r={12 / Math.max(scale, 0.1)}
          fill="transparent"
          onPointerDown={leaderDrag.onPointerDown}
          onPointerMove={leaderDrag.onPointerMove}
          onPointerUp={leaderDrag.onPointerUp}
          onPointerCancel={leaderDrag.onPointerUp}
          style={{ cursor: 'ns-resize', pointerEvents: 'all' }}
        />
      )}
    </svg>
  );
}

function PerimeterRender({
  annotation,
  scale,
  isSelected,
  onClick,
  documentId,
  pageRotation = 0,
}: {
  annotation: PdfPolylineAnnoObject & MeasureExtra;
  scale: number;
  isSelected: boolean;
  onClick?: (e: AnnotationInteractionEvent) => void;
  documentId: string;
  pageRotation?: number;
}) {
  const {
    rect,
    vertices,
    strokeColor = ANNOTATION_DEFAULTS.measure,
    strokeWidth = 1.5,
    embeddedPreset,
  } = annotation;

  const vertexKey = vertices.map((v) => `${v.x},${v.y}`).join('|');
  const areasVersion = useScaleAreasVersion(documentId);
  const scaleCtx = captionScaleFor(documentId, annotation);
  useEffect(() => {
    if (!isSelected || !scaleCtx) return;
    const snap = measureSnapshot('perimeter', vertices, scaleCtx);
    if (snap) publishSelected(snap);
  }, [isSelected, vertexKey, embeddedPreset, annotation.measureJson, areasVersion]);
  const localPts = shiftAll(vertices, rect.origin);
  const anchor = polylineCaptionAnchor(localPts, 12);
  const width = rect.size.width * scale;
  const height = rect.size.height * scale;

  const pointsAttr = localPts.map((p) => `${p.x},${p.y}`).join(' ');
  const hitPointerEvents = onClick && !isSelected ? 'visibleStroke' : 'none';
  const hitStrokeWidth = Math.max(strokeWidth, 12 / Math.max(scale, 0.1));

  return (
    <svg
      style={{
        position: 'absolute',
        width,
        height,
        pointerEvents: 'none',
        zIndex: 2,
        overflow: 'visible',
      }}
      width={width}
      height={height}
      viewBox={`0 0 ${rect.size.width} ${rect.size.height}`}
    >
      <polyline
        points={pointsAttr}
        fill="none"
        stroke="transparent"
        strokeWidth={hitStrokeWidth}
        onPointerDown={onClick}
        style={{
          pointerEvents: hitPointerEvents,
          cursor: isSelected ? 'move' : onClick ? 'pointer' : 'default',
        }}
      />
      <polyline
        points={pointsAttr}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        style={{ pointerEvents: 'none' }}
      />
      <Caption
        anchor={anchor}
        text={livePerimeterCaption(scaleCtx, vertices)}
        pageRotation={pageRotation}
      />
    </svg>
  );
}

function AreaRender({
  annotation,
  scale,
  isSelected,
  onClick,
  documentId,
  pageRotation = 0,
}: {
  annotation: PdfPolygonAnnoObject & MeasureExtra;
  scale: number;
  isSelected: boolean;
  onClick?: (e: AnnotationInteractionEvent) => void;
  documentId: string;
  pageRotation?: number;
}) {
  const {
    rect,
    vertices,
    strokeColor = ANNOTATION_DEFAULTS.measure,
    strokeWidth = 1.5,
    color: fill = 'transparent',
    opacity = 1,
    embeddedPreset,
  } = annotation;

  const vertexKey = vertices.map((v) => `${v.x},${v.y}`).join('|');
  const areasVersion = useScaleAreasVersion(documentId);
  const scaleCtx = captionScaleFor(documentId, annotation);
  useEffect(() => {
    if (!isSelected || !scaleCtx) return;
    const snap = measureSnapshot('area', vertices, scaleCtx);
    if (snap) publishSelected(snap);
  }, [isSelected, vertexKey, embeddedPreset, annotation.measureJson, areasVersion]);
  const localPts = shiftAll(vertices, rect.origin);
  const anchor = bboxCenter(localPts);
  const width = rect.size.width * scale;
  const height = rect.size.height * scale;
  const pointsAttr = localPts.map((p) => `${p.x},${p.y}`).join(' ');
  const hitPointerEvents = onClick && !isSelected ? 'visibleStroke' : 'none';
  const hitStrokeWidth = Math.max(strokeWidth, 12 / Math.max(scale, 0.1));

  return (
    <svg
      style={{
        position: 'absolute',
        width,
        height,
        pointerEvents: 'none',
        zIndex: 2,
        overflow: 'visible',
      }}
      width={width}
      height={height}
      viewBox={`0 0 ${rect.size.width} ${rect.size.height}`}
    >
      <polygon
        points={pointsAttr}
        fill="transparent"
        stroke="transparent"
        strokeWidth={hitStrokeWidth}
        onPointerDown={onClick}
        style={{
          pointerEvents: hitPointerEvents,
          cursor: isSelected ? 'move' : onClick ? 'pointer' : 'default',
        }}
      />
      <polygon
        points={pointsAttr}
        fill={fill === 'transparent' ? 'none' : fill}
        fillOpacity={opacity}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        style={{ pointerEvents: 'none' }}
      />
      <Caption
        anchor={anchor}
        text={liveAreaCaption(scaleCtx, vertices)}
        pageRotation={pageRotation}
      />
    </svg>
  );
}

function previewScale(
  documentId: string,
  pageIndex: number | undefined,
  first: Position | undefined,
): ScaleContext {
  return scaleAt(documentId, pageIndex ?? -1, pageIndex == null ? null : first);
}

function PreviewDistance({
  data,
  scale,
  documentId,
  pageIndex,
  pageRotation = 0,
}: {
  data: {
    rect: { origin: Position; size: { width: number; height: number } };
    linePoints: { start: Position; end: Position };
    strokeColor?: string;
    strokeWidth?: number;
  };
  scale: number;
  documentId: string;
  pageIndex: number | undefined;
  pageRotation?: number;
}) {
  const { provides: capability } = useAnnotationCapability();
  const areasVersion = useScaleAreasVersion(documentId);
  const scaleCtx = previewScale(documentId, pageIndex, data.linePoints.start);
  const preset = scaleCtx.preset;
  const { rect, linePoints } = data;
  const { style: visual, lineEndings: previewEndings } = resolveMeasurementVisual(
    capability,
    'distance',
  );
  const { strokeColor, strokeWidth } = visual;
  const s = shift(linePoints.start, rect.origin);
  const e = shift(linePoints.end, rect.origin);
  const captionAnchor = captionOffsetForDistance(s, e);
  const snap = measureSnapshot('distance', [linePoints.start, linePoints.end], scaleCtx);
  const len = snap?.rawPdfUnits ?? 0;
  const text = formatMeasurement(len, buildDistanceChain(preset));

  useEffect(() => {
    publishPreview(snap);
  }, [len, snap?.angleDeg, snap?.deltaX, snap?.deltaY, preset, scaleCtx.area, areasVersion]);
  useEffect(() => () => publishPreview(null), []);

  const width = rect.size.width * scale;
  const height = rect.size.height * scale;
  return (
    <svg
      style={{ position: 'absolute', width, height, overflow: 'visible' }}
      width={width}
      height={height}
      viewBox={`0 0 ${rect.size.width} ${rect.size.height}`}
    >
      <line
        x1={s.x}
        y1={s.y}
        x2={e.x}
        y2={e.y}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
        style={{ strokeLinecap: 'butt' }}
      />
      <DimensionEnds
        a={s}
        b={e}
        endings={previewEndings}
        strokeWidth={strokeWidth}
        color={strokeColor}
      />
      <Caption anchor={captionAnchor} text={text} pageRotation={pageRotation} />
    </svg>
  );
}

function PreviewPerimeter({
  data,
  scale,
  documentId,
  pageIndex,
  pageRotation = 0,
}: {
  data: {
    rect: { origin: Position; size: { width: number; height: number } };
    vertices: Position[];
    currentVertex: Position;
    strokeColor?: string;
    strokeWidth?: number;
  };
  scale: number;
  documentId: string;
  pageIndex: number | undefined;
  pageRotation?: number;
}) {
  const { provides: capability } = useAnnotationCapability();
  const areasVersion = useScaleAreasVersion(documentId);
  const scaleCtx = previewScale(documentId, pageIndex, data.vertices[0] ?? data.currentVertex);
  const preset = scaleCtx.preset;
  const { rect, vertices, currentVertex } = data;
  const { strokeColor, strokeWidth } = resolveMeasurementVisual(capability, 'perimeter').style;
  const allPts: Position[] = [...vertices, currentVertex];
  const local = shiftAll(allPts, rect.origin);
  const anchor = polylineCaptionAnchor(local, 12);
  const snap = measureSnapshot('perimeter', allPts, scaleCtx);
  const len = snap?.rawPdfUnits ?? 0;
  const text = formatMeasurement(len, buildDistanceChain(preset));

  useEffect(() => {
    publishPreview(snap);
  }, [len, preset, scaleCtx.area, areasVersion]);
  useEffect(() => () => publishPreview(null), []);

  const width = rect.size.width * scale;
  const height = rect.size.height * scale;
  const pointsAttr = local.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <svg
      style={{ position: 'absolute', width, height, overflow: 'visible' }}
      width={width}
      height={height}
      viewBox={`0 0 ${rect.size.width} ${rect.size.height}`}
    >
      <polyline points={pointsAttr} fill="none" stroke={strokeColor} strokeWidth={strokeWidth} />
      <Caption anchor={anchor} text={text} pageRotation={pageRotation} />
    </svg>
  );
}

function PreviewArea({
  data,
  scale,
  documentId,
  pageIndex,
  pageRotation = 0,
}: {
  data: {
    rect: { origin: Position; size: { width: number; height: number } };
    vertices: Position[];
    currentVertex: Position;
    strokeColor?: string;
    strokeWidth?: number;
    color?: string;
    opacity?: number;
  };
  scale: number;
  documentId: string;
  pageIndex: number | undefined;
  pageRotation?: number;
}) {
  const { provides: capability } = useAnnotationCapability();
  const areasVersion = useScaleAreasVersion(documentId);
  const scaleCtx = previewScale(documentId, pageIndex, data.vertices[0] ?? data.currentVertex);
  const preset = scaleCtx.preset;
  const { rect, vertices, currentVertex } = data;
  const {
    strokeColor,
    strokeWidth,
    color: fill,
    opacity,
  } = resolveMeasurementVisual(capability, 'area').style;
  const allPts: Position[] = [...vertices, currentVertex];
  const local = shiftAll(allPts, rect.origin);
  const anchor = bboxCenter(local);
  const snap = measureSnapshot('area', allPts, scaleCtx) ?? {
    toolId: 'area' as const,
    rawPdfUnits: 0,
    preset,
    ...(scaleCtx.area ? { areaName: scaleCtx.area.name } : {}),
  };
  const area = snap.rawPdfUnits;
  const text = formatMeasurement(area, buildAreaChain(preset));

  useEffect(() => {
    publishPreview(snap);
  }, [area, preset, scaleCtx.area, areasVersion]);
  useEffect(() => () => publishPreview(null), []);

  const width = rect.size.width * scale;
  const height = rect.size.height * scale;
  const pointsAttr = local.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <svg
      style={{ position: 'absolute', width, height, overflow: 'visible' }}
      width={width}
      height={height}
      viewBox={`0 0 ${rect.size.width} ${rect.size.height}`}
    >
      <polygon
        points={pointsAttr}
        fill={fill === 'transparent' ? MEASUREMENT_COLORS.areaPreviewFill : fill}
        fillOpacity={opacity}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
      />
      <Caption anchor={anchor} text={text} pageRotation={pageRotation} />
    </svg>
  );
}

export function buildMeasurementRenderers(documentId: string) {
  return [
    createRenderer<PdfLineAnnoObject>({
      id: 'measurement-distance',
      matches: (a): a is PdfLineAnnoObject =>
        a.type === PdfAnnotationSubtype.LINE &&
        hasMeasurementIntent((a as unknown as MeasureExtra).intent, 'LineDimension'),
      matchesPreview: (p) =>
        p.type === PdfAnnotationSubtype.LINE && getAnyPendingMode() === 'distance',
      render: ({
        currentObject,
        scale,
        isSelected,
        onClick,
        pageIndex,
        documentId: docId,
        pageRotation,
      }) => (
        <DistanceRender
          annotation={currentObject as unknown as PdfLineAnnoObject & MeasureExtra}
          scale={scale}
          isSelected={isSelected}
          onClick={onClick}
          pageRotation={pageRotation}
          pageIndex={pageIndex}
          documentId={docId}
        />
      ),
      renderPreview: ({ data, scale, pageRotation, pageIndex }) => (
        <PreviewDistance
          data={data as Parameters<typeof PreviewDistance>[0]['data']}
          scale={scale}
          documentId={documentId}
          pageIndex={pageIndex}
          pageRotation={pageRotation}
        />
      ),
      vertexConfig: {
        extractVertices: (a) => [a.linePoints.start, a.linePoints.end],
        transformAnnotation: (a, v) => ({
          ...a,
          linePoints: { start: v[0]!, end: v[1]! },
        }),
      },
      containerStyle: () =>
        ({
          zIndex: 11,
        }) as ReturnType<
          NonNullable<Parameters<typeof createRenderer<PdfLineAnnoObject>>[0]['containerStyle']>
        >,
      interactionDefaults: { isDraggable: true, isResizable: false, isRotatable: false },
      useAppearanceStream: false,
    }),

    createRenderer<PdfPolylineAnnoObject>({
      id: 'measurement-perimeter',
      matches: (a): a is PdfPolylineAnnoObject =>
        a.type === PdfAnnotationSubtype.POLYLINE &&
        hasMeasurementIntent((a as unknown as MeasureExtra).intent, 'PolyLineDimension'),
      matchesPreview: (p) =>
        p.type === PdfAnnotationSubtype.POLYLINE && getAnyPendingMode() === 'perimeter',
      render: ({ currentObject, scale, isSelected, onClick, documentId: docId, pageRotation }) => (
        <PerimeterRender
          annotation={currentObject as unknown as PdfPolylineAnnoObject & MeasureExtra}
          scale={scale}
          isSelected={isSelected}
          onClick={onClick}
          documentId={docId}
          pageRotation={pageRotation}
        />
      ),
      renderPreview: ({ data, scale, pageRotation, pageIndex }) => (
        <PreviewPerimeter
          data={data as Parameters<typeof PreviewPerimeter>[0]['data']}
          scale={scale}
          documentId={documentId}
          pageIndex={pageIndex}
          pageRotation={pageRotation}
        />
      ),
      vertexConfig: {
        extractVertices: (a) => a.vertices,
        transformAnnotation: (a, vertices) => ({ ...a, vertices }),
      },
      interactionDefaults: { isDraggable: true, isResizable: false, isRotatable: false },
      useAppearanceStream: false,
    }),

    createRenderer<PdfPolygonAnnoObject>({
      id: 'measurement-area',
      matches: (a): a is PdfPolygonAnnoObject =>
        a.type === PdfAnnotationSubtype.POLYGON &&
        hasMeasurementIntent((a as unknown as MeasureExtra).intent, 'PolygonDimension'),
      matchesPreview: (p) =>
        p.type === PdfAnnotationSubtype.POLYGON && getAnyPendingMode() === 'area',
      render: ({ currentObject, scale, isSelected, onClick, documentId: docId, pageRotation }) => (
        <AreaRender
          annotation={currentObject as unknown as PdfPolygonAnnoObject & MeasureExtra}
          scale={scale}
          isSelected={isSelected}
          onClick={onClick}
          documentId={docId}
          pageRotation={pageRotation}
        />
      ),
      renderPreview: ({ data, scale, pageRotation, pageIndex }) => (
        <PreviewArea
          data={data as Parameters<typeof PreviewArea>[0]['data']}
          scale={scale}
          documentId={documentId}
          pageIndex={pageIndex}
          pageRotation={pageRotation}
        />
      ),
      vertexConfig: {
        extractVertices: (a) => a.vertices,
        transformAnnotation: (a, vertices) => ({ ...a, vertices }),
      },
      interactionDefaults: { isDraggable: true, isResizable: false, isRotatable: false },
      useAppearanceStream: false,
    }),
  ];
}
