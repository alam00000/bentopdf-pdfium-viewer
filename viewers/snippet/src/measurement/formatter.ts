import type { NumberFormat, ScalePreset, MeasureDict } from './types';
import { TO_IN, UNIT_LABEL, UNIT_LABEL_SQ, type Unit } from './units';

export function formatMeasurement(raw: number, chain: readonly NumberFormat[]): string {
  if (chain.length === 0) return String(raw);
  return formatChain(raw, chain, 0).trim();
}

function roundToFormat(value: number, f: NumberFormat): number {
  if (f.F === 'F') {
    const denom = Math.max(1, Math.round(f.D));
    return Math.round(value * denom) / denom;
  }
  const decimals = f.D <= 1 ? 0 : Math.round(Math.log10(f.D));
  const p = Math.pow(10, Math.min(100, Math.max(0, decimals)));
  return Math.round(value * p) / p;
}

function formatChain(value: number, chain: readonly NumberFormat[], i: number): string {
  const f = chain[i]!;
  const converted = value * f.C;
  const isLast = i === chain.length - 1;

  if (!isLast) {
    let intPart = Math.trunc(converted);
    let fracPart = converted - intPart;

    const next = chain[i + 1]!;
    const nextRounded = roundToFormat(Math.abs(fracPart) * next.C, next);
    if (next.C > 0 && nextRounded >= next.C) {
      intPart += converted < 0 ? -1 : 1;
      fracPart = 0;
    }

    if (intPart !== 0 && Math.abs(fracPart) > 0) {
      const intText = formatInteger(intPart, f);
      const tail = formatChain(fracPart, chain, i + 1);
      return tail ? `${intText} ${tail}` : intText;
    }
    if (intPart !== 0) {
      return formatInteger(intPart, f);
    }
    if (Math.abs(fracPart) > 0) {
      return formatChain(fracPart, chain, i + 1);
    }
    return formatInteger(0, f);
  }

  return formatTerminal(converted, f);
}

function formatTerminal(value: number, f: NumberFormat): string {
  switch (f.F) {
    case 'D':
      return formatDecimal(value, f);
    case 'F':
      return formatFraction(value, f);
    case 'R':
      return formatInteger(Math.round(value), f);
    case 'T':
      return formatInteger(Math.trunc(value), f);
    default:
      return formatDecimal(value, f);
  }
}

function formatDecimal(value: number, f: NumberFormat): string {
  if (!Number.isFinite(value)) value = 0;
  const decimals = f.D <= 1 ? 0 : Math.min(100, Math.max(0, Math.round(Math.log10(f.D))));
  const sign = value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  const fixed = absValue.toFixed(decimals);

  const [intPart, fracPart] = fixed.split('.');
  const intGrouped = applyThousands(intPart!, f.RT ?? ',');
  const decimalSep = f.RD ?? '.';
  let numText: string;
  if (fracPart === undefined || fracPart === '') {
    numText = intGrouped;
  } else if (f.FD === false || f.FD === undefined) {
    const trimmed = fracPart.replace(/0+$/, '');
    numText = trimmed ? `${intGrouped}${decimalSep}${trimmed}` : intGrouped;
  } else {
    numText = `${intGrouped}${decimalSep}${fracPart}`;
  }
  return wrapWithLabel(sign + numText, f);
}

function formatFraction(value: number, f: NumberFormat): string {
  const denom = Math.max(1, Math.round(f.D));
  const sign = value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  const whole = Math.trunc(absValue);
  const frac = absValue - whole;
  let numer = Math.round(frac * denom);
  let d = denom;

  let wholeAdj = whole;
  if (numer === denom) {
    wholeAdj += 1;
    numer = 0;
  }

  if (!f.FD && numer > 0) {
    const g = gcd(numer, d);
    if (g > 1) {
      numer = numer / g;
      d = d / g;
    }
  }

  const intGrouped = applyThousands(String(wholeAdj), f.RT ?? ',');
  let numText: string;
  if (numer === 0) {
    numText = intGrouped;
  } else if (wholeAdj === 0) {
    numText = `${numer}/${d}`;
  } else {
    numText = `${intGrouped} ${numer}/${d}`;
  }
  return wrapWithLabel(sign + numText, f);
}

function formatInteger(value: number, f: NumberFormat): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const intGrouped = applyThousands(String(Math.trunc(abs)), f.RT ?? ',');
  return wrapWithLabel(sign + intGrouped, f);
}

