/*
 * RunLog v2 — phone side (PebbleKit JS, ES5)
 *
 * Runs inside the Pebble mobile app while the watchapp is open.
 *  - records GPS (navigator.geolocation), filters bad fixes
 *  - live accuracy readout, auto-pause, km/mi split alerts
 *  - merges HR + step samples from the watch (cadence from step deltas)
 *  - distance, rolling + average pace (always s/km on the wire),
 *    elevation gain with smoothing + hysteresis
 *  - on save: stats bundle + downsampled route shape to the watch,
 *    full run (points, splits) into localStorage
 *  - auto-export: GPX to intervals.icu / Runalyze (API token), any
 *    WebDAV server (Nextcloud etc.) or a custom webhook
 *  - the app's Settings page is the debrief UI: OSM map, charts,
 *    splits, GPX download, upload + storage management (tools/page.html)
 */

var gpx = require('./gpx');
var tcx = require('./tcx');
var fit = require('./fit');

/* Choose the export body/filename/content-type for the selected format. */
function exportRun(run, fmt) {
  fmt = (fmt === 'tcx' || fmt === 'fit') ? fmt : 'gpx';
  var base = run.name.replace(/[^\w.\-]+/g, '_');
  if (fmt === 'tcx') return { fname: base + '.tcx', contentType: 'application/vnd.garmin.tcx+xml', body: tcx.build(run), binary: false };
  if (fmt === 'fit') return { fname: base + '.fit', contentType: 'application/vnd.ant.fit', body: fit.build(run), binary: true };
  return { fname: base + '.gpx', contentType: 'application/gpx+xml', body: gpx.build(run), binary: false };
}
var ksmooth = require('./smooth');
var gps = require('./kalman');

/* Diagnostic log: last 40 events, shown in the page's LOG card and
 * mirrored to the developer console (`pebble logs`). */
function rlog(msg) {
  msg = String(msg).slice(0, 120);
  try {
    var L = JSON.parse(localStorage.getItem('runlog.log') || '[]');
    L.push([Math.round(Date.now() / 1000), msg]);
    if (L.length > 40) L = L.slice(L.length - 40);
    localStorage.setItem('runlog.log', JSON.stringify(L));
  } catch (e) {}
  console.log('RunLog: ' + msg);
}

function hostOf(u) {
  var m = /^https?:\/\/([^\/]+)/.exec(u || '');
  return m ? m[1] : (u || '?');
}
var PAGE = require('./page').TEMPLATE;

/* ------------------ Tunables ------------------ */
var C = {
  MAX_ACC_M: 50,        // ignore fixes with worse horizontal accuracy
  MIN_GAP_S: 3,         // min seconds between recorded points
  MIN_MOVE_M: 2,        // ignore jitter below this when nearly stationary
  PACE_WINDOW_S: 60,    // rolling pace window
  KEEP_RUNS: 4,         // finished runs kept on the phone
  MAX_STORE_CHARS: 2200000,
  HR_STALE_MS: 15000,   // drop HR readings older than this
  CAD_STALE_MS: 15000,
  CAD_WINDOW_MS: 15000, // per-point cadence = step rate over this trailing window (tames BLE/quantisation spikes)
  CAD_SAMPLE_MS: 5000,  // watch's deterministic step-send cadence; window span is snapped to a multiple of this
  AP_SLOW_N: 3,         // consecutive slow fixes before auto-pause
  AP_FAST_N: 2,         // consecutive fast fixes before auto-resume
  // auto-pause speed thresholds (m/s) per activity: [run, walk, ride]
  AP_SLOW: [0.7, 0.45, 1.0],
  AP_FAST: [1.4, 0.9, 2.2],
  SPLIT_MULT: [1, 1, 5],          // ride splits every 5 km / 5 mi
  ACT_NAME: ['Run', 'Walk', 'Ride'],
  NAME_TPL_DEFAULT: '%Y-%m-%d_%H%M_{activity}',   // includes time so same-day runs never share a filename
  MAX_SPEED: [12, 6, 30],         // m/s outlier gate per [run,walk,ride]: reject fixes implying impossible speed
  MOV_CAP_S: 20,                  // cap one inter-fix interval when accruing moving time (guard missed-pause gaps without over-trimming sparse fixes)
  IP_RESUME_MS: 1200000,          // on restart, resume an in-progress run if its checkpoint is younger than this; else recover+save
  GPS_IDLE_MS: 300000,            // release a warmed-up GPS receiver if no run starts within this long
  SEND_RETRY: 4,                  // re-send a failed *protected* AppMessage up to this many times before giving up
  ACT_GPX:  ['running', 'walking', 'cycling'],
  ACC_MIN_DELTA_M: 2,   // resend accuracy when it changes by this much
  ACC_MIN_GAP_MS: 7000, //   ...or this long has passed
  STAT_MIN_S: 5,        // min seconds (fix time) between live stat pushes to the watch (each one wakes the watch radio)
  TRACK_PTS: 64,        // route points sent to the watch summary
  GRAPH_PTS: 48,        // pace/HR samples sent to the watch debrief graphs
  UPLOAD_TIMEOUT_MS: 20000,
  QUEUE_MAX: 30
};

/* settings mirrored from the watch (UP-button menu) */
var WSET = { mi: false, ap: true, splits: true, mode: 0, maxHr: 190, restHr: 0 };  // 0 run,1 walk,2 ride; restHr 0=off

var ST = {
  act: 0, lastT: 0, lastTp: 0, tsWarned: false, fixLogged: false,
  lastSaved: null, upTimer: null, idleTimer: null, sid: 0,
  recording: false, paused: false, autopaused: false,
  pts: [], dist: 0, movS: 0, last: null,
  prevFix: null, lastFixAt: 0, slowN: 0, fastN: 0,
  eleSm: null, eleBase: null, egain: 0,
  hr: 0, hrAt: 0, cad: 0, cadAt: 0, lastSteps: null, stepHist: [], steps: 0,
  stepAdj: 0, stepPrevRaw: null,
  startAt: 0, splitN: 0, segFlag: 0,
  watchId: null, geoWatchdog: null, sending: false, queue: [], lastStatT: 0,
  lastOk: -1, lastAccSent: -1, lastAccAt: 0,
  uploading: false
};

function now() { return Date.now(); }
function unitM(mi) { return mi ? 1609.344 : 1000; }

/* ------------------ AppMessage queue ------------------ */
/* Protected dicts (run results, upload status) are retried on failure and never
 * silently dropped: APP_MSG_OK from a send does not mean the watch received it,
 * so on the error callback we keep the message at the head of the queue and
 * re-send (with backoff) up to SEND_RETRY times. */
function send(dict, protect) {
  dict._p = protect ? 1 : 0;
  dict._retry = 0;
  ST.queue.push(dict);
  if (ST.queue.length > C.QUEUE_MAX) {
    for (var i = 0; i < ST.queue.length; i++) {
      if (!ST.queue[i]._p) { ST.queue.splice(i, 1); break; }   // evict an unprotected one, never a protected one
    }
  }
  pump();
}
function cleanDict(d) { var o = {}, k; for (k in d) { if (k !== '_p' && k !== '_retry' && d.hasOwnProperty(k)) o[k] = d[k]; } return o; }
function pump() {
  if (ST.sending || !ST.queue.length) return;
  ST.sending = true;
  var d = ST.queue[0];                       // peek — don't drop until it actually lands
  Pebble.sendAppMessage(cleanDict(d),
    function () { ST.sending = false; ST.queue.shift(); pump(); },
    function () {
      ST.sending = false;
      if (d._p && (d._retry = (d._retry || 0) + 1) <= C.SEND_RETRY) {
        var t = setTimeout(pump, 400 * d._retry);   // keep it at the head, back off, retry
        if (t && t.unref) t.unref();
      } else {
        if (d._p) rlog('gave up on a protected message after ' + C.SEND_RETRY + ' retries');
        ST.queue.shift();
        pump();
      }
    });
}

