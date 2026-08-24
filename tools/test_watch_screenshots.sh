#!/usr/bin/env bash
# Native watch-UI regression pass. It resets only the running disposable
# emulator, then leaves original PNGs in /tmp so layout changes can be inspected
# directly instead of being inferred from C source.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${RUNLOG_SCREENSHOT_DIR:-/tmp/runlog-watch-screenshots}"
SESSION_SID=424242
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

assert_native_budget() {
  if unzip -Z1 build/pebble-runlog.pbw | rg -q '(^|/)(mc\.xsa|.*\.MOD)(/|$)'; then
    echo "ERROR: physical Emery package still contains an in-RAM Alloy archive" >&2
    return 1
  fi
  local resource_bytes
  resource_bytes="$(stat -c '%s' build/emery/app_resources.pbpack)"
  if (( resource_bytes > 10000 )); then
    echo "ERROR: Emery native resources exceed 10000 B ($resource_bytes B)" >&2
    return 1
  fi
  echo "Emery native package budget OK ($resource_bytes B resources, no Alloy archive)"
}

stress_relaunch() {
  local platform="$1"
  local before="$OUT/.${platform}-restart-before.png"
  local after="$OUT/.${platform}-restart-after.png"

  pebble kill >/dev/null 2>&1 || true
  pebble install --emulator "$platform" --vnc >/dev/null
  pebble wipe >/dev/null
  pebble kill >/dev/null 2>&1 || true
  for attempt in {1..6}; do
    pebble install --emulator "$platform" --vnc >/dev/null
    pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
      "$before" >/dev/null
    pebble emu-button --emulator "$platform" --vnc click up >/dev/null
    pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
      "$after" >/dev/null
    if cmp -s "$before" "$after"; then
      echo "ERROR: $platform did not respond after relaunch $attempt" >&2
      return 1
    fi
    pebble emu-button --emulator "$platform" --vnc click back >/dev/null
  done
  rm -f "$before" "$after"
  pebble kill >/dev/null 2>&1 || true
  echo "$platform repeated-launch stress OK (6 launches)"
}

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
  pebble send-app-message --emulator "$platform" --vnc --int \
    10030=3 10031="$SESSION_SID" 10034=1 >/dev/null
  pebble send-app-message --emulator "$platform" --vnc --int \
    10030=3 10031="$SESSION_SID" 10013=1 10022=0 10008=12560 10010=315 10014=153 10015=181 \
    10016=3661 10036=3719 10011=247 10027=48 >/dev/null
  pebble send-app-message --emulator "$platform" --vnc \
    --int 10031="$SESSION_SID" 10024=3100 10056=1 \
    --bytes 10017=0AB41E9632A046785A826E5A8264963CB41E \
            10020=180168010A141E2D3C4B5A50463728190F \
            10021=7800B500141E28374655645A50463C32281E14 >/dev/null
}

show_live_fixture() {
  local platform="$1"
  # A long-enough workout exercises timer fitting, >10 km distance, pace,
  # ascent and page-specific values without waiting in real time.
  pebble send-app-message --emulator "$platform" --vnc --int \
    10030=3 10031="$SESSION_SID" 10034=1 10035=754 10006=1 10007=8 10008=12560 10009=315 \
    10042=247 10043=731 10044=153 >/dev/null
  if [[ "$platform" == "emery" ]]; then
    pebble emu-heart-rate --emulator "$platform" --vnc 153 >/dev/null
  fi
}

assert_stale_session_ignored() {
  local platform="$1"
  local before="$OUT/.${platform}-stale-before.png"
  local after="$OUT/.${platform}-stale-after.png"

  # Freeze the elapsed display, then prove that a delayed READY snapshot for a
  # different session cannot replace the active workout. Exact pixel equality
  # is reliable while paused; a rollback would redraw the entire ready screen.
  pebble send-app-message --emulator "$platform" --vnc --int \
    10030=3 10031="$SESSION_SID" 10034=2 10035=754 10019=0 >/dev/null
  pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
    "$before" >/dev/null
  pebble send-app-message --emulator "$platform" --vnc --int \
    10030=3 10031=989898 10034=0 10035=0 >/dev/null
  pebble screenshot --emulator "$platform" --vnc --no-correction --no-open \
    "$after" >/dev/null
  if ! cmp -s "$before" "$after"; then
    echo "ERROR: $platform accepted a stale foreign-session state packet" >&2
    return 1
  fi
  rm -f "$before" "$after"
  pebble send-app-message --emulator "$platform" --vnc --int \
    10030=3 10031="$SESSION_SID" 10034=1 10035=754 10019=0 >/dev/null
  echo "$platform stale-session rejection OK"
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
  assert_stale_session_ignored "$platform"
  capture "$platform" live
  pebble emu-button --emulator "$platform" --vnc click down
  capture "$platform" lap
  pebble emu-button --emulator "$platform" --vnc click down
  capture "$platform" totals
  pebble send-app-message --emulator "$platform" --vnc --int \
    10030=3 10031="$SESSION_SID" 10034=2 10035=755 10019=1 >/dev/null
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
assert_native_budget

echo "== Emery repeated-launch stress =="
stress_relaunch emery

echo "== Emery screenshots (200x228) =="
exercise_platform emery

node tools/test_watch_screenshots.js "$OUT"
echo "WATCH SCREENSHOTS: $OUT"