function applyThousands(intDigits: string, sep: string): string {
  if (sep === '') return intDigits;
  const neg = intDigits.startsWith('-');
  const digits = neg ? intDigits.slice(1) : intDigits;
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return neg ? '-' + out : out;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

function wrapWithLabel(valueText: string, f: NumberFormat): string {
  const ps = f.PS ?? ' ';
  const ss = f.SS ?? '';
  const o = f.O ?? 'S';
  if (o === 'P') {
    return `${f.U}${ps}${valueText}${ss}`;
  }
  return `${valueText}${ps}${f.U}${ss}`;
}

function precisionToFormatFields(p: number): { F: 'D' | 'F'; D: number } {
  if (p < 0) {
    return { F: 'F', D: -p };
  }
  if (p >= 1) return { F: 'D', D: 1 };
  if (!(p > 0)) return { F: 'D', D: 1 };
  return { F: 'D', D: Math.round(1 / p) };
}

export function buildDistanceChain(preset: ScalePreset): NumberFormat[] {
  const primary = preset.world.unit;
  const C_primary = pdfPtsToUnitFactor(preset, primary);

  if (!preset.showSecondary || !preset.secondary) {
    const fmt = precisionToFormatFields(preset.precision);
    return [
      {
        U: UNIT_LABEL[primary],
        C: C_primary,
        F: fmt.F,
        D: fmt.D,
      },
    ];
  }

  const secondary = preset.secondary.unit;
  const C_secondary = TO_IN[primary] / TO_IN[secondary];
  const terminalPrec = preset.secondary.precision ?? preset.precision;
  const terminalFmt = precisionToFormatFields(terminalPrec);

  return [
    {
      U: UNIT_LABEL[primary],
      C: C_primary,
      F: 'D',
      D: 1,
    },
    {
      U: UNIT_LABEL[secondary],
      C: C_secondary,
      F: terminalFmt.F,
      D: terminalFmt.D,
    },
  ];
}

export function buildAreaChain(preset: ScalePreset): NumberFormat[] {
  const primary = preset.world.unit;
  const linearC = pdfPtsToUnitFactor(preset, primary);
  const C_primary = linearC * linearC;
  const fmt = precisionToFormatFields(preset.precision);

  return [
    {
      U: UNIT_LABEL_SQ[primary],
      C: C_primary,
      F: fmt.F,
      D: fmt.D,
    },
  ];
}

export function buildXChain(preset: ScalePreset): NumberFormat[] {
  return [buildDistanceChain(preset)[0]!];
}

export function buildScaleRatio(preset: ScalePreset): string {
  const pv = stripTrailingZeros(preset.page.value);
  const wv = stripTrailingZeros(preset.world.value);
  const across = `${pv} ${UNIT_LABEL[preset.page.unit]} = ${wv} ${UNIT_LABEL[preset.world.unit]}`;
  if (!preset.vertical) return across;
  const v = preset.vertical;
  const up =
    `${stripTrailingZeros(v.page.value)} ${UNIT_LABEL[v.page.unit]} = ` +
    `${stripTrailingZeros(v.world.value)} ${UNIT_LABEL[v.world.unit]}`;
  return `in X ${across}, in Y ${up}`;
}

export function verticalRatio(preset: ScalePreset): number {
  const v = preset.vertical;
  if (!v) return 1;
  const across = ratioIn(preset.page, preset.world);
  const up = ratioIn(v.page, v.world);
  if (!(across > 0) || !(up > 0) || !Number.isFinite(across) || !Number.isFinite(up)) {
    return 1;
  }
  return up / across;
}

function ratioIn(
  page: { value: number; unit: Unit },
  world: { value: number; unit: Unit },
): number {
  const pageInches = page.value * TO_IN[page.unit];
  const worldInches = world.value * TO_IN[world.unit];
  return pageInches > 0 ? worldInches / pageInches : 0;
}

export function sameScale(a: ScalePreset, b: ScalePreset): boolean {
  if (a.world.unit !== b.world.unit) return false;
  const close = (x: number, y: number) =>
    Math.abs(x - y) <= 1e-4 * Math.max(Math.abs(x), Math.abs(y));
  return (
    close(ratioIn(a.page, a.world), ratioIn(b.page, b.world)) &&
    close(verticalRatio(a), verticalRatio(b))
  );
}

function stripTrailingZeros(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

export function buildMeasureDict(preset: ScalePreset, userUnit = 1): MeasureDict {
  const dChain = buildDistanceChain(preset);
  const aChain = buildAreaChain(preset);
  const uu = Number.isFinite(userUnit) && userUnit > 0 ? userUnit : 1;
  const x = buildXChain(preset).map((e) => ({ ...e, C: e.C * uu }));
  const dict: MeasureDict = {
    R: buildScaleRatio(preset),
    X: x,
    D: [{ ...dChain[0]!, C: 1 }, ...dChain.slice(1)],
    A: [{ ...aChain[0]!, C: 1 }],
  };
  if (preset.vertical) {
    const yUnit = preset.vertical.world.unit;
    dict.Y = [
      {
        ...x[0]!,
        U: UNIT_LABEL[yUnit],
        C: ptsToUnitFactor(preset.vertical.page, preset.vertical.world, yUnit) * uu,
      },
    ];
    dict.CYX = TO_IN[yUnit] / TO_IN[preset.world.unit];
  }
  return dict;
}

function pdfPtsToUnitFactor(preset: ScalePreset, displayUnit: Unit): number {
  return ptsToUnitFactor(preset.page, preset.world, displayUnit);
}

function ptsToUnitFactor(
  page: { value: number; unit: Unit },
  world: { value: number; unit: Unit },
  displayUnit: Unit,
): number {
  const pageInches = page.value * TO_IN[page.unit];
  const worldInches = world.value * TO_IN[world.unit];
  if (!(pageInches > 0) || !Number.isFinite(worldInches)) return 0;
  const inchesPerPdfPoint = (1 / 72) * (worldInches / pageInches);
  return inchesPerPdfPoint / TO_IN[displayUnit];
}
