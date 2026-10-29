import type { PluginRegistry } from '@embedpdf/core';
import {
  ANNOTATION_PLUGIN_ID,
  getAnnotationsByPageIndex,
  type AnnotationPlugin,
} from '@embedpdf/plugin-annotation';
import { HISTORY_PLUGIN_ID, type HistoryPlugin } from '@embedpdf/plugin-history';
import type { PdfAnnotationObject, Position } from '@embedpdf/models';

import {
  deleteScaleArea,
  duplicateScaleArea,
  getScaleAreas,
  getUserUnit,
  getViewportCount,
  reloadScaleAreas,
  reorderScaleArea,
  restoreScaleAreas,
  snapshotScaleAreas,
  writeScaleArea,
  type ScaleArea,
  type ScaleAreaBox,
} from './scale-areas';
import {
  areaAt,
  firstPoint,
  ownScale,
  scaledArea,
  scaledLength,
  type ScaleContext,
} from './scale-context';
import {
  buildAreaChain,
  buildDistanceChain,
  buildMeasureDict,
  formatMeasurement,
  sameScale,
} from './formatter';
import type { ScalePreset } from './types';

export const SCALE_AREAS_TOPIC = 'scale-areas';

const QUEUE = new Map<string, Promise<unknown>>();

function enqueue<T>(documentId: string, fn: () => Promise<T>): Promise<T> {
  const run = (QUEUE.get(documentId) ?? Promise.resolve()).then(fn, fn);
  QUEUE.set(
    documentId,
    run.catch(() => undefined),
  );
  return run;
}

function historyFor(registry: PluginRegistry | null, documentId: string) {
  try {
    return (
      registry?.getPlugin<HistoryPlugin>(HISTORY_PLUGIN_ID)?.provides()?.forDocument(documentId) ??
      null
    );
  } catch {
    return null;
  }
}

function annotationsFor(registry: PluginRegistry | null, documentId: string) {
  try {
    return (
      registry
        ?.getPlugin<AnnotationPlugin>(ANNOTATION_PLUGIN_ID)
        ?.provides()
        ?.forDocument(documentId) ?? null
    );
  } catch {
    return null;
  }
}

function sameBox(a: ScaleAreaBox, b: ScaleAreaBox): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) < 1e-3;
  return (
    close(a.left, b.left) &&
    close(a.bottom, b.bottom) &&
    close(a.right, b.right) &&
    close(a.top, b.top)
  );
}

export function locateScaleArea(documentId: string, area: ScaleArea): ScaleArea | null {
  const areas = getScaleAreas(documentId, area.pageIndex);
  const same = (a: ScaleArea) =>
    a.kind === area.kind && a.name === area.name && sameBox(a.box, area.box);
  const atIndex = areas.find((a) => a.index === area.index);
  if (atIndex && same(atIndex)) return atIndex;
  const matches = areas.filter(same);
  return matches.length === 1 ? matches[0]! : null;
}

type Apply = () => Promise<{ ok: boolean; alongside?: () => void }>;

async function runAreaEdit(
  registry: PluginRegistry | null,
  documentId: string,
  pages: readonly number[],
  apply: Apply,
): Promise<boolean> {
  return enqueue(documentId, async () => {
    if (pages.length === 0) return false;
    const before = await Promise.all(pages.map((p) => snapshotScaleAreas(documentId, p)));
    if (before.some((b) => b == null)) return false;
    let result: { ok: boolean; alongside?: () => void } = { ok: false };
    try {
      result = await apply();
    } catch {
      result = { ok: false };
    }
    const after = await Promise.all(pages.map((p) => snapshotScaleAreas(documentId, p)));
    await reloadScaleAreas(documentId);
    const changed = after.some((a, i) => a !== before[i]);
    if (!changed) return result.ok;
    if (after.some((a) => a == null)) return false;
    const restore = (snaps: Array<string | null>) =>
      enqueue(documentId, async () => {
        for (let i = 0; i < pages.length; i++) {
          await restoreScaleAreas(documentId, pages[i]!, snaps[i]!);
        }
        await reloadScaleAreas(documentId);
      });
    const history = historyFor(registry, documentId);
    if (!history) {
      result.alongside?.();
      return result.ok;
    }
    let applied = true;
    history.beginTransaction();
    try {
      history.register(
        {
          execute: () => {
            if (applied) {
              applied = false;
              return;
            }
            void restore(after);
          },
          undo: () => {
            void restore(before);
          },
          metadata: { kind: 'scale-areas', pages: [...pages] },
        },
        SCALE_AREAS_TOPIC,
      );
      result.alongside?.();
    } finally {
      history.endTransaction(SCALE_AREAS_TOPIC);
    }
    return result.ok;
  });
}

