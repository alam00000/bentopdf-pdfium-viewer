// generate-functions.mjs
//
// ---------------------------------------------------------------------------
// Converts a Clang JSON AST into
//   • exported-functions.txt      (_FPDF_LoadPage,_PDFiumExt_Init,…)
//   • functions.ts               (typed map for cwrap)
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname }                      from 'node:path';
import { fileURLToPath }                         from 'node:url';

// ──────────────────────────────────────────────────────────────────────────
// 0 .  Helpers
// ──────────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));

/** ultra-simple C→TS mapping that already covers ~95 % of PDFium */
function cToTs(ctype, isRet = false) {
  const clean = ctype.replace(/\bconst\b/g, '').trim();

  if (clean === 'void')                 return isRet ? 'null' : null;
  if (/\*/.test(clean))                return 'number';          // pointer
  if (!isRet && /\bFPDF_BYTESTRING\b/.test(clean)) return 'string'; 
  if (/^(FPDF_BOOL|bool)\b/.test(clean)) return 'boolean'; 
  return 'number';                                          // int, enum, …
}

/** DFS walk that harvests every matching FunctionDecl */
function collectFunctions(node, out = []) {
  if (!node || typeof node !== 'object') return out;

  if (
    node.kind === 'FunctionDecl' &&
    node.name &&
    /^(?:FPDF|EPDF|FORM|PDFiumExt_|ec_)/.test(node.name)
  ) {
    const qual = node.type?.qualType || '';
    const m    = qual.match(/^(.*?)\s*\((.*?)\)$/);        // ret  ( params )
    if (m) {
      const [, retRaw, paramsRaw] = m;

      const ret  = cToTs(retRaw, true);
      const params =
        paramsRaw === 'void' || paramsRaw.trim() === ''
          ? []
          : paramsRaw.split(',').map(p => cToTs(p, false) ?? 'number');

      out.push({ name: node.name, params, ret });
    }
  }

  if (Array.isArray(node.inner)) {
    node.inner.forEach(child => collectFunctions(child, out));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 1 .  CLI & I/O
// ──────────────────────────────────────────────────────────────────────────
const [,, astPath, outDirArg = '.'] = process.argv;
if (!astPath) {
  console.error('usage: node parse-ast.mjs <ast.json> [outDir]');
  process.exit(1);
}

const outDir = resolve(outDirArg);
mkdirSync(outDir, { recursive: true });

const ast    = JSON.parse(readFileSync(astPath, 'utf8'));
const funcs  = collectFunctions(ast).sort((a, b) =>
  a.name.localeCompare(b.name),
);

/** functions we always want, even if they’re not in the AST */
const extraFunctions = ['malloc', 'free'];

// #1  exported-functions.txt  (for -sEXPORTED_FUNCTIONS=[…])
writeFileSync(
  resolve(outDir, 'exported-functions.txt'),
  [
    ...funcs.map(f => '_' + f.name),
    ...extraFunctions.map(n => '_' + n),            // <- add them here
  ].join(','),
  'utf8',
);

// #2  functions.ts  (typed map)
const tsLines = funcs.map(
  f =>
    `  ${f.name}: [${JSON.stringify(f.params)} as const, ${
      f.ret === 'null' ? 'null' : `'${f.ret}'`
    }] as const,`,
);

writeFileSync(
  resolve(outDir, 'functions.ts'),
  `/* AUTO-GENERATED — DO NOT EDIT BY HAND */\n` +
    `export const functions = {\n${tsLines.join('\n')}\n} as const;\n`,
  'utf8',
);

//  tiny summary
console.log(
  `generated ${funcs.length} functions – exported-functions.txt & functions.ts`,
);
