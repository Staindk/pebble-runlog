# RunLog — run / walk / ride tracker for Pebble

A workout tracker for the Pebble Time 2 (also builds for Pebble 2 and Pebble Time). The watch shows live stats and reads the on-board heart-rate sensor; your phone records GPS, computes everything, and can export each activity as GPX, TCX or FIT — including straight to your own home server, whenever you choose.

## Where your activities live

This trips everyone up once, so up front: when the watch says **SAVED**, the activity has been stored **on your phone**, inside the Pebble app's storage for RunLog (the last 4 activities are kept). There's no file in your Downloads yet and nothing on the watch itself — the watch only holds the debrief screen you're looking at, and its footer now says so: *"On phone: gear icon"*.

To see your activities: open the **Pebble phone app → RunLog → gear/settings icon**. That opens the full debrief — map, charts, splits — for every saved activity. From there you can get a *tangible* copy two ways:

- **Download .gpx** on any activity saves a file to your phone (share it anywhere), or
- set up an **upload destination** and send any activity to a server of your choosing with one button — from the watch debrief, or per-run on the phone page (see *Uploading* below). Uploads are fully manual now: nothing leaves your phone until you press Upload.

RunLog also asks the phone to pop the debrief open automatically right after each save, but most versions of the Pebble app only honour that from the gear icon, so don't be surprised if the gear is the only way in.

## Activity modes — Run / Walk / Ride

Press **DOWN** on the main screen to cycle between RUN, WALK and RIDE (only while idle — mid-activity it flashes MODE LOCKED). The current mode sits top-left next to the GPS accuracy, e.g. `RIDE ±8m`, and there's also an **Activity** item in the settings menu. The mode is locked in when you press start, and changes:

Ride mode also drops the step/cadence readouts everywhere (meaningless on a bike): the watch debrief shows **max speed** and **elapsed time** in their place, and the phone detail view does the same.

| | Run | Walk | Ride |
|---|---|---|---|
| Auto-pause below / resume above | 0.7 / 1.4 m/s | 0.45 / 0.9 m/s | 1.0 / 2.2 m/s |
| Split alerts every | 1 km/mi | 1 km/mi | **5** km/mi |
| Live metric | pace /km | pace /km | **speed km/h** (or mph) |
| Debrief | avg pace, cadence | avg pace, cadence | **avg + max speed**, no cadence |
| GPX `<type>` / name | running / "Run …" | walking / "Walk …" | cycling / "Ride …" |

The thresholds matter: a gentle walk would constantly false-trigger run auto-pause, and a bike coasting up to lights at 0.9 m/s should pause where a runner shouldn't. Ride mode drops wrist cadence (meaningless on handlebars) and announces splits as cumulative distance ("KM 5", "KM 10"). Export destinations pick this up too — FitTrackee files the activity under the right sport automatically.

## On the watch

**While recording:** a large elapsed timer in the LECO face used across the watch, then distance, rolling pace (or speed), heart rate and step count in a four-cell grid — all in matching LECO digits, sized to read at a glance without shouting. The current **time of day** sits top-right; the GPS fix readout (accuracy, e.g. `±8m`) sits top-left by the fix dot (green = good fix ≤ 20 m, orange = weak, red = none). Split alerts vibrate, light the backlight and flash `KM 3` / `MI 3` on a small line under the timer; auto-pause shows **AUTO-PAUSE** there and stops the timer, resuming itself when you move.

**Is it recording?** The timer's colour tells you instantly: **black while it's timing**, **red when paused** (including auto-pause), and grey when idle or saving — no squinting at a label.

**Heart rate readability:** the HR number is now always drawn in solid black, with the training zone shown as a small coloured bar beneath it (zones are 60/70/80/90 % of your configurable max HR). Previously the digits themselves were tinted, which made the yellow zone nearly unreadable on the white screen; moving the colour to an outlined bar keeps the number crisp while still showing the zone at a glance.

