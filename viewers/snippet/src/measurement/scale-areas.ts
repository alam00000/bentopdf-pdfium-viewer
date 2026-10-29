import { useEffect, useState } from 'preact/hooks';

import type { ScalePreset } from './types';
import { presetFromMeasureJson } from './embedded-preset';
import { buildMeasureDict, buildScaleRatio } from './formatter';
import { notifyCommandRefresh } from '@/lib/command-refresh';
import { engineFor } from './engine-bridge';

export type ScaleAreaKind = 'scale' | 'unscaled' | 'other';

export interface ScaleArea {
  pageIndex: number;
  index: number;
  box: { left: number; bottom: number; right: number; top: number };
  name: string;
  kind: ScaleAreaKind;
  preset: ScalePreset | null;
}

export function scaleAreaLabel(area: ScaleArea): string {
  if (area.kind === 'scale' && area.preset) {
    const ratio = buildScaleRatio(area.preset);
    return area.name ? `${area.name} · ${ratio}` : ratio;
  }
  if (area.kind === 'unscaled') return `${area.name || 'Scale area'} · page scale`;
  return `${area.name || 'Map'} · not used for measuring`;
}

export interface ScaleAreaBox {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface DocAreas {
  state: LoadState;
  pages: Map<number, ScaleArea[]>;
  userUnits: Map<number, number>;
  vpCounts: Map<number, number>;
  generation: number;
  listeners: Set<() => void>;
}

const docs = new Map<string, DocAreas>();
const NO_AREAS: readonly ScaleArea[] = [];
const anyListeners = new Set<() => void>();

function docFor(documentId: string): DocAreas {
  let d = docs.get(documentId);
  if (!d) {
    d = {
      state: 'idle',
      pages: new Map(),
      userUnits: new Map(),
      vpCounts: new Map(),
      generation: 0,
      listeners: new Set(),
    };
    docs.set(documentId, d);
  }
  return d;
}

function notify(d: DocAreas): void {
  for (const fn of [...d.listeners, ...anyListeners]) {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
}

interface ViewportJson {
  i: number;
  BBox?: number[];
  Name?: string;
  PtData?: boolean;
  Measure?: { Subtype?: string } & Record<string, unknown>;
}

export function parseScaleAreas(json: string): {
  pages: Map<number, ScaleArea[]>;
  userUnits: Map<number, number>;
  vpCounts: Map<number, number>;
} {
  const pages = new Map<number, ScaleArea[]>();
  const userUnits = new Map<number, number>();
  const vpCounts = new Map<number, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { pages, userUnits, vpCounts };
  }
  if (!Array.isArray(parsed)) return { pages, userUnits, vpCounts };
  for (const entry of parsed as Array<{ p?: unknown; uu?: unknown; vp?: unknown }>) {
    if (typeof entry?.p !== 'number' || !Number.isInteger(entry.p) || entry.p < 0) continue;
    const pageIndex = entry.p;
    const uu =
      typeof entry.uu === 'number' && Number.isFinite(entry.uu) && entry.uu > 0 ? entry.uu : 1;
    if (uu !== 1) userUnits.set(pageIndex, uu);
    const areas: ScaleArea[] = [];
    const vp = Array.isArray(entry.vp) ? (entry.vp as ViewportJson[]) : [];
    if (vp.length > 0) vpCounts.set(pageIndex, vp.length);
    for (const v of vp) {
      const b = v?.BBox;
      if (typeof v?.i !== 'number' || !Array.isArray(b) || b.length !== 4) continue;
      if (!b.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      const box = {
        left: Math.min(b[0]!, b[2]!),
        bottom: Math.min(b[1]!, b[3]!),
        right: Math.max(b[0]!, b[2]!),
        top: Math.max(b[1]!, b[3]!),
      };
      if (!(box.right > box.left) || !(box.top > box.bottom)) continue;
      let kind: ScaleAreaKind = 'unscaled';
      let preset: ScalePreset | null = null;
      if (v.Measure) {
        preset = v.PtData ? null : presetFromMeasureJson(JSON.stringify(v.Measure), uu);
        kind = preset ? 'scale' : 'other';
      }
      areas.push({
        pageIndex,
        index: v.i,
        box,
        name: typeof v.Name === 'string' ? v.Name : '',
        kind,
        preset,
      });
    }
    if (areas.length > 0) pages.set(pageIndex, areas);
  }
  return { pages, userUnits, vpCounts };
}

export async function reloadScaleAreas(documentId: string): Promise<void> {
  const d = docFor(documentId);
  const target = engineFor(documentId);
  if (!target?.engine.getScaleAreas) return;
  const generation = ++d.generation;
  const wasUnavailable = d.state === 'unavailable';
  if (d.state !== 'ready') d.state = 'loading';
  let json: string | null = null;
  try {
    json = await target.engine.getScaleAreas(target.doc).toPromise();
  } catch {
    json = null;
  }
  if (docs.get(documentId) !== d || d.generation !== generation) return;
  if ((json == null) !== wasUnavailable) notifyCommandRefresh();
  if (json == null) {
    d.state = 'unavailable';
    d.pages = new Map();
    d.userUnits = new Map();
    d.vpCounts = new Map();
  } else {
    const { pages, userUnits, vpCounts } = parseScaleAreas(json);
    d.state = 'ready';
    d.pages = pages;
    d.userUnits = userUnits;
    d.vpCounts = vpCounts;
  }
  notify(d);
}

export function ensureScaleAreas(documentId: string): void {
  const d = docFor(documentId);
  if (d.state === 'idle') void reloadScaleAreas(documentId);
}

export function refreshScaleAreasIfLoaded(documentId: string): void {
  const d = docs.get(documentId);
  if (d && d.state !== 'idle') void reloadScaleAreas(documentId);
}

export function scaleAreasSupported(documentId: string): boolean | null {
  const s = docs.get(documentId)?.state;
  if (s === 'ready') return true;
  if (s === 'unavailable') return false;
  return null;
}

export function getScaleAreas(documentId: string, pageIndex: number): readonly ScaleArea[] {
  return docs.get(documentId)?.pages.get(pageIndex) ?? NO_AREAS;
}

export function getViewportCount(documentId: string, pageIndex: number): number {
  return docs.get(documentId)?.vpCounts.get(pageIndex) ?? 0;
}

export function getUserUnit(documentId: string, pageIndex: number): number {
  return docs.get(documentId)?.userUnits.get(pageIndex) ?? 1;
}

export function subscribeScaleAreas(documentId: string, fn: () => void): () => void {
  const d = docFor(documentId);
  d.listeners.add(fn);
  return () => {
    d.listeners.delete(fn);
  };
}

export function subscribeAnyScaleAreas(fn: () => void): () => void {
  anyListeners.add(fn);
  return () => {
    anyListeners.delete(fn);
  };
}

export function useScaleAreas(documentId: string, pageIndex: number): readonly ScaleArea[] {
  const [areas, setAreas] = useState(() => getScaleAreas(documentId, pageIndex));
  useEffect(() => {
    setAreas(getScaleAreas(documentId, pageIndex));
    return subscribeScaleAreas(documentId, () => setAreas(getScaleAreas(documentId, pageIndex)));
  }, [documentId, pageIndex]);
  return areas;
}

export function clearScaleAreasForDoc(documentId: string): void {
  const d = docs.get(documentId);
  if (!d) return;
  d.generation++;
  docs.delete(documentId);
}

export async function writeScaleArea(
  documentId: string,
  pageIndex: number,
  index: number,
  box: ScaleAreaBox,
  name: string,
  preset: ScalePreset | null | 'keep',
): Promise<number | null> {
  const target = engineFor(documentId);
  if (!target?.engine.setScaleArea) return null;
  const measure =
    preset === 'keep'
      ? 'keep'
      : preset
        ? buildMeasureDict(preset, getUserUnit(documentId, pageIndex))
        : null;
  try {
    return await target.engine
      .setScaleArea(target.doc, pageIndex, index, box, name.trim() || null, measure)
      .toPromise();
  } catch {
    return null;
  }
}

export async function deleteScaleArea(
  documentId: string,
  pageIndex: number,
  index: number,
): Promise<boolean> {
  const target = engineFor(documentId);
  if (!target?.engine.removeScaleArea) return false;
  try {
    return await target.engine.removeScaleArea(target.doc, pageIndex, index).toPromise();
  } catch {
    return false;
  }
}

export async function reorderScaleArea(
  documentId: string,
  pageIndex: number,
  from: number,
  to: number,
): Promise<boolean> {
  const target = engineFor(documentId);
  if (!target?.engine.moveScaleArea) return false;
  try {
    return await target.engine.moveScaleArea(target.doc, pageIndex, from, to).toPromise();
  } catch {
    return false;
  }
}

export async function duplicateScaleArea(
  documentId: string,
  fromPage: number,
  index: number,
  toPage: number,
): Promise<number | null> {
  const target = engineFor(documentId);
  if (!target?.engine.copyScaleArea) return null;
  try {
    return await target.engine.copyScaleArea(target.doc, fromPage, index, toPage).toPromise();
  } catch {
    return null;
  }
}

export async function snapshotScaleAreas(
  documentId: string,
  pageIndex: number,
): Promise<string | null> {
  const target = engineFor(documentId);
  if (!target?.engine.getScaleAreasSyntax) return null;
  try {
    return await target.engine.getScaleAreasSyntax(target.doc, pageIndex).toPromise();
  } catch {
    return null;
  }
}

export async function restoreScaleAreas(
  documentId: string,
  pageIndex: number,
  syntax: string,
): Promise<boolean> {
  const target = engineFor(documentId);
  if (!target?.engine.setScaleAreasSyntax) return false;
  try {
    return await target.engine.setScaleAreasSyntax(target.doc, pageIndex, syntax).toPromise();
  } catch {
    return false;
  }
}
