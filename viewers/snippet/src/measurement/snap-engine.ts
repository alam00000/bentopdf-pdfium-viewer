import type { PdfPathSegments } from '@embedpdf/models';
import type { SnapKind, SnapSettings } from './snap-settings';
import { engineFor } from './engine-bridge';

export interface SnapResult {
  kind: SnapKind;
  pdfX: number;
  pdfY: number;
  label: string;
  distance: number;
}

export interface BeginOptions {
  documentId: string;
  pageIndex: number;
  pageMinX: number;
  pageMinY: number;
  pageMaxX: number;
  pageMaxY: number;
  settings: SnapSettings;
}

interface SegmentList {
  count: number;
  coords: Float32Array;
  meta: Int32Array;
}

interface SpatialGrid {
  cellSize: number;
  ox: number;
  oy: number;
  cols: number;
  rows: number;
  cells: Map<number, Int32Array>;
}

interface GestureCache {
  documentId: string;
  pageIndex: number;
  settings: SnapSettings;
  segs: SegmentList;
  grid: SpatialGrid | null;
  intersections: Map<string, { x: number; y: number }>;
}

let cache: GestureCache | null = null;

const REUSED_RESULT: SnapResult = {
  kind: 'path',
  pdfX: 0,
  pdfY: 0,
  label: '',
  distance: 0,
};

function projectOnSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
  out: { x: number; y: number; distSq: number },
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    out.x = ax;
    out.y = ay;
    const ex = px - ax;
    const ey = py - ay;
    out.distSq = ex * ex + ey * ey;
    return;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  const ex = px - qx;
  const ey = py - qy;
  out.x = qx;
  out.y = qy;
  out.distSq = ex * ex + ey * ey;
}

