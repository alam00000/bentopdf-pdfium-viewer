import { h, Fragment } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useDocumentState } from '@embedpdf/core/preact';
import { useRenderCapability } from '@embedpdf/plugin-render/preact';
import { PdfErrorCode } from '@embedpdf/models';

import {
  Button,
  FieldGroup,
  IconButton,
  NumberField,
  PickerSelect,
  ProgressBar,
  SegmentedControl,
} from './ds/controls';
import { Menu, Modal, ModalActions, ModalBody, ModalHeader, PopupMenuItem } from './ds/floating';
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretLineLeftIcon,
  CaretLineRightIcon,
  CaretRightIcon,
  XIcon,
} from './ds/icons';
import { PageRangePicker } from './ds/page-range-picker';

export type PageSizeUnit = 'mm' | 'in' | 'cm' | 'pt' | 'p';

export interface PageSizeSubmit {
  indices: number[];
  newWidthPt: number;
  newHeightPt: number;
}

interface PageSizeModalProps {
  documentId: string;
  totalPages: number;
  preselected?: number[];
  initialPreviewPage?: number;
  progressThreshold?: number;
  onSubmit: (
    result: PageSizeSubmit,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<void> | void;
  onCancel: () => void;
}

const STANDARD_SIZES: ReadonlyArray<{ id: string; label: string; wPt: number; hPt: number }> = [
  { id: 'letter', label: 'Letter', wPt: 612, hPt: 792 },
  { id: 'legal', label: 'Legal', wPt: 612, hPt: 1008 },
  { id: 'tabloid', label: 'Tabloid', wPt: 792, hPt: 1224 },
  { id: 'executive', label: 'Executive', wPt: 522, hPt: 756 },
  { id: 'a0', label: 'A0', wPt: 2384, hPt: 3370 },
  { id: 'a1', label: 'A1', wPt: 1684, hPt: 2384 },
  { id: 'a2', label: 'A2', wPt: 1191, hPt: 1684 },
  { id: 'a3', label: 'A3', wPt: 842, hPt: 1191 },
  { id: 'a4', label: 'A4', wPt: 595, hPt: 842 },
  { id: 'a5', label: 'A5', wPt: 420, hPt: 595 },
  { id: 'a6', label: 'A6', wPt: 297, hPt: 420 },
  { id: 'b4', label: 'B4', wPt: 709, hPt: 1001 },
  { id: 'b5', label: 'B5', wPt: 499, hPt: 709 },
];

const PT_PER_MM = 72 / 25.4;

const UNIT_INFO: Record<PageSizeUnit, { name: string; ptPerUnit: number }> = {
  in: { name: 'Inches', ptPerUnit: 72 },
  mm: { name: 'Millimeters', ptPerUnit: PT_PER_MM },
  cm: { name: 'Centimeters', ptPerUnit: PT_PER_MM * 10 },
  pt: { name: 'Points', ptPerUnit: 1 },
  p: { name: 'Picas', ptPerUnit: 12 },
};

const UNITS: readonly PageSizeUnit[] = ['in', 'mm', 'cm', 'pt', 'p'];

function formatDim(pt: number, unit: PageSizeUnit): string {
  const v = pt / UNIT_INFO[unit].ptPerUnit;
  return `${unit === 'mm' || unit === 'pt' ? Math.round(v) : Math.round(v * 100) / 100}`;
}

function matchStandard(wPt: number, hPt: number): string | null {
  const TOL = 3;
  const minD = Math.min(wPt, hPt);
  const maxD = Math.max(wPt, hPt);
  for (const s of STANDARD_SIZES) {
    if (
      Math.abs(Math.min(s.wPt, s.hPt) - minD) <= TOL &&
      Math.abs(Math.max(s.wPt, s.hPt) - maxD) <= TOL
    ) {
      return s.id;
    }
  }
  return null;
}

type Orientation = 'portrait' | 'landscape';

function applyOrientation(wPt: number, hPt: number, ori: Orientation) {
  if (ori === 'landscape') return { wPt: Math.max(wPt, hPt), hPt: Math.min(wPt, hPt) };
  return { wPt: Math.min(wPt, hPt), hPt: Math.max(wPt, hPt) };
}

export function PageSizeModal({
  documentId,
  totalPages,
  preselected,
  initialPreviewPage = 0,
  progressThreshold = 50,
  onSubmit,
  onCancel,
}: PageSizeModalProps) {
  const [previewIdx, setPreviewIdx] = useState<number>(
    Math.max(0, Math.min(totalPages - 1, initialPreviewPage)),
  );
  const [unit, setUnit] = useState<PageSizeUnit>('mm');
  const [widthPt, setWidthPt] = useState<number>(595);
  const [heightPt, setHeightPt] = useState<number>(842);
  const [presetId, setPresetId] = useState<string>('a4');
  const [orientation, setOrientation] = useState<Orientation>('portrait');

  const handlePresetChange = useCallback(
    (id: string) => {
      setPresetId(id);
      if (id === 'custom') return;
      const std = STANDARD_SIZES.find((s) => s.id === id);
      if (!std) return;
      const o = applyOrientation(std.wPt, std.hPt, orientation);
      setWidthPt(o.wPt);
      setHeightPt(o.hPt);
    },
    [orientation],
  );

  const handleWidthChange = (val: string) => {
    const num = parseFloat(val);
    if (!Number.isFinite(num) || num <= 0) return;
    const pt = num * UNIT_INFO[unit].ptPerUnit;
    setWidthPt(pt);
    setPresetId(matchStandard(pt, heightPt) ?? 'custom');
  };

  const handleHeightChange = (val: string) => {
    const num = parseFloat(val);
    if (!Number.isFinite(num) || num <= 0) return;
    const pt = num * UNIT_INFO[unit].ptPerUnit;
    setHeightPt(pt);
    setPresetId(matchStandard(widthPt, pt) ?? 'custom');
  };

  const handleOrientationChange = (next: Orientation) => {
    if (next === orientation) return;
    setOrientation(next);
    setWidthPt(heightPt);
    setHeightPt(widthPt);
  };

  const [indices, setIndices] = useState<number[]>([]);
  const [showUnitMenu, setShowUnitMenu] = useState(false);
  const unitBtnRef = useRef<HTMLButtonElement | null>(null);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [origPagePt, setOrigPagePt] = useState<{ wPt: number; hPt: number } | null>(null);
  const [hasPickedInitialSize, setHasPickedInitialSize] = useState(false);

  useEffect(() => {
    if (hasPickedInitialSize || !origPagePt) return;
    const ori: Orientation = origPagePt.wPt > origPagePt.hPt ? 'landscape' : 'portrait';
    const match = matchStandard(origPagePt.wPt, origPagePt.hPt);
    if (match) {
      const std = STANDARD_SIZES.find((s) => s.id === match);
      if (std) {
        const o = applyOrientation(std.wPt, std.hPt, ori);
        setWidthPt(o.wPt);
        setHeightPt(o.hPt);
      }
      setPresetId(match);
    } else {
      setPresetId('custom');
      setWidthPt(origPagePt.wPt);
      setHeightPt(origPagePt.hPt);
    }
    setOrientation(ori);
    setHasPickedInitialSize(true);
  }, [origPagePt, hasPickedInitialSize]);

  const canSubmit = indices.length > 0 && widthPt > 0 && heightPt > 0;

  const submit = async () => {
    if (!canSubmit) return;
    const showProgress = indices.length > progressThreshold;
    if (showProgress) {
      setApplying(true);
      setProgress({ done: 0, total: indices.length });
    }
    try {
      await onSubmit(
        { indices, newWidthPt: widthPt, newHeightPt: heightPt },
        showProgress ? (done, total) => setProgress({ done, total }) : undefined,
      );
    } finally {
      if (showProgress) setApplying(false);
    }
  };

  const step = unit === 'mm' || unit === 'pt' ? 1 : 0.01;

  return (
    <Modal
      open
      onClose={onCancel}
      ariaLabel="Page Size"
      width={920}
      dismissOnBackdrop={!applying}
      dismissOnEscape={!applying}
    >
      <ModalHeader closeButton={false}>Page Size</ModalHeader>
      <ModalBody>
        {applying ? (
          <div
            class="flex min-h-[240px] flex-col items-center justify-center gap-4 px-5 py-14"
            role="status"
            aria-live="polite"
          >
            <p class="text-fg-primary text-sm font-medium">Updating Page Size…</p>
            <ProgressBar
              class="w-[min(360px,80%)]"
              aria-label="Updating Page Size"
              value={progress.done}
              max={Math.max(progress.total, 1)}
            />
            <p class="text-fg-secondary text-sm tabular-nums">
              {progress.done} / {progress.total} pages
            </p>
          </div>
        ) : (
          <div class="grid grid-cols-1 gap-6 md:grid-cols-[minmax(280px,1fr)_1px_360px]">
            <div class="flex min-h-[240px] flex-col md:min-h-[360px]">
              <PagePreviewPane
                documentId={documentId}
                totalPages={totalPages}
                activeIndex={previewIdx}
                onActiveIndexChange={setPreviewIdx}
                previewWidthPt={widthPt}
                previewHeightPt={heightPt}
                previewCaption={`Preview: ${formatDim(widthPt, unit)} × ${formatDim(
                  heightPt,
                  unit,
                )} ${unit}`}
                onPageDims={setOrigPagePt}
              />
            </div>

            <div class="bg-border-default hidden w-px self-stretch md:block" aria-hidden="true" />

            <div class="flex min-w-0 flex-col gap-4">
              <FieldGroup label="Original Page Size">
                <p class="text-fg-primary text-sm font-medium tabular-nums">
                  {origPagePt
                    ? `${formatDim(origPagePt.wPt, unit)} × ${formatDim(origPagePt.hPt, unit)} ${unit}`
                    : 'Loading…'}
                </p>
              </FieldGroup>

              <FieldGroup
                label="Size"
                labelAction={
                  <>
                    <Button
                      ref={unitBtnRef}
                      variant="ghost"
                      size="sm"
                      aria-label="Display unit"
                      aria-haspopup="menu"
                      aria-expanded={showUnitMenu}
                      trailingIcon={<CaretDownIcon size={10} weight="bold" />}
                      onClick={() => setShowUnitMenu((v) => !v)}
                    >
                      {unit}
                    </Button>
                    <Menu
                      open={showUnitMenu}
                      onClose={() => setShowUnitMenu(false)}
                      triggerRef={unitBtnRef}
                      align="end"
                      aria-label="Display unit"
                    >
                      {UNITS.map((u) => (
                        <PopupMenuItem
                          key={u}
                          selected={unit === u}
                          icon={<span class="min-w-[22px] font-semibold">{u}</span>}
                          onClick={() => setUnit(u)}
                          label={UNIT_INFO[u].name}
                        />
                      ))}
                    </Menu>
                  </>
                }
              >
                <PickerSelect
                  aria-label="Paper size"
                  value={presetId}
                  onChange={handlePresetChange}
                  options={[
                    ...STANDARD_SIZES.map((s) => ({ value: s.id, label: s.label })),
                    { value: 'custom', label: 'Custom' },
                  ]}
                  size="sm"
                />
                <div class="mt-2 flex items-center gap-2">
                  <NumberField
                    class="min-w-0 flex-1"
                    aria-label="Width"
                    prefix="W"
                    value={formatDim(widthPt, unit)}
                    min={step}
                    step={step}
                    onValueChange={handleWidthChange}
                  />
                  <XIcon class="text-fg-muted shrink-0" size={10} weight="bold" />
                  <NumberField
                    class="min-w-0 flex-1"
                    aria-label="Height"
                    prefix="H"
                    value={formatDim(heightPt, unit)}
                    min={step}
                    step={step}
                    onValueChange={handleHeightChange}
                  />
                </div>
              </FieldGroup>

              <FieldGroup label="Orientation">
                <SegmentedControl
                  aria-label="Orientation"
                  options={[
                    { value: 'portrait', label: 'Portrait' },
                    { value: 'landscape', label: 'Landscape' },
                  ]}
                  value={orientation}
                  onChange={handleOrientationChange}
                />
              </FieldGroup>

              <FieldGroup label="Page Range">
                <PageRangePicker
                  totalPages={totalPages}
                  preselected={preselected}
                  showFilter
                  onChange={setIndices}
                  name="page-size-range"
                />
              </FieldGroup>
            </div>
          </div>
        )}
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel"
        onCancel={onCancel}
        cancelDisabled={applying}
        confirmLabel="Apply"
        onConfirm={() => void submit()}
        confirmDisabled={!canSubmit || applying}
        confirmLoading={applying}
      />
    </Modal>
  );
}

function PagePreviewPane({
  documentId,
  totalPages,
  activeIndex,
  onActiveIndexChange,
  previewWidthPt,
  previewHeightPt,
  previewCaption,
  onPageDims,
}: {
  documentId: string;
  totalPages: number;
  activeIndex: number;
  onActiveIndexChange: (next: number) => void;
  previewWidthPt: number;
  previewHeightPt: number;
  previewCaption: string;
  onPageDims?: (dims: { wPt: number; hPt: number }) => void;
}) {
  const documentState = useDocumentState(documentId);
  const { provides: renderProvides } = useRenderCapability();
  const page = documentState?.document?.pages?.[activeIndex];
  const refreshVersion = documentState?.pageRefreshVersions?.[activeIndex] ?? 0;
  const [bitmapUrl, setBitmapUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!page || page.size.width <= 0) return;
    onPageDims?.({ wPt: page.size.width, hPt: page.size.height });
  }, [page, onPageDims]);

  useEffect(() => {
    if (!renderProvides || !page || page.size.width <= 0) return;
    const rotated = page.rotation % 2 === 1;
    const visibleW = rotated ? page.size.height : page.size.width;
    const task = renderProvides.forDocument(documentId).renderPageRect({
      pageIndex: activeIndex,
      rect: { origin: { x: 0, y: 0 }, size: page.size },
      options: {
        scaleFactor: 480 / visibleW,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
        rotation: page.rotation,
      },
    });
    let cancelled = false;
    task.wait(
      (blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setBitmapUrl(url);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      try {
        task.abort({ code: PdfErrorCode.Cancelled, message: 'unmount' });
      } catch {}
    };
  }, [renderProvides, documentId, activeIndex, page, refreshVersion]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const bitmapStyle = useMemo(() => {
    const origW = page?.size.width ?? 1;
    const origH = page?.size.height ?? 1;
    const rotated = page ? page.rotation % 2 === 1 : false;
    const visibleW = rotated ? origH : origW;
    const visibleH = rotated ? origW : origH;
    const frameRatio = previewWidthPt / previewHeightPt;
    return {
      width: `${Math.min(100, (100 * (visibleW / visibleH)) / frameRatio)}%`,
      height: `${Math.min(100, 100 * (visibleH / visibleW) * frameRatio)}%`,
      aspectRatio: `${visibleW} / ${visibleH}`,
    };
  }, [page, previewWidthPt, previewHeightPt]);

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3">
      <div class="flex min-h-0 flex-1 items-center justify-center">
        <div
          class="bg-bg-app border-border-default relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-md border"
          style={{ aspectRatio: `${previewWidthPt} / ${previewHeightPt}` }}
          aria-label="Page preview"
        >
          {bitmapUrl ? (
            <img
              class="block bg-white object-contain shadow-sm"
              src={bitmapUrl}
              alt={`Page ${activeIndex + 1} preview`}
              style={bitmapStyle}
              draggable={false}
            />
          ) : (
            <div class="bg-bg-elevated h-1/2 w-1/2 rounded-sm" aria-hidden="true" />
          )}
        </div>
      </div>
      <p class="text-fg-secondary text-center text-sm tabular-nums">{previewCaption}</p>
      <PageNav index={activeIndex} total={totalPages} onChange={onActiveIndexChange} />
    </div>
  );
}