export async function addScaleArea(
  registry: PluginRegistry | null,
  documentId: string,
  pageIndex: number,
  box: ScaleAreaBox,
  name: string,
  preset: ScalePreset | null,
): Promise<number | null> {
  let index: number | null = null;
  await runAreaEdit(registry, documentId, [pageIndex], async () => {
    index = await writeScaleArea(documentId, pageIndex, -1, box, name, preset);
    return { ok: index != null };
  });
  return index;
}

type MeasuredAnnotation = {
  intent?: string;
  pageIndex: number;
  embeddedPreset?: ScalePreset;
  measureJson?: string;
  measure?: unknown;
  linePoints?: { start: Position; end: Position };
  vertices?: ReadonlyArray<Position>;
};

const KIND_OF_INTENT: Record<string, 'length' | 'area'> = {
  LineDimension: 'length',
  PolyLineDimension: 'length',
  PolygonDimension: 'area',
};

function measurementsTakenIn(
  registry: PluginRegistry | null,
  documentId: string,
  area: ScaleArea,
  oldPreset: ScalePreset,
): PdfAnnotationObject[] {
  const scope = annotationsFor(registry, documentId);
  if (!scope) return [];
  const out: PdfAnnotationObject[] = [];
  for (const ta of getAnnotationsByPageIndex(scope.getState(), area.pageIndex)) {
    const a = ta.object as PdfAnnotationObject & MeasuredAnnotation;
    if (!a.intent || !(a.intent in KIND_OF_INTENT)) continue;
    const at = areaAt(documentId, area.pageIndex, firstPoint(a));
    if (!at || at.index !== area.index) continue;
    const own = ownScale(a, getUserUnit(documentId, area.pageIndex));
    if (!own || !sameScale(own, oldPreset)) continue;
    out.push(a);
  }
  return out;
}

function captionIn(a: MeasuredAnnotation, ctx: ScaleContext): string {
  const kind = KIND_OF_INTENT[a.intent ?? ''];
  if (kind === 'area') {
    const v = a.vertices ?? [];
    return v.length >= 3 ? formatMeasurement(scaledArea(v, ctx), buildAreaChain(ctx.preset)) : '';
  }
  const pts = a.linePoints ? [a.linePoints.start, a.linePoints.end] : (a.vertices ?? []);
  return pts.length >= 2
    ? formatMeasurement(scaledLength(pts, ctx), buildDistanceChain(ctx.preset))
    : '';
}

function rescaleMeasurements(
  registry: PluginRegistry | null,
  documentId: string,
  measurements: readonly PdfAnnotationObject[],
  preset: ScalePreset,
): void {
  const scope = annotationsFor(registry, documentId);
  if (!scope) return;
  for (const raw of measurements) {
    const a = raw as PdfAnnotationObject & MeasuredAnnotation;
    const userUnit = getUserUnit(documentId, a.pageIndex);
    const ctx: ScaleContext = { preset, userUnit, area: null };
    if (a.measure == null && a.measureJson) {
      try {
        scope.updateAnnotation(a.pageIndex, a.id, {
          measure: JSON.parse(a.measureJson),
        } as unknown as Partial<PdfAnnotationObject>);
      } catch {}
    }
    scope.updateAnnotation(a.pageIndex, a.id, {
      measure: buildMeasureDict(preset, userUnit),
      embeddedPreset: preset,
      contents: captionIn(a, ctx),
    } as unknown as Partial<PdfAnnotationObject>);
  }
}

