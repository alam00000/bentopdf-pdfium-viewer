const PAPER_SIZES_PT: ReadonlyArray<{ name: string; w: number; h: number }> = [
  { name: 'A0', w: 2383.94, h: 3370.39 },
  { name: 'A1', w: 1683.78, h: 2383.94 },
  { name: 'A2', w: 1190.55, h: 1683.78 },
  { name: 'A3', w: 841.89, h: 1190.55 },
  { name: 'A4', w: 595.28, h: 841.89 },
  { name: 'A5', w: 419.53, h: 595.28 },
  { name: 'A6', w: 297.64, h: 419.53 },
  { name: 'A7', w: 209.76, h: 297.64 },
  { name: 'B4', w: 708.66, h: 1000.63 },
  { name: 'B5', w: 498.9, h: 708.66 },
  { name: 'JIS B4', w: 728.5, h: 1031.81 },
  { name: 'JIS B5', w: 515.91, h: 728.5 },
  { name: 'US Letter', w: 612, h: 792 },
  { name: 'US Legal', w: 612, h: 1008 },
  { name: 'Tabloid', w: 792, h: 1224 },
  { name: 'Executive', w: 522, h: 756 },
  { name: 'Statement', w: 396, h: 612 },
  { name: 'Photo 4×6', w: 288, h: 432 },
  { name: 'Photo 5×7', w: 360, h: 504 },
  { name: 'Photo 8×10', w: 576, h: 720 },
];

export function formatPageSize(widthPt: number, heightPt: number): string {
  if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt)) return '';
  if (widthPt <= 0 || heightPt <= 0) return '';
  const TOL = 3;
  const minD = Math.min(widthPt, heightPt);
  const maxD = Math.max(widthPt, heightPt);
  const match = PAPER_SIZES_PT.find(
    (p) => Math.abs(Math.min(p.w, p.h) - minD) <= TOL && Math.abs(Math.max(p.w, p.h) - maxD) <= TOL,
  );
  const wMm = Math.round((widthPt * 25.4) / 72);
  const hMm = Math.round((heightPt * 25.4) / 72);
  const dim = `${wMm} × ${hMm} mm`;
  return match ? `${match.name} (${dim})` : dim;
}

export function pageSizeLabel(
  page: { size: { width: number; height: number }; rotation: number } | undefined,
): string {
  if (!page) return '';
  const turned = page.rotation % 2 === 1;
  return formatPageSize(
    turned ? page.size.height : page.size.width,
    turned ? page.size.width : page.size.height,
  );
}
