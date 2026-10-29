import { useCommandsCapability } from '@embedpdf/plugin-commands/preact';
import { useScroll } from '@embedpdf/plugin-scroll/preact';
import { h, Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { Checkbox } from './ui/checkbox';
import { openScaleAreaDialog } from '../measurement/scale-area-tool';
import { ensureScaleAreas, scaleAreaLabel, useScaleAreas } from '../measurement/scale-areas';
import {
  addPreset,
  defaultPreset,
  getScaleState,
  removePreset,
  replaceState,
  setActivePreset,
  updatePreset,
  useScaleStore,
} from '../measurement/scale-store';
import {
  PRECISIONS,
  parsePrecisionKey,
  precisionKey,
  precisionLabel,
  type Precision,
  type ScalePreset,
  type ScaleState,
} from '../measurement/types';
import {
  Button,
  IconButton,
  NumberField,
  PickerSelect,
  SidebarCard,
  TextField,
} from '../measurement/ui/controls';
import { Modal, ModalHeader, ModalBody, ModalActions } from '../measurement/ui/floating';
import { TrashIcon, PlusIcon } from '../measurement/ui/icons';
import { UNITS, UNIT_LABEL, type Unit } from '../measurement/units';

interface Props {
  documentId: string;
  open: boolean;
  onClose: () => void;
}

export function MeasurementScaleModal({ documentId, open, onClose }: Props) {
  const { state, activePreset } = useScaleStore(documentId);

  const [snapshot, setSnapshot] = useState<ScaleState | null>(null);
  useEffect(() => {
    if (open) {
      setSnapshot(getScaleState(documentId));
    } else {
      setSnapshot(null);
    }
  }, [open, documentId]);

  const handleCancel = () => {
    if (snapshot) replaceState(documentId, snapshot);
    onClose();
  };

  const handleAddScale = () => {
    addPreset(documentId, { ...defaultPreset(), name: '' });
  };

  return (
    <Modal open={open} onClose={handleCancel} ariaLabel="Set Scale" width="md">
      <ModalHeader closeButton={false}>Set Scale</ModalHeader>
      <ModalBody>
        <div class="flex flex-col gap-2">
          <div class="flex flex-col gap-2">
            {state.presets.map((preset) => (
              <ScaleRow
                key={preset.id}
                documentId={documentId}
                preset={preset}
                isActive={preset.id === state.activePresetId}
                canDelete={state.presets.length > 1}
              />
            ))}
          </div>

          <div class="self-start py-1.5">
            <Button variant="link" onClick={handleAddScale}>
              <PlusIcon size={14} weight="bold" class="mr-1" aria-hidden="true" />
              Add Scale
            </Button>
          </div>
        </div>

        <div class="border-border-default mt-4 border-t pt-[14px]">
          <SecondaryUnitSection documentId={documentId} preset={activePreset} />
        </div>

        <div class="border-border-default mt-4 border-t pt-[14px]">
          <VerticalScaleSection documentId={documentId} preset={activePreset} />
        </div>

        {open ? (
          <div class="border-border-default mt-4 border-t pt-[14px]">
            <PageScaleAreasSection documentId={documentId} onLeave={onClose} />
          </div>
        ) : null}
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel"
        onCancel={handleCancel}
        confirmLabel="Done"
        onConfirm={onClose}
      />
    </Modal>
  );
}

interface ScaleRowProps {
  documentId: string;
  preset: ScalePreset;
  isActive: boolean;
  canDelete: boolean;
}

function ScaleRow({ documentId, preset, isActive, canDelete }: ScaleRowProps) {
  const [pageValue, setPageValue] = useState(String(preset.page.value));
  const [worldValue, setWorldValue] = useState(String(preset.world.value));

  useEffect(() => setPageValue(String(preset.page.value)), [preset.page.value]);
  useEffect(() => setWorldValue(String(preset.world.value)), [preset.world.value]);

  const commitPage = (raw: string = pageValue) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v > 0 && v !== preset.page.value) {
      updatePreset(documentId, preset.id, {
        page: { ...preset.page, value: v },
      });
    } else {
      setPageValue(String(preset.page.value));
    }
  };
  const commitWorld = (raw: string = worldValue) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v > 0 && v !== preset.world.value) {
      updatePreset(documentId, preset.id, {
        world: { ...preset.world, value: v },
      });
    } else {
      setWorldValue(String(preset.world.value));
    }
  };

  const ratio = `${preset.page.value} ${UNIT_LABEL[preset.page.unit]} = ${preset.world.value} ${UNIT_LABEL[preset.world.unit]}`;
  return (
    <SidebarCard
      selected={isActive}
      onSelect={() => setActivePreset(documentId, preset.id)}
      aria-label={preset.name ? `${preset.name}, ${ratio}` : ratio}
    >
      <div class="flex items-center gap-2">
        <TextField
          size="sm"
          class="min-w-0 flex-1"
          aria-label="Scale name"
          placeholder="Scale name (optional)"
          value={preset.name}
          onInput={(e) =>
            updatePreset(documentId, preset.id, {
              name: (e.currentTarget as HTMLInputElement).value,
            })
          }
        />
        <span class="text-fg-secondary shrink-0 text-sm">Precision</span>
        <PrecisionSelect
          value={preset.precision}
          onChange={(p) => updatePreset(documentId, preset.id, { precision: p })}
        />
      </div>

      <div class="flex items-center gap-1.5">
        <NumberField
          size="sm"
          class="min-w-0 flex-1"
          aria-label="Page distance"
          min={0}
          step={1}
          value={pageValue}
          onInput={(e) => setPageValue((e.currentTarget as HTMLInputElement).value)}
          onChange={(e) => commitPage((e.currentTarget as HTMLInputElement).value)}
        />
        <UnitSelect
          value={preset.page.unit}
          onChange={(u) =>
            updatePreset(documentId, preset.id, {
              page: { ...preset.page, unit: u },
            })
          }
        />
        <span class="text-fg-secondary shrink-0 px-0.5 text-sm" aria-hidden="true">
          =
        </span>
        <NumberField
          size="sm"
          class="min-w-0 flex-1"
          aria-label="Real-world distance"
          min={0}
          step={1}
          value={worldValue}
          onInput={(e) => setWorldValue((e.currentTarget as HTMLInputElement).value)}
          onChange={(e) => commitWorld((e.currentTarget as HTMLInputElement).value)}
        />
        <UnitSelect
          value={preset.world.unit}
          onChange={(u) =>
            updatePreset(documentId, preset.id, {
              world: { ...preset.world, unit: u },
            })
          }
        />
        {canDelete ? (
          <IconButton
            variant="danger"
            size="sm"
            onClick={() => removePreset(documentId, preset.id)}
            aria-label="Remove scale"
            class="shrink-0"
          >
            <TrashIcon size={14} weight="regular" />
          </IconButton>
        ) : null}
      </div>
    </SidebarCard>
  );
}

