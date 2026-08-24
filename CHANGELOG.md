# Changelog

All notable changes to RunLog. Dates are approximate. Versions that change the
**watch binary** are marked — those require re-flashing the watch, not just
reloading the phone bundle.

## 2.2.0 — Emery-native runtime, essential settings and steadier tracking

- The watch package now targets only **Emery / Pebble Time 2** and uses the
  feature-complete native C runtime. The established 60-key protocol remains
  append-only, so the PebbleKit JS GPS, storage, trim, export and upload pipeline
  is unchanged.
- Removed the full Alloy watch archive after reproducing the physical-only
  `fxMapArchive failed in ArchivePebbleResource` crash. Current PebbleOS copies
  an installable MOD into app RAM, while QEMU maps the same resource in place;
  RunLog's 44 KiB archive and expanded XS state therefore fit the emulator but
  cannot coexist on a physical PT2. The native PBW contains no MOD/XSA, uses
  6,959 bytes of resources, and the SDK reports 48,040 bytes of fixed RAM with
  83,032 bytes left for the app heap after the touch additions.
- Opted the native app into PebbleOS's current PT2 touch APIs. The workout
  window now owns its tap/swipe recognizers: a screen tap requests a coherent
  stat refresh without synthesising SELECT or pausing, while swipes preserve
  the established button mappings. Accelerometer-triggered refresh is
  deliberately disabled so arm swing and rocky trails cannot create wakeups.
  Debrief and settings keep native touch navigation, and all physical
  single/long-button recognizers remain authoritative for rain or gloves.
- Preserved native Health, restart recovery, dynamically fitted metrics,
  route/stats/trends debrief and the protocol-v3 sensor journal. The bounded
  journal holds 1,024 compact records (about 8.5 hours normally or 17 hours for
  Hike), and AppMessage buffers remain 512 bytes.
- Avoided continuous accelerometer sampling: PT2 Health provides workout steps,
  while raw wrist motion would add wakeups without improving phone-GPS route
  estimation. Normal/Hike Health and HR periods remain deliberately sparse.
- Hike Health reads and watch-bound live snapshots now share a 30-second
  cadence, unchanged-health keepalives use 60 seconds, and small GPS-accuracy
  fluctuations are coalesced for up to 30 seconds. The 2-second high-accuracy
  GPS request remains unchanged so auto-pause and resume do not become sluggish.
- Fixed the Hike watch journal resend deadline accidentally using the normal
  30-second constant instead of Hike's 60-second cadence.
- Session-mutating phone packets are now rejected when their session ID is
  missing or stale, and every no-save result carries its session ID. A delayed
  state retry can no longer replace a newer workout on the watch.
- Preflighted variable-length rename packets and explicitly finish a partial
  AppMessage after any dictionary error. This prevents PebbleOS remaining in
  `OUT_WRITING` and refusing every later control after an undersized fallback
  buffer.

- Restored the settings most useful immediately before a workout to the watch:
  **Auto-pause**, **Units**, **Split alerts** and the **HR zone** marker now sit
  beside Activity, while maximum/resting HR, targets, naming and uploads remain
  under Phone settings.
- Watch edits persist and work offline. The existing `CFGSET` key now
  distinguishes a phone edit from a local watch edit and explicitly acknowledges
  the accepted full snapshot, so a stale disconnected phone value cannot
  overwrite a newer watch toggle.
- Auto-pause now requires four consecutive slow observations in every mode.
  The Run pause gate is 0.65 m/s and Ride is 0.90 m/s, reducing false pauses
  during very slow genuine movement. Run and Walk require two moving
  observations to resume; Ride and Hike require three. Stale GPS gaps reset both
  debounce counters instead of counting an unseen interval as evidence.
- Hike now accepts ordinary route points at most every 10 seconds, rejects fixes
  worse than 35 m, uses a calmer filter, an accuracy-scaled movement floor and a
  4 m/s jump gate. Uncertain near-180-degree legs inside the reported error
  radius are treated as stop/noise evidence and cannot trigger auto-resume. This
  reduces stopped/canyon multipath zigzags without raising the slow-climb pause
  threshold or starving consistent 0.35 m/s progress.
- The current Core Devices PKJS `frequency` extension now requests 1000 ms fixes
  for Run/Walk/Ride and 2000 ms for Hike. The continuous watch no longer passes
  `maximumAge` or `timeout`, which the current bridge does not forward.
- GPS covariance now matches Android's forwarded 68%-confidence accuracy radius.
  A 2D innovation gate down-weights borderline measurements and atomically
  rejects statistically implausible jumps; guarded receiver speed improves
  auto-pause when Core supplies it. A 10-second callback outage creates an
  explicit route segment instead of adding distance across unseen movement.