function sendStatus(ok, acc, force) {
  var d = {}, t = now();
  if (force || ok !== ST.lastOk) { d.GPSOK = ok; ST.lastOk = ok; }
  if (ok && acc !== null && acc !== undefined) {
    var a = Math.round(acc);
    if (force || Math.abs(a - ST.lastAccSent) >= C.ACC_MIN_DELTA_M ||
        (a !== ST.lastAccSent && t - ST.lastAccAt > C.ACC_MIN_GAP_MS)) {
      d.ACC = a; ST.lastAccSent = a; ST.lastAccAt = t;
    }
  }
  for (var k in d) { send(d); return; }
}

/* ------------------ Geometry ------------------ */
function rad(x) { return x * Math.PI / 180; }
function haversine(a, b) {
  var R = 6371000;
  var dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/* ------------------ GPS ------------------ */
function startGeo() {
  if (ST.watchId !== null && ST.watchId !== undefined) return;   // already acquiring
  if (!navigator.geolocation) { sendStatus(0, null, true); return; }
  ST.watchId = navigator.geolocation.watchPosition(onFix, function () {
    sendStatus(0, null, true);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });

  if (!ST.geoWatchdog) {
    ST.geoWatchdog = setInterval(function () {     // stale-fix watchdog
      if (now() - ST.lastFixAt > 12000) sendStatus(0, null, true);
    }, 6000);
  }
}

/* Release the GPS receiver. High-accuracy GPS is by far the biggest battery
 * draw and is pure waste once a run is saved, so we stop it the moment
 * recording ends and re-acquire on the next start. */
function stopGeo() {
  if (navigator.geolocation && ST.watchId !== null && ST.watchId !== undefined) {
    navigator.geolocation.clearWatch(ST.watchId);
  }
  ST.watchId = null;
  if (ST.geoWatchdog) { clearInterval(ST.geoWatchdog); ST.geoWatchdog = null; }
}

/* All pace / moving-time / GPX-time maths runs on the fix timestamp, but
 * not every phone app's geolocation bridge fills pos.timestamp in sanely
 * (missing, 0, boot-relative or seconds instead of ms have all been seen
 * in the wild).  Only trust it when it looks like a real epoch-ms value;
 * otherwise fall back to the wall clock, which is what "now" means anyway
 * for a fix that just arrived. */
function fixTime(pos) {
  var ts = pos ? pos.timestamp : null;
  if (typeof ts === 'number' && ts > 1e12 && ts < 4e12) {
    return ts / 1000;                       // fractional seconds — keep sub-second precision
  }
  if (!ST.tsWarned) {
    ST.tsWarned = true;
    rlog('geolocation timestamp unusable (' + ts + '), using wall clock');
  }
  return now() / 1000;
}

function onFix(pos) {
  ST.lastFixAt = now();
  var c = pos.coords;
  var good = (c.accuracy !== null && c.accuracy !== undefined && isFinite(c.accuracy) &&
              c.accuracy <= C.MAX_ACC_M &&
              isFinite(c.latitude) && isFinite(c.longitude));
  sendStatus(good ? 1 : 0, c.accuracy);
  if (!good) return;

  if (!ST.fixLogged) {
    ST.fixLogged = true;
    rlog('GPS ok, accuracy ' + Math.round(c.accuracy) + ' m');
  }

  var tp = fixTime(pos);                 // fractional seconds — ms precision for the filter & auto-pause
  if (tp < ST.lastTp) tp = ST.lastTp;    // GPS clocks must never run backwards
  ST.lastTp = tp;
  var t = Math.round(tp);
  if (t < ST.lastT) t = ST.lastT;
  ST.lastT = t;

  if (!ST.kf) ST.kf = gps.make();
  var sm = ST.kf.update(c.latitude, c.longitude, c.accuracy, tp);   // Kalman-smoothed (real dt: no zero-delta velocity spikes)
  var fix = {
    t: t,
    lat: sm.lat,
    lon: sm.lon,
    ele: (c.altitude === null || c.altitude === undefined)
           ? null : Math.round(c.altitude * 10) / 10
  };

  // Auto-pause keys off RAW GPS speed: the Kalman filter adds velocity inertia
  // that lags a sudden stop, which would make pause/resume sluggish. Distance,
  // track and splits use the smoothed fix; only stop/resume detection sees raw.
  var rawFix = { t: tp, lat: +c.latitude.toFixed(6), lon: +c.longitude.toFixed(6) };

  if (ST.recording && !ST.paused) autoPauseCheck(rawFix);
  var accumulating = ST.recording && !ST.paused && !ST.autopaused;
  ST.prevFix = rawFix;
  if (!accumulating) return;

  if (ST.last) {
    var dt = fix.t - ST.last.t;
    var dm = haversine(ST.last, fix);
    if (dt > 0 && dm / dt > C.MAX_SPEED[ST.act || 0]) return;  // physically impossible step: drop the outlier
    if (dt < C.MIN_GAP_S && dm < 15) return;   // throttle dense fixes
    if (dm < C.MIN_MOVE_M && dt < 15) return;  // jitter while still
    ST.dist += dm;
    ST.movS += Math.min(dt, C.MOV_CAP_S);
  }

  // Feed raw altitude to the gain accumulator (its 3 m dead-band does the
  // noise rejection for the stat), but STORE the smoothed value on the point:
  // GPS vertical noise would otherwise make a flat run's exported gain balloon
  // (this run: 107 m raw vs 23 m as displayed). Keeps every export consistent.
  if (fix.ele !== null) { trackElevation(fix.ele); fix.ele = Math.round(ST.eleSm * 10) / 10; }

  fix.hr = (now() - ST.hrAt < C.HR_STALE_MS) ? ST.hr : 0;
  fix.cad = (now() - ST.cadAt < C.CAD_STALE_MS) ? ST.cad : 0;
  fix.seg = ST.segFlag; ST.segFlag = 0;
  ST.pts.push(fix);
  ST.last = fix;

  var mult = C.SPLIT_MULT[ST.act || 0];
  var n = Math.floor(ST.dist / (unitM(WSET.mi) * mult));
  if (n > ST.splitN) {
    ST.splitN = n;
    if (WSET.splits) send({ SPLIT: n * mult });   // watch shows "KM 5", "KM 10"…
  }

  if (t - ST.lastStatT >= C.STAT_MIN_S) {     // throttle live pushes to the watch
    ST.lastStatT = t;
    send({
      DIST: Math.round(ST.dist),
      PACE: curPace(),
      AVGP: avgPace(),
      EGAIN: Math.round(ST.egain)
    });
  }

  if (ST.pts.length % 15 === 0) persistInProgress();
}

/* Auto-pause: N slow fixes in a row pause the run; M fast ones resume it. */
function autoPauseCheck(fix) {
  if (!ST.prevFix) return;
  var dt = fix.t - ST.prevFix.t;
  if (dt <= 0) return;                 // duplicate / zero-delta fix: don't fabricate a speed
  var v = haversine(ST.prevFix, fix) / dt;

  if (!ST.autopaused) {
    if (WSET.ap && v < C.AP_SLOW[ST.act || 0]) {
      if (++ST.slowN >= C.AP_SLOW_N) {
        ST.autopaused = true; ST.slowN = 0; ST.fastN = 0;
        send({ APAUSE: 1 });
        persistInProgress();
      }
    } else ST.slowN = 0;
  } else {
    if (v > C.AP_FAST[ST.act || 0]) {
      if (++ST.fastN >= C.AP_FAST_N) {
        ST.autopaused = false; ST.fastN = 0; ST.slowN = 0;
        ST.last = null; ST.segFlag = 1;     // new GPX segment on resume
        ST.stepHist = [];                   // fresh cadence window after the paused stretch
        send({ APAUSE: 0 });
      }
    } else ST.fastN = 0;
  }
}

function trackElevation(ele) {
  if (ST.eleSm === null) { ST.eleSm = ele; ST.eleBase = ele; return; }
  ST.eleSm = ST.eleSm + 0.3 * (ele - ST.eleSm);     // EMA smoothing
  var diff = ST.eleSm - ST.eleBase;
  if (diff >= 3) { ST.egain += diff; ST.eleBase = ST.eleSm; }
  else if (diff <= -3) { ST.eleBase = ST.eleSm; }
}

/* Paces are ALWAYS seconds-per-km on the wire and in storage;
 * the watch and the debrief page convert for display. */
function curPace() {
  var pts = ST.pts;
  if (pts.length < 2) return 0;
  var tEnd = pts[pts.length - 1].t, tMin = tEnd - C.PACE_WINDOW_S;
  var d = 0, t0 = tEnd;
  for (var i = pts.length - 1; i > 0; i--) {
    var a = pts[i - 1], b = pts[i];
    if (b.seg) break;                 // don't measure across a pause
    d += haversine(a, b);
    t0 = a.t;
    if (a.t <= tMin) break;
  }
  var dt = tEnd - t0;
  if (d < 15 || dt < 15) return 0;
  return Math.round(dt / (d / 1000));
}

function avgPace() {
  if (ST.movS < 30 || ST.dist < 50) return 0;
  return Math.round(ST.movS / (ST.dist / 1000));
}

/* ------------------ Run lifecycle ------------------ */
function startRun() {
  if (ST.recording) return;      // idempotent: a duplicate START must not reset a live run
  ST.recording = true; ST.paused = false; ST.autopaused = false;
  ST.pts = []; ST.dist = 0; ST.movS = 0;
  ST.last = null; ST.startAt = now(); ST.splitN = 0; ST.segFlag = 0;
  ST.lastT = 0; ST.lastTp = 0;
  ST.slowN = 0; ST.fastN = 0;
  ST.eleSm = null; ST.eleBase = null; ST.egain = 0;
  ST.steps = 0; ST.lastSteps = null; ST.stepHist = []; ST.cad = 0;
  ST.stepAdj = 0; ST.stepPrevRaw = null;
  ST.hr = 0; ST.hrAt = 0;        // don't carry the previous run's HR into this one
  ST.sid = now();                // session id ties this run to its recovery checkpoint and saved record
  ST.act = WSET.mode;            // mode is locked for the whole activity
  ST.kf = gps.make();            // fresh GPS Kalman filter per run
  ST.lastStatT = 0;              // push the first live stats promptly
  if (ST.idleTimer) { clearTimeout(ST.idleTimer); ST.idleTimer = null; }
  startGeo();                    // re-acquire GPS if a previous run released it
  persistInProgress();
}
function pauseRun() {
  if (!ST.recording || ST.paused) return;   // idempotent
  ST.paused = true; ST.autopaused = false;
  ST.slowN = 0; ST.fastN = 0;
  ST.stepHist = [];              // a pre-pause sample must not seed the first post-pause cadence
  persistInProgress();
}
function resumeRun() {
  if (!ST.recording) return;
  ST.paused = false; ST.autopaused = false;
  ST.slowN = 0; ST.fastN = 0;
  ST.last = null; ST.segFlag = 1;
  ST.stepHist = [];
}

function stopRun() {
  if (!ST.recording) { send({ NOSAVE: 1 }, true); return; }   // idempotent: STOP with nothing live can't have saved anything
  ST.recording = false; ST.paused = false; ST.autopaused = false;
  stopGeo();                     // recording over — release GPS to save battery
  var run = finalizeRun({
    startAt: ST.startAt, dist: ST.dist, movS: ST.movS,
    egain: ST.egain, steps: ST.steps, act: ST.act, sid: ST.sid,
    elapsed: ST.startAt ? (now() - ST.startAt) / 1000 : 0,
    mi: WSET.mi ? 1 : 0, pts: compactPts(ST.pts)
  }, '');
  if (run) {
    var ok = saveRun(run);       // saveRun now reports whether the write actually succeeded
    rlog((ok ? 'saved' : 'SAVE FAILED') + ' "' + run.name + '" (' +
         Math.round(run.dist) + ' m' + (run.noGps ? ', no GPS' : '') + ')');
    if (ok) {
      send({ SAVED: 1, DIST: run.dist, AVGP: run.avgp, AVGHR: run.avgHr,
             MAXHR: run.maxHr, MOVS: run.mov, EGAIN: run.egain, VO2: run.vo2max || 0 }, true);
      sendTrack(run.pts);
      sendGraphs(run.pts);
      ST.lastSaved = run.start;
      try { openRunLogPage(run.start); } catch (e1) {}
    } else {
      send({ NOSAVE: 1 }, true); // storage full and unrecoverable — don't claim it saved
    }
    try { localStorage.removeItem('runlog.inprogress'); } catch (e0) {}
  } else {
    /* no GPS and no meaningful time (a stray start/stop): nothing to save,
     * and we say so rather than flashing a bogus "RUN SAVED". */
    send({ NOSAVE: 1 }, true);
    try { localStorage.removeItem('runlog.inprogress'); } catch (e2) {}
  }
}

function compactPts(pts) {
  var out = [];
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    out.push([p.t, p.lat, p.lon, (p.ele === null ? '' : p.ele),
              p.hr || 0, p.seg || 0, p.cad || 0]);
  }
  return out;
}

