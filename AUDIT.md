# RunLog fresh audit and remediation report

Date: 2026-07-27

Scope: Pebble C watchapp, PebbleKit JS companion, AppMessage protocol, workout
recovery/storage, GPS and health handling, GPX/TCX/FIT exports, phone
configuration/debrief page, tests, documentation, privacy, and battery use.

The previous contents of `AUDIT.md` were not read or used for this review.
This document records the fresh audit and the implementation performed from it.

## Current verdict

The source-level release blockers found in the fresh audit have been remediated.
RunLog now has an acknowledged, restart-aware workout protocol; hostile log text
cannot break out of the phone page's inline data; and a long pause or GPS drought
cannot be treated as an ended workout based only on checkpoint age.

The implementation also fixes health boundaries, GPS poisoning, stable workout
actions, secret exposure in page URLs, raw-cadence destruction, elapsed/export
clock inconsistencies, XHR abort deadlocks, and several misleading UI states.

The battery work removes redundant paused ticks, radio packets, redraws,
whole-route checkpoint rewrites, configuration-only GPS use, string-number
round trips, repeated settings writes, and all-routes page construction. It does
so without reducing GPS accuracy/frequency, stored route points, HR sampling,
step resolution, auto-pause detection, exports, or upload features.

No open P0 source defect remains from this audit. The largest remaining release
risk is verification: native state transitions compile on every target, but are
not executed in an automated Pebble emulator/hardware fault matrix.

## Final verification

- `bash tools/test.sh`: passed.
  - GPX, TCX, and FIT structure/CRC/session-clock tests passed.
  - All 23 phone pipeline scenarios passed.
  - All phone-page rendering/action/download tests passed.
- Generated `src/pkjs/page.js` was rebuilt from the page and shared exporters.
- `node --check` passed for the JavaScript sources and tools.
- `git diff --check`: passed.
- A clean `pebble build` passed for basalt, diorite, and emery.
- Final native RAM footprints reported by the SDK:
  - basalt: 22,780 bytes, 42,756 bytes heap free;
  - diorite: 22,552 bytes, 42,984 bytes heap free;
  - emery: 22,780 bytes, 108,292 bytes heap free.

The SDK linker emits its usual RWX load-segment warning. No emulator interaction,
real watch/phone transport fault injection, hardware power measurement, or live
upload-service interoperability test was performed.

## Remediation status

### P0-1 — Fire-and-forget workout state

Status: remediated.

- Protocol v2 carries a session id, monotonic sequence, desired/current state,
  active time, start time, auto-pause state, sensor sample time, and settings.
- Watch control intents persist and retry after busy/failed outboxes until an
  authoritative ACK/state response arrives (`src/c/main.c:319-615`).
- The phone applies commands idempotently, caches the last ACK, rejects stale
  state changes, and can resend a saved summary by session id
  (`src/pkjs/index.js:1579-1752`).
- HELLO/state reconciliation repairs watch-only and phone-only restarts.
- START/PAUSE/RESUME/STOP display explicit pending text rather than claiming
  that phone recording/save has already completed.
- STOP carries the final HR/step sample. SAVING retries instead of escaping to a
  false DONE state.
- Auto-pause sends a protected authoritative state snapshot, and the watch takes
  the same health boundary and vibration path as a manual transition.
- Discard, upload, rename, and phone-page mutations use stable session ids and
  report explicit results.

Pipeline scenarios 19 and 20 exercise duplicate/reordered commands, cached ACKs,
one-save STOP behavior, final sensor delivery, stable discard, and a two-hour
paused restart.

### P0-2 — Diagnostic-log script injection

Status: remediated.

- Stored log JSON is parsed defensively and serialized through the same
  less-than/U+2028/U+2029-safe encoder as runs/config
  (`src/pkjs/index.js:1754-1802`).
- Malformed log storage becomes an empty log.
- Pipeline scenario 21 includes `</script><script>`, U+2028, and U+2029 and
  verifies that the payload cannot appear literally in executable page source.

The page still uses an inline script because it must be a self-contained Pebble
`data:` page. Eliminating `unsafe-inline` with a tested WebView-compatible hash
remains defense-in-depth work, not an active injection path.

### P0-3 — Live workout finalized after a long pause

Status: remediated.

- Every manual and automatic pause/resume persists state.
- A small one-minute liveness record updates independently of route points
  (`src/pkjs/index.js:918-927`).
- Route recovery uses bounded appendable point chunks instead of full snapshots
  (`src/pkjs/index.js:929-979`).
