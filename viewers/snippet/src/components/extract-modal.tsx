import { h } from 'preact';
import { useMemo, useState } from 'preact/hooks';

import { FieldGroup, Label, Radio, RadioGroup, SegmentedControl } from './ds/controls';
import { Modal, ModalActions, ModalBody, ModalHeader } from './ds/floating';
import { FilePdfIcon, ImageIcon } from './ds/icons';
import { PageRangePicker } from './ds/page-range-picker';

export type ExtractFormat = 'pdf' | 'image';
export type ExtractCombine = 'combine' | 'split';

export interface ExtractSubmit {
  format: ExtractFormat;
  indices: number[];
  combine: ExtractCombine;
}

export const PREVIEW_CALLOUT =
  'text-fg-primary bg-bg-surface-alt border-border-subtle m-0 rounded-lg border px-3 py-2.5 text-sm';

export function ExtractModal({
  totalPages,
  preselected,
  defaultFormat = 'pdf',
  onSubmit,
  onCancel,
}: {
  totalPages: number;
  preselected: number[];
  defaultFormat?: ExtractFormat;
  onSubmit: (result: ExtractSubmit) => void;
  onCancel: () => void;
}) {
  const [format, setFormat] = useState<ExtractFormat>(defaultFormat);
  const [combine, setCombine] = useState<ExtractCombine>('combine');
  const [indices, setIndices] = useState<number[]>([]);
  const pageCount = indices.length;

  const canSubmit = pageCount > 0;

  const previewLine = useMemo(() => {
    if (pageCount === 0) return 'Select at least one page to extract.';
    if (format === 'image') {
      return pageCount === 1
        ? 'Exports 1 image file.'
        : `Exports a ZIP containing ${pageCount} individual image files.`;
    }
    if (combine === 'combine') {
      return pageCount === 1
        ? 'Exports 1 PDF file.'
        : `Exports ${pageCount} pages into a single PDF file.`;
    }
    return pageCount === 1
      ? 'Exports 1 PDF file.'
      : `Exports a ZIP containing ${pageCount} individual PDF files.`;
  }, [pageCount, format, combine]);

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ format, indices, combine: format === 'pdf' ? combine : 'split' });
  };

  return (
    <Modal open onClose={onCancel} width="md" ariaLabel="Extract Pages">
      <ModalHeader closeButton={false}>Extract Pages</ModalHeader>
      <ModalBody>
        <div class="flex flex-col gap-4">
          <FieldGroup label="Format">
            <SegmentedControl
              aria-label="Format"
              options={[
                { value: 'pdf', label: 'PDF', icon: <FilePdfIcon size={14} /> },
                { value: 'image', label: 'Image', icon: <ImageIcon size={14} /> },
              ]}
              value={format}
              onChange={setFormat}
            />
          </FieldGroup>

          <div class="flex flex-col gap-2">
            <Label>Apply to pages</Label>
            <PageRangePicker
              totalPages={totalPages}
              preselected={preselected}
              onChange={setIndices}
              name="extract-range"
            />
          </div>

          <RadioGroup aria-label="Output">
            <Label>Output</Label>
            <Radio
              name="extract-combine"
              value="combine"
              checked={combine === 'combine'}
              onChange={() => setCombine('combine')}
              label="Combine into a single PDF"
              disabled={format !== 'pdf'}
            />
            <Radio
              name="extract-combine"
              value="split"
              checked={combine === 'split'}
              onChange={() => setCombine('split')}
              label="Each page as a separate PDF"
              disabled={format !== 'pdf'}
            />
          </RadioGroup>

          <p class={PREVIEW_CALLOUT} aria-live="polite">
            {previewLine}
          </p>
        </div>
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel"
        onCancel={onCancel}
        confirmLabel="Extract"
        onConfirm={submit}
        confirmDisabled={!canSubmit}
      />
    </Modal>
  );
}
