import { useDocumentState, useRegistry } from '@embedpdf/core/preact';
import { h, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { PrecisionSelect, UnitSelect } from './measurement-scale-modal';
import { Checkbox } from './ui/checkbox';
import { buildScaleRatio, sameScale } from '../measurement/formatter';
import {
  addScaleArea,
  copyScaleAreaToPages,
  locateScaleArea,
  removeScaleArea,
  updateScaleArea,
} from '../measurement/scale-area-edits';
import {
  closeScaleAreaDialog,
  selectScaleArea,
  useScaleAreaTool,
  type ScaleAreaDialog,
} from '../measurement/scale-area-tool';
import type { ScaleArea, ScaleAreaBox } from '../measurement/scale-areas';
import {
  getActivePreset,
  getScaleState,
  startCalibration,
  type CalibrationAxis,
} from '../measurement/scale-store';
import type { Precision, ScalePreset } from '../measurement/types';
import {
  Button,
  FieldGroup,
  Notice,
  NumberField,
  PageScopeField,
  PickerSelect,
  TextField,
} from '../measurement/ui/controls';
import { Modal, ModalBody, ModalHeader, ModalActions } from '../measurement/ui/floating';
import { resolvePageScope, type PageScopeValue } from '../measurement/ui/page-range';
import { TO_IN, type Unit } from '../measurement/units';

interface Props {
  documentId: string;
}

interface RatioFields {
  page: string;
  pageUnit: Unit;
  world: string;
  worldUnit: Unit;
}

interface Draft {
  name: string;
  across: RatioFields;
  vertical: RatioFields | null;
  precision: Precision;
  base: ScalePreset;
  scaleTouched: boolean;
  savedId: string | null;
}

const METRIC = new Set<Unit>(['mm', 'cm', 'm', 'km']);

function shown(n: number): string {
  return String(Number(n.toPrecision(6)));
}

function fieldsOf(r: {
  page: { value: number; unit: Unit };
  world: { value: number; unit: Unit };
}): RatioFields {
  return {
    page: shown(r.page.value),
    pageUnit: r.page.unit,
    world: shown(r.world.value),
    worldUnit: r.world.unit,
  };
}

function parseRatio(
  r: RatioFields,
): { page: { value: number; unit: Unit }; world: { value: number; unit: Unit } } | null {
  const p = parseFloat(r.page);
  const w = parseFloat(r.world);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(w) || w <= 0) return null;
  return { page: { value: p, unit: r.pageUnit }, world: { value: w, unit: r.worldUnit } };
}

function calibratedFields(paperPoints: number, world: { value: number; unit: Unit }): RatioFields {
  const pageUnit: Unit = METRIC.has(world.unit) ? 'cm' : 'in';
  const paper = paperPoints / 72 / TO_IN[pageUnit];
  return { page: '1', pageUnit, world: shown(world.value / paper), worldUnit: world.unit };
}

function draftFor(documentId: string, dialog: ScaleAreaDialog): Draft {
  const page = getActivePreset(documentId);
  if (dialog.kind === 'edit' && dialog.area.kind === 'scale' && dialog.area.preset) {
    const p = dialog.area.preset;
    return {
      name: dialog.area.name,
      across: fieldsOf(p),
      vertical: p.vertical ? fieldsOf(p.vertical) : null,
      precision: p.precision,
      base: p,
      scaleTouched: false,
      savedId: null,
    };
  }
  return {
    name: dialog.kind === 'edit' ? dialog.area.name : '',
    across: fieldsOf(page),
    vertical: page.vertical ? fieldsOf(page.vertical) : null,
    precision: page.precision,
    base: page,
    scaleTouched: dialog.kind === 'new',
    savedId: null,
  };
}

function presetOf(d: Draft): ScalePreset | null {
  const across = parseRatio(d.across);
  if (!across) return null;
  const vertical = d.vertical ? parseRatio(d.vertical) : null;
  if (d.vertical && !vertical) return null;
  return {
    id: 'scale-area',
    name: '',
    page: across.page,
    world: across.world,
    precision: d.precision,
    showSecondary: d.base.showSecondary,
    ...(d.base.secondary ? { secondary: d.base.secondary } : {}),
    ...(vertical ? { vertical } : {}),
  };
}

export function ScaleAreaDialogs({ documentId }: Props) {
  const tool = useScaleAreaTool(documentId);
  const dialog = tool.dialog;
  return (
    <>
      <ScaleAreaModal
        documentId={documentId}
        dialog={dialog && dialog.kind !== 'copy' ? dialog : null}
      />
      <ScaleAreaCopyModal
        documentId={documentId}
        area={dialog?.kind === 'copy' ? dialog.area : null}
      />
    </>
  );
}

