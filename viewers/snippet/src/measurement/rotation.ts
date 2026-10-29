export interface FieldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pageQuarterTurns(quarterTurns: unknown): 0 | 1 | 2 | 3 {
  if (typeof quarterTurns !== 'number' || !Number.isFinite(quarterTurns)) return 0;
  return (((Math.round(quarterTurns) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

export function screenDeltaToPage(
  dx: number,
  dy: number,
  quarterTurns: unknown,
): { dx: number; dy: number } {
  switch (pageQuarterTurns(quarterTurns)) {
    case 1:
      return { dx: dy, dy: -dx };
    case 2:
      return { dx: -dx, dy: -dy };
    case 3:
      return { dx: -dy, dy: dx };
    default:
      return { dx, dy };
  }
}

export function screenPointToPage(
  localX: number,
  localY: number,
  displayW: number,
  displayH: number,
  quarterTurns: unknown,
): { x: number; y: number } {
  switch (pageQuarterTurns(quarterTurns)) {
    case 1:
      return { x: localY, y: displayW - localX };
    case 2:
      return { x: displayW - localX, y: displayH - localY };
    case 3:
      return { x: displayH - localY, y: localX };
    default:
      return { x: localX, y: localY };
  }
}

export function fieldLabelAnchor(
  rect: FieldRect,
  scale: number,
  quarterTurns: unknown,
  extraTransform = '',
): { left: number; top: number; transform: string; transformOrigin: string } {
  const q = pageQuarterTurns(quarterTurns);
  const x = rect.x * scale;
  const y = rect.y * scale;
  const w = rect.w * scale;
  const h = rect.h * scale;
  const corner =
    q === 1
      ? { left: x, top: y + h }
      : q === 2
        ? { left: x + w, top: y + h }
        : q === 3
          ? { left: x + w, top: y }
          : { left: x, top: y };
  const turn = q === 0 ? '' : `rotate(-${q * 90}deg)`;
  return {
    ...corner,
    transform: [turn, extraTransform].filter(Boolean).join(' '),
    transformOrigin: '0 0',
  };
}

const HANDLE_RING = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type ResizeHandle = (typeof HANDLE_RING)[number];
export function handleOnScreen(handle: ResizeHandle, quarterTurns: unknown): ResizeHandle {
  const i = HANDLE_RING.indexOf(handle);
  return HANDLE_RING[(i + 2 * pageQuarterTurns(quarterTurns)) % 8]!;
}
