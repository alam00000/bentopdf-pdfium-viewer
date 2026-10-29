import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import type { InsertBatchPasswordFile } from '@/hooks/pages-ops-types';
import { Checkbox } from './ui/checkbox';
import { Notice, PasswordField, SegmentedControl } from './ds/controls';
import { Modal, ModalActions, ModalBody, ModalHeader } from './ds/floating';
import { FilePdfIcon, WarningOctagonIcon } from './ds/icons';

export interface BatchPasswordResult {
  passwords: Map<string, string>;
  skipped: Set<string>;
}

type Tab = 'shared' | 'per-file';

export function InsertPdfBatchPasswordPrompt({
  files,
  onSubmit,
  onCancel,
  isProcessing = false,
}: {
  files: InsertBatchPasswordFile[];
  onSubmit: (result: BatchPasswordResult) => void;
  onCancel: () => void;
  isProcessing?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('shared');
  const [sharedPassword, setSharedPassword] = useState('');
  const [perFile, setPerFile] = useState<Record<string, string>>(() =>
    Object.fromEntries(files.map((f) => [f.path, ''])),
  );
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const anyInvalid = useMemo(() => files.some((f) => f.invalid), [files]);

  useEffect(() => {
    setPerFile((prev) => {
      const next: Record<string, string> = {};
      for (const f of files) next[f.path] = f.invalid ? '' : (prev[f.path] ?? '');
      return next;
    });
    setSkipped((prev) => {
      const next = new Set<string>();
      for (const p of prev) if (files.some((f) => f.path === p)) next.add(p);
      return next;
    });
    if (anyInvalid) setSharedPassword('');
  }, [files, anyInvalid]);

  const cancel = () => {
    if (isProcessing) return;
    onCancel();
  };

  const canSubmit = useMemo(() => {
    if (isProcessing || files.length === 0) return false;
    if (files.every((f) => skipped.has(f.path))) return true;
    if (tab === 'shared') return sharedPassword.trim().length > 0;
    return files.every((f) => skipped.has(f.path) || !!perFile[f.path]?.trim());
  }, [tab, sharedPassword, perFile, skipped, files, isProcessing]);

  const submit = () => {
    if (isProcessing) return;
    const passwords = new Map<string, string>();
    const skip = new Set<string>();
    for (const f of files) {
      if (skipped.has(f.path)) {
        skip.add(f.path);
        continue;
      }
      const pw = tab === 'shared' ? sharedPassword : perFile[f.path]?.trim();
      if (tab === 'shared' ? !sharedPassword.trim() : !pw) return;
      passwords.set(f.path, pw ?? '');
    }
    if (passwords.size === 0 && skip.size === 0) return;
    onSubmit({ passwords, skipped: skip });
  };

  const headerTitle =
    files.length === 1
      ? '1 PDF is password-protected'
      : `${files.length} PDFs are password-protected`;

  const toggleSkip = (path: string, checked: boolean) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });

  const renderList = (perFileMode: boolean) => (
    <ul
      aria-label="Locked files"
      class={`border-border-subtle bg-bg-input overflow-y-auto rounded-md border ${
        perFileMode ? 'max-h-[min(420px,55vh)]' : 'max-h-[min(280px,50vh)]'
      }`}
    >
      {files.map((f, index) => {
        const isSkipped = skipped.has(f.path);
        return (
          <li
            key={f.path}
            class={`flex flex-col gap-2 px-3 text-sm ${
              perFileMode ? 'text-fg-primary py-2.5' : 'text-fg-secondary py-2'
            } ${isSkipped ? 'opacity-60' : ''} ${
              index < files.length - 1 ? 'border-border-subtle border-b' : ''
            }`}
          >
            <div class="flex min-w-0 items-center gap-2">
              {f.invalid ? (
                <span role="img" aria-label="Incorrect password" class="flex shrink-0">
                  <WarningOctagonIcon size={16} weight="fill" class="text-state-error" />
                </span>
              ) : (
                <FilePdfIcon size={16} class="text-fg-muted shrink-0" />
              )}
              <span
                class={`min-w-0 flex-1 truncate ${isSkipped ? 'line-through' : ''}`}
                dir="auto"
                title={f.fileName}
              >
                {f.fileName}
              </span>
              <Checkbox
                checked={isSkipped}
                onChange={(checked) => toggleSkip(f.path, checked)}
                label="Skip"
              />
            </div>
            {perFileMode && !isSkipped && (
              <PasswordField
                size="sm"
                aria-label={`Password for ${f.fileName}`}
                value={perFile[f.path] ?? ''}
                invalid={f.invalid}
                disabled={isProcessing}
                onValueChange={(v) => setPerFile((prev) => ({ ...prev, [f.path]: v }))}
                onSubmit={() => {
                  if (canSubmit) submit();
                }}
                placeholder="Password"
              />
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <Modal
      open
      onClose={cancel}
      width="md"
      ariaLabel="Password required"
      dismissOnBackdrop={!isProcessing}
      dismissOnEscape={!isProcessing}
    >
      <ModalHeader closeButton={false}>{headerTitle}</ModalHeader>
      <ModalBody>
        <div class="flex flex-col gap-3">
          {anyInvalid && (
            <Notice tone="danger">Some passwords were incorrect. Update them and try again.</Notice>
          )}

          <SegmentedControl
            options={[
              { value: 'shared', label: 'Use one password' },
              { value: 'per-file', label: 'Different per file' },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === 'shared' && (
            <div class="flex flex-col gap-2.5">
              <p class="text-fg-secondary text-sm">
                {files.length === 1
                  ? 'Enter the password for this PDF.'
                  : 'Enter the password used by all of the locked PDFs.'}
              </p>
              <PasswordField
                aria-label="Password"
                value={sharedPassword}
                invalid={anyInvalid}
                onValueChange={setSharedPassword}
                onSubmit={() => {
                  if (canSubmit) submit();
                }}
                placeholder="Password"
                disabled={isProcessing}
              />
              {renderList(false)}
            </div>
          )}

          {tab === 'per-file' && (
            <div class="flex flex-col gap-2.5">
              <p class="text-fg-secondary text-sm">
                Enter each password below. Toggle Skip on files you don't want to insert.
              </p>
              {renderList(true)}
            </div>
          )}
        </div>
      </ModalBody>
      <ModalActions
        cancelLabel="Cancel All"
        onCancel={cancel}
        cancelDisabled={isProcessing}
        confirmLabel="Insert"
        onConfirm={submit}
        confirmDisabled={!canSubmit}
        confirmLoading={isProcessing}
      />
    </Modal>
  );
}