- The active watch screen now says **GPS LOST** when the phone remains connected
  but the usable location stream disappears; **PHONE OFFLINE** still takes
  precedence when Bluetooth is gone.
- Routed activities can now be trimmed from both ends on the phone debrief.
  Its point-snapped controls now sit directly with the map, report retained
  time/distance/route size, label the proposed START/END markers, redraw at most
  once per animation frame and include a one-tap Reset before the irreversible
  confirmation. The retained route stays solid orange, discarded ends become
  dashed grey, and no slider movement reloads map tiles. Applying a trim
  transactionally rewrites the route journal, preserves pause segments, recalculates distance, time,
  elevation, heart rate, splits and analysis, adjusts steps from the retained
  cadence evidence, and marks an uploaded copy as changed locally for deliberate
  re-upload.
- The host suite now covers 39 end-to-end scenarios, including every activity's
  pause/resume debounce, slow Hikes at 8 m and 20 m accuracy, Hike gorge jitter
  with auto-pause, Core request options, innovation rejection, receiver speed,
  stale route segmentation, activity trimming, coherent manual refresh, and the
  watch-wins reconnect conflict. A headless SDK 4.33.1 pass also builds the
  Emery PBW and verifies touch and physical-button state separation.

## 2.1.0 — calmer HR display and phone-first settings (complete PBW reinstall)

- Removed every app-controlled backlight colour change. RunLog now leaves the
  user's system backlight colour alone on Emery as well as older watches.
- Replaced the detached, full-width HR-zone badge with a small `Z1`–`Z5` text
  marker inside the HR tile's own caption row. The BPM stays solid black, the
  explicit zone remains legible on monochrome hardware, and the marker can be
  hidden from the phone page.
- Refined the live recorder without changing its familiar anatomy: boxed tiles
  became thin rules and whitespace, metric captions use compact Pebble system
  type, and the timer status now names **LIVE / LAP / TOTALS** with a `1/3`
  position and restrained segment marker. The marker appears only while those
  pages are navigable; pause state stays unmistakable, and no sensor, GPS,
  journal or radio cadence changes when a page changes.
- Rebuilt the on-watch debrief as three fixed Pebble-style pages instead of one
  long scrolling canvas: **Route** opens first, followed by **Stats** and
  **Trends**. UP/DOWN advances exactly one screen, the unavailable direction is
  removed from the button bar at each end, and SELECT keeps the protected
  Upload/Rename/Discard actions. A `1/3` position marker makes navigation clear.
- Route-less saves now say **NO GPS ROUTE — Time & sensors saved** on the watch.
  Routed workouts retain a distinct arrival state while their compact route is
  streaming from the phone, rather than leaving both cases on the same endless
  “waiting for phone” message.
- Removed truncating and trailing-ellipsis UI on both sides. Watch values and
  captions select the largest complete one-line font that fits, compact labels
  replace broken word fragments on Basalt, and long phone activity names wrap.
  The normal debrief no longer repeats an `ON PHONE` footer beneath a green
  SAVED header; upload state appears only when it adds information.
- Corrected the GPS Kalman setup: W3C's 95%-confidence accuracy radius is now
  converted to per-axis measurement variance, acceleration noise is tuned per
  activity, velocity is estimated instead of seeded from one noisy interval,
  duplicate/reordered timestamps are ignored, and long outages re-anchor the
  state. New regressions cover timestamp spikes, sharp turns, accuracy weighting
  and stale-velocity projection.
- Moved units, auto-pause, split alerts, maximum HR and resting HR into a new
  **Watch & Workout** card on the mobile RunLog page, alongside the existing
  workout targets. The watch menu is now only Activity and Phone settings;
  activity selection remains fully local and available offline.
- Phone-managed settings are sent in one protected packet only when changed.
  A disconnected edit carries a durable pending marker, ignores stale watch
  snapshots, retries on reconciliation and clears only after the watch echoes
  the complete applied values. Watch flash writes still occur only on change.
- Watch controls are locked on the page during a live workout, and the watch
  also refuses a settings packet while active, so units or auto-pause cannot
  unexpectedly change halfway through an activity. Targets remain live-editable.
- Added `CFGSET` and `HRZONE` as appended message keys without renumbering the
  established protocol. Existing settings migrate with the zone marker on.
- The host suite now covers 34 end-to-end scenarios, including stale reconnect
  and settings-ack behaviour. A native screenshot suite resets a disposable
  emulator, injects deterministic long-distance live/debrief fixtures, and
  captures ten distinct Ready/Settings/workout/debrief screens on both Emery
  and Basalt using the SDK's headless VNC backend, so automated runs never
  steal desktop focus.
  Native SDK 4.17 builds pass for Emery, Diorite and Basalt; source policy also
  prevents a scroll-layer or ellipsis regression.

## 2.0.0 — workout-first controls, resilient recording, current SDK (complete PBW reinstall)

