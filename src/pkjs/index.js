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
  AP_SLOW_N: 3,         // consecutive slow fixes before auto-pause
  AP_FAST_N: 2,         // consecutive fast fixes before auto-resume
  // auto-pause speed thresholds (m/s) per activity: [run, walk, ride]
  AP_SLOW: [0.7, 0.45, 1.0],
  AP_FAST: [1.4, 0.9, 2.2],
  SPLIT_MULT: [1, 1, 5],          // ride splits every 5 km / 5 mi
  ACT_NAME: ['Run', 'Walk', 'Ride'],
  NAME_TPL_DEFAULT: '%Y-%m-%d_{activity}',
  ACT_GPX:  ['running', 'walking', 'cycling'],
  ACC_MIN_DELTA_M: 2,   // resend accuracy when it changes by this much
  ACC_MIN_GAP_MS: 7000, //   ...or this long has passed
  STAT_MIN_S: 3,        // min seconds (fix time) between live stat pushes to the watch
  TRACK_PTS: 64,        // route points sent to the watch summary
  GRAPH_PTS: 48,        // pace/HR samples sent to the watch debrief graphs
  UPLOAD_TIMEOUT_MS: 20000,
  QUEUE_MAX: 30
};

/* settings mirrored from the watch (UP-button menu) */
var WSET = { mi: false, ap: true, splits: true, mode: 0 };  // 0 run, 1 walk, 2 ride

var ST = {
  act: 0, lastT: 0, tsWarned: false, fixLogged: false,
  lastSaved: null, upTimer: null,
  recording: false, paused: false, autopaused: false,
  pts: [], dist: 0, movS: 0, last: null,
  prevFix: null, lastFixAt: 0, slowN: 0, fastN: 0,
  eleSm: null, eleBase: null, egain: 0,
  hr: 0, hrAt: 0, cad: 0, cadAt: 0, lastSteps: null, steps: 0,
  startAt: 0, splitN: 0, segFlag: 0,
  watchId: null, geoWatchdog: null, sending: false, queue: [], lastStatT: 0,
  lastOk: -1, lastAccSent: -1, lastAccAt: 0,
  uploading: false
};

function now() { return Date.now(); }
function unitM(mi) { return mi ? 1609.344 : 1000; }

/* ------------------ AppMessage queue ------------------ */
/* Protected dicts (run results, upload status) are never dropped. */
function send(dict, protect) {
  dict._p = protect ? 1 : 0;
  ST.queue.push(dict);
  if (ST.queue.length > C.QUEUE_MAX) {
    for (var i = 0; i < ST.queue.length; i++) {
      if (!ST.queue[i]._p) { ST.queue.splice(i, 1); break; }
    }
  }
  pump();
}
function pump() {
  if (ST.sending || !ST.queue.length) return;
  ST.sending = true;
  var d = ST.queue.shift();
  delete d._p;
  Pebble.sendAppMessage(d,
    function () { ST.sending = false; pump(); },
    function () { ST.sending = false; pump(); });
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
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });

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
    return Math.round(ts / 1000);
  }
  if (!ST.tsWarned) {
    ST.tsWarned = true;
    rlog('geolocation timestamp unusable (' + ts + '), using wall clock');
  }
  return Math.round(now() / 1000);
}

