export type Unit = 'in' | 'mm' | 'cm' | 'pt' | 'ft' | 'm' | 'yd' | 'km' | 'mi';

export const UNITS: readonly Unit[] = [
  'in',
  'mm',
  'cm',
  'pt',
  'ft',
  'm',
  'yd',
  'km',
  'mi',
] as const;

export const CALIBRATE_UNITS: readonly Unit[] = UNITS.filter((u) => u !== 'pt');

export const TO_IN: Readonly<Record<Unit, number>> = {
  in: 1,
  pt: 1 / 72,
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  ft: 12,
  yd: 36,
  m: 1 / 0.0254,
  km: 1 / 0.0000254,
  mi: 63360,
};

export const UNIT_LABEL: Readonly<Record<Unit, string>> = {
  in: 'in',
  mm: 'mm',
  cm: 'cm',
  pt: 'pt',
  ft: 'ft',
  m: 'm',
  yd: 'yd',
  km: 'km',
  mi: 'mi',
};

export const UNIT_LABEL_SQ: Readonly<Record<Unit, string>> = {
  in: 'in²',
  mm: 'mm²',
  cm: 'cm²',
  pt: 'pt²',
  ft: 'ft²',
  m: 'm²',
  yd: 'yd²',
  km: 'km²',
  mi: 'mi²',
};

export function convert(value: number, from: Unit, to: Unit): number {
  if (from === to) return value;
  return (value * TO_IN[from]) / TO_IN[to];
}

export function pdfPointsToWorld(
  pdfPoints: number,
  pageValue: number,
  pageUnit: Unit,
  worldValue: number,
  worldUnit: Unit,
  displayUnit: Unit,
): number {
  const inchesWorldPerPdfPoint =
    ((1 / 72) * (worldValue * TO_IN[worldUnit])) / (pageValue * TO_IN[pageUnit]);
  return (pdfPoints * inchesWorldPerPdfPoint) / TO_IN[displayUnit];
}