RunLog 2 is a native Basalt/Diorite/Emery release built and verified with the
official `latest` SDK channel (SDK 4.17, GCC 14). It keeps physical-button
behavior deterministic and recording quality fixed for the whole workout; no
feature silently reduces GPS or logging quality after an elapsed-time threshold.

**Live workout experience**

- UP and DOWN now switch among three zero-cost views: core distance/pace/HR,
  current lap, and averages/ascent/target. Page changes only redraw already
  collected values and never change GPS, Health, journal or radio cadence.
- Hold DOWN while running to close a manual lap. Lap boundaries survive phone
  reconnects, appear in the phone debrief, and are carried with the activity.
- Optional phone-configured targets cover duration, distance, HR zone and pace
  range. Target checks piggyback on the existing one-second UI tick, require a
  sustained miss, and rate-limit vibration reminders to avoid noisy workouts.
- AUTO-PAUSE now has deliberately separate controls: SELECT resumes; either
  outer button converts it atomically into a true manual pause. This never adds
  a fake active interval or requires the old resume-then-pause double click.
- The live HR tile retains its explicit coloured `Z1`–`Z5` badge and complete,
  dynamically fitted numbers. On Emery's current RGB-backlight firmware the
  existing backlight takes the zone tint without being forced on; other watches
  retain the labelled badge. Disabled Health permission is shown as `HR OFF`.

**Protocol-v3 sensor journal and honest route-less workouts**

- The watch retains compact timestamp/active-time/HR/peak/step/state/lap records
  at a fixed 30-second cadence (60 seconds for Hike), batches them into existing
  messages, and drops records only after the phone durably stores and ACKs them.
  Capacity is roughly 8.5 hours disconnected, or 17 hours for Hike.
- Full session snapshots, monotonically sequenced commands and durable journal
  ACKs reconcile independent phone/watch restarts. Lifecycle commands remain
  usable locally while offline; duplicate and reordered messages are idempotent.
- A meaningful workout with no phone GPS is saved as route-less time, HR, net
  steps, pauses and laps. Distance, pace, ascent and coordinates remain absent—
  GPS is still their only source. The page shows no map and uses time-axis HR.
- GPX emits metadata without fake track points, TCX retains timed sensor points
  while omitting position/distance, and FIT uses profile-defined invalid
  position/distance/speed values. All three forms remain downloadable/uploadable.
- An immediate empty start/stop still reports `NOT SAVED`. Any unavoidable loss
  of unacknowledged watch RAM is marked as a data-quality gap, never fabricated.

**Battery and current platform services**

- ConnectionService suppresses every AppMessage attempt while the phone is
  absent and wakes reconciliation immediately on the reconnect edge. A phone
  that is connected but not acknowledging backs off exponentially from 1.4 to
  30 seconds instead of retrying every 450–1400 ms indefinitely.
- Active HR uses firmware `HealthEventHeartRateUpdate` events rather than
  repeatedly peeking the same cached optical reading. Allocation failure falls
  back to the exact fixed activity cadence; pausing unsubscribes and retains the
  low-duty 60-second sample. The three-sample mean now counts each optical sample
  once instead of overweighting cached duplicates.
- Run/Walk/Ride still keep 5-second watch updates and Hike keeps its selected
  15-second profile from start to finish. High-accuracy GPS points are never
  thinned, and the RGB zone tint never activates or extends the backlight.
- Pebble Data Logging was not substituted for the journal: it cannot deliver to
  a PebbleKit JS companion. The protocol-v3 journal preserves the current phone
  architecture and all supported watches without a native Android/iOS app.

**Verification**

- The host suite now covers 33 end-to-end recording/upload scenarios plus
  route-less GPX/TCX/FIT bytes, target/config radio discipline, atomic
  auto-to-manual pause, durable missed-START reconstruction, long-route phone
  rendering, Endurain and corruption recovery.
- Native builds pass for Emery, Diorite and Basalt under SDK 4.17. HRV and its
  stillness/recovery workflow remain fully removed.

## 1.30.4 — legible live metrics and HR zones (watch binary changed → reflash)

- The live HR tile now has a full-width colour badge labelled `HR Z1` through
  `HR Z5`. The explicit zone number remains clear on monochrome watches, while
  the solid badge is much easier to identify at a glance during a workout than
  the previous six-pixel colour bar.
- Distance, pace/speed, HR, steps and long elapsed times now select the largest
  bundled font that actually fits their tile. Normal values retain the large
  LECO digits, while values such as `10.00` shrink just enough to remain complete
  instead of becoming an ellipsis.
- Font fitting uses measured glyph widths and only refits the one-second timer
  when its character count changes, avoiding needless layout work while running.

## 1.30.3 — predictable blank launch screen (watch binary changed → reflash)

