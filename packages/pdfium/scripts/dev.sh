#!/usr/bin/env bash
set -euo pipefail
set -x   # verbose – remove once everything works smoothly

ROOT=/workspace
SRC=$ROOT/packages/pdfium/pdfium-src
OUT=$SRC/out/wasm
PDFIUM=$ROOT/packages/pdfium

# make them visible in child shells
export ROOT SRC OUT PDFIUM

git config --global --add safe.directory '*' >/dev/null 2>&1 || true

mkdir -p $OUT

export PATH="$HOME/.cargo/bin:$PATH" 

###############################################################################
# 0.  Bring in Chromium build tool-chain (first run only)
###############################################################################
if [[ ! -d "$SRC/third_party/llvm-build" || ! -x "$SRC/buildtools/linux64/gn" ]]; then
  echo "⏬  Running first-time gclient sync (few minutes)…"

  # minimal helper .gclient so `sync` knows where it is
  cat > "$ROOT/.gclient" <<'EOF'
solutions = [
  { "name": "packages/pdfium/pdfium-src",
    "url":  "https://pdfium.googlesource.com/pdfium.git",
    "deps_file": "DEPS",
    "managed": False,
    "custom_deps": {},
  },
]
EOF

  ( cd "$ROOT/packages/pdfium/pdfium-src" && \
    gclient sync --no-history --shallow --nohooks --deps=builder )

  rm "$ROOT/.gclient"
fi

###############################################################################
# 0.5 Apply our local build-system patches (always, they’re tiny)
###############################################################################
echo "🔧  Patching PDFium build files…"
cp -f "$PDFIUM/build/patch/build/config/BUILDCONFIG.gn" \
      "$SRC/build/config/BUILDCONFIG.gn"

mkdir -p "$SRC/build/toolchain/wasm"
cp -f "$PDFIUM/build/patch/build/toolchain/wasm/BUILD.gn" \
      "$SRC/build/toolchain/wasm/BUILD.gn"

if ! git -C "$SRC" apply --reverse --check "$PDFIUM/build/patch/editcore-pdfium.patch" >/dev/null 2>&1; then
  git -C "$SRC" apply "$PDFIUM/build/patch/editcore-pdfium.patch"
fi


#if command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$OUT"; then
#  echo "⚠️ $OUT is a mount — clearing contents only"
#  find "$OUT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
#else
#  rm -rf "$OUT"
#fi

###############################################################################
# 1) GN gen — run from source directory (running from elsewhere with --root causes issues)
###############################################################################
(
  cd "$SRC" && \
  ./buildtools/linux64/gn gen out/wasm \
    --args='is_debug=false treat_warnings_as_errors=false pdf_use_skia=false pdf_enable_xfa=false pdf_enable_v8=false is_component_build=false clang_use_chrome_plugins=false pdf_is_standalone=true use_debug_fission=false use_custom_libcxx=false use_sysroot=false pdf_is_complete_lib=true pdf_use_partition_alloc=false is_clang=false symbol_level=0 target_os="wasm" target_cpu="wasm"'
)

###############################################################################
# 2.  Helper – regenerate export lists
###############################################################################
gen_exports() {
  local WS=$ROOT/packages/pdfium/build/wasm
  mkdir -p "$WS"

  ( cd "$SRC" &&
    find public -path public/cpp -prune -o -name '*.h' -print |
    sort | sed 's|^|#include "|;s|$|"|' ) > "$WS/all.h"

  echo '#include "../build/code/cpp/ext_api.h"' >> "$WS/all.h"
  echo '#include "editcore.h"' >> "$WS/all.h"

  clang -std=c11 -I"$SRC" -I"$ROOT/build/code/cpp" -I"$SRC/public" -I"$PDFIUM/build/code/editcore" \
        -fsyntax-only -Xclang -ast-dump=json "$WS/all.h" > "$WS/ast.json"

  node "$PDFIUM/build/generate-functions.mjs"       "$WS/ast.json" "$WS"
  node "$PDFIUM/build/generate-runtime-methods.mjs" "$WS"
}

gen_exports   # at start-up

echo -e "\n🚀  Dev container ready – save a *.cc / *.h and it rebuilds.\n"

###############################################################################
# 3.  Watch loop
###############################################################################
cd "$SRC"

# build the one-off logic into WATCHER_SCRIPT as before
WATCHER_SCRIPT=$(typeset -f gen_exports)$'\n'"\
# 🧹 clear previous artefacts
rm -rf \"$PDFIUM/build/wasm\" && mkdir -p \"$PDFIUM/build/wasm\"; \
\
echo \"🛠 \$(date +%H:%M:%S) Rebuilding…\";\
\"$SRC/third_party/ninja/ninja\" -C \"$OUT\" pdfium -v;\
gen_exports;\
cd $PDFIUM/build && bash ./compile.esm.sh && bash ./compile.sh;\
# ⬇️  copy freshly-built artefacts into src/vendor (overwrite if they exist)
cp -f \"$PDFIUM/build/wasm/\"{runtime-methods.ts,functions.ts,pdfium.wasm,pdfium.js,pdfium.cjs} \"$PDFIUM/src/vendor/\";\
echo \"✅ pdfium.wasm refreshed\"\
"

# Explicitly use --shell bash and pass the script content as the command.
# This makes watchexec run: bash -c "..." using the full script.
watchexec --exts cc,cpp,h --ignore 'third_party/**' --restart \
  --shell bash \
  -- \
  "$WATCHER_SCRIPT"
