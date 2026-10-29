import { useDocumentState, useRegistry } from '@embedpdf/core/preact';
import { PdfAnnotationLineEnding } from '@embedpdf/models';
import { useInteractionManagerCapability } from '@embedpdf/plugin-interaction-manager/preact';
import { h, Fragment } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { useViewportEdgeAnchor } from './viewport-edge-anchor';
import { MEASUREMENT_COLORS } from '../measurement/colors';
import { DimensionEnds, DimensionTick } from '../measurement/dimension-ends';
import { useEscapeKey } from '../measurement/escape-key';
import { publishLoupe } from '../measurement/loupe-bus';
import { getPageMeta } from '../measurement/page-meta-registry';
import { setScaleAreaScale } from '../measurement/scale-area-edits';
import { ensureScaleAreas, getScaleAreas, getUserUnit } from '../measurement/scale-areas';
import { areaAt } from '../measurement/scale-context';
import {
  applyCalibration,
  calibratedPreset,
  getActivePreset,
  getCalibrationState,
  resetCalibration,
  setCalibrationCursor,
  setCalibrationFirst,
  setCalibrationSecond,
  subscribeCalibration,
  type CalibrationAxis,
  type CalibrationState,
  type CalibrationTarget,
} from '../measurement/scale-store';
import {
  begin as snapBegin,
  end as snapEnd,
  snap as snapSnap,
  cacheMatches as snapCacheMatches,
} from '../measurement/snap-engine';
import { getSnapSettings } from '../measurement/snap-settings';
import { Button, IconButton, Kbd, Notice, NumberField, PickerSelect } from './ds/controls';
import { FloatingMenu } from './ds/floating';
import { XIcon } from './ds/icons';
import { CALIBRATE_UNITS, UNIT_LABEL, type Unit } from '../measurement/units';

interface Props {
  documentId: string;
}

function useCalibrationState(documentId: string): CalibrationState {
  const [state, setState] = useState<CalibrationState>(() => getCalibrationState(documentId));
  useEffect(() => {
    setState(getCalibrationState(documentId));
    return subscribeCalibration(documentId, () => {
      setState(getCalibrationState(documentId));
    });
  }, [documentId]);
  return state;
}

const CALIBRATE_MODE_ID = 'measurementCalibrate';

