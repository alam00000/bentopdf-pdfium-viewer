import type { ScalePreset, Precision } from './types';
import type { Unit } from './units';
import { TO_IN, UNITS } from './units';

interface ParsedRatio {
  pageValue: number;
  pageUnit: Unit;
  worldValue: number;
  worldUnit: Unit;
}

const UNIT_SET = new Set<string>(UNITS);

const UNIT_ALIASES: Readonly<Record<string, Unit>> = {
  in: 'in',
  inch: 'in',
  inches: 'in',
  '"': 'in',
  ft: 'ft',
  foot: 'ft',
  feet: 'ft',
  "'": 'ft',
  pt: 'pt',
  point: 'pt',
  points: 'pt',
  mm: 'mm',
  millimeter: 'mm',
  millimetre: 'mm',
  millimeters: 'mm',
  millimetres: 'mm',
  cm: 'cm',
  centimeter: 'cm',
  centimetre: 'cm',
  centimeters: 'cm',
  centimetres: 'cm',
  m: 'm',
  meter: 'm',
  metre: 'm',
  meters: 'm',
  metres: 'm',
  km: 'km',
  kilometer: 'km',
  kilometre: 'km',
  kilometers: 'km',
  kilometres: 'km',
  yd: 'yd',
  yard: 'yd',
  yards: 'yd',
  mi: 'mi',
  mile: 'mi',
  miles: 'mi',
};

function normalizeUnit(raw: string | undefined): Unit | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (UNIT_ALIASES[key]) return UNIT_ALIASES[key];
  if (UNIT_SET.has(key)) return key as Unit;
  return null;
}

function parseRatioString(r: string): ParsedRatio | null {
  const m = r.match(
    /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([A-Za-z"']+)\s*=\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([A-Za-z"']+)\s*$/,
  );
  if (!m) return null;
  const pageValue = parseFloat(m[1]!.replace(/,/g, ''));
  const pageUnit = normalizeUnit(m[2]);
  const worldValue = parseFloat(m[3]!.replace(/,/g, ''));
  const worldUnit = normalizeUnit(m[4]);
  if (
    !Number.isFinite(pageValue) ||
    pageValue <= 0 ||
    !Number.isFinite(worldValue) ||
    worldValue <= 0 ||
    !pageUnit ||
    !worldUnit
  ) {
    return null;
  }
  return { pageValue, pageUnit, worldValue, worldUnit };
}

function precisionFromTerminal(entry: { F?: string; D?: number } | undefined): Precision {
  if (!entry || typeof entry.D !== 'number') return 0.01;
  if (entry.F === 'F') return -entry.D;
  if (entry.D <= 1) return 1;
  return 1 / entry.D;
}

export function parseScaleText(r: string): { x: ParsedRatio; y?: ParsedRatio } | null {
  const two = r.match(/^\s*in\s+X\s+(.+?)\s*[,;]\s*in\s+Y\s+(.+?)\s*$/i);
  if (two) {
    const x = parseRatioString(two[1]!);
    const y = parseRatioString(two[2]!);
    return x && y ? { x, y } : null;
  }
  const one = parseRatioString(r);
  return one ? { x: one } : null;
}

const METRIC: ReadonlySet<Unit> = new Set<Unit>(['mm', 'cm', 'm', 'km']);

type NumberFormatJson = { U?: string; C?: number; F?: string; D?: number };

function ratioFromChain(
  entry: NumberFormatJson | undefined,
  userUnit: number,
): { page: { value: number; unit: Unit }; world: { value: number; unit: Unit } } | null {
  const unit = normalizeUnit(entry?.U);
  const c = entry?.C;
  if (!unit || typeof c !== 'number' || !Number.isFinite(c) || !(c > 0)) return null;
  const perInch = (c * 72) / userUnit;
  if (METRIC.has(unit)) {
    return { page: { value: 1, unit: 'cm' }, world: { value: perInch / 2.54, unit } };
  }
  return { page: { value: 1, unit: 'in' }, world: { value: perInch, unit } };
}

type Ratio = { page: { value: number; unit: Unit }; world: { value: number; unit: Unit } };

function asRatio(r: ParsedRatio): Ratio {
  return {
    page: { value: r.pageValue, unit: r.pageUnit },
    world: { value: r.worldValue, unit: r.worldUnit },
  };
}

function inchesPerInch(r: Ratio): number {
  return (r.world.value * TO_IN[r.world.unit]) / (r.page.value * TO_IN[r.page.unit]);
}

function inUnit(
  ratio: { page: { value: number; unit: Unit }; world: { value: number; unit: Unit } },
  unit: Unit,
): { page: { value: number; unit: Unit }; world: { value: number; unit: Unit } } {
  if (ratio.world.unit === unit) return ratio;
  return {
    page: ratio.page,
    world: { value: (ratio.world.value * TO_IN[ratio.world.unit]) / TO_IN[unit], unit },
  };
}

export function presetFromMeasureJson(
  measureJson: string | undefined | null,
  userUnit = 1,
): ScalePreset | null {
  if (!measureJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(measureJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as {
    R?: unknown;
    Subtype?: unknown;
    X?: NumberFormatJson[];
    Y?: NumberFormatJson[];
    D?: unknown[];
    A?: unknown[];
  };
  if (typeof m.Subtype === 'string' && m.Subtype !== 'RL') return null;
  const uu = Number.isFinite(userUnit) && userUnit > 0 ? userUnit : 1;

  const text = typeof m.R === 'string' ? parseScaleText(m.R) : null;
  const xEntry = Array.isArray(m.X) ? m.X[0] : undefined;
  const yEntry = Array.isArray(m.Y) ? m.Y[0] : undefined;
  let across = text ? asRatio(text.x) : ratioFromChain(xEntry, uu);
  if (!across) return null;
  let up = text?.y ? asRatio(text.y) : null;
  if (!up && yEntry) {
    const fromY = ratioFromChain(yEntry, uu);
    const fromX = ratioFromChain(xEntry, uu);
    if (fromY && fromX) {
      const yIn = inchesPerInch(fromY);
      const xIn = inchesPerInch(fromX);
      if (Math.abs(yIn - xIn) > 1e-9 * Math.max(yIn, xIn)) {
        const paperInches = across.page.value * TO_IN[across.page.unit];
        up = {
          page: across.page,
          world: { value: (yIn * paperInches) / TO_IN[fromY.world.unit], unit: fromY.world.unit },
        };
      }
    }
  }

  const dArr: Array<{ F?: string; D?: number; U?: string }> = Array.isArray(m.D)
    ? (m.D as Array<{ F?: string; D?: number; U?: string }>)
    : [];
  const d0 = dArr[0];
  const dTerminal = dArr.length > 1 ? dArr[dArr.length - 1] : undefined;
  const secondaryUnit = dTerminal ? normalizeUnit(dTerminal.U) : null;
  const showSecondary = !!(dTerminal && secondaryUnit);
  const precision = precisionFromTerminal(showSecondary ? dTerminal : d0);

  const displayUnit = normalizeUnit(d0?.U);
  if (displayUnit && displayUnit !== across.world.unit) {
    across = inUnit(across, displayUnit);
  }

  return {
    id: 'embedded',
    name: '',
    page: across.page,
    world: across.world,
    precision,
    showSecondary,
    secondary: showSecondary ? { unit: secondaryUnit as Unit, precision } : undefined,
    ...(up ? { vertical: up } : {}),
  };
}