**The button bar:** a slim strip down the right edge shows, as small icons, what the three side buttons do right now. Idle, it's a **gear** (UP → settings), a **play triangle** (SELECT → start) and the **activity icon** (DOWN → cycle Run/Walk/Ride: a runner, a walker or a bicycle). Recording, SELECT becomes a **pause** glyph (hold SELECT to end and save) and returns to the **play triangle** when paused. UP and DOWN are blank mid-activity — settings and mode lock once you start. The icons are bundled bitmaps rendered from the project's SVGs (in `icons-svg/`), not drawn at runtime.

**The on-watch route card** is a vector sketch of your GPS track — north up, with a centre crosshair, an `N` marker and a distance-span label — not a street map. That's a hardware limit, not a missing feature: the watchapp has no network or image decoder of its own (map tiles are network-fetched PNGs), so real tiles only exist on the phone page. The card shows the genuinely useful part, the shape of where you went.

**The debrief actions menu:** by the time you see the debrief the run is already saved to your phone. UP and DOWN (▲ / ▼ icons) scroll the summary, and **SELECT (a ⋮ kebab) opens an actions menu**: **UP = Upload to your server**, **SELECT = Rename by voice** (a mic icon), **DOWN = Discard** (a trash icon). Both Upload and Discard are two-step — Upload raises a green **"Upload to server?"**, Discard a red **"Discard this run?"**, each confirmed with SELECT and cancelled with UP or BACK — so neither fires by accident. **Rename** records a short phrase with Pebble's dictation and renames the run on the spot. BACK leaves the menu (and, from plain scrolling, exits the debrief).

**In the launcher.** After every run, RunLog updates its **app glance** — the line under the app's name in the watch launcher — to your most recent activity, e.g. `Run · 5.23 km · 26:10` (it follows your unit setting, and shows Walk/Ride to match). It's set from the phone with the finished, authoritative stats, clears itself if you delete all your runs, and refreshes when you re-type or rename the latest one. Purely informational — a glance at the launcher tells you how your last outing went without opening the app.

