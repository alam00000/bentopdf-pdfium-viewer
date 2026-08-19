import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', '..', 'src', 'vendor');

let modulePromise = null;

async function loadModule() {
  const { default: createPdfium } = await import(join(vendorDir, 'pdfium.js'));
  const M = await createPdfium({
    locateFile: (file, prefix) =>
      file.endsWith('.wasm') ? join(vendorDir, 'pdfium.wasm') : `${prefix}${file}`,
  });
  const cfg = M._malloc(48);
  M.HEAPU8.fill(0, cfg, cfg + 48);
  M.HEAPU32[cfg >> 2] = 2;
  M._FPDF_InitLibraryWithConfig(cfg);
  M._free(cfg);
  return M;
}

export function pdfium() {
  if (!modulePromise) modulePromise = loadModule();
  return modulePromise;
}

const RUN_SIZE = 60;
const FMT_SIZE = 36;

export class TestEngine {
  constructor(M) {
    this.M = M;
    this.doc = 0;
    this.page = 0;
    this.session = 0;
    this.docBuf = 0;
    this.pageCount = 0;
    this.pageT = [1, 0, 0, 1, 0, 0];
  }

  static async create() {
    return new TestEngine(await pdfium());
  }

  close() {
    const M = this.M;
    if (this.page) M._FPDF_ClosePage(this.page);
    if (this.session) M._ec_session_destroy(this.session);
    if (this.doc) M._FPDF_CloseDocument(this.doc);
    if (this.docBuf) M._free(this.docBuf);
    this.page = 0;
    this.session = 0;
    this.doc = 0;
    this.docBuf = 0;
  }

