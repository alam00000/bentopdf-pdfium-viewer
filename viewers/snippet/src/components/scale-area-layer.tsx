import { useDocumentState, useRegistry } from '@embedpdf/core/preact';
import { h, JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { pinCursorOf } from '../measurement/gesture-cursor';
import { useMeasurePointer } from '../measurement/measure-pointer';
import {
  fieldLabelAnchor,
  handleOnScreen,
  pageQuarterTurns,
  screenPointToPage,
  type ResizeHandle,
} from '../measurement/rotation';
import {
  bringScaleAreaToFront,
  locateScaleArea,
  moveScaleArea,
  removeScaleArea,
} from '../measurement/scale-area-edits';
import {
  openScaleAreaDialog,
  selectScaleArea,
  useScaleAreaTool,
} from '../measurement/scale-area-tool';
import {
  getViewportCount,
  scaleAreaLabel,
  useScaleAreas,
  type ScaleArea,
} from '../measurement/scale-areas';
import { areaAt, toPageRect, toUserBox } from '../measurement/scale-context';
import {
  getCalibrationState,
  getPendingMode,
  subscribeCalibration,
  subscribePendingMode,
} from '../measurement/scale-store';
import { Badge } from '../measurement/ui/controls';
import { PopupMenu, PopupMenuDivider, PopupMenuItem } from '../measurement/ui/floating';
import { CopyIcon, PencilSimpleIcon, StackIcon, TrashIcon } from '../measurement/ui/icons';
import {
  PageRegion,
  SelectionFrame,
  SelectionHandle,
  type SelectionHandlePosition,
} from '../measurement/ui/page';

interface Props {
  documentId: string;
  pageIndex: number;
}

const MIN_DRAG_PX = 6;
const MIN_SIDE = 4;
const LABEL_H = 16;
const LABEL_GAP = 4;
const LABEL_INSET = 12;

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const RESIZE_CURSOR: Record<ResizeHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Drag =
  | { kind: 'draw'; x0: number; y0: number; x1: number; y1: number; sx: number; sy: number }
  | {
      kind: 'move';
      area: ScaleArea;
      from: PageRect;
      px: number;
      py: number;
      sx: number;
      sy: number;
      rect: PageRect;
    }
  | {
      kind: 'resize';
      area: ScaleArea;
      handle: ResizeHandle;
      from: PageRect;
      px: number;
      py: number;
      rect: PageRect;
    };

function useMeasuring(documentId: string): { measuring: boolean; calibrating: boolean } {
  const read = () => {
    const calibrating = getCalibrationState(documentId).phase !== 'idle';
    return { measuring: calibrating || getPendingMode(documentId) !== null, calibrating };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () =>
      setState((prev) => {
        const next = read();
        return prev.measuring === next.measuring && prev.calibrating === next.calibrating
          ? prev
          : next;
      });
    update();
    const a = subscribePendingMode(documentId, update);
    const b = subscribeCalibration(documentId, update);
    return () => {
      a();
      b();
    };
  }, [documentId]);
  return state;
}

function startRange(start: number, size: number, extent: number): [number, number] {
  return [Math.min(start, 0), Math.max(start, extent - size)];
}

function moved(from: PageRect, dx: number, dy: number, pageW: number, pageH: number): PageRect {
  const [x0, x1] = startRange(from.x, from.w, pageW);
  const [y0, y1] = startRange(from.y, from.h, pageH);
  return {
    ...from,
    x: Math.min(Math.max(x0, from.x + dx), x1),
    y: Math.min(Math.max(y0, from.y + dy), y1),
  };
}

