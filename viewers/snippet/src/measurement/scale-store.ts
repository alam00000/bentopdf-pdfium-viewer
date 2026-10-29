import { useCallback, useEffect, useState } from 'preact/hooks';

import type { Precision, ScalePreset, ScaleState } from './types';
import type { Unit } from './units';

function newPresetId(): string {
  return 'scale-' + Math.random().toString(36).slice(2, 10);
}

export function defaultPreset(): ScalePreset {
  return {
    id: newPresetId(),
    name: '',
    page: { value: 1, unit: 'in' },
    world: { value: 1, unit: 'in' },
    precision: 0.01,
    showSecondary: false,
  };
}

function defaultState(): ScaleState {
  const p = defaultPreset();
  return { presets: [p], activePresetId: p.id };
}

interface DocStore {
  state: ScaleState;
  listeners: Set<() => void>;
}

export type MeasurementMode = 'distance' | 'perimeter' | 'area';

export const MODE_BASE_TOOL_ID: Record<MeasurementMode, string> = {
  distance: 'line',
  perimeter: 'polyline',
  area: 'polygon',
};

export function isPendingModeStale(
  mode: MeasurementMode | null,
  activeToolId: string | null,
): boolean {
  return mode !== null && activeToolId !== MODE_BASE_TOOL_ID[mode];
}

export function resolveMeasurementToolId(
  mode: MeasurementMode | null,
  activeToolId: string | null,
): MeasurementMode | null {
  return mode !== null && !isPendingModeStale(mode, activeToolId) ? mode : null;
}

interface ModeStore {
  mode: MeasurementMode | null;
  listeners: Set<() => void>;
}

const modeStores = new Map<string, ModeStore>();

function getModeStore(documentId: string): ModeStore {
  let s = modeStores.get(documentId);
  if (!s) {
    s = { mode: null, listeners: new Set() };
    modeStores.set(documentId, s);
  }
  return s;
}

export function getPendingMode(documentId: string): MeasurementMode | null {
  return getModeStore(documentId).mode;
}

export function getAnyPendingMode(): MeasurementMode | null {
  if (activeDocId) {
    const s = modeStores.get(activeDocId);
    if (s?.mode) return s.mode;
  }
  for (const s of modeStores.values()) {
    if (s.mode) return s.mode;
  }
  return null;
}

let activeDocId: string | null = null;
const mountedDocs: string[] = [];

export function setActiveMeasurementDoc(id: string | null): void {
  if (id === null) {
    activeDocId = null;
    return;
  }
  const idx = mountedDocs.indexOf(id);
  if (idx !== -1) mountedDocs.splice(idx, 1);
  mountedDocs.push(id);
  activeDocId = id;
}

export function releaseMeasurementDoc(id: string): void {
  const idx = mountedDocs.indexOf(id);
  if (idx !== -1) mountedDocs.splice(idx, 1);
  if (activeDocId === id) {
    activeDocId = mountedDocs.length > 0 ? mountedDocs[mountedDocs.length - 1]! : null;
  }
}

export function getActiveMeasurementDoc(): string | null {
  return activeDocId;
}

export type CalibrationPhase = 'idle' | 'placing-first' | 'placing-second' | 'confirming';

export interface CalibrationPoint {
  x: number;
  y: number;
}

export type CalibrationAxis = 'both' | 'x' | 'y';

export type CalibrationTarget =
  | { kind: 'page' }
  | { kind: 'area'; pageIndex: number; index: number; name: string }
  | {
      kind: 'draft';
      axis: CalibrationAxis;
      initialWorld: { value: number; unit: Unit };
      onResult: (r: CalibrationResult) => void;
      onCancel: () => void;
    };

export interface CalibrationResult {
  axis: CalibrationAxis;
  paperPoints: number;
  world: { value: number; unit: Unit };
}

export function calibratedPreset(base: ScalePreset, r: CalibrationResult): ScalePreset {
  const ratio = {
    page: { value: r.paperPoints, unit: 'pt' as Unit },
    world: { value: r.world.value, unit: r.world.unit },
  };
  if (r.axis === 'y' && base.vertical) return { ...base, vertical: ratio };
  return { ...base, ...ratio };
}

export interface CalibrationState {
  phase: CalibrationPhase;
  target: CalibrationTarget;
  pageIndex: number | null;
  first: CalibrationPoint | null;
  second: CalibrationPoint | null;
  cursor: CalibrationPoint | null;
}

interface CalibrationStore {
  state: CalibrationState;
  listeners: Set<() => void>;
}

const calibrationStores = new Map<string, CalibrationStore>();

function defaultCalibrationState(): CalibrationState {
  return {
    phase: 'idle',
    target: { kind: 'page' },
    pageIndex: null,
    first: null,
    second: null,
    cursor: null,
  };
}