- A stale checkpoint is retained until watch HELLO establishes authority.
- A torn chunk tail that landed before its metadata commit is truncated before
  appending, preventing duplicate/reordered recovery points.
- Scenario 20 confirms that a two-hour paused workout resumes normally when the
  watch reports the same live session.

### P1-1 — Step boundaries and independent watch restart

Status: remediated.

- START captures the health baseline synchronously.
- Manual and automatic pause/resume refresh the counter under the old state.
- STOP samples HR and steps before sending its transactional intent.
- Watch step baseline, gross count, paused offset, and net total persist with the
  session (`src/c/main.c:319-471`).
- Sensor packets carry watch source time. The phone normalizes a restarted raw
  counter without letting the recovered total move backwards.

Native fake-health unit tests are still desirable; see remaining work.

### P1-2 — Wrong-target/optimistic debrief actions

Status: remediated.

- Saved records use a stable session id, with start time as a legacy fallback.
- Watch/page actions resolve the id against current storage at execution time.
- Discard and rename wait for ACK before showing success.
- Upload status is session-scoped so an older page upload cannot alter another
  watch summary.
- Renaming/retyping an uploaded record marks it `changed locally`.

### P1-3 — GPS values poisoning the workout

Status: remediated.

- Accuracy must be finite, non-negative, and at most 50 m.
- Latitude/longitude ranges are checked.
- Altitude must be finite and physically defensible or becomes missing.
- GPS timestamps must be near the receipt wall clock; otherwise wall time is
  used.
- Monotonic clocks commit only after the raw spatial outlier gate
  (`src/pkjs/index.js:284-386`).
- Scenario 23 covers negative accuracy, invalid coordinates, infinity altitude,
  a future timestamp, and a spatial outlier followed by normal fixes.

### P1-4 — Corrupt/quota-constrained storage

Status: substantially remediated.

- An unreadable primary is not treated as a valid empty array.
- Implicit writes are blocked while corrupt storage is unresolved.
- The raw malformed value is copied and verified when possible.
- Successful writes are read back and verified.
- Only an explicit “delete all” action can force a clean store and remove the
  corrupt backup (`src/pkjs/index.js:820-887`).
- Checkpoint write failures are logged once rather than swallowed invisibly.

A versioned A/B finished-run store and user-facing raw-backup download remain
worth adding. `localStorage.setItem` is atomic on supported WebViews, but an A/B
generation would provide a stronger last-known-good guarantee.

### P1-5 — Retype destroyed raw cadence/derived data

Status: remediated.

- Raw point cadence is never deleted.
- Ride presentation and GPX/TCX/FIT export suppress wrist cadence instead of
  pretending it is bicycle cadence.
- `recomputeDerived()` is shared by finalize and retype
  (`src/pkjs/index.js:656-718`).
- Run → Ride → Run restores cadence and recalculates splits/VO2/activity fields.
- Modified uploaded records enter the re-upload state.

### P1-6 — Contradictory elapsed/export clocks

Status: remediated.

- Records distinguish wall elapsed, active timer time, and GPS moving time.
- The final watch summary receives true elapsed via `DURS`.
- GPX metadata and TCX/FIT session/lap start use session START; trackpoints keep
  their actual GPS timestamps.
- FIT timer start/stop events encode pause segment boundaries, and timer time
  uses active time (`src/pkjs/fit.js:49-153`).
- FIT local timestamp applies the stored timezone offset.

The stored offset is the start-time offset. A workout spanning a timezone/DST
change is a remaining low-frequency edge case.

### P1-7 — All routes and plaintext secrets in every page URL

Status: remediated.

- Page config contains `hasAuth`/`hasKey`/`hasPass`, never the values.
- Blank secret fields mean “keep”; replacement and clearing require explicit
  intent.
- The list/config page contains only run metadata.
- Selecting a run closes it and opens a one-run detail page
  (`src/pkjs/index.js:1771-1802`, `tools/page.html:287-358`).
- Unrelated settings edits preserve a valid FitTrackee token.

Credentials still live as plaintext in the app's private local config, as
documented. PebbleKit JS offers no secure credential-store API.

## Other correctness and UX work

- Overall HR average/max now uses source-timestamped, time-weighted watch samples
  rather than GPS point density (`src/pkjs/index.js:117-143`).
- Split HR is duration-weighted within each GPS segment.
- The phone's duplicate ride “MAX SPEED” label was replaced with stopped time.
- XHR handles abort and has a timeout watchdog (`src/pkjs/index.js:1255-1285`).
- FIT pause events and timezone metadata are emitted and structurally decoded in
  tests.