- Every ordinary app launch now starts on the READY recorder with zero time,
  distance, steps and live measurements. A completed workout remains saved on
  the phone and in its history, but its watch debrief is not restored later.
- The debrief still appears immediately when the current workout is saved; this
  change only retires `DONE` when that watchapp process ends.
- Genuine unfinished sessions remain restart-safe: RUNNING, PAUSED and SAVING
  state still restore and reconcile with the phone instead of being zeroed.
- A delayed protected `SAVED` retry is rejected on a fresh launch and while a
  different session is active, preventing an old phone packet from resurrecting
  the previous debrief over READY or clobbering a newly started workout.
- The phone protocol test now verifies that a fresh `SID=0` / `READY` handshake
  keeps the previous activity in storage without replaying its summary.

## 1.30.2 — single-page phone debrief (package changed → reinstall)

**The real phone-detail fix**

- Replaced the close/reopen detail handoff. The current official Pebble mobile
  app leaves the settings screen after `pebblejs://close` and does not consume
  RunLog's immediate second `Pebble.openURL()`, so 1.30.1's smaller second URL
  could still never appear.
- The first and only settings page now carries every retained route as a compact
  binary varint stream. Tapping a row decodes that route inside the existing
  WebView: it does not close, navigate or depend on a second bridge call.
- Packing is lossless at the journal's stored precision. Tests round-trip every
  timestamp, coordinate, elevation, HR, pause marker and cadence value in a
  12,000-point hike.
- Only the selected route is expanded in memory. Returning to the list releases
  it, and tapping it again decodes the retained packed stream.
- Charts and downloads still use every point. The map alone limits its SVG
  vertices to what the phone display can resolve, while retaining starts, ends
  and both sides of every pause; this avoids handing old WebViews enormous path
  strings without altering stored/exported data.

## 1.30.1 — reliable details and Endurain, still-measurement removal (watch binary changed → reflash)

**Removed cleanly**

- Removed the short-lived HRV/still-measurement feature in full: no high-rate
  sensor request, idle or recovery timer, prompt, wire fields, summary section,
  phone analysis, native compatibility shim or dedicated math test remains.
- Upgrade cleanup deletes its old watch persistence slots and drops its aggregate
  metadata from the phone index. Activity routes, heart rate, steps, cadence,
  splits, post-workout analysis and exports are unchanged.

**Phone detail crash**

- A selected route is now injected into the debrief as lossless integer deltas
  and expanded before the map, charts, splits and exporters run. The complete
  HTML then uses a base64 `data:` URL instead of percent-encoding punctuation.
- No route point is sampled out or omitted. The pipeline round-trips a synthetic
  12,000-point hike exactly and verifies the complete page remains below the
  phone-webview danger size.

**Endurain**

- Confirmed the current official contract: multipart field `file`,
  `POST /api/v1/activities/create/upload`, `X-API-Key`, and the
  `activities:upload` scope.
- GPX/TCX multipart bodies now use explicit UTF-8 bytes, matching the reliable
  binary FIT transport instead of depending on embedded-XHR string encoding.
- Endurain gets a 90-second import timeout because it parses and stores the file
  before returning `201`. Instance roots, `/api/v1`, the full endpoint and
  pasted API-docs URLs normalize to one endpoint while reverse-proxy subpaths
  remain intact.
- HTTP JSON error details now appear in RunLog's phone log. URL/API-key inputs
  disable auto-capitalization and correction, avoiding silent credential edits.

## 1.30.0 — bounded HRV and recovery analysis (watch binary changed → reflash)

RunLog now uses PebbleOS 4.32.0's native peak-to-peak interval API on Pebble
Time 2. Basalt, Diorite and older firmware keep all existing behaviour without
showing unsupported HRV controls or results.

**Useful, honest measurements**

- A static `HRV: KEEP STILL` prompt collects a 60-second pre-workout window.
  Starting a workout is never delayed; an incomplete window is simply omitted.
- Stopping starts a non-blocking two-minute recovery window without delaying
  save or the debrief. RunLog records stop-to-60-second heart-rate recovery,
  then calculates RMSSD from recovery minute two, after the strong initial HR
  trend.
- RMSSD needs at least 30 accepted intervals covering at least 40 seconds.
  Values outside 300–2000 ms and consecutive jumps over 20% are rejected.
  Insufficient signal is reported honestly, with the accepted count, rather
  than converted into a plausible-looking score.
- The phone debrief compares pre-workout RMSSD with the median of up to the last
  seven earlier pre-workout readings. It intentionally avoids a medical or
  “readiness” classification, because comparable posture, timing and conditions
  matter more than a universal threshold.
- Raw peak-to-peak intervals exist only in watch RAM. The saved activity retains
  aggregate RMSSD, quality count and HR recovery; existing GPX/TCX/FIT files are
  unchanged.