function onFix(pos) {
  ST.lastFixAt = now();
  var c = pos.coords;
  var good = (c.accuracy !== null && c.accuracy !== undefined &&
              c.accuracy <= C.MAX_ACC_M);
  sendStatus(good ? 1 : 0, c.accuracy);
  if (!good) return;

  if (!ST.fixLogged) {
    ST.fixLogged = true;
    rlog('GPS ok, accuracy ' + Math.round(c.accuracy) + ' m');
  }

  var t = fixTime(pos);
  if (t < ST.lastT) t = ST.lastT;     // GPS clocks must never run backwards
  ST.lastT = t;

  if (!ST.kf) ST.kf = gps.make();
  var sm = ST.kf.update(c.latitude, c.longitude, c.accuracy, t);   // Kalman-smoothed
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
  var rawFix = { t: t, lat: +c.latitude.toFixed(6), lon: +c.longitude.toFixed(6) };

  if (ST.recording && !ST.paused) autoPauseCheck(rawFix);
  var accumulating = ST.recording && !ST.paused && !ST.autopaused;
  ST.prevFix = rawFix;
  if (!accumulating) return;

  if (ST.last) {
    var dt = fix.t - ST.last.t;
    var dm = haversine(ST.last, fix);
    if (dt < C.MIN_GAP_S && dm < 15) return;   // throttle dense fixes
    if (dm < C.MIN_MOVE_M && dt < 15) return;  // jitter while still
    ST.dist += dm;
    ST.movS += Math.min(dt, 10);
  }

  if (fix.ele !== null) trackElevation(fix.ele);

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
  var dt = Math.max(1, fix.t - ST.prevFix.t);
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
  ST.recording = true; ST.paused = false; ST.autopaused = false;
  ST.pts = []; ST.dist = 0; ST.movS = 0;
  ST.last = null; ST.startAt = now(); ST.splitN = 0; ST.segFlag = 0;
  ST.slowN = 0; ST.fastN = 0;
  ST.eleSm = null; ST.eleBase = null; ST.egain = 0;
  ST.steps = 0; ST.lastSteps = null; ST.cad = 0;
  ST.act = WSET.mode;            // mode is locked for the whole activity
  ST.kf = gps.make();            // fresh GPS Kalman filter per run
  ST.lastStatT = 0;              // push the first live stats promptly
  startGeo();                    // re-acquire GPS if a previous run released it
  persistInProgress();
}
function pauseRun() {
  ST.paused = true; ST.autopaused = false;
  ST.slowN = 0; ST.fastN = 0;
  persistInProgress();
}
function resumeRun() {
  ST.paused = false; ST.autopaused = false;
  ST.slowN = 0; ST.fastN = 0;
  ST.last = null; ST.segFlag = 1;
}

