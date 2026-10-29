import { h } from 'preact';

import { Modal, ModalActions, ModalBody, ModalHeader, ModalText } from './ds/floating';
import { FileXIcon } from './ds/icons';

export function InvalidFileDropModal({
  fileNames,
  onClose,
}: {
  fileNames: string[];
  onClose: () => void;
}) {
  const headerTitle =
    fileNames.length === 1 ? "Can't insert this file" : "Can't insert these files";

  const description =
    fileNames.length === 1
      ? 'Only PDFs and images can be inserted into the document. The dropped file isn’t a PDF or image.'
      : `Only PDFs and images can be inserted into the document. ${fileNames.length} of the dropped files aren’t PDFs or images.`;

  return (
    <Modal open onClose={onClose} width="md" ariaLabel={headerTitle}>
      <ModalHeader closeButton={false}>{headerTitle}</ModalHeader>
      <ModalBody>
        <ModalText>{description}</ModalText>
        <ul
          aria-label="Files that can't be inserted"
          class="border-border-subtle bg-bg-input mt-3 max-h-[min(220px,40vh)] overflow-y-auto rounded-md border"
        >
          {fileNames.map((name, i) => (
            <li
              key={`${i}:${name}`}
              class={`text-fg-secondary flex min-w-0 items-center gap-2 px-3 py-2 text-sm ${
                i < fileNames.length - 1 ? 'border-border-subtle border-b' : ''
              }`}
            >
              <FileXIcon size={16} class="text-state-error shrink-0" />
              <span class="min-w-0 flex-auto truncate" dir="auto" title={name}>
                {name}
              </span>
            </li>
          ))}
        </ul>
      </ModalBody>
      <ModalActions confirmLabel="OK" onConfirm={onClose} />
    </Modal>
  );
}