/* Splits from the stored points, with boundary interpolation.
 * Returns [{d: metres, s: seconds, hr: avg bpm|0}, ...]; the last
 * entry may be a partial split. */
function computeSplits(cpts, mi, mult) {
  var U = unitM(mi) * (mult || 1), out = [];
  var sd = 0, st = 0, hrS = 0, hrN = 0;
  for (var i = 1; i < cpts.length; i++) {
    var a = cpts[i - 1], b = cpts[i];
    if (b[5]) continue;                       // pause boundary: skip the gap
    var dm = haversine({ lat: a[1], lon: a[2] }, { lat: b[1], lon: b[2] });
    var dt = Math.min(Math.max(b[0] - a[0], 0), 10);
    while (dm > 0 && sd + dm >= U) {
      var need = U - sd;
      var f = need / dm;
      st += dt * f;
      out.push({ d: Math.round(U), s: Math.round(st), hr: hrN ? Math.round(hrS / hrN) : 0 });
      dm -= need; dt -= dt * f;
      sd = 0; st = 0; hrS = 0; hrN = 0;
    }
    sd += dm; st += dt;
    if (b[4] > 0) { hrS += b[4]; hrN++; }
  }
  if (sd > 25) out.push({ d: Math.round(sd), s: Math.round(st), hr: hrN ? Math.round(hrS / hrN) : 0 });
  return out;
}

/* strftime-style date/time codes (a practical subset). */
function strftimeLite(fmt, d) {
  function p2(x) { return (x < 10 ? '0' : '') + x; }
  var DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
             'August', 'September', 'October', 'November', 'December'];
  var Y = d.getFullYear(), Mo = d.getMonth(), Da = d.getDate(), H = d.getHours();
  var h12 = (H % 12) || 12;
  var doy = Math.floor((d - new Date(Y, 0, 0)) / 86400000);
  var tok = {
    Y: '' + Y, y: p2(Y % 100), m: p2(Mo + 1), d: p2(Da), e: (Da < 10 ? ' ' : '') + Da,
    H: p2(H), I: p2(h12), M: p2(d.getMinutes()), S: p2(d.getSeconds()),
    p: H < 12 ? 'AM' : 'PM', A: DAY[d.getDay()], a: DAY[d.getDay()].slice(0, 3),
    B: MON[Mo], b: MON[Mo].slice(0, 3), j: ('00' + doy).slice(-3),
    F: Y + '-' + p2(Mo + 1) + '-' + p2(Da),
    T: p2(H) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()),
    R: p2(H) + ':' + p2(d.getMinutes()),
    D: p2(Mo + 1) + '/' + p2(Da) + '/' + p2(Y % 100), '%': '%'
  };
  return fmt.replace(/%([A-Za-z%])/g, function (m, c) {
    return Object.prototype.hasOwnProperty.call(tok, c) ? tok[c] : m;
  });
}

