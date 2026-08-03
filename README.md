# RunLog — run / walk / ride / hike tracker for Pebble

A workout tracker for the Pebble Time 2 (also builds for Pebble 2 and Pebble Time). The watch shows live stats and reads the on-board heart-rate sensor; your phone records GPS, computes everything, and can export each activity as GPX, TCX or FIT — including straight to your own home server, whenever you choose.

## Where your activities live

This trips everyone up once, so up front: when the watch says **SAVED**, the activity has been stored **on your phone**, inside the Pebble app's storage for RunLog (up to the last 12 activities are kept, subject to the storage cap). There's no file in your Downloads yet — the watch retains only the live, unacknowledged sensor journal and the debrief screen you're looking at, whose footer says *"On phone: gear icon"*. SAVED is shown only after the phone write succeeds. A genuinely empty accidental start/stop or a failed storage write says **NOT SAVED**. A real workout without a GPS fix is now kept honestly as a route-less time/HR/step activity: it has no invented coordinates, distance, pace, climb or map.

To see your activities: open the **Pebble phone app → RunLog → gear/settings icon**. That opens the full debrief — map, charts, splits — for every saved activity. From there you can get a *tangible* copy two ways:

- **Download .gpx** on any activity saves a file to your phone (share it anywhere), or
- set up an **upload destination** and send any activity to a server of your choosing with one button — from the watch debrief, or per-run on the phone page (see *Uploading* below). Uploads are fully manual: no *activity file* leaves your phone until you press Upload. (One caveat, for full honesty: opening a run's detail on the phone page fetches street-map tiles for that route's area from OpenStreetMap/CARTO, so the map view does make a network request — see *Privacy*.)

RunLog also asks the phone to pop the debrief open automatically right after each save, but most versions of the Pebble app only honour that from the gear icon, so don't be surprised if the gear is the only way in.

## Activity modes — Run / Walk / Ride / Hike

Press **DOWN** on the main screen to cycle between RUN, WALK, RIDE and HIKE (only while idle — mid-activity it flashes MODE LOCKED). The current mode sits top-left next to the GPS accuracy, e.g. `HIKE ±8m`, and there's also an **Activity** item in the settings menu. The mode is locked in when you press start.

Ride mode also drops the step/cadence readouts everywhere (wrist steps are not bicycle cadence). The watch debrief shows a smoothed peak speed and elapsed time in their place; the phone detail shows stopped time, elapsed time, and the best 5 km split as distinct metrics.

| | Run | Walk | Ride | Hike |
|---|---|---|---|---|
| Auto-pause below / resume above | 0.7 / 1.4 m/s | 0.45 / 0.9 m/s | 1.0 / 2.2 m/s | **0.30 / 0.65 m/s** |
| Split alerts every | 1 km/mi | 1 km/mi | **5** km/mi | 1 km/mi |
| Live metric | pace /km | pace /km | **speed km/h** (or mph) | pace /km |
| Debrief | avg pace, cadence | avg pace, cadence | **speed + ride timing**, no wrist cadence | avg pace, cadence |
| GPX `<type>` / name | running / "Run …" | walking / "Walk …" | cycling / "Ride …" | hiking / "Hike …" |

The thresholds matter: a gentle walk would constantly false-trigger run auto-pause, a bike coasting up to lights at 0.9 m/s should pause where a runner should not, and a steep climb can be genuine movement below ordinary walking speed. Hike therefore has a lower pause threshold and a fixed, lower-duty power profile. It records with the same high-accuracy GPS and the same point acceptance/filtering as every other mode; it saves power by refreshing watch-bound live values and health data less often, not by thinning the recorded route. The profile is selected with the activity and stays unchanged for the whole workout. Ride mode drops wrist cadence (meaningless on handlebars) and announces splits as cumulative distance ("KM 5", "KM 10"). Export destinations pick every mode up automatically.

## On the watch

**While recording:** a large elapsed timer in the LECO face used across the watch, then distance, rolling pace (or speed), heart rate and step count in a four-cell grid — all in matching LECO digits, sized to read at a glance without shouting. The current **time of day** sits top-right; the GPS fix readout (accuracy, e.g. `±8m`) sits top-left by the fix dot (green = good fix ≤ 20 m, orange = weak, red = none). Split alerts vibrate, light the backlight and flash `KM 3` / `MI 3` on a small line under the timer; auto-pause shows **AUTO-PAUSE** there and stops the timer, resuming itself when you move.