function intersectSegments(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { x: number; y: number } | null {
  const r1x = bx - ax;
  const r1y = by - ay;
  const r2x = dx - cx;
  const r2y = dy - cy;
  const denom = r1x * r2y - r1y * r2x;
  if (Math.abs(denom) < 1e-9) return null;
  const sx = cx - ax;
  const sy = cy - ay;
  const t = (sx * r2y - sy * r2x) / denom;
  const u = (sx * r1y - sy * r1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: ax + t * r1x, y: ay + t * r1y };
}

function buildGrid(
  segs: SegmentList,
  ox: number,
  oy: number,
  wx: number,
  wy: number,
): SpatialGrid | null {
  if (segs.count === 0) return null;
  const span = Math.max(wx, wy, 1);
  const targetCells = 64;
  let cellSize = Math.max(8, Math.min(256, span / targetCells));
  if (!Number.isFinite(cellSize) || cellSize <= 0) cellSize = 32;
  const cols = Math.max(1, Math.ceil(wx / cellSize));
  const rows = Math.max(1, Math.ceil(wy / cellSize));

  const counts = new Int32Array(cols * rows);
  for (let i = 0; i < segs.count; i++) {
    const base = i * 4;
    const x0 = segs.coords[base]!;
    const y0 = segs.coords[base + 1]!;
    const x1 = segs.coords[base + 2]!;
    const y1 = segs.coords[base + 3]!;
    const lx = Math.max(0, Math.min(cols - 1, Math.floor((Math.min(x0, x1) - ox) / cellSize)));
    const hx = Math.max(0, Math.min(cols - 1, Math.floor((Math.max(x0, x1) - ox) / cellSize)));
    const ly = Math.max(0, Math.min(rows - 1, Math.floor((Math.min(y0, y1) - oy) / cellSize)));
    const hy = Math.max(0, Math.min(rows - 1, Math.floor((Math.max(y0, y1) - oy) / cellSize)));
    for (let r = ly; r <= hy; r++) {
      for (let c = lx; c <= hx; c++) {
        const k = r * cols + c;
        counts[k] = counts[k]! + 1;
      }
    }
  }
  const cellArrays: (Int32Array | null)[] = new Array(cols * rows).fill(null);
  const writePos = new Int32Array(cols * rows);
  for (let k = 0; k < cols * rows; k++) {
    const n = counts[k]!;
    if (n > 0) cellArrays[k] = new Int32Array(n);
  }
  for (let i = 0; i < segs.count; i++) {
    const base = i * 4;
    const x0 = segs.coords[base]!;
    const y0 = segs.coords[base + 1]!;
    const x1 = segs.coords[base + 2]!;
    const y1 = segs.coords[base + 3]!;
    const lx = Math.max(0, Math.min(cols - 1, Math.floor((Math.min(x0, x1) - ox) / cellSize)));
    const hx = Math.max(0, Math.min(cols - 1, Math.floor((Math.max(x0, x1) - ox) / cellSize)));
    const ly = Math.max(0, Math.min(rows - 1, Math.floor((Math.min(y0, y1) - oy) / cellSize)));
    const hy = Math.max(0, Math.min(rows - 1, Math.floor((Math.max(y0, y1) - oy) / cellSize)));
    for (let r = ly; r <= hy; r++) {
      for (let c = lx; c <= hx; c++) {
        const k = r * cols + c;
        const arr = cellArrays[k];
        if (arr) {
          const wp = writePos[k]!;
          arr[wp] = i;
          writePos[k] = wp + 1;
        }
      }
    }
  }
  const cells = new Map<number, Int32Array>();
  for (let k = 0; k < cols * rows; k++) {
    const arr = cellArrays[k];
    if (arr) cells.set(k, arr);
  }
  return { cellSize, ox, oy, cols, rows, cells };
}

function forEachCandidate(
  grid: SpatialGrid,
  cx: number,
  cy: number,
  radius: number,
  visited: Uint8Array,
  visitedClear: number[],
  fn: (segIdx: number) => void,
): void {
  const lx = Math.max(
    0,
    Math.min(grid.cols - 1, Math.floor((cx - radius - grid.ox) / grid.cellSize)),
  );
  const hx = Math.max(
    0,
    Math.min(grid.cols - 1, Math.floor((cx + radius - grid.ox) / grid.cellSize)),
  );
  const ly = Math.max(
    0,
    Math.min(grid.rows - 1, Math.floor((cy - radius - grid.oy) / grid.cellSize)),
  );
  const hy = Math.max(
    0,
    Math.min(grid.rows - 1, Math.floor((cy + radius - grid.oy) / grid.cellSize)),
  );
  for (let r = ly; r <= hy; r++) {
    for (let c = lx; c <= hx; c++) {
      const k = r * grid.cols + c;
      const arr = grid.cells.get(k);
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const segIdx = arr[i]!;
        if (visited[segIdx]) continue;
        visited[segIdx] = 1;
        visitedClear.push(segIdx);
        fn(segIdx);
      }
    }
  }
}

const PROJ_TMP = { x: 0, y: 0, distSq: 0 };
let VISITED: Uint8Array = new Uint8Array(0);
const VISITED_CLEAR: number[] = [];

function ensureVisited(n: number): void {
  if (VISITED.length < n) {
    VISITED = new Uint8Array(n);
  }
}

function clearVisited(): void {
  for (let i = 0; i < VISITED_CLEAR.length; i++) {
    VISITED[VISITED_CLEAR[i]!] = 0;
  }
  VISITED_CLEAR.length = 0;
}