function stopRun() {
  ST.recording = false; ST.paused = false; ST.autopaused = false;
  stopGeo();                     // recording over — release GPS to save battery
  var run = finalizeRun({
    startAt: ST.startAt, dist: ST.dist, movS: ST.movS,
    egain: ST.egain, steps: ST.steps, act: ST.act,
    mi: WSET.mi ? 1 : 0, pts: compactPts(ST.pts)
  }, '');
  if (run) {
    rlog('saved "' + run.name + '" (' + Math.round(run.dist) + ' m)');
    saveRun(run);
    send({ SAVED: 1, DIST: run.dist, AVGP: run.avgp, AVGHR: run.avgHr,
           MAXHR: run.maxHr, MOVS: run.mov, EGAIN: run.egain }, true);
    sendTrack(run.pts);
    sendGraphs(run.pts);
    try { localStorage.removeItem('runlog.inprogress'); } catch (e0) {}
    ST.lastSaved = run.start;
    // Uploads are fully user-driven now: nothing leaves the phone until you
    // press Upload on the watch debrief, or Upload/Retry on the phone page.
    /* Best effort: most phone apps only honour openURL from the gear
     * icon (showConfiguration), so this may be a quiet no-op. */
    try { openRunLogPage(run.start); } catch (e1) {}
  } else {
    /* nothing recordable (no GPS) — the watch still keeps time/steps */
    send({ SAVED: 1, DIST: Math.round(ST.dist), AVGP: 0, AVGHR: 0,
           MAXHR: 0, MOVS: Math.round(ST.movS), EGAIN: 0 }, true);
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

function finalizeRun(d, suffix) {
  var cpts = d.pts;
  if (!cpts || cpts.length < 2) return null;
  var sum = 0, n = 0, max = 0, i;
  for (i = 0; i < cpts.length; i++) {
    var hr = cpts[i][4];
    if (hr > 0) { sum += hr; n++; if (hr > max) max = hr; }
  }
  var mov = Math.round(d.movS || 0), dist = Math.round(d.dist);
  var act = (d.act >= 0 && d.act <= 2) ? d.act : 0;
  var dd = new Date(d.startAt);
  function p2(x) { return (x < 10 ? '0' : '') + x; }
  var name = nameFromTemplate(loadCfg().name, act, d.startAt) + suffix;
  return {
    name: name, start: d.startAt,
    dist: dist,
    dur: cpts[cpts.length - 1][0] - cpts[0][0],
    mov: mov,
    avgp: (mov >= 30 && dist >= 50) ? Math.round(mov / (dist / 1000)) : 0,
    avgHr: n ? Math.round(sum / n) : 0,
    maxHr: max,
    egain: Math.round(d.egain || 0),
    cad: (act !== 2 && mov >= 30 && d.steps > 0)
           ? Math.min(260, Math.round(d.steps * 60 / mov)) : 0,
    steps: d.steps || 0,
    mi: d.mi ? 1 : 0,
    act: act,
    splits: computeSplits(cpts, d.mi, C.SPLIT_MULT[act]),
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
  while (runs.length > C.KEEP_RUNS) runs.shift();
  while (JSON.stringify(runs).length > C.MAX_STORE_CHARS && runs.length > 1) runs.shift();
  if (!storeRuns(runs) && runs.length > 1) {   // quota fallback
    runs.shift();
    storeRuns(runs);
  }
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
      egain: ST.egain, steps: ST.steps, act: ST.act,
      mi: WSET.mi ? 1 : 0, pts: compactPts(ST.pts)
    }));
  } catch (e) {}
}
function recoverIfNeeded() {
  var raw = null;
  try { raw = localStorage.getItem('runlog.inprogress'); } catch (e) {}
  if (!raw) return;
  try {
    var ip = JSON.parse(raw);
    if (ip && ip.pts && ip.pts.length > 10) {
      var run = finalizeRun(ip, ' (recovered)');
      if (run) saveRun(run);
    }
  } catch (e2) {}
  try { localStorage.removeItem('runlog.inprogress'); } catch (e3) {}
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
  try {
    var x = new XMLHttpRequest();
    x.open(req.method, req.url, true);
    x.timeout = C.UPLOAD_TIMEOUT_MS;
    for (var hk in req.headers) {
      if (req.headers.hasOwnProperty(hk)) x.setRequestHeader(hk, req.headers[hk]);
    }
    x.onload = function () { cb(x.status, x.responseText); };
    x.onerror = function () { cb(0, ''); };
    x.ontimeout = function () { cb(0, ''); };
    x.send(req.body);
  } catch (e) {
    cb(0, '');
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
  var pw = c.pass || '';
  var fp = pw.length >= 2 ? pw.charAt(0) + '\u2026' + pw.charAt(pw.length - 1)
                          : (pw ? '*' : '');
  rlog('logging in as "' + c.user + '" (password "' + fp + '", ' +
       pw.length + ' chars)');
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
  if (ST.uploading) return;
  var c = loadCfg();
  var ex = exportRun(run, c.fmt);
  var fname = ex.fname;

  function finish(ok, status) {
    ST.uploading = false;
    var still = loadRuns().some(function (r) { return r.start === run.start; });
    if (!still) {
      rlog('upload result for a discarded workout ignored');
      return;
    }
    updateRun(run.start, function (r) { r.up = ok ? 1 : 2; });
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
    if (!c.url || (!ftToken(c) && !canLogin)) return;
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
  if (!req) return;
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
  recoverIfNeeded();
  startGeo();
  sendStatus(0, null, true);
  // (no auto-upload on connect — uploads are user-driven)
});

Pebble.addEventListener('appmessage', function (e) {
  var p = (e && e.payload) || {};
  if (p.UNITS !== undefined)  { WSET.mi = !!p.UNITS; storeWatchSet(); }
  if (p.AUTOP !== undefined)  { WSET.ap = !!p.AUTOP; storeWatchSet(); }
  if (p.SPLITP !== undefined) { WSET.splits = !!p.SPLITP; storeWatchSet(); }
  if (p.MODE !== undefined)   { WSET.mode = (p.MODE >= 0 && p.MODE <= 2) ? p.MODE : 0; storeWatchSet(); }
  if (p.HR !== undefined)     { ST.hr = p.HR; ST.hrAt = now(); }
  if (p.STEPS !== undefined)  {
    var t = now();
    if (ST.lastSteps && t > ST.lastSteps.at) {
      var ds = p.STEPS - ST.lastSteps.n;
      var spm = ds * 60000 / (t - ST.lastSteps.at);
      if (ds >= 0 && spm <= 300) { ST.cad = Math.round(spm); ST.cadAt = t; }
    }
    ST.lastSteps = { n: p.STEPS, at: t };
    ST.steps = p.STEPS;
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
