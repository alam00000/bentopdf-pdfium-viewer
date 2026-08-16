import { CSSProperties, MouseEvent } from '@framework';
import { MarkupOrientation, Rect } from '@embedpdf/models';

import { strikeRuleStyle, resolveSegmentOrientation } from './orientation';

type StrikeoutProps = {
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

export function Strikeout({
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
}: StrikeoutProps) {
  const resolvedColor = strokeColor ?? '#FFFF00';
  const thickness = (strokeWidth ?? 1.6) * scale;

  return (
    <>
      {segmentRects.map((r, i) => {

        const orientation = resolveSegmentOrientation(segmentOrientations, i, pageRotation);
        const ruleStyle = strikeRuleStyle(orientation, thickness);
        return (
        <div
          key={i}
          onPointerDown={onClick}
          style={{
            position: 'absolute',
            left: (rect ? r.origin.x - rect.origin.x : r.origin.x) * scale,
            top: (rect ? r.origin.y - rect.origin.y : r.origin.y) * scale,
            width: r.size.width * scale,
            height: r.size.height * scale,
            background: 'transparent',
            pointerEvents: onClick ? 'auto' : 'none',
            cursor: onClick ? 'pointer' : 'default',
            zIndex: onClick ? 1 : 0,
            ...style,
          }}
        >
          {}
          {!appearanceActive && (
            <div
              style={{
                position: 'absolute',
                background: resolvedColor,
                opacity: opacity,
                pointerEvents: 'none',
                ...ruleStyle,
              }}
            />
          )}
        </div>
        );
      })}
    </>
  );
}
