import { h, ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { Button, IconButton } from '../ds/controls';
import { Menu, PopupMenuItem } from '../ds/floating';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowsDownUpIcon,
  ArrowsSplitIcon,
  CaretDownIcon,
  ClipboardTextIcon,
  FileArrowDownIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  GridFourIcon,
  GridNineIcon,
  ListNumbersIcon,
  ResizeIcon,
  ShuffleIcon,
  TrashIcon,
  XIcon,
} from '../ds/icons';
import { ArrowBackUpIcon } from '../icons/arrow-back-up';
import { ArrowForwardUpIcon } from '../icons/arrow-forward-up';

interface OrganizeToolbarProps {
  pageCount: number;
  selectionCount: number;
  canModifyContents: boolean;
  canExtract: boolean;
  selectionCoversAll: boolean;
  onRotate: (delta: 90 | -90) => void;
  onExtract: () => void;
  onInsertBlank: () => void;
  onAppendFile: () => void;
  onPageLabels: () => void;
  onReverse: () => void;
  onPageSize: () => void;
  onSplit?: () => void;
  onInterleave?: () => void;
  onPasteFromClipboard?: () => void;
  onDelete: () => void;
  columns?: number;
  onColumnsChange?: (next: number) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onClose?: () => void;
}

function ToolLabel({ children }: { children: ComponentChildren }) {
  return <span class="hidden @5xl:inline">{children}</span>;
}

