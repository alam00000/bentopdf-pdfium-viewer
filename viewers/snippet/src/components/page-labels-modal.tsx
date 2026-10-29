import { h } from 'preact';
import { useMemo, useState } from 'preact/hooks';

import type { PageLabelStyle } from '@/hooks/pages-ops-types';
import { FieldGroup, Label, NumberField, PickerSelect, TextField } from './ds/controls';
import { Modal, ModalActions, ModalBody, ModalHeader } from './ds/floating';
import { PageRangePicker } from './ds/page-range-picker';
import { PREVIEW_CALLOUT } from './extract-modal';

export interface PageLabelsSubmit {
  style: PageLabelStyle;
  prefix: string;
  start: number;
  rangeStart: number;
  rangeEnd: number;
}

const STYLE_OPTIONS: ReadonlyArray<{ value: PageLabelStyle; label: string }> = [
  { value: '', label: 'None' },
  { value: 'D', label: '1, 2, 3, 4, ...' },
  { value: 'r', label: 'i, ii, iii, iv, ...' },
  { value: 'R', label: 'I, II, III, IV, ...' },
  { value: 'a', label: 'a, b, c, d, ...' },
  { value: 'A', label: 'A, B, C, D, ...' },
];

const ROMAN: ReadonlyArray<[number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function toRoman(n: number, lowercase: boolean): string {
  if (n <= 0) return '';
  let v = n;
  let out = '';
  for (const [num, sym] of ROMAN) {
    while (v >= num) {
      out += sym;
      v -= num;
    }
  }
  return lowercase ? out.toLowerCase() : out;
}

function toAlpha(n: number, lowercase: boolean): string {
  if (n <= 0) return '';
  const idx = (n - 1) % 26;
  const reps = Math.floor((n - 1) / 26) + 1;
  return String.fromCharCode((lowercase ? 97 : 65) + idx).repeat(reps);
}

function formatOneLabel(style: PageLabelStyle, prefix: string, n: number): string {
  if (style === '') return prefix;
  let body = '';
  if (style === 'D') body = String(n);
  else if (style === 'r') body = toRoman(n, true);
  else if (style === 'R') body = toRoman(n, false);
  else if (style === 'a') body = toAlpha(n, true);
  else if (style === 'A') body = toAlpha(n, false);
  return `${prefix}${body}`;
}

function renderSample(style: PageLabelStyle, prefix: string, start: number): string {
  if (style === '') return prefix ? `${prefix}, ${prefix}, ${prefix}, ...` : '(blank)';
  const out: string[] = [];
  for (let i = 0; i < 4; i++) out.push(formatOneLabel(style, prefix, start + i));
  return `${out.join(', ')}, ...`;
}

export function PageLabelsModal({
  totalPages,
  preselected,
  onSubmit,
  onCancel,
}: {
  totalPages: number;
  preselected?: number[];
  onSubmit: (result: PageLabelsSubmit) => void;
  onCancel: () => void;
}) {
  const [style, setStyle] = useState<PageLabelStyle>('D');
  const [prefix, setPrefix] = useState('');
  const [start, setStart] = useState<number>(1);
  const [indices, setIndices] = useState<number[]>([]);
  const parsedRange = useMemo(() => {
    if (indices.length === 0) return null;
    return { start: indices[0]!, end: indices[indices.length - 1]! };
  }, [indices]);

  const first = Math.max(1, Math.floor(start || 1));
  const sample = useMemo(() => renderSample(style, prefix, first), [style, prefix, first]);

  const canSubmit = parsedRange !== null && totalPages > 0;

  const submit = () => {
    if (!canSubmit || !parsedRange) return;
    onSubmit({
      style,
      prefix,
      start: first,
      rangeStart: parsedRange.start,
      rangeEnd: parsedRange.end,
    });
  };

  return (
    <Modal open onClose={onCancel} ariaLabel="Page Numbering" width={460}>
      <ModalHeader closeButton={false}>Page Numbering</ModalHeader>
      <ModalBody>
        <div class="flex flex-col gap-4">
          <FieldGroup label="Format">
            <PickerSelect
              aria-label="Format"
              value={style}
              onChange={setStyle}
              options={STYLE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
              size="sm"
            />
          </FieldGroup>

          <FieldGroup label="Prefix (optional)">
            <TextField value={prefix} onValueChange={setPrefix} placeholder="For example Ch-" />
          </FieldGroup>

          {style !== '' && (
            <FieldGroup
              label="Start At"
              hint={
                parsedRange
                  ? `Page ${parsedRange.start + 1} will be labeled “${formatOneLabel(
                      style,
                      prefix,
                      first,
                    )}”, page ${parsedRange.start + 2} will be “${formatOneLabel(
                      style,
                      prefix,
                      first + 1,
                    )}”, and so on.`
                  : `The first page in the range will be labeled “${formatOneLabel(
                      style,
                      prefix,
                      first,
                    )}”.`
              }
            >
              <NumberField
                value={String(start)}
                min={1}
                step={1}
                onValueChange={(text) => {
                  const v = Number.parseInt(text, 10);
                  setStart(Number.isFinite(v) ? v : 1);
                }}
              />
            </FieldGroup>
          )}

          <div class="flex flex-col gap-2">
            <Label>Apply to pages</Label>
            <PageRangePicker
              totalPages={totalPages}
              preselected={preselected}
              onChange={setIndices}
              name="page-labels-range"
            />
          </div>

          <p class={PREVIEW_CALLOUT} aria-live="polite">
            <span class="text-fg-secondary">Sample: </span>
            <bdi>{sample}</bdi>
          </p>
        </div>
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel"
        onCancel={onCancel}
        confirmLabel="OK"
        onConfirm={submit}
        confirmDisabled={!canSubmit}
      />
    </Modal>
  );
}
