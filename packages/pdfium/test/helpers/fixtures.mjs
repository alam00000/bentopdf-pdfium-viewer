import { buildPdf, buildTextPdf, textLine } from './pdf-builder.mjs';

const LEADING = 14;

export function paragraphContent(lines, x, topBaseline, size = 12, leading = LEADING, font = 'F1') {
  return lines.map((t, i) => textLine(font, size, x, topBaseline - i * leading, t)).join('');
}

export const PARA_A = [
  'The quick brown fox jumps over the lazy dog and',
  'continues running through the quiet field until it',
  'finally rests beneath an old oak tree.',
];

export const PARA_B = [
  'A second paragraph starts well below the first one',
  'and has two lines of its own.',
];

export const PARA_C = ['A third paragraph closes the page.'];

export const A_TEXT = PARA_A.join(' ');
export const B_TEXT = PARA_B.join(' ');
export const C_TEXT = PARA_C.join(' ');

export function singleParagraphPdf() {
  return buildTextPdf({ content: paragraphContent(PARA_A, 72, 700) });
}

export function twoParagraphPdf() {
  return buildTextPdf({
    content: paragraphContent(PARA_A, 72, 700) + paragraphContent(PARA_B, 72, 620),
  });
}

export function stackedParagraphPdf() {
  return buildTextPdf({
    content:
      paragraphContent(PARA_A, 72, 700) +
      paragraphContent(PARA_B, 72, 620) +
      paragraphContent(PARA_C, 72, 560),
  });
}

export function splitLinePdf(gap) {
  const secondX = 72 + 118 + gap;
  return buildTextPdf({
    content:
      textLine('F1', 12, 72, 700, 'Thank you for using our') +
      textLine('F1', 12, secondX, 700, 'paper for your assignment.') +
      textLine('F1', 12, 72, 686, 'The second line continues here normally.'),
  });
}

export function twoColumnPdf() {
  let content = '';
  for (let i = 0; i < 3; i++) {
    content += textLine('F1', 11, 60, 700 - i * 13, `Left column line ${i + 1} text`);
    content += textLine('F1', 11, 330, 700 - i * 13, `Right column line ${i + 1} text`);
  }
  return buildTextPdf({ content });
}

export function headingAndBodyPdf() {
  return buildTextPdf({
    content: textLine('F2', 20, 72, 700, 'A Bold Heading') + paragraphContent(PARA_A, 72, 660),
    fonts: [
      {
        name: 'F1',
        dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      },
      {
        name: 'F2',
        dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      },
    ],
  });
}

export function centeredParagraphPdf() {
  const lines = ['Centered heading line', 'and a shorter one'];
  let content = '';
  lines.forEach((t, i) => {
    const w = t.length * 6.2;
    content += textLine('F1', 12, (612 - w) / 2, 700 - i * LEADING, t);
  });
  return buildTextPdf({ content });
}

export function greetingAndParagraphPdf() {
  return buildTextPdf({
    content:
      textLine('F1', 12, 216, 614, 'Hi, APA Styler!') +
      paragraphContent(
        [
          'Thank you for using the APA Style annotated sample',
          'student paper for your assignment.',
        ],
        216,
        590,
        12,
        16,
      ),
  });
}

export function markerColumnPdf() {
  let content = '';
  for (let i = 0; i < 4; i++) {
    content += textLine('F1', 11, 90, 700 - i * 20, '-');
    content += textLine('F1', 11, 120, 695 - i * 20, `List item number ${i + 1}`);
  }
  return buildTextPdf({ content });
}

export function doubleSpacedPdf(leading = 24) {
  return buildTextPdf({ content: paragraphContent(PARA_A, 72, 700, 12, leading) });
}

export function twoPagePdf() {
  const c1 = new TextEncoder().encode(paragraphContent(PARA_A, 72, 700));
  const c2 = new TextEncoder().encode(paragraphContent(PARA_B, 72, 700));
  return buildPdf([
    { body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { body: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>' },
    {
      body:
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    },
    { body: `<< /Length ${c1.length} >>`, stream: c1 },
    { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    {
      body:
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    },
    { body: `<< /Length ${c2.length} >>`, stream: c2 },
  ]);
}

export function privateUseFontPdf() {
  const cmap =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
    '/CMapName /Custom def /CMapType 2 def\n' +
    '1 begincodespacerange <00> <FF> endcodespacerange\n' +
    '4 beginbfchar <48> <E001> <65> <E002> <6C> <E003> <6F> <E004> endbfchar\n' +
    'endcmap CMapName currentdict /CMap defineresource pop end end';
  const cmapBytes = new TextEncoder().encode(cmap);
  const content = new TextEncoder().encode(
    textLine('F1', 14, 72, 700, 'Hello there fellow') +
      textLine('F1', 14, 72, 682, 'reader of the page'),
  );
  return buildPdf([
    { body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      body:
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    },
    { body: `<< /Length ${content.length} >>`, stream: content },
    {
      body:
        '<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Arial /FirstChar 32 ' +
        '/LastChar 122 /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
    },
    { body: `<< /Length ${cmapBytes.length} >>`, stream: cmapBytes },
  ]);
}
