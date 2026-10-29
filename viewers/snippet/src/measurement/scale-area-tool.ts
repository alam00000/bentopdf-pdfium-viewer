import { useEffect, useState } from 'preact/hooks';

import { notifyCommandRefresh } from '@/lib/command-refresh';
import type { ScaleArea, ScaleAreaBox } from './scale-areas';

export interface ScaleAreaRef {
  pageIndex: number;
  index: number;
}

export type ScaleAreaDialog =
  | { kind: 'new'; pageIndex: number; box: ScaleAreaBox }
  | { kind: 'edit'; area: ScaleArea }
  | { kind: 'copy'; area: ScaleArea };

export interface ScaleAreaToolState {
  armed: boolean;
  selected: ScaleAreaRef | null;
  dialog: ScaleAreaDialog | null;
}

const IDLE: ScaleAreaToolState = { armed: false, selected: null, dialog: null };
const states = new Map<string, ScaleAreaToolState>();
const listeners = new Map<string, Set<() => void>>();

function set(documentId: string, next: ScaleAreaToolState): void {
  const prev = states.get(documentId) ?? IDLE;
  if (prev.armed === next.armed && prev.selected === next.selected && prev.dialog === next.dialog)
    return;
  states.set(documentId, next);
  for (const fn of [...(listeners.get(documentId) ?? [])]) {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
  if (prev.armed !== next.armed) notifyCommandRefresh();
}

export function getScaleAreaTool(documentId: string): ScaleAreaToolState {
  return states.get(documentId) ?? IDLE;
}

export function isScaleAreaToolArmed(documentId: string): boolean {
  return getScaleAreaTool(documentId).armed;
}

export function armScaleAreaTool(documentId: string): void {
  set(documentId, { ...getScaleAreaTool(documentId), armed: true });
}

export function disarmScaleAreaTool(documentId: string): void {
  set(documentId, { ...getScaleAreaTool(documentId), armed: false, selected: null });
}

export function selectScaleArea(documentId: string, ref: ScaleAreaRef | null): void {
  const cur = getScaleAreaTool(documentId);
  if (cur.selected?.pageIndex === ref?.pageIndex && cur.selected?.index === ref?.index) return;
  set(documentId, { ...cur, selected: ref });
}

export function openScaleAreaDialog(documentId: string, dialog: ScaleAreaDialog): void {
  set(documentId, { ...getScaleAreaTool(documentId), dialog });
}

export function closeScaleAreaDialog(documentId: string): void {
  set(documentId, { ...getScaleAreaTool(documentId), dialog: null });
}

export function subscribeScaleAreaTool(documentId: string, fn: () => void): () => void {
  let subs = listeners.get(documentId);
  if (!subs) {
    subs = new Set();
    listeners.set(documentId, subs);
  }
  subs.add(fn);
  return () => {
    subs!.delete(fn);
  };
}

export function useScaleAreaTool(documentId: string): ScaleAreaToolState {
  const [state, setState] = useState(() => getScaleAreaTool(documentId));
  useEffect(() => {
    setState(getScaleAreaTool(documentId));
    return subscribeScaleAreaTool(documentId, () => setState(getScaleAreaTool(documentId)));
  }, [documentId]);
  return state;
}

export function clearScaleAreaToolForDoc(documentId: string): void {
  const wasArmed = states.get(documentId)?.armed;
  states.delete(documentId);
  listeners.delete(documentId);
  if (wasArmed) notifyCommandRefresh();
}