export function updateScaleArea(
  registry: PluginRegistry | null,
  documentId: string,
  area: ScaleArea,
  next: { box: ScaleAreaBox; name: string; preset: ScalePreset | null | 'keep' },
): Promise<boolean> {
  return runAreaEdit(registry, documentId, [area.pageIndex], async () => {
    const now = locateScaleArea(documentId, area);
    if (!now) return { ok: false };
    const preset = next.preset === 'keep' ? null : next.preset;
    const rescale = now.kind === 'scale' && now.preset && preset && !sameScale(now.preset, preset);
    const carried = rescale ? measurementsTakenIn(registry, documentId, now, now.preset!) : [];
    const ok =
      (await writeScaleArea(
        documentId,
        now.pageIndex,
        now.index,
        next.box,
        next.name,
        next.preset,
      )) != null;
    return {
      ok,
      alongside:
        ok && carried.length && preset
          ? () => rescaleMeasurements(registry, documentId, carried, preset)
          : undefined,
    };
  });
}

export function moveScaleArea(
  registry: PluginRegistry | null,
  documentId: string,
  area: ScaleArea,
  box: ScaleAreaBox,
): Promise<boolean> {
  return updateScaleArea(registry, documentId, area, { box, name: area.name, preset: 'keep' });
}

export function setScaleAreaScale(
  registry: PluginRegistry | null,
  documentId: string,
  area: ScaleArea,
  preset: ScalePreset,
): Promise<boolean> {
  return updateScaleArea(registry, documentId, area, { box: area.box, name: area.name, preset });
}

export function removeScaleArea(
  registry: PluginRegistry | null,
  documentId: string,
  area: ScaleArea,
): Promise<boolean> {
  return runAreaEdit(registry, documentId, [area.pageIndex], async () => {
    const now = locateScaleArea(documentId, area);
    return { ok: !!now && (await deleteScaleArea(documentId, now.pageIndex, now.index)) };
  });
}

export async function bringScaleAreaToFront(
  registry: PluginRegistry | null,
  documentId: string,
  area: ScaleArea,
): Promise<number | null> {
  let index: number | null = null;
  await runAreaEdit(registry, documentId, [area.pageIndex], async () => {
    const now = locateScaleArea(documentId, area);
    if (!now) return { ok: false };
    const last = getViewportCount(documentId, now.pageIndex) - 1;
    if (now.index >= last) {
      index = now.index;
      return { ok: true };
    }
    const ok = await reorderScaleArea(documentId, now.pageIndex, now.index, last);
    if (ok) index = last;
    return { ok };
  });
  return index;
}

export async function copyScaleAreaToPages(
  registry: PluginRegistry | null,
  documentId: string,
  area: ScaleArea,
  pages: readonly number[],
  pageBoxes: (pageIndex: number) => ScaleAreaBox | null,
): Promise<{ copied: number; skipped: number }> {
  const targets: number[] = [];
  let skipped = 0;
  for (const p of new Set(pages)) {
    if (p === area.pageIndex) continue;
    const page = pageBoxes(p);
    const b = area.box;
    if (
      !page ||
      b.right <= page.left ||
      b.left >= page.right ||
      b.top <= page.bottom ||
      b.bottom >= page.top
    ) {
      skipped++;
      continue;
    }
    targets.push(p);
  }
  let copied = 0;
  if (targets.length === 0) return { copied, skipped };
  await runAreaEdit(registry, documentId, targets, async () => {
    const now = locateScaleArea(documentId, area);
    if (!now) return { ok: false };
    let all = true;
    for (const p of targets) {
      const r = await duplicateScaleArea(documentId, now.pageIndex, now.index, p);
      if (r == null) all = false;
      else copied++;
    }
    return { ok: all };
  });
  return { copied, skipped: skipped + (targets.length - copied) };
}
