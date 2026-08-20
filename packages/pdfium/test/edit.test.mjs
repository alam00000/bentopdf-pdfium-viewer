import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TestEngine,
  paragraphText,
  allText,
  normalizedText,
  runsFrom,
  overlappingPairs,
} from './helpers/engine.mjs';
import { closeTo } from './helpers/assert-extra.mjs';
import {
  twoParagraphPdf,
  stackedParagraphPdf,
  centeredParagraphPdf,
  headingAndBodyPdf,
  oneUnmappedGlyphPdf,
  strayMarkerPdf,
  A_TEXT,
  B_TEXT,
  C_TEXT,
} from './helpers/fixtures.mjs';

let engine;

before(async () => {
  engine = await TestEngine.create();
});

after(() => {
  engine.close();
});

function build(bytes) {
  engine.open(bytes);
  engine.loadPage(0);
  return engine.buildModel();
}

function findByPrefix(model, prefix) {
  const hit = model.find((p) => paragraphText(p).startsWith(prefix));
  assert.ok(hit, `no paragraph starting with "${prefix}"`);
  return hit;
}

function editText(bytes, prefix, change) {
  const model = build(bytes);
  const target = findByPrefix(model, prefix);
  engine.commitParagraph(target.id, runsFrom(target, change(paragraphText(target))), target.format);
  return engine.buildModel();
}

describe('text changes', () => {
  test('applies an inserted character to the edited paragraph only', () => {
    const after = editText(twoParagraphPdf(), 'The quick', (t) => t.replace('quick', 'quicks'));
    assert.equal(after.length, 2);
    assert.equal(paragraphText(after[0]), A_TEXT.replace('quick', 'quicks'));
    assert.equal(paragraphText(after[1]), B_TEXT);
  });

  test('applies a deleted character without disturbing neighbours', () => {
    const after = editText(twoParagraphPdf(), 'The quick', (t) => t.replace('brown ', ''));
    assert.equal(paragraphText(after[0]), A_TEXT.replace('brown ', ''));
    assert.equal(paragraphText(after[1]), B_TEXT);
  });

  test('keeps the text verbatim through a no-op commit', () => {
    const after = editText(twoParagraphPdf(), 'The quick', (t) => t);
    assert.equal(paragraphText(after[0]), A_TEXT);
    assert.equal(paragraphText(after[1]), B_TEXT);
  });

  test('preserves every other paragraph when one grows onto a new line', () => {
    const after = editText(
      stackedParagraphPdf(),
      'The quick',
      (t) => t + ' plus a trailing sentence that forces another line.',
    );
    const text = allText(after);
    assert.ok(text.includes(B_TEXT));
    assert.ok(text.includes(C_TEXT));
    assert.ok(after[0].lines.length > 3);
  });

  test('does not lose neighbouring text when a paragraph grows several lines', () => {
    const after = editText(stackedParagraphPdf(), 'The quick', (t) => `${t} ${A_TEXT}`);
    assert.ok(allText(after).includes(B_TEXT));
    assert.ok(allText(after).includes(C_TEXT));
  });
});

describe('undecodable glyphs', () => {
  test('preserves an undecodable glyph through an edit', () => {
    const before = build(oneUnmappedGlyphPdf())[0];
    const original = paragraphText(before);
    assert.ok(original.includes('\uFFFD'));

    const result = engine.commitParagraph(
      before.id,
      runsFrom(before, original + '!'),
      before.format,
    );
    assert.ok(result, 'commit should be accepted');

    const after = engine.buildModel();
    const text = paragraphText(after[0]);
    assert.ok(
      text.includes('\uFFFD'),
      `the undecodable glyph should survive, got ${JSON.stringify(text)}`,
    );
    assert.ok(text.includes('Happy'));
  });
});

describe('stray page objects', () => {
  test('does not gain a space from a stray object when text is edited', () => {
    const before = build(strayMarkerPdf())[0];
    const original = paragraphText(before);
    engine.commitParagraph(before.id, runsFrom(before, original.replace('!', 'Z!')), before.format);
    const after = paragraphText(engine.buildModel()[0]);
    assert.equal(after, 'Happy writingZ!');
  });
});

