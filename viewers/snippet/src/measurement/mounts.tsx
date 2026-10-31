import { h, Fragment } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  useAnnotation,
  useAnnotationCapability,
  useRegisterRenderers,
} from '@embedpdf/plugin-annotation/preact';

import { MeasurementCreateListener } from './create-listener';
import { MeasurementScaleModal } from '../components/measurement-scale-modal';
import { MEASUREMENT_OPEN_SCALE_EVENT } from '../components/measurement-scale-badge';
import { MeasurementCalibrateOverlay } from '../components/measurement-calibrate-overlay';
import { MeasurementSelectionBridge } from './selection-bridge';
import { buildMeasurementRenderers } from './renderers';
import {
  getCalibrationState,
  getPendingMode,
  isPendingModeStale,
  resolveMeasurementToolId,
  setActiveMeasurementDoc,
  setPendingMode,
  releaseMeasurementDoc,
  subscribeCalibration,
  subscribePendingMode,
} from './scale-store';
import { notifyCommandRefresh } from '@/lib/command-refresh';
import { setLoupeEnabled, setSnapEnabled } from './snap-settings';
import { Loupe } from './loupe';
import { ScaleAreaMounts } from './scale-area-driver';
import { ensureScaleAreas } from './scale-areas';

interface Props {
  documentId: string;
}

export function MeasurementMounts({ documentId }: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);

  useEffect(() => {
    window.addEventListener(MEASUREMENT_OPEN_SCALE_EVENT, openModal);
    return () => window.removeEventListener(MEASUREMENT_OPEN_SCALE_EVENT, openModal);
  }, [openModal]);

  useEffect(() => {
    setActiveMeasurementDoc(documentId);
    return () => releaseMeasurementDoc(documentId);
  }, [documentId]);

  useEffect(() => {
    const offMode = subscribePendingMode(documentId, notifyCommandRefresh);
    const offCalibration = subscribeCalibration(documentId, notifyCommandRefresh);
    return () => {
      offMode();
      offCalibration();
    };
  }, [documentId]);

  useEffect(() => {
    let lastWasArmed = !!getPendingMode(documentId);
    if (lastWasArmed) ensureScaleAreas(documentId);
    const unsub = subscribePendingMode(documentId, () => {
      const armed = !!getPendingMode(documentId);
      if (armed) ensureScaleAreas(documentId);
      if (lastWasArmed && !armed) {
        setSnapEnabled(documentId, false);
        setLoupeEnabled(documentId, false);
      }
      lastWasArmed = armed;
    });
    return unsub;
  }, [documentId]);

  const resolvePageElement = useCallback(
    (pageIndex: number): HTMLElement | null => {
      if (typeof document === 'undefined') return null;
      const root = anchorRef.current?.getRootNode();
      const scope: ParentNode =
        root instanceof ShadowRoot || root instanceof Document ? root : document;
      return (
        scope.querySelector<HTMLElement>(
          `[data-document-id="${CSS.escape(documentId)}"][data-page-index="${pageIndex}"]`,
        ) ?? scope.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`)
      );
    },
    [documentId],
  );

  return (
    <>
      <span ref={anchorRef} hidden />
      <MeasurementRendererRegistration documentId={documentId} />
      <MeasurementModeToolSync documentId={documentId} />
      <MeasurementCreateListener documentId={documentId} />
      <MeasurementSelectionBridge documentId={documentId} />
      <MeasurementScaleModal documentId={documentId} open={modalOpen} onClose={closeModal} />
      <MeasurementCalibrateOverlay documentId={documentId} />
      <ScaleAreaMounts documentId={documentId} />
      <Loupe documentId={documentId} resolvePageElement={resolvePageElement} />
    </>
  );
}

export function useMeasuring(documentId: string): boolean {
  const { provides } = useAnnotationCapability();
  const [measuring, setMeasuring] = useState(false);

  useEffect(() => {
    const scope = provides?.forDocument(documentId);
    const sync = () => {
      const { phase } = getCalibrationState(documentId);
      const toolId = scope?.getActiveTool()?.id ?? null;
      setMeasuring(
        phase === 'placing-first' ||
          phase === 'placing-second' ||
          resolveMeasurementToolId(getPendingMode(documentId), toolId) !== null,
      );
    };
    sync();
    const offs = [
      subscribePendingMode(documentId, sync),
      subscribeCalibration(documentId, sync),
      scope?.onActiveToolChange(sync),
    ];
    return () => offs.forEach((off) => off?.());
  }, [provides, documentId]);

  return measuring;
}

function MeasurementModeToolSync({ documentId }: Props) {
  const { provides, state } = useAnnotation(documentId);
  const activeToolId = provides ? state.activeToolId : undefined;

  useEffect(() => {
    if (activeToolId === undefined) return;
    if (isPendingModeStale(getPendingMode(documentId), activeToolId)) {
      setPendingMode(documentId, null);
    }
  }, [documentId, activeToolId]);

  return null;
}

function MeasurementRendererRegistration({ documentId }: Props) {
  const renderers = useMemo(() => buildMeasurementRenderers(documentId), [documentId]);
  useRegisterRenderers(renderers);
  return null;
}