export function MeasurementCalibrateOverlay({ documentId }: Props) {
  const cal = useCalibrationState(documentId);
  const { provides: imCap } = useInteractionManagerCapability();
  const docState = useDocumentState(documentId);
  const pageCount = docState?.document?.pages?.length ?? 0;

  const calRef = useRef(cal);
  useEffect(() => {
    calRef.current = cal;
  }, [cal]);

  useEffect(() => {
    if (!imCap) return;
    try {
      imCap.registerMode({
        id: CALIBRATE_MODE_ID,
        scope: 'page',
        exclusive: true,
        cursor: 'crosshair',
      });
    } catch {}
  }, [imCap]);

  useEscapeKey(() => resetCalibration(documentId), cal.phase !== 'idle');

  useEffect(() => {
    if (cal.phase !== 'idle') ensureScaleAreas(documentId);
  }, [cal.phase, documentId]);

  useEffect(() => {
    if (!imCap) return;
    const activeNow = cal.phase === 'placing-first' || cal.phase === 'placing-second';
    if (!activeNow) return;

    const applySnap = (
      pageIdx: number,
      pos: { x: number; y: number },
    ): { x: number; y: number } => {
      const meta = getPageMeta(documentId, pageIdx);
      if (!meta) return pos;
      const settings = getSnapSettings(documentId);
      if (!settings.enabled) {
        publishLoupe(null);
        return pos;
      }
      if (!snapCacheMatches(documentId, pageIdx)) {
        void snapBegin({
          documentId,
          pageIndex: pageIdx,
          pageMinX: 0,
          pageMinY: 0,
          pageMaxX: meta.pageWidthPdf,
          pageMaxY: meta.pageHeightPdf,
          settings,
        });
      }
      const radiusPdf = 8 / Math.max(meta.pageCssScale, 0.001);
      const pdfY = meta.pageHeightPdf - pos.y;
      const result = snapSnap(documentId, pageIdx, pos.x, pdfY, radiusPdf);
      publishLoupe({
        documentId,
        pageIndex: pageIdx,
        pdfX: pos.x,
        pdfY,
        pageCssX: pos.x * meta.pageCssScale,
        pageCssY: pos.y * meta.pageCssScale,
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
      if (!result) return pos;
      return { x: result.pdfX, y: meta.pageHeightPdf - result.pdfY };
    };

    const unsubs: Array<() => void> = [];
    for (let i = 0; i < pageCount; i++) {
      const pageIdx = i;
      const unreg = imCap.registerHandlers({
        documentId,
        modeId: CALIBRATE_MODE_ID,
        pageIndex: pageIdx,
        handlers: {
          onPointerDown: (pos, evt) => {
            const snapped = applySnap(pageIdx, pos);
            const cur = calRef.current;
            if (cur.phase === 'placing-first') {
              const area = cur.target.kind === 'page' ? areaAt(documentId, pageIdx, snapped) : null;
              setCalibrationFirst(
                documentId,
                pageIdx,
                snapped,
                area && area.kind !== 'other'
                  ? { kind: 'area', pageIndex: pageIdx, index: area.index, name: area.name }
                  : undefined,
              );
            } else if (cur.phase === 'placing-second' && cur.pageIndex === pageIdx) {
              setCalibrationSecond(documentId, snapped);
            }
            evt.stopImmediatePropagation?.();
          },
          onPointerMove: (pos) => {
            const snapped = applySnap(pageIdx, pos);
            const cur = calRef.current;
            if (cur.phase !== 'placing-second' || cur.pageIndex !== pageIdx) {
              return;
            }
            setCalibrationCursor(documentId, pageIdx, snapped);
          },
          onPointerLeave: () => {
            publishLoupe(null);
          },
        },
      });
      if (unreg) unsubs.push(unreg);
    }

    const scope = imCap.forDocument(documentId);
    const prevMode = scope.getActiveMode();
    scope.activate(CALIBRATE_MODE_ID);

    return () => {
      unsubs.forEach((fn) => fn());
      snapEnd();
      publishLoupe(null);
      if (scope.getActiveMode() === CALIBRATE_MODE_ID) {
        if (prevMode && prevMode !== CALIBRATE_MODE_ID) {
          scope.activate(prevMode);
        } else {
          scope.activateDefaultMode();
        }
      }
    };
  }, [
    cal.phase === 'placing-first' || cal.phase === 'placing-second',
    imCap,
    pageCount,
    documentId,
  ]);

  if (cal.phase === 'idle') return null;

  return <CalibrationBanner documentId={documentId} state={cal} />;
}

const CALIBRATE_STROKE_WIDTH = 1.5;

const CALIBRATE_LINE_ENDINGS = {
  start: PdfAnnotationLineEnding.OpenArrow,
  end: PdfAnnotationLineEnding.OpenArrow,
};

export function MeasurementCalibratePageVisual({
  documentId,
  pageIndex,
}: {
  documentId: string;
  pageIndex: number;
}) {
  const cal = useCalibrationState(documentId);
  const docState = useDocumentState(documentId);
  const page = docState?.document?.pages?.[pageIndex];

  if (cal.phase === 'idle') return null;
  if (!page) return null;
  if (cal.pageIndex !== pageIndex) return null;
  if (!cal.first) return null;

  const color = MEASUREMENT_COLORS.calibrateLine;
  const pageW = page.size.width;
  const pageH = page.size.height;

  const end = cal.phase === 'placing-second' ? cal.cursor : cal.second;
  const dashed = cal.phase === 'placing-second';

  if (!end) {
    return (
      <svg
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 100,
          overflow: 'visible',
        }}
        viewBox={`0 0 ${pageW} ${pageH}`}
        preserveAspectRatio="none"
      >
        <DimensionTick
          at={cal.first}
          nx={0}
          ny={1}
          strokeWidth={CALIBRATE_STROKE_WIDTH}
          color={color}
        />
      </svg>
    );
  }

  const dx = end.x - cal.first.x;
  const dy = end.y - cal.first.y;
  const segLength = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dy / segLength;
  const ny = -dx / segLength;

  const captionText =
    segLength > 0 ? `${(segLength * getUserUnit(documentId, pageIndex)).toFixed(1)} pt` : '';

  const mid = {
    x: (cal.first.x + end.x) * 0.5,
    y: (cal.first.y + end.y) * 0.5,
  };
  const captionOffset = 10;
  const captionAnchor = {
    x: mid.x + nx * captionOffset,
    y: mid.y + ny * captionOffset,
  };
  let captionAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (captionAngle > 90) captionAngle -= 180;
  if (captionAngle < -90) captionAngle += 180;

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 100,
        overflow: 'visible',
      }}
      viewBox={`0 0 ${pageW} ${pageH}`}
      preserveAspectRatio="none"
    >
      <line
        x1={cal.first.x}
        y1={cal.first.y}
        x2={end.x}
        y2={end.y}
        stroke={color}
        strokeWidth={CALIBRATE_STROKE_WIDTH}
        strokeDasharray={dashed ? '6 4' : undefined}
        vectorEffect="non-scaling-stroke"
        style={{ strokeLinecap: 'butt' }}
      />

      <DimensionEnds
        a={cal.first}
        b={end}
        endings={CALIBRATE_LINE_ENDINGS}
        strokeWidth={CALIBRATE_STROKE_WIDTH}
        color={color}
      />

      {captionText && (
        <text
          x={captionAnchor.x}
          y={captionAnchor.y}
          textAnchor="middle"
          fontWeight={600}
          fill={MEASUREMENT_COLORS.caption}
          style={{ userSelect: 'none', fontFamily: 'inherit', fontSize: '11px' }}
          transform={`rotate(${captionAngle.toFixed(2)} ${captionAnchor.x} ${captionAnchor.y})`}
        >
          {captionText}
        </text>
      )}
    </svg>
  );
}

