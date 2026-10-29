import { h, ComponentChildren, JSX } from 'preact';

const FRAME = 'rgb(63, 143, 247)';
const HOVER = 'rgba(63, 143, 247, 0.06)';

function frame(dash: number, gap: number): string {
  const run = (dir: string) =>
    `repeating-linear-gradient(${dir}, ${FRAME} 0 ${dash}px, transparent ${dash}px ${dash + gap}px)`;
  return [
    `${run('to right')} top left / 100% 1px no-repeat`,
    `${run('to right')} bottom left / 100% 1px no-repeat`,
    `${run('to bottom')} top left / 1px 100% no-repeat`,
    `${run('to bottom')} top right / 1px 100% no-repeat`,
  ].join(', ');
}

const DASHED = frame(8, 6);
const DOTTED = frame(2, 3);

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function PageRegion({
  rect,
  look = 'dashed',
  highlighted = false,
  'data-testid': testId,
}: {
  rect: Rect;
  look?: 'dashed' | 'dotted' | 'draft';
  highlighted?: boolean;
  'data-testid'?: string;
}) {
  const paint: JSX.CSSProperties =
    look === 'draft'
      ? { border: '1px solid rgba(33, 150, 243, 0.8)', background: 'rgba(33, 150, 243, 0.15)' }
      : {
          background: look === 'dotted' ? DOTTED : DASHED,
          backgroundColor: highlighted ? HOVER : '',
        };
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      class="pointer-events-none absolute box-border"
      style={{ ...rect, ...paint }}
    />
  );
}

export function SelectionFrame({
  rect,
  raise,
  children,
}: {
  rect: Rect;
  raise?: number;
  children?: ComponentChildren;
}) {
  return (
    <div
      aria-hidden="true"
      class="pointer-events-none absolute box-border"
      style={{ ...rect, background: DASHED, zIndex: raise === undefined ? '' : 1 + raise }}
    >
      {children}
    </div>
  );
}

export type SelectionHandlePosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLE_AT: Record<SelectionHandlePosition, [string, string]> = {
  nw: ['0', '0'],
  n: ['50%', '0'],
  ne: ['100%', '0'],
  e: ['100%', '50%'],
  se: ['100%', '100%'],
  s: ['50%', '100%'],
  sw: ['0', '100%'],
  w: ['0', '50%'],
};

type PointerHandler = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => void;

export function SelectionHandle({
  position,
  cursor,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  position: SelectionHandlePosition;
  cursor?: string;
  onPointerDown: PointerHandler;
  onPointerMove?: PointerHandler;
  onPointerUp?: PointerHandler;
  onPointerCancel?: PointerHandler;
}) {
  const [left, top] = HANDLE_AT[position];
  return (
    <div
      data-handle={position}
      class="pointer-events-auto absolute z-[1] flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center select-none"
      style={{ left, top, cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span
        class="box-border h-3 w-3 rounded-full border-[1.5px] border-solid bg-white shadow-sm"
        style={{ borderColor: FRAME }}
      />
    </div>
  );
}