function ScaleAreaModal({
  documentId,
  dialog,
}: {
  documentId: string;
  dialog: Exclude<ScaleAreaDialog, { kind: 'copy' }> | null;
}) {
  const { registry } = useRegistry();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownFor = useRef<ScaleAreaDialog | null>(null);
  useEffect(() => {
    if (dialog === shownFor.current) return;
    shownFor.current = dialog;
    setDraft(dialog ? draftFor(documentId, dialog) : null);
    setCalibrating(false);
    setBusy(false);
    setError(null);
  }, [dialog, documentId]);

  const presets = getScaleState(documentId).presets;
  const savedOptions = useMemo(
    () =>
      presets.map((p) => ({
        value: p.id,
        label: p.name ? `${p.name} (${buildScaleRatio(p)})` : buildScaleRatio(p),
      })),
    [presets],
  );

  if (!dialog || !draft) return null;
  const isNew = dialog.kind === 'new';
  const area = dialog.kind === 'edit' ? dialog.area : null;
  const preset = presetOf(draft);
  const edit = (patch: Partial<Draft>, touchesScale = true) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            ...(touchesScale ? { savedId: null } : {}),
            ...patch,
            scaleTouched: d.scaleTouched || touchesScale,
          }
        : d,
    );

  const close = () => closeScaleAreaDialog(documentId);

  const calibrate = (which: 'across' | 'up') => {
    const fields = which === 'up' ? draft.vertical : draft.across;
    if (!fields) return;
    const axis: CalibrationAxis = draft.vertical ? (which === 'up' ? 'y' : 'x') : 'both';
    setCalibrating(true);
    startCalibration(documentId, {
      kind: 'draft',
      axis,
      initialWorld: { value: parseFloat(fields.world) || 1, unit: fields.worldUnit },
      onResult: (r) => {
        setCalibrating(false);
        const next = calibratedFields(r.paperPoints, r.world);
        if (which === 'up') edit({ vertical: next });
        else edit({ across: next });
      },
      onCancel: () => setCalibrating(false),
    });
  };

  const currentArea = (): ScaleArea | null => (area ? locateScaleArea(documentId, area) : null);

  const save = async () => {
    if (!preset || busy) return;
    setBusy(true);
    setError(null);
    if (isNew) {
      const box: ScaleAreaBox = dialog.box;
      const index = await addScaleArea(
        registry,
        documentId,
        dialog.pageIndex,
        box,
        draft.name,
        preset,
      );
      setBusy(false);
      if (index == null) {
        setError('The scale area could not be added.');
        return;
      }
      selectScaleArea(documentId, { pageIndex: dialog.pageIndex, index });
      close();
      return;
    }
    const now = currentArea();
    if (!now) {
      setBusy(false);
      setError('This scale area is no longer on the page.');
      return;
    }
    const unchanged =
      !draft.scaleTouched ||
      (now.preset != null &&
        sameScale(now.preset, preset) &&
        now.preset.precision === preset.precision &&
        buildScaleRatio(now.preset) === buildScaleRatio(preset));
    const ok = await updateScaleArea(registry, documentId, now, {
      box: now.box,
      name: draft.name,
      preset: unchanged ? 'keep' : preset,
    });
    setBusy(false);
    if (!ok) {
      setError('The scale area could not be saved.');
      return;
    }
    close();
  };

  const remove = async () => {
    const now = currentArea();
    if (!now || busy) return;
    setBusy(true);
    const ok = await removeScaleArea(registry, documentId, now);
    setBusy(false);
    if (!ok) {
      setError('The scale area could not be deleted.');
      return;
    }
    selectScaleArea(documentId, null);
    close();
  };

  const ratioRow = (fields: RatioFields, which: 'across' | 'up') => {
    const set = (patch: Partial<RatioFields>) =>
      which === 'up'
        ? edit({ vertical: { ...fields, ...patch } })
        : edit({ across: { ...fields, ...patch } });
    return (
      <div class="flex items-center gap-1.5">
        <NumberField
          size="sm"
          class="min-w-0 flex-1"
          aria-label={which === 'up' ? 'Vertical page distance' : 'Page distance'}
          min={0}
          step={1}
          value={fields.page}
          onInput={(e) => set({ page: (e.currentTarget as HTMLInputElement).value })}
        />
        <UnitSelect value={fields.pageUnit} onChange={(u) => set({ pageUnit: u })} />
        <span class="text-fg-secondary shrink-0 px-0.5 text-sm" aria-hidden="true">
          =
        </span>
        <NumberField
          size="sm"
          class="min-w-0 flex-1"
          aria-label={which === 'up' ? 'Vertical real-world distance' : 'Real-world distance'}
          min={0}
          step={1}
          value={fields.world}
          onInput={(e) => set({ world: (e.currentTarget as HTMLInputElement).value })}
        />
        <UnitSelect value={fields.worldUnit} onChange={(u) => set({ worldUnit: u })} />
        <Button variant="secondary" size="sm" class="shrink-0" onClick={() => calibrate(which)}>
          Calibrate…
        </Button>
      </div>
    );
  };

  return (
    <Modal
      open={!calibrating}
      onClose={close}
      ariaLabel={isNew ? 'New Scale Area' : 'Edit Scale Area'}
      width="md"
    >
      <ModalHeader closeButton={false}>{isNew ? 'New Scale Area' : 'Edit Scale Area'}</ModalHeader>
      <ModalBody>
        <div class="flex flex-col gap-4">
          <FieldGroup label="Name">
            <TextField
              size="sm"
              placeholder="Detail A (optional)"
              value={draft.name}
              onInput={(e) => edit({ name: (e.currentTarget as HTMLInputElement).value }, false)}
            />
          </FieldGroup>
          {area?.kind === 'unscaled' && !draft.scaleTouched ? (
            <Notice tone="info">
              This area has no scale of its own: measurements inside it use the page scale. Set a
              scale below to give it one.
            </Notice>
          ) : null}
          <FieldGroup label="Saved scale">
            <PickerSelect<string>
              size="sm"
              block
              value={draft.savedId ?? ''}
              placeholder="None"
              options={savedOptions}
              onChange={(id) => {
                const p = presets.find((x) => x.id === id);
                if (!p) return;
                edit({
                  across: fieldsOf(p),
                  vertical: p.vertical ? fieldsOf(p.vertical) : null,
                  precision: p.precision,
                  base: p,
                  savedId: p.id,
                });
              }}
            />
          </FieldGroup>
          <FieldGroup label={draft.vertical ? 'Horizontal scale' : 'Scale'}>
            {ratioRow(draft.across, 'across')}
          </FieldGroup>
          <Checkbox
            checked={draft.vertical != null}
            onChange={(on) => edit({ vertical: on ? { ...draft.across } : null })}
            label="Separate vertical scale"
          />
          {draft.vertical ? (
            <FieldGroup
              label="Vertical scale"
              hint="Measurements count lengths up the page at this scale."
            >
              {ratioRow(draft.vertical, 'up')}
            </FieldGroup>
          ) : null}
          <FieldGroup label="Precision">
            <PrecisionSelect value={draft.precision} onChange={(p) => edit({ precision: p })} />
          </FieldGroup>
          {!preset ? <Notice tone="danger">Enter distances greater than zero.</Notice> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
      </ModalBody>
      <ModalActions
        leading={
          area ? (
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
              Delete
            </Button>
          ) : undefined
        }
        cancelLabel="Cancel"
        onCancel={close}
        confirmLabel={isNew ? 'Add' : 'Save'}
        onConfirm={() => void save()}
        confirmDisabled={!preset}
        confirmLoading={busy}
      />
    </Modal>
  );
}

