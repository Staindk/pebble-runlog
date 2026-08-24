#!/usr/bin/env bash
# RunLog test runner. The phone logic, exporters and config/debrief page are
# fully exercised with Node. The native Emery watch source is policy-checked
# here and rendered separately with the Pebble SDK + emulator:
#     pebble build && pebble install --emulator emery
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== generated page freshness is checked by the page tests =="

echo "== watch source policy checks =="
node - <<'NODE'
const assert = require('assert');
const fs = require('fs');
const pkg = require('./package.json');
assert.strictEqual(pkg.pebble.projectType, 'native',
                   'physical PT2 builds must not load an in-RAM Alloy archive');
assert.deepStrictEqual(pkg.pebble.targetPlatforms, ['emery'], 'RunLog targets only Pebble Time 2');
assert.strictEqual(pkg.pebble.sdkVersion, '3');
assert.strictEqual(pkg.pebble.messageKeys[0], 'CMD');
assert.strictEqual(pkg.pebble.messageKeys[pkg.pebble.messageKeys.length - 1], 'HRZONE');
assert.strictEqual(pkg.pebble.messageKeys.length, 60, 'wire key order is append-only');
const resources = pkg.pebble.resources.media.map(item => item.name);
['ICON_SETTINGS', 'ICON_START', 'ICON_CONFIRM', 'ICON_DECLINE', 'ICON_PAUSE',
 'ICON_STOP', 'ICON_RUN', 'ICON_WALK', 'ICON_BIKE', 'ICON_HIKE', 'ICON_UP',
 'ICON_DOWN', 'ICON_MENU', 'ICON_UPLOAD', 'ICON_TRASH', 'ICON_MIC']
  .forEach(name => assert(resources.includes(name), 'missing native watch resource ' + name));
const watch = fs.readFileSync('src/c/main.c', 'utf8');
assert(watch.includes('#define HIKE_SAMPLE_PERIOD_S 30'),
       'Hike Health reads must stay on the reviewed 30-second battery cadence');
assert(watch.includes('#define HIKE_KEEPALIVE_S     60'),
       'Hike keepalives must tolerate one missed 30-second sample');
assert(watch.includes('s_journal_last_sent_at + (uint32_t)journal_period'),
       'journal resend cadence must use the selected activity profile');
assert(watch.includes('prv_release_partial_outbox();'),
       'dictionary failures must release PebbleOS from OUT_WRITING');
assert(watch.includes('ignoring stale session packet'),
       'session-mutating phone packets must be SID-gated');
assert(watch.includes('window_set_touch_bridge_disabled(s_window, true)'),
       'workout touch must bypass SELECT emulation so a tap cannot pause');
assert(watch.includes('tap_recognizer_create') && watch.includes('swipe_recognizer_create'),
       'custom PT2 workout tap and swipe recognizers must stay attached');
NODE
if rg -q 'light_set_(color|system_color)|PBL_RGB_BACKLIGHT' src/c; then
  echo "ERROR: RunLog must not override the system backlight colour" >&2
  exit 1
fi
if rg -q 'ScrollLayer|scroll_layer_' src/c; then
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
for watch_setting in 'Auto-pause' 'Units' 'Split alerts' 'HR zone' 'Phone settings'; do
  if ! rg -Fq "\"$watch_setting\"" src/c/settings.c; then
    echo "ERROR: important watch setting missing: $watch_setting" >&2
    exit 1
  fi
done
if ! rg -q 'settings_save_local_and_sync\(\)' src/c/settings.c; then
  echo "ERROR: watch settings must use the durable local-edit sync path" >&2
  exit 1
fi
for native_feature in 'app_touch_navigation_enable(true)' \
                      'health_service_set_heart_rate_sample_period' \
                      'connection_service_subscribe' 'PKEY_SESSION_SID' \
                      'JOURNAL_BATCH_RECORDS'; do
  if ! rg -Fq "$native_feature" src/c; then
    echo "ERROR: required native Emery feature missing: $native_feature" >&2
    exit 1
  fi
done
if ! rg -Fq '#define JOURNAL_MAX_RECORDS 1024' src/c/main.c; then
  echo "ERROR: native Emery outage journal capacity changed unexpectedly" >&2
  exit 1
fi
if rg -q 'accel_service_set_sampling_rate|accel_data_service_subscribe|accel_tap_service_subscribe' src/c; then
  echo "ERROR: motion-triggered acceleration is excluded so rocky terrain cannot wake or refresh the workout" >&2
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
