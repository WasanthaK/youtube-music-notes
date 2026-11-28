#!/usr/bin/env bash
# Shared packaging step for build-extension.yml and release-extension.yml.
# Usage: package-extension.sh <output-dir>
# Copies the files that make up the shipped extension into <output-dir>.
# Fails if any listed file or directory is missing.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <output-dir>" >&2
  exit 2
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$1"

# Files copied to the package root.
ROOT_FILES=(
  manifest.json
  offscreen.html
  popup.html
  popup.js
  popup-progress.js
  popup.css
  result.html
  tab-layout.js
  result.js
  result.css
  original-audio.js
  critic.js
  diagnostic-upload.js
  clean-playback.js
  service_worker.js
  service-worker-diagnostic.js
)
# Files copied to <output-dir>/dist.
DIST_FILES=(
  dist/offscreen.bundle.js
)
# Directories copied recursively.
DIST_DIRS=(
  dist/models
  dist/ort
)

missing=0
for f in "${ROOT_FILES[@]}" "${DIST_FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING file: extension/$f" >&2; missing=1; fi
done
for d in "${DIST_DIRS[@]}"; do
  if [ ! -d "$SRC/$d" ]; then echo "MISSING dir: extension/$d" >&2; missing=1; fi
done
if [ "$missing" -ne 0 ]; then
  echo "package-extension: aborting, required files are missing" >&2
  exit 1
fi

mkdir -p "$OUT/dist"
for f in "${ROOT_FILES[@]}"; do cp "$SRC/$f" "$OUT/"; done
for f in "${DIST_FILES[@]}"; do cp "$SRC/$f" "$OUT/dist/"; done
for d in "${DIST_DIRS[@]}"; do cp -R "$SRC/$d" "$OUT/$d"; done
echo "package-extension: packaged into $OUT"
