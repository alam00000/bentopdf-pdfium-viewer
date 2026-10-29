import { PdfAnnotationLineEnding } from '@embedpdf/models';
import type { LineEndings } from '@embedpdf/models';

import type { MeasurementMode } from './scale-store';
import { ANNOTATION_DEFAULTS } from './colors';

export interface MeasurementVisual {
  style: {
    strokeColor: string;
    strokeWidth: number;
    opacity: number;
    color: string;
  };
  lineEndings?: LineEndings;
}

const FALLBACK_STYLE = {
  strokeColor: ANNOTATION_DEFAULTS.measure,
  strokeWidth: 1.5,
  opacity: 1,
  color: 'transparent',
} as const;

const FALLBACK_DISTANCE_LINE_ENDINGS: LineEndings = {
  start: PdfAnnotationLineEnding.OpenArrow,
  end: PdfAnnotationLineEnding.OpenArrow,
};

export interface MeasurementToolLookup {
  getTool: (toolId: string) => { defaults?: Record<string, unknown> } | undefined;
}

export function resolveMeasurementVisual(
  tools: MeasurementToolLookup | null | undefined,
  mode: MeasurementMode,
): MeasurementVisual {
  const d = tools?.getTool(mode)?.defaults as
    | Partial<MeasurementVisual['style'] & { lineEndings: LineEndings }>
    | undefined;

  return {
    style: {
      strokeColor: d?.strokeColor ?? FALLBACK_STYLE.strokeColor,
      strokeWidth: d?.strokeWidth ?? FALLBACK_STYLE.strokeWidth,
      opacity: d?.opacity ?? FALLBACK_STYLE.opacity,
      color: d?.color ?? FALLBACK_STYLE.color,
    },
    ...(mode === 'distance'
      ? { lineEndings: d?.lineEndings ?? FALLBACK_DISTANCE_LINE_ENDINGS }
      : {}),
  };
}
