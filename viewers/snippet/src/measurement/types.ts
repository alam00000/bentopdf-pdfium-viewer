import type { Unit } from './units';

export type Precision = number;

export const PRECISIONS: readonly Precision[] = [1, 0.1, 0.01, 0.001, 0.0001, -2, -4, -8, -16];

export function isFractionPrecision(p: Precision): boolean {
  return p < 0;
}

export function precisionLabel(p: Precision): string {
  return isFractionPrecision(p) ? `1/${-p}` : String(p);
}

export function precisionKey(p: Precision): string {
  return isFractionPrecision(p) ? `f${-p}` : `d${p}`;
}

export function parsePrecisionKey(key: string): Precision {
  if (key.startsWith('f')) return -parseInt(key.slice(1), 10);
  if (key.startsWith('d')) return parseFloat(key.slice(1));
  const n = parseFloat(key);
  return Number.isFinite(n) ? n : 0.01;
}

export interface ScalePreset {
  id: string;
  name: string;
  page: { value: number; unit: Unit };
  world: { value: number; unit: Unit };
  precision: Precision;
  showSecondary: boolean;
  secondary?: { unit: Unit; precision?: Precision };
  vertical?: {
    page: { value: number; unit: Unit };
    world: { value: number; unit: Unit };
  };
}

export interface ScaleState {
  presets: ScalePreset[];
  activePresetId: string;
}

export interface NumberFormat {
  U: string;
  C: number;
  F: 'D' | 'F' | 'R' | 'T';
  D: number;
  FD?: boolean;
  RT?: string;
  RD?: string;
  PS?: string;
  SS?: string;
  O?: 'S' | 'P';
}

export interface MeasureDict {
  R: string;
  X: NumberFormat[];
  Y?: NumberFormat[];
  D: NumberFormat[];
  A: NumberFormat[];
  CYX?: number;
}

export interface CaptionOffset {
  dx: number;
  dy: number;
}

export type MeasurementToolId = 'distance' | 'perimeter' | 'area';

export interface PreviewSnapshot {
  toolId: MeasurementToolId;
  rawPdfUnits: number;
  angleDeg?: number;
  deltaX?: number;
  deltaY?: number;
  preset: ScalePreset;
  areaName?: string;
}