**Is it recording?** The timer's colour tells you instantly: **black while it's timing**, **red when paused** (including auto-pause), and grey when idle or saving — no squinting at a label.

**Heart rate readability:** the HR number is always drawn in solid black. Above it, a full-width coloured badge says **HR Z1** through **HR Z5** (zones are 60/70/80/90 % of your configurable max HR), making the current zone obvious while moving and still fully identifiable on a monochrome Pebble. On current Emery firmware, the backlight also takes the zone tint whenever it would already be lit; RunLog never turns it on merely to show a colour and restores the system tint outside recording. `HR OFF` distinguishes disabled Health permission from an ordinary sensor warm-up. Normal metrics retain the large LECO digits; if distance, pace/speed, steps or a long elapsed time outgrows its cell, RunLog selects the largest bundled font that fits the complete value instead of replacing its end with an ellipsis.

**Three workout pages:** while recording or manually paused, **UP/DOWN** move through the main distance/pace/HR-zone page, a current-lap page, and an averages/ascent/target page. These pages only redraw values already collected; changing pages never changes GPS, Health or radio cadence. Hold **DOWN** while recording to close the current manual lap. A target configured on the phone can be a duration, distance, HR zone or pace range; short signal wobbles are ignored, reminders are rate-limited, and target checks add no sensor reads or radio packets.

**The button bar:** a slim strip down the right edge shows what the three side buttons do now. Idle, it is a **gear** (UP → settings), a **play triangle** (SELECT → start) and the activity icon (DOWN → cycle Run/Walk/Ride/Hike). During normal recording, SELECT pauses and UP/DOWN change page. During a manual pause, SELECT resumes and UP/DOWN still change page. During **AUTO-PAUSE**, SELECT resumes immediately, while either UP or DOWN converts it directly into a full manual pause—there is no fake resume/pause or double click. Hold SELECT to end and save; hold DOWN while recording for a manual lap. The icons are bundled bitmaps rendered from the project's SVGs (in `icons-svg/`), not drawn at runtime.

**The on-watch route card** is a vector sketch of your GPS track — north up, with a centre crosshair, an `N` marker and a distance-span label — not a street map. That's a hardware limit, not a missing feature: the watchapp has no network or image decoder of its own (map tiles are network-fetched PNGs), so real tiles only exist on the phone page. The card shows the genuinely useful part, the shape of where you went.

**The debrief actions menu:** by the time you see the debrief the run is already saved to your phone. UP and DOWN (▲ / ▼ icons) scroll the summary, and **SELECT (a ⋮ kebab) opens an actions menu**: **UP = Upload to your server**, **SELECT = Rename by voice** (a mic icon), **DOWN = Discard** (a trash icon). Both Upload and Discard are two-step — Upload raises a green **"Upload to server?"**, Discard a red **"Discard activity?"**, each confirmed with SELECT and cancelled with UP or BACK — so neither fires by accident. **Rename** records a short phrase with Pebble's dictation and renames the run on the spot. BACK leaves the menu (and, from plain scrolling, exits the debrief).

**In the launcher.** After every activity, RunLog updates its **app glance** — the line under the app's name in the watch launcher — to your most recent activity, e.g. `Hike · 12.43 km · 3:26:10` (it follows your unit setting and activity type). It's set from the phone with the finished, authoritative stats, clears itself if you delete all your activities, and refreshes when you re-type or rename the latest one. Purely informational — a glance at the launcher tells you how your last outing went without opening the app.