function CalibrationBanner({ documentId, state }: { documentId: string; state: CalibrationState }) {
  const close = useCallback(() => resetCalibration(documentId), [documentId]);
  const topEdge = useViewportEdgeAnchor('top');

  return (
    <FloatingMenu anchor={topEdge} placement="bottom" offset={16} aria-label="Calibrate">
      <div class="text-fg-primary flex max-w-[710px] min-w-[450px] items-center gap-4 px-3 py-2 text-sm">
        {state.phase === 'placing-first' && (
          <>
            <div class="flex-1">Select the first point of a segment with a known distance.</div>
            <BannerCloseButton onClose={close} />
          </>
        )}
        {state.phase === 'placing-second' && (
          <>
            <div class="flex-1">
              <div>Select the second point of the segment.</div>
              <div class="text-fg-secondary mt-0.5 text-xs">
                Press <Kbd keys={['Escape']} /> to cancel.
              </div>
            </div>
            <BannerCloseButton onClose={close} />
          </>
        )}
        {state.phase === 'confirming' &&
          state.first &&
          state.second &&
          state.pageIndex !== null && (
            <CalibrationConfirm
              documentId={documentId}
              pageIndex={state.pageIndex}
              target={state.target}
              start={state.first}
              end={state.second}
              onClose={close}
            />
          )}
      </div>
    </FloatingMenu>
  );
}

function BannerCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <IconButton variant="ghost" size="sm" onClick={onClose} aria-label="Cancel calibration">
      <XIcon size={16} weight="bold" />
    </IconButton>
  );
}

