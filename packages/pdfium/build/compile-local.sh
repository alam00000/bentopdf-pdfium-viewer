#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PDFIUM="$(dirname "$HERE")"
SRC="$PDFIUM/pdfium-src"
LIB="${PDFIUM_LIB:-$SRC/out/wasm/obj/libembedpdf.a}"

if ! command -v em++ >/dev/null 2>&1; then
  echo "em++ not found. Install emscripten first (brew install emscripten)." >&2
  exit 1
fi

if [[ ! -f "$LIB" ]]; then
  cat >&2 <<MSG
Missing $LIB

Download it from a Build PDFium WASM run:
  gh run download <run-id> -n pdfium-link-inputs -D "$PDFIUM"
That artifact carries libembedpdf.a and the two exported-*.txt lists.
Or point PDFIUM_LIB at a copy you already have.
MSG
  exit 1
fi

cd "$HERE"
mkdir -p wasm

for f in exported-functions.txt exported-runtime-methods.txt; do
  if [[ ! -f "wasm/$f" ]]; then
    echo "Missing build/wasm/$f — it ships in the pdfium-link-inputs artifact." >&2
    exit 1
  fi
done

link() {
  local out="$1"
  shift
  em++ $(ls ./code/cpp/*.cpp) $(ls ./code/editcore/*.cpp) \
    "$LIB" \
    "$@" \
    -sENVIRONMENT=node,worker,web,shell \
    -sMODULARIZE=1 \
    -sWASM=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sALLOW_TABLE_GROWTH=1 \
    -sEXPORT_NAME=createPdfium \
    -sUSE_ZLIB=1 \
    -sASSERTIONS=1 \
    -sEXPORTED_RUNTIME_METHODS=$(cat ./wasm/exported-runtime-methods.txt) \
    -sEXPORTED_FUNCTIONS=$(cat ./wasm/exported-functions.txt) \
    -L"$(dirname "$LIB")" \
    -I"$SRC/public" \
    -I./code/editcore \
    -I./code/harfbuzz/src \
    -std=c++17 \
    -Wall \
    --no-entry \
    -o "$out"
}

echo "Linking ESM build…"
link ./wasm/pdfium.js -sEXPORT_ES6=1

echo "Linking CJS build…"
link ./wasm/pdfium.cjs

cp -f ./wasm/pdfium.wasm ./wasm/pdfium.js ./wasm/pdfium.cjs "$PDFIUM/src/vendor/"

echo "Done. src/vendor updated — run: node --test test/*.test.mjs"
