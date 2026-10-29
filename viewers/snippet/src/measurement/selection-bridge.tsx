import { useEffect, useMemo, useState } from 'preact/hooks';
import { useAnnotation } from '@embedpdf/plugin-annotation/preact';
import { getSelectedAnnotations } from '@embedpdf/plugin-annotation';
import { PdfAnnotationSubtype } from '@embedpdf/models';
import type {
  PdfLineAnnoObject,
  PdfPolylineAnnoObject,
  PdfPolygonAnnoObject,
} from '@embedpdf/models';

import { publishSelected } from './selection-bus';
import { setActiveMeasurementDoc } from './scale-store';
import { begin as snapBegin } from './snap-engine';
import { getSnapSettings } from './snap-settings';
import { getPageMeta } from './page-meta-registry';
import { annotationScale, measureSnapshot } from './scale-context';
import { ensureScaleAreas, subscribeScaleAreas } from './scale-areas';
import type { MeasurementToolId, PreviewSnapshot, ScalePreset } from './types';

interface Props {
  documentId: string;
}

const INTENT_TO_TOOL: Record<string, MeasurementToolId> = {
  LineDimension: 'distance',
  PolyLineDimension: 'perimeter',
  PolygonDimension: 'area',
};

type MeasurementAnnotation = (PdfLineAnnoObject | PdfPolylineAnnoObject | PdfPolygonAnnoObject) & {
  intent?: string;
  embeddedPreset?: ScalePreset;
  measureJson?: string;
};

function snapshotFor(documentId: string, ann: MeasurementAnnotation): PreviewSnapshot | null {
  const intent = ann.intent;
  if (!intent || !(intent in INTENT_TO_TOOL)) return null;
  const toolId = INTENT_TO_TOOL[intent]!;
  const scale = annotationScale(documentId, ann);
  if (toolId === 'distance' && ann.type === PdfAnnotationSubtype.LINE) {
    return measureSnapshot(toolId, [ann.linePoints.start, ann.linePoints.end], scale);
  }
  if (toolId === 'perimeter' && ann.type === PdfAnnotationSubtype.POLYLINE) {
    return measureSnapshot(toolId, ann.vertices, scale);
  }
  if (toolId === 'area' && ann.type === PdfAnnotationSubtype.POLYGON) {
    return measureSnapshot(toolId, ann.vertices, scale);
  }
  return null;
}

export function MeasurementSelectionBridge({ documentId }: Props) {
  const { state } = useAnnotation(documentId);
  const selected = useMemo(() => getSelectedAnnotations(state), [state]);
  const [areasVersion, setAreasVersion] = useState(0);
  useEffect(
    () => subscribeScaleAreas(documentId, () => setAreasVersion((v) => v + 1)),
    [documentId],
  );

  useEffect(() => {
    if (selected.length !== 1) {
      publishSelected(null);
      return;
    }
    const ann = selected[0]!.object as MeasurementAnnotation;
    if (ann.intent && ann.intent in INTENT_TO_TOOL) ensureScaleAreas(documentId);
    publishSelected(snapshotFor(documentId, ann));
  }, [selected, documentId, areasVersion]);

  useEffect(() => {
    if (selected.length !== 1) return;
    const ann = selected[0]!.object as MeasurementAnnotation;

    if (!ann.intent || !(ann.intent in INTENT_TO_TOOL)) return;
    setActiveMeasurementDoc(documentId);
    const pageMeta = getPageMeta(documentId, ann.pageIndex);
    if (!pageMeta) return;
    void snapBegin({
      documentId,
      pageIndex: ann.pageIndex,
      pageMinX: 0,
      pageMinY: 0,
      pageMaxX: pageMeta.pageWidthPdf,
      pageMaxY: pageMeta.pageHeightPdf,
      settings: getSnapSettings(documentId),
    });
  }, [selected, documentId]);

  useEffect(() => () => publishSelected(null), []);

  return null;
}
