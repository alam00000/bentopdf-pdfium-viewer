export type ArrowDir = 'left' | 'right' | 'up' | 'down';

export type HomeEndKind = 'row-start' | 'row-end' | 'doc-start' | 'doc-end';

function clampIndex(i: number, total: number): number {
  return Math.max(0, Math.min(total - 1, i));
}

export function nextLeadIndex(
  current: number,
  dir: ArrowDir,
  columns: number,
  total: number,
): number {
  if (total <= 0) return current;
  const cols = Math.max(1, Math.floor(columns));
  const i = clampIndex(current, total);
  const lastIndex = total - 1;
  const col = i % cols;

  switch (dir) {
    case 'left':
      return col === 0 ? i : i - 1;

    case 'right':
      if (col === cols - 1) return i;
      if (i + 1 > lastIndex) return i;
      return i + 1;

    case 'up': {
      const t = i - cols;
      return t < 0 ? i : t;
    }

    case 'down': {
      const t = i + cols;
      if (t <= lastIndex) return t;
      const lastRowStart = lastIndex - (lastIndex % cols);
      if (i >= lastRowStart) return i;
      return lastIndex;
    }
  }
  return i;
}

export function homeEndTarget(
  current: number,
  kind: HomeEndKind,
  columns: number,
  total: number,
): number {
  if (total <= 0) return current;
  const cols = Math.max(1, Math.floor(columns));
  const i = clampIndex(current, total);
  const lastIndex = total - 1;

  switch (kind) {
    case 'doc-start':
      return 0;
    case 'doc-end':
      return lastIndex;
    case 'row-start':
      return i - (i % cols);
    case 'row-end':
      return Math.min(i - (i % cols) + cols - 1, lastIndex);
  }
  return i;
}
