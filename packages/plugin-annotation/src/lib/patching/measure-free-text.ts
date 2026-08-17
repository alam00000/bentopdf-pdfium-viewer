import { PdfFreeTextAnnoObject, freeTextFontCssProperties } from '@embedpdf/models';

export function measureFreeTextContentHeight(
  obj: Pick<PdfFreeTextAnnoObject, 'contents' | 'fontSize' | 'fontFamily' | 'fontFamilyName'>,
  contentWidth: number,
): number | null {
  if (typeof document === 'undefined' || !document.body) return null;

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.left = '-100000px';
  probe.style.top = '0';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.boxSizing = 'content-box';
  probe.style.width = `${Math.max(1, contentWidth)}px`;
  probe.style.fontSize = `${obj.fontSize}px`;
  probe.style.lineHeight = '1.18';

  const fontCss = freeTextFontCssProperties(obj.fontFamily, obj.fontFamilyName);
  for (const [key, value] of Object.entries(fontCss)) {
    if (value != null) (probe.style as unknown as Record<string, string>)[key] = String(value);
  }

  for (const line of (obj.contents ?? '').split(/\r\n?|\n/)) {
    const lineDiv = document.createElement('div');
    lineDiv.dir = 'auto';
    if (line) lineDiv.textContent = line;
    else lineDiv.appendChild(document.createElement('br'));
    probe.appendChild(lineDiv);
  }

  document.body.appendChild(probe);
  const height = probe.scrollHeight;
  probe.remove();
  return height;
}

export const FREE_TEXT_FONT_KEYS = [
  'fontSize',
  'fontFamily',
  'fontFamilyName',
  'fontPostScriptName',
  'fontFaceName',
] as const;

export function freeTextFontChanged(changes: Partial<PdfFreeTextAnnoObject>): boolean {
  return FREE_TEXT_FONT_KEYS.some((k) => changes[k] !== undefined);
}
