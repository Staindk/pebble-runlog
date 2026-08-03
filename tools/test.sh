#!/usr/bin/env bash
# RunLog test runner. The JS side — phone logic, exporters and the config/
# debrief page — is fully exercised here with Node. Native C and on-watch
# rendering are verified separately with the Pebble SDK + emulator:
#     pebble build && pebble install --emulator emery
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== generated page freshness is checked by the page tests =="

echo "== format unit tests (GPX / TCX / FIT bytes + CRC) =="
node tools/test_formats.js

echo "== pipeline tests (record -> save -> export -> upload) =="
node tools/test_pipeline.js

echo "== page tests (debrief render + config + downloads) =="
node tools/test_export.js

echo
echo "ALL TESTS PASSED"