export async function begin(opts: BeginOptions): Promise<number> {
  end();
  const MAX = 64 * 1024;
  let result: PdfPathSegments;
  try {
    const target = engineFor(opts.documentId);
    const page = target?.doc.pages[opts.pageIndex];
    if (!target?.engine.getPathSegments || !page) return -1;
    result = await target.engine
      .getPathSegments(
        target.doc,
        page,
        { minX: opts.pageMinX, minY: opts.pageMinY, maxX: opts.pageMaxX, maxY: opts.pageMaxY },
        MAX,
      )
      .toPromise();
  } catch {
    return -1;
  }
  if (result.count < 0) {
    return -1;
  }
  const segs: SegmentList = {
    count: result.count,
    coords: result.coords,
    meta: result.meta,
  };
  const ox = Math.min(opts.pageMinX, opts.pageMaxX);
  const oy = Math.min(opts.pageMinY, opts.pageMaxY);
  const wx = Math.abs(opts.pageMaxX - opts.pageMinX);
  const wy = Math.abs(opts.pageMaxY - opts.pageMinY);
  const grid = buildGrid(segs, ox, oy, wx, wy);
  cache = {
    documentId: opts.documentId,
    pageIndex: opts.pageIndex,
    settings: opts.settings,
    segs,
    grid,
    intersections: new Map(),
  };
  ensureVisited(segs.count);
  return segs.count;
}

export function updateSettings(settings: SnapSettings): void {
  if (cache) cache.settings = settings;
}

