/** @jsxImportSource preact */
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useAnnotationCapability, useAnnotation } from '@embedpdf/plugin-annotation/preact';
import { useTranslations } from '@embedpdf/plugin-i18n/preact';
import { getSelectedAnnotations } from '@embedpdf/plugin-annotation';

import { EmptyState } from './annotation-sidebar/empty-state';
import { DynamicSidebar } from './annotation-sidebar/dynamic-sidebar';
import { ANNOTATION_PROPERTIES } from './annotation-sidebar/property-schema';
import { MeasurementScaleBadge } from './measurement-scale-badge';
import {
  getPendingMode,
  resolveMeasurementToolId,
  subscribePendingMode,
  type MeasurementMode,
} from '../measurement/scale-store';

/**
 * Map annotation subtypes to their translation keys for the sidebar title.
 * Values correspond to PdfAnnotationSubtype enum:
 * TEXT=1, LINK=2, FREETEXT=3, LINE=4, SQUARE=5, CIRCLE=6, POLYGON=7,
 * POLYLINE=8, HIGHLIGHT=9, UNDERLINE=10, SQUIGGLY=11, STRIKEOUT=12,
 * STAMP=13, CARET=14, INK=15
 */
const ANNOTATION_TYPE_KEYS: Record<number, string> = {
  1: 'annotation.text',
  3: 'annotation.freeText',
  4: 'annotation.line',
  5: 'annotation.square',
  6: 'annotation.circle',
  7: 'annotation.polygon',
  8: 'annotation.polyline',
  9: 'annotation.highlight',
  10: 'annotation.underline',
  11: 'annotation.squiggly',
  12: 'annotation.strikeout',
  13: 'annotation.stamp',
  14: 'annotation.caret',
  15: 'annotation.ink',
  28: 'annotation.redact',
};

const MEASUREMENT_TOOL_KEYS: Record<string, string> = {
  distance: 'annotation.distance',
  perimeter: 'annotation.perimeter',
  area: 'annotation.area',
};

function usePendingMeasurementMode(documentId: string): MeasurementMode | null {
  const [mode, setMode] = useState<MeasurementMode | null>(() => getPendingMode(documentId));
  useEffect(() => {
    setMode(getPendingMode(documentId));
    return subscribePendingMode(documentId, () => setMode(getPendingMode(documentId)));
  }, [documentId]);
  return mode;
}

export function AnnotationSidebar({ documentId }: { documentId: string }) {
  const { provides: annotationCapability } = useAnnotationCapability();
  const { provides: annotation, state } = useAnnotation(documentId);
  const { translate } = useTranslations(documentId);
  const pendingMode = usePendingMeasurementMode(documentId);

  if (!annotationCapability || !annotation) return null;

  const colorPresets = annotationCapability?.getColorPresets() ?? [];
  const selectedAnnotations = getSelectedAnnotations(state);
  const baseTool = annotation.getActiveTool();
  const measurementToolId = resolveMeasurementToolId(pendingMode, baseTool?.id ?? null);
  const activeTool =
    (measurementToolId && annotationCapability.getTool(measurementToolId)) || baseTool;
  const measurementKey =
    MEASUREMENT_TOOL_KEYS[
      (selectedAnnotations.length > 0
        ? annotation.findToolForAnnotation(selectedAnnotations[0].object)?.id
        : activeTool?.id) ?? ''
    ];

  // Determine mode
  const isEditing = selectedAnnotations.length > 0;
  const isMulti = selectedAnnotations.length > 1;

  // Compute title
  let title = '';
  if (isMulti) {
    // Multiple annotations selected
    title = translate('annotation.multiSelect', {
      params: { count: String(selectedAnnotations.length) },
    });
  } else if (isEditing) {
    // Single annotation selected
    const subtype = selectedAnnotations[0].object.type;
    const typeKey = measurementKey ?? ANNOTATION_TYPE_KEYS[subtype];
    const annotationType = typeKey ? translate(typeKey) : '';
    title = annotationType
      ? translate('annotation.styles', { params: { type: annotationType } })
      : '';
  } else if (activeTool) {
    // Tool defaults mode
    const subtype = activeTool.defaults.type;
    if (subtype !== undefined) {
      const typeKey = measurementKey ?? ANNOTATION_TYPE_KEYS[subtype];
      const annotationType = typeKey ? translate(typeKey) : '';
      title = annotationType
        ? translate('annotation.defaults', { params: { type: annotationType } })
        : '';
    }
  }

  // Check if we have properties to show
  const types = isEditing
    ? [...new Set(selectedAnnotations.map((a) => a.object.type))]
    : activeTool?.defaults.type !== undefined
      ? [activeTool.defaults.type]
      : [];

  const hasProperties =
    types.length > 0 && types.some((t) => (ANNOTATION_PROPERTIES[t]?.length ?? 0) > 0);

  // If nothing to show, display empty state
  if (!hasProperties && !isEditing && !activeTool) {
    return <EmptyState documentId={documentId} />;
  }

  return (
    <div class="h-full overflow-y-auto p-4">
      {title && <h2 class="text-md mb-4 font-medium">{title}</h2>}
      {measurementKey && <MeasurementScaleBadge documentId={documentId} />}
      <DynamicSidebar
        documentId={documentId}
        annotations={selectedAnnotations}
        activeTool={activeTool}
        colorPresets={colorPresets}
      />
    </div>
  );
}