**Battery and lifecycle**

- The 100 Hz HRV request is never active during a workout. It is bounded to one
  minute while idle and two minutes immediately after stop, regardless of
  workout length; every cancellation, new-start and app-exit path explicitly
  turns it off.
- Beat events only append to a fixed-size buffer. They do not redraw the display
  or send Bluetooth messages. One small metadata update lands after the recovery
  window without rewriting the independently checksummed route chunks.
- Run/Walk/Ride/Hike GPS acceptance and each mode's fixed live-stat, Health and
  radio cadence are untouched.

**Compatibility and tests**

- The source compiles against the currently packaged revision-107 SDK while
  runtime-gating the two append-only revision-109 HRV calls behind PebbleOS
  4.32.0. A newer SDK that declares the calls automatically replaces the
  compatibility thunks.
- Host tests cover the interval gate, integer RMSSD, quality floor and bounded
  buffer. The 30th end-to-end pipeline scenario covers pre-workout capture,
  delayed recovery/HRR persistence, duplicate idempotency, phone rendering and
  metadata-only journal updates.

## 1.29.0 — post-workout analysis, chunked journal, Endurain (package changed → reinstall)

Recording quality, GPS acceptance and each activity's fixed power profile are
unchanged. New calculations run only after stop and add no live watch, GPS,
Health or Bluetooth work.

**Post-workout analysis**

- The phone debrief now shows time in five HR zones, calculated from the max HR
  stored with the activity and weighted by sample time. A coverage percentage
  makes missing optical-HR data visible.
- Full splits get a coefficient-of-variation consistency rating. Finish strength
  compares equal-distance halves, avoiding point-density bias.
- Sustained climbs are detected from the already-smoothed elevation track using
  conservative 10 m gain / 50 m distance / 5 m closing-descent thresholds. The
  three largest show gain, distance, moving time and average grade.
- Stopped time and manual/automatic pause count come from the authoritative
  clocks and lifecycle event journal.
- A workout is compared with the preceding saved workout of the same activity
  type. Record badges are honestly scoped to the activities currently saved on
  the phone and recalculate after delete or re-type.

**Chunked activity journal**

- Completed activities now use a lightweight metadata index and independently
  checksummed, delta-encoded route chunks. The phone keeps up to 12 activities
  within the existing conservative storage cap.
- New chunks are fully written and read-back-verified before the small index is
  committed. Superseded chunks are removed only after that commit; orphan chunks
  left by a crash before it are garbage-collected on the next launch.
- Existing monolithic `runlog.runs` data migrates atomically. A failed migration
  leaves the byte-for-byte legacy value authoritative and retryable.
- Rename, re-type and upload-state edits reuse immutable route chunks rather
  than serialising every GPS point again.
- A missing or damaged route chunk no longer erases the activity. Every other
  valid chunk is salvaged, a segment break prevents drawing/exporting across the
  hole, and the detail page reports recovered versus expected points.
- Start, pause, automatic pause/resume, manual resume, phone restart, recovery
  and stop are retained as compact lifecycle events alongside the run.

**Endurain**

- Added a first-class Endurain preset using its official
  `POST /api/v1/activities/create/upload` endpoint.
- Authentication uses an `X-API-Key` created with only the
  `activities:upload` scope. GPX, TCX and FIT follow the existing format choice;
  the account password is never needed.

**Tests**

- The pipeline now covers 29 end-to-end scenarios, including Endurain request
  shape, metadata-only edits not rewriting route chunks, failed/successful
  legacy migration, orphan cleanup and damaged-final-chunk salvage.

## 1.28.0 — export correctness, credential encoding, debrief identity (watch binary changed → reflash)

Correctness pass. GPS acceptance, workout cadence and per-mode power profiles
remain fixed from start to finish; this release improves exported metadata,
credential handling and the accuracy of recorded summary fields.

**Exports**

- **FIT `total_timer_time` was written to the wrong field and silently discarded
  by every decoder.** The activity message declared it as field 15, which is not
  defined in FIT global message 34, so importers dropped it. It is field 0. Lap
  and session already carried a correct copy, which is why this never surfaced as
  an obvious failure.
- FIT lap and session now also carry `avg_speed`, `total_ascent`, `avg_cadence`
  and lap avg/max heart rate — the summary fields importers check a file against.
  Note that lap and session number these differently (`avg_speed` is 13 in lap
  and 14 in session; HR is 15/16 vs 16/17); both are now asserted in the tests.
- A `file_creator` message is emitted, as Garmin-produced activity files do.
- Absent values emit FIT invalid markers rather than misleading measurements.
  A route with altitude samples and genuinely zero ascent remains a measured
  `0 m`; only a route with no elevation data is marked unknown.