  open(bytes) {
    const M = this.M;
    this.close();
    const buf = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, buf);
    const doc = M._FPDF_LoadMemDocument64(buf, bytes.length, 0);
    if (!doc) {
      M._free(buf);
      throw new Error('could not open fixture as a PDF');
    }
    this.docBuf = buf;
    this.doc = doc;
    this.session = M._ec_session_create(doc, 0, 0);
    this.pageCount = M._FPDF_GetPageCount(doc);
  }

  loadPage(index) {
    const M = this.M;
    if (this.page) M._FPDF_ClosePage(this.page);
    this.page = M._FPDF_LoadPage(this.doc, index);
    this.pageIndex = index;
  }

  reloadPage() {
    const M = this.M;
    M._ec_generate_content(this.session, this.page);
    M._FPDF_ClosePage(this.page);
    this.page = M._FPDF_LoadPage(this.doc, this.pageIndex);
  }

  buildModel() {
    const M = this.M;
    const ptr = M._ec_build_page_model(this.session, this.page);
    if (!ptr) return [];
    const json = M.UTF8ToString(ptr);
    M._ec_string_free(ptr);
    return JSON.parse(json).paragraphs;
  }

  allocString(s) {
    const M = this.M;
    const n = M.lengthBytesUTF8(s || '') + 1;
    const p = M._malloc(n);
    M.stringToUTF8(s || '', p, n);
    return p;
  }

  writeRuns(runs) {
    const M = this.M;
    const arr = M._malloc(RUN_SIZE * runs.length);
    const strs = [];
    runs.forEach((r, i) => {
      const b = arr + i * RUN_SIZE;
      const tp = this.allocString(r.text);
      const fp = this.allocString(r.family || '');
      strs.push(tp, fp);
      M.HEAPU32[(b + 0) >> 2] = tp;
      M.HEAPU32[(b + 4) >> 2] = fp;
      M.HEAP32[(b + 8) >> 2] = r.bold === 2 ? 2 : r.bold ? 1 : 0;
      M.HEAP32[(b + 12) >> 2] = r.italic === 2 ? 2 : r.italic ? 1 : 0;
      M.HEAPF32[(b + 16) >> 2] = r.size;
      M.HEAPU32[(b + 20) >> 2] = r.rgba >>> 0;
      M.HEAP32[(b + 24) >> 2] = r.underline ? 1 : 0;
      M.HEAP32[(b + 28) >> 2] = r.strike ? 1 : 0;
      M.HEAP32[(b + 32) >> 2] = r.script | 0;
      M.HEAP32[(b + 36) >> 2] = r.sourceIndex == null ? -1 : r.sourceIndex;
      M.HEAP32[(b + 40) >> 2] = r.renderMode | 0;
      M.HEAPU32[(b + 44) >> 2] = (r.strokeRgba || 0) >>> 0;
      M.HEAPF32[(b + 48) >> 2] = r.strokeWidth || 1;
      M.HEAPF32[(b + 52) >> 2] = r.hScale || 1;
      M.HEAPF32[(b + 56) >> 2] = r.rise || 0;
    });
    return { arr, strs, count: runs.length };
  }

  writeFmt(fmt) {
    const M = this.M;
    const p = M._malloc(FMT_SIZE);
    M.HEAP32[(p + 0) >> 2] = fmt.align | 0;
    M.HEAPF32[(p + 4) >> 2] = fmt.lineSpacing;
    M.HEAPF32[(p + 8) >> 2] = fmt.charSpacing || 0;
    M.HEAPF32[(p + 12) >> 2] = fmt.paraSpacing || 0;
    M.HEAPF32[(p + 16) >> 2] = fmt.wordSpacing || 0;
    M.HEAPF32[(p + 20) >> 2] = fmt.firstIndent || 0;
    M.HEAPF32[(p + 24) >> 2] = fmt.hangIndent || 0;
    M.HEAP32[(p + 28) >> 2] = fmt.dir | 0;
    M.HEAP32[(p + 32) >> 2] = fmt.listLevel | 0;
    return p;
  }

  freeRuns(alloc) {
    for (const s of alloc.strs) this.M._free(s);
    this.M._free(alloc.arr);
  }

  commitParagraph(id, runs, fmt) {
    const M = this.M;
    const a = this.writeRuns(runs);
    const f = this.writeFmt(fmt);
    const ptr = M._ec_commit_paragraph(this.session, this.page, id, a.arr, a.count, f);
    this.freeRuns(a);
    M._free(f);
    if (!ptr) return null;
    const json = M.UTF8ToString(ptr);
    M._ec_string_free(ptr);
    return JSON.parse(json);
  }

  moveParagraph(id, dx, dy) {
    return this.M._ec_move_paragraph(this.session, this.page, id, dx, dy);
  }

  deleteParagraph(id) {
    return this.M._ec_delete_paragraph(this.session, this.page, id);
  }
}

export function paragraphText(p) {
  return p.runs.map((r) => r.text).join('');
}

export function allText(paragraphs) {
  return paragraphs.map(paragraphText).join('\n');
}

export function normalizedText(paragraphs) {
  return allText(paragraphs).replace(/\s+/g, ' ').trim();
}

export function runsFrom(p, text) {
  return [{ ...p.runs[0], text }];
}

export function boxContains(outer, inner) {
  const eps = 0.5;
  return (
    inner.x >= outer.x - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.top <= outer.top + eps &&
    inner.top - inner.h >= outer.top - outer.h - eps
  );
}

export function boxOverlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.top, b.top) - Math.max(a.top - a.h, b.top - b.h);
  return w > 0 && h > 0 ? w * h : 0;
}

export function overlappingPairs(paragraphs, minRatio = 0.25) {
  const hits = [];
  for (let i = 0; i < paragraphs.length; i++) {
    for (let j = i + 1; j < paragraphs.length; j++) {
      const a = paragraphs[i];
      const b = paragraphs[j];
      const area = boxOverlapArea(a.box, b.box);
      if (area <= 0) continue;
      const smallest = Math.min(a.box.w * a.box.h, b.box.w * b.box.h);
      if (smallest > 0 && area / smallest >= minRatio) hits.push([a.id, b.id]);
    }
  }
  return hits;
}