function PageNav({
  index,
  total,
  onChange,
}: {
  index: number;
  total: number;
  onChange: (index: number) => void;
}) {
  const shown = Math.min(Math.max(index, 0), Math.max(total - 1, 0));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number.parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n)) onChange(Math.min(Math.max(n, 1), Math.max(total, 1)) - 1);
  };
  return (
    <div class="flex items-center justify-center gap-1 text-xs">
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="First page"
        tooltip="First page"
        disabled={shown <= 0}
        onClick={() => onChange(0)}
      >
        <CaretLineLeftIcon size={14} weight="bold" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Previous page"
        tooltip="Previous page"
        disabled={shown <= 0}
        onClick={() => onChange(Math.max(0, shown - 1))}
      >
        <CaretLeftIcon size={14} weight="bold" />
      </IconButton>
      <NumberField
        size="sm"
        inputWidth={48}
        class="text-center"
        aria-label="Page number"
        min={1}
        max={Math.max(total, 1)}
        step={1}
        value={draft ?? String(shown + 1)}
        onValueChange={setDraft}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape' && draft !== null) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
      <span class="text-fg-secondary tabular-nums">/ {total}</span>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Next page"
        tooltip="Next page"
        disabled={shown >= total - 1}
        onClick={() => onChange(Math.min(total - 1, shown + 1))}
      >
        <CaretRightIcon size={14} weight="bold" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Last page"
        tooltip="Last page"
        disabled={shown >= total - 1}
        onClick={() => onChange(total - 1)}
      >
        <CaretLineRightIcon size={14} weight="bold" />
      </IconButton>
    </div>
  );
}
