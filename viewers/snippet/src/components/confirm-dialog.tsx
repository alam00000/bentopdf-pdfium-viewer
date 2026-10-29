import { h } from 'preact';

import { Modal, ModalActions, ModalBody, ModalHeader, ModalText } from './ds/floating';

export function ConfirmDialog({
  title,
  message,
  destructiveLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  destructiveLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open onClose={onCancel} width="sm" ariaLabel={title} role="alertdialog">
      <ModalHeader closeButton={false}>{title}</ModalHeader>
      <ModalBody>
        <ModalText>{message}</ModalText>
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel"
        onCancel={onCancel}
        confirmLabel={destructiveLabel}
        onConfirm={onConfirm}
        confirmVariant="destructive"
        confirmAutoFocus
      />
    </Modal>
  );
}
