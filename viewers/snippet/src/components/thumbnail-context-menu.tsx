import { h } from 'preact';

import { PopupMenu, PopupMenuDivider, PopupMenuItem, PopupMenuSubmenu } from './ds/floating';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  ClipboardIcon,
  CopyIcon,
  CopySimpleIcon,
  FilePdfIcon,
  FilePlusIcon,
  ImageIcon,
  PlusIcon,
  ScissorsIcon,
  TrashIcon,
} from './ds/icons';

export type ThumbnailContextMenuState = {
  x: number;
  y: number;
  anchorPageIndex: number;
  selection: number[];
};

export type ThumbnailContextMenuCaps = {
  pageCount: number;
  canModifyContents: boolean;
  canExtract: boolean;
  canCopyPages: boolean;
  clipboardHasContent: boolean;
};

export type ThumbnailContextMenuActions = {
  rotateClockwise: () => void;
  rotateCounterClockwise: () => void;
  insertBlankAfter: () => void;
  insertFromFileAfter: () => void;
  replace: () => void;
  extractAsPdf: () => void;
  extractAsImage: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  duplicate: () => void;
  remove: () => void;
};

export function ThumbnailContextMenu({
  state,
  caps,
  actions,
  onClose,
}: {
  state: ThumbnailContextMenuState;
  caps: ThumbnailContextMenuCaps;
  actions: ThumbnailContextMenuActions;
  onClose: () => void;
}) {
  const selSize = state.selection.length;
  const isSingle = selSize === 1;
  const coversAll = selSize >= caps.pageCount;

  const rotateDisabled = !caps.canModifyContents || selSize === 0;
  const insertDisabled = !caps.canModifyContents || !isSingle;
  const extractDisabled = !caps.canExtract || selSize === 0;

  return (
    <PopupMenu position={{ x: state.x, y: state.y }} onClose={onClose} aria-label="Page actions">
      <PopupMenuItem
        icon={<ArrowCounterClockwiseIcon size={14} />}
        label="Rotate Left"
        shortcut={['Shift', 'R']}
        disabled={rotateDisabled}
        onClick={actions.rotateCounterClockwise}
      />
      <PopupMenuItem
        icon={<ArrowClockwiseIcon size={14} />}
        label="Rotate Right"
        shortcut={['R']}
        disabled={rotateDisabled}
        onClick={actions.rotateClockwise}
      />

      <PopupMenuDivider />

      <PopupMenuSubmenu icon={<PlusIcon size={14} />} label="Insert" disabled={insertDisabled}>
        <PopupMenuItem
          icon={<PlusIcon size={14} />}
          label="Blank Page After"
          disabled={insertDisabled}
          onClick={actions.insertBlankAfter}
        />
        <PopupMenuItem
          icon={<FilePlusIcon size={14} />}
          label="From File After…"
          disabled={insertDisabled}
          onClick={actions.insertFromFileAfter}
        />
        <PopupMenuItem
          icon={<ArrowsClockwiseIcon size={14} />}
          label="Replace…"
          disabled={insertDisabled}
          onClick={actions.replace}
        />
      </PopupMenuSubmenu>

      <PopupMenuSubmenu icon={<FilePdfIcon size={14} />} label="Extract" disabled={extractDisabled}>
        <PopupMenuItem
          icon={<FilePdfIcon size={14} />}
          label="As PDF…"
          disabled={extractDisabled}
          onClick={actions.extractAsPdf}
        />
        <PopupMenuItem
          icon={<ImageIcon size={14} />}
          label="As Image…"
          disabled={extractDisabled}
          onClick={actions.extractAsImage}
        />
      </PopupMenuSubmenu>

      <PopupMenuDivider />

      <PopupMenuItem
        icon={<ScissorsIcon size={14} />}
        label="Cut"
        shortcut={['Mod', 'X']}
        disabled={!caps.canModifyContents || selSize === 0 || coversAll}
        onClick={actions.cut}
      />
      <PopupMenuItem
        icon={<CopyIcon size={14} />}
        label="Copy"
        shortcut={['Mod', 'C']}
        disabled={!caps.canCopyPages || selSize === 0}
        onClick={actions.copy}
      />
      <PopupMenuItem
        icon={<ClipboardIcon size={14} />}
        label="Paste"
        shortcut={['Mod', 'V']}
        disabled={!caps.canModifyContents || !caps.clipboardHasContent}
        onClick={actions.paste}
      />
      <PopupMenuItem
        icon={<CopySimpleIcon size={14} />}
        label="Duplicate"
        shortcut={['Mod', 'D']}
        disabled={!caps.canModifyContents || selSize === 0}
        onClick={actions.duplicate}
      />

      <PopupMenuDivider />

      <PopupMenuItem
        icon={<TrashIcon size={14} />}
        label="Delete"
        shortcut={['Backspace']}
        destructive
        disabled={!caps.canModifyContents || selSize === 0 || coversAll}
        onClick={actions.remove}
      />
    </PopupMenu>
  );
}
