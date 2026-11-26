#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

npx --yes @tauri-apps/cli@2.11.4 icon icons/icon.svg --output "$SCRIPT_DIR"
convert -size 44x44 xc:black \
  \( icons/icon.png -background black -alpha remove -alpha off -colorspace gray \
     -level '27%,65%' -resize 36x36 -gravity center -background black -extent 44x44 \) \
  -compose CopyOpacity -composite -strip PNG32:icons/tray.png