Every run is saved to your phone automatically the instant you stop — that copy always exists (it's what the phone page lists and what you can download as GPX). Sending it on to a **server** is a separate, deliberate step: pick Upload in the debrief menu and confirm, or use Upload/Retry per run on the phone page. Nothing reaches the server on its own, and there's no timer. Discard a run and nothing was ever sent; discard one mid-upload and the local copy still goes while the late server result is ignored.

**Wrong activity type?** Don't discard — re-file it: open the workout on the phone page and tap Run / Walk / Ride under the title. The name, GPX `<type>`, splits (1 km vs 5 km) and cadence all update to match. If it had already uploaded, hit Re-upload to refresh the server copy.

**After saving — the debrief:** a scrollable summary with the distance up top, your route on a card (green start, red finish), two mini graphs — **pace/speed** (faster = up, range labelled) and **heart rate** (min–max) — sampled across the activity by distance, then a stat grid and the upload/location status line. Route and graphs stream in from the phone a moment after the stats.

**Buttons**

| Button | Action |
|---|---|
| SELECT | start / pause / resume |
| SELECT (hold) | finish + save |
| UP | settings (activity, units, auto-pause, splits, max HR, export) |
| DOWN | switch Run / Walk / Ride (while idle) |
| BACK | exit (blocked mid-activity — finish first) |

### About satellite counts

The watch shows GPS **accuracy** but not a **satellite count**, and that's a hard platform limit: RunLog's GPS comes from your phone through PebbleKit JS, which exposes the W3C Geolocation API — position, altitude and accuracy only. Satellite counts live in the phone OS's low-level GNSS interfaces that PebbleKit JS can't reach. Accuracy is the more useful signal anyway (it's what the recording filter uses: fixes worse than 50 m are discarded).

## On the phone — the debrief page

Pebble app → RunLog → gear icon. Tap an activity for the full debrief: the route map described above, a **pinch-/double-tap-zoomable** street map of your route (CARTO tiles, OpenStreetMap fallback, drag to pan; the +/&minus; buttons still work), speed / elevation / heart-rate **charts** (lightly smoothed — see below), **splits** with the best highlighted (5-km splits and speeds for rides), **Download .gpx**, **Upload now / Re-upload**, **Delete**. The GPX embeds heart rate and cadence via the Garmin TrackPointExtension; pauses become separate track segments. If the map shows the route on a plain grid with a "tiles unavailable" note, your phone's web view is blocking remote images — everything else still works.

At the bottom of the page sits a **LOG** card: the last 40 events — GPS lock, saves, every upload attempt with its destination and HTTP status, FitTrackee logins and token refreshes — newest first, failures in red. It's the first place to look when something says "failed": `login FAILED (HTTP 401)` means FitTrackee rejected the credentials — either a typo, **or the account was never activated**: fresh FitTrackee accounts stay inactive until the confirmation email is clicked, and home instances without a mail server never send one. Activate from the server with `ftcli users update <username> --activate` (prefix with `docker compose exec fittrackee` if containerised). The log prints the exact email, the password's first and last characters plus its *length* on every login, and quotes the server's own error message verbatim — so keyboard mischief (auto-capitalised email, a sneaky trailing space) and server-side reasons are both visible at a glance. The password field has a Show/Hide toggle for double-checking. Since 1.4.3 the settings travel from the page to the app as URL-safe base64, so emails with `+` and passwords containing `%`, `+`, spaces or unicode can no longer be mangled by the phone app's fragment decoding (the historic cause of "curl works, watch doesn't" 401s); `upload FAILED (HTTP 404)` usually means the URL is off (use the instance root, no `/api`), and `no network` means the phone couldn't reach the server at all — commonly a self-signed HTTPS certificate (the phone app's web stack rejects those; use a real cert or plain `http://` on your LAN) or being on the wrong Wi-Fi. The same lines stream to `pebble logs`.

### Chart smoothing

All plots — the phone's speed/elevation/HR charts and the watch's pace/HR mini graphs — run through a centred, gap-aware Gaussian-weighted moving average (`src/pkjs/smooth.js`, with a copy inside `tools/page.html`). It never blends across pauses, leaves missing samples missing, and being centred it doesn't lag the data the way a trailing average would; a curve fit was rejected because polynomial/spline fits can overshoot and invent features that were never in the data. The kernel width adapts to recording density (`sg` in `series()` on the page, fixed `1.3` buckets for the watch graphs) — nudge those constants if you want it smoother or sharper.

### GPS smoothing

Raw GPS positions jitter, and summing the straight-line hops between jittery fixes systematically *over*-counts distance — worst at 1 Hz, where the noise compounds over hundreds of fixes. RunLog runs every accepted fix through a **constant-velocity Kalman filter** (`src/pkjs/kalman.js`) before it touches distance, track or splits. Measurement noise comes from each fix's reported accuracy (so confident fixes pull hard and fuzzy ones barely move the estimate), process noise from a plausible human acceleration (so a steady stride/pedal is tracked tightly while real turns and pace changes still come through), and velocity is seeded from the first step so there's no startup lag. In a realistic 1 Hz, ±2.5 m test the raw track overshot true distance by ~27 %; filtered, it's within ~1–2 %. Clean, well-spaced fixes are left essentially untouched. This is the right tool when GPS is the *only* signal — there's no onboard accelerometer or barometer exposed to fuse on this hardware — and it's deliberately the same algorithm production fitness apps use for the same problem. One subtlety: **auto-pause keys off raw GPS speed, not the filtered track**, because the filter's velocity inertia would lag a sudden stop and make pause/resume sluggish.

### VO₂max estimate

The phone estimates a running **VO₂max** after each run. It shows on the watch summary (a full-width row under the stat grid, runs only) and on the debrief page. It uses the standard submaximal field method that wrist devices use: the ACSM running equation gives the oxygen cost of each steady pace (`VO₂ = 0.2·speed + 3.5`, speed in m/min), the heart rate at that pace is turned into a fraction of capacity, and `VO₂ / fraction` is the implied VO₂max — taken as the median over qualifying points.

To be as accurate as the available signal allows, the estimate:
- **drops the first two minutes** of the run, where heart rate still lags the pace and would otherwise inflate the figure;
- counts **only metabolic steady state** — points mid-acceleration, where HR and pace are out of step, are skipped;
- uses the more accurate **heart-rate-reserve model** (`%VO₂R = %HRR`, Karvonen) when a resting HR is set, falling back to Swain's `%VO₂max = (%HRmax − 37)/0.64` otherwise;
- only counts steady aerobic running (pace 7.2–24 km/h, 65–100 % of max HR).

For best accuracy, set both heart-rate values in watch **Settings**: **Max heart rate** (ideally your true measured max, not a `220 − age` guess — a wrong max scales the number directly) and **Resting HR** (optional; turning it on switches to the more accurate reserve model). Both are synced to the phone; until max HR is set it defaults to 190.

**Why there's no hill correction:** the ACSM equation has a grade term, but applying it needs per-segment grade, and the Pebble exposes only GPS altitude (no barometric altimeter to watchapps). GPS vertical error is large enough that a grade term would add more noise than it removes, so the estimate is deliberately level-ground. That, plus the fact that it leans on a population HR–VO₂ relationship rather than your personal physiology and can't see cardiac drift or running economy, is why this is a fitness *trend* to watch over many runs, not a lab value. Running only; walks, rides, very easy runs, and runs without heart rate produce no figure.

### Cadence

Cadence comes from the watch's wrist step counter, and two things are worth knowing:

- **The displayed number is doubled by the viewer.** RunLog records a per-foot-rate value (around 75-85 for a typical run). The GPX `gpxtpx:cad` field isn't standardised for running — some tools read it as steps-per-minute, others as a per-foot rate they double. FitTrackee doubles it, so ~80 shows as ~160 spm, which is correct; a tool that doesn't double would show roughly half. RunLog leaves the value as recorded rather than guess a convention.
- **Per-point cadence is a windowed rate.** Each point's cadence is the step rate over a short trailing window, not the gap between two step messages. The step counter updates coarsely and arrives over Bluetooth with timing jitter, so a single mistimed message used to fling individual points to roughly double or half the true rate (the running total and the average stayed correct throughout). The window removes those spikes without shifting the bulk value.

### Elevation

Elevation comes only from phone GPS (Pebble exposes no barometric altimeter to apps), so RunLog treats it cautiously:

- **Exported elevation is smoothed.** Raw GPS vertical noise would otherwise inflate the gain a downstream tool computes from the track — on a flat run it can read 100 m+ of phantom climb. RunLog stores a smoothed elevation on each point, so GPX/TCX/FIT and the page chart stay consistent with the gain it displays (which adds a further 3 m dead-band and is the most conservative figure).
- **Absolute values can look wrong, even negative.** The Geolocation API reports height above the WGS84 *ellipsoid*, not mean sea level; the two differ by the local geoid offset, which near Perth is about −30 m. That offset shifts every point equally, so it doesn't affect elevation *gain* — only the absolute numbers. Correcting it would need an on-device geoid model, which isn't practical, so the raw ellipsoidal height is kept.

## Run name

Every saved activity is named from a template you control, set in **Default run name** on the phone page. The default is `%Y-%m-%d_{activity}` (e.g. `2026-06-25_run`). Date and time use the classic **strftime codes**: `%Y` / `%y` year, `%m` month, `%d` day, `%H` / `%I` hour (24 / 12), `%M` minute, `%S` second, `%p` AM/PM, `%a` / `%A` weekday, `%b` / `%B` month name, `%j` day-of-year, plus the usual shorthands `%F` (`YYYY-MM-DD`), `%T` (`HH:MM:SS`), `%R` (`HH:MM`) and `%D` (US `MM/DD/YY`); `%%` is a literal percent. On top of those are two named **extras** in braces: `{activity}` / `{Activity}` (run/walk/ride) and `{part}` / `{Part}` (morning / afternoon / evening / night, by start time). (`{date}` and `{time}` are kept as back-compat aliases for `%Y-%m-%d` and `HH.MM`.) Anything else is kept verbatim, an unknown `%x` or `{x}` passes through untouched, and leaving the field blank falls back to the default. Re-typing an activity on the phone (Run ⇄ Walk ⇄ Ride) regenerates the name for the new type; the name also drives the GPX/TCX/FIT filename and the activity title sent to your server. You can also **rename a run by voice on the watch**: open the debrief menu, pick Rename (the mic), and speak a name — it replaces the template-generated one for that run.

## Uploading

In the page's **UPLOAD** card, pick a destination and fill in the credential, then save. Uploads are manual: press **Upload** on the watch debrief right after a run, or **Upload now** on any activity in the list. The watch shows Uploading… / Uploaded / Upload failed live — failures include the reason right on the wrist, e.g. `Upload failed (401)` or `Upload failed (net)`.

**File formats.** Under **FILE FORMAT** on the phone page, choose how activities are exported and uploaded: **GPX** (universal, text — the default, and what every destination accepts), **TCX** (Garmin's XML — carries heart rate, cadence and per-point cumulative distance in one file), or **FIT** (Garmin's compact binary — the richest format and what Strava, Garmin Connect and intervals.icu prefer). The choice drives both the per-run **Download** button and what gets uploaded; the filename extension and `Content-Type` follow it. Two honest caveats: the destination has to accept the format you pick (FitTrackee, for example, expects GPX/TCX, not FIT), and FIT is *binary* — the phone-page download is rock solid, but a FIT *upload* relies on the phone JS runtime sending raw bytes over XHR, which varies by app version. If a FIT upload ever fails where GPX/TCX succeed, that's the reason, and the page download is the fallback. GPX and TCX uploads are plain text and always work.

### Self-hosted (recommended for a home server)

**FitTrackee** — https://docs.fittrackee.org — is the standout: a self-hosted, actively maintained "keep your outdoor activities on your own server" app with maps, stats and records, and RunLog has a built-in preset for it. Setup is just: pick **FitTrackee (self-hosted)** in the UPLOAD card and enter your instance URL, email and password. That's it — RunLog handles tokens itself: it logs in via `POST /api/auth/login`, caches the `auth_token`, uploads with it, and whenever the server answers 401 (FitTrackee tokens expire) it transparently logs in again and retries. No curl, no re-pasting, fully set-and-forget.

Activities upload to `POST /api/workouts` with the right sport attached automatically (Run → Running, Walk → Walking, Ride → Cycling (Sport), using FitTrackee's default sport ids 5/6/1 — if your instance's ids differ, check `GET /api/sports`). Two notes: your credentials are stored in the Pebble app's storage on your phone in plain text, same trust level as the session token they replace — fine for a personal phone and a home server, but know that it's there. And a token pasted in an older RunLog version keeps working as a fallback until it expires; credentials simply take over from then on.

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

Also worth a look if you're shopping around the self-hosted space: **Endurain** (a newer self-hosted fitness dashboard in the same spirit as FitTrackee) and **Dawarich** (self-hosted location history that can ingest GPX — fun if you want runs feeding a personal Google-Timeline replacement). Both could be fed from the webhook receiver above; I haven't wired presets for them, so check their current import APIs before committing.

### Hosted options

**intervals.icu** (API key from Settings → Developer Settings) and **Runalyze** (personal token, `activity_push` scope) presets remain for anyone who wants them. **Strava** has no preset because its API only issues OAuth tokens that expire every 6 hours — there's no pasteable permanent key; the practical route is downloading the GPX and sharing it to the Strava app.

## Files

```
runlog/
├── package.json            manifest (23 message keys, platforms, capabilities)
├── wscript                 standard Pebble build script
├── src/
│   ├── c/runlog.h          shared types (settings, modes, stats, graph buffers)
│   ├── c/main.c            run screen, comms, mode switch, GPS accuracy
│   ├── c/format.c          shared formatting (duration, distance, pace, speed)
│   ├── c/settings.c        UP-button settings menu
│   └── c/summary.c         post-run debrief (route card, graphs, stat grid)
│   └── pkjs/index.js       phone side: GPS, Kalman smoothing, auto-pause, splits, graphs, uploads
│   └── pkjs/gpx.js         GPX builder used for uploads
│   └── pkjs/kalman.js      constant-velocity GPS Kalman filter
│   └── pkjs/smooth.js      centred Gaussian chart smoother
│   └── pkjs/page.js        GENERATED from tools/page.html — don't edit
└── tools/
    ├── page.html           the debrief/settings page (edit this one)
    ├── build_page.js       embeds page.html into src/pkjs/page.js
    ├── test_pipeline.js    full phone-side simulation tests (4 scenarios)
    └── test_export.js      page rendering/map/GPX/action tests
```

## Building

You need the Pebble SDK from Core Devices (https://developer.repebble.com/sdk). `pebble-tool` currently needs Python ≤ 3.13:

```bash
uv tool install pebble-tool --python 3.12 --force
pebble sdk install latest
```

Then, from this folder:

```bash
node tools/build_page.js     # only needed after editing tools/page.html
pebble build
pebble install --phone <phone IP>   # Developer Connection in the phone app
```

`src/pkjs/page.js` in this archive is already current, so `pebble build` alone works until you touch `page.html`. Tests run with plain Node, no SDK:

```bash
node tools/test_pipeline.js && node tools/test_export.js
```

## Notes & troubleshooting

- **Battery:** GPS is by far the biggest cost, all of it on the phone. RunLog runs high-accuracy GPS only while a run is *active* — it's acquired on start and released the instant you save (`startGeo`/`stopGeo`), and the phone has no background timers running otherwise. The watch is tuned to spend cycles only where they buy something: the optical HR sensor samples every second while recording (and returns to the OS default afterwards), and rather than waste those readings the watch keeps a running mean of the last `HR_AVG_N` (5) of them — peeked from the per-second timer it's already awake for, so at no extra wakeup — and pushes that *smoothed* value plus steps to the phone every `SAMPLE_PERIOD_S` (5 s) rather than per fix. The seconds timer itself drops to once-a-minute on the READY screen and the debrief (only a running activity counts seconds), the wall clock is recomputed only when the minute actually changes rather than 60×/minute, and the step-count DB read happens at the 5 s push cadence rather than every second. Stats sent to the watch go through a coalescing queue, so a slow Bluetooth link self-limits instead of piling up. **One deliberate tradeoff:** GPS is warmed up the moment the app opens (in the `ready` handler), so pressing start gives you an immediate fix — at the cost of draining while you sit on the READY screen. If you'd rather save that power and accept a few seconds' wait for first lock after pressing start, move the `startGeo()` call out of the `ready` handler and into `startRun()`.
- **Storage:** the phone keeps the last 4 activities. The debrief page ships as a self-contained `data:` URI, so with very long activities it gets large; if it ever refuses to open, delete an old activity.
- **No-GPS sessions** (treadmill): the watch still shows time/steps/HR in the debrief, but nothing is stored on the phone — there's no track to keep.
- **Crash recovery:** if the phone app dies mid-activity, the partial recording is recovered (named `… (recovered)`) on the next start and kept for you to upload when you like.
- **Logs:** `pebble logs --phone <IP>` shows the phone-side JS console — first stop if anything misbehaves. On every launch RunLog logs one line when GPS locks (`RunLog: GPS ok, accuracy N m`) and warns if it has to work around a broken fix timestamp.
- **Pace fixed in 1.3.1:** all pace, moving-time and GPX timing maths used to trust the `timestamp` field on geolocation fixes. Some phone apps report it missing, zero or in the wrong unit, which left distance working but pace stuck on `--:--` and the pace graph empty. RunLog now validates the timestamp and falls back to the wall clock, so pace works regardless; the first live reading also appears a few seconds sooner (~15 s into a run).
- **Units** affect display and split boundaries only; storage, the wire protocol and GPX stay metric.
- **Old configs** from earlier RunLog versions migrate automatically (a stored PUT setup becomes the WebDAV preset).
