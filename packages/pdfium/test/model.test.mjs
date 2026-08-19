import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TestEngine, paragraphText, overlappingPairs, boxContains } from './helpers/engine.mjs';
import { closeTo, knownGap } from './helpers/assert-extra.mjs';
import {
  singleParagraphPdf,
  twoParagraphPdf,
  splitLinePdf,
  twoColumnPdf,
  headingAndBodyPdf,
  centeredParagraphPdf,
  doubleSpacedPdf,
  greetingAndParagraphPdf,
  markerColumnPdf,
  twoPagePdf,
  privateUseFontPdf,
  PARA_A,
  A_TEXT,
  B_TEXT,
} from './helpers/fixtures.mjs';

let engine;

before(async () => {
  engine = await TestEngine.create();
});

after(() => {
  engine.close();
});

function build(bytes, pageIndex = 0) {
  engine.open(bytes);
  engine.loadPage(pageIndex);
  return engine.buildModel();
}

describe('paragraph grouping', () => {
  test('groups consecutive lines of one block into a single paragraph', () => {
    const model = build(singleParagraphPdf());
    assert.equal(model.length, 1);
    assert.equal(model[0].lines.length, 3);
    assert.equal(paragraphText(model[0]), A_TEXT);
  });

  test('keeps vertically separated blocks apart', () => {
    const model = build(twoParagraphPdf());
    assert.equal(model.length, 2);
    assert.equal(paragraphText(model[0]), A_TEXT);
    assert.equal(paragraphText(model[1]), B_TEXT);
  });

  test('returns paragraphs in reading order, top to bottom', () => {
    const model = build(twoParagraphPdf());
    assert.ok(model[0].box.top > model[1].box.top);
  });

  test('does not split a line into separate paragraphs across ordinary word gaps', () => {
    for (const gap of [4, 8, 16, 30]) {
      const model = build(splitLinePdf(gap));
      assert.equal(model.length, 1, `gap of ${gap}pt should stay one paragraph`);
      const text = paragraphText(model[0]);
      assert.ok(text.includes('paper for your assignment.'));
      assert.ok(text.includes('The second line continues'));
    }
  });

  test('separates side-by-side columns instead of merging across the gutter', () => {
    const model = build(twoColumnPdf());
    assert.equal(model.length, 2);
    const texts = model.map(paragraphText);
    assert.ok(texts.some((t) => t.startsWith('Left column')));
    assert.ok(texts.some((t) => t.startsWith('Right column')));
    for (const t of texts) {
      assert.ok(!(t.includes('Left column') && t.includes('Right column')));
    }
  });

  test('groups a paragraph set at loose line spacing', () => {
    const model = build(doubleSpacedPdf(16));
    assert.equal(model.length, 1);
    assert.equal(paragraphText(model[0]), A_TEXT);
  });

  test('keeps a short standalone line above a paragraph separate', () => {
    const model = build(greetingAndParagraphPdf());
    assert.equal(model.length, 2);
    assert.equal(paragraphText(model[0]), 'Hi, APA Styler!');
    assert.ok(paragraphText(model[1]).startsWith('Thank you for using'));
  });

  test('keeps an interleaved marker column together', () => {
    const model = build(markerColumnPdf());
    const markers = model.filter((p) => /^-+$/.test(paragraphText(p).trim()));
    assert.equal(markers.length, 1, 'the marker column should be one paragraph');
    assert.equal(markers[0].lines.length, 4);
  });

  test('groups a double-spaced paragraph into one box', () => {
    const model = build(doubleSpacedPdf(24));
    assert.equal(model.length, 1);
    assert.equal(paragraphText(model[0]), A_TEXT);
  });

  test('keeps a heading separate from the body text that follows it', () => {
    const model = build(headingAndBodyPdf());
    assert.equal(model.length, 2);
    assert.equal(paragraphText(model[0]), 'A Bold Heading');
    closeTo(model[0].runs[0].size, 20, 0.2);
    closeTo(model[1].runs[0].size, 12, 0.2);
  });
});