function ScaleAreaCopyModal({ documentId, area }: { documentId: string; area: ScaleArea | null }) {
  const { registry } = useRegistry();
  const docState = useDocumentState(documentId);
  const pages = docState?.document?.pages ?? [];
  const pageCount = pages.length;
  const [scope, setScope] = useState<PageScopeValue>({ mode: 'all', text: '' });
  const [busy, setBusy] = useState(false);
  const shownFor = useRef<ScaleArea | null>(null);
  useEffect(() => {
    if (area === shownFor.current) return;
    shownFor.current = area;
    setScope({ mode: 'all', text: '' });
    setBusy(false);
  }, [area]);

  if (!area) return null;
  const modes = ['all', 'range'] as const;
  const resolved = resolvePageScope(scope, { pageCount }, modes);
  const targets = resolved.ok ? resolved.indices.filter((p) => p !== area.pageIndex) : [];
  const close = () => closeScaleAreaDialog(documentId);

  const pageBox = (p: number): ScaleAreaBox | null => {
    const size = pages[p]?.size;
    if (!size) return null;
    return { left: 0, bottom: 0, right: size.width, top: size.height };
  };

  const copy = async () => {
    if (!targets.length || busy) return;
    setBusy(true);
    await copyScaleAreaToPages(registry, documentId, area, targets, pageBox);
    setBusy(false);
    close();
  };

  return (
    <Modal open onClose={close} ariaLabel="Copy Scale Area to Pages" width="sm">
      <ModalHeader closeButton={false}>Copy Scale Area to Pages</ModalHeader>
      <ModalBody>
        <div class="flex flex-col gap-3">
          <FieldGroup
            label="Pages"
            hint="The area goes in the same place on each page, on top of their own."
          >
            <PageScopeField value={scope} onChange={setScope} pageCount={pageCount} modes={modes} />
          </FieldGroup>
          {resolved.ok && targets.length === 0 ? (
            <Notice tone="info">Pick pages other than this one.</Notice>
          ) : null}
        </div>
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel"
        onCancel={close}
        confirmLabel="Copy"
        onConfirm={() => void copy()}
        confirmDisabled={!targets.length}
        confirmLoading={busy}
      />
    </Modal>
  );
}