function getCalibrationStore(docId: string): CalibrationStore {
  let s = calibrationStores.get(docId);
  if (!s) {
    s = { state: defaultCalibrationState(), listeners: new Set() };
    calibrationStores.set(docId, s);
  }
  return s;
}

function notifyCalibration(s: CalibrationStore): void {
  s.listeners.forEach((fn) => fn());
}

export function getCalibrationState(docId: string): CalibrationState {
  return getCalibrationStore(docId).state;
}

export function startCalibration(
  docId: string,
  target: CalibrationTarget = { kind: 'page' },
): void {
  const s = getCalibrationStore(docId);
  if (s.state.phase !== 'idle' && s.state.target.kind === 'draft') s.state.target.onCancel();
  s.state = {
    phase: 'placing-first',
    target,
    pageIndex: null,
    first: null,
    second: null,
    cursor: null,
  };
  notifyCalibration(s);
}

export function resetCalibration(docId: string, delivered = false): void {
  const s = getCalibrationStore(docId);
  if (s.state.phase === 'idle') return;
  const target = s.state.target;
  s.state = defaultCalibrationState();
  notifyCalibration(s);
  if (!delivered && target.kind === 'draft') target.onCancel();
}

export function setCalibrationFirst(
  docId: string,
  pageIndex: number,
  pt: CalibrationPoint,
  target?: CalibrationTarget,
): void {
  const s = getCalibrationStore(docId);
  s.state = {
    phase: 'placing-second',
    target: target ?? s.state.target,
    pageIndex,
    first: pt,
    second: null,
    cursor: pt,
  };
  notifyCalibration(s);
}

export function setCalibrationSecond(docId: string, pt: CalibrationPoint): void {
  const s = getCalibrationStore(docId);
  if (s.state.phase !== 'placing-second' || s.state.first === null) return;
  s.state = {
    ...s.state,
    phase: 'confirming',
    second: pt,
    cursor: pt,
  };
  notifyCalibration(s);
}

export function setCalibrationCursor(docId: string, pageIndex: number, pt: CalibrationPoint): void {
  const s = getCalibrationStore(docId);
  if (s.state.phase !== 'placing-second') return;
  if (s.state.pageIndex !== pageIndex) return;
  s.state = { ...s.state, cursor: pt };
  notifyCalibration(s);
}

export function subscribeCalibration(docId: string, fn: () => void): () => void {
  const s = getCalibrationStore(docId);
  s.listeners.add(fn);
  return () => {
    s.listeners.delete(fn);
  };
}

export function applyCalibration(
  docId: string,
  pdfPointsDistance: number,
  worldValue: number,
  worldUnit: Unit,
  axis: CalibrationAxis = 'both',
): void {
  if (!Number.isFinite(pdfPointsDistance) || pdfPointsDistance <= 0) return;
  if (!Number.isFinite(worldValue) || worldValue <= 0) return;

  const active = getActivePreset(docId);
  const next = calibratedPreset(active, {
    axis,
    paperPoints: pdfPointsDistance,
    world: { value: worldValue, unit: worldUnit },
  });
  updatePreset(docId, active.id, {
    page: next.page,
    world: next.world,
    ...(next.vertical ? { vertical: next.vertical } : {}),
  });
  resetCalibration(docId);
}

export function setPendingMode(documentId: string, mode: MeasurementMode | null): void {
  const s = getModeStore(documentId);
  if (s.mode === mode) return;
  s.mode = mode;
  s.listeners.forEach((fn) => fn());
  anyModeListeners.forEach((fn) => fn());
}

export function subscribePendingMode(documentId: string, fn: () => void): () => void {
  const s = getModeStore(documentId);
  s.listeners.add(fn);
  return () => {
    s.listeners.delete(fn);
  };
}

const anyModeListeners = new Set<() => void>();

export function subscribeAnyPendingMode(fn: () => void): () => void {
  anyModeListeners.add(fn);
  return () => {
    anyModeListeners.delete(fn);
  };
}

const stores = new Map<string, DocStore>();

function storageKey(documentId: string): string {
  return `bentopdf.measurement.presets.${documentId}`;
}

function isLegacyUntouchedDefault(s: ScaleState): boolean {
  if (s.presets.length !== 1) return false;
  const p = s.presets[0]!;
  return (
    p.name === '' &&
    p.page.value === 1 &&
    p.page.unit === 'cm' &&
    p.world.value === 1 &&
    p.world.unit === 'cm' &&
    p.precision === 0.01 &&
    !p.showSecondary &&
    !p.secondary
  );
}

