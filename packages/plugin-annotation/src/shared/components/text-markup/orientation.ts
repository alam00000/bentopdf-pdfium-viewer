import { CSSProperties } from '@framework';
import { MarkupOrientation } from '@embedpdf/models';

export function orientationFromPageRotation(pageRotation: number): MarkupOrientation {
  const r = ((Math.round(pageRotation) % 4) + 4) % 4;
  if (r === 1) return MarkupOrientation.VerticalRight;
  if (r === 3) return MarkupOrientation.VerticalLeft;
  return MarkupOrientation.Horizontal;
}

export function resolveSegmentOrientation(
  segmentOrientations: MarkupOrientation[] | undefined,
  index: number,
  pageRotation: number,
): MarkupOrientation {
  const stored = segmentOrientations?.[index];
  return stored ?? orientationFromPageRotation(pageRotation);
}

export function isVerticalMarkup(orientation: MarkupOrientation): boolean {
  return (
    orientation === MarkupOrientation.VerticalRight ||
    orientation === MarkupOrientation.VerticalLeft
  );
}

export function strikeRuleStyle(orientation: MarkupOrientation, thickness: number): CSSProperties {
  return isVerticalMarkup(orientation)
    ? { top: 0, left: '50%', width: thickness, height: '100%', transform: 'translateX(-50%)' }
    : { left: 0, top: '50%', width: '100%', height: thickness, transform: 'translateY(-50%)' };
}

export function baselineEdgeStyle(orientation: MarkupOrientation, cross: number): CSSProperties {
  switch (orientation) {
    case MarkupOrientation.VerticalRight:
      return { top: 0, right: 0, width: cross, height: '100%' };
    case MarkupOrientation.VerticalLeft:
      return { top: 0, left: 0, width: cross, height: '100%' };
    case MarkupOrientation.Horizontal:
    default:
      return { bottom: 0, left: 0, width: '100%', height: cross };
  }
}