export function UnitSelect({
  value,
  onChange,
  units = UNITS,
}: {
  value: Unit;
  onChange: (u: Unit) => void;
  units?: readonly Unit[];
}) {
  return (
    <div class="w-[80px]">
      <PickerSelect<Unit>
        size="sm"
        value={value}
        onChange={onChange}
        aria-label="Unit"
        options={units.map((u) => ({ value: u, label: UNIT_LABEL[u] }))}
      />
    </div>
  );
}

export function PrecisionSelect({
  value,
  onChange,
}: {
  value: Precision;
  onChange: (p: Precision) => void;
}) {
  return (
    <div class="w-[116px]">
      <PickerSelect<string>
        size="sm"
        value={precisionKey(value)}
        onChange={(k) => onChange(parsePrecisionKey(k))}
        aria-label="Precision"
        options={PRECISIONS.map((p) => ({
          value: precisionKey(p),
          label: precisionLabel(p),
        }))}
      />
    </div>
  );
}

function SecondaryUnitSection({ documentId, preset }: { documentId: string; preset: ScalePreset }) {
  const secondaryUnit = useMemo<Unit>(
    () => preset.secondary?.unit ?? (preset.world.unit === 'ft' ? 'in' : 'mm'),
    [preset.secondary, preset.world.unit],
  );
  const secondaryPrecision: Precision = preset.secondary?.precision ?? preset.precision;

  return (
    <div class="flex flex-col gap-2.5">
      <strong class="text-fg-muted text-xs tracking-[0.04em] uppercase">Secondary Units</strong>
      <Checkbox
        checked={preset.showSecondary}
        onChange={(next) =>
          updatePreset(documentId, preset.id, {
            showSecondary: next,
            secondary: next
              ? { unit: secondaryUnit, precision: secondaryPrecision }
              : preset.secondary,
          })
        }
        label="Display secondary unit on captions"
      />
      {preset.showSecondary && (
        <>
          <div class="flex flex-wrap items-center gap-4 pl-6">
            <div class="inline-flex items-center gap-1.5">
              <span class="text-fg-secondary text-sm">Unit</span>
              <UnitSelect
                value={secondaryUnit}
                onChange={(u) =>
                  updatePreset(documentId, preset.id, {
                    secondary: { unit: u, precision: secondaryPrecision },
                  })
                }
              />
            </div>
            <div class="inline-flex items-center gap-1.5">
              <span class="text-fg-secondary text-sm">Precision</span>
              <PrecisionSelect
                value={secondaryPrecision}
                onChange={(p) =>
                  updatePreset(documentId, preset.id, {
                    secondary: { unit: secondaryUnit, precision: p },
                  })
                }
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function VerticalScaleSection({ documentId, preset }: { documentId: string; preset: ScalePreset }) {
  const v = preset.vertical;
  const [pageValue, setPageValue] = useState(String(v?.page.value ?? ''));
  const [worldValue, setWorldValue] = useState(String(v?.world.value ?? ''));
  useEffect(() => setPageValue(String(v?.page.value ?? '')), [v?.page.value]);
  useEffect(() => setWorldValue(String(v?.world.value ?? '')), [v?.world.value]);

  const commit = (side: 'page' | 'world', raw: string) => {
    if (!v) return;
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0 && n !== v[side].value) {
      updatePreset(documentId, preset.id, { vertical: { ...v, [side]: { ...v[side], value: n } } });
    } else if (side === 'page') {
      setPageValue(String(v.page.value));
    } else {
      setWorldValue(String(v.world.value));
    }
  };

  return (
    <div class="flex flex-col gap-2.5">
      <strong class="text-fg-muted text-xs tracking-[0.04em] uppercase">Vertical Scale</strong>
      <Checkbox
        checked={!!v}
        onChange={(next) =>
          updatePreset(documentId, preset.id, {
            vertical: next ? { page: { ...preset.page }, world: { ...preset.world } } : undefined,
          })
        }
        label="Separate vertical scale, for drawings stretched in height"
      />
      {v && (
        <div class="flex items-center gap-1.5 pl-6">
          <NumberField
            size="sm"
            class="min-w-0 flex-1"
            aria-label="Vertical page distance"
            min={0}
            step={1}
            value={pageValue}
            onInput={(e) => setPageValue((e.currentTarget as HTMLInputElement).value)}
            onChange={(e) => commit('page', (e.currentTarget as HTMLInputElement).value)}
          />
          <UnitSelect
            value={v.page.unit}
            onChange={(u) =>
              updatePreset(documentId, preset.id, {
                vertical: { ...v, page: { ...v.page, unit: u } },
              })
            }
          />
          <span class="text-fg-secondary shrink-0 px-0.5 text-sm" aria-hidden="true">
            =
          </span>
          <NumberField
            size="sm"
            class="min-w-0 flex-1"
            aria-label="Vertical real-world distance"
            min={0}
            step={1}
            value={worldValue}
            onInput={(e) => setWorldValue((e.currentTarget as HTMLInputElement).value)}
            onChange={(e) => commit('world', (e.currentTarget as HTMLInputElement).value)}
          />
          <UnitSelect
            value={v.world.unit}
            onChange={(u) =>
              updatePreset(documentId, preset.id, {
                vertical: { ...v, world: { ...v.world, unit: u } },
              })
            }
          />
        </div>
      )}
    </div>
  );
}

function PageScaleAreasSection({
  documentId,
  onLeave,
}: {
  documentId: string;
  onLeave: () => void;
}) {
  const { state: scroll } = useScroll(documentId);
  const { provides: commands } = useCommandsCapability();
  const pageIndex = Math.max(0, (scroll.currentPage ?? 1) - 1);
  useEffect(() => ensureScaleAreas(documentId), [documentId]);
  const areas = useScaleAreas(documentId, pageIndex);

  return (
    <div class="flex flex-col gap-2.5">
      <strong class="text-fg-muted text-xs tracking-[0.04em] uppercase">
        Scale Areas on Page {pageIndex + 1}
      </strong>
      {areas.length === 0 ? (
        <span class="text-fg-secondary text-sm">
          None. A scale area gives part of the page, such as a detail, its own scale.
        </span>
      ) : (
        areas.map((a) => (
          <div key={a.index} class="flex items-center gap-2">
            <span class="text-fg-primary min-w-0 flex-1 truncate text-sm">{scaleAreaLabel(a)}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={a.kind === 'other'}
              onClick={() => {
                onLeave();
                openScaleAreaDialog(documentId, { kind: 'edit', area: a });
              }}
            >
              Edit…
            </Button>
          </div>
        ))
      )}
      <div class="self-start py-1.5">
        <Button
          variant="link"
          onClick={() => {
            onLeave();
            commands?.execute('measurement:scale-area', documentId, 'ui');
          }}
        >
          <PlusIcon size={14} weight="bold" class="mr-1" aria-hidden="true" />
          Draw a Scale Area
        </Button>
      </div>
    </div>
  );
}
