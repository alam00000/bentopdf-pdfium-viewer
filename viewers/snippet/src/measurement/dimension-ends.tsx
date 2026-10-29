import { h, Fragment } from 'preact';
import { patching } from '@embedpdf/plugin-annotation';
import type { LineEndings, Position } from '@embedpdf/models';
import { DIMENSION_TICK_HALF } from './transforms';

const STROKE = { pointerEvents: 'none', strokeLinecap: 'butt' } as const;
const ARROW = { ...STROKE, strokeLinejoin: 'bevel' } as const;

export function DimensionTick({
  at,
  nx,
  ny,
  strokeWidth,
  color,
}: {
  at: Position;
  nx: number;
  ny: number;
  strokeWidth: number;
  color: string;
}) {
  return (
    <line
      x1={at.x - nx * DIMENSION_TICK_HALF}
      y1={at.y - ny * DIMENSION_TICK_HALF}
      x2={at.x + nx * DIMENSION_TICK_HALF}
      y2={at.y + ny * DIMENSION_TICK_HALF}
      stroke={color}
      strokeWidth={strokeWidth}
      vectorEffect="non-scaling-stroke"
      style={STROKE}
    />
  );
}

export function DimensionEnds({
  a,
  b,
  endings,
  strokeWidth,
  color,
}: {
  a: Position;
  b: Position;
  endings: LineEndings | undefined;
  strokeWidth: number;
  color: string;
}) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dy / len;
  const ny = -dx / len;
  const angle = Math.atan2(dy, dx);
  const heads = endings
    ? [
        patching.createEnding(endings.start, strokeWidth, angle + Math.PI, a.x, a.y),
        patching.createEnding(endings.end, strokeWidth, angle, b.x, b.y),
      ]
    : [];
  return (
    <>
      {heads.map(
        (head, i) =>
          head && (
            <path
              key={i}
              d={head.d}
              transform={head.transform}
              fill={head.filled ? color : 'none'}
              stroke={color}
              strokeWidth={strokeWidth}
              vectorEffect="non-scaling-stroke"
              style={ARROW}
            />
          ),
      )}
      <DimensionTick at={a} nx={nx} ny={ny} strokeWidth={strokeWidth} color={color} />
      <DimensionTick at={b} nx={nx} ny={ny} strokeWidth={strokeWidth} color={color} />
    </>
  );
}