export function OrganizeToolbar({
  pageCount,
  selectionCount,
  canModifyContents,
  canExtract,
  selectionCoversAll,
  onRotate,
  onExtract,
  onInsertBlank,
  onAppendFile,
  onPageLabels,
  onReverse,
  onPageSize,
  onSplit,
  onInterleave,
  onPasteFromClipboard,
  onDelete,
  columns,
  onColumnsChange,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onClose,
}: OrganizeToolbarProps) {
  const hasSelection = selectionCount > 0;
  const rotateDisabled = !canModifyContents || !hasSelection;
  const deleteDisabled = !canModifyContents || !hasSelection || selectionCoversAll;

  return (
    <div class="bg-bg-surface border-border-default relative flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2 @3xl:grid @3xl:h-14 @3xl:grid-cols-[1fr_auto_1fr] @3xl:px-6 @3xl:py-0">
      <div class="flex items-center gap-1 justify-self-start">
        <IconButton
          variant="toolbar"
          aria-label="Rotate Left"
          tooltip="Rotate Left"
          tooltipPosition="bottom"
          onClick={() => onRotate(-90)}
          disabled={rotateDisabled}
        >
          <ArrowCounterClockwiseIcon size={18} />
        </IconButton>
        <IconButton
          variant="toolbar"
          aria-label="Rotate Right"
          tooltip="Rotate Right"
          tooltipPosition="bottom"
          onClick={() => onRotate(90)}
          disabled={rotateDisabled}
        >
          <ArrowClockwiseIcon size={18} />
        </IconButton>

        <span class="bg-border-default mx-2.5 h-6 w-px opacity-70" />

        <IconButton
          variant="danger"
          aria-label="Delete"
          tooltip="Delete"
          tooltipPosition="bottom"
          onClick={onDelete}
          disabled={deleteDisabled}
        >
          <TrashIcon size={18} />
        </IconButton>
      </div>

      <div class="flex items-center gap-1 justify-self-center">
        <Button
          variant="toolbar"
          aria-label="Extract"
          leadingIcon={<FileArrowDownIcon size={18} />}
          tooltip="Extract"
          tooltipPosition="bottom"
          onClick={onExtract}
          disabled={!canExtract}
        >
          <ToolLabel>Extract</ToolLabel>
        </Button>

        <InsertMenu
          disabled={!canModifyContents}
          onAppendFile={onAppendFile}
          onInsertBlank={onInsertBlank}
          onPasteFromClipboard={onPasteFromClipboard}
          onInterleave={onInterleave}
        />
        <Button
          variant="toolbar"
          aria-label="Page Numbers"
          leadingIcon={<ListNumbersIcon size={18} />}
          tooltip="Page Numbering"
          tooltipPosition="bottom"
          onClick={onPageLabels}
          disabled={!canModifyContents}
        >
          <ToolLabel>Page Numbers</ToolLabel>
        </Button>
        <Button
          variant="toolbar"
          aria-label="Reverse"
          leadingIcon={<ArrowsDownUpIcon size={18} />}
          tooltip="Reverse page order"
          tooltipPosition="bottom"
          onClick={onReverse}
          disabled={!canModifyContents || pageCount <= 1}
        >
          <ToolLabel>Reverse</ToolLabel>
        </Button>
        <Button
          variant="toolbar"
          aria-label="Page Size"
          leadingIcon={<ResizeIcon size={18} />}
          tooltip="Page Size"
          tooltipPosition="bottom"
          onClick={onPageSize}
          disabled={!canModifyContents || pageCount === 0}
        >
          <ToolLabel>Page Size</ToolLabel>
        </Button>
        {onSplit && (
          <Button
            variant="toolbar"
            aria-label="Split"
            leadingIcon={<ArrowsSplitIcon size={18} />}
            tooltip="Split into multiple PDFs"
            tooltipPosition="bottom"
            onClick={onSplit}
            disabled={pageCount === 0}
          >
            <ToolLabel>Split</ToolLabel>
          </Button>
        )}
      </div>

      <div class="flex items-center gap-4 justify-self-end">
        {onUndo && onRedo && (
          <div class="flex items-center gap-1">
            <IconButton
              variant="toolbar"
              aria-label="Undo"
              tooltip="Undo"
              tooltipPosition="bottom"
              onClick={onUndo}
              disabled={!canUndo}
            >
              <ArrowBackUpIcon size={18} />
            </IconButton>
            <IconButton
              variant="toolbar"
              aria-label="Redo"
              tooltip="Redo"
              tooltipPosition="bottom"
              onClick={onRedo}
              disabled={!canRedo}
            >
              <ArrowForwardUpIcon size={18} />
            </IconButton>
          </div>
        )}
        {typeof columns === 'number' && onColumnsChange && (
          <div
            class="bg-bg-surface-alt inline-flex items-center gap-0.5 rounded-lg p-0.5"
            role="group"
            aria-label="Thumbnail size"
          >
            <IconButton
              variant="ghost"
              aria-label="Smaller thumbnails"
              tooltip="Smaller thumbnails"
              tooltipPosition="bottom"
              onClick={() => onColumnsChange(Math.min(6, columns + 1))}
              disabled={columns >= 6}
            >
              <GridNineIcon size={18} />
            </IconButton>
            <IconButton
              variant="ghost"
              aria-label="Larger thumbnails"
              tooltip="Larger thumbnails"
              tooltipPosition="bottom"
              onClick={() => onColumnsChange(Math.max(2, columns - 1))}
              disabled={columns <= 2}
            >
              <GridFourIcon size={18} />
            </IconButton>
          </div>
        )}

        <span class="text-fg-secondary text-sm whitespace-nowrap tabular-nums">
          {selectionCount > 0
            ? `${selectionCount} of ${pageCount} selected`
            : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`}
        </span>
        {onClose && (
          <IconButton
            variant="toolbar"
            aria-label="Close Organize"
            tooltip="Close Organize"
            tooltipPosition="bottom"
            onClick={onClose}
          >
            <XIcon size={18} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function InsertMenu({
  disabled,
  onAppendFile,
  onInsertBlank,
  onPasteFromClipboard,
  onInterleave,
}: {
  disabled: boolean;
  onAppendFile: () => void;
  onInsertBlank: () => void;
  onPasteFromClipboard?: () => void;
  onInterleave?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <div class="relative">
      <Button
        ref={triggerRef}
        variant="toolbar"
        aria-label="Insert"
        leadingIcon={<FilePlusIcon size={18} />}
        trailingIcon={
          <CaretDownIcon
            size={12}
            weight="bold"
            class={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        }
        tooltip="Insert"
        tooltipPosition="bottom"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
      >
        <ToolLabel>Insert</ToolLabel>
      </Button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        side="bottom"
        align="start"
        class="min-w-[232px]"
      >
        <PopupMenuItem
          icon={<FolderIcon size={16} />}
          onClick={() => pick(onAppendFile)}
          label="From File…"
        />
        <PopupMenuItem
          icon={<FileIcon size={16} />}
          onClick={() => pick(onInsertBlank)}
          label="Blank Page…"
        />
        {onPasteFromClipboard && (
          <PopupMenuItem
            icon={<ClipboardTextIcon size={16} />}
            onClick={() => pick(onPasteFromClipboard)}
            label="From Clipboard…"
          />
        )}
        {onInterleave && (
          <PopupMenuItem
            icon={<ShuffleIcon size={16} />}
            onClick={() => pick(onInterleave)}
            label="Alternate Merge…"
          />
        )}
      </Menu>
    </div>
  );
}
