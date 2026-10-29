import { useEffect, useRef } from 'preact/hooks';
import { useAnnotationCapability } from '@embedpdf/plugin-annotation/preact';
import { PdfAnnotationSubtype } from '@embedpdf/models';
import type { PdfAnnotationObject, LineEndings, Position } from '@embedpdf/models';

import { getPendingMode, type MeasurementMode } from './scale-store';
import { resolveMeasurementVisual } from './visual';
import {
  buildAreaChain,
  buildDistanceChain,
  buildMeasureDict,
  formatMeasurement,
} from './formatter';
import type { ScalePreset } from './types';
import { distance as segLen } from './geom';
import {
  annotationScale,
  firstPoint,
  scaleAt,
  scaledArea,
  scaledLength,
  type ScaleContext,
} from './scale-context';
import { clearLatestSnap, clearClickSnaps } from './snap-store';
interface Props {
  documentId: string;
}

const MODE_TO_INTENT: Record<MeasurementMode, string> = {
  distance: 'LineDimension',
  perimeter: 'PolyLineDimension',
  area: 'PolygonDimension',
};

const INTENT_TO_MODE: Record<string, MeasurementMode> = {
  LineDimension: 'distance',
  PolyLineDimension: 'perimeter',
  PolygonDimension: 'area',
};

const MODE_TO_SUBTYPE: Record<MeasurementMode, number> = {
  distance: PdfAnnotationSubtype.LINE,
  perimeter: PdfAnnotationSubtype.POLYLINE,
  area: PdfAnnotationSubtype.POLYGON,
};

const DEFAULT_DISTANCE_LEADER_LENGTH = 0;

interface Geometry {
  linePoints?: { start: Position; end: Position };
  vertices?: ReadonlyArray<Position>;
  lineEndings?: LineEndings;
  strokeWidth?: number;
  leaderLength?: number;
  contents?: string;
}

function captionFor(mode: MeasurementMode, geom: Geometry, ctx: ScaleContext): string {
  if (mode === 'distance' && geom.linePoints) {
    const len = scaledLength([geom.linePoints.start, geom.linePoints.end], ctx);
    return formatMeasurement(len, buildDistanceChain(ctx.preset));
  }
  if (mode === 'perimeter' && geom.vertices && geom.vertices.length >= 2) {
    return formatMeasurement(scaledLength(geom.vertices, ctx), buildDistanceChain(ctx.preset));
  }
  if (mode === 'area' && geom.vertices && geom.vertices.length >= 3) {
    return formatMeasurement(scaledArea(geom.vertices, ctx), buildAreaChain(ctx.preset));
  }
  return '';
}

export function MeasurementCreateListener({ documentId }: Props) {
  const { provides: capability } = useAnnotationCapability();
  const selfUpdatingRef = useRef<Set<string>>(new Set());
  const enrichedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!capability) return;
    const scope = capability.forDocument(documentId);

    const unsub = scope.onAnnotationEvent((event) => {
      if (event.type === 'create' && !event.committed) {
        const mode = getPendingMode(documentId);
        if (!mode) return;
        if (event.annotation.type !== MODE_TO_SUBTYPE[mode]) return;
        if (enrichedIdsRef.current.has(event.annotation.id)) return;

        if (mode === 'distance') {
          const lp = (event.annotation as unknown as Geometry).linePoints;
          if (lp && segLen(lp.start, lp.end) < 1) {
            const delId = event.annotation.id;
            const delPage = event.pageIndex;
            queueMicrotask(() => capability.deleteAnnotation(delPage, delId));
            return;
          }
        }

        const scale = scaleAt(
          documentId,
          event.pageIndex,
          firstPoint(event.annotation as unknown as Geometry),
        );
        const preset = scale.preset;
        const measure = buildMeasureDict(preset, scale.userUnit);
        const defaultLL = mode === 'distance' ? DEFAULT_DISTANCE_LEADER_LENGTH : 0;
        const incoming = event.annotation as unknown as Geometry;
        const visual = resolveMeasurementVisual(capability, mode);

        clearLatestSnap();
        clearClickSnaps();
        const snappedLinePoints = incoming.linePoints;
        const snappedVertices = incoming.vertices;

        const postPatchGeom: Geometry = {
          ...incoming,
          linePoints: snappedLinePoints,
          vertices: snappedVertices ? Array.from(snappedVertices) : undefined,
          strokeWidth: visual.style.strokeWidth,
          lineEndings: visual.lineEndings ?? incoming.lineEndings,
          leaderLength: defaultLL,
        };
        const contents = captionFor(mode, postPatchGeom, scale);

        const patch: Record<string, unknown> = {
          ...visual.style,
          intent: MODE_TO_INTENT[mode],
          measure,
          contents,
          leaderLength: defaultLL,
          embeddedPreset: preset,
        };
        if (snappedLinePoints && snappedLinePoints !== incoming.linePoints) {
          patch.linePoints = snappedLinePoints;
        }
        if (snappedVertices && snappedVertices !== incoming.vertices) {
          patch.vertices = snappedVertices;
        }
        if (visual.lineEndings) {
          patch.lineEndings = visual.lineEndings;
        }

        enrichedIdsRef.current.add(event.annotation.id);
        selfUpdatingRef.current.add(event.annotation.id);
        capability.updateAnnotation(
          event.pageIndex,
          event.annotation.id,
          patch as Partial<PdfAnnotationObject>,
          { amendPrevious: true },
        );
        queueMicrotask(() => {
          selfUpdatingRef.current.delete(event.annotation.id);
        });

        return;
      }

      if (event.type === 'update') {
        if (selfUpdatingRef.current.has(event.annotation.id)) return;
        const intent = (event.annotation as unknown as { intent?: string }).intent;
        if (!intent || !(intent in INTENT_TO_MODE)) return;
        const mode = INTENT_TO_MODE[intent]!;

        const patch = event.patch as Record<string, unknown>;
        const geomChanged =
          'linePoints' in patch ||
          'vertices' in patch ||
          'rect' in patch ||
          'leaderLength' in patch;
        if (!geomChanged) return;

        const scale = annotationScale(
          documentId,
          event.annotation as unknown as Geometry & {
            pageIndex: number;
            embeddedPreset?: ScalePreset;
            measureJson?: string;
          },
        );
        const geom = event.annotation as unknown as Geometry;
        const contents = captionFor(mode, geom, scale);
        const prevContents = (event.annotation as unknown as { contents?: string }).contents;
        if (contents === prevContents) return;

        selfUpdatingRef.current.add(event.annotation.id);
        capability.updateAnnotation(
          event.pageIndex,
          event.annotation.id,
          { contents } as Partial<PdfAnnotationObject>,
          { amendPrevious: true },
        );
        queueMicrotask(() => {
          selfUpdatingRef.current.delete(event.annotation.id);
        });
        return;
      }
    });

    return () => {
      unsub();
    };
  }, [capability, documentId]);

  return null;
}