describe('geometry stability', () => {
  test('keeps the paragraph origin fixed through a no-op commit', () => {
    const before = build(twoParagraphPdf())[0];
    const origin = {
      x: before.box.x,
      top: before.box.top,
      firstBaseline: before.firstBaseline,
    };
    engine.commitParagraph(before.id, runsFrom(before, paragraphText(before)), before.format);
    const after = engine.buildModel()[0];
    closeTo(after.box.x, origin.x, 0.01);
    closeTo(after.box.top, origin.top, 0.01);
    closeTo(after.firstBaseline, origin.firstBaseline, 0.01);
  });

  test('keeps every line baseline fixed through a no-op commit', () => {
    const before = build(twoParagraphPdf())[0];
    const baselines = before.lines.map((l) => l.y);
    engine.commitParagraph(before.id, runsFrom(before, paragraphText(before)), before.format);
    const after = engine.buildModel()[0];
    after.lines.forEach((ln, i) => closeTo(ln.y, baselines[i], 0.05));
  });

  test('leaves untouched paragraphs exactly where they were', () => {
    const before = build(stackedParagraphPdf());
    const others = before
      .slice(1)
      .map((p) => ({ text: paragraphText(p), x: p.box.x, top: p.box.top }));
    const target = before[0];
    engine.commitParagraph(
      target.id,
      runsFrom(target, paragraphText(target).replace('quick', 'quicks')),
      target.format,
    );
    const after = engine.buildModel();
    for (const snapshot of others) {
      const match = after.find((p) => paragraphText(p) === snapshot.text);
      assert.ok(match, `paragraph "${snapshot.text}" disappeared`);
      closeTo(match.box.x, snapshot.x, 0.01);
      closeTo(match.box.top, snapshot.top, 0.01);
    }
  });

  test('keeps a centered paragraph centered after an edit', () => {
    const before = build(centeredParagraphPdf())[0];
    const centre = before.box.x + before.box.w / 2;
    engine.commitParagraph(before.id, runsFrom(before, paragraphText(before)), before.format);
    const after = engine.buildModel()[0];
    closeTo(after.box.x + after.box.w / 2, centre, 4);
  });

  test('does not introduce overlapping boxes through a small edit', () => {
    const after = editText(stackedParagraphPdf(), 'The quick', (t) => t.replace('quick', 'quicks'));
    assert.deepEqual(overlappingPairs(after), []);
  });
});

describe('formatting changes', () => {
  test('applies a font size change to the edited paragraph only', () => {
    const model = build(twoParagraphPdf());
    const target = model[0];
    const runs = runsFrom(target, paragraphText(target)).map((r) => ({
      ...r,
      size: 16,
    }));
    engine.commitParagraph(target.id, runs, target.format);
    const after = engine.buildModel();
    closeTo(after[0].runs[0].size, 16, 0.2);
    closeTo(after[1].runs[0].size, 12, 0.2);
    assert.equal(paragraphText(after[1]), B_TEXT);
  });

  test('applies a colour change without altering the text', () => {
    const model = build(twoParagraphPdf());
    const target = model[0];
    const runs = runsFrom(target, paragraphText(target)).map((r) => ({
      ...r,
      rgba: 0xff0000ff,
    }));
    engine.commitParagraph(target.id, runs, target.format);
    const after = engine.buildModel();
    assert.equal(paragraphText(after[0]), A_TEXT);
    assert.equal(after[0].runs[0].rgba >>> 0, 0xff0000ff);
  });

  test('applies a bold change without altering the text', () => {
    const model = build(headingAndBodyPdf());
    const target = findByPrefix(model, 'The quick');
    const runs = runsFrom(target, paragraphText(target)).map((r) => ({
      ...r,
      bold: true,
    }));
    engine.commitParagraph(target.id, runs, target.format);
    const after = engine.buildModel();
    assert.ok(normalizedText(after).includes(A_TEXT));
    for (const p of after) {
      if (paragraphText(p).startsWith('The quick')) {
        assert.equal(p.runs[0].bold, true);
      }
    }
  });

  test('applies a line spacing change to the paragraph it targets', () => {
    const model = build(twoParagraphPdf());
    const target = model[0];
    engine.commitParagraph(target.id, runsFrom(target, paragraphText(target)), {
      ...target.format,
      lineSpacing: 2,
    });
    const after = engine.buildModel();
    const spanBefore = target.lines[0].y - target.lines[target.lines.length - 1].y;
    const baselines = after
      .filter((p) => !paragraphText(p).startsWith('A second'))
      .flatMap((p) => p.lines.map((l) => l.y));
    const spanAfter = Math.max(...baselines) - Math.min(...baselines);
    assert.ok(
      spanAfter > spanBefore * 1.4,
      `expected the paragraph to grow taller: ${spanAfter} vs ${spanBefore}`,
    );
    assert.ok(normalizedText(after).includes(A_TEXT));
  });
});

describe('structural operations', () => {
  test('translates a paragraph by exactly the requested delta', () => {
    const model = build(twoParagraphPdf());
    const before = { ...model[0].box };
    engine.moveParagraph(model[0].id, 20, -30);
    const after = engine.buildModel();
    const moved = findByPrefix(after, 'The quick');
    closeTo(moved.box.x - before.x, 20, 0.05);
    closeTo(moved.box.top - before.top, -30, 0.05);
  });

  test('deletes only the targeted paragraph', () => {
    const model = build(twoParagraphPdf());
    engine.deleteParagraph(model[0].id);
    const after = engine.buildModel();
    assert.equal(after.length, 1);
    assert.equal(paragraphText(after[0]), B_TEXT);
  });
});