function areaBasePreset(documentId: string, target: Extract<CalibrationTarget, { kind: 'area' }>) {
  const area = getScaleAreas(documentId, target.pageIndex).find((a) => a.index === target.index);
  if (area?.kind === 'scale' && area.preset) return { area, preset: area.preset };
  return {
    area: area ?? null,
    preset: { ...getActivePreset(documentId), vertical: undefined },
  };
}

function CalibrationConfirm({
  documentId,
  pageIndex,
  target,
  start,
  end,
  onClose,
}: {
  documentId: string;
  pageIndex: number;
  target: CalibrationTarget;
  start: { x: number; y: number };
  end: { x: number; y: number };
  onClose: () => void;
}) {
  const { registry } = useRegistry();
  const base =
    target.kind === 'area'
      ? areaBasePreset(documentId, target).preset
      : getActivePreset(documentId);
  const { pdfPts, axis } = useMemo(() => {
    const uu = getUserUnit(documentId, pageIndex);
    const dx = Math.abs(end.x - start.x) * uu;
    const dy = Math.abs(end.y - start.y) * uu;
    const a: CalibrationAxis =
      target.kind === 'draft' ? target.axis : base.vertical ? (dy > dx ? 'y' : 'x') : 'both';
    return { pdfPts: a === 'x' ? dx : a === 'y' ? dy : Math.sqrt(dx * dx + dy * dy), axis: a };
  }, [start.x, start.y, end.x, end.y, documentId, pageIndex, target, base.vertical]);

  const initial =
    target.kind === 'draft'
      ? target.initialWorld
      : axis === 'y' && base.vertical
        ? base.vertical.world
        : base.world;
  const [valueStr, setValueStr] = useState(String(initial.value));
  const [unit, setUnit] = useState<Unit>(initial.unit === 'pt' ? 'in' : initial.unit);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const tooShort = !(pdfPts > 0.5);

  const accept = useCallback(() => {
    if (tooShort) return;
    const v = parseFloat(valueStr);
    if (!Number.isFinite(v) || v <= 0) return;
    const result = { axis, paperPoints: pdfPts, world: { value: v, unit } };
    if (target.kind === 'draft') {
      resetCalibration(documentId, true);
      target.onResult(result);
      return;
    }
    if (target.kind === 'area') {
      const { area, preset } = areaBasePreset(documentId, target);
      resetCalibration(documentId);
      if (area) {
        void setScaleAreaScale(registry, documentId, area, calibratedPreset(preset, result));
      }
      return;
    }
    applyCalibration(documentId, pdfPts, v, unit, axis);
    onClose();
  }, [documentId, pdfPts, axis, valueStr, unit, onClose, tooShort, target, registry]);

  const detected = pdfPts.toFixed(1);
  const where =
    target.kind === 'area' ? ` in ${target.name ? `“${target.name}”` : 'the scale area'}` : '';
  const which =
    axis === 'x' ? ' for the horizontal scale' : axis === 'y' ? ' for the vertical scale' : '';

  return (
    <div class="flex flex-1 flex-col gap-3">
      <div>
        {tooShort ? (
          <Notice tone="danger">
            The two points coincide. Cancel and draw the line across a known distance.
          </Notice>
        ) : (
          <>
            <strong>{detected} pt</strong> detected{where}. Enter the real-world distance{which}:
          </>
        )}
      </div>
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-1.5">
          <NumberField
            ref={inputRef}
            size="sm"
            min={0}
            step={0.01}
            value={valueStr}
            inputWidth={104}
            aria-label="Real-world distance"
            onInput={(e) => setValueStr((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if ((e as KeyboardEvent).key === 'Enter') accept();
            }}
          />
          <PickerSelect<Unit>
            value={unit}
            onChange={(u) => setUnit(u)}
            options={CALIBRATE_UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u] }))}
            size="sm"
            aria-label="Real-world unit"
          />
        </div>
        <div class="ml-auto flex gap-2">
          <Button variant="secondary" onClick={onClose} class="min-w-[84px]">
            Cancel
          </Button>
          <Button variant="brand" onClick={accept} disabled={tooShort} class="min-w-[84px]">
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
