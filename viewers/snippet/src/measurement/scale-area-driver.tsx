import { h, Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import { useDocumentState, useRegistry } from '@embedpdf/core/preact';
import { useAnnotationCapability } from '@embedpdf/plugin-annotation/preact';
import { useInteractionManagerCapability } from '@embedpdf/plugin-interaction-manager/preact';
import { useSelectionCapability } from '@embedpdf/plugin-selection/preact';
import type { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager/preact';
import { isInFloatingLayer, useEscapeKey } from './escape-key';

import {
  ensureScaleAreas,
  getScaleAreas,
  refreshScaleAreasIfLoaded,
  scaleAreasSupported,
  subscribeScaleAreas,
} from './scale-areas';
import { disarmScaleAreaTool, selectScaleArea, useScaleAreaTool } from './scale-area-tool';
import { removeScaleArea } from './scale-area-edits';
import { getPendingMode, subscribePendingMode } from './scale-store';
import { ScaleAreaDialogs } from '../components/scale-area-modal';

export const SCALE_AREA_MODE_ID = 'measurementScaleArea';

interface Props {
  documentId: string;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function ScaleAreaMounts({ documentId }: Props) {
  return (
    <>
      <ScaleAreasSync documentId={documentId} />
      <ScaleAreaToolDriver documentId={documentId} />
      <ScaleAreaDialogs documentId={documentId} />
    </>
  );
}

function ScaleAreasSync({ documentId }: Props) {
  const doc = useDocumentState(documentId)?.document;
  useEffect(() => {
    refreshScaleAreasIfLoaded(documentId);
  }, [doc, documentId]);
  return null;
}

function ScaleAreaToolDriver({ documentId }: Props) {
  const tool = useScaleAreaTool(documentId);
  const { registry } = useRegistry();
  const { provides: interaction } = useInteractionManagerCapability();
  const { provides: annotations } = useAnnotationCapability();
  const { provides: selection } = useSelectionCapability();
  const armed = tool.armed;

  useEffect(() => {
    if (!armed) return;
    const check = () => {
      if (scaleAreasSupported(documentId) !== false) return;
      disarmScaleAreaTool(documentId);
    };
    ensureScaleAreas(documentId);
    check();
    return subscribeScaleAreas(documentId, check);
  }, [armed, documentId]);

  useEffect(() => {
    if (!interaction) return;
    try {
      interaction.registerMode({
        id: SCALE_AREA_MODE_ID,
        scope: 'page',
        exclusive: false,
        cursor: 'crosshair',
      });
    } catch {}
  }, [interaction]);

  useEffect(() => {
    if (!interaction || !armed) return;
    let previous: string | null = null;
    try {
      const scope = interaction.forDocument(documentId);
      previous = scope.getActiveMode();
      scope.activate(SCALE_AREA_MODE_ID);
      selection?.clear(documentId);
      annotations?.forDocument(documentId).deselectAnnotation();
    } catch {}
    return () => {
      try {
        const scope = interaction.forDocument(documentId);
        if (scope.getActiveMode() !== SCALE_AREA_MODE_ID) return;
        if (previous && previous !== SCALE_AREA_MODE_ID) scope.activate(previous);
        else scope.activateDefaultMode();
      } catch {}
    };
  }, [interaction, annotations, selection, armed, documentId]);

  useEffect(() => {
    if (!armed) return;
    const scope = annotations?.forDocument(documentId);
    const offTool = scope?.onActiveToolChange?.((t) => {
      if (t) disarmScaleAreaTool(documentId);
    });
    const offMode = subscribePendingMode(documentId, () => {
      if (getPendingMode(documentId) !== null) disarmScaleAreaTool(documentId);
    });
    return () => {
      offTool?.();
      offMode();
    };
  }, [annotations, armed, documentId]);

  useEscapeKey(() => {
    if (tool.selected) selectScaleArea(documentId, null);
    else disarmScaleAreaTool(documentId);
  }, armed && !tool.dialog);

  useEffect(() => {
    const sel = tool.selected;
    if (!armed || !sel || tool.dialog || !registry) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.composedPath()[0] ?? e.target))
        return;
      if (isInFloatingLayer(e)) return;
      const active = registry
        .getPlugin<DocumentManagerPlugin>('document-manager')
        ?.provides()
        ?.getActiveDocumentId();
      if (active !== documentId) return;
      const area = getScaleAreas(documentId, sel.pageIndex).find((a) => a.index === sel.index);
      if (!area) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      selectScaleArea(documentId, null);
      void removeScaleArea(registry, documentId, area);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [armed, tool.selected, tool.dialog, registry, documentId]);

  return null;
}
