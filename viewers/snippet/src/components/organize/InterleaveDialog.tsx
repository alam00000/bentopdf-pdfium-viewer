import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { Button, Radio } from '../ds/controls';
import { Modal, ModalActions, ModalBody, ModalHeader } from '../ds/floating';

export type InterleaveSide = 'after' | 'before';

export interface InterleaveDialogProps {
  open: boolean;
  onClose: () => void;
  pageCount: number;
  onSubmit: (opts: { file: File; side: InterleaveSide }) => void;
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function InterleaveDialog({ open, onClose, pageCount, onSubmit }: InterleaveDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [side, setSide] = useState<InterleaveSide>('after');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setSide('after');
  }, [open]);

  const submit = () => {
    if (file) onSubmit({ file, side });
  };

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Interleave Pages" width="md">
      <ModalHeader closeButton={false}>Interleave Pages</ModalHeader>
      <ModalBody>
        <div class="flex flex-col gap-3.5 py-1">
          <p class="text-fg-secondary mb-1 text-sm">
            Insert every page of another PDF into this {pageCount}-page doc, one source page per
            target page.
          </p>

          <div class="flex flex-col gap-1 text-sm">
            <span class="text-fg-secondary text-xs tracking-[0.04em] uppercase">Source PDF</span>
            <div class="flex items-center gap-2">
              <span class="border-border-subtle bg-bg-elevated text-fg-primary min-w-0 flex-1 truncate rounded-sm border px-2 py-1.5 text-xs">
                {file ? file.name : <em class="text-fg-muted italic">None selected</em>}
              </span>
              <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
                Choose PDF
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                class="hidden"
                tabIndex={-1}
                onChange={(e) => {
                  const picked = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  if (picked && isPdf(picked)) setFile(picked);
                }}
              />
            </div>
          </div>

          <Radio
            name="interleave-side"
            value="after"
            checked={side === 'after'}
            onChange={() => setSide('after')}
            label={
              <span>
                Insert source pages <strong>after</strong> each target page
              </span>
            }
          />

          <Radio
            name="interleave-side"
            value="before"
            checked={side === 'before'}
            onChange={() => setSide('before')}
            label={
              <span>
                Insert source pages <strong>before</strong> each target page
              </span>
            }
          />
        </div>
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel"
        onCancel={onClose}
        confirmLabel="Interleave"
        onConfirm={submit}
        confirmDisabled={file == null}
      />
    </Modal>
  );
}