function load(documentId: string): ScaleState {
  try {
    const raw = localStorage.getItem(storageKey(documentId));
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as ScaleState;
    if (!parsed || !Array.isArray(parsed.presets) || parsed.presets.length === 0) {
      return defaultState();
    }
    if (isLegacyUntouchedDefault(parsed)) return defaultState();
    const activeOk = parsed.presets.some((p) => p.id === parsed.activePresetId);
    return {
      presets: parsed.presets,
      activePresetId: activeOk ? parsed.activePresetId : parsed.presets[0]!.id,
    };
  } catch {
    return defaultState();
  }
}

function save(documentId: string, state: ScaleState): void {
  try {
    localStorage.setItem(storageKey(documentId), JSON.stringify(state));
  } catch {}
}

function getStore(documentId: string): DocStore {
  let s = stores.get(documentId);
  if (!s) {
    s = { state: load(documentId), listeners: new Set() };
    stores.set(documentId, s);
  }
  return s;
}

function commit(documentId: string, next: ScaleState): void {
  const s = getStore(documentId);
  s.state = next;
  save(documentId, next);
  s.listeners.forEach((fn) => fn());
}

export function getScaleState(documentId: string): ScaleState {
  return getStore(documentId).state;
}

export function getActivePreset(documentId: string): ScalePreset {
  const s = getScaleState(documentId);
  return s.presets.find((p) => p.id === s.activePresetId) ?? s.presets[0]!;
}

export function setActivePreset(documentId: string, presetId: string): void {
  const s = getScaleState(documentId);
  if (!s.presets.some((p) => p.id === presetId)) return;
  commit(documentId, { ...s, activePresetId: presetId });
}

export function addPreset(documentId: string, preset?: Partial<ScalePreset>): string {
  const s = getScaleState(documentId);
  const next: ScalePreset = { ...defaultPreset(), ...preset, id: newPresetId() };
  commit(documentId, {
    presets: [...s.presets, next],
    activePresetId: next.id,
  });
  return next.id;
}

export function updatePreset(
  documentId: string,
  presetId: string,
  patch: Partial<ScalePreset>,
): void {
  const s = getScaleState(documentId);
  const presets = s.presets.map((p) => (p.id === presetId ? { ...p, ...patch, id: p.id } : p));
  commit(documentId, { ...s, presets });
}

export function removePreset(documentId: string, presetId: string): void {
  const s = getScaleState(documentId);
  if (s.presets.length <= 1) return;
  const presets = s.presets.filter((p) => p.id !== presetId);
  const activePresetId = s.activePresetId === presetId ? presets[0]!.id : s.activePresetId;
  commit(documentId, { presets, activePresetId });
}

export function replaceState(documentId: string, state: ScaleState): void {
  commit(documentId, state);
}

export function subscribe(documentId: string, fn: () => void): () => void {
  const s = getStore(documentId);
  s.listeners.add(fn);
  return () => {
    s.listeners.delete(fn);
  };
}

export function useScaleStore(documentId: string): {
  state: ScaleState;
  activePreset: ScalePreset;
  setActive: (presetId: string) => void;
  add: (preset?: Partial<ScalePreset>) => string;
  update: (presetId: string, patch: Partial<ScalePreset>) => void;
  remove: (presetId: string) => void;
  replace: (state: ScaleState) => void;
} {
  const [state, setState] = useState<ScaleState>(() => getScaleState(documentId));
  useEffect(() => {
    setState(getScaleState(documentId));
    return subscribe(documentId, () => setState(getScaleState(documentId)));
  }, [documentId]);
  const activePreset =
    state.presets.find((p: ScalePreset) => p.id === state.activePresetId) ?? state.presets[0]!;

  return {
    state,
    activePreset,
    setActive: useCallback((id: string) => setActivePreset(documentId, id), [documentId]),
    add: useCallback((p?: Partial<ScalePreset>) => addPreset(documentId, p), [documentId]),
    update: useCallback(
      (id: string, patch: Partial<ScalePreset>) => updatePreset(documentId, id, patch),
      [documentId],
    ),
    remove: useCallback((id: string) => removePreset(documentId, id), [documentId]),
    replace: useCallback((s: ScaleState) => replaceState(documentId, s), [documentId]),
  };
}

export function clearScaleStoresForDoc(documentId: string): void {
  stores.delete(documentId);
  modeStores.delete(documentId);
  calibrationStores.delete(documentId);
}

export function makePreset(
  pageValue: number,
  pageUnit: Unit,
  worldValue: number,
  worldUnit: Unit,
  precision: Precision = 0.01,
): ScalePreset {
  return {
    id: newPresetId(),
    name: '',
    page: { value: pageValue, unit: pageUnit },
    world: { value: worldValue, unit: worldUnit },
    precision,
    showSecondary: false,
  };
}