function resized(
  from: PageRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  pageW: number,
  pageH: number,
): PageRect {
  let left = from.x;
  let top = from.y;
  let right = from.x + from.w;
  let bottom = from.y + from.h;
  if (handle.includes('w'))
    left = Math.min(Math.max(Math.min(0, from.x), left + dx), right - MIN_SIDE);
  if (handle.includes('e'))
    right = Math.max(Math.min(Math.max(pageW, right), right + dx), left + MIN_SIDE);
  if (handle.includes('n'))
    top = Math.min(Math.max(Math.min(0, from.y), top + dy), bottom - MIN_SIDE);
  if (handle.includes('s'))
    bottom = Math.max(Math.min(Math.max(pageH, bottom), bottom + dy), top + MIN_SIDE);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const inside = (r: PageRect, p: { x: number; y: number }) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export function ScaleAreaLayer({ documentId, pageIndex }: Props) {
  const { registry } = useRegistry();
  const docState = useDocumentState(documentId);
  const page = docState?.document?.pages?.[pageIndex];
  const scale = docState?.scale ?? 1;
  const pageW = page?.size?.width ?? 0;
  const pageH = page?.size?.height ?? 0;
  const quarter = pageQuarterTurns((page?.rotation ?? 0) + (docState?.rotation ?? 0));

  const tool = useScaleAreaTool(documentId);
  const { measuring, calibrating } = useMeasuring(documentId);
  const areas = useScaleAreas(documentId, pageIndex);
  const pointer = useMeasurePointer();
  const visible = tool.armed || measuring;
  const interactive = tool.armed && !calibrating;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [held, setHeld] = useState<{ index: number; rect: PageRect } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; area: ScaleArea } | null>(null);
  const [hoverCursor, setHoverCursor] = useState<'move' | 'pointer' | 'crosshair'>('crosshair');
  useEffect(() => {
    setHeld(null);
    setMenu(null);
  }, [areas]);
  useEffect(() => {
    if (!interactive) {
      dragRef.current = null;
      setDrag(null);
      setMenu(null);
    }
  }, [interactive]);

  const updateDrag = (d: Drag | null): void => {
    dragRef.current = d;
    setDrag(d);
  };

  const rects = useMemo(
    () =>
      areas
        .map((a) => ({ area: a, rect: toPageRect(documentId, pageIndex, a.box, pageH) }))
        .filter((r): r is { area: ScaleArea; rect: PageRect } => r.rect !== null),
    [areas, documentId, pageIndex, pageH],
  );

  if (!visible || pageW <= 0 || pageH <= 0) return null;

  const pagePoint = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const el = rootRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const p = screenPointToPage(e.clientX - r.left, e.clientY - r.top, r.width, r.height, quarter);
    const s = (quarter % 2 === 1 ? r.height : r.width) / pageW;
    if (!(s > 0)) return null;
    return { x: p.x / s, y: p.y / s };
  };

  const selected =
    tool.selected && tool.selected.pageIndex === pageIndex
      ? (areas.find((a) => a.index === tool.selected!.index) ?? null)
      : null;
  const editable = (a: ScaleArea) => a.kind !== 'other';

  const live = (area: ScaleArea, rect: PageRect): PageRect => {
    if ((drag?.kind === 'move' || drag?.kind === 'resize') && drag.area.index === area.index)
      return drag.rect;
    if (held && held.index === area.index) return held.rect;
    return rect;
  };
  const selectedBase = selected ? (rects.find((r) => r.area === selected)?.rect ?? null) : null;
  const selectedRect = selected && selectedBase ? live(selected, selectedBase) : null;

  const hit = (p: { x: number; y: number }): ScaleArea | null => {
    for (let i = rects.length - 1; i >= 0; i--) {
      if (inside(rects[i]!.rect, p)) return rects[i]!.area;
    }
    return null;
  };

  const capture = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    pinCursorOf(e.currentTarget, e.pointerId);
  };

  const onRootPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!interactive || (typeof e.button === 'number' && e.button !== 0)) return;
    const p = pagePoint(e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    if (selected && selectedRect && editable(selected) && inside(selectedRect, p)) {
      updateDrag({
        kind: 'move',
        area: selected,
        from: selectedRect,
        px: p.x,
        py: p.y,
        sx: e.clientX,
        sy: e.clientY,
        rect: selectedRect,
      });
    } else {
      const x = Math.min(Math.max(0, p.x), pageW);
      const y = Math.min(Math.max(0, p.y), pageH);
      updateDrag({ kind: 'draw', x0: x, y0: y, x1: x, y1: y, sx: e.clientX, sy: e.clientY });
    }
    capture(e);
  };

  const onHandleDown =
    (area: ScaleArea, rect: PageRect, handle: ResizeHandle) =>
    (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      if (typeof e.button === 'number' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const p = pagePoint(e);
      if (!p) return;
      updateDrag({ kind: 'resize', area, handle, from: rect, px: p.x, py: p.y, rect });
      capture(e);
    };

  const onPointerMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const p = pagePoint(e);
    if (!p) return;
    if (!d) {
      setHoverCursor(
        selected && selectedRect && editable(selected) && inside(selectedRect, p)
          ? 'move'
          : hit(p)
            ? 'pointer'
            : 'crosshair',
      );
      return;
    }
    if (d.kind === 'draw') {
      updateDrag({
        ...d,
        x1: Math.min(Math.max(0, p.x), pageW),
        y1: Math.min(Math.max(0, p.y), pageH),
      });
    } else if (d.kind === 'move') {
      updateDrag({ ...d, rect: moved(d.from, p.x - d.px, p.y - d.py, pageW, pageH) });
    } else {
      updateDrag({
        ...d,
        rect: resized(d.from, d.handle, p.x - d.px, p.y - d.py, pageW, pageH),
      });
    }
  };

  const onPointerUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    updateDrag(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    const click =
      d.kind !== 'resize' &&
      Math.abs(e.clientX - d.sx) < MIN_DRAG_PX &&
      Math.abs(e.clientY - d.sy) < MIN_DRAG_PX;
    if (click) {
      const p = pagePoint(e);
      const area = p ? hit(p) : null;
      selectScaleArea(documentId, area ? { pageIndex, index: area.index } : null);
      return;
    }
    if (d.kind === 'draw') {
      const rect = {
        x: Math.min(d.x0, d.x1),
        y: Math.min(d.y0, d.y1),
        w: Math.abs(d.x1 - d.x0),
        h: Math.abs(d.y1 - d.y0),
      };
      const box =
        rect.w >= MIN_SIDE && rect.h >= MIN_SIDE
          ? toUserBox(documentId, pageIndex, rect, pageH)
          : null;
      if (box) {
        selectScaleArea(documentId, null);
        openScaleAreaDialog(documentId, { kind: 'new', pageIndex, box });
      }
      return;
    }
    const same =
      Math.abs(d.rect.x - d.from.x) < 1e-3 &&
      Math.abs(d.rect.y - d.from.y) < 1e-3 &&
      Math.abs(d.rect.w - d.from.w) < 1e-3 &&
      Math.abs(d.rect.h - d.from.h) < 1e-3;
    if (same) return;
    const box = toUserBox(documentId, pageIndex, d.rect, pageH);
    if (!box) return;
    setHeld({ index: d.area.index, rect: d.rect });
    void moveScaleArea(registry, documentId, d.area, box).then((ok) => {
      if (!ok) setHeld(null);
    });
  };

  const onPointerCancel = () => updateDrag(null);

  const onDblClick = (e: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const p = pagePoint(e);
    const area = p ? hit(p) : null;
    if (!area || !editable(area)) return;
    e.stopPropagation();
    openScaleAreaDialog(documentId, { kind: 'edit', area });
  };

  const onContextMenu = (e: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const p = pagePoint(e);
    const area = p ? hit(p) : null;
    if (!area) return;
    e.preventDefault();
    e.stopPropagation();
    selectScaleArea(documentId, { pageIndex, index: area.index });
    setMenu({ x: e.clientX, y: e.clientY, area });
  };

  const hover =
    pointer && pointer.documentId === documentId && pointer.pageIndex === pageIndex && !tool.armed
      ? areaAt(documentId, pageIndex, pointer)
      : null;

  const css = (r: PageRect) => ({
    left: r.x * scale,
    top: r.y * scale,
    width: Math.max(1, r.w * scale),
    height: Math.max(1, r.h * scale),
  });

  const draft = (() => {
    if (drag?.kind === 'draw') {
      return {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        w: Math.abs(drag.x1 - drag.x0),
        h: Math.abs(drag.y1 - drag.y0),
      };
    }
    if (tool.dialog?.kind === 'new' && tool.dialog.pageIndex === pageIndex) {
      return toPageRect(documentId, pageIndex, tool.dialog.box, pageH);
    }
    return null;
  })();

  const menuArea = (): ScaleArea | null => (menu ? locateScaleArea(documentId, menu.area) : null);

  return (
    <div
      ref={rootRef}
      class={`absolute inset-0 z-[100] ${interactive ? 'touch-none' : 'pointer-events-none'}`}
      style={interactive ? { cursor: hoverCursor } : undefined}
      data-testid={`scale-area-layer-${pageIndex}`}
      onPointerDown={onRootPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDblClick={onDblClick}
      onContextMenu={onContextMenu}
    >
      {rects.map(({ area, rect }) =>
        interactive && selected?.index === area.index ? null : (
          <PageRegion
            key={area.index}
            rect={css(live(area, rect))}
            look={area.kind === 'scale' ? 'dashed' : 'dotted'}
            highlighted={hover?.index === area.index}
            data-testid="scale-area"
          />
        ),
      )}
      {rects.map(({ area, rect }) => {
        const r = live(area, rect);
        const turned = quarter % 2 === 1;
        const roomAbove =
          (quarter === 0
            ? r.y
            : quarter === 1
              ? r.x
              : quarter === 2
                ? pageH - (r.y + r.h)
                : pageW - (r.x + r.w)) * scale;
        const onScreenH = (turned ? r.w : r.h) * scale;
        const place =
          roomAbove >= LABEL_H + LABEL_GAP
            ? `translate(${LABEL_INSET}px, calc(-100% - ${LABEL_GAP}px))`
            : `translate(${LABEL_INSET}px, ${onScreenH + LABEL_GAP}px)`;
        const anchor = fieldLabelAnchor(r, scale, quarter, place);
        return (
          <div
            key={`label-${area.index}`}
            class="pointer-events-none absolute"
            style={{
              ...anchor,
              maxWidth: Math.max(24, (turned ? r.h : r.w) * scale - LABEL_INSET),
            }}
            data-testid="scale-area-label"
            data-place={roomAbove >= LABEL_H + LABEL_GAP ? 'above' : 'below'}
          >
            <Badge tone="brand" size="sm" icon={null} class="max-w-full">
              <span class="min-w-0 truncate">{scaleAreaLabel(area)}</span>
            </Badge>
          </div>
        );
      })}
      {draft ? <PageRegion rect={css(draft)} look="draft" data-testid="scale-area-draft" /> : null}
      {interactive && selected && selectedRect ? (
        <SelectionFrame
          rect={{
            left: selectedRect.x * scale - 0.5,
            top: selectedRect.y * scale - 0.5,
            width: selectedRect.w * scale + 1,
            height: selectedRect.h * scale + 1,
          }}
          raise={2}
        >
          {editable(selected)
            ? HANDLES.map((handle) => (
                <SelectionHandle
                  key={handle}
                  position={handle as SelectionHandlePosition}
                  cursor={RESIZE_CURSOR[handleOnScreen(handle, quarter)]}
                  onPointerDown={onHandleDown(selected, selectedRect, handle)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancel}
                />
              ))
            : null}
        </SelectionFrame>
      ) : null}
      {menu ? (
        <PopupMenu
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          aria-label="Scale area"
        >
          <PopupMenuItem
            icon={<PencilSimpleIcon size={14} weight="regular" />}
            label="Edit…"
            disabled={!editable(menu.area)}
            onClick={() => {
              const area = menuArea();
              if (area) openScaleAreaDialog(documentId, { kind: 'edit', area });
            }}
          />
          <PopupMenuItem
            icon={<StackIcon size={14} weight="regular" />}
            label="Bring to Front"
            disabled={menu.area.index >= getViewportCount(documentId, pageIndex) - 1}
            onClick={() => {
              const area = menuArea();
              if (!area) return;
              void bringScaleAreaToFront(registry, documentId, area).then((index) => {
                if (index != null) selectScaleArea(documentId, { pageIndex, index });
              });
            }}
          />
          <PopupMenuItem
            icon={<CopyIcon size={14} weight="regular" />}
            label="Copy to Pages…"
            onClick={() => {
              const area = menuArea();
              if (area) openScaleAreaDialog(documentId, { kind: 'copy', area });
            }}
          />
          <PopupMenuDivider />
          <PopupMenuItem
            icon={<TrashIcon size={14} weight="regular" />}
            label="Delete"
            shortcut={['Backspace']}
            destructive
            onClick={() => {
              const area = menuArea();
              if (!area) return;
              selectScaleArea(documentId, null);
              void removeScaleArea(registry, documentId, area);
            }}
          />
        </PopupMenu>
      ) : null}
    </div>
  );
}
