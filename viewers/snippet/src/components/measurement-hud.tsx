import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import {
  buildAreaChain,
  buildDistanceChain,
  buildScaleRatio,
  formatMeasurement,
} from '../measurement/formatter';
import { getMeasurePointer, subscribeMeasurePointer } from '../measurement/measure-pointer';
import { subscribePreview, getPreview } from '../measurement/preview-bus';
import { subscribeAnyScaleAreas, type ScaleArea } from '../measurement/scale-areas';
import { areaAt } from '../measurement/scale-context';
import {
  getActiveMeasurementDoc,
  getActivePreset,
  getAnyPendingMode,
  subscribeAnyPendingMode,
  type MeasurementMode,
} from '../measurement/scale-store';
import { subscribeSelected, getSelected } from '../measurement/selection-bus';
import type { PreviewSnapshot } from '../measurement/types';
import { FloatingMenu } from './ds/floating';

const MODE_LABEL: Record<PreviewSnapshot['toolId'], string> = {
  distance: 'Distance',
  perimeter: 'Perimeter',
  area: 'Area',
};

function useHoverArea(): ScaleArea | null {
  const read = () => {
    const p = getMeasurePointer();
    const area = p ? areaAt(p.documentId, p.pageIndex, p) : null;
    return area?.kind === 'scale' ? area : null;
  };
  const [area, setArea] = useState(read);
  useEffect(() => {
    const update = () => setArea(read());
    update();
    const offPointer = subscribeMeasurePointer(update);
    const offAreas = subscribeAnyScaleAreas(update);
    return () => {
      offPointer();
      offAreas();
    };
  }, []);
  return area;
}

function precisionLabel(p: number): string {
  if (p >= 1) return String(p);
  return p.toString();
}

export function MeasurementHud() {
  const [snap, setSnap] = useState<PreviewSnapshot | null>(() => getPreview());
  const [selectedSnap, setSelectedSnap] = useState<PreviewSnapshot | null>(() => getSelected());
  const [armedMode, setArmedMode] = useState<MeasurementMode | null>(() => getAnyPendingMode());
  const hoverArea = useHoverArea();

  useEffect(() => {
    const unsubPreview = subscribePreview(setSnap);
    const unsubSelected = subscribeSelected(setSelectedSnap);
    const unsubMode = subscribeAnyPendingMode(() => {
      setArmedMode(getAnyPendingMode());
    });
    return () => {
      unsubPreview();
      unsubSelected();
      unsubMode();
    };
  }, []);

  if (!armedMode) return null;

  let toolId: PreviewSnapshot['toolId'];
  let rawPdfUnits: number;
  let angleDeg: number | undefined;
  let deltaX: number | undefined;
  let deltaY: number | undefined;
  let preset: PreviewSnapshot['preset'];
  let areaName: string | undefined;

  if (snap) {
    ({ toolId, rawPdfUnits, angleDeg, deltaX, deltaY, preset, areaName } = snap);
  } else if (selectedSnap) {
    ({ toolId, rawPdfUnits, angleDeg, deltaX, deltaY, preset, areaName } = selectedSnap);
  } else {
    toolId = armedMode;
    rawPdfUnits = 0;
    const docId = getActiveMeasurementDoc();
    if (!docId) return null;
    if (hoverArea?.preset) {
      preset = hoverArea.preset;
      areaName = hoverArea.name;
    } else {
      preset = getActivePreset(docId);
    }
  }

  const distanceChain = buildDistanceChain(preset);
  const areaChain = buildAreaChain(preset);

  const primaryText =
    toolId === 'area'
      ? formatMeasurement(rawPdfUnits, areaChain)
      : formatMeasurement(rawPdfUnits, distanceChain);

  const scaleRatio = buildScaleRatio(preset);
  const precText = precisionLabel(preset.precision);

  return (
    <FloatingMenu hud="bottom-start" passive aria-label="Measurement">
      <div class="text-fg-primary min-w-[230px] px-[9px] py-[7px] font-mono text-sm">
        <div class="border-border-subtle mb-2 flex items-baseline justify-between border-b pb-1.5">
          <strong class="text-fg-secondary text-xs font-semibold tracking-[0.04em]">
            {MODE_LABEL[toolId].toUpperCase()}
          </strong>
        </div>

        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <span class="text-fg-secondary">{MODE_LABEL[toolId]}:</span>
          <span class="text-right font-semibold">{primaryText}</span>

          {toolId === 'distance' && angleDeg !== undefined && (
            <>
              <span class="text-fg-secondary">Angle:</span>
              <span class="text-right">{angleDeg.toFixed(1)}°</span>
            </>
          )}

          {toolId === 'distance' && deltaX !== undefined && deltaY !== undefined && (
            <>
              <span class="text-fg-secondary">ΔX:</span>
              <span class="text-right">{formatMeasurement(deltaX, distanceChain)}</span>
              <span class="text-fg-secondary">ΔY:</span>
              <span class="text-right">{formatMeasurement(deltaY, distanceChain)}</span>
            </>
          )}

          {areaName !== undefined && (
            <>
              <span class="text-fg-secondary">Scale Area:</span>
              <span class="text-right">{areaName || 'Unnamed'}</span>
            </>
          )}

          <span class="text-fg-secondary">Scale Ratio:</span>
          <span class="text-right">{scaleRatio}</span>

          <span class="text-fg-secondary">Precision:</span>
          <span class="text-right">{precText}</span>
        </div>
      </div>
    </FloatingMenu>
  );
}