- The FIT tests now assert declared *field numbers* against the profile. The
  previous decoder read fields by whatever number the writer emitted, so it was
  structurally incapable of catching this class of bug.

**Uploads**

- **Basic credentials use UTF-8**, including valid surrogate pairs. RFC 7617
  leaves the legacy default encoding unspecified but defines UTF-8 as its
  international form. The old encoder simply masked each UTF-16 code unit to
  8 bits, mangling most non-ASCII passwords and tokens.

**Watch**

- The debrief always describes the activity it belongs to. It read the *live*
  mode setting, so backing out, pressing DOWN, and receiving a late route packet
  could redraw a run as "RIDE SAVED" with ride formatting. The recorded activity
  now travels with the summary (`MODE`) and is stored on the run stats.
- Dismissing the debrief sticks: a late route/graph packet no longer reopens it.
- Upload status survives the debrief being closed and reopened, and is cleared
  only for a genuinely new activity.
- "Nothing to upload" is shown when the phone reports it, instead of falling
  through to "Saved on phone" — a failure was displaying as a success.
- Max heart rate can use a corroborated raw sensor peak (new `HRPK` key), so a
  genuine peak hidden by the three-sample display mean is retained. A lone
  optical-sensor jump is rejected, and the smoothed maximum remains the fallback.
  The cumulative peak tuple is sent only when it changes or on an existing
  keepalive, rather than enlarging every health packet.
- Windows are no longer destroyed from inside their own unload handler, which
  freed memory the window stack was still unwinding through — reachable from an
  AppMessage callback via the discard path.
- Every `dict_write_*` result is checked. A truncated control message is never
  transmitted, and a voice name too long for the outbox now fails visibly instead
  of leaving the wrist on "Renaming…" forever. The outbox is 512 bytes (was 256,
  against a ~240-byte worst case) and `app_message_open`'s result is honoured.
- Health sampling uses a resettable fixed-cadence countdown instead of a
  never-reset tick counter. Every manual or automatic resume samples promptly;
  wall-clock corrections cannot stall it, and cadence never changes because a
  workout has become longer.

**Phone**

- VO₂max is recomputed from the max/resting HR that were configured *when the
  run was recorded*, now stored on each activity. Changing your max HR used to
  retroactively rescale an old activity's estimate on re-type. Activities saved
  before 1.28.0 fall back to the current setting.
- The log warns when a detail page's `data:` URL grows past ~900 KB, which some
  phone webviews silently refuse — previously the button just did nothing.

**Build**

- `tools/build_page.js` is the single source of truth for shared code and now
  injects `gpx` and `smooth` alongside `tcx` and `fit`. GPX and the chart
  smoother had been hand-copied into `tools/page.html` and had already drifted
  (different escaping, a missing `undefined` check), so a download and an upload
  could produce different files. The bundler refuses to build if the page
  redeclares a shared function, and `tools/test_export.js` now injects through
  the bundler rather than keeping its own copy of the list.

## 1.27.1 — predictable, quality-preserving battery pass (watch binary changed → reflash)

- Removed 1.27.0's elapsed-time-based power switch. Run, Walk and Ride retain
  the same live-stat, health and accuracy cadence from start to finish; no
  activity silently changes its logging behaviour based on elapsed time. Hike
  keeps its explicitly selected, fixed 15/30-second profile.
- GPS acquisition and the accepted-point path remain unchanged while moving:
  splits, checkpoints and exports still consume the same recorded points.
- A manual pause in **any** activity now keeps GPS warm for one minute, then
  releases the receiver for a long break and reacquires it on resume. Auto-pause
  keeps GPS running so movement can still resume the activity automatically.
- Idle and manually paused fixes bypass timestamp, Kalman and elevation work.
  Auto-paused fixes do only the raw-speed work needed for auto-resume and restart
  the filter cleanly once movement returns.
- GPS accuracy, split and live stats originating from one fix now share one
  AppMessage. Average pace and elevation gain, which are not displayed live,
  are sent only in the final protected summary.
- Replaced the six-second GPS watchdog poll and fixed recovery heartbeat with
  deadline-driven one-shot timers. A full checkpoint resets the heartbeat
  instead of immediately writing duplicate liveness data.
- Watch persistence writes now skip unchanged values. HR changes redraw the
  chrome only when the displayed zone changes, and accuracy changes redraw it
  only when the GPS dot changes between no-fix/good/weak.
- Added simulation coverage proving hour-plus Runs and Rides retain their
  original update cadence, plus all-mode manual-pause GPS release/reacquisition,
  coalesced packets, non-duplicated checkpoints and unthinned routes.

## 1.26 — Hike + fixed battery profile (watch binary changed → reflash)

- Added **Hike** as a fourth first-class activity from watch selection through
  saved history, launcher glance, re-typing, names, summaries, GPX/TCX/FIT
  exports and uploads. Hikes export as GPX `hiking`, FIT `hiking`, TCX `Other`,
  and FitTrackee Hiking (default sport id 3).