- Old HR is cleared at START; no-microphone feedback remains visible; SAVING can
  only retry/reconcile.
- Run cards/back/map controls use real buttons, visible focus, labels, and canvas
  text alternatives (`tools/page.html:183-196`, `tools/page.html:296-358`,
  `tools/page.html:449-454`).
- README password-log and default-name claims now match the code.

## Battery and performance work

| Audit item | Status | Implementation |
|---|---|---|
| B1 no-GPS radio spam | Done | Unavailable status sends only on transition; watchdog repeats deduplicate. |
| B2 paused one-second ticks | Done | RUNNING uses seconds; PAUSED uses minute ticks plus one five-second AppTimer (`src/c/main.c:983-1001`). |
| B3 unchanged sensor packets | Done | Send on HR/step change plus a bounded ten-second keepalive; carry source time and always include final samples (`src/c/main.c:576-607`). |
| B4 AppMessage coalescing | Mostly done | Obsolete GPS/live snapshots replace queued ones; TRACK+TSPAN and PACEG+HRG are bundled. GPS status remains separate when it conveys a real transition/accuracy update. |
| B5 redraw invalidation | Partly done | Identical HR, steps, and hint icons do not redraw. Splitting static grid/GPS/HR into separate native layers is deferred pending on-watch profiling. |
| B6 checkpoint amplification | Done | 60-point chunk journal plus small metadata/heartbeat; bounded partial-chunk rewrites and one final compaction. |
| B7 configuration-only GPS | Done | GPS starts for active recovery or foreground watch HELLO, not phone-only page launch. |
| B8 numeric hot path | Mostly done | Removed decimal string round trips; route drawing uses array/join; rolling pace already scans only its 60-second window. Per-segment distance caching remains optional. |
| B9 settings persistence | Done | Watch writes only changed keys; phone applies a packet then persists once. |
| B10 full-page work | Done | Metadata list, one-run detail, joined SVG commands, and visual chart decimation preserve full stored/exported points. |
| B11 token churn | Done | FitTrackee token invalidates only for destination/credential changes. |

No GPS frequency, GPS precision, stored route, HR sensor period, step sample, or
auto-pause feature was reduced.

## Remaining work, in priority order

### R1 — Native state-machine and transport fault automation (P1 assurance)

The JS harness now covers protocol sequencing and restart reconciliation, but it
cannot execute watch C callbacks. Extract state/health accounting into pure C
and test busy outbox, failed send, delayed/duplicate ACK, watch process death,
midnight health rollover, and every transition offset. Add emulator smoke tests
for basalt/diorite/emery.

### R2 — Finished-run A/B generations and recovery UI (P2)

Use two versioned finished-run records plus a verified active pointer. Expose the
raw corrupt backup as a download before clearing it. Add quota/interrupted-write
tests with injected localStorage failures.

### R3 — Recovery chunk integrity (P2)

Add per-chunk checksum/version and an acknowledged manifest so a malformed
middle chunk is reported explicitly instead of retaining only the valid prefix.

### R4 — Robust auto-resume window (P2)

START now clears pre-run motion history, but resume still relies on consecutive
point-to-point raw speeds. Test a short median/displacement window that includes
accuracy bounds against stationary high-jitter traces without increasing real
resume latency.

### R5 — Preserve a raw HR sample series (P2)

Overall HR is now correctly time-weighted and peak-safe, but only its aggregate
is retained separately. A chunked raw HR series would make future recalculation
possible and let split/export interpolation include peaks between accepted GPS
points.

### R6 — Hardware power budget and native layer split (P2 assurance)

Measure callbacks, AppMessages/bytes, flash writes, redraws, GPS-active time, and
battery change in READY/RUNNING/PAUSED/no-GPS scenarios on real watches/phones.
Only then decide whether splitting the native chrome layer gives a worthwhile
gain for its extra memory/complexity.

### R7 — Independent importer and CSP hardening (P3)

Import produced FIT files with an external decoder/service, then test GPX/TCX/FIT
against real destinations. Separately test whether all supported Pebble
WebViews accept a build-generated script hash so `unsafe-inline` can be removed.

## Release assessment

The app is materially safer, more recoverable, more privacy-conscious, and more
battery-efficient than the audited snapshot. The original P0 defects are fixed
in source and covered by new phone-side fault scenarios. A production release
should still include emulator/on-device protocol exercises and at least one
repeatable battery comparison, because compilation and JS simulation cannot
prove native callback timing or real radio/power behavior.
