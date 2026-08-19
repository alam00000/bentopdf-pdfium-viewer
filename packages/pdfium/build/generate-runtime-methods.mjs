#!/usr/bin/env node
// generate-runtime-methods.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Purpose
//   • Produce  exported-runtime-methods.txt ──► consumed by em++
//   • Produce  runtime-methods.ts           ──► handy, typed wrapper for TS.
//
// Usage
//   $ node generate-runtime-methods.mjs [outDir]
//
//   • outDir (optional) defaults to the folder **this** script sits in.
//
// Maintenance
//   • Need another helper?  Just append its name to the `methods` array below.
//     Re-build and everything stays in sync.
// ──────────────────────────────────────────────────────────────────────────────

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath }            from 'node:url';

// ———————————————————————————————————————————————————————————————————
// 1.  Config – tweak here if you ever need more helpers
//     (keep alphabetised for sanity).
// ———————————————————————————————————————————————————————————————————
const methods = [
  'wasmExports',
  'UTF16ToString',
  'UTF8ToString',
  'addFunction',
  'ccall',
  'cwrap',
  'getValue',
  'removeFunction',
  'setValue',
  'stringToUTF16',
  'stringToUTF8',
  'lengthBytesUTF8',
  'HEAPU8',
  'HEAPU16',
  'HEAPU32',
  'HEAP32',
  'HEAPF32',
  'HEAPF64'
];

/**
 * Optionally override the TypeScript type for a given helper.
 * Anything not listed here gets `typeof <name>` (i.e. whatever Emscripten
 * puts on `Module` at runtime) which is usually good enough.
 */
const customTsTypes = {
  wasmExports: 'WasmExports',
};

// ———————————————————————————————————————————————————————————————————
// 2.  Resolve where we’re writing
// ———————————————————————————————————————————————————————————————————
const selfDir = dirname(fileURLToPath(import.meta.url));
const outDir  = resolve(process.argv[2] ?? selfDir);

mkdirSync(outDir, { recursive: true });

// ──────────────────────────────────────────────────────────────────────────────
// 3.  exported-runtime-methods.txt  (comma-separated, as em++ expects)
// ──────────────────────────────────────────────────────────────────────────────
writeFileSync(
  resolve(outDir, 'exported-runtime-methods.txt'),
  methods.join(','),
  'utf8',
);

// ──────────────────────────────────────────────────────────────────────────────
// 4.  runtime-methods.ts  (nice DX for TypeScript consumers)
// ──────────────────────────────────────────────────────────────────────────────
const tsBanner = `/* AUTO-GENERATED — DO NOT EDIT BY HAND */
/// <reference types="emscripten" />

export interface WasmExports {
  malloc: (size: number) => number;
  free:   (ptr:  number) => void;
}

/**
 * Subset of Emscripten helpers that our wrapper re-exports.
 * Extend \`customTsTypes\` above if you want richer typings.
 */
export interface PdfiumRuntimeMethods {
${methods
  .map((name) => `  ${name}: ${customTsTypes[name] ?? `typeof ${name}`};`)
  .join('\n')}
}

export const exportedRuntimeMethods = [\n${
  methods.map(m => `  "${m}"`).join(',\n')
}\n] as const;
`;

writeFileSync(
  resolve(outDir, 'runtime-methods.ts'),
  tsBanner,
  'utf8',
);

// ———————————————————————————————————————————————————————————————————
// 5.  Friendly CLI output
// ———————————————————————————————————————————————————————————————————
const rel = p => (p.startsWith(process.cwd()) ? p.slice(process.cwd().length + 1) : p);
console.log(
  `generated ${methods.length} runtime helpers ⇒ ` +
  `${rel(resolve(outDir, 'exported-runtime-methods.txt'))}, ` +
  `${rel(resolve(outDir, 'runtime-methods.ts'))}`,
);
