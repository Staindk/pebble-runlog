#!/usr/bin/env bash
# RunLog test runner. The JS side — phone logic, exporters and the config/
# debrief page — is fully exercised here with Node. Native C and on-watch
# rendering are verified separately with the Pebble SDK + emulator:
#     pebble build && pebble install --emulator emery
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== generated page freshness is checked by the page tests =="

echo "== watch source policy checks =="
if rg -q 'light_set_(color|system_color)|PBL_RGB_BACKLIGHT' src/c; then
  echo "ERROR: RunLog must not override the system backlight colour" >&2
  exit 1
fi
if rg -q 'ScrollLayer|scroll_layer_' src/c/summary.c; then
  echo "ERROR: the on-watch debrief must remain page-based, not scroll-based" >&2
  exit 1
fi
if rg -q 'GTextOverflowModeTrailingEllipsis|\.\.\.|…' src/c; then
  echo "ERROR: watch UI text must fit or rephrase; ellipses are forbidden" >&2
  exit 1
fi
if rg -q 'text-overflow[[:space:]]*:[[:space:]]*ellipsis|\.\.\.|…' tools/page.html; then
  echo "ERROR: phone UI text must wrap or rephrase; ellipses are forbidden" >&2
  exit 1
fi

echo "== format unit tests (GPX / TCX / FIT bytes + CRC) =="
node tools/test_formats.js

echo "== pipeline tests (record -> save -> export -> upload) =="
node tools/test_pipeline.js

echo "== page tests (debrief render + config + downloads) =="
node tools/test_export.js

echo
echo "ALL TESTS PASSED"

if [[ "${1:-}" == "--screenshots" ]]; then
  bash tools/test_watch_screenshots.sh
fi