Every run is saved to your phone automatically the instant you stop — that copy always exists (it's what the phone page lists and what you can download as GPX). Sending it on to a **server** is a separate, deliberate step: pick Upload in the debrief menu and confirm, or use Upload/Retry per run on the phone page. Nothing reaches the server on its own, and there's no timer. Discard a run and nothing was ever sent; discard one mid-upload and the local copy still goes while the late server result is ignored.

**Wrong activity type?** Don't discard — re-file it: open the workout on the phone page and tap Run / Walk / Ride / Hike under the title. The name, export sport, splits (1 km vs 5 km) and cadence presentation all update to match. The underlying wrist samples are preserved, so re-typing a ride back to a foot activity restores its cadence. If it had already uploaded, hit Re-upload to refresh the server copy.

**After saving — the debrief:** a scrollable summary with the distance up top, your route on a card (green start, red finish), two mini graphs — **pace/speed** (faster = up, range labelled) and **heart rate** (min–max) — sampled across the activity by distance, then a stat grid and the upload/location status line. Route and graphs stream in from the phone a moment after the stats.

The debrief belongs to the workout that just finished, not the next app launch. Whenever you open RunLog normally, it starts on a clean **READY** recorder with zero time, distance and steps so there is no ambiguity about whether it is ready for a new activity. The completed workout remains safely available under the phone gear icon. This reset applies only after a completed workout; reopening during a genuinely RUNNING, PAUSED or SAVING session restores and reconciles that unfinished session instead of throwing it away.

**Buttons**

| Button | Action |
|---|---|
| SELECT | start / manual pause / resume; from auto-pause, resume |
| SELECT (hold) | finish + save |
| UP | settings while idle; previous workout page; from auto-pause, full manual pause |
| DOWN | switch activity while idle; next workout page; from auto-pause, full manual pause |
| DOWN (hold) | record a manual lap while running |
| BACK | exit (blocked mid-activity — finish first) |

### About satellite counts

The watch shows GPS **accuracy** but not a **satellite count**, and that's a hard platform limit: RunLog's GPS comes from your phone through PebbleKit JS, which exposes the W3C Geolocation API — position, altitude and accuracy only. Satellite counts live in the phone OS's low-level GNSS interfaces that PebbleKit JS can't reach. Accuracy is the more useful signal anyway (it's what the recording filter uses: fixes worse than 50 m are discarded).

## On the phone — the debrief page

Pebble app → RunLog → gear icon. Tap an activity for the full debrief: the route map described above, a **pinch-/double-tap-zoomable** street map of your route (CARTO tiles, OpenStreetMap fallback, drag to pan; the +/&minus; buttons still work), post-workout analysis, speed / elevation / heart-rate **charts** (lightly smoothed — see below), automatic splits plus **manual laps**, **Download**, **Upload now / Re-upload**, **Delete**. A route-less workout says **No GPS route**, omits map/speed/elevation claims, and plots available HR against time. The selected GPX/TCX/FIT format drives both Download and Upload. Route-less exports never invent `0,0` coordinates: GPX is metadata-only, TCX omits per-point position/distance and labels the required zero lap total as unavailable, and FIT uses the profile's invalid markers. GPX embeds heart rate and cadence via the Garmin TrackPointExtension; pauses become separate track segments. The phone app gives a configuration page only one reliable open call, so every retained route travels compactly in that first page as lossless binary deltas. Tapping a row expands only that route inside the same WebView—there is no close/reopen transition, and returning to the list releases its expanded copy. Maps, charts and exports still receive every recorded sample. If the map shows the route on a plain grid with a "tiles unavailable" note, your phone's web view is blocking remote images — everything else still works.

### Post-workout analysis

The base analysis added in version 1.29.0 runs only after recording stops, so it adds no live GPS, Health, Bluetooth or watch CPU work:

- **Time in five heart-rate zones** uses the max HR stored with that activity and weights each sample by time, rather than counting GPS points. The page also shows HR coverage so a patchy sensor trace cannot look more complete than it was.
- **Split consistency** reports variation across full splits. **Finish strength** compares equal-distance halves, not equal point counts, so sparse GPS sections do not bias the result.
- **Climb detection** works from the already-smoothed elevation track. A sustained climb must gain at least 10 m over 50 m and a 5 m descent closes it; this deliberately ignores little GPS-altitude ripples. The three largest detected climbs show gain, distance, moving time and average grade.
- **Stopped time and pause count** come from elapsed/active clocks and the saved lifecycle journal.
- **History context** compares pace and heart rate with the previous saved workout of the same type. Record badges are explicitly “best of saved activities,” not lifetime claims: they compare with the activities currently retained on this phone and update correctly after delete or re-type.

At the bottom of the page sits a **LOG** card: the last 40 events — GPS lock, saves, every upload attempt with its destination and HTTP status, FitTrackee logins and token refreshes — newest first, failures in red. It's the first place to look when something says "failed": RunLog now includes a destination's short JSON `detail`, `message` or `error` response, so an Endurain scope/key rejection is visible instead of being reduced to a status number. `login FAILED (HTTP 401)` means FitTrackee rejected the credentials — either a typo, **or the account was never activated**: fresh FitTrackee accounts stay inactive until the confirmation email is clicked, and home instances without a mail server never send one. Activate from the server with `ftcli users update <username> --activate` (prefix with `docker compose exec fittrackee` if containerised). The log records the account email, warns about leading/trailing password whitespace, and includes the server's error message, but it never records the password, authorization header, API key, or token. The password field has a Show/Hide toggle for a newly entered value; an existing saved secret is represented only by a “saved” indicator and is never placed in the page source. Settings travel back to the app as URL-safe base64, so emails with `+` and passwords containing `%`, `+`, spaces or unicode are preserved verbatim. `upload FAILED (HTTP 404)` usually means the URL is off, while `no network: request timed out` means the server did not answer in time and plain `no network` usually means the phone couldn't reach it at all — commonly a self-signed HTTPS certificate (the phone app's web stack rejects those; use a real cert or plain `http://` on your LAN) or being on the wrong Wi-Fi. The same lines stream to `pebble logs`.

### Chart smoothing

All plots — the phone's speed/elevation/HR charts and the watch's pace/HR mini graphs — run through a centred, gap-aware Gaussian-weighted moving average (`src/pkjs/smooth.js`, which `tools/build_page.js` injects verbatim into the phone page, so both run the same code). It never blends across pauses, leaves missing samples missing, and being centred it doesn't lag the data the way a trailing average would; a curve fit was rejected because polynomial/spline fits can overshoot and invent features that were never in the data. The kernel width adapts to recording density (`sg` in `series()` on the page, fixed `1.3` buckets for the watch graphs) — nudge those constants if you want it smoother or sharper.

### GPS smoothing

Raw GPS positions jitter, and summing the straight-line hops between jittery fixes systematically *over*-counts distance — worst at 1 Hz, where the noise compounds over hundreds of fixes. RunLog runs every accepted fix through a **constant-velocity Kalman filter** (`src/pkjs/kalman.js`) before it touches distance, track or splits. Measurement noise comes from each fix's reported accuracy (so confident fixes pull hard and fuzzy ones barely move the estimate), process noise from a plausible human acceleration (so a steady stride/pedal is tracked tightly while real turns and pace changes still come through), and velocity is seeded from the first step so there's no startup lag. In a realistic 1 Hz, ±2.5 m test the raw track overshot true distance by ~27 %; filtered, it's within ~1–2 %. Clean, well-spaced fixes are left essentially untouched. This is the right tool when GPS is the *only* signal — there's no onboard accelerometer or barometer exposed to fuse on this hardware — and it's deliberately the same algorithm production fitness apps use for the same problem. One subtlety: **auto-pause keys off raw GPS speed, not the filtered track**, because the filter's velocity inertia would lag a sudden stop and make pause/resume sluggish.

### VO₂max estimate

The phone estimates a running **VO₂max** after each run. It shows on the watch summary (a full-width row under the stat grid, runs only) and on the debrief page. It uses the standard submaximal field method that wrist devices use: the ACSM running equation gives the oxygen cost of each steady pace (`VO₂ = 0.2·speed + 3.5`, speed in m/min), the heart rate at that pace is turned into a fraction of capacity, and `VO₂ / fraction` is the implied VO₂max — taken as the median over qualifying points.

To be as accurate as the available signal allows, the estimate:
- **drops the first two minutes** of the run, where heart rate still lags the pace and would otherwise inflate the figure;
- counts **only metabolic steady state** — points mid-acceleration, where HR and pace are out of step, are skipped;
- uses the more accurate **heart-rate-reserve model** (`%VO₂R = %HRR`, Karvonen) when a resting HR is set, falling back to Swain's `%VO₂max = (%HRmax − 37)/0.64` otherwise;
- only counts steady aerobic running (pace 7.2–24 km/h, 65–100 % of max HR).

The max and resting HR in force when you record are stored *with* the activity, so changing them later affects future runs only — re-typing an old activity will not quietly rewrite the figure it was saved with. For best accuracy, set both heart-rate values in watch **Settings**: **Max heart rate** (ideally your true measured max, not a `220 − age` guess — a wrong max scales the number directly) and **Resting HR** (optional; turning it on switches to the more accurate reserve model). Both are synced to the phone; until max HR is set it defaults to 190.

**Why there's no hill correction:** the ACSM equation has a grade term, but applying it needs per-segment grade, and the Pebble exposes only GPS altitude (no barometric altimeter to watchapps). GPS vertical error is large enough that a grade term would add more noise than it removes, so the estimate is deliberately level-ground. That, plus the fact that it leans on a population HR–VO₂ relationship rather than your personal physiology and can't see cardiac drift or running economy, is why this is a fitness *trend* to watch over many runs, not a lab value. Running only; walks, rides, very easy runs, and runs without heart rate produce no figure.

### Cadence

Cadence comes from the watch's wrist step counter, and two things are worth knowing:

- **RunLog stores the wrist step rate and halves it on export.** Internally — and on the watch debrief's CADENCE cell — a typical run reads around 150-170, i.e. actual steps per minute. Every exporter then emits half that (~75-85), because all three target fields are per-foot *stride* rates by convention: TCX `RunCadence` and FIT `cadence` are defined that way, and `gpxtpx:cad` is read that way by the tools that matter. FitTrackee doubles it back, so ~80 displays as ~160 spm, which is correct. A tool that does *not* double would show roughly half — that's a disagreement between viewers rather than something RunLog can fix in the file.
- **Per-point cadence is a windowed rate.** Each point's cadence is the step rate over a short trailing window, not the gap between two step messages. The step counter updates coarsely and arrives over Bluetooth with timing jitter, so a single mistimed message used to fling individual points to roughly double or half the true rate (the running total and the average stayed correct throughout). The window removes those spikes without shifting the bulk value.

### Elevation

Elevation comes only from phone GPS (Pebble exposes no barometric altimeter to apps), so RunLog treats it cautiously:

- **Exported elevation is smoothed.** Raw GPS vertical noise would otherwise inflate the gain a downstream tool computes from the track — on a flat run it can read 100 m+ of phantom climb. RunLog stores a smoothed elevation on each point, so GPX/TCX/FIT and the page chart stay consistent with the gain it displays (which adds a further 3 m dead-band and is the most conservative figure).
- **Absolute values can look wrong, even negative.** The Geolocation API reports height above the WGS84 *ellipsoid*, not mean sea level; the two differ by the local geoid offset, which near Perth is about −30 m. That offset shifts every point equally, so it doesn't affect elevation *gain* — only the absolute numbers. Correcting it would need an on-device geoid model, which isn't practical, so the raw ellipsoidal height is kept.

## Activity name

Every saved activity is named from a template you control, set in **Default activity name** on the phone page. The default is `%Y-%m-%d_%H%M_{activity}` (e.g. `2026-06-25_0715_hike`), so two same-day activities do not collide. Date and time use the classic **strftime codes**: `%Y` / `%y` year, `%m` month, `%d` day, `%H` / `%I` hour (24 / 12), `%M` minute, `%S` second, `%p` AM/PM, `%a` / `%A` weekday, `%b` / `%B` month name, `%j` day-of-year, plus the usual shorthands `%F` (`YYYY-MM-DD`), `%T` (`HH:MM:SS`), `%R` (`HH:MM`) and `%D` (US `MM/DD/YY`); `%%` is a literal percent. On top of those are two named **extras** in braces: `{activity}` / `{Activity}` (run/walk/ride/hike) and `{part}` / `{Part}` (morning / afternoon / evening / night, by start time). (`{date}` and `{time}` are kept as back-compat aliases for `%Y-%m-%d` and `HH.MM`.) Anything else is kept verbatim, an unknown `%x` or `{x}` passes through untouched, and leaving the field blank falls back to the default. Re-typing an activity on the phone (Run ⇄ Walk ⇄ Ride ⇄ Hike) regenerates the name for the new type; the name also drives the GPX/TCX/FIT filename and the activity title sent to your server. You can also **rename an activity by voice on the watch**: open the debrief menu, pick Rename (the mic), and speak a name — it replaces the template-generated one for that activity.

## Uploading

In the page's **UPLOAD** card, pick a destination and fill in the credential, then save. Uploads are manual: press **Upload** on the watch debrief right after an activity, or **Upload now** on any activity in the list. The watch shows Uploading… / Uploaded / Upload failed live — failures include the reason right on the wrist, e.g. `Upload failed (401)` or `Upload failed (net)`.

**File formats.** Under **FILE FORMAT** on the phone page, choose how activities are exported and uploaded: **GPX** (universal, text — the default, and what every destination accepts), **TCX** (Garmin's XML — carries heart rate, cadence and per-point cumulative distance in one file), or **FIT** (Garmin's compact binary — the richest format and what Strava, Garmin Connect and intervals.icu prefer). The choice drives both the per-run **Download** button and what gets uploaded; the filename extension and `Content-Type` follow it. Two honest caveats: the destination has to accept the format you pick (FitTrackee, for example, expects GPX/TCX, not FIT), and FIT is *binary* — the phone-page download is rock solid, but a FIT *upload* relies on the phone JS runtime sending raw bytes over XHR, which varies by app version. If a FIT upload ever fails where GPX/TCX succeed, that's the reason, and the page download is the fallback. GPX and TCX uploads are plain text and always work.

### Self-hosted (recommended for a home server)

**FitTrackee** — https://docs.fittrackee.org — is the standout: a self-hosted, actively maintained "keep your outdoor activities on your own server" app with maps, stats and records, and RunLog has a built-in preset for it. Setup is just: pick **FitTrackee (self-hosted)** in the UPLOAD card and enter your instance URL, email and password. That's it — RunLog handles tokens itself: it logs in via `POST /api/auth/login`, caches the `auth_token`, uploads with it, and whenever the server answers 401 (FitTrackee tokens expire) it transparently logs in again and retries. No curl, no re-pasting, fully set-and-forget.

Activities upload to `POST /api/workouts` with the right sport attached automatically (Run → Running, Walk → Walking, Ride → Cycling (Sport), Hike → Hiking, using FitTrackee's default sport ids 5/6/1/3 — if your instance's ids differ, check `GET /api/sports`). Two notes: your credentials are stored in the Pebble app's storage on your phone in plain text, same trust level as the session token they replace — fine for a personal phone and a home server, but know that it's there. And a token pasted in an older RunLog version keeps working as a fallback until it expires; credentials simply take over from then on.

**Endurain** — https://docs.endurain.com — has a first-class preset. Enter the instance root URL and create an API key in **Settings → Security → API Keys** with only the `activities:upload` scope. RunLog posts the selected GPX, TCX or FIT file to the official `/api/v1/activities/create/upload` endpoint as multipart data, with the key in `X-API-Key`; it does not store your Endurain account password or request broader read/write access. The URL field also accepts a pasted `/api/v1`, upload-endpoint or API-docs URL and preserves a reverse-proxy subpath. Text files are sent as explicit UTF-8 bytes (avoiding phone-runtime string encoding differences), and Endurain gets 90 seconds to parse and store a long file before RunLog times out. See Endurain's [authentication documentation](https://docs.endurain.com/developer-guide/authentication/) for the endpoint and scope.

**Nextcloud / any WebDAV** — already built in: pick the WebDAV preset, point it at e.g. `https://cloud.example.com/remote.php/dav/files/YOU/Runs/`, and use an app password (`user:app-password` in the auth field — RunLog Base64s it for you). Every activity appears as a dated `.gpx` in that folder.

**Your own webhook** — the Custom preset POSTs the raw file to any URL, with the `Content-Type` and the `X-Filename` extension matching your chosen format (GPX/TCX are text; FIT is binary). A complete receiver that drops files in a folder (pair it with cron to forward anywhere — including refreshing FitTrackee tokens server-side):

```python
# python3 receiver.py  → saves every POSTed activity into ./runs/
from http.server import BaseHTTPRequestHandler, HTTPServer
import os, re
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        os.makedirs('runs', exist_ok=True)
        name = re.sub(r'[^\w.\-]', '_', self.headers.get('X-Filename', 'run.gpx'))
        with open(f'runs/{name}', 'wb') as f:
            f.write(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(201); self.end_headers()
HTTPServer(('', 8080), H).serve_forever()
```

Also worth a look if you're shopping around the self-hosted space: **Dawarich** is self-hosted location history that can ingest GPX — useful if you want runs feeding a personal Google-Timeline replacement. It can be fed from the webhook receiver above.

### Hosted options

**intervals.icu** (API key from Settings → Developer Settings) and **Runalyze** (personal token, `activity_push` scope) presets remain for anyone who wants them. **Strava** has no preset because its API only issues OAuth tokens that expire every 6 hours — there's no pasteable permanent key; the practical route is downloading the GPX and sharing it to the Strava app.

## Files

```
runlog/
├── package.json            manifest (41 message keys, platforms, capabilities)
├── wscript                 standard Pebble build script
├── src/
│   ├── c/runlog.h          shared types (settings, modes, stats, graph buffers)
│   ├── c/main.c            run screen, comms, mode switch, GPS accuracy
│   ├── c/format.c          shared formatting (duration, distance, pace, speed)
│   ├── c/settings.c        UP-button settings menu
│   └── c/summary.c         post-run debrief (route card, graphs, stat grid)
│   └── pkjs/index.js       phone side: GPS, Kalman smoothing, auto-pause, splits, graphs, uploads
│   └── pkjs/gpx.js         GPX builder used for uploads
│   └── pkjs/tcx.js         TCX builder used for uploads
│   └── pkjs/fit.js         FIT binary builder used for uploads
│   └── pkjs/kalman.js      constant-velocity GPS Kalman filter
│   └── pkjs/smooth.js      centred Gaussian chart smoother
│   └── pkjs/page.js        GENERATED from tools/page.html — don't edit
└── tools/
    ├── page.html           the debrief/settings page (edit this one)
    ├── build_page.js       embeds page.html into src/pkjs/page.js, injecting
    │                       gpx/tcx/fit/smooth so the page and the uploader run
    │                       identical code (also require()d by the page tests)
    ├── test_pipeline.js    full phone-side simulation tests (33 scenarios)
    ├── test_formats.js     GPX/TCX/FIT format tests
    └── test_export.js      page rendering/map/export/action tests
```

## Building

You need the Pebble SDK from Core Devices (https://developer.repebble.com/sdk). `pebble-tool` currently needs Python ≤ 3.13:

```bash
uv tool install pebble-tool --python 3.12 --force
pebble sdk install latest
```

Then, from this folder:

```bash
node tools/build_page.js     # after editing page.html or shared gpx/tcx/fit/smooth code
pebble sdk install latest    # RunLog 2.0 is verified with the current 4.17 channel
pebble build
pebble install --phone <phone IP>   # Developer Connection in the phone app
```

`src/pkjs/page.js` in this archive is already current, so `pebble build` alone works until you touch `page.html` or one of the injected shared modules. The page tests fail if that generated file is stale. The full host test suite needs a C compiler and Node, but no Pebble SDK:

```bash
tools/test.sh
```

## Notes & troubleshooting

- **Battery:** GPS is by far the biggest phone cost, so RunLog releases it as soon as an activity is saved. An idle READY warm-up still auto-releases after 5 minutes. While moving, every mode keeps the same high-accuracy GPS acquisition, Kalman filter, outlier gate and accepted route points—power savings never come from thinning the saved track. Run, Walk and Ride retain 5-second live-stat/health updates, 10-second unchanged-health keepalives and normal accuracy reporting from start to finish, however long the workout lasts. Hike uses a fixed profile selected from the start: 15-second live-stat/health updates and 30-second optical-HR requests/keepalives. No mode silently changes quality based on elapsed time. Active HR now consumes firmware `HealthEventHeartRateUpdate` events, so RunLog does not repeatedly read the same cached optical sample; if the event subscription cannot allocate, the exact fixed cadence remains as a polling fallback, and PAUSED unsubscribes. A manual pause in **any** mode keeps GPS warm for one minute, then releases it for a long break and reacquires it on resume; auto-pause keeps GPS active because movement is what triggers automatic resume. Paused fixes skip route-filter work, GPS status and live stats produced by one fix share one Bluetooth packet, and unused live summary fields are deferred until save. ConnectionService stops all AppMessage attempts while the phone is absent, wakes reconciliation on the connection edge, and backs a connected-but-unresponsive phone off from 1.4 seconds to a 30-second ceiling. Deadline-driven GPS/liveness timers replace fixed polling wakeups; full checkpoints no longer cause a duplicate liveness write; unchanged watch persistence values are not rewritten; and the HR/GPS chrome redraws only when the visible colour zone changes. Only RUNNING uses one-second watch ticks.
- **Storage:** the phone keeps up to the last 12 activities within a conservative storage cap. Version 1.29.0 replaces the monolithic full-history JSON value with a small metadata index plus immutable, delta-encoded route chunks. Each chunk has a corruption checksum; chunks are written and verified before the index commit, old chunks are removed only after that commit, and uncommitted orphans are cleaned on the next launch. Existing activities migrate automatically with the same ordering. Rename, upload-state and re-type edits no longer rewrite every GPS point. If one chunk is damaged, the detail page salvages every valid chunk, inserts a route break across the gap and says exactly how many points survived. If the index itself cannot be parsed, implicit saves remain blocked and its raw value is retained instead of overwriting the only copy. For the phone UI, all retained routes are repacked into compact binary streams in the single initial configuration page; only the selected stream is expanded, and its in-memory points are released on return to the list.
- **No-GPS sessions:** a meaningful treadmill workout or phone outage is stored from the watch's acknowledged sensor journal: active/elapsed time, HR, peak HR, net steps, pauses and manual laps survive. It is explicitly marked route-less, with distance/pace/ascent unavailable. The page does not draw a map, and GPX/TCX/FIT omit position rather than inventing coordinates. An immediate empty start/stop is still **NOT SAVED**.
- **Crash recovery and reconnects:** watch and phone exchange protocol-v3 session ids, monotonic command sequences, acknowledgements, and authoritative snapshots. State-changing commands are idempotent; a restarted side reconciles to the existing session. While running, the watch keeps compact 30-second sensor records (60 seconds for Hike) and removes them only after the phone has durably chunked and acknowledged them, giving roughly 8.5/17 hours of disconnected RAM journal respectively. GPS remains the only source of route and distance. In-progress phone GPS points are independently chunked, while start/pause/auto-pause/resume/lap/restart/stop events are journalled. Checkpoint age alone never finalizes a potentially live workout, and any unavoidable watch-process loss is marked as a data-quality gap rather than silently filled.
- **Logs:** `pebble logs --phone <IP>` shows the phone-side JS console — first stop if anything misbehaves. On every launch RunLog logs one line when GPS locks (`RunLog: GPS ok, accuracy N m`) and warns if it has to work around a broken fix timestamp.
- **Pace fixed in 1.3.1:** all pace, moving-time and GPX timing maths used to trust the `timestamp` field on geolocation fixes. Some phone apps report it missing, zero or in the wrong unit, which left distance working but pace stuck on `--:--` and the pace graph empty. RunLog now validates the timestamp and falls back to the wall clock, so pace works regardless; the first live reading also appears a few seconds sooner (~15 s into a run).
- **Units** affect display and split boundaries only; storage, the wire protocol and GPX stay metric.
- **Old configs** from earlier RunLog versions migrate automatically (a stored PUT setup becomes the WebDAV preset).

## Privacy & data

RunLog is built to keep your data local by default.

- **On the phone**, activities live in the Pebble app's private storage for RunLog (up to the last 12 within the storage cap). GPS positions, HR and steps never leave the phone unless *you* press Upload to a destination *you* configured.
- **The one network request you don't explicitly trigger** is map tiles: opening a run's detail on the phone page fetches street-map tiles for that route's area from OpenStreetMap and CARTO, which necessarily reveals the route's rough location to those tile servers. Everything else on the page is self-contained; if your phone's web view blocks remote images the map falls back to a plain grid and nothing else changes.
- **Uploads** go only to the server you set, using the credentials you enter. Prefer an **HTTPS** destination — RunLog warns in the log if you point it at a plain-`http://` server with credentials, because both the credentials and the activity file would then cross the network unencrypted. Credentials are stored in the app's local config, but are neither written to the diagnostic log nor injected into the configuration page/data URL; the page gets only “saved secret present” flags and blank means “keep unchanged.”
- **Nothing is sent to the author or any third party.** There is no analytics, no telemetry, no account.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for the per-version history. The current release is **2.0.0**: three live pages, atomic manual/auto-pause controls, manual laps, optional targets, protocol-v3 route-less recovery, event-driven HR/link handling and current Emery zone-tinted backlight support. It is built and verified with the official latest SDK channel (SDK 4.17 / GCC 14 toolchain) while retaining native Basalt, Diorite and Emery packages. Recording quality never degrades with workout duration. The watch and phone protocol both changed, so **reinstall the complete PBW** after updating.

## License

MIT — see [`LICENSE`](LICENSE). RunLog is an independent project and is not affiliated with or endorsed by Pebble, Core Devices, or Anthropic.
