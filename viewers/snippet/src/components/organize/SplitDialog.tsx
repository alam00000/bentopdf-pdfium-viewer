import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import {
  createDefaultSplitConfig,
  parseRangeList,
  rangeTextError,
  splitApplyBlocked,
  type BookmarkDepth,
  type RangeOutput,
  type SizeUnit,
  type SplitConfig,
  type SplitMode,
} from '@/lib/split-engine';
import { Checkbox } from '../ui/checkbox';
import { FieldGroup, NumberField, PickerSelect, TextField } from '../ds/controls';
import { Modal, ModalActions, ModalBody, ModalHeader } from '../ds/floating';

export interface SplitDialogProps {
  open: boolean;
  onClose: () => void;
  pageCount: number;
  busy?: boolean;
  onSubmit: (config: SplitConfig) => void;
}

const HINT = 'text-fg-muted text-xs';

function SplitOptionsFields({
  config,
  onChange,
  pageCount,
  busy,
}: {
  config: SplitConfig;
  onChange: (patch: Partial<SplitConfig>) => void;
  pageCount: number;
  busy?: boolean;
}) {
  const rangeErr =
    config.mode === 'page-range' ? rangeTextError(config.rangeText, pageCount) : null;
  const rangeHint = () => {
    if (config.rangeOutput === 'combined') {
      return (
        <>
          <strong>Produces 1 PDF</strong> with all the selected pages.
        </>
      );
    }
    const parsed = parseRangeList(config.rangeText, pageCount);
    if (!parsed) return 'One PDF per comma-separated section.';
    return parsed.length === 1 ? (
      <strong>Produces 1 PDF.</strong>
    ) : (
      <strong>Produces {parsed.length} PDFs in a .zip.</strong>
    );
  };
  const chunks = config.nChunk > 0 ? Math.ceil(pageCount / config.nChunk) : 0;

  return (
    <>
      <FieldGroup label="Split Mode">
        <PickerSelect<SplitMode>
          value={config.mode}
          onChange={(mode) => onChange({ mode })}
          disabled={busy}
          options={[
            { value: 'page-range', label: 'By page range' },
            { value: 'even-odd', label: 'Even & Odd pages' },
            { value: 'each-page', label: 'Each page → own PDF' },
            { value: 'bookmarks', label: 'By bookmarks' },
            { value: 'by-n', label: 'Every N pages' },
            { value: 'by-size', label: 'By maximum file size' },
          ]}
          aria-label="Split mode"
        />
      </FieldGroup>

      {config.mode === 'page-range' && (
        <>
          <FieldGroup
            label="Page Ranges"
            error={rangeErr && config.rangeText.trim().length > 0 ? rangeErr : undefined}
            hint="Comma-separate the pages and ranges to include."
          >
            <TextField
              value={config.rangeText}
              onValueChange={(rangeText) => onChange({ rangeText })}
              disabled={busy}
              placeholder={pageCount ? `e.g. 1-3, 5, 9-${pageCount}` : '1-3, 5, 9-12'}
              aria-label="Page ranges"
            />
          </FieldGroup>

          <FieldGroup label="Output" hint={!rangeErr ? rangeHint() : undefined}>
            <PickerSelect<RangeOutput>
              value={config.rangeOutput}
              onChange={(rangeOutput) => onChange({ rangeOutput })}
              disabled={busy}
              options={[
                { value: 'separate', label: 'One PDF per range' },
                { value: 'combined', label: 'Combined into a single PDF' },
              ]}
              aria-label="Range output"
            />
          </FieldGroup>
        </>
      )}

      {config.mode === 'by-n' && (
        <FieldGroup
          label="Pages per file"
          hint={
            pageCount && chunks > 0 ? (
              <>
                Produces {chunks} PDFs{chunks > 1 ? ' in a .zip.' : '.'}
              </>
            ) : undefined
          }
        >
          <NumberField
            value={config.nChunk}
            min={1}
            max={pageCount}
            step={1}
            disabled={busy}
            onValueChange={(text) => {
              const n = Number(text);
              if (Number.isFinite(n)) onChange({ nChunk: Math.max(1, Math.floor(n)) });
            }}
            aria-label="Pages per file"
          />
        </FieldGroup>
      )}

      {config.mode === 'each-page' && pageCount > 0 && (
        <div class={HINT}>Produces {pageCount} PDFs in a .zip.</div>
      )}

      {config.mode === 'even-odd' && (
        <div class={HINT}>Produces 2 PDFs in a .zip (odd pages, even pages).</div>
      )}

      {config.mode === 'bookmarks' && (
        <>
          <FieldGroup label="Bookmark Depth">
            <PickerSelect<BookmarkDepth>
              value={config.bookmarkDepth}
              onChange={(bookmarkDepth) => onChange({ bookmarkDepth })}
              disabled={busy}
              options={[
                { value: 0, label: 'Top level only' },
                { value: 1, label: 'Top + sub-bookmarks' },
                { value: 2, label: 'Top + 2 levels down' },
                { value: -1, label: 'All levels' },
              ]}
              aria-label="Bookmark depth"
            />
          </FieldGroup>
          <Checkbox
            checked={config.includeUnbookmarked}
            onChange={(includeUnbookmarked) => onChange({ includeUnbookmarked })}
            label="Include pages before the first bookmark"
          />
        </>
      )}

      {config.mode === 'by-size' && (
        <FieldGroup
          label="Maximum file size"
          hint="Each output PDF will be no larger than this size. If a single page exceeds the limit, the operation fails (no partial output)."
        >
          <div class="flex items-center gap-2">
            <NumberField
              class="min-w-0 flex-1"
              value={config.sizeValue}
              min={1}
              step={1}
              disabled={busy}
              onValueChange={(text) => {
                const n = Number(text);
                if (Number.isFinite(n) && n > 0) onChange({ sizeValue: n });
              }}
              aria-label="Maximum size value"
            />
            <div class="w-24 shrink-0">
              <PickerSelect<SizeUnit>
                value={config.sizeUnit}
                onChange={(sizeUnit) => onChange({ sizeUnit })}
                disabled={busy}
                options={[
                  { value: 'KB', label: 'KB' },
                  { value: 'MB', label: 'MB' },
                ]}
                aria-label="Size unit"
              />
            </div>
          </div>
        </FieldGroup>
      )}
    </>
  );
}

export function SplitDialog({ open, onClose, pageCount, busy, onSubmit }: SplitDialogProps) {
  const [config, setConfig] = useState<SplitConfig>(() => createDefaultSplitConfig(pageCount));

  useEffect(() => {
    if (!open) return;
    setConfig(createDefaultSplitConfig(pageCount));
  }, [open, pageCount]);

  const canSubmit = splitApplyBlocked(config, { pageCount }, !!busy) === null && !busy;

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Split PDF" width="md">
      <ModalHeader closeButton={false}>Split PDF</ModalHeader>
      <ModalBody>
        <div class="flex h-[300px] flex-col gap-3.5 overflow-y-auto py-1">
          <p class="text-fg-secondary mb-1 text-sm">
            {pageCount} {pageCount === 1 ? 'page' : 'pages'} total. Choose how to divide the
            document.
          </p>
          <SplitOptionsFields
            config={config}
            onChange={(patch) => setConfig((c) => ({ ...c, ...patch }))}
            pageCount={pageCount}
            busy={busy}
          />
        </div>
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel"
        onCancel={onClose}
        cancelDisabled={busy}
        confirmLabel="Split"
        onConfirm={() => onSubmit(config)}
        confirmDisabled={!canSubmit}
        confirmLoading={busy}
      />
    </Modal>
  );
}