describe('bounding boxes', () => {
  const fixtures = [
    singleParagraphPdf,
    twoParagraphPdf,
    twoColumnPdf,
    headingAndBodyPdf,
    centeredParagraphPdf,
  ];

  test('never nests one paragraph box inside another', () => {
    for (const make of fixtures) {
      const model = build(make());
      for (const a of model) {
        for (const b of model) {
          if (a.id === b.id) continue;
          assert.ok(!boxContains(a.box, b.box), `paragraph ${b.id} nested inside ${a.id}`);
        }
      }
    }
  });

  test('does not produce substantially overlapping paragraph boxes', () => {
    for (const make of [twoParagraphPdf, twoColumnPdf, headingAndBodyPdf]) {
      assert.deepEqual(overlappingPairs(build(make())), []);
    }
  });

  test('gives every paragraph a positive, finite box', () => {
    for (const p of build(twoParagraphPdf())) {
      assert.ok(Number.isFinite(p.box.x));
      assert.ok(Number.isFinite(p.box.top));
      assert.ok(p.box.w > 0);
      assert.ok(p.box.h > 0);
    }
  });

  test('covers every reported line within the paragraph box', () => {
    const p = build(singleParagraphPdf())[0];
    for (const ln of p.lines) {
      assert.ok(ln.x >= p.box.x - 0.5);
      assert.ok(ln.x + ln.w <= p.box.x + p.box.w + 0.5);
      assert.ok(ln.y <= p.box.top + 0.5);
      assert.ok(ln.y >= p.box.top - p.box.h - 0.5);
    }
  });
});

describe('line geometry', () => {
  test('reports line baselines matching the source leading', () => {
    const p = build(singleParagraphPdf())[0];
    const ys = p.lines.map((l) => l.y);
    closeTo(ys[0] - ys[1], 14, 0.05);
    closeTo(ys[1] - ys[2], 14, 0.05);
  });

  test('reports character offsets that index into the paragraph text', () => {
    const p = build(singleParagraphPdf())[0];
    const text = paragraphText(p);
    let previous = -1;
    for (const ln of p.lines) {
      assert.ok(ln.off > previous);
      assert.ok(ln.off < text.length);
      previous = ln.off;
    }
    assert.equal(p.lines[0].off, 0);
  });

  test('derives a line spacing close to the source leading over font size', () => {
    const p = build(singleParagraphPdf())[0];
    assert.ok(p.format.lineSpacing > 1.0);
    assert.ok(p.format.lineSpacing < 1.4);
  });
});

describe('editability', () => {
  test('marks ordinary text paragraphs editable with no lock reason', () => {
    for (const make of [
      singleParagraphPdf,
      twoParagraphPdf,
      twoColumnPdf,
      headingAndBodyPdf,
      centeredParagraphPdf,
    ]) {
      for (const p of build(make())) {
        assert.equal(p.editable, true);
        assert.equal(p.lockReason, 0);
      }
    }
  });

  test('never reports a lock reason for text drawn with a private-use encoding', () => {
    for (const p of build(privateUseFontPdf())) {
      assert.equal(p.editable, true);
      assert.equal(p.lockReason, 0);
    }
  });

  knownGap('exposes private-use characters instead of one atomic placeholder', () => {
    assert.notEqual(paragraphText(build(privateUseFontPdf())[0]), '￼');
  });
});

describe('multi-page documents', () => {
  test('builds an independent model per page', () => {
    engine.open(twoPagePdf());
    assert.equal(engine.pageCount, 2);

    engine.loadPage(0);
    const first = engine.buildModel();
    engine.loadPage(1);
    const second = engine.buildModel();

    assert.equal(paragraphText(first[0]), PARA_A.join(' '));
    assert.equal(paragraphText(second[0]), B_TEXT);
  });
});