/* Build a run name from the template: named {extras} first, then %-codes. */
function nameFromTemplate(tpl, act, startMs) {
  var d = new Date(startMs);
  function p2(x) { return (x < 10 ? '0' : '') + x; }
  var h = d.getHours();
  var part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  var Act = C.ACT_NAME[(act >= 0 && act <= 2) ? act : 0];   // 'Run'/'Walk'/'Ride'
  var ext = {                                  // {date}/{time} kept as back-compat aliases
    part: part, Part: part.charAt(0).toUpperCase() + part.slice(1),
    activity: Act.toLowerCase(), Activity: Act,
    date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
    time: p2(h) + '.' + p2(d.getMinutes())
  };
  var t = (tpl && String(tpl).replace(/^\s+|\s+$/g, '')) ? String(tpl) : C.NAME_TPL_DEFAULT;
  t = t.replace(/\{([A-Za-z]+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(ext, k) ? ext[k] : m;
  });
  return strftimeLite(t, d);
}

/* Estimate VO2max from a run using the documented submaximal field method,
 * tuned for accuracy within what a GPS+HR watch can actually measure:
 *   - the ACSM running equation gives VO2 at each steady pace (level-ground
 *     only: Pebble exposes just noisy GPS altitude, no barometer, so a grade
 *     term would add more error than it removes);
 *   - the heart rate at that pace is turned into a fraction of capacity, by
 *     heart-rate reserve / VO2 reserve (Karvonen) when a resting HR is known
 *     -- the more accurate model -- otherwise by Swain's %HRmax relation;
 *   - VO2 / fraction is the implied VO2max, taken as the median over points.
 * Accuracy guards: the first two minutes are dropped (HR lags pace on warm-up,
 * which would inflate the figure), and only metabolic steady state counts --
 * points mid-acceleration, where HR and pace are out of step, are skipped.
 * Running only; needs HR and the user's max HR; 0 when there isn't enough
 * steady aerobic running to lean on. */
function estimateVo2max(pts, act, hrMax, restHr) {
  if (act !== 0 || !hrMax || hrMax < 120) return 0;
  var useReserve = (restHr > 0 && restHr < hrMax - 20);  // Karvonen when resting HR is set
  var t0 = pts.length ? pts[0][0] : 0;
  var s = [], i, vEma = 0;
  for (i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    if (b[5]) { vEma = 0; continue; }                    // pause/resume: reset steadiness ref
    var dt = b[0] - a[0];
    if (dt <= 0 || dt > 20) { vEma = 0; continue; }      // gap / paused stretch
    var v = haversine({ lat: a[1], lon: a[2] }, { lat: b[1], lon: b[2] }) / dt * 60; // m/min
    if (vEma === 0) vEma = v;
    var steady = Math.abs(v - vEma) / vEma <= 0.22;      // close to recent pace = steady state
    vEma = vEma + 0.30 * (v - vEma);
    if (v < 120 || v > 400) continue;                    // running pace band (~7.2-24 km/h)
    if (!steady) continue;                               // accel/decel: HR lags pace, skip
    if (b[0] - t0 < 120) continue;                       // warm-up: HR not yet at steady state
    var hr = b[4];
    if (!hr || hr <= 0) continue;
    var pHR = hr / hrMax * 100;
    if (pHR < 65 || pHR > 100) continue;                 // band where the HR models hold up
    var frac = useReserve ? (hr - restHr) / (hrMax - restHr)  // %HRR = %VO2R
                          : (pHR - 37) / 64;                  // Swain (1994), as a fraction
    if (frac < 0.30) continue;                           // guard tiny denominators
    var exVO2 = 0.2 * v + 3.5;                            // ACSM level running
    var vo2 = useReserve ? (3.5 + (exVO2 - 3.5) / frac)  // VO2 reserve model
                         : (exVO2 / frac);
    if (vo2 >= 20 && vo2 <= 90) s.push(vo2);
  }
  if (s.length < 20) return 0;                           // not enough steady aerobic running
  s.sort(function (x, y) { return x - y; });
  var m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

function finalizeRun(d, suffix) {
  var cpts = d.pts || [];
  var hasGps = cpts.length >= 2;
  var elapsed = Math.round(d.elapsed || 0);
  if (!hasGps && elapsed < 10) return null;   // no route and no meaningful time: nothing to record
  var sum = 0, n = 0, max = 0, i;
  for (i = 0; i < cpts.length; i++) {
    var hr = cpts[i][4];
    if (hr > 0) { sum += hr; n++; if (hr > max) max = hr; }
  }
  var act = (d.act >= 0 && d.act <= 2) ? d.act : 0;
  if (act === 2) { for (i = 0; i < cpts.length; i++) cpts[i][6] = 0; }   // wrist cadence is meaningless on a bike — never export it
  var mov = hasGps ? Math.round(d.movS || 0) : elapsed;   // no GPS (treadmill): the whole elapsed time is "moving"
  var dist = hasGps ? Math.round(d.dist) : 0;
  var dur = hasGps ? (cpts[cpts.length - 1][0] - cpts[0][0]) : elapsed;
  var name = nameFromTemplate(loadCfg().name, act, d.startAt) + suffix;
  return {
    name: name, start: d.startAt,
    dist: dist,
    dur: dur,
    mov: mov,
    avgp: (mov >= 30 && dist >= 50) ? Math.round(mov / (dist / 1000)) : 0,
    avgHr: n ? Math.round(sum / n) : 0,
    maxHr: max,
    vo2max: hasGps ? estimateVo2max(cpts, act, WSET.maxHr, WSET.restHr) : 0,
    egain: Math.round(d.egain || 0),
    cad: (act !== 2 && mov >= 30 && d.steps > 0)
           ? Math.min(260, Math.round(d.steps * 60 / mov)) : 0,
    steps: d.steps || 0,
    mi: d.mi ? 1 : 0,
    act: act,
    noGps: hasGps ? 0 : 1,
    sid: d.sid || 0,
    splits: hasGps ? computeSplits(cpts, d.mi, C.SPLIT_MULT[act]) : [],
    up: 0,
    pts: cpts
  };
}

/* Downsample + normalise the route into 0..200 x/y byte pairs for the
 * watch summary screen (aspect preserved, centred, y grows downward). */
function sendTrack(cpts) {
  var N = cpts.length;
  if (N < 2) return;
  var K = Math.min(C.TRACK_PTS, N);
  var latMid = 0, i;
  var mnLa = 1e9, mxLa = -1e9, mnX = 1e9, mxX = -1e9;
  for (i = 0; i < N; i++) latMid += cpts[i][1];
  latMid /= N;
  var cosM = Math.cos(rad(latMid));
  var sel = [];
  for (i = 0; i < K; i++) {
    var p = cpts[Math.round(i * (N - 1) / (K - 1))];
    var x = p[2] * cosM, la = p[1];
    sel.push([x, la]);
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (la < mnLa) mnLa = la; if (la > mxLa) mxLa = la;
  }
  var spanX = mxX - mnX, spanY = mxLa - mnLa;
  var span = Math.max(spanX, spanY, 1e-9);
  var s = 200 / span;
  var offX = (200 - spanX * s) / 2, offY = (200 - spanY * s) / 2;
  var bytes = [];
  for (i = 0; i < K; i++) {
    var px = Math.round((sel[i][0] - mnX) * s + offX);
    var py = Math.round((mxLa - sel[i][1]) * s + offY);   // top-down y
    bytes.push(Math.max(0, Math.min(200, px)), Math.max(0, Math.min(200, py)));
  }
  send({ TRACK: bytes }, true);
  // longest axis of the route in real-world metres -> the watch scale label
  var spanM = Math.round(span * 111320 * (spanX >= spanY ? cosM : 1));
  send({ TSPAN: spanM }, true);
}

/* Mini pace + HR graphs for the watch debrief.  Each is a byte array:
 * [minLo, minHi, maxLo, maxHi, sample0..N-1] where samples are the
 * series resampled onto GRAPH_PTS equal-distance buckets, normalised
 * 0..100 between min and max; 255 marks an empty bucket. */
function buildGraph(vals) {
  var mn = Infinity, mx = -Infinity, i;
  for (i = 0; i < vals.length; i++) {
    if (vals[i] !== null) {
      if (vals[i] < mn) mn = vals[i];
      if (vals[i] > mx) mx = vals[i];
    }
  }
  if (mn === Infinity) return null;
  mn = Math.round(mn); mx = Math.round(mx);
  if (mx - mn < 1) mx = mn + 1;
  var out = [mn & 255, (mn >> 8) & 255, mx & 255, (mx >> 8) & 255];
  for (i = 0; i < vals.length; i++) {
    out.push(vals[i] === null ? 255 :
      Math.max(0, Math.min(100, Math.round((vals[i] - mn) * 100 / (mx - mn)))));
  }
  return out;
}

function sendGraphs(cpts) {
  var N = cpts.length;
  if (N < 4) return;
  var cum = [0], paceAt = [null];
  var hrAt = [cpts[0][4] > 0 ? cpts[0][4] : null];
  var total = 0, i;
  for (i = 1; i < N; i++) {
    var d = cpts[i][5] ? 0 :
      haversine({ lat: cpts[i-1][1], lon: cpts[i-1][2] },
                { lat: cpts[i][1],   lon: cpts[i][2] });
    var dt = cpts[i][0] - cpts[i-1][0];
    total += d;
    cum.push(total);
    var v = (cpts[i][5] || dt <= 0) ? null : d / dt;
    paceAt.push((v && v > 0.4) ? Math.min(1200, 1000 / v) : null);
    hrAt.push(cpts[i][4] > 0 ? cpts[i][4] : null);
  }
  if (total < 50) return;
  var B = C.GRAPH_PTS, ps = [], pc = [], hs = [], hc = [];
  for (i = 0; i < B; i++) { ps.push(0); pc.push(0); hs.push(0); hc.push(0); }
  for (i = 0; i < N; i++) {
    var b = Math.min(B - 1, Math.floor(cum[i] * B / total));
    if (paceAt[i] !== null) { ps[b] += paceAt[i]; pc[b]++; }
    if (hrAt[i] !== null)   { hs[b] += hrAt[i];   hc[b]++; }
  }
  var pv = [], hv = [];
  for (i = 0; i < B; i++) {
    pv.push(pc[i] ? ps[i] / pc[i] : null);
    hv.push(hc[i] ? hs[i] / hc[i] : null);
  }
  // a light centered kernel takes the shimmer off without moving features
  pv = ksmooth(pv, 1.3);
  hv = ksmooth(hv, 1.3);
  var pg = buildGraph(pv), hg = buildGraph(hv);
  if (pg) send({ PACEG: pg }, true);
  if (hg) send({ HRG: hg }, true);
}

/* ------------------ Storage ------------------ */
function loadRuns() {
  try {
    var raw = localStorage.getItem('runlog.runs');
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function storeRuns(runs) {
  try { localStorage.setItem('runlog.runs', JSON.stringify(runs)); updateGlance(); return true; }
  catch (e) { return false; }
}

/* ---- App Glance: surface the most recent run in the launcher ----
 * Phone-side (PebbleKit JS) so it uses the authoritative final stats and
 * needs no watch code. Best-effort: never let a glance error break a save. */
function glanceDist(m, mi) {
  var v = mi ? m / 1609.344 : m / 1000;
  return v.toFixed(2) + (mi ? ' mi' : ' km');
}
function glanceTime(s) {
  s = Math.round(s || 0);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  function p2(x) { return (x < 10 ? '0' : '') + x; }
  return h > 0 ? (h + ':' + p2(m) + ':' + p2(sec)) : (m + ':' + p2(sec));
}
function updateGlance() {
  try {
    if (typeof Pebble === 'undefined' || !Pebble.appGlanceReload) return;
    var runs = loadRuns(), i;
    if (!runs.length) { Pebble.appGlanceReload([], function () {}, function () {}); return; }
    var r = runs[0];
    for (i = 1; i < runs.length; i++) if (runs[i].start > r.start) r = runs[i];
    var set = {};
    try { set = JSON.parse(localStorage.getItem('runlog.set') || '{}'); } catch (e) {}
    var label = ['Run', 'Walk', 'Ride'][r.act || 0] || 'Run';
    var subtitle = label + ' \u00b7 ' + glanceDist(r.dist || 0, !!set.mi) + ' \u00b7 ' + glanceTime(r.dur || 0);
    Pebble.appGlanceReload(
      [{ layout: { icon: 'system://images/GENERIC_CONFIRMATION', subtitleTemplateString: subtitle } }],
      function () {}, function () {});
  } catch (e) { /* glance is best-effort */ }
}
function saveRun(run) {
  var runs = loadRuns();
  runs.push(run);
  var evicted = 0;
  while (runs.length > C.KEEP_RUNS) { runs.shift(); evicted++; }
  while (JSON.stringify(runs).length > C.MAX_STORE_CHARS && runs.length > 1) { runs.shift(); evicted++; }
  var ok = storeRuns(runs);
  if (!ok && runs.length > 1) { runs.shift(); evicted++; ok = storeRuns(runs); }   // quota fallback
  if (evicted > 0) rlog('storage full: dropped ' + evicted + ' oldest run' + (evicted > 1 ? 's' : '') + ' to make room');
  return ok;
}
function updateRun(start, fn) {
  var runs = loadRuns();
  for (var i = 0; i < runs.length; i++) {
    if (runs[i].start === start) { fn(runs[i]); break; }
  }
  storeRuns(runs);
}

function persistInProgress() {
  try {
    localStorage.setItem('runlog.inprogress', JSON.stringify({
      startAt: ST.startAt, dist: ST.dist, movS: ST.movS,
      egain: ST.egain, steps: ST.steps, act: ST.act, sid: ST.sid, at: now(),
      mi: WSET.mi ? 1 : 0, pts: compactPts(ST.pts)
    }));
  } catch (e) {}
}

/* Re-hydrate a run interrupted by a phone-JS restart. If the checkpoint is
 * fresh the run is almost certainly still going, so we RESTORE state and keep
 * recording (the old behaviour finalized it immediately, silently truncating
 * everything recorded after the restart). If it's stale the run ended while we
 * were down, so we save what we have — but only once: the session id guards
 * against a second recovery re-saving a run that already made it to storage. */
function restoreFromInprogress(ip) {
  ST.recording = true; ST.paused = false; ST.autopaused = false;
  ST.startAt = ip.startAt; ST.dist = ip.dist || 0; ST.movS = ip.movS || 0;
  ST.egain = ip.egain || 0; ST.steps = ip.steps || 0;
  ST.act = (ip.act >= 0 && ip.act <= 2) ? ip.act : 0;
  ST.sid = ip.sid || now();
  WSET.mi = !!ip.mi;
  ST.pts = (ip.pts || []).map(function (p) {
    return { t: p[0], lat: p[1], lon: p[2], ele: (p[3] === '' ? null : p[3]), hr: p[4], seg: p[5], cad: p[6] };
  });
  ST.last = ST.pts.length ? ST.pts[ST.pts.length - 1] : null;
  ST.lastT = ST.last ? ST.last.t : 0;
  ST.lastTp = ST.lastT;
  ST.eleSm = (ST.last && ST.last.ele !== null && ST.last.ele !== undefined) ? ST.last.ele : null;
  ST.eleBase = ST.eleSm;
  ST.kf = gps.make();                 // fresh filter; stored positions are already smoothed
  ST.segFlag = 1;                     // the gap over the restart is a segment boundary
  ST.stepAdj = 0; ST.stepPrevRaw = null; ST.stepHist = [];
  ST.splitN = Math.floor(ST.dist / (unitM(WSET.mi) * C.SPLIT_MULT[ST.act]));
  ST.lastStatT = 0;
}
function resumeOrRecover() {
  var raw = null;
  try { raw = localStorage.getItem('runlog.inprogress'); } catch (e) {}
  if (!raw) return false;
  var ip = null;
  try { ip = JSON.parse(raw); } catch (e2) {}
  if (!ip) { try { localStorage.removeItem('runlog.inprogress'); } catch (e3) {} return false; }
  if (ip.at && (now() - ip.at < C.IP_RESUME_MS) && ip.pts) {
    restoreFromInprogress(ip);
    rlog('resumed in-progress run after restart (' + (ip.pts.length) + ' pts)');
    return true;                      // still recording — caller will (re)start GPS
  }
  if (ip.pts && ip.pts.length > 10) {
    var already = ip.sid && loadRuns().some(function (r) { return r.sid === ip.sid; });
    if (!already) {
      var run = finalizeRun(ip, ' (recovered)');
      if (run) saveRun(run);
    }
  }
  try { localStorage.removeItem('runlog.inprogress'); } catch (e4) {}
  return false;
}
function recoverIfNeeded() { return resumeOrRecover(); }   // back-compat alias

/* Warm-up GPS on the READY screen gives an instant fix on start, but left
 * running it drains the phone for nothing. Release it if no run has begun. */
function armIdleGpsRelease() {
  if (ST.idleTimer) clearTimeout(ST.idleTimer);
  ST.idleTimer = setTimeout(function () {
    ST.idleTimer = null;
    if (!ST.recording) { stopGeo(); rlog('released idle GPS (' + Math.round(C.GPS_IDLE_MS / 60000) + ' min on ready, no run started)'); }
  }, C.GPS_IDLE_MS);
  if (ST.idleTimer && ST.idleTimer.unref) ST.idleTimer.unref();
}

/* ------------------ Settings ------------------ */
function loadCfg() {
  try {
    var raw = localStorage.getItem('runlog.cfg');
    var c = raw ? JSON.parse(raw) : {};
    var preset = c.preset;
    if (['custom', 'webdav', 'intervals', 'runalyze', 'fittrackee'].indexOf(preset) < 0) {
      preset = (c.method === 'PUT') ? 'webdav' : 'custom';   // migrate old configs
    }
    return { auto: c.auto ? 1 : 0, preset: preset, url: c.url || '',
             auth: c.auth || '', key: c.key || '',
             user: c.user || '', pass: c.pass || '', name: c.name || '',
             fmt: (['gpx', 'tcx', 'fit'].indexOf(c.fmt) >= 0) ? c.fmt : 'gpx' };
  } catch (e) {
    return { auto: 0, preset: 'custom', url: '', auth: '', key: '', user: '', pass: '', name: '', fmt: 'gpx' };
  }
}

/* does the config actually point somewhere we can upload to? */
function hasTarget(c) {
  if (c.preset === 'intervals' || c.preset === 'runalyze') return !!c.key;
  if (c.preset === 'fittrackee') return !!(c.url && (c.key || (c.user && c.pass)));
  return !!c.url;
}
function storeCfg(c) {
  try { localStorage.setItem('runlog.cfg', JSON.stringify(c)); } catch (e) {}
}
function loadWatchSet() {
  try {
    var raw = localStorage.getItem('runlog.set');
    if (raw) {
      var c = JSON.parse(raw);
      WSET.mi = !!c.mi; WSET.ap = !!c.ap; WSET.splits = !!c.splits;
      WSET.mode = (c.mode >= 0 && c.mode <= 2) ? c.mode : 0;
      if (c.maxHr >= 120 && c.maxHr <= 220) WSET.maxHr = c.maxHr;
      if (c.restHr >= 0 && c.restHr <= 120) WSET.restHr = c.restHr;
    }
  } catch (e) {}
}
function storeWatchSet() {
  try { localStorage.setItem('runlog.set', JSON.stringify(WSET)); } catch (e) {}
}

/* ------------------ Upload (auto-export) ------------------ */
/* PebbleKit JS has no reliable btoa, so bring our own (ASCII input). */
var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(str) {
  var out = '', i = 0, a, b, c;
  while (i < str.length) {
    a = str.charCodeAt(i++) & 255;
    b = i < str.length ? str.charCodeAt(i++) & 255 : -1;
    c = i < str.length ? str.charCodeAt(i++) & 255 : -1;
    out += B64C.charAt(a >> 2);
    out += B64C.charAt(((a & 3) << 4) | (b < 0 ? 0 : b >> 4));
    out += b < 0 ? '=' : B64C.charAt(((b & 15) << 2) | (c < 0 ? 0 : c >> 6));
    out += c < 0 ? '=' : B64C.charAt(c & 63);
  }
  return out;
}

/* 'user:pass' is auto-wrapped as Basic; full header values pass through. */
function authHeader(c) {
  if (!c.auth) return '';
  if (c.auth.indexOf(' ') < 0 && c.auth.indexOf(':') > 0) return 'Basic ' + b64(c.auth);
  return c.auth;
}

function strBytes(s) { var a = [], i; for (i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xFF); return a; }

/* multipart/form-data body. fileBody is a string (GPX/TCX) or Uint8Array (FIT). */
function multipart(fileBody, fname, contentType, dataJson) {
  var bnd = 'runlog' + Date.now().toString(16);
  var pre = '--' + bnd + '\r\n' +
            'Content-Disposition: form-data; name="file"; filename="' + fname + '"\r\n' +
            'Content-Type: ' + (contentType || 'application/octet-stream') + '\r\n\r\n';
  var post = '\r\n';
  if (dataJson) {
    post += '--' + bnd + '\r\n' +
            'Content-Disposition: form-data; name="data"\r\n\r\n' + dataJson + '\r\n';
  }
  post += '--' + bnd + '--\r\n';
  var type = 'multipart/form-data; boundary=' + bnd;
  if (typeof fileBody === 'string') return { type: type, body: pre + fileBody + post };
  var bytes = strBytes(pre).concat(Array.prototype.slice.call(fileBody)).concat(strBytes(post));
  return { type: type, body: new Uint8Array(bytes) };
}

/* One place that knows how to talk to each destination.
 * ftok is only used by the FitTrackee branch (managed bearer token). */
function buildUploadRequest(c, run, ex, ftok) {
  var body = ex.body, ct = ex.contentType, fname = ex.fname;
  if (c.preset === 'intervals') {
    if (!c.key) return null;
    var m = multipart(body, fname, ct);
    return {
      method: 'POST',
      url: 'https://intervals.icu/api/v1/athlete/0/activities?name=' +
           encodeURIComponent(run.name),
      headers: { 'Content-Type': m.type,
                 'Authorization': 'Basic ' + b64('API_KEY:' + c.key) },
      body: m.body
    };
  }
  if (c.preset === 'fittrackee') {
    if (!c.url || !ftok) return null;
    // default FitTrackee sport ids: 5 Running, 6 Walking, 1 Cycling (Sport)
    var sport = [5, 6, 1][run.act || 0];
    var mf = multipart(body, fname, ct, JSON.stringify({ sport_id: sport }));
    return {
      method: 'POST',
      url: ftBase(c) + '/api/workouts',
      headers: { 'Content-Type': mf.type, 'Authorization': 'Bearer ' + ftok },
      body: mf.body
    };
  }
  if (c.preset === 'runalyze') {
    if (!c.key) return null;
    var m2 = multipart(body, fname, ct);
    return {
      method: 'POST',
      url: 'https://runalyze.com/api/v1/activities/uploads',
      headers: { 'Content-Type': m2.type, 'token': c.key },
      body: m2.body
    };
  }
  if (!c.url) return null;
  if (c.preset === 'webdav') {
    var u = c.url + (c.url.charAt(c.url.length - 1) === '/' ? '' : '/') + fname;
    var h = { 'Content-Type': ct };
    var a = authHeader(c);
    if (a) h.Authorization = a;
    return { method: 'PUT', url: u, headers: h, body: body };
  }
  var h2 = { 'Content-Type': ct, 'X-Filename': fname };
  var a2 = authHeader(c);
  if (a2) h2.Authorization = a2;
  return { method: 'POST', url: c.url, headers: h2, body: body };
}

/* Fire one request; cb(status, responseText), status 0 = network error. */
function xhrSend(req, cb) {
  var done = false;
  function once(status, text) { if (done) return; done = true; cb(status, text); }
  try {
    var x = new XMLHttpRequest();
    x.open(req.method, req.url, true);
    x.timeout = C.UPLOAD_TIMEOUT_MS;
    for (var hk in req.headers) {
      if (req.headers.hasOwnProperty(hk)) x.setRequestHeader(hk, req.headers[hk]);
    }
    x.onload = function () { once(x.status, x.responseText); };
    x.onerror = function () { once(0, ''); };
    x.ontimeout = function () { once(0, ''); };
    x.send(req.body);
  } catch (e) {
    once(0, '');
  }
}

/* ---- FitTrackee token management ----
 * The user gives us their instance URL + email + password; we log in via
 * POST /api/auth/login, cache the auth_token, and transparently log in
 * again whenever the server answers 401 (FitTrackee tokens expire). A
 * token pasted in older versions (cfg.key) keeps working as a fallback. */
function ftBase(c) { return (c.url || '').replace(/\/+$/, ''); }

function ftToken(c) {
  try { return localStorage.getItem('runlog.ftok') || c.key || ''; }
  catch (e) { return c.key || ''; }
}

function ftLogin(c, cb) {
  if (/^\s|\s$/.test(c.pass || '')) {
    rlog('note: password has leading/trailing whitespace');
  }
  rlog('logging in as "' + c.user + '"');
  xhrSend({
    method: 'POST',
    url: ftBase(c) + '/api/auth/login',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: c.user, password: c.pass })
  }, function (status, text) {
    var tok = null;
    if (status >= 200 && status < 300) {
      try { tok = JSON.parse(text).auth_token || null; } catch (e) {}
    }
    if (tok) {
      rlog('fittrackee login ok');
      try { localStorage.setItem('runlog.ftok', tok); } catch (e2) {}
    } else {
      var sm = '';
      try { sm = JSON.parse(text).message || ''; } catch (e3) {}
      rlog('fittrackee login FAILED (HTTP ' + status + ')' +
           (sm ? ' - server said: "' + sm + '"' : ''));
    }
    cb(tok, status);
  });
}

function uploadRun(run) {
  if (ST.uploading) { rlog('an upload is already in progress — try again in a moment'); send({ EXPST: 2, EXPERR: 0 }, true); return; }
  var c = loadCfg();
  if (/^http:\/\//i.test(c.url || '') && (c.pass || c.key || c.auth || c.user)) {
    rlog('WARNING: destination is plain HTTP — credentials and your activity travel the network unencrypted');
  }
  var ex = exportRun(run, c.fmt);
  var fname = ex.fname;
  var fmt = (['gpx', 'tcx', 'fit'].indexOf(c.fmt) >= 0) ? c.fmt : 'gpx';

  function finish(ok, status) {
    ST.uploading = false;
    var still = loadRuns().some(function (r) { return r.start === run.start; });
    if (!still) {
      rlog('upload result for a discarded workout ignored');
      return;
    }
    updateRun(run.start, function (r) {
      r.up = ok ? 1 : 2;
      if (ok) r.upMeta = { dest: c.preset || 'custom', fmt: fmt, at: Math.round(now() / 1000) };
    });
    if (ok) {
      rlog('upload ok (HTTP ' + status + ')');
      send({ EXPST: 1 }, true);
    } else {
      rlog('upload FAILED (' + (status ? 'HTTP ' + status : 'no network') + ')');
      send({ EXPST: 2, EXPERR: status || 0 }, true);
    }
  }

  if (c.preset === 'fittrackee') {
    var canLogin = !!(c.user && c.pass);
    if (!c.url || (!ftToken(c) && !canLogin)) {
      rlog('fittrackee upload needs a URL and either a saved token or email + password');
      send({ EXPST: 2, EXPERR: 0 }, true);
      return;
    }
    ST.uploading = true;
    rlog('upload -> fittrackee ' + hostOf(c.url) + ' (' + fname + ')');
    send({ EXPST: 0 }, true);                     // "Uploading…"
    var refreshed = false;
    var attempt = function () {
      xhrSend(buildUploadRequest(c, run, ex, ftToken(c)), function (status) {
        if (status >= 200 && status < 300) return finish(true, status);
        if (status === 401 && canLogin && !refreshed) {
          refreshed = true;                       // expired token: renew once
          rlog('token rejected (HTTP 401), logging in again');
          return ftLogin(c, function (tok, lst) {
            tok ? attempt() : finish(false, lst);
          });
        }
        finish(false, status);
      });
    };
    if (!ftToken(c)) {
      refreshed = true;                           // first ever upload: log in
      ftLogin(c, function (tok, lst) { tok ? attempt() : finish(false, lst); });
    } else {
      attempt();
    }
    return;
  }

  var req = buildUploadRequest(c, run, ex);
  if (!req) {
    rlog('no upload destination configured (or missing credentials) — set one on the phone page');
    send({ EXPST: 2, EXPERR: 0 }, true);
    return;
  }
  ST.uploading = true;
  rlog('upload -> ' + c.preset + ' ' + hostOf(req.url) + ' (' + fname + ')');
  send({ EXPST: 0 }, true);                       // "Uploading…"
  xhrSend(req, function (status) {
    finish(status >= 200 && status < 300, status);
  });
}

/* Newest run that has never uploaded (0) or failed (2). Runs saved by
 * v1 (no 'up' field) are left alone. */
function retryPending() {
  var c = loadCfg();
  if (!hasTarget(c) || ST.uploading) return;   // manual: used as the CMD 7 fallback
  var runs = loadRuns();
  for (var i = runs.length - 1; i >= 0; i--) {
    if (runs[i].up === 0 || runs[i].up === 2) { uploadRun(runs[i]); return; }
  }
}

/* ------------------ Pebble events ------------------ */
Pebble.addEventListener('ready', function () {
  loadWatchSet();
  var resumed = resumeOrRecover();
  startGeo();
  if (!resumed) armIdleGpsRelease();   // warm up for a quick start, but don't drain forever on READY
  sendStatus(0, null, true);
  // (no auto-upload on connect — uploads are user-driven)
});

Pebble.addEventListener('appmessage', function (e) {
  var p = (e && e.payload) || {};
  if (p.UNITS !== undefined)  { WSET.mi = !!p.UNITS; storeWatchSet(); }
  if (p.AUTOP !== undefined)  { WSET.ap = !!p.AUTOP; storeWatchSet(); }
  if (p.SPLITP !== undefined) { WSET.splits = !!p.SPLITP; storeWatchSet(); }
  if (p.MODE !== undefined)   { WSET.mode = (p.MODE >= 0 && p.MODE <= 2) ? p.MODE : 0; storeWatchSet(); }
  if (p.MHR !== undefined && p.MHR >= 120 && p.MHR <= 220) { WSET.maxHr = p.MHR; storeWatchSet(); }
  if (p.RHR !== undefined && p.RHR >= 0   && p.RHR <= 120) { WSET.restHr = p.RHR; storeWatchSet(); }
  if (p.HR !== undefined)     { ST.hr = p.HR; ST.hrAt = now(); }
  if (p.STEPS !== undefined)  {
    var t = now(), raw = p.STEPS;
    // The watch step counter keeps climbing while paused (you might walk around
    // at a light). Those steps aren't part of the activity, so while paused we
    // fold each increment into stepAdj (subtracted from the effective total)
    // and skip the cadence window entirely; only moving steps count.
    if (ST.recording && (ST.paused || ST.autopaused)) {
      if (ST.stepPrevRaw !== null && raw >= ST.stepPrevRaw) ST.stepAdj = (ST.stepAdj || 0) + (raw - ST.stepPrevRaw);
    } else {
      var eff = raw - (ST.stepAdj || 0);
      // Cadence is the derivative of a coarse, Bluetooth-delivered step counter.
      // Over one ~5 s message that derivative is dominated by integer-step
      // quantisation and BLE arrival jitter, which throw individual points to
      // ~2x / ~0.5x the true rate (in matched high/low pairs, since the running
      // total stays correct). Average the rate over a short trailing window, with
      // the span snapped to the watch's deterministic 5 s send cadence, to remove
      // the spikes without shifting the bulk value or the run average.
      ST.stepHist = ST.stepHist || [];
      if (ST.stepHist.length && eff < ST.stepHist[ST.stepHist.length - 1].n) ST.stepHist = [];  // counter went backwards: restart
      ST.stepHist.push({ n: eff, at: t });
      while (ST.stepHist.length > 2 && t - ST.stepHist[0].at > C.CAD_WINDOW_MS) ST.stepHist.shift();
      var b0 = ST.stepHist[0], dn = eff - b0.n, dtw = t - b0.at;
      if (dn >= 0 && dtw >= 3500) {
        var span = Math.round(dtw / C.CAD_SAMPLE_MS) * C.CAD_SAMPLE_MS || C.CAD_SAMPLE_MS;
        var spm = dn * 60000 / span;
        if (spm <= 300) { ST.cad = Math.round(spm); ST.cadAt = t; }
      }
      ST.lastSteps = { n: eff, at: t };
      ST.steps = eff;
    }
    ST.stepPrevRaw = raw;
  }
  if (p.CMD !== undefined) {
    if (p.CMD === 1) startRun();
    else if (p.CMD === 2) pauseRun();
    else if (p.CMD === 3) resumeRun();
    else if (p.CMD === 4) stopRun();
    else if (p.CMD === 5) openRunLogPage(0);
    else if (p.CMD === 6) discardLast();
    else if (p.CMD === 7) uploadLast();
  }
  if (p.RENAME !== undefined) renameLast(p.RENAME);
});

function uploadLast() {
  // manual "Upload now" from the debrief: skip the grace wait and send it
  if (ST.upTimer) { clearTimeout(ST.upTimer); ST.upTimer = null; }
  if (ST.lastSaved !== null) {
    var runs = loadRuns();
    for (var i = 0; i < runs.length; i++) {
      if (runs[i].start === ST.lastSaved) {
        rlog('manual upload from watch');
        uploadRun(runs[i]);
        return;
      }
    }
  }
  retryPending();   // nothing pinned; nudge any backlog
}

function discardLast() {
  if (ST.upTimer) { clearTimeout(ST.upTimer); ST.upTimer = null; }
  if (ST.lastSaved === null) return;
  var runs = loadRuns();
  for (var i = 0; i < runs.length; i++) {
    if (runs[i].start === ST.lastSaved) {
      rlog('discarded "' + runs[i].name + '" from the watch');
      runs.splice(i, 1);
      storeRuns(runs);
      break;
    }
  }
  ST.lastSaved = null;
}

/* Voice rename from the watch debrief: rename the just-saved run. The phone
 * copy is always kept; this only changes its name (and the GPX filename). */
function renameLast(raw) {
  if (ST.lastSaved === null) return;
  var name = String(raw || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')
                              .replace(/^\s+|\s+$/g, '');
  if (!name) return;
  var runs = loadRuns();
  for (var i = 0; i < runs.length; i++) {
    if (runs[i].start === ST.lastSaved) {
      var old = runs[i].name;
      runs[i].name = name;
      storeRuns(runs);
      rlog('renamed "' + old + '" -> "' + name + '" (voice)');
      if (runs[i].up === 1) rlog('note: re-upload to update the server copy');
      return;
    }
  }
}
function jsafe(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function openRunLogPage(initialStart) {
  var runs = jsafe(loadRuns());
  var cfg = jsafe(loadCfg());
  var mi = WSET.mi ? 'true' : 'false';
  var initial = jsafe(initialStart || 0);
  var html = PAGE
    .replace('"__RUNLOG_RUNS__"', function () { return runs; })
    .replace('"__RUNLOG_CFG__"', function () { return cfg; })
    .replace('"__RUNLOG_MILES__"', function () { return mi; })
    .replace('"__RUNLOG_INITIAL__"', function () { return initial; })
    .replace('"__RUNLOG_LOG__"', function () {
      var lg = '[]';
      try { lg = localStorage.getItem('runlog.log') || '[]'; } catch (eL) {}
      return lg;
    });
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

Pebble.addEventListener('showConfiguration', function () {
  openRunLogPage(0);
});

/* Decode the page's URL-safe base64 (see closePage in the page). */
function b64udec(str) {
  var T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var out = '', i = 0, buf = 0, bits = 0;
  for (i = 0; i < str.length; i++) {
    var v = T.indexOf(str.charAt(i));
    if (v < 0) continue;                       // '=' padding and noise
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 255);
    }
  }
  return decodeURIComponent(escape(out));      // UTF-8 bytes -> string
}

/* Phone apps disagree on whether the close fragment arrives still
 * percent-encoded, already decoded, or decoded with '+' -> space.  Try
 * every sensible reading; the b64 payload is immune to all of them. */
function parseAction(resp) {
  var cands = [resp], dec = null;
  try { dec = decodeURIComponent(resp); } catch (e) {}
  if (dec !== null && dec !== resp) cands.push(dec);
  for (var i = 0; i < cands.length; i++) {
    var r = cands[i];
    if (!r) continue;
    if (r.slice(0, 4) === 'b64.') {
      try { return JSON.parse(b64udec(r.slice(4))); } catch (e1) {}
    }
    try { return JSON.parse(r); } catch (e2) {}   // legacy plain-JSON closes
  }
  return null;
}

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  var act = parseAction(e.response);
  if (!act || !act.act) return;

  if (act.act === 'cfg' && act.cfg) {
    rlog('settings saved (' + (act.cfg.preset || 'custom') + ')');
    storeCfg({ auto: act.cfg.auto ? 1 : 0,
               preset: act.cfg.preset || 'custom',
               url: act.cfg.url || '',
               auth: act.cfg.auth || '',
               key: act.cfg.key || '',
               user: act.cfg.user || '',
               pass: act.cfg.pass || '',
               name: act.cfg.name || '',
               fmt: (['gpx', 'tcx', 'fit'].indexOf(act.cfg.fmt) >= 0) ? act.cfg.fmt : 'gpx' });
    // settings may point at a different server/account now
    try { localStorage.removeItem('runlog.ftok'); } catch (eft) {}
  } else if (act.act === 'retype' && act.to >= 0 && act.to <= 2) {
    var rr = loadRuns();
    if (act.idx >= 0 && act.idx < rr.length) {
      var rv = rr[act.idx];
      var oldName = rv.name;
      rv.act = act.to;
      rv.name = nameFromTemplate(loadCfg().name, act.to, rv.start);  // re-derive for the new activity
      rv.splits = computeSplits(rv.pts, rv.mi, C.SPLIT_MULT[act.to]);
      if (act.to === 2) {
        rv.cad = 0;            // wrist cadence is meaningless on a bike
        if (rv.pts) { for (var pc = 0; pc < rv.pts.length; pc++) rv.pts[pc][6] = 0; }   // and strip it per-point so GPX/TCX/FIT don't export it
      } else if (!rv.cad && rv.steps > 0 && (rv.mov || 0) >= 30) {
        rv.cad = Math.min(260, Math.round(rv.steps * 60 / rv.mov));
      }
      storeRuns(rr);
      rlog('retyped "' + oldName + '" -> ' + C.ACT_NAME[act.to] + ' ("' + rv.name + '")');
      if (rv.up === 1) rlog('note: re-upload to update the server copy');
    }
  } else if (act.act === 'del') {
    var runs = loadRuns();
    if (act.idx >= 0 && act.idx < runs.length) {
      runs.splice(act.idx, 1);
      storeRuns(runs);
    }
  } else if (act.act === 'retry') {
    var runs2 = loadRuns();
    if (act.idx >= 0 && act.idx < runs2.length) uploadRun(runs2[act.idx]);
  } else if (act.act === 'clear') {
    storeRuns([]);
  }
});
