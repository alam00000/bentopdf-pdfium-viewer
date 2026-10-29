export interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1]!, points[i]!);
  }
  return total;
}

export function polygonPerimeter(points: readonly Point[]): number {
  if (points.length < 2) return 0;
  let total = polylineLength(points);
  total += distance(points[points.length - 1]!, points[0]!);
  return total;
}

export function polygonArea(points: readonly Point[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

export function bboxCenter(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let minX = points[0]!.x;
  let maxX = points[0]!.x;
  let minY = points[0]!.y;
  let maxY = points[0]!.y;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5 };
}

export function polylineCaptionAnchor(points: readonly Point[], offsetPdfPt = 12): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0]! };

  let bestLen = -1;
  let bestI = 0;
  for (let i = 1; i < points.length; i++) {
    const len = distance(points[i - 1]!, points[i]!);
    if (len > bestLen) {
      bestLen = len;
      bestI = i;
    }
  }
  const a = points[bestI - 1]!;
  const b = points[bestI]!;
  const m = midpoint(a, b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return { x: m.x + nx * offsetPdfPt, y: m.y + ny * offsetPdfPt };
}

export function angleDeg(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

export interface RectXY {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}

export function aabbFromPoints(points: readonly Point[], pad = 0): RectXY {
  if (points.length === 0) {
    return { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } };
  }
  let minX = points[0]!.x;
  let maxX = points[0]!.x;
  let minY = points[0]!.y;
  let maxY = points[0]!.y;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    origin: { x: minX - pad, y: minY - pad },
    size: { width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 },
  };
}

export function unionRects(a: RectXY, b: RectXY): RectXY {
  const aRight = a.origin.x + a.size.width;
  const aBottom = a.origin.y + a.size.height;
  const bRight = b.origin.x + b.size.width;
  const bBottom = b.origin.y + b.size.height;
  const x = Math.min(a.origin.x, b.origin.x);
  const y = Math.min(a.origin.y, b.origin.y);
  const right = Math.max(aRight, bRight);
  const bottom = Math.max(aBottom, bBottom);
  return {
    origin: { x, y },
    size: { width: right - x, height: bottom - y },
  };
}

export function captionPillSize(
  text: string,
  fontSizePt = 11,
): {
  width: number;
  height: number;
} {
  const width = (text.length || 1) * fontSizePt * 0.55 + 6;
  const height = fontSizePt * 1.2 + 2;
  return { width, height };
}

export function perpendicularUnit(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return { x: 0, y: 0 };
  return { x: -dy / len, y: dx / len };
}
