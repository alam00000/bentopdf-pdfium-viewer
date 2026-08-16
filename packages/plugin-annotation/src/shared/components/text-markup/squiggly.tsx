import { CSSProperties, MouseEvent } from '@framework';
import { MarkupOrientation, Rect } from '@embedpdf/models';

import { isVerticalMarkup, resolveSegmentOrientation } from './orientation';

type SquigglyProps = {
  /** Stroke/markup color */
  strokeColor?: string;
  opacity?: number;
  segmentRects: Rect[];
  rect?: Rect;
  scale: number;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  style?: CSSProperties;
  /** When true, AP image provides the visual; only render hit area */
  appearanceActive?: boolean;

  strokeWidth?: number;

  pageRotation?: number;

  segmentOrientations?: MarkupOrientation[];
};

type Run = { rect: Rect; orientation: MarkupOrientation };

function mergeLineRuns(segments: Run[]): Run[] {
  const runs: Run[] = [];
  for (const seg of segments) {
    const vertical = isVerticalMarkup(seg.orientation);
    const r = seg.rect;
    const rLo = vertical ? r.origin.y : r.origin.x;
    const rHi = vertical ? r.origin.y + r.size.height : r.origin.x + r.size.width;
    const rC0 = vertical ? r.origin.x : r.origin.y;
    const rC1 = vertical ? r.origin.x + r.size.width : r.origin.y + r.size.height;
    const target = runs.find((run) => {
      if (run.orientation !== seg.orientation) return false;
      const u = run.rect;
      const uLo = vertical ? u.origin.y : u.origin.x;
      const uHi = vertical ? u.origin.y + u.size.height : u.origin.x + u.size.width;
      const uC0 = vertical ? u.origin.x : u.origin.y;
      const uC1 = vertical ? u.origin.x + u.size.width : u.origin.y + u.size.height;
      const overlap = Math.min(rC1, uC1) - Math.max(rC0, uC0);
      if (overlap <= 0.5 * Math.min(rC1 - rC0, uC1 - uC0)) return false;
      const gapLimit = 1.5 * (rC1 - rC0);
      return rLo <= uHi + gapLimit && uLo <= rHi + gapLimit;
    });
    if (target) {
      const u = target.rect;
      const right = Math.max(u.origin.x + u.size.width, r.origin.x + r.size.width);
      const bottom = Math.max(u.origin.y + u.size.height, r.origin.y + r.size.height);
      u.origin.x = Math.min(u.origin.x, r.origin.x);
      u.origin.y = Math.min(u.origin.y, r.origin.y);
      u.size.width = right - u.origin.x;
      u.size.height = bottom - u.origin.y;
    } else {
      runs.push({
        rect: {
          origin: { x: r.origin.x, y: r.origin.y },
          size: { width: r.size.width, height: r.size.height },
        },
        orientation: seg.orientation,
      });
    }
  }
  return runs;
}

export function Squiggly({
  strokeColor,
  opacity = 0.5,
  segmentRects,
  rect,
  scale,
  onClick,
  style,
  appearanceActive = false,
  strokeWidth,
  pageRotation = 0,
  segmentOrientations,
}: SquigglyProps) {
  const resolvedColor = strokeColor ?? '#FFFF00';

  const amplitude = 1.4 * scale;
  const period = 5 * scale;
  const stroke = (strokeWidth ?? 0.9) * scale;
  const bandH = amplitude * 2 + stroke;

  const wavePath = (length: number, alongY: boolean): string => {
    const half = period / 2;
    const c = bandH / 2;
    const pt = (a: number, b: number) => (alongY ? `${b} ${a}` : `${a} ${b}`);
    let d = `M${pt(0, c)}`;
    let a = 0;
    let up = 1;
    while (a < length - 0.01) {
      const hp = Math.min(half, length - a);
      const amp = amplitude * (hp / half);
      const crest = c - up * (4 / 3) * amp;
      d += ` C ${pt(a + hp / 3, crest)} ${pt(a + (2 * hp) / 3, crest)} ${pt(a + hp, c)}`;
      a += hp;
      up = -up;
    }
    return d;
  };

  const toPxX = (x: number) => (rect ? x - rect.origin.x : x) * scale;
  const toPxY = (y: number) => (rect ? y - rect.origin.y : y) * scale;

  const runs = appearanceActive
    ? []
    : mergeLineRuns(
        segmentRects.map((r, i) => ({
          rect: r,
          orientation: resolveSegmentOrientation(segmentOrientations, i, pageRotation),
        })),
      );

  return (
    <>
      {}
      {segmentRects.map((r, i) => (
        <div
          key={`hit-${i}`}
          onPointerDown={onClick}
          style={{
            position: 'absolute',
            left: toPxX(r.origin.x),
            top: toPxY(r.origin.y),
            width: r.size.width * scale,
            height: r.size.height * scale,
            background: 'transparent',
            pointerEvents: onClick ? 'auto' : 'none',
            cursor: onClick ? 'pointer' : 'default',
            zIndex: onClick ? 1 : 0,
            ...style,
          }}
        />
      ))}
      {}
      {runs.map((run, i) => {
        const vertical = isVerticalMarkup(run.orientation);
        const leftPx = toPxX(run.rect.origin.x);
        const topPx = toPxY(run.rect.origin.y);
        const wPx = run.rect.size.width * scale;
        const hPx = run.rect.size.height * scale;
        const lengthPx = vertical ? hPx : wPx;

        const bandStyle: CSSProperties = vertical
          ? {
              top: topPx,
              left:
                run.orientation === MarkupOrientation.VerticalRight
                  ? leftPx + wPx - bandH / 2
                  : leftPx - bandH / 2,
              width: bandH,
              height: hPx,
            }
          : {
              left: leftPx,
              top: topPx + hPx - bandH / 2,
              width: wPx,
              height: bandH,
            };
        return (
          <svg
            key={`wave-${i}`}
            xmlns="http://www.w3.org/2000/svg"
            width={vertical ? bandH : lengthPx}
            height={vertical ? lengthPx : bandH}
            viewBox={`0 0 ${vertical ? bandH : lengthPx} ${vertical ? lengthPx : bandH}`}
            style={{
              position: 'absolute',
              opacity: opacity,
              pointerEvents: 'none',
              overflow: 'visible',
              ...bandStyle,
            }}
          >
            <path
              d={wavePath(lengthPx, vertical)}
              fill="none"
              stroke={resolvedColor}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          </svg>
        );
      })}
    </>
  );
}