- Hike auto-pause is tuned for steep, genuinely slow movement (pause below
  0.30 m/s, resume above 0.65 m/s) and retains one-unit splits, steps and foot
  cadence.
- Added a fixed power profile for Hike: 15-second live-stat and health
  updates, 30-second optical-HR requests and unchanged-health keepalives, plus
  less chatty GPS-accuracy updates. The phone still acquires high-accuracy GPS
  continuously and applies the same acceptance, filtering and checkpoint path,
  so the saved route is not thinned to obtain these savings.
- A manually paused Hike keeps GPS warm for one minute, then releases it during
  a long break and reacquires it on resume. Auto-pause deliberately keeps GPS
  active because GPS movement is what triggers automatic resume.
- All paused modes now sample watch health once per minute. Repeated distance,
  pace, accuracy and GPS-state text is ignored before invalidating layers, and
  the HR sensor is reconfigured only when its requested period actually changes.
- Added a Hike icon and end-to-end simulations covering slow-climb auto-pause,
  reduced live-message cadence, long-pause GPS release/reacquisition, route
  preservation, cadence and FitTrackee/GPX classification.

## 1.25 — second-review fixes (watch binary changed → reflash)

A follow-up review of 1.24 found that several 1.24 claims didn't hold end to end,
including two that were my fault: the route-scale fix was described but never
actually applied, and a "paused steps excluded" test passed only because it fed
the watch messages a real watch never sends. This release fixes those and the
rest of the findings, and adds realistic integration tests.

- **Route scale actually fixed now.** The east–west scale label applied
  `cos(latitude)` twice (the coordinates were already `lon·cos(lat)`), so a 1 km
  east–west route near Perth read ~848 m. The second cosine is gone.
- **No-GPS runs are no longer stored.** 1.24 tried to keep them as time/steps
  records, but every consumer (detail page, GPX/TCX/FIT export, upload) assumed a
  GPS point existed and threw, and HR was never actually preserved. A no-GPS stop
  now reports **NOT SAVED** and stores nothing — honest, and it removes the whole
  empty-track failure class. Exporters and the page also gained defensive guards.
- **Paused steps are excluded on the watch**, where the step counter lives. The
  count freezes during a pause (manual or auto), and since the watch only sends
  while running, the phone receives an already-correct total (the old phone-side
  subtraction never fired, because no messages arrive during a pause).
- **Restart recovery no longer corrupts distance.** Resuming a checkpoint starts a
  fresh segment, so the reacquisition gap isn't added to distance; the checkpoint
  now records pause state; a paused-at-crash run resumes paused; the arbitrary
  ">10 points" cutoff is gone; and a failed recovery save keeps the checkpoint to
  retry instead of dropping the run.
- **More idempotent commands.** A duplicate resume no longer injects a phantom
  segment break; a duplicate stop is silent instead of sending NOSAVE over a
  prior SAVED.
- **Outlier gate moved before the filter**, so a physically-impossible raw fix is
  rejected before it can reach the Kalman filter, auto-pause or the previous-fix
  reference (only closely-spaced fixes are gated, so post-pause relocations are
  fine).
- Split interval cap aligned with the moving-time cap (avg pace and split pace
  agreed).
- Duration now uses true elapsed wall-clock time, not the first-to-last-fix span.
- Corrupt `runlog.runs` is backed up before an empty history is returned, so a
  later save can't overwrite recoverable data.
- Watch: **NOT SAVED** is shown after the READY screen is reset (so it isn't
  immediately overwritten) and stale workout numbers are cleared; HR is read only
  after checking the metric is accessible.
- CSP tightened: images restricted to the two tile CDNs and network connections
  blocked outright (the page makes none).
- Silenced the `summary.c` truncation warnings; added `.lock-waf*` to
  `.gitignore`; added integration tests for honest-NOSAVE, the phone/watch step
  contract, and restart-resume-without-gap-distance.

Still deferred (see 1.24): a full application-level watch↔phone acknowledgement.
The phone retries messages that fail to send, but a successful *transport*
callback still isn't a confirmation the watch processed the message — so a run
can, in principle, still be lost to a dropped message. Claims elsewhere are
worded to reflect that.

## 1.24 — correctness & robustness pass (watch binary changed → reflash)

A large pass in response to a detailed external code review of 1.22. The theme
is honesty and durability: claim a save only when it succeeded, hold up against a
mid-run restart, retry messages that fail to send, and get the exported numbers
right. (Several 1.24 items were corrected again in 1.25 — see above.)

Data integrity & messaging
- **Honest saves.** "SAVED" is now sent only after the write actually succeeds.
  A stop with no GPS *and* no meaningful time reports **NOT SAVED**; a storage
  failure reports it too, instead of flashing a bogus summary.
