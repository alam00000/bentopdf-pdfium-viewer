import { useEffect, useState } from 'preact/hooks';

export type SnapKind = 'path' | 'endpoint' | 'midpoint' | 'intersection';

export interface SnapSettings {
  path: boolean;
  endpoint: boolean;
  midpoint: boolean;
  intersection: boolean;
  enabled: boolean;
  loupe: boolean;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  path: true,
  endpoint: true,
  midpoint: true,
  intersection: true,
  enabled: true,
  loupe: true,
};

const STORAGE_PREFIX = 'measurement:snap:';

function storageKey(documentId: string): string {
  return STORAGE_PREFIX + documentId;
}

function loadFromStorage(documentId: string): SnapSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SNAP_SETTINGS };
  try {
    const raw = localStorage.getItem(storageKey(documentId));
    if (!raw) return { ...DEFAULT_SNAP_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<SnapSettings>;
    return {
      path: typeof parsed.path === 'boolean' ? parsed.path : true,
      endpoint: typeof parsed.endpoint === 'boolean' ? parsed.endpoint : true,
      midpoint: typeof parsed.midpoint === 'boolean' ? parsed.midpoint : true,
      intersection: typeof parsed.intersection === 'boolean' ? parsed.intersection : true,
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      loupe: typeof parsed.loupe === 'boolean' ? parsed.loupe : true,
    };
  } catch {
    return { ...DEFAULT_SNAP_SETTINGS };
  }
}

function saveToStorage(documentId: string, settings: SnapSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(documentId), JSON.stringify(settings));
  } catch {}
}

const stateByDoc = new Map<string, SnapSettings>();
const subscribers = new Map<string, Set<() => void>>();

function ensureDoc(documentId: string): SnapSettings {
  let s = stateByDoc.get(documentId);
  if (!s) {
    s = loadFromStorage(documentId);
    stateByDoc.set(documentId, s);
  }
  return s;
}

function notify(documentId: string): void {
  const subs = subscribers.get(documentId);
  if (!subs) return;
  for (const fn of subs) fn();
}

export function getSnapSettings(documentId: string): SnapSettings {
  return ensureDoc(documentId);
}

export function clearSnapSettingsForDoc(documentId: string): void {
  stateByDoc.delete(documentId);
  subscribers.delete(documentId);
}

export function setSnapKind(documentId: string, kind: SnapKind, on: boolean): void {
  const cur = ensureDoc(documentId);
  if (cur[kind] === on) return;
  const next: SnapSettings = { ...cur, [kind]: on };
  stateByDoc.set(documentId, next);
  saveToStorage(documentId, next);
  notify(documentId);
}

export function setSnapEnabled(documentId: string, on: boolean): void {
  const cur = ensureDoc(documentId);
  if (cur.enabled === on) return;
  const next: SnapSettings = { ...cur, enabled: on };
  stateByDoc.set(documentId, next);
  saveToStorage(documentId, next);
  notify(documentId);
}

export function setLoupeEnabled(documentId: string, on: boolean): void {
  const cur = ensureDoc(documentId);
  if (cur.loupe === on) return;
  const next: SnapSettings = { ...cur, loupe: on };
  stateByDoc.set(documentId, next);
  saveToStorage(documentId, next);
  notify(documentId);
}

export function subscribeSnapSettings(documentId: string, fn: () => void): () => void {
  let subs = subscribers.get(documentId);
  if (!subs) {
    subs = new Set();
    subscribers.set(documentId, subs);
  }
  subs.add(fn);
  return () => {
    const s = subscribers.get(documentId);
    if (s) {
      s.delete(fn);
      if (s.size === 0) subscribers.delete(documentId);
    }
  };
}

export function useSnapSettings(documentId: string): SnapSettings {
  const [snap, setSnap] = useState<SnapSettings>(() => getSnapSettings(documentId));
  useEffect(() => {
    setSnap(getSnapSettings(documentId));
    const unsub = subscribeSnapSettings(documentId, () => {
      setSnap(getSnapSettings(documentId));
    });
    return unsub;
  }, [documentId]);
  return snap;
}