export function snap(
  documentId: string,
  pageIndex: number,
  pdfX: number,
  pdfY: number,
  radiusPdf: number,
): SnapResult | null {
  if (!cache || cache.documentId !== documentId || cache.pageIndex !== pageIndex) {
    return null;
  }
  if (!cache.grid || cache.segs.count === 0) return null;
  if (!cache.settings.enabled) return null;
  const radiusSq = radiusPdf * radiusPdf;
  const { settings, segs, grid, intersections } = cache;

  clearVisited();
  const candidates: number[] = [];
  forEachCandidate(grid, pdfX, pdfY, radiusPdf, VISITED, VISITED_CLEAR, (segIdx) =>
    candidates.push(segIdx),
  );

  let bestIntDistSq = Number.POSITIVE_INFINITY;
  let bestIntX = 0;
  let bestIntY = 0;
  let haveInt = false;
  if (settings.intersection) {
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i]!;
      const aBase = a * 4;
      const aMeta = a * 3;
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j]!;
        if (segs.meta[aMeta] === segs.meta[b * 3]) continue;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        let pt = intersections.get(key);
        if (pt === undefined) {
          const bBase = b * 4;
          const computed = intersectSegments(
            segs.coords[aBase]!,
            segs.coords[aBase + 1]!,
            segs.coords[aBase + 2]!,
            segs.coords[aBase + 3]!,
            segs.coords[bBase]!,
            segs.coords[bBase + 1]!,
            segs.coords[bBase + 2]!,
            segs.coords[bBase + 3]!,
          );
          pt = computed ?? { x: NaN, y: NaN };
          intersections.set(key, pt);
        }
        if (Number.isNaN(pt.x)) continue;
        const ex = pdfX - pt.x;
        const ey = pdfY - pt.y;
        const dsq = ex * ex + ey * ey;
        if (dsq < radiusSq && dsq < bestIntDistSq) {
          bestIntDistSq = dsq;
          bestIntX = pt.x;
          bestIntY = pt.y;
          haveInt = true;
        }
      }
    }
  }
  if (haveInt) {
    REUSED_RESULT.kind = 'intersection';
    REUSED_RESULT.pdfX = bestIntX;
    REUSED_RESULT.pdfY = bestIntY;
    REUSED_RESULT.label = 'Intersection';
    REUSED_RESULT.distance = Math.sqrt(bestIntDistSq);
    return REUSED_RESULT;
  }

  let bestEndDistSq = Number.POSITIVE_INFINITY;
  let bestEndX = 0;
  let bestEndY = 0;
  let haveEnd = false;
  if (settings.endpoint) {
    for (let i = 0; i < candidates.length; i++) {
      const segIdx = candidates[i]!;
      const base = segIdx * 4;
      const flags = segs.meta[segIdx * 3 + 2]!;
      const curveScale = flags & 0x8 ? 1.5 : 1.0;
      let ex = pdfX - segs.coords[base]!;
      let ey = pdfY - segs.coords[base + 1]!;
      let dsq = (ex * ex + ey * ey) * curveScale;
      if (dsq < radiusSq && dsq < bestEndDistSq) {
        bestEndDistSq = dsq;
        bestEndX = segs.coords[base]!;
        bestEndY = segs.coords[base + 1]!;
        haveEnd = true;
      }
      ex = pdfX - segs.coords[base + 2]!;
      ey = pdfY - segs.coords[base + 3]!;
      dsq = (ex * ex + ey * ey) * curveScale;
      if (dsq < radiusSq && dsq < bestEndDistSq) {
        bestEndDistSq = dsq;
        bestEndX = segs.coords[base + 2]!;
        bestEndY = segs.coords[base + 3]!;
        haveEnd = true;
      }
    }
  }
  if (haveEnd) {
    REUSED_RESULT.kind = 'endpoint';
    REUSED_RESULT.pdfX = bestEndX;
    REUSED_RESULT.pdfY = bestEndY;
    REUSED_RESULT.label = 'Endpoint';
    REUSED_RESULT.distance = Math.sqrt(bestEndDistSq);
    return REUSED_RESULT;
  }

  let bestMidDistSq = Number.POSITIVE_INFINITY;
  let bestMidX = 0;
  let bestMidY = 0;
  let haveMid = false;
  if (settings.midpoint) {
    for (let i = 0; i < candidates.length; i++) {
      const segIdx = candidates[i]!;
      const base = segIdx * 4;
      const flags = segs.meta[segIdx * 3 + 2]!;
      if (flags & 0x8) continue;
      const mx = (segs.coords[base]! + segs.coords[base + 2]!) * 0.5;
      const my = (segs.coords[base + 1]! + segs.coords[base + 3]!) * 0.5;
      const ex = pdfX - mx;
      const ey = pdfY - my;
      const dsq = ex * ex + ey * ey;
      if (dsq < radiusSq && dsq < bestMidDistSq) {
        bestMidDistSq = dsq;
        bestMidX = mx;
        bestMidY = my;
        haveMid = true;
      }
    }
  }
  if (haveMid) {
    REUSED_RESULT.kind = 'midpoint';
    REUSED_RESULT.pdfX = bestMidX;
    REUSED_RESULT.pdfY = bestMidY;
    REUSED_RESULT.label = 'Midpoint';
    REUSED_RESULT.distance = Math.sqrt(bestMidDistSq);
    return REUSED_RESULT;
  }

  let bestPathDistSq = Number.POSITIVE_INFINITY;
  let bestPathX = 0;
  let bestPathY = 0;
  let havePath = false;
  if (settings.path) {
    for (let i = 0; i < candidates.length; i++) {
      const segIdx = candidates[i]!;
      const base = segIdx * 4;
      projectOnSegment(
        segs.coords[base]!,
        segs.coords[base + 1]!,
        segs.coords[base + 2]!,
        segs.coords[base + 3]!,
        pdfX,
        pdfY,
        PROJ_TMP,
      );
      if (PROJ_TMP.distSq < radiusSq && PROJ_TMP.distSq < bestPathDistSq) {
        bestPathDistSq = PROJ_TMP.distSq;
        bestPathX = PROJ_TMP.x;
        bestPathY = PROJ_TMP.y;
        havePath = true;
      }
    }
  }
  if (havePath) {
    REUSED_RESULT.kind = 'path';
    REUSED_RESULT.pdfX = bestPathX;
    REUSED_RESULT.pdfY = bestPathY;
    REUSED_RESULT.label = 'Path';
    REUSED_RESULT.distance = Math.sqrt(bestPathDistSq);
    return REUSED_RESULT;
  }
  return null;
}

export function end(): void {
  cache = null;
}

export function cacheMatches(documentId: string, pageIndex: number): boolean {
  return !!cache && cache.documentId === documentId && cache.pageIndex === pageIndex;
}

export function currentGesture(): {
  documentId: string;
  pageIndex: number;
  segmentCount: number;
} | null {
  if (!cache) return null;
  return {
    documentId: cache.documentId,
    pageIndex: cache.pageIndex,
    segmentCount: cache.segs.count,
  };
}