- **No-GPS runs:** reported honestly as NOT SAVED rather than flashing a bogus
  summary. (1.24 briefly stored them as time/steps records; 1.25 removed that — it
  broke the page, exporters and upload, and never preserved HR.)
- **Retryable messaging.** Protected watch messages (final stats, route, graphs,
  upload results) are retried with backoff on send failure instead of being
  dropped — an `APP_MSG_OK` from a send no longer counts as "received".
- **Restart resilience.** A phone-JS restart mid-run now *resumes* a fresh
  in-progress checkpoint (continues recording) instead of truncating the run; a
  stale checkpoint is recovered and saved. A per-run **session id** prevents a
  recovered run from being written twice.
- **Idempotent commands.** Duplicate start/stop/pause/resume no longer reset or
  corrupt an active run.
- **Storage** reports success/failure and logs when it evicts the oldest run.

Sensors, timing & exports
- Millisecond-precision fix timestamps feed the Kalman filter and auto-pause, so
  bursts of same-second fixes no longer seed spurious velocity.
- Physical **outlier gate**: fixes implying impossible speed (per activity) are
  rejected; non-finite coordinates are ignored.
- Moving-time accrual cap relaxed so sparse-but-moving stretches aren't clipped.
- **TCX/FIT** cumulative distance no longer adds the straight-line jump across a
  pause (a paused relocation used to inflate the last trackpoint by kilometres).
- **Ride cadence** (wrist-derived) is stripped from GPX/TCX/FIT and cleared on
  retype-to-ride — it was never crank cadence.
- Steps taken **while paused** are excluded from the total and cadence.
- HR state is reset between runs (no carry-over of the previous run's HR).
- Default filename template is now time-bearing (`%Y-%m-%d_%H%M_{activity}`) so
  two same-day activities can't overwrite each other on WebDAV.
- Watch **route scale** label fixed (a double `cos(latitude)` under-reported
  east–west distance by ~15% at Perth's latitude).

Uploads & security
- Upload records destination/format/timestamp; busy/no-destination cases now
  give a visible signal instead of failing silently; XHR callbacks fire once.
- The diagnostic log no longer prints password characters or length.
- Plain-`http://` destinations carrying credentials now log a clear warning.
- The phone page escapes user-authored run names in HTML and GPX output and ships
  with a tightened Content-Security-Policy (external scripts and objects blocked;
  inline scripts/styles remain, since the page is a single self-contained file).

Watch UI
- Debrief title reflects the activity (RUN/WALK/RIDE SAVED), not always "RUN".
- Activity label shown in the top bar next to GPS accuracy (e.g. `RIDE ±8m`);
  the accuracy/clock overlap in the top bar is fixed.
- Live step readout hidden in ride mode; stale VO₂max cleared on a no-GPS save.
- Stop now needs a longer, deliberate hold (was 600 ms — too easy to trigger).
- Watch max-HR default aligned with the phone (190).

Battery (carried over from 1.23) and the idle-GPS release: GPS is warmed on open
for an instant start but auto-releases after 5 idle minutes if no run begins.

Deliberately deferred (documented, with reasons): a full bidirectional
per-command ACK handshake beyond retry+session+idempotency; watch route
pause-markers; native emulator CI; splitting the monolithic phone module; true
update-vs-create uploads (POST destinations create a new activity on re-upload);
offline maps; and a true peak-HR figure (the watch doesn't retain raw samples).

## 1.23 — battery (watch binary changed → reflash)

- Optical HR sensor sample period 1 s → 10 s (the sensor is the biggest watch
  drain, and the firmware only refreshes BPM every ~50 s during a run anyway);
  HR peeked at the 5 s push cadence rather than every second; running mean
  shortened to 3 samples.
- Live distance/pace pushes to the watch throttled to every 5 s.
- GPS `maximumAge` relaxed to 2 s.

## 1.22 — cadence spike fix

- Per-point cadence computed over a short trailing window snapped to the watch's
  5 s send cadence, removing BLE-timing 2×/0.5× spikes without shifting the bulk
  value or the run average.

## 1.21 — elevation smoothing in exports

- Stored and exported per-point elevation is the smoothed value, so GPX elevation
  gain is no longer inflated by GPS vertical noise.

## 1.20 — VO₂max on the watch (watch binary changed → reflash)

- VO₂max estimate shown on the watch summary; submaximal estimator with an
  optional Resting-HR setting (Karvonen/VO₂-reserve when set).

## 1.8–1.19 — earlier

Action bar and fonts; manual uploads with presets (WebDAV, intervals.icu,
Runalyze, FitTrackee) and a name template with voice rename; GPX/TCX/FIT export
with CI; App Glance; Kalman GPS smoother; VO₂max first added on the phone page.
