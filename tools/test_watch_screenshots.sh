#!/usr/bin/env bash
# Native watch-UI regression pass. It resets only the running disposable
# emulator, then leaves original PNGs in /tmp so layout changes can be inspected
# directly instead of being inferred from C source.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${RUNLOG_SCREENSHOT_DIR:-/tmp/runlog-watch-screenshots}"
mkdir -p "$OUT"
find "$OUT" -maxdepth 1 -type f -name '*.png' -delete

if ! command -v pebble >/dev/null 2>&1; then
  echo "ERROR: screenshot tests require the Pebble SDK CLI" >&2
  exit 1
fi

cleanup() {
  pebble kill >/dev/null 2>&1 || true
}
trap cleanup EXIT

capture() {
  local platform="$1" name="$2"
  pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
    "$OUT/${platform}-${name}.png"
}

wait_for_debrief() {
  local platform="$1" before="$OUT/.${platform}-before.png"
  local after="$OUT/.${platform}-after.png"

  # DOWN is inert on the recorder but advances Route to Stats in the debrief.
  # Prove the page transition twice instead of accepting a stale capture.
  for _ in {1..5}; do
    pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
      "$before" >/dev/null
    pebble emu-button --emulator "$platform" --vnc click down >/dev/null
    pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
      "$after" >/dev/null
    if ! cmp -s "$before" "$after"; then
      pebble emu-button --emulator "$platform" --vnc click up >/dev/null
      pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
        "$before" >/dev/null
      pebble emu-button --emulator "$platform" --vnc click down >/dev/null
      pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
        "$after" >/dev/null
      if ! cmp -s "$before" "$after"; then
        pebble emu-button --emulator "$platform" --vnc click up >/dev/null
        rm -f "$before" "$after"
        return 0
      fi
    fi
    sleep 2
  done
  rm -f "$before" "$after"
  echo "ERROR: $platform did not reach the paged debrief" >&2
  return 1
}

show_debrief_fixture() {
  local platform="$1"
  # Protocol keys are append-only, so these IDs are stable. First put the watch
  # into an activity state so its stale-SAVED guard is active, then deliver a
  # realistic final summary and streamed route/graph payloads. Pipeline tests
  # exercise the real save handshake; this fixture isolates native rendering.
  pebble send-app-message --emulator "$platform" --vnc --int 10034=1 >/dev/null
  pebble send-app-message --emulator "$platform" --vnc --int \
    10013=1 10022=0 10008=12560 10010=315 10014=153 10015=181 \
    10016=3661 10036=3719 10011=247 10027=48 >/dev/null
  pebble send-app-message --emulator "$platform" --vnc \
    --int 10024=3100 10056=1 \
    --bytes 10017=0AB41E9632A046785A826E5A8264963CB41E \
            10020=180168010A141E2D3C4B5A50463728190F \
            10021=7800B500141E28374655645A50463C32281E14 >/dev/null
}

show_live_fixture() {
  local platform="$1"
  # A long-enough workout exercises timer fitting, >10 km distance, pace,
  # ascent and page-specific values without waiting in real time.
  pebble send-app-message --emulator "$platform" --vnc --int \
    10034=1 10035=754 10006=1 10007=8 10008=12560 10009=315 \
    10042=247 10043=731 10044=153 >/dev/null
  if [[ "$platform" == "emery" ]]; then
    pebble emu-heart-rate --emulator "$platform" --vnc 153 >/dev/null
  fi
}

exercise_platform() {
  local platform="$1"
  pebble kill >/dev/null 2>&1 || true
  # Start the target once so wipe addresses that platform's emulator data, then
  # restart it and install onto the genuinely clean watch. This prevents an old
  # persisted RUNNING/SAVING session from masquerading as the ready baseline.
  pebble install --emulator "$platform" --vnc >/dev/null
  pebble wipe >/dev/null
  pebble kill >/dev/null 2>&1 || true
  pebble install --emulator "$platform" --vnc

  capture "$platform" ready
  pebble emu-button --emulator "$platform" --vnc click up
  capture "$platform" settings
  pebble emu-button --emulator "$platform" --vnc click back

  show_live_fixture "$platform"
  capture "$platform" live
  pebble emu-button --emulator "$platform" --vnc click down
  capture "$platform" lap
  pebble emu-button --emulator "$platform" --vnc click down
  capture "$platform" totals
  pebble send-app-message --emulator "$platform" --vnc --int \
    10034=2 10035=755 10019=1 >/dev/null
  capture "$platform" autopause

  show_debrief_fixture "$platform"
  wait_for_debrief "$platform"
  capture "$platform" route
  pebble emu-button --emulator "$platform" --vnc click down
  capture "$platform" stats
  pebble emu-button --emulator "$platform" --vnc click down
  capture "$platform" trends
  pebble emu-button --emulator "$platform" --vnc click select
  capture "$platform" actions
}

echo "== building native screenshot subject =="
pebble build

echo "== Emery screenshots (200x228) =="
exercise_platform emery

echo "== Basalt screenshots (144x168) =="
exercise_platform basalt

node tools/test_watch_screenshots.js "$OUT"
echo "WATCH SCREENSHOTS: $OUT"
