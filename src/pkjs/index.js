/*
 * RunLog — phone side (PebbleKit JS, ES5)
 *
 * Runs inside the Pebble mobile app while the watchapp is open.
 *  - records GPS (navigator.geolocation), filters bad fixes
 *  - live accuracy readout, auto-pause, km/mi split alerts
 *  - merges HR + step samples from the watch (cadence from step deltas)
 *  - distance, rolling + average pace (always s/km on the wire),
 *    elevation gain with smoothing + hysteresis
 *  - on save: stats bundle + downsampled route shape to the watch,
 *    a compact metadata index and checksummed route journal in localStorage
 *  - manual export/upload to Endurain, FitTrackee, intervals.icu,
 *    Runalyze, WebDAV or a custom webhook
 *  - the app's Settings page is the debrief UI: OSM map, charts,
 *    splits, GPX download, upload + storage management (tools/page.html)
 */

var gpx = require('./gpx');
var tcx = require('./tcx');
var fit = require('./fit');

/* Choose the export body/filename/content-type for the selected format. */
function exportRun(run, fmt) {
  if (!run || !run.pts || run.pts.length < 1) return null;
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
  ACT_COUNT: 4,
  // Per [run, walk, ride, hike]. Hike deliberately stores a sparser route and
  // rejects openly weak fixes: canopy/gorge multipath otherwise accumulates as
  // a back-and-forth track while stopped. GPS acquisition itself stays live so
  // auto-pause can still notice genuine movement promptly.
  MAX_ACC_M: [50, 50, 50, 35],
  MIN_GAP_S: [3, 3, 3, 10],
  MIN_MOVE_M: [2, 2, 2, 4],       // base stationary dead-band
  MIN_MOVE_ACC_FRAC: [0, 0, 0, 0.30], // Hike also scales it with reported uncertainty
  MIN_MOVE_HOLD_S: [15, 15, 15, 60],  // retain a sparse stationary heartbeat
  PACE_WINDOW_S: 60,    // rolling pace window
  KEEP_RUNS: 12,        // newest finished runs kept, subject to the storage cap
  MAX_STORE_CHARS: 2200000,
  POWER: {
    normal: { hrStale: 15000, cadStale: 15000, cadWindow: 15000, cadSample: 5000,
              accDelta: 2, accGap: 7000, statGap: 5 },
    hike:   { hrStale: 75000, cadStale: 75000, cadWindow: 90000, cadSample: 30000,
              accDelta: 10, accGap: 30000, statGap: 30 }
  },
  // Require sustained evidence, not a brief speed wobble. Ride also needs one
  // extra moving fix before resume so a single GPS/coasting burst cannot restart it.
  AP_SLOW_N: [4, 4, 4, 4],
  AP_FAST_N: [2, 2, 3, 3],
  // Hike-only multipath guard: at uncertain accuracy, a sharp reversal whose
  // two legs both fit inside the error radius is stop/noise evidence, not a
  // burst of real speed. It also cannot count toward auto-resume.
  AP_REVERSE_ACC_M: 15,
  AP_REVERSE_COS: -0.35,
  // auto-pause speed thresholds (m/s) per [run, walk, ride, hike]. Hike's
  // lower threshold avoids false pauses on steep, genuinely slow climbs.
  AP_SLOW: [0.65, 0.45, 0.90, 0.30],
  AP_FAST: [1.4, 0.9, 2.2, 0.65],
  SPLIT_MULT: [1, 1, 5, 1],       // ride splits every 5 km / 5 mi
  ACT_NAME: ['Run', 'Walk', 'Ride', 'Hike'],
  NAME_TPL_DEFAULT: '%Y-%m-%d_%H%M_{activity}',   // includes time so same-day runs never share a filename
  MAX_SPEED: [12, 6, 30, 4],      // m/s outlier gate per activity
  KF_ACCEL: [1.0, 0.7, 1.6, 0.4],// plausible acceleration noise: run, walk, ride, hike
  // Core Devices' current PKJS bridge forwards this non-standard option to
  // Android's requested update interval (minimum displacement remains 0 m).
  GPS_FREQUENCY_MS: [1000, 1000, 1000, 2000],
  MOV_CAP_S: 20,                  // cap one inter-fix interval when accruing moving time (guard missed-pause gaps without over-trimming sparse fixes)
  IP_RESUME_MS: 1200000,          // on restart, resume an in-progress run if its checkpoint is younger than this; else recover+save
  GPS_IDLE_MS: 300000,            // release a warmed-up GPS receiver if no run starts within this long
  SEND_RETRY: 4,                  // re-send a failed *protected* AppMessage up to this many times before giving up
  ACT_GPX:  ['running', 'walking', 'cycling', 'hiking'],
  TRACK_PTS: 64,        // route points sent to the watch summary
  GRAPH_PTS: 48,        // pace/HR samples sent to the watch debrief graphs
  UPLOAD_TIMEOUT_MS: 20000,
  ENDURAIN_UPLOAD_TIMEOUT_MS: 90000, // Endurain parses and stores the file before its 201 response
  MAX_PAGE_URL_CHARS: 900000,   // keep the one-shot settings page below fragile data: URL limits
  QUEUE_MAX: 30,
  IP_HEARTBEAT_MS: 60000,
  IP_CHUNK_PTS: 60,
  RUN_CHUNK_PTS: 96,
  WATCH_CHUNK_SAMPLES: 64,
  GPS_STALE_MS: 10000,
  PAUSE_GPS_GRACE_MS: 60000             // short manual pauses stay warm; long breaks release phone GPS
};

/* Workout settings mirrored durably between phone and watch. Activity mode
 * remains watch-local for instant pre-workout selection. `pending` represents
 * a disconnected phone edit; CFGSET=2 gives a newer local watch edit priority. */
var WSET = { mi: false, ap: true, splits: true, mode: 0, maxHr: 190,
             restHr: 0, zone: true, pending: false }; // restHr 0=off

var ST = {
  act: 0, lastT: 0, lastTp: 0, tsWarned: false, fixLogged: false,
  lastSaved: null, upTimer: null, idleTimer: null, pauseGpsTimer: null, sid: 0, lastCmdSeq: 0,
  recording: false, paused: false, autopaused: false,
  activeS: 0, activeAt: 0,
  pts: [], dist: 0, movS: 0, last: null,
  prevFix: null, apVec: null, lastFixAt: 0, slowN: 0, fastN: 0,
  eleSm: null, eleBase: null, egain: 0,
  hr: 0, hrAt: 0, cad: 0, cadAt: 0, lastSteps: null, stepHist: [], steps: 0,
  hrArea: 0, hrSecs: 0, hrPeak: 0, hrAgg: 0, hrAggAt: 0,
  stepAdj: 0, stepPrevRaw: null, lastRaw: null,
  startAt: 0, splitN: 0, segFlag: 0,
  watchId: null, geoFrequency: 0, geoWatchdog: null,
  sending: false, queue: [], lastStatT: 0,
  lastOk: -1, lastAccSent: -1, lastAccAt: 0,
  uploading: false, ipTimer: null, ipPersistedN: 0, ipWarned: false,
  pendingRecovery: null, storeBlocked: false,
  events: [], journalSeq: 0, journalGc: false,
  watchSamples: [], watchAck: 0, watchAckSid: 0, watchAckTimer: null,
  preWatch: null, watchDq: 0, laps: [], watchSetAck: false
};

function now() { return Date.now(); }
function unitM(mi) { return mi ? 1609.344 : 1000; }
function recordEvent(type, at) {
  if (!ST.events) ST.events = [];
  ST.events.push([Math.round((at === undefined ? now() : at) / 1000), type]);
}
function activityIndex(v) {
  var n = Number(v);
  return isFinite(n) && n === Math.floor(n) && n >= 0 && n < C.ACT_COUNT ? n : 0;
}
function activityValue(values, act) {
  return values[activityIndex(act === undefined
    ? (ST.recording ? ST.act : WSET.mode) : act)];
}
function powerProfile(act) {
  if (activityIndex(act === undefined ? ST.act : act) === 3) return C.POWER.hike;
  return C.POWER.normal;
}
function activeNow() {
  return ST.activeS + ((ST.recording && !ST.paused && !ST.autopaused && ST.activeAt)
    ? Math.max(0, (now() - ST.activeAt) / 1000) : 0);
}
function integrateHr(toMs) {
  if (ST.recording && !ST.paused && !ST.autopaused && ST.hrAgg > 0 &&
      ST.hrAggAt > 0 && toMs > ST.hrAggAt) {
    // A missing keepalive must not turn one stale BPM into hours of samples.
    var ds = Math.min((toMs - ST.hrAggAt) / 1000,
                      powerProfile(ST.act).hrStale / 1000);
    ST.hrArea += ST.hrAgg * ds;
    ST.hrSecs += ds;
  }
  if (toMs > ST.hrAggAt) ST.hrAggAt = toMs;
}
function freezeActive() {
  var t = now();
  integrateHr(t);
  ST.activeS = activeNow();
  ST.activeAt = 0;
  ST.hrAggAt = 0;
}
function resumeActive() {
  ST.activeAt = now();
  if (ST.hr > 0 && ST.activeAt - ST.hrAt < powerProfile(ST.act).hrStale) {
    ST.hrAgg = ST.hr;
    ST.hrAggAt = ST.activeAt;
  }
}
function phoneState() {
  if (ST.recording) return (ST.paused || ST.autopaused) ? 2 : 1;
  return (ST.lastSaved !== null && ST.sid === ST.lastSaved) ? 4 : 0;
}
function wireSid(v) {
  return (typeof v === 'number' && isFinite(v) && v >= 0 && v <= 0xFFFFFFFF) ? v : 0;
}

// One coherent live snapshot is shared by periodic GPS telemetry and by the
// protected state reply to a watch HELLO. The latter powers screen-tap refresh:
// reconnecting or explicitly refreshing cannot leave one tile a cadence behind
// another, and it does not require another protocol command or radio packet.
function appendLiveStats(d, includeGps) {
  if (!ST.recording) return d;
  d.DIST = Math.round(ST.dist);
  d.PACE = curPace();
  d.EGLIVE = Math.round(ST.egain || 0);
  d.MOVLIVE = Math.round(ST.movS || 0);
  d.AVGHRLIVE = ST.hrSecs > 0 ? Math.round(ST.hrArea / ST.hrSecs) : 0;
  var lb = ST.laps.length ? ST.laps[ST.laps.length - 1] : { active: 0, dist: 0 };
  var la = Math.max(0, activeNow() - lb.active);
  var ld = Math.max(0, ST.dist - lb.dist);
  d.LAPN = ST.laps.length + 1;
  d.LAPD = Math.round(ld);
  d.LAPT = Math.round(la);
  d.LAPP = (ld >= 10 && la > 0) ? Math.round(la / (ld / 1000)) : 0;
  if (includeGps && ST.lastOk >= 0) {
    d.GPSOK = ST.lastOk;
    if (ST.lastOk && ST.lastAccSent >= 0) d.ACC = ST.lastAccSent;
  }
  return d;
}

function sendState(ack, result) {
  var target = loadCfg().target;
  var d = {
    PROTO: 3,
    SID: wireSid(ST.sid),
    WSTATE: phoneState(),
    ACTIVE: Math.max(0, Math.round(activeNow())),
    STARTTS: ST.startAt ? Math.round(ST.startAt / 1000) : 0,
    APAUSE: ST.autopaused ? 1 : 0,
    TGTYPE: target.type,
    TGLO: target.lo,
    TGHI: target.hi,
    TGVAL: target.value
  };
  var cfgKind = ST.watchSetAck ? 2 : (WSET.pending ? 1 : 0);
  if (cfgKind) {
    d.CFGSET = cfgKind;
    d.UNITS = WSET.mi ? 1 : 0;
    d.AUTOP = WSET.ap ? 1 : 0;
    d.SPLITP = WSET.splits ? 1 : 0;
    d.MHR = WSET.maxHr;
    d.RHR = WSET.restHr;
    d.HRZONE = WSET.zone ? 1 : 0;
  }
  if (ST.watchSetAck) ST.watchSetAck = false;
  if (ack !== undefined && ack !== null) d.ACK = ack;
  if (result !== undefined && result !== null) d.RESULT = result ? 1 : 0;
  appendLiveStats(d, true);
  send(d, true);
}

/* ------------------ AppMessage queue ------------------ */
/* Protected dicts (run results, upload status) are retried on failure and never
 * silently dropped: APP_MSG_OK from a send does not mean the watch received it,
 * so on the error callback we keep the message at the head of the queue and
 * re-send (with backoff) up to SEND_RETRY times. */
function send(dict, protect) {
  if (ST.watchAck && dict.WSACK === undefined &&
      (dict.SID === undefined || (dict.SID >>> 0) === (ST.watchAckSid >>> 0))) {
    dict.WSACK = ST.watchAck;
    if (dict.SID === undefined) dict.SID = wireSid(ST.watchAckSid);
    ST.watchAck = 0; ST.watchAckSid = 0;
    if (ST.watchAckTimer) clearTimeout(ST.watchAckTimer);
    ST.watchAckTimer = null;
  }
  dict._p = protect ? 1 : 0;
  dict._retry = 0;
  if (!protect) {
    var slot = (dict.DIST !== undefined || dict.PACE !== undefined) ? 'live' :
               (dict.GPSOK !== undefined || dict.ACC !== undefined) ? 'gps' : '';
    if (slot) {
      dict._slot = slot;
      // A queued telemetry snapshot has no ordering value once a newer one exists.
      for (var qi = ST.queue.length - 1; qi >= (ST.sending ? 1 : 0); qi--) {
        if (!ST.queue[qi]._p && ST.queue[qi]._slot === slot) {
          ST.queue[qi] = dict;
          pump();
          return;
        }
      }
    }
  }
  ST.queue.push(dict);
  if (ST.queue.length > C.QUEUE_MAX) {
    for (var i = 0; i < ST.queue.length; i++) {
      if (!ST.queue[i]._p) { ST.queue.splice(i, 1); break; }   // evict an unprotected one, never a protected one
    }
  }
  pump();
}
function cleanDict(d) { var o = {}, k; for (k in d) { if (k.charAt(0) !== '_' && d.hasOwnProperty(k)) o[k] = d[k]; } return o; }
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

function statusDelta(ok, acc, force) {
  var d = {}, t = now();
  if (force || ok !== ST.lastOk) { d.GPSOK = ok; ST.lastOk = ok; }
  if (ok && acc !== null && acc !== undefined) {
    var a = Math.round(acc);
    var profile = powerProfile();
    if (force || Math.abs(a - ST.lastAccSent) >= profile.accDelta ||
        (a !== ST.lastAccSent && t - ST.lastAccAt > profile.accGap)) {
      d.ACC = a; ST.lastAccSent = a; ST.lastAccAt = t;
    }
  }
  return d;
}
function sendIfAny(d, protect) {
  for (var k in d) {
    if (d.hasOwnProperty(k)) { send(d, protect); return true; }
  }
  return false;
}
function sendStatus(ok, acc, force) {
  sendIfAny(statusDelta(ok, acc, force));
}

/* ------------------ Watch sensor journal ------------------ */
function watchJournalStem(kind, sid) { return 'runlog.' + kind + '.' + (sid >>> 0); }
function watchJournalMetaKey(kind, sid) { return watchJournalStem(kind, sid) + '.meta'; }
function watchJournalChunkKey(kind, sid, i) { return watchJournalStem(kind, sid) + '.' + i; }

function loadWatchJournalMeta(kind, sid) {
  var meta = null;
  try { meta = JSON.parse(localStorage.getItem(watchJournalMetaKey(kind, sid)) || 'null'); }
  catch (e) { meta = null; }
  return meta && meta.v === 1 ? meta : null;
}

function loadWatchJournal(kind, sid) {
  var out = [], meta = loadWatchJournalMeta(kind, sid);
  if (!meta) return out;
  for (var i = 0; i < (meta.chunks || 0); i++) {
    try {
      var c = JSON.parse(localStorage.getItem(watchJournalChunkKey(kind, sid, i)) || '[]');
      if (!isArray(c)) break;
      out = out.concat(c);
    } catch (e2) { break; }
  }
  if (out.length > (meta.n || 0)) out.length = meta.n;
  return out;
}

function loadWatchJournalDq(kind, sid) {
  var meta = loadWatchJournalMeta(kind, sid);
  return meta && meta.dq ? 1 : 0;
}

function clearWatchJournal(kind, sid) {
  var meta = null;
  try { meta = JSON.parse(localStorage.getItem(watchJournalMetaKey(kind, sid)) || 'null'); }
  catch (e) {}
  for (var i = 0; meta && i < (meta.chunks || 0); i++) {
    try { localStorage.removeItem(watchJournalChunkKey(kind, sid, i)); } catch (e2) {}
  }
  try { localStorage.removeItem(watchJournalMetaKey(kind, sid)); } catch (e3) {}
}

/* Rewrites at most the current 64-sample tail chunk, so persistence work stays
 * bounded on an all-day workout. The metadata is the commit point; ACK is only
 * emitted after both the chunk and metadata verify. */
function persistWatchJournal(kind, sid, samples, dq) {
  if (!sid || !samples.length) return 0;
  try {
    var old = JSON.parse(localStorage.getItem(watchJournalMetaKey(kind, sid)) || 'null') || { n: 0 };
    var K = C.WATCH_CHUNK_SAMPLES;
    var committed = Math.max(0, Math.min(old.n || 0, samples.length));
    var first = Math.floor(Math.max(0, committed - 1) / K);
    var chunks = Math.ceil(samples.length / K);
    for (var i = first; i < chunks; i++) {
      var raw = JSON.stringify(samples.slice(i * K, Math.min(samples.length, (i + 1) * K)));
      var key = watchJournalChunkKey(kind, sid, i);
      localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw new Error('watch journal verify failed');
    }
    var meta = JSON.stringify({ v: 1, n: samples.length, chunks: chunks,
                                ack: samples[samples.length - 1][0],
                                dq: (dq || old.dq) ? 1 : 0 });
    localStorage.setItem(watchJournalMetaKey(kind, sid), meta);
    if (localStorage.getItem(watchJournalMetaKey(kind, sid)) !== meta)
      throw new Error('watch journal metadata verify failed');
    return samples[samples.length - 1][0];
  } catch (e) {
    rlog('WARNING: watch sample journal could not be stored');
    return 0;
  }
}

function decodeWatchSamples(bytes) {
  if (!bytes || bytes.length < 12) return [];
  var out = [];
  for (var i = 0; i + 11 < bytes.length; i += 12) {
    var at = Number(bytes[i]) + Number(bytes[i + 1]) * 256 +
             Number(bytes[i + 2]) * 65536 + Number(bytes[i + 3]) * 16777216;
    var active = Number(bytes[i + 4]) + Number(bytes[i + 5]) * 256;
    var steps = Number(bytes[i + 8]) + Number(bytes[i + 9]) * 256 +
                Number(bytes[i + 10]) * 65536;
    var flags = Number(bytes[i + 11]);
    if (at > 1000000000 && at < 4000000000)
      out.push([at, active, Number(bytes[i + 6]), Number(bytes[i + 7]),
                steps, flags & 7, flags & 128 ? 1 : 0]);
  }
  return out;
}

function mergeWatchSamples(dst, incoming) {
  for (var i = 0; i < incoming.length; i++) {
    var n = incoming[i], found = -1;
    for (var j = dst.length - 1; j >= 0 && dst[j][0] >= n[0]; j--)
      if (dst[j][0] === n[0]) { found = j; break; }
    if (found >= 0) {
      n[6] = n[6] || dst[found][6];
      dst[found] = n;
    } else {
      dst.push(n);
    }
  }
  dst.sort(function (a, b) { return a[0] - b[0]; });
}

function distanceAtWatchTime(at) {
  var pts = ST.pts || [], d = 0;
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    if (b.seg) continue;
    var dm = haversine(a, b);
    if (b.t <= at) { d += dm; continue; }
    if (a.t < at && b.t > a.t) d += dm * (at - a.t) / (b.t - a.t);
    break;
  }
  return Math.max(0, Math.min(ST.dist, d));
}

function markManualLap(sample) {
  if (!sample[6]) return;
  for (var i = 0; i < ST.laps.length; i++) if (ST.laps[i].at === sample[0]) return;
  ST.laps.push({ at: sample[0], active: sample[1], dist: distanceAtWatchTime(sample[0]) });
  ST.laps.sort(function (a, b) { return a.at - b.at; });
  recordEvent('lap', sample[0] * 1000);
}

function clearWatchAck() {
  ST.watchAck = 0; ST.watchAckSid = 0;
  if (ST.watchAckTimer) clearTimeout(ST.watchAckTimer);
  ST.watchAckTimer = null;
}
function queueWatchAck(sid, ack, immediate) {
  if (!ack) return;
  ST.watchAck = Math.max(ST.watchAck || 0, ack);
  ST.watchAckSid = sid >>> 0;
  if (ST.watchAckTimer) clearTimeout(ST.watchAckTimer);
  if (immediate) {
    var a = ST.watchAck, s = ST.watchAckSid;
    clearWatchAck();
    send({ PROTO: 3, SID: wireSid(s), WSACK: a }, true);
  } else {
    ST.watchAckTimer = setTimeout(function () {
      var a2 = ST.watchAck, s2 = ST.watchAckSid;
      clearWatchAck();
      if (a2) send({ PROTO: 3, SID: wireSid(s2), WSACK: a2 }, false);
    }, 15000);
    if (ST.watchAckTimer && ST.watchAckTimer.unref) ST.watchAckTimer.unref();
  }
}

function ingestWatchSamples(p, sid) {
  var incoming = decodeWatchSamples(p.WSAMPLES);
  if (!sid || !incoming.length) return;
  var active = ST.recording && (ST.sid >>> 0) === (sid >>> 0);
  var kind, samples;
  if (active) {
    kind = 'ipw'; samples = ST.watchSamples;
  } else {
    kind = 'prew';
    if (!ST.preWatch || (ST.preWatch.sid >>> 0) !== (sid >>> 0))
      ST.preWatch = { sid: sid, samples: loadWatchJournal(kind, sid),
                      dq: loadWatchJournalDq(kind, sid) };
    samples = ST.preWatch.samples;
  }
  mergeWatchSamples(samples, incoming);
  if (active) for (var i = 0; i < incoming.length; i++) markManualLap(incoming[i]);
  if (p.DQ) {
    if (active) ST.watchDq = 1;
    else ST.preWatch.dq = 1;
  }
  var ack = persistWatchJournal(kind, sid, samples,
                                active ? ST.watchDq : ST.preWatch.dq);
  queueWatchAck(sid, ack, !!p.WSFLUSH);
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
function newTrackFilter() {
  return gps.make({
    accelStd: activityValue(C.KF_ACCEL, ST.act),
    maxSpeed: activityValue(C.MAX_SPEED, ST.act)
  });
}

function startGeo() {
  if (!navigator.geolocation) { sendStatus(0, null, false); return; }
  var frequency = activityValue(C.GPS_FREQUENCY_MS);
  if (ST.watchId !== null && ST.watchId !== undefined) {
    if (ST.geoFrequency === frequency) return;       // already acquiring at this profile
    navigator.geolocation.clearWatch(ST.watchId);    // activity changed while GPS was warm
    ST.watchId = null;
    if (ST.geoWatchdog !== null) clearTimeout(ST.geoWatchdog);
    ST.geoWatchdog = null;
  }
  ST.watchId = navigator.geolocation.watchPosition(onFix, function () {
    sendStatus(0, null, false);
  }, { enableHighAccuracy: true, frequency: frequency });
  ST.geoFrequency = frequency;
  ST.lastFixAt = now();
  armGeoWatchdog(C.GPS_STALE_MS);
}

/* A deadline-driven watchdog wakes about once per stale interval. The old
 * fixed six-second poll woke the phone twice as often even while fixes were
 * arriving normally. */
function armGeoWatchdog(delay) {
  if (ST.geoWatchdog !== null) clearTimeout(ST.geoWatchdog);
  if (ST.watchId === null || ST.watchId === undefined) {
    ST.geoWatchdog = null;
    return;
  }
  ST.geoWatchdog = setTimeout(function () {
    ST.geoWatchdog = null;
    if (ST.watchId === null || ST.watchId === undefined) return;
    var age = now() - ST.lastFixAt;
    if (age >= C.GPS_STALE_MS) {
      sendStatus(0, null, false);
      return;  // a later fix re-arms us; do not poll a prolonged outage
    }
    armGeoWatchdog(C.GPS_STALE_MS - age);
  }, Math.max(1000, delay || C.GPS_STALE_MS));
  if (ST.geoWatchdog && ST.geoWatchdog.unref) ST.geoWatchdog.unref();
}

/* Release the GPS receiver. High-accuracy GPS is by far the biggest battery
 * draw and is pure waste once a run is saved, so we stop it the moment
 * recording ends and re-acquire on the next start. */
function stopGeo() {
  if (navigator.geolocation && ST.watchId !== null && ST.watchId !== undefined) {
    navigator.geolocation.clearWatch(ST.watchId);
  }
  ST.watchId = null;
  ST.geoFrequency = 0;
  if (ST.geoWatchdog !== null) clearTimeout(ST.geoWatchdog);
  ST.geoWatchdog = null;
}

function cancelPauseGpsRelease() {
  if (ST.pauseGpsTimer) clearTimeout(ST.pauseGpsTimer);
  ST.pauseGpsTimer = null;
}

/* A short manual pause keeps GPS warm for a seamless restart. If the break
 * lasts longer, the route is already segmented and paused time is excluded, so
 * every activity can release the receiver without dropping a workout point.
 * Auto-pause deliberately keeps GPS on so movement can trigger auto-resume. */
function armPauseGpsRelease() {
  cancelPauseGpsRelease();
  ST.pauseGpsTimer = setTimeout(function () {
    ST.pauseGpsTimer = null;
    if (ST.recording && ST.paused) {
      stopGeo();
      sendStatus(0, null, false);
      rlog('released GPS during long manual pause');
    }
  }, C.PAUSE_GPS_GRACE_MS);
  if (ST.pauseGpsTimer && ST.pauseGpsTimer.unref) ST.pauseGpsTimer.unref();
}

/* Reconciliation has no reliable "pause began" timestamp, so a restored manual
 * pause is conservatively treated as long. Auto-paused/running sessions keep
 * GPS active. */
function restoreGeoForSession() {
  cancelPauseGpsRelease();
  if (!ST.recording) return;
  if (ST.paused) stopGeo();
  else startGeo();
}

/* All pace / moving-time / GPX-time maths runs on the fix timestamp, but
 * not every phone app's geolocation bridge fills pos.timestamp in sanely
 * (missing, 0, boot-relative or seconds instead of ms have all been seen
 * in the wild).  Only trust it when it looks like a real epoch-ms value;
 * otherwise fall back to the wall clock, which is what "now" means anyway
 * for a fix that just arrived. */
function fixTime(pos) {
  var ts = pos ? pos.timestamp : null;
  var wall = now();
  if (typeof ts === 'number' && isFinite(ts) && ts > 1e12 && ts < 4e12 &&
      Math.abs(ts - wall) <= 300000) {
    return ts / 1000;                       // fractional seconds — keep sub-second precision
  }
  if (!ST.tsWarned) {
    ST.tsWarned = true;
    rlog('geolocation timestamp unusable (' + ts + '), using wall clock');
  }
  return wall / 1000;
}

function onFix(pos) {
  ST.lastFixAt = now();
  if (ST.geoWatchdog === null && ST.watchId !== null && ST.watchId !== undefined)
    armGeoWatchdog(C.GPS_STALE_MS);
  var c = pos && pos.coords;
  if (!c) {
    ST.slowN = 0; ST.fastN = 0; ST.apVec = null;
    sendStatus(0, null, false);
    return;
  }
  var maxAcc = activityValue(C.MAX_ACC_M);
  var good = (c.accuracy !== null && c.accuracy !== undefined && isFinite(c.accuracy) &&
              c.accuracy >= 0 && c.accuracy <= maxAcc &&
              isFinite(c.latitude) && c.latitude >= -90 && c.latitude <= 90 &&
              isFinite(c.longitude) && c.longitude >= -180 && c.longitude <= 180);
  if (!good) {
    // Auto-pause evidence must be consecutive trustworthy fixes. Do not bridge
    // an accuracy outage with counters collected on either side of it.
    ST.slowN = 0; ST.fastN = 0; ST.apVec = null;
    sendStatus(0, null, false);
    return;
  }

  if (!ST.fixLogged) {
    ST.fixLogged = true;
    rlog('GPS ok, accuracy ' + Math.round(c.accuracy) + ' m');
  }

  // READY warm-up and manual pauses need only the fix indicator. Starting or
  // resuming creates a fresh filter, so running every idle fix through the
  // Kalman/elevation path was pure CPU work.
  if (!ST.recording || ST.paused) {
    sendIfAny(statusDelta(1, c.accuracy, false));
    return;
  }

  var tp = fixTime(pos);                 // fractional seconds — ms precision for the filter & auto-pause
  // A duplicate or reordered timestamp cannot carry a defensible displacement.
  // Skipping it is safer than coercing dt to a tiny positive value, which used
  // to turn an ordinary coordinate delta into a kilometre-per-second velocity.
  if (ST.lastTp > 0 && tp <= ST.lastTp) {
    sendIfAny(statusDelta(1, c.accuracy, false));
    return;
  }
  var t = Math.round(tp);
  if (t < ST.lastT) t = ST.lastT;

  var rawFix = { t: tp, lat: Math.round(c.latitude * 1e6) / 1e6,
                 lon: Math.round(c.longitude * 1e6) / 1e6,
                 acc: c.accuracy,
                 speed: (typeof c.speed === 'number' && isFinite(c.speed) &&
                         c.speed >= 0 && c.speed <= activityValue(C.MAX_SPEED, ST.act))
                          ? c.speed : null };

  // A location return after the stale boundary is a new observation segment.
  // Never draw, time or measure the unseen interval as one straight route edge.
  if (ST.lastTp > 0 && (tp - ST.lastTp) * 1000 >= C.GPS_STALE_MS) {
    ST.last = null; ST.lastRaw = null; ST.prevFix = null; ST.apVec = null;
    ST.slowN = 0; ST.fastN = 0;
    if (ST.pts.length) ST.segFlag = 1;
    ST.kf = newTrackFilter();
  }

  // Outlier gate on RAW coordinates, BEFORE the filter, auto-pause or prevFix see
  // the fix. Only closely-spaced fixes are gated (a real GPS stream); a large time
  // gap (after a pause or a restart) can legitimately jump far and starts a fresh
  // segment, so it's never treated as an outlier.
  if (ST.recording && !ST.paused && !ST.autopaused && ST.lastRaw) {
    var gdt = tp - ST.lastRaw.t;
    if (gdt > 0 && gdt < 30 &&
        haversine(ST.lastRaw, rawFix) / gdt > activityValue(C.MAX_SPEED, ST.act)) {
      ST.slowN = 0; ST.fastN = 0; ST.apVec = null;
      sendIfAny(statusDelta(0, null, false));
      return;
    }
  }
  // While moving, reject a measurement atomically before it can affect route
  // clocks, auto-pause evidence or the next raw-coordinate gate. Auto-paused
  // fixes deliberately skip trajectory work; a successful resume anchors a
  // fresh segment below.
  var sm = null;
  if (!ST.autopaused) {
    if (!ST.kf) ST.kf = newTrackFilter();
    sm = ST.kf.update(c.latitude, c.longitude, c.accuracy, tp);
    if (sm.accepted === false) {
      ST.slowN = 0; ST.fastN = 0; ST.apVec = null;
      sendIfAny(statusDelta(0, null, false));
      return;
    }
  }

  var telemetry = statusDelta(1, c.accuracy, false);
  // Commit route clocks only after validation and the innovation gate.
  ST.lastTp = tp;
  ST.lastT = t;

  // Auto-pause keys off RAW GPS speed: the Kalman filter adds velocity inertia
  // that lags a sudden stop, which would make pause/resume sluggish. Distance,
  // track and splits use the smoothed fix; only stop/resume detection sees raw.
  // Auto-paused fixes still do only the raw work needed for auto-resume.
  autoPauseCheck(rawFix);
  var accumulating = ST.recording && !ST.paused && !ST.autopaused;
  ST.prevFix = rawFix;
  if (accumulating) ST.lastRaw = rawFix;   // reference the next outlier check compares against
  if (!accumulating) { sendIfAny(telemetry); return; }

  // A fix that triggered auto-resume was intentionally not fed through the
  // stale pre-pause filter. autoPauseCheck() reset it, so anchor the new segment.
  if (!sm) {
    if (!ST.kf) ST.kf = newTrackFilter();
    sm = ST.kf.update(c.latitude, c.longitude, c.accuracy, tp);
  }
  var fix = {
    t: t,
    lat: sm.lat,
    lon: sm.lon,
    ele: (c.altitude === null || c.altitude === undefined ||
          !isFinite(c.altitude) || c.altitude < -500 || c.altitude > 10000)
           ? null : Math.round(c.altitude * 10) / 10
  };

  if (ST.last) {
    var dt = fix.t - ST.last.t;
    var dm = haversine(ST.last, fix);
    var minMove = activityValue(C.MIN_MOVE_M, ST.act);
    var accFloor = activityValue(C.MIN_MOVE_ACC_FRAC, ST.act);
    if (accFloor > 0) minMove = Math.max(minMove, Math.min(10, c.accuracy * accFloor));
    if (dt < activityValue(C.MIN_GAP_S, ST.act) && dm < 15) {
      sendIfAny(telemetry);
      return;
    }   // throttle dense fixes; Hike keeps a deliberately sparser route
    if (dm < minMove && dt < activityValue(C.MIN_MOVE_HOLD_S, ST.act)) {
      sendIfAny(telemetry);
      return;
    }   // accuracy-aware stationary jitter floor; never suppress a heartbeat forever
    ST.dist += dm;
    ST.movS += Math.min(dt, C.MOV_CAP_S);
  }

  // Feed raw altitude to the gain accumulator (its 3 m dead-band does the
  // noise rejection for the stat), but STORE the smoothed value on the point:
  // GPS vertical noise would otherwise make a flat run's exported gain balloon
  // (this run: 107 m raw vs 23 m as displayed). Keeps every export consistent.
  if (fix.ele !== null) { trackElevation(fix.ele); fix.ele = Math.round(ST.eleSm * 10) / 10; }

  var profile = powerProfile(ST.act);
  fix.hr = (now() - ST.hrAt < profile.hrStale) ? ST.hr : 0;
  fix.cad = (now() - ST.cadAt < profile.cadStale) ? ST.cad : 0;
  fix.seg = ST.segFlag; ST.segFlag = 0;
  ST.pts.push(fix);
  ST.last = fix;

  var mult = activityValue(C.SPLIT_MULT, ST.act);
  var n = Math.floor(ST.dist / (unitM(WSET.mi) * mult));
  if (n > ST.splitN) {
    ST.splitN = n;
    if (WSET.splits) telemetry.SPLIT = n * mult;   // watch shows "KM 5", "KM 10"…
  }

  if (t - ST.lastStatT >= powerProfile(ST.act).statGap) {
    ST.lastStatT = t;
    appendLiveStats(telemetry, false);
  }
  // Accuracy, split and live stats produced by one fix share one radio packet.
  // Split alerts are protected so queue coalescing can never discard a milestone.
  sendIfAny(telemetry, telemetry.SPLIT !== undefined);

  if (ST.pts.length % 15 === 0) persistInProgress();
}

/* Auto-pause: N slow fixes in a row pause the run; M fast ones resume it. */
function autoPauseCheck(fix) {
  if (!ST.prevFix) { ST.apVec = null; return; }
  var dt = fix.t - ST.prevFix.t;
  if (dt <= 0) return;                 // duplicate / zero-delta fix: don't fabricate a speed
  if (dt * 1000 >= C.GPS_STALE_MS) {
    // A return from a GPS outage is a new observation boundary, not evidence
    // that the athlete stopped or resumed throughout the unseen interval.
    ST.slowN = 0; ST.fastN = 0; ST.apVec = null;
    return;
  }
  // Preserve direction as well as scalar speed for Hike. In a gorge, two
  // uncertain positions commonly alternate across the true location: scalar
  // speed calls every leg "fast", while the near-180-degree reversals reveal
  // that there is no credible forward progress. Accurate switchbacks are left
  // alone, as are all other activity modes.
  var midLat = rad((ST.prevFix.lat + fix.lat) / 2);
  var vx = rad(fix.lon - ST.prevFix.lon) * 6371000 * Math.cos(midLat);
  var vy = rad(fix.lat - ST.prevFix.lat) * 6371000;
  var vm = Math.sqrt(vx * vx + vy * vy);
  var uncertainReverse = false;
  if (ST.act === 3 && ST.apVec && vm >= 2 && ST.apVec.m >= 2) {
    var uncertainty = Math.max(fix.acc || 0, ST.prevFix.acc || 0,
                               ST.apVec.acc || 0);
    var cosine = (vx * ST.apVec.x + vy * ST.apVec.y) / (vm * ST.apVec.m);
    uncertainReverse = uncertainty >= C.AP_REVERSE_ACC_M &&
                       vm <= uncertainty && ST.apVec.m <= uncertainty &&
                       cosine <= C.AP_REVERSE_COS;
  }
  ST.apVec = { x: vx, y: vy, m: vm,
               acc: Math.max(fix.acc || 0, ST.prevFix.acc || 0) };
  // Android receiver speed can be Doppler-derived and steadier than coordinate
  // differences. The bridge exposes no speed uncertainty, so trust it only
  // when finite/plausible and paired with a reasonably accurate position.
  var v = (fix.speed !== null && fix.acc <= 25) ? fix.speed : vm / dt;

  if (!ST.autopaused) {
    if (WSET.ap && (v < activityValue(C.AP_SLOW, ST.act) || uncertainReverse)) {
      if (++ST.slowN >= activityValue(C.AP_SLOW_N, ST.act)) {
        freezeActive();
        ST.autopaused = true; ST.slowN = 0; ST.fastN = 0;
        recordEvent('auto_pause');
        persistInProgress();
        sendState();
      }
    } else ST.slowN = 0;
  } else {
    if (v > activityValue(C.AP_FAST, ST.act) && !uncertainReverse) {
      if (++ST.fastN >= activityValue(C.AP_FAST_N, ST.act)) {
        ST.autopaused = false; ST.fastN = 0; ST.slowN = 0;
        ST.last = null; ST.segFlag = 1;     // new GPX segment on resume
        ST.stepHist = [];                   // fresh cadence window after the paused stretch
        ST.kf = newTrackFilter();           // paused fixes skipped filtering; restart cleanly here
        resumeActive();
        recordEvent('auto_resume');
        persistInProgress();
        sendState();
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

/* ------------------ Run lifecycle ------------------ */
function startRun(sid, startAt) {
  if (ST.recording) return;      // idempotent: a duplicate START must not reset a live run
  if (ST.pendingRecovery && !finalizeRecovery(ST.pendingRecovery)) return;
  cancelPauseGpsRelease();
  clearInProgress();             // discard only after an explicit new-session intent
  ST.lastRaw = null; ST.prevFix = null; ST.apVec = null;
  ST.recording = true; ST.paused = false; ST.autopaused = false;
  ST.pts = []; ST.dist = 0; ST.movS = 0;
  ST.last = null;
  ST.startAt = (startAt && isFinite(startAt) && startAt > 0 && startAt <= now() + 300000)
                 ? startAt : now();
  ST.splitN = 0; ST.segFlag = 0;
  ST.lastT = 0; ST.lastTp = 0;
  ST.slowN = 0; ST.fastN = 0; ST.apVec = null;
  ST.eleSm = null; ST.eleBase = null; ST.egain = 0;
  ST.steps = 0; ST.lastSteps = null; ST.stepHist = []; ST.cad = 0;
  ST.stepAdj = 0; ST.stepPrevRaw = null;
  ST.hr = 0; ST.hrAt = 0;        // don't carry the previous run's HR into this one
  ST.hrArea = 0; ST.hrSecs = 0; ST.hrPeak = 0; ST.hrAgg = 0; ST.hrAggAt = 0;
  ST.sid = wireSid(sid) || ((now() >>> 0) || 1); // always a non-zero uint32 on the wire
  ST.lastCmdSeq = 0;
  ST.events = [];
  ST.watchSamples = []; ST.watchDq = 0; ST.laps = [];
  recordEvent('start', ST.startAt);
  ST.activeS = 0; ST.activeAt = now();
  ST.act = activityIndex(WSET.mode);  // mode is locked for the whole activity
  var pre = null;
  if (ST.preWatch && (ST.preWatch.sid >>> 0) === (ST.sid >>> 0)) pre = ST.preWatch;
  else {
    var preSamples = loadWatchJournal('prew', ST.sid);
    if (preSamples.length)
      pre = { sid: ST.sid, samples: preSamples,
              dq: loadWatchJournalDq('prew', ST.sid) };
  }
  if (pre) {
    ST.watchSamples = pre.samples.slice();
    ST.watchDq = pre.dq ? 1 : 0;
    for (var wi = 0; wi < ST.watchSamples.length; wi++) markManualLap(ST.watchSamples[wi]);
    if (persistWatchJournal('ipw', ST.sid, ST.watchSamples, ST.watchDq)) {
      clearWatchJournal('prew', ST.sid);
      ST.preWatch = null;
    }
  }
  ST.kf = newTrackFilter();       // fresh GPS Kalman filter per run
  ST.lastStatT = 0;              // push the first live stats promptly
  if (ST.idleTimer) { clearTimeout(ST.idleTimer); ST.idleTimer = null; }
  startGeo();                    // re-acquire GPS if a previous run released it
  persistInProgress();
}
function pauseRun() {
  if (!ST.recording || ST.paused) return;   // idempotent
  freezeActive();
  ST.lastRaw = null;   // first fix after resume starts a fresh segment (not gated)
  ST.paused = true; ST.autopaused = false;
  ST.slowN = 0; ST.fastN = 0; ST.apVec = null;
  ST.stepHist = [];              // a pre-pause sample must not seed the first post-pause cadence
  armPauseGpsRelease();
  recordEvent('pause');
  persistInProgress();
}
function resumeRun() {
  if (!ST.recording || (!ST.paused && !ST.autopaused)) return;   // idempotent: nothing to resume if not paused
  cancelPauseGpsRelease();
  ST.paused = false; ST.autopaused = false;
  ST.slowN = 0; ST.fastN = 0; ST.apVec = null;
  ST.last = null; ST.lastRaw = null; ST.segFlag = 1;
  ST.kf = newTrackFilter();       // manual-pause fixes skipped filtering
  ST.stepHist = [];
  resumeActive();
  startGeo();                    // may have been released during a long manual Hike pause
  recordEvent('resume');
  persistInProgress();
}

function sendNoSaveForCurrentSession() {
  var failedSid = ST.sid;
  send({ NOSAVE: 1, PROTO: 3, SID: wireSid(failedSid) }, true);
  // The tagged NOSAVE clears this workout on the watch. Any following
  // command ACK/state snapshot must describe the resulting blank recorder,
  // not re-advertise the discarded identifier with WSTATE=READY.
  ST.sid = 0;
}

function stopRun() {
  if (!ST.recording) return;     // idempotent: a duplicate STOP does nothing (never send NOSAVE over a prior SAVED)
  freezeActive();
  ST.recording = false; ST.paused = false; ST.autopaused = false;
  cancelPauseGpsRelease();
  disarmIpHeartbeat();
  stopGeo();                     // recording over — release GPS to save battery
  recordEvent('stop');
  var run = finalizeRun({
    startAt: ST.startAt, dist: ST.dist, movS: ST.movS,
    egain: ST.egain, steps: ST.steps, act: ST.act, sid: ST.sid,
    hrArea: ST.hrArea, hrSecs: ST.hrSecs, hrPeak: ST.hrPeak,
    activeS: ST.activeS, cmdSeq: ST.lastCmdSeq,
    elapsed: ST.startAt ? (now() - ST.startAt) / 1000 : 0,
    mi: WSET.mi ? 1 : 0, events: ST.events.slice(), pts: compactPts(ST.pts),
    watchSamples: ST.watchSamples.slice(), watchDq: ST.watchDq,
    laps: ST.laps.slice()
  }, '');
  if (run) {
    var ok = saveRun(run);       // saveRun reports whether the write actually succeeded
    rlog((ok ? 'saved' : 'SAVE FAILED') + ' "' + run.name + '" (' + Math.round(run.dist) + ' m)');
    if (ok) {
      sendSummary(run);
      ST.lastSaved = runId(run);
      try { openRunLogPage(runId(run)); } catch (e1) {}
      clearInProgress();
    } else {
      sendNoSaveForCurrentSession(); // storage full and unrecoverable — don't claim it saved, and KEEP the checkpoint
    }
  } else {
    /* An immediate accidental start/stop still has no meaningful workout data. */
    sendNoSaveForCurrentSession();
    clearInProgress();
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

function watchMetrics(samples) {
  var area = 0, secs = 0, peak = 0, steps = 0;
  for (var i = 0; i < samples.length; i++) {
    var p = samples[i];
    peak = Math.max(peak, p[2] || 0, p[3] || 0);
    steps = Math.max(steps, p[4] || 0);
    if (i === 0 || p[5] !== 1) continue;
    var a = samples[i - 1], dt = p[1] - a[1];
    if (dt > 0 && dt <= 120) {
      var hr = p[2] > 0 ? p[2] : a[2];
      if (hr > 0) { area += hr * dt; secs += dt; }
    }
  }
  return { area: area, secs: secs, peak: peak, steps: steps };
}

function sensorPoints(samples) {
  var out = [], prior = null, gap = false;
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (s[5] !== 1 && s[5] !== 3) { gap = true; prior = s; continue; }
    var cad = 0;
    if (prior && s[1] > prior[1] && s[4] >= prior[4])
      cad = Math.min(300, Math.round((s[4] - prior[4]) * 60 / (s[1] - prior[1])));
    out.push([s[0], 0, 0, '', s[2] || 0, (gap && out.length ? 1 : 0), cad]);
    gap = false; prior = s;
  }
  return out;
}

function mergeWatchMetricsIntoRoute(pts, samples) {
  if (!pts.length || !samples.length) return pts;
  var j = 0, lastSteps = null, lastActive = null;
  for (var i = 0; i < pts.length; i++) {
    while (j + 1 < samples.length &&
           Math.abs(samples[j + 1][0] - pts[i][0]) <= Math.abs(samples[j][0] - pts[i][0])) j++;
    var s = samples[j];
    if (Math.abs(s[0] - pts[i][0]) <= 75) {
      if (!pts[i][4] && s[2] > 0) pts[i][4] = s[2];
      if (!pts[i][6] && lastSteps !== null && s[1] > lastActive && s[4] >= lastSteps)
        pts[i][6] = Math.min(300, Math.round((s[4] - lastSteps) * 60 / (s[1] - lastActive)));
      lastSteps = s[4]; lastActive = s[1];
    }
  }
  return pts;
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
    var dt = Math.min(Math.max(b[0] - a[0], 0), C.MOV_CAP_S);   // same cap as moving-time accrual, so split pace and avg pace agree
    while (dm > 0 && sd + dm >= U) {
      var need = U - sd;
      var f = need / dm;
      var usedT = dt * f;
      st += usedT;
      if (b[4] > 0 && usedT > 0) { hrS += b[4] * usedT; hrN += usedT; }
      out.push({ d: Math.round(U), s: Math.round(st), hr: hrN ? Math.round(hrS / hrN) : 0 });
      dm -= need; dt -= dt * f;
      sd = 0; st = 0; hrS = 0; hrN = 0;
    }
    sd += dm; st += dt;
    if (b[4] > 0 && dt > 0) { hrS += b[4] * dt; hrN += dt; }
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
  var Act = C.ACT_NAME[activityIndex(act)];
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

/* Post-workout analysis is deliberately computed here, after recording has
 * stopped. None of it adds GPS, Health or Bluetooth work to a live workout. */
function analyseHrZones(pts, hrMax, movingS, routed) {
  if (!hrMax || hrMax < 120) return null;
  var secs = [0, 0, 0, 0, 0], total = 0;
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    if (b[5]) continue;
    var dt = Math.min(Math.max(b[0] - a[0], 0), routed ? C.MOV_CAP_S : 120);
    var hr = b[4] > 0 ? b[4] : (a[4] > 0 ? a[4] : 0);
    if (!hr || !dt) continue;
    var f = hr / hrMax;
    var z = f < 0.60 ? 0 : f < 0.70 ? 1 : f < 0.80 ? 2 : f < 0.90 ? 3 : 4;
    secs[z] += dt;
    total += dt;
  }
  if (total < 20) return null;
  for (var j = 0; j < secs.length; j++) secs[j] = Math.round(secs[j]);
  return {
    maxHr: hrMax,
    secs: secs,
    total: Math.round(total),
    coverage: movingS > 0 ? Math.min(100, Math.round(total * 100 / movingS)) : 0
  };
}

function analysePacing(pts, splits, splitM) {
  var full = [], i;
  for (i = 0; i < (splits || []).length; i++) {
    if (splits[i].d >= splitM * 0.99 && splits[i].s > 0)
      full.push(splits[i].s / (splits[i].d / 1000));
  }
  var out = { fullSplits: full.length };
  if (full.length >= 2) {
    var sum = 0, mn = Infinity, mx = -Infinity;
    for (i = 0; i < full.length; i++) {
      sum += full[i];
      if (full[i] < mn) mn = full[i];
      if (full[i] > mx) mx = full[i];
    }
    var mean = sum / full.length, variance = 0;
    for (i = 0; i < full.length; i++) variance += Math.pow(full[i] - mean, 2);
    out.cv = Math.round(Math.sqrt(variance / full.length) / mean * 1000) / 10;
    out.rangePct = Math.round((mx - mn) / mean * 1000) / 10;
  }

  // Compare equal-distance halves, not equal point counts. That keeps sparse
  // sections and GPS cadence changes from biasing the finish-strength result.
  var segs = [], totalD = 0;
  for (i = 1; i < pts.length; i++) {
    if (pts[i][5]) continue;
    var dm = haversine({ lat: pts[i - 1][1], lon: pts[i - 1][2] },
                       { lat: pts[i][1], lon: pts[i][2] });
    var dt = Math.min(Math.max(pts[i][0] - pts[i - 1][0], 0), C.MOV_CAP_S);
    if (dm > 0 && dt > 0) { segs.push([dm, dt]); totalD += dm; }
  }
  if (totalD >= 200) {
    var half = totalD / 2, d0 = 0, t0 = 0, d1 = 0, t1 = 0, walked = 0;
    for (i = 0; i < segs.length; i++) {
      var d = segs[i][0], t = segs[i][1];
      if (walked < half) {
        var firstD = Math.min(d, half - walked);
        d0 += firstD; t0 += t * firstD / d;
        d1 += d - firstD; t1 += t * (d - firstD) / d;
      } else {
        d1 += d; t1 += t;
      }
      walked += d;
    }
    if (d0 > 0 && d1 > 0) {
      out.firstHalf = Math.round(t0 / (d0 / 1000));
      out.secondHalf = Math.round(t1 / (d1 / 1000));
      out.trendPct = Math.round((out.secondHalf - out.firstHalf) /
                                out.firstHalf * 1000) / 10;
    }
  }
  return out;
}

/* Find sustained ascents in the already-smoothed elevation track. A climb must
 * gain at least 10 m over 50 m; a 5 m descent closes it. Those thresholds keep
 * ordinary GPS vertical shimmer from being promoted into a "climb". */
function analyseClimbs(pts) {
  var dp = [0], tp = [0], i;
  for (i = 1; i < pts.length; i++) {
    var brk = !!pts[i][5];
    var dm = brk ? 0 : haversine({ lat: pts[i - 1][1], lon: pts[i - 1][2] },
                                 { lat: pts[i][1], lon: pts[i][2] });
    var dt = brk ? 0 : Math.min(Math.max(pts[i][0] - pts[i - 1][0], 0), C.MOV_CAP_S);
    dp.push(dp[i - 1] + dm);
    tp.push(tp[i - 1] + dt);
  }
  var climbs = [], baseI = -1, peakI = -1, baseE = 0, peakE = 0;
  function finish() {
    if (baseI < 0 || peakI < 0) return;
    var gain = peakE - baseE, dist = dp[peakI] - dp[baseI];
    if (gain >= 10 && dist >= 50) {
      climbs.push({
        gain: Math.round(gain),
        dist: Math.round(dist),
        dur: Math.round(tp[peakI] - tp[baseI]),
        grade: Math.round(gain / dist * 1000) / 10,
        at: pts[baseI][0]
      });
    }
  }
  for (i = 0; i < pts.length; i++) {
    var ele = pts[i][3];
    if (pts[i][5]) {
      finish(); baseI = peakI = -1;
    }
    if (ele === '' || ele === null || ele === undefined || !isFinite(ele)) {
      finish(); baseI = peakI = -1;
      continue;
    }
    ele = Number(ele);
    if (baseI < 0) {
      baseI = peakI = i; baseE = peakE = ele;
    } else if (ele > peakE) {
      peakE = ele; peakI = i;
    } else if (peakE - ele >= 5) {
      finish();
      baseI = peakI = i; baseE = peakE = ele;
    } else if (peakI === baseI && ele < baseE) {
      baseI = peakI = i; baseE = peakE = ele;
    }
  }
  finish();
  if (!climbs.length) return { count: 0, top: [] };
  var ranked = climbs.slice().sort(function (a, b) { return b.gain - a.gain; });
  return { count: climbs.length, top: ranked.slice(0, 3) };
}

function analyseWorkout(run, pts, hrMax) {
  var pauses = 0;
  for (var i = 0; i < (run.events || []).length; i++) {
    if (run.events[i][1] === 'pause' || run.events[i][1] === 'auto_pause') pauses++;
  }
  var splitM = unitM(!!run.mi) * C.SPLIT_MULT[activityIndex(run.act)];
  var routed = run.route !== 0;
  return {
    version: 1,
    stopped: Math.max(0, Math.round((run.dur || 0) -
             (run.active || run.mov || run.dur || 0))),
    pauses: pauses,
    zones: analyseHrZones(pts, hrMax, run.mov || run.active || 0, routed),
    pacing: routed ? analysePacing(pts, run.splits, splitM) : { fullSplits: 0 },
    climbs: routed ? analyseClimbs(pts) : { count: 0, top: [] }
  };
}

function recomputeDerived(run) {
  var cpts = run.pts || [];
  var sum = 0, n = 0, max = 0, i;
  for (i = 0; i < cpts.length; i++) {
    var hr = cpts[i][4];
    if (hr > 0) { sum += hr; n++; if (hr > max) max = hr; }
  }
  var act = activityIndex(run.act);
  run.act = act;
  var routed = run.route !== 0;
  run.route = routed ? 1 : 0;
  run.avgp = (routed && run.mov >= 30 && run.dist >= 50) ? Math.round(run.mov / (run.dist / 1000)) : 0;
  run.avgHr = run.hrSecs > 0 ? Math.round(run.hrArea / run.hrSecs)
                             : (n ? Math.round(sum / n) : 0);
  run.maxHr = Math.max(max, run.hrPeak || 0);
  // Use the max/resting HR that were configured when the run was recorded, not
  // whatever they are today: max HR scales the estimate directly, so recomputing
  // an old run after changing the setting would silently rewrite its history.
  // Runs saved before 1.28.0 have no stored values and fall back to current.
  var vMaxHr = run.maxHrSet > 0 ? run.maxHrSet : WSET.maxHr;
  var vRestHr = run.restHrSet >= 0 && run.restHrSet !== undefined ? run.restHrSet : WSET.restHr;
  run.vo2max = routed ? estimateVo2max(cpts, act, vMaxHr, vRestHr) : 0;
  run.cad = (act !== 2 && run.mov >= 30 && run.steps > 0)
              ? Math.min(260, Math.round(run.steps * 60 / run.mov)) : 0;
  run.splits = routed ? computeSplits(cpts, run.mi, C.SPLIT_MULT[act]) : [];
  run.analysis = analyseWorkout(run, cpts, vMaxHr);
  return run;
}

/* Base aggregates that can be reconstructed from the compact saved route.
 * Trimming deliberately snaps to retained points: no coordinate, HR or
 * elevation value is invented at a cut boundary. */
function trimPointStats(pts) {
  var out = { dist: 0, mov: 0, egain: 0, hrArea: 0, hrSecs: 0,
              hrPeak: 0, cadWork: 0 };
  var eleBase = null;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i], ele = p[3];
    if (p[4] > out.hrPeak) out.hrPeak = p[4];
    if (p[5]) eleBase = null;
    if (ele !== '' && ele !== null && ele !== undefined && isFinite(ele)) {
      ele = Number(ele);
      if (eleBase === null) eleBase = ele;
      else {
        var de = ele - eleBase;
        if (de >= 3) { out.egain += de; eleBase = ele; }
        else if (de <= -3) eleBase = ele;
      }
    }
    if (i === 0 || p[5]) continue;
    var a = pts[i - 1], rawDt = p[0] - a[0];
    if (!(rawDt > 0)) continue;
    var dt = Math.min(rawDt, C.MOV_CAP_S);
    out.dist += haversine({ lat: a[1], lon: a[2] }, { lat: p[1], lon: p[2] });
    out.mov += dt;
    var hr = p[4] > 0 ? p[4] : (a[4] > 0 ? a[4] : 0);
    if (hr > 0) { out.hrArea += hr * dt; out.hrSecs += dt; }
    var cad = p[6] > 0 ? p[6] : (a[6] > 0 ? a[6] : 0);
    if (cad > 0) out.cadWork += cad * dt;
  }
  return out;
}

function trimTimelineBounds(run, pts) {
  var first = pts[0][0], last = pts[pts.length - 1][0];
  var start = run.start && isFinite(run.start) ? run.start / 1000 : first;
  var end = run.dur > 0 ? start + run.dur : last;
  if (start > first) start = first;
  if (end < last) end = last;
  return { start: start, end: end };
}

function trimEventState(active, type) {
  if (type === 'start' || type === 'resume' || type === 'auto_resume') return true;
  if (type === 'pause' || type === 'auto_pause' || type === 'stop' ||
      type === 'recovered') return false;
  return active;
}

function trimSortedEvents(events) {
  return (events || []).slice().filter(function (e) {
    return e && isFinite(e[0]) && typeof e[1] === 'string';
  }).sort(function (a, b) { return a[0] - b[0]; });
}

/* Exact active-time overlap when the saved pause/resume event stream exists.
 * Legacy records without events return null and use a proportional fallback. */
function trimActiveInWindow(events, lo, hi) {
  var ev = trimSortedEvents(events);
  if (!ev.length) return null;
  var active = true, cursor = lo, total = 0, i, at;
  for (i = 0; i < ev.length && ev[i][0] <= lo; i++)
    active = trimEventState(active, ev[i][1]);
  for (; i < ev.length && ev[i][0] < hi; i++) {
    at = Math.max(lo, ev[i][0]);
    if (active && at > cursor) total += at - cursor;
    cursor = Math.max(cursor, at);
    active = trimEventState(active, ev[i][1]);
  }
  if (active && hi > cursor) total += hi - cursor;
  return Math.max(0, total);
}

function trimEventsToWindow(events, lo, hi) {
  var ev = trimSortedEvents(events), active = true, out = [], i;
  // Keep legacy activities event-less. Inventing a fully-active start/stop
  // pair would make a second trim lose the proportional fallback used when
  // the original pause history was never stored.
  if (!ev.length) return out;
  for (i = 0; i < ev.length && ev[i][0] <= lo; i++)
    active = trimEventState(active, ev[i][1]);
  out.push([Math.round(lo), 'start']);
  if (!active) out.push([Math.round(lo), 'pause']);
  for (; i < ev.length && ev[i][0] < hi; i++) {
    var type = ev[i][1];
    if (type === 'pause' || type === 'auto_pause' ||
        type === 'resume' || type === 'auto_resume')
      out.push([Math.round(ev[i][0]), type]);
  }
  out.push([Math.round(hi), 'stop']);
  return out;
}

function trimDistanceAt(pts, at) {
  var d = 0;
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    if (at <= a[0]) break;
    if (b[5]) continue;
    var dm = haversine({ lat: a[1], lon: a[2] }, { lat: b[1], lon: b[2] });
    if (at >= b[0]) d += dm;
    else {
      d += dm * Math.max(0, Math.min(1, (at - a[0]) / (b[0] - a[0])));
      break;
    }
  }
  return d;
}

function finalizeRun(d, suffix) {
  var gpsPts = d.pts || [], samples = d.watchSamples || [];
  var route = gpsPts.length >= 2;
  var cpts = route ? mergeWatchMetricsIntoRoute(gpsPts, samples) : sensorPoints(samples);
  var active = Math.round(d.activeS || d.movS || 0);
  var meaningful = active >= 10 || (d.steps || 0) > 0 || cpts.length >= 2;
  if (!meaningful) return null;       // an accidental immediate start/stop remains NOSAVE
  if (!cpts.length) {
    // A final aggregate can survive even if the detailed ring overflowed or the
    // app restarted. One timestamped measurement is honest; coordinates remain absent.
    cpts.push([Math.round((d.startAt + Math.max(0, d.elapsed || active) * 1000) / 1000),
               0, 0, '', 0, 0, 0]);
  }
  var act = activityIndex(d.act);
  var wm = watchMetrics(samples);
  var mov = route ? Math.round(d.movS || 0) : active;
  var dist = route ? Math.round(d.dist || 0) : 0;
  var span = cpts.length > 1 ? cpts[cpts.length - 1][0] - cpts[0][0] : 0;
  var dur = (d.elapsed && d.elapsed >= span) ? Math.round(d.elapsed) : span;   // true wall-clock elapsed (incl. acquisition/trailing), never less than the GPS span
  var name = nameFromTemplate(loadCfg().name, act, d.startAt) + suffix;
  var run = {
    name: name, start: d.startAt,
    dist: dist,
    dur: dur,
    active: active,
    mov: mov,
    egain: Math.round(d.egain || 0),
    steps: Math.max(d.steps || 0, wm.steps),
    hrArea: wm.secs > (d.hrSecs || 0) ? wm.area : (d.hrArea || 0),
    hrSecs: Math.max(d.hrSecs || 0, wm.secs),
    hrPeak: Math.max(d.hrPeak || 0, wm.peak),
    mi: d.mi ? 1 : 0,
    act: act,
    maxHrSet: WSET.maxHr,
    restHrSet: WSET.restHr,
    sid: d.sid || 0,
    cmdSeq: d.cmdSeq || 0,
    tz: -new Date(d.startAt).getTimezoneOffset(),
    up: 0,
    events: d.events || [], laps: d.laps || [],
    route: route ? 1 : 0, dq: d.watchDq ? 1 : 0,
    pts: cpts
  };
  return recomputeDerived(run);
}

/* Downsample + normalise the route into 0..200 x/y byte pairs for the
 * watch summary screen (aspect preserved, centred, y grows downward). */
function sendTrack(cpts, sid) {
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
  // longest axis of the route in real-world metres -> the watch scale label.
  // x is already lon*cos(lat), so a span in x maps to metres by *111320 just
  // like a latitude span does — applying cos(lat) again here under-counted
  // east-west routes (~15% at Perth, 50% at 60 deg).
  var spanM = Math.round(span * 111320);
  send({ TRACK: bytes, TSPAN: spanM, SID: wireSid(sid) }, true);
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

function sendGraphs(cpts, sid, routed) {
  var N = cpts.length;
  if (N < 2) return;
  if (!routed) {
    var span = cpts[N - 1][0] - cpts[0][0];
    if (span <= 0) return;
    var B0 = C.GRAPH_PTS, hs0 = [], hc0 = [], hv0 = [], i0;
    for (i0 = 0; i0 < B0; i0++) { hs0.push(0); hc0.push(0); }
    for (i0 = 0; i0 < N; i0++) {
      if (cpts[i0][4] <= 0) continue;
      var b0 = Math.min(B0 - 1, Math.floor((cpts[i0][0] - cpts[0][0]) * B0 / span));
      hs0[b0] += cpts[i0][4]; hc0[b0]++;
    }
    for (i0 = 0; i0 < B0; i0++) hv0.push(hc0[i0] ? hs0[i0] / hc0[i0] : null);
    var hg0 = buildGraph(ksmooth(hv0, 1.3));
    if (hg0) send({ SID: wireSid(sid), HRG: hg0 }, true);
    return;
  }
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
  var d = { SID: wireSid(sid) };
  if (pg) d.PACEG = pg;
  if (hg) d.HRG = hg;
  if (pg || hg) send(d, true);
}

function sendSummary(run) {
  var d = {
    PROTO: 3, SID: wireSid(runId(run)), WSTATE: 4,
    STARTTS: Math.round(run.start / 1000),
    ACTIVE: Math.round(run.active || run.mov || 0),
    MODE: activityIndex(run.act),
    SAVED: 1, DIST: run.dist, AVGP: run.avgp, AVGHR: run.avgHr,
    MAXHR: run.maxHr, MOVS: run.mov, DURS: run.dur,
    EGAIN: run.egain, VO2: run.vo2max || 0,
    ROUTE: run.route !== 0 ? 1 : 0, DQ: run.dq ? 1 : 0
  };
  send(d, true);
  if (run.route !== 0) sendTrack(run.pts, runId(run));
  sendGraphs(run.pts, runId(run), run.route !== 0);
}

/* ------------------ Storage ------------------ */
var J_PREFIX = 'runlog.j.';

function isArray(v) {
  return Object.prototype.toString.call(v) === '[object Array]';
}

/* FNV-1a over the exact JSON payload. This is corruption detection, not a
 * security primitive: it lets a damaged/missing chunk be skipped honestly
 * instead of poisoning the whole workout. */
function journalHash(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

function journalChunkKey(j, i) {
  return J_PREFIX + j.id + '.' + i;
}

/* Coordinates are integer microdegrees; time/position are deltas after the
 * first point. Elevation remains absolute decimetres so a missing sample needs
 * no sentinel delta state. Six decimal places retain ~11 cm resolution. */
function encodePointDeltas(pts) {
  var d = [], pt = null;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i], t = Math.round(p[0]), la = Math.round(p[1] * 1e6),
        lo = Math.round(p[2] * 1e6);
    var el = (p[3] === '' || p[3] === null || p[3] === undefined)
               ? null : Math.round(Number(p[3]) * 10);
    d.push([pt ? t - pt[0] : t, pt ? la - pt[1] : la,
            pt ? lo - pt[2] : lo, el, p[4] || 0, p[5] || 0, p[6] || 0]);
    pt = [t, la, lo];
  }
  return d;
}

/* The current Pebble mobile app consumes one Pebble.openURL() when Settings is
 * requested, then leaves that screen after pebblejs://close.  It cannot use a
 * close/reopen round trip to fetch one route.  Carry all retained routes in the
 * first page instead, but use a compact stream rather than JSON point arrays:
 * seven zig-zag/unsigned varints per point, then URL-safe base64.  Every stored
 * sample remains present; the page expands only the route the user taps.
 *
 * Time/position and the remaining measurements are delta-coded.  Elevation is
 * mapped to 0 for missing, otherwise zig-zag(decimetres)+1 before its delta is
 * written.  This preserves negative elevations and missing samples exactly. */
function zigzagInt(n) {
  n = Math.round(n);
  return n < 0 ? (-n * 2 - 1) : n * 2;
}
function putVarUint(out, n) {
  n = Math.floor(n);
  while (n >= 128) {
    out.push((n % 128) + 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
}
function putVarInt(out, n) {
  putVarUint(out, zigzagInt(n));
}
function pageElevationCode(v) {
  if (v === '' || v === null || v === undefined) return 0;
  return zigzagInt(Math.round(Number(v) * 10)) + 1;
}
function encodePagePoints(pts) {
  var out = [], prev = null;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var cur = [
      Math.round(p[0]),
      Math.round(p[1] * 1e6),
      Math.round(p[2] * 1e6),
      pageElevationCode(p[3]),
      Math.round(p[4] || 0),
      Math.round(p[5] || 0),
      Math.round(p[6] || 0)
    ];
    if (!prev) {
      putVarUint(out, cur[0]);
      putVarInt(out, cur[1]);
      putVarInt(out, cur[2]);
      putVarUint(out, cur[3]);
      putVarUint(out, cur[4]);
      putVarUint(out, cur[5]);
      putVarUint(out, cur[6]);
    } else {
      putVarInt(out, cur[0] - prev[0]);
      putVarInt(out, cur[1] - prev[1]);
      putVarInt(out, cur[2] - prev[2]);
      putVarInt(out, cur[3] - prev[3]);
      putVarInt(out, cur[4] - prev[4]);
      putVarUint(out, cur[5]);
      putVarInt(out, cur[6] - prev[6]);
    }
    prev = cur;
  }
  return b64Bytes(out, true);
}

/* A route chunk is an immutable stream of compact point events. */
function encodeJournalChunk(pts) {
  var d = encodePointDeltas(pts);
  var payload = JSON.stringify(d);
  return JSON.stringify({ v: 1, n: d.length, h: journalHash(payload), d: d });
}

function decodeJournalChunk(raw) {
  var e = JSON.parse(raw);
  if (!e || e.v !== 1 || !isArray(e.d) || e.n !== e.d.length ||
      e.h !== journalHash(JSON.stringify(e.d))) throw new Error('bad route chunk');
  var out = [], t = 0, la = 0, lo = 0;
  for (var i = 0; i < e.d.length; i++) {
    var d = e.d[i];
    if (!isArray(d) || d.length < 7) throw new Error('bad point event');
    if (i === 0) { t = d[0]; la = d[1]; lo = d[2]; }
    else { t += d[0]; la += d[1]; lo += d[2]; }
    var lat = la / 1e6, lon = lo / 1e6;
    if (!isFinite(t) || !isFinite(lat) || !isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180)
      throw new Error('invalid point event');
    out.push([t, lat, lon, d[3] === null ? '' : d[3] / 10,
              d[4] || 0, d[5] || 0, d[6] || 0]);
  }
  return out;
}

function journalToken(run) {
  var id = String(runId(run) || run.start || now()).replace(/[^A-Za-z0-9_-]/g, '_');
  ST.journalSeq = (ST.journalSeq + 1) & 0xFFFF;
  return id + '-' + now().toString(36) + '-' + ST.journalSeq.toString(36);
}

function metadataForRun(run, journal) {
  var m = {};
  for (var k in run) {
    if (run.hasOwnProperty(k) && k !== 'pts' && k !== '_j' &&
        k !== 'journalWarning' && k !== 'hrv') m[k] = run[k];
  }
  if (journal || run._j) m._j = journal || run._j;
  return m;
}

function prepareRunJournal(run) {
  if (!run.pts || !run.pts.length) return { meta: metadataForRun(run), chunks: [] };
  if (!run.analysis) recomputeDerived(run);
  var j = { v: 1, id: journalToken(run), npts: run.pts.length, chunks: 0, bytes: 0 };
  var chunks = [];
  for (var i = 0; i < run.pts.length; i += C.RUN_CHUNK_PTS) {
    var encoded = encodeJournalChunk(run.pts.slice(i, i + C.RUN_CHUNK_PTS));
    var key = journalChunkKey(j, chunks.length);
    chunks.push({ key: key, value: encoded });
    j.bytes += key.length + encoded.length;
  }
  j.chunks = chunks.length;
  return { meta: metadataForRun(run, j), chunks: chunks };
}

function removeJournal(j) {
  if (!j || j.v !== 1) return;
  for (var i = 0; i < (j.chunks || 0); i++) {
    try { localStorage.removeItem(journalChunkKey(j, i)); } catch (e) {}
  }
}

function parseRunsRaw(raw) {
  var parsed = raw ? JSON.parse(raw) : [];
  if (!isArray(parsed)) throw new Error('runs store is not an array');
  return parsed;
}

function cleanJournalOrphans(index) {
  if (ST.journalGc) return;
  ST.journalGc = true;
  try {
    if (typeof localStorage.length !== 'number' || !localStorage.key) return;
    var keep = {}, keys = [], i, c;
    for (i = 0; i < index.length; i++) {
      if (!index[i]._j) continue;
      for (c = 0; c < index[i]._j.chunks; c++)
        keep[journalChunkKey(index[i]._j, c)] = true;
    }
    for (i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(J_PREFIX) === 0 && !keep[k]) keys.push(k);
    }
    for (i = 0; i < keys.length; i++) localStorage.removeItem(keys[i]);
  } catch (e) {}
}

function loadRunIndex() {
  if (ST.storeBlocked) return [];
  var raw = null, parsed;
  try {
    raw = localStorage.getItem('runlog.runs');
    parsed = parseRunsRaw(raw);
  } catch (e) {
    // Block all implicit writes: returning [] must never let the next workout
    // overwrite the only malformed copy, even when quota prevents a backup.
    ST.storeBlocked = true;
    var backed = false;
    try {
      if (raw) {
        localStorage.setItem('runlog.runs.corrupt', raw);
        backed = localStorage.getItem('runlog.runs.corrupt') === raw;
      }
    } catch (e2) {}
    rlog('runs store is corrupt; saves blocked' +
         (backed ? ' (raw backup retained)' : ' (backup failed)'));
    return [];
  }

  // 1.28 and older stored every full route in this one array. Chunk writes land
  // first and the small index is the commit point, so a failed/torn migration
  // leaves the exact legacy array authoritative and retryable.
  var legacy = false, retiredHealth = false;
  for (var i = 0; i < parsed.length; i++) {
    if (parsed[i].hasOwnProperty('hrv')) {
      delete parsed[i].hrv;
      retiredHealth = true;
    }
    if (parsed[i].pts && !parsed[i]._j) legacy = true;
  }
  if (legacy || retiredHealth) {
    if (storeRuns(parsed)) {
      try {
        parsed = parseRunsRaw(localStorage.getItem('runlog.runs'));
        if (legacy) rlog('migrated saved activities to the chunked journal');
        if (retiredHealth) rlog('removed retired health-measurement metadata');
      } catch (e3) {}
    }
  }
  cleanJournalOrphans(parsed);
  return parsed;
}

function hydrateRun(meta) {
  if (!meta) return null;
  if (meta.pts || !meta._j) return meta;
  var run = metadataForRun(meta), pts = [], damaged = 0, gap = false;
  run._j = meta._j;
  for (var i = 0; i < meta._j.chunks; i++) {
    try {
      var raw = localStorage.getItem(journalChunkKey(meta._j, i));
      if (!raw) throw new Error('missing route chunk');
      var part = decodeJournalChunk(raw);
      if (gap && part.length) part[0][5] = 1;  // never draw/export across a lost chunk
      pts = pts.concat(part);
      gap = false;
    } catch (e) {
      damaged++;
      gap = true;
    }
  }
  run.pts = pts;
  if (damaged || pts.length !== meta._j.npts) {
    run.journalWarning = {
      damaged: damaged,
      expected: meta._j.npts,
      recovered: pts.length
    };
    rlog('WARNING: salvaged ' + pts.length + '/' + meta._j.npts +
         ' points from "' + (run.name || 'activity') + '"');
  }
  return run;
}

function loadRuns() {
  var index = loadRunIndex(), out = [];
  for (var i = 0; i < index.length; i++) out.push(hydrateRun(index[i]));
  return out;
}

/* Write new immutable chunks, then atomically replace the small index. Only
 * after that commit succeeds are superseded/evicted chunks removed. */
function storeRuns(runs, force) {
  if (ST.storeBlocked && !force) return false;
  var old = [];
  try { old = parseRunsRaw(localStorage.getItem('runlog.runs')); }
  catch (e0) { if (!force) return false; }

  var prepared = [], metas = [], total = 0, i, p;
  try {
    for (i = 0; i < runs.length; i++) {
      if (runs[i]._j) p = { meta: metadataForRun(runs[i]), chunks: [] };
      else p = prepareRunJournal(runs[i]);
      prepared.push(p);
      metas.push(p.meta);
    }
    function logicalSize() {
      var n = JSON.stringify(metas).length;
      for (var z = 0; z < metas.length; z++)
        if (metas[z]._j) n += metas[z]._j.bytes || 0;
      return n;
    }
    total = logicalSize();
    var evicted = 0;
    while ((metas.length > C.KEEP_RUNS || total > C.MAX_STORE_CHARS) &&
           metas.length > 1) {
      metas.shift(); prepared.shift(); evicted++;
      total = logicalSize();
    }

    var written = [];
    try {
      for (i = 0; i < prepared.length; i++) {
        for (var c = 0; c < prepared[i].chunks.length; c++) {
          var ch = prepared[i].chunks[c];
          localStorage.setItem(ch.key, ch.value);
          if (localStorage.getItem(ch.key) !== ch.value) throw new Error('route chunk verify failed');
          written.push(ch.key);
        }
      }
      var encoded = JSON.stringify(metas);
      localStorage.setItem('runlog.runs', encoded);       // commit point
      if (localStorage.getItem('runlog.runs') !== encoded) throw new Error('index verify failed');
    } catch (ew) {
      for (i = 0; i < written.length; i++) {
        try { localStorage.removeItem(written[i]); } catch (ec) {}
      }
      return false;
    }

    var kept = {};
    for (i = 0; i < metas.length; i++) if (metas[i]._j) kept[metas[i]._j.id] = true;
    for (i = 0; i < old.length; i++) {
      if (old[i]._j && !kept[old[i]._j.id]) removeJournal(old[i]._j);
    }
    if (force) {
      ST.storeBlocked = false;
      ST.journalGc = false;
      cleanJournalOrphans(metas);
    }
    if (evicted > 0) rlog('storage limit: dropped ' + evicted + ' oldest activit' +
                          (evicted > 1 ? 'ies' : 'y'));
    updateGlance(metas);
    return true;
  } catch (e) {
    return false;
  }
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
function updateGlance(knownRuns) {
  try {
    if (typeof Pebble === 'undefined' || !Pebble.appGlanceReload) return;
    var runs = knownRuns || loadRunIndex(), i;
    if (!runs.length) { Pebble.appGlanceReload([], function () {}, function () {}); return; }
    var r = runs[0];
    for (i = 1; i < runs.length; i++) if (runs[i].start > r.start) r = runs[i];
    var set = {};
    try { set = JSON.parse(localStorage.getItem('runlog.set') || '{}'); } catch (e) {}
    var label = C.ACT_NAME[activityIndex(r.act)];
  var subtitle = label + ' \u00b7 ' + (r.route === 0 ? 'no GPS route' : glanceDist(r.dist || 0, !!set.mi)) +
                 ' \u00b7 ' + glanceTime(r.dur || 0);
    Pebble.appGlanceReload(
      [{ layout: { icon: 'system://images/GENERIC_CONFIRMATION', subtitleTemplateString: subtitle } }],
      function () {}, function () {});
  } catch (e) { /* glance is best-effort */ }
}
function saveRun(run) {
  var runs = loadRunIndex();
  if (ST.storeBlocked) return false;
  runs.push(run);
  return storeRuns(runs);
}
function updateRun(id, fn, withPoints) {
  var runs = loadRunIndex(), changed = false;
  for (var i = 0; i < runs.length; i++) {
    if (runId(runs[i]) === id) {
      var run = withPoints ? hydrateRun(runs[i]) : runs[i];
      fn(run);
      runs[i] = run;
      changed = true;
      break;
    }
  }
  return changed && storeRuns(runs);
}

function ipChunkKey(sid, i) { return 'runlog.ip.' + sid + '.' + i; }
function checkpointMeta() {
  return {
    version: 3, chunked: 1,
    startAt: ST.startAt, dist: ST.dist, movS: ST.movS,
    activeS: activeNow(), egain: ST.egain, steps: ST.steps,
    hrArea: ST.hrArea, hrSecs: ST.hrSecs, hrPeak: ST.hrPeak,
    act: ST.act, sid: ST.sid, cmdSeq: ST.lastCmdSeq, at: now(),
    paused: ST.paused ? 1 : 0, autopaused: ST.autopaused ? 1 : 0,
    mi: WSET.mi ? 1 : 0, npts: ST.pts.length,
    chunks: Math.ceil(ST.pts.length / C.IP_CHUNK_PTS),
    events: ST.events || [], laps: ST.laps || [],
    watchN: (ST.watchSamples || []).length, watchDq: ST.watchDq ? 1 : 0
  };
}
function persistLiveness() {
  try {
    localStorage.setItem('runlog.inprogress.live', JSON.stringify({
      sid: ST.sid, at: now(), activeS: activeNow(), cmdSeq: ST.lastCmdSeq,
      steps: ST.steps, hrArea: ST.hrArea, hrSecs: ST.hrSecs, hrPeak: ST.hrPeak,
      paused: ST.paused ? 1 : 0, autopaused: ST.autopaused ? 1 : 0
      , watchDq: ST.watchDq ? 1 : 0, laps: ST.laps || []
    }));
  } catch (e) {
    if (!ST.ipWarned) { ST.ipWarned = true; rlog('WARNING: recovery heartbeat could not be stored'); }
  }
}
function persistInProgress() {
  if (!ST.recording || !ST.sid) return;
  try {
    if (ST.watchSamples && ST.watchSamples.length)
      persistWatchJournal('ipw', ST.sid, ST.watchSamples, ST.watchDq);
    var n = ST.ipPersistedN;
    if (n < 0 || n > ST.pts.length) n = 0;
    while (n < ST.pts.length) {
      var ci = Math.floor(n / C.IP_CHUNK_PTS);
      var off = n % C.IP_CHUNK_PTS;
      var chunk = [];
      if (off) {
        try {
          chunk = JSON.parse(localStorage.getItem(ipChunkKey(ST.sid, ci)) || '[]');
          if (Object.prototype.toString.call(chunk) !== '[object Array]') throw new Error('bad point chunk');
          // A crash can land the chunk write but not the following metadata
          // commit. Discard that unacknowledged tail before appending again.
          if (chunk.length > off) chunk.length = off;
          if (chunk.length < off) { chunk = []; off = 0; n = ci * C.IP_CHUNK_PTS; }
        }
        catch (ec) { chunk = []; off = 0; n = ci * C.IP_CHUNK_PTS; }
      }
      while (n < ST.pts.length && chunk.length < C.IP_CHUNK_PTS) {
        var p = ST.pts[n++];
        chunk.push([p.t, p.lat, p.lon, (p.ele === null ? '' : p.ele),
                    p.hr || 0, p.seg || 0, p.cad || 0]);
      }
      localStorage.setItem(ipChunkKey(ST.sid, ci), JSON.stringify(chunk));
    }
    ST.ipPersistedN = ST.pts.length;
    localStorage.setItem('runlog.inprogress', JSON.stringify(checkpointMeta()));
    // The full checkpoint already contains every liveness field. Reset the
    // one-shot heartbeat instead of immediately writing the same state twice.
    armIpHeartbeat();
    ST.ipWarned = false;
  } catch (e) {
    if (!ST.ipWarned) { ST.ipWarned = true; rlog('WARNING: in-progress checkpoint could not be stored'); }
  }
}
function armIpHeartbeat() {
  if (ST.ipTimer !== null) clearTimeout(ST.ipTimer);
  ST.ipTimer = null;
  if (!ST.recording) return;
  ST.ipTimer = setTimeout(function () {
    ST.ipTimer = null;
    if (ST.recording) {
      persistLiveness();
      armIpHeartbeat();
    }
  }, C.IP_HEARTBEAT_MS);
  if (ST.ipTimer && ST.ipTimer.unref) ST.ipTimer.unref();
}
function disarmIpHeartbeat() {
  if (ST.ipTimer !== null) clearTimeout(ST.ipTimer);
  ST.ipTimer = null;
}
function loadIpPoints(ip) {
  if (!ip) return [];
  if (!ip.chunked) return ip.pts || [];
  var pts = [];
  for (var i = 0; i < (ip.chunks || 0); i++) {
    try {
      var c = JSON.parse(localStorage.getItem(ipChunkKey(ip.sid, i)) || '[]');
      if (Object.prototype.toString.call(c) !== '[object Array]') break;
      pts = pts.concat(c);
    } catch (e) { break; }
  }
  if (ip.npts >= 0 && pts.length > ip.npts) pts.length = ip.npts;
  return pts;
}
function clearInProgress(ip) {
  if (!ip) {
    try {
      var raw = localStorage.getItem('runlog.inprogress');
      ip = raw ? JSON.parse(raw) : null;
    } catch (e) {}
  }
  if (ip && ip.chunked) {
    for (var i = 0; i < (ip.chunks || 0); i++) {
      try { localStorage.removeItem(ipChunkKey(ip.sid, i)); } catch (ec) {}
    }
  }
  if (ip && ip.sid) clearWatchJournal('ipw', ip.sid);
  try { localStorage.removeItem('runlog.inprogress'); } catch (e1) {}
  try { localStorage.removeItem('runlog.inprogress.live'); } catch (e2) {}
  ST.ipPersistedN = 0;
  ST.pendingRecovery = null;
  ST.watchSamples = []; ST.watchDq = 0; ST.laps = [];
}

/* Re-hydrate a run interrupted by a phone-JS restart. If the checkpoint is
 * fresh the run is almost certainly still going, so we RESTORE state and keep
 * recording (the old behaviour finalized it immediately, silently truncating
 * everything recorded after the restart). If it's stale the run ended while we
 * were down, so we save what we have — but only once: the session id guards
 * against a second recovery re-saving a run that already made it to storage. */
function restoreFromInprogress(ip) {
  ST.recording = true;
  ST.paused = !!ip.paused;                     // a run paused when the app died stays paused
  ST.autopaused = !!ip.autopaused;
  ST.startAt = ip.startAt; ST.dist = ip.dist || 0; ST.movS = ip.movS || 0;
  ST.activeS = ip.activeS || ip.movS || 0;
  ST.activeAt = (!ip.paused && !ip.autopaused) ? now() : 0;
  ST.egain = ip.egain || 0; ST.steps = ip.steps || 0;
  ST.hrArea = ip.hrArea || 0; ST.hrSecs = ip.hrSecs || 0;
  ST.hrPeak = ip.hrPeak || 0; ST.hrAgg = 0; ST.hrAggAt = 0;
  ST.act = activityIndex(ip.act);
  ST.sid = ip.sid || now();
  ST.lastCmdSeq = ip.cmdSeq || 0;
  ST.events = ip.events || [];
  ST.laps = ip.laps || [];
  ST.watchDq = (ip.watchDq || loadWatchJournalDq('ipw', ST.sid)) ? 1 : 0;
  ST.watchSamples = loadWatchJournal('ipw', ST.sid);
  recordEvent('phone_restart');
  WSET.mi = !!ip.mi;
  var storedPts = ip.pts || loadIpPoints(ip);
  ST.pts = storedPts.map(function (p) {
    return { t: p[0], lat: p[1], lon: p[2], ele: (p[3] === '' ? null : p[3]), hr: p[4], seg: p[5], cad: p[6] };
  });
  // Treat the restart as a segment boundary: the next fix starts a fresh segment
  // and must NOT have the gap back to the pre-restart point added to distance.
  ST.last = null; ST.lastRaw = null; ST.segFlag = 1;
  var lastPt = ST.pts.length ? ST.pts[ST.pts.length - 1] : null;
  ST.lastT = lastPt ? lastPt.t : 0;
  ST.lastTp = ST.lastT;
  ST.eleSm = (lastPt && lastPt.ele !== null && lastPt.ele !== undefined) ? lastPt.ele : null;
  ST.eleBase = ST.eleSm;
  ST.kf = newTrackFilter();            // stored positions are already smoothed
  // A HELLO may already have carried the restarted watch's raw step counter
  // before this stale checkpoint was rehydrated. Preserve that observation and
  // offset it to the recovered total instead of letting the next sample reset it.
  if (ST.stepPrevRaw !== null) ST.stepAdj = Math.max(0, ST.steps - ST.stepPrevRaw);
  else ST.stepAdj = 0;
  ST.stepHist = [];
  ST.splitN = Math.floor(ST.dist / (unitM(WSET.mi) * C.SPLIT_MULT[ST.act]));
  ST.lastStatT = 0;
  ST.ipPersistedN = ST.pts.length;
  armIpHeartbeat();
}
function resumeOrRecover() {
  var raw = null;
  try { raw = localStorage.getItem('runlog.inprogress'); } catch (e) {}
  if (!raw) return false;
  var ip = null;
  try { ip = JSON.parse(raw); } catch (e2) {}
  if (!ip) { clearInProgress(); return false; }
  try {
    var liveRaw = localStorage.getItem('runlog.inprogress.live');
    var live = liveRaw ? JSON.parse(liveRaw) : null;
    if (live && live.sid === ip.sid && live.at > (ip.at || 0)) {
      ip.at = live.at; ip.activeS = live.activeS; ip.cmdSeq = live.cmdSeq;
      ip.paused = live.paused; ip.autopaused = live.autopaused;
      if (live.steps !== undefined) ip.steps = live.steps;
      if (live.hrArea !== undefined) ip.hrArea = live.hrArea;
      if (live.hrSecs !== undefined) ip.hrSecs = live.hrSecs;
      if (live.hrPeak !== undefined) ip.hrPeak = live.hrPeak;
      if (live.watchDq !== undefined) ip.watchDq = live.watchDq;
      if (live.laps) ip.laps = live.laps;
    }
  } catch (e3) {}
  ip.pts = loadIpPoints(ip);
  if (ip.at && (now() - ip.at < C.IP_RESUME_MS)) {
    restoreFromInprogress(ip);
    persistInProgress();                    // commit the phone_restart lifecycle event
    rlog('resumed in-progress run after restart (' + (ip.pts.length) + ' pts)');
    return true;                      // still recording — caller will (re)start GPS
  }
  // A timestamp cannot prove that a workout ended: the watch may have spent
  // hours paused while the companion was dead. Keep it intact until HELLO
  // supplies the watch's session id/state.
  ST.pendingRecovery = ip;
  rlog('stale checkpoint retained pending watch reconciliation (' + ip.pts.length + ' pts)');
  return false;
}
function finalizeRecovery(ip) {
  if (!ip) return true;
  var done = true;
  if (ip.sid && loadRunIndex().some(function (r) { return r.sid === ip.sid; })) {
    done = true;                      // already saved on a previous recovery
  } else {
    var run = finalizeRun({
      startAt: ip.startAt, dist: ip.dist, movS: ip.movS, egain: ip.egain,
      activeS: ip.activeS, cmdSeq: ip.cmdSeq,
      hrArea: ip.hrArea, hrSecs: ip.hrSecs, hrPeak: ip.hrPeak,
      steps: ip.steps, act: ip.act, sid: ip.sid, mi: ip.mi,
      elapsed: (ip.at && ip.startAt) ? (ip.at - ip.startAt) / 1000 : 0,
      events: (ip.events || []).concat([[Math.round((ip.at || now()) / 1000), 'recovered']]),
      pts: ip.pts, watchSamples: loadWatchJournal('ipw', ip.sid),
      watchDq: (ip.watchDq || loadWatchJournalDq('ipw', ip.sid)) ? 1 : 0,
      laps: ip.laps || []
    }, ' (recovered)');
    done = run ? saveRun(run) : true;   // nothing recordable -> nothing to keep -> clear it
  }
  if (done) clearInProgress(ip);
  return done;
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
function normaliseWorkoutTarget(t) {
  t = t || {};
  var type = Math.round(Number(t.type) || 0);
  if (type < 0 || type > 4) type = 0;
  var lo = Math.max(0, Math.round(Number(t.lo) || 0));
  var hi = Math.max(0, Math.round(Number(t.hi) || 0));
  var value = Math.max(0, Math.round(Number(t.value) || 0));
  if (type === 1 && (value < 1 || value > 5)) value = 2;
  if (type === 4 && lo > 0 && hi > 0 && lo > hi) { var x = lo; lo = hi; hi = x; }
  return { type: type, lo: lo, hi: hi, value: value };
}

function loadCfg() {
  try {
    var raw = localStorage.getItem('runlog.cfg');
    var c = raw ? JSON.parse(raw) : {};
    var preset = c.preset;
    if (['custom', 'webdav', 'intervals', 'runalyze', 'fittrackee', 'endurain'].indexOf(preset) < 0) {
      preset = (c.method === 'PUT') ? 'webdav' : 'custom';   // migrate old configs
    }
    return { auto: c.auto ? 1 : 0, preset: preset, url: c.url || '',
             auth: c.auth || '', key: c.key || '',
             user: c.user || '', pass: c.pass || '', name: c.name || '',
             target: normaliseWorkoutTarget(c.target),
             fmt: (['gpx', 'tcx', 'fit'].indexOf(c.fmt) >= 0) ? c.fmt : 'gpx' };
  } catch (e) {
    return { auto: 0, preset: 'custom', url: '', auth: '', key: '', user: '', pass: '', name: '', fmt: 'gpx',
             target: normaliseWorkoutTarget(null) };
  }
}

/* does the config actually point somewhere we can upload to? */
function hasTarget(c) {
  if (c.preset === 'intervals' || c.preset === 'runalyze') return !!c.key;
  if (c.preset === 'endurain') return !!(c.url && c.key);
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
      WSET.mode = activityIndex(c.mode);
      if (c.maxHr >= 80 && c.maxHr <= 220) WSET.maxHr = c.maxHr;
      if (c.restHr >= 0 && c.restHr <= 120) WSET.restHr = c.restHr;
      WSET.zone = c.zone !== false;
      WSET.pending = !!c.pending;
    }
  } catch (e) {}
}
function storeWatchSet() {
  try { localStorage.setItem('runlog.set', JSON.stringify(WSET)); } catch (e) {}
}

function normaliseWatchConfig(w) {
  w = w || {};
  var maxHr = Math.round(Number(w.maxHr));
  var restHr = Math.round(Number(w.restHr));
  return {
    mi: w.mi !== undefined ? !!w.mi : WSET.mi,
    ap: w.ap !== undefined ? !!w.ap : WSET.ap,
    splits: w.splits !== undefined ? !!w.splits : WSET.splits,
    maxHr: maxHr >= 120 && maxHr <= 220 ? maxHr : WSET.maxHr,
    restHr: restHr >= 0 && restHr <= 120 ? restHr : WSET.restHr,
    zone: w.zone !== undefined ? !!w.zone : WSET.zone
  };
}

function wireBit(v) { return typeof v === 'number' && (v === 0 || v === 1); }
function validWatchSnapshot(p) {
  return p && wireBit(p.UNITS) && wireBit(p.AUTOP) && wireBit(p.SPLITP) &&
         wireBit(p.HRZONE) && typeof p.MHR === 'number' && isFinite(p.MHR) &&
         p.MHR === Math.floor(p.MHR) && p.MHR >= 80 && p.MHR <= 220 &&
         typeof p.RHR === 'number' && isFinite(p.RHR) &&
         p.RHR === Math.floor(p.RHR) && p.RHR >= 0 && p.RHR <= 120;
}
function applyWatchSnapshot(p) {
  WSET.mi = !!p.UNITS; WSET.ap = !!p.AUTOP; WSET.splits = !!p.SPLITP;
  WSET.maxHr = p.MHR; WSET.restHr = p.RHR; WSET.zone = !!p.HRZONE;
}
function watchSnapshotMatches(p) {
  return validWatchSnapshot(p) &&
         (!!p.UNITS === WSET.mi) && (!!p.AUTOP === WSET.ap) &&
         (!!p.SPLITP === WSET.splits) && (Number(p.MHR) === WSET.maxHr) &&
         (Number(p.RHR) === WSET.restHr) && (!!p.HRZONE === WSET.zone);
}

/* ------------------ Manual export/upload ------------------ */
/* PebbleKit JS has no reliable btoa, so bring our own. We deliberately use
 * UTF-8 for modern non-ASCII credential interoperability. RFC 7617 leaves the
 * default encoding unspecified for compatibility, but defines UTF-8 as the
 * server-advertised international form. The old encoder merely discarded the
 * high byte of every UTF-16 code unit. */
var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64URLC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function utf8Bytes(str) {
  var out = [], i, c, lo, cp;
  str = String(str);
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) { out.push(c); continue; }
    if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); continue; }
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      lo = str.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {          // valid surrogate pair
        cp = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
        continue;
      }
    }
    // A lone surrogate is not a Unicode scalar value. Match a strict encoder by
    // replacing it with U+FFFD instead of emitting an illegal UTF-8 sequence.
    if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;
    out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function b64Bytes(bytes, urlSafe) {
  var chars = urlSafe ? B64URLC : B64C;
  var out = '', i = 0, a, b, c;
  while (i < bytes.length) {
    a = bytes[i++];
    b = i < bytes.length ? bytes[i++] : -1;
    c = i < bytes.length ? bytes[i++] : -1;
    out += chars.charAt(a >> 2);
    out += chars.charAt(((a & 3) << 4) | (b < 0 ? 0 : b >> 4));
    out += b < 0 ? '=' : chars.charAt(((b & 15) << 2) | (c < 0 ? 0 : c >> 6));
    out += c < 0 ? '=' : chars.charAt(c & 63);
  }
  return out;
}
function b64(str) {
  return b64Bytes(utf8Bytes(str), false);
}

/* 'user:pass' is auto-wrapped as Basic; full header values pass through. */
function authHeader(c) {
  if (!c.auth) return '';
  if (c.auth.indexOf(' ') < 0 && c.auth.indexOf(':') > 0) return 'Basic ' + b64(c.auth);
  return c.auth;
}

function strBytes(s) { var a = [], i; for (i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xFF); return a; }

/* multipart/form-data body. fileBody is a string (GPX/TCX) or Uint8Array (FIT). */
function multipart(fileBody, fname, contentType, dataJson, forceBytes) {
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
  if (typeof fileBody === 'string' && !forceBytes)
    return { type: type, body: pre + fileBody + post };
  var fileBytes = typeof fileBody === 'string'
                    ? utf8Bytes(fileBody)
                    : Array.prototype.slice.call(fileBody);
  var bytes = strBytes(pre).concat(fileBytes).concat(strBytes(post));
  return { type: type, body: new Uint8Array(bytes) };
}

function endurainUploadUrl(raw) {
  var u = String(raw || '').replace(/^\s+|\s+$/g, '')
                           .replace(/[?#].*$/, '')
                           .replace(/\/+$/, '');
  // Accept an instance root, /api/v1, the upload endpoint itself, or a pasted
  // API-docs URL without duplicating paths. Reverse-proxy subpaths are kept.
  var apiAt = u.search(/\/api\/v1(?:\/|$)/i);
  if (apiAt >= 0) u = u.slice(0, apiAt);
  return u.replace(/\/+$/, '') + '/api/v1/activities/create/upload';
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
    // default FitTrackee sport ids: Running 5, Walking 6,
    // Cycling (Sport) 1, Hiking 3.
    var sport = [5, 6, 1, 3][activityIndex(run.act)];
    var mf = multipart(body, fname, ct, JSON.stringify({ sport_id: sport }));
    return {
      method: 'POST',
      url: ftBase(c) + '/api/workouts',
      headers: { 'Content-Type': mf.type, 'Authorization': 'Bearer ' + ftok },
      body: mf.body
    };
  }
  if (c.preset === 'endurain') {
    if (!c.url || !c.key) return null;
    // Pebble's embedded XHR implementations disagree on the encoding of a
    // JavaScript string request body. Send explicit UTF-8 bytes just as the
    // already-reliable FIT path does.
    var me = multipart(body, fname, ct, null, true);
    return {
      method: 'POST',
      url: endurainUploadUrl(c.url),
      headers: { 'Content-Type': me.type, 'X-API-Key': c.key },
      body: me.body,
      timeoutMs: C.ENDURAIN_UPLOAD_TIMEOUT_MS
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
  var done = false, x = null, watchdog = null;
  var timeoutMs = req.timeoutMs || C.UPLOAD_TIMEOUT_MS;
  function once(status, text) {
    if (done) return;
    done = true;
    if (watchdog !== null) clearTimeout(watchdog);
    if (x) x.onload = x.onerror = x.ontimeout = x.onabort = null;
    cb(status, text);
  }
  try {
    x = new XMLHttpRequest();
    x.open(req.method, req.url, true);
    x.timeout = timeoutMs;
    for (var hk in req.headers) {
      if (req.headers.hasOwnProperty(hk)) x.setRequestHeader(hk, req.headers[hk]);
    }
    x.onload = function () { once(x.status, x.responseText); };
    x.onerror = function () { once(0, 'network request failed'); };
    x.ontimeout = function () { once(0, 'request timed out'); };
    x.onabort = function () { once(0, 'request aborted'); };
    x.send(req.body);
    // Some embedded WebViews emit neither timeout nor error when their
    // lifecycle aborts a request. This bounds ST.uploading even there.
    if (!done) {
      watchdog = setTimeout(function () {
        once(0, 'request timed out');
        try { if (x && x.abort) x.abort(); } catch (e1) {}
      }, timeoutMs + 1000);
      if (watchdog && watchdog.unref) watchdog.unref();
    }
  } catch (e) {
    once(0, e && e.message ? e.message : 'request could not be sent');
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

function uploadErrorText(text) {
  if (!text) return '';
  var msg = '';
  try {
    var body = JSON.parse(text);
    msg = body && (body.detail || body.message || body.error);
    if (msg && typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch (e) {
    msg = String(text);
  }
  return String(msg || '').replace(/<[^>]*>/g, ' ')
                          .replace(/\s+/g, ' ')
                          .replace(/^\s+|\s+$/g, '')
                          .slice(0, 80);
}

function uploadRun(run) {
  var uploadSid = runId(run);
  if (ST.uploading) { rlog('an upload is already in progress — try again in a moment'); send({ EXPST: 2, EXPERR: 0, SID: wireSid(uploadSid) }, true); return; }
  var c = loadCfg();
  if (/^http:\/\//i.test(c.url || '') && (c.pass || c.key || c.auth || c.user)) {
    rlog('WARNING: destination is plain HTTP — credentials and your activity travel the network unencrypted');
  }
  var ex = exportRun(run, c.fmt);
  if (!ex) { rlog('nothing to upload (run has no GPS track)'); send({ EXPST: 3, EXPERR: 0, SID: wireSid(uploadSid) }, true); return; }
  var fname = ex.fname;
  var fmt = (['gpx', 'tcx', 'fit'].indexOf(c.fmt) >= 0) ? c.fmt : 'gpx';

  function finish(ok, status, responseText) {
    ST.uploading = false;
    var still = loadRunIndex().some(function (r) { return runId(r) === uploadSid; });
    if (!still) {
      rlog('upload result for a discarded workout ignored');
      return;
    }
    updateRun(uploadSid, function (r) {
      r.up = ok ? 1 : 2;
      if (ok) r.upMeta = { dest: c.preset || 'custom', fmt: fmt, at: Math.round(now() / 1000) };
    });
    if (ok) {
      rlog('upload ok (HTTP ' + status + ')');
      send({ EXPST: 1, SID: wireSid(uploadSid) }, true);
    } else {
      var why = uploadErrorText(responseText);
      rlog('upload FAILED (' + (status ? 'HTTP ' + status : 'no network') + ')' +
           (why ? ': ' + why : ''));
      send({ EXPST: 2, EXPERR: status || 0, SID: wireSid(uploadSid) }, true);
    }
  }

  if (c.preset === 'fittrackee') {
    var canLogin = !!(c.user && c.pass);
    if (!c.url || (!ftToken(c) && !canLogin)) {
      rlog('fittrackee upload needs a URL and either a saved token or email + password');
      send({ EXPST: 2, EXPERR: 0, SID: wireSid(uploadSid) }, true);
      return;
    }
    ST.uploading = true;
    rlog('upload -> fittrackee ' + hostOf(c.url) + ' (' + fname + ')');
    send({ EXPST: 0, SID: wireSid(uploadSid) }, true); // "Uploading…"
    var refreshed = false;
    var attempt = function () {
      xhrSend(buildUploadRequest(c, run, ex, ftToken(c)), function (status, text) {
        if (status >= 200 && status < 300) return finish(true, status, text);
        if (status === 401 && canLogin && !refreshed) {
          refreshed = true;                       // expired token: renew once
          rlog('token rejected (HTTP 401), logging in again');
          return ftLogin(c, function (tok, lst) {
            tok ? attempt() : finish(false, lst);
          });
        }
        finish(false, status, text);
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
    send({ EXPST: 2, EXPERR: 0, SID: wireSid(uploadSid) }, true);
    return;
  }
  ST.uploading = true;
  rlog('upload -> ' + c.preset + ' ' + hostOf(req.url) + ' (' + fname + ')');
  send({ EXPST: 0, SID: wireSid(uploadSid) }, true); // "Uploading…"
  xhrSend(req, function (status, text) {
    finish(status >= 200 && status < 300, status, text);
  });
}

/* Newest run that has never uploaded (0) or failed (2). Runs saved by
 * v1 (no 'up' field) are left alone. */
function retryPending() {
  var c = loadCfg();
  if (!hasTarget(c) || ST.uploading) return;   // manual: used as the CMD 7 fallback
  var runs = loadRunIndex();
  for (var i = runs.length - 1; i >= 0; i--) {
    if (runs[i].up === 0 || runs[i].up === 2 || runs[i].up === 3) {
      uploadRun(hydrateRun(runs[i]));
      return;
    }
  }
}

/* ------------------ Pebble events ------------------ */
Pebble.addEventListener('ready', function () {
  loadWatchSet();
  var resumed = resumeOrRecover();
  if (resumed) restoreGeoForSession();
  if (!resumed && !ST.pendingRecovery) {
    var prior = loadRunIndex();
    if (prior.length) {
      var newest = prior[0];
      for (var pi = 1; pi < prior.length; pi++) if (prior[pi].start > newest.start) newest = prior[pi];
      ST.lastSaved = runId(newest);     // action target only; HELLO decides whether watch is DONE
    }
  }
  sendStatus(0, null, true);
  // (no auto-upload on connect — uploads are user-driven)
});

Pebble.addEventListener('appmessage', function (e) {
  var p = (e && e.payload) || {};
  var setChanged = false;
  // CFGSET=2 is an explicit local watch edit. It supersedes an older phone
  // snapshot that may still be pending from a disconnected page save, and the
  // next protected state packet echoes the complete accepted values as its ACK.
  var declaresWatchLocalEdit = Number(p.CFGSET) === 2;
  var watchLocalEdit = declaresWatchLocalEdit && validWatchSnapshot(p);
  if (watchLocalEdit) {
    WSET.pending = false;
    applyWatchSnapshot(p);
    ST.watchSetAck = true;
    setChanged = true;
  }
  // Unless CFGSET=2 declares a deliberate local edit, a phone edit remains
  // authoritative until the watch echoes the complete applied snapshot. This
  // prevents an old HELLO from silently overwriting disconnected page changes.
  if (!declaresWatchLocalEdit && WSET.pending) {
    if (watchSnapshotMatches(p)) { WSET.pending = false; setChanged = true; }
  } else if (!declaresWatchLocalEdit && !WSET.pending) {
    if (p.UNITS !== undefined)  { WSET.mi = !!p.UNITS; setChanged = true; }
    if (p.AUTOP !== undefined)  { WSET.ap = !!p.AUTOP; setChanged = true; }
    if (p.SPLITP !== undefined) { WSET.splits = !!p.SPLITP; setChanged = true; }
    if (p.MHR !== undefined && p.MHR >= 80  && p.MHR <= 220) { WSET.maxHr = p.MHR; setChanged = true; }
    if (p.RHR !== undefined && p.RHR >= 0   && p.RHR <= 120) { WSET.restHr = p.RHR; setChanged = true; }
    if (p.HRZONE !== undefined) { WSET.zone = !!p.HRZONE; setChanged = true; }
  }
  if (p.MODE !== undefined)   { WSET.mode = activityIndex(p.MODE); setChanged = true; }
  if (setChanged) storeWatchSet();

  var packetSid = (p.SID !== undefined) ? (p.SID >>> 0) : 0;
  if (p.WSAMPLES !== undefined) ingestWatchSamples(p, packetSid);
  else if (p.DQ && ST.recording && packetSid === (ST.sid >>> 0)) ST.watchDq = 1;
  var sampleMatches = !ST.recording || !packetSid || packetSid === (ST.sid >>> 0);
  var arrival = now();
  var sampleAt = (p.SAMPLET !== undefined && isFinite(p.SAMPLET) &&
                  Math.abs(p.SAMPLET * 1000 - arrival) <= 300000)
                   ? p.SAMPLET * 1000 : arrival;
  if (sampleMatches && p.HR !== undefined) {
    if (ST.recording && !ST.paused && !ST.autopaused && sampleAt >= ST.hrAggAt) {
      integrateHr(sampleAt);
      ST.hrAgg = p.HR > 0 ? p.HR : 0;
      ST.hrAggAt = ST.hrAgg ? sampleAt : 0;
    }
    ST.hr = p.HR;
    ST.hrAt = sampleAt;
    if (p.HR > ST.hrPeak) ST.hrPeak = p.HR;
  }
  // HRPK is the watch's corroborated raw peak. p.HR is a 3-sample mean chosen
  // for display legibility; older watch builds omit HRPK and fall back above.
  if (sampleMatches && p.HRPK !== undefined && ST.recording &&
      p.HRPK > ST.hrPeak && p.HRPK < 260) {
    ST.hrPeak = p.HRPK;
  }
  if (sampleMatches && p.STEPS !== undefined)  {
    var t = sampleAt, rawSteps = Math.max(0, p.STEPS), n = rawSteps;
    // The watch activity counter can restart independently. Keep the recovered
    // phone total monotonic and use an offset from the new raw generation.
    if (ST.recording || ST.pendingRecovery) {
      if (ST.stepPrevRaw !== null && rawSteps < ST.stepPrevRaw)
        ST.stepAdj = Math.max(0, ST.steps - rawSteps);
      n = ST.stepAdj + rawSteps;
      if (n < ST.steps) {
        ST.stepAdj += ST.steps - n;
        n = ST.steps;
      }
      ST.stepPrevRaw = rawSteps;
    }
    // The watch already excludes steps taken while paused from this count (a
    // paused stretch freezes it), so we take it at face value. Cadence is the
    // derivative of a coarse, Bluetooth-delivered step counter. Over one
    // activity-profile sample message, that derivative is dominated by
    // integer-step quantisation and BLE arrival jitter, throwing individual
    // points to ~2x/~0.5x the true rate (in
    // matched high/low pairs, since the total stays correct). Average the rate
    // over a short trailing window, snapped to the watch's configured cadence, to
    // remove the spikes without shifting the bulk value or the run average. The
    // window is cleared across pauses (in pauseRun/resumeRun) so a pre-pause
    // sample can't seed a bogus first post-resume cadence.
    ST.stepHist = ST.stepHist || [];
    if (ST.stepHist.length && n < ST.stepHist[ST.stepHist.length - 1].n) ST.stepHist = [];  // defensive: normalized total should never retreat
    ST.stepHist.push({ n: n, at: t });
    var profile = powerProfile(ST.act);
    var cadWindow = profile.cadWindow;
    var cadSample = profile.cadSample;
    while (ST.stepHist.length > 2 && t - ST.stepHist[0].at > cadWindow) ST.stepHist.shift();
    var b0 = ST.stepHist[0], dn = n - b0.n, dtw = t - b0.at;
    if (dn >= 0 && dtw >= 3500) {
      var span = Math.round(dtw / cadSample) * cadSample || cadSample;
      var spm = dn * 60000 / span;
      if (spm <= 300) { ST.cad = Math.round(spm); ST.cadAt = t; }
    }
    ST.lastSteps = { n: n, at: t };
    ST.steps = n;
  }
  if (p.HELLO !== undefined) handleHello(p);
  if (p.CMD !== undefined) handleCommand(p);
  else if (p.RENAME !== undefined) renameLast(p.RENAME);  // legacy watch
});

function findRunById(id, withPoints) {
  var runs = loadRunIndex(), i = runIndexById(runs, id);
  return i >= 0 ? {
    runs: runs, index: i,
    run: withPoints === false ? runs[i] : hydrateRun(runs[i])
  } : null;
}
function uploadLast(id) {
  // manual "Upload now" from the debrief: skip the grace wait and send it
  if (ST.upTimer) { clearTimeout(ST.upTimer); ST.upTimer = null; }
  var target = (id !== undefined && id !== null) ? id : ST.lastSaved;
  if (target !== null) {
    var f = findRunById(target);
    if (f) {
      ST.lastSaved = runId(f.run);
      rlog('manual upload from watch');
      uploadRun(f.run);
      return true;
    }
  }
  if (id === undefined || id === null) { retryPending(); return true; }  // legacy fallback
  return false;
}

function discardLast(id) {
  if (ST.upTimer) { clearTimeout(ST.upTimer); ST.upTimer = null; }
  var target = (id !== undefined && id !== null) ? id : ST.lastSaved;
  if (target === null) return false;
  var f = findRunById(target, false);
  if (!f) return false;
  var discardedName = f.run.name;
  f.runs.splice(f.index, 1);
  if (!storeRuns(f.runs)) return false;
  rlog('discarded "' + discardedName + '" from the watch');
  ST.lastSaved = null;
  if (ST.sid === target) ST.sid = 0;
  return true;
}

/* Voice rename from the watch debrief: rename the just-saved run. The phone
 * copy is always kept; this only changes its name (and the GPX filename). */
function renameLast(raw, id) {
  var target = (id !== undefined && id !== null) ? id : ST.lastSaved;
  if (target === null) return false;
  var name = String(raw || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')
                              .replace(/^\s+|\s+$/g, '');
  if (!name) return false;
  var f = findRunById(target, false);
  if (!f) return false;
  var old = f.run.name;
  var wasUploaded = f.run.up === 1;
  f.run.name = name;
  if (wasUploaded) f.run.up = 3;
  f.runs[f.index] = f.run;
  if (!storeRuns(f.runs)) return false;
  ST.lastSaved = runId(f.run);
  rlog('renamed "' + old + '" -> "' + name + '" (voice)');
  if (wasUploaded) rlog('note: re-upload to update the server copy');
  return true;
}

/* Permanently keep one inclusive point range from a saved routed activity.
 * New immutable chunks are written before the run index changes, so a quota
 * or write failure leaves the original activity authoritative and recoverable. */
function trimSavedRun(id, first, last) {
  var f = findRunById(id);
  if (!f || !f.run || f.run.route === 0 || !f.run.pts) return false;
  first = Number(first); last = Number(last);
  if (!isFinite(first) || !isFinite(last) || first !== Math.floor(first) ||
      last !== Math.floor(last) || first < 0 || last <= first ||
      last >= f.run.pts.length ||
      (first === 0 && last === f.run.pts.length - 1)) return false;

  var run = f.run, oldPts = run.pts, bounds = trimTimelineBounds(run, oldPts);
  var lo = first === 0 ? bounds.start : oldPts[first][0];
  var hi = last === oldPts.length - 1 ? bounds.end : oldPts[last][0];
  if (!isFinite(lo) || !isFinite(hi) || hi - lo < 10) return false;

  var oldId = runId(run), oldEvents = run.events || [], oldLaps = run.laps || [];
  var oldStats = trimPointStats(oldPts);
  var pts = [];
  for (var i = first; i <= last; i++) pts.push(oldPts[i].slice());
  pts[0][5] = 0;                         // a retained route always starts a fresh segment
  var stats = trimPointStats(pts);
  if (!(stats.dist >= 0) || !(stats.mov >= 0)) return false;

  var dur = hi - lo;
  var oldActive = Math.max(0, Number(run.active || run.mov || run.dur || 0));
  var active = trimActiveInWindow(oldEvents, lo, hi);
  if (active === null) {
    var fullDur = Math.max(1, bounds.end - bounds.start);
    active = oldActive * dur / fullDur;
  }
  active = Math.min(dur, Math.max(stats.mov, active));

  var stepRatio = 0;
  if (oldStats.cadWork > 0) stepRatio = stats.cadWork / oldStats.cadWork;
  else if (oldActive > 0) stepRatio = active / oldActive;
  else if (bounds.end > bounds.start) stepRatio = dur / (bounds.end - bounds.start);
  stepRatio = Math.max(0, Math.min(1, stepRatio));

  var laps = [];
  for (i = 0; i < oldLaps.length; i++) {
    var lapAt = Number(oldLaps[i].at);
    if (!(lapAt > lo && lapAt < hi)) continue;
    var lapActive = trimActiveInWindow(oldEvents, lo, lapAt);
    if (lapActive === null) lapActive = active * (lapAt - lo) / dur;
    laps.push({ at: lapAt, active: Math.round(Math.max(0, lapActive)),
                dist: Math.round(trimDistanceAt(pts, lapAt)) });
  }

  run.pts = pts;
  run.start = Math.round(lo * 1000);
  run.dur = Math.round(dur);
  run.active = Math.round(active);
  run.mov = Math.round(stats.mov);
  run.dist = Math.round(stats.dist);
  run.egain = Math.round(stats.egain);
  run.steps = activityIndex(run.act) === 2 ? 0 :
              Math.round(Math.max(0, Number(run.steps || 0)) * stepRatio);
  run.hrArea = stats.hrArea;
  run.hrSecs = stats.hrSecs;
  run.hrPeak = stats.hrPeak;
  run.events = trimEventsToWindow(oldEvents, lo, hi);
  run.laps = laps;
  if (run.up === 1) run.up = 3;
  delete run._j;                         // force a new journal for the shorter route
  delete run.journalWarning;
  delete run.routeDecodeError;
  recomputeDerived(run);

  f.runs[f.index] = run;
  if (!storeRuns(f.runs)) {
    rlog('trim FAILED for "' + (run.name || 'activity') + '"');
    return false;
  }
  var newId = runId(run);
  if (ST.lastSaved === oldId) ST.lastSaved = newId;
  rlog('trimmed "' + run.name + '" to ' + Math.round(run.dur) +
       ' s / ' + Math.round(run.dist) + ' m');
  if (run.up === 3) rlog('note: re-upload to update the server copy');
  return true;
}

function loadLastAck() {
  try { return JSON.parse(localStorage.getItem('runlog.lastack') || 'null'); }
  catch (e) { return null; }
}
function cacheAck(sid, seq, cmd, result) {
  try {
    localStorage.setItem('runlog.lastack', JSON.stringify({
      sid: sid, seq: seq, cmd: cmd, result: result ? 1 : 0
    }));
  } catch (e) {}
}
function savedRunForSid(sid) {
  var f = findRunById(sid);
  return f ? f.run : null;
}

function handleHello(p) {
  var sid = (p.SID !== undefined) ? (p.SID >>> 0) : 0;
  var ws = (p.WSTATE !== undefined) ? p.WSTATE : 0;
  var seq = (p.SEQ !== undefined) ? (p.SEQ >>> 0) : 0;
  var watchActive = (p.ACTIVE !== undefined && p.ACTIVE >= 0) ? p.ACTIVE : null;

  if (ST.pendingRecovery) {
    var ip = ST.pendingRecovery;
    if (sid && sid === (ip.sid >>> 0) && (ws === 1 || ws === 2)) {
      restoreFromInprogress(ip);
      ST.pendingRecovery = null;
      if (watchActive !== null) ST.activeS = watchActive;
      ST.autopaused = ws === 2 && !!p.APAUSE;
      ST.paused = ws === 2 && !ST.autopaused;
      ST.activeAt = (ST.paused || ST.autopaused) ? 0 : now();
      ST.lastCmdSeq = Math.max(ST.lastCmdSeq, seq);
      persistInProgress();
      restoreGeoForSession();
      rlog('stale checkpoint resumed after watch reconciliation');
    } else if (sid && sid === (ip.sid >>> 0) && ws === 3) {
      if (finalizeRecovery(ip)) {
        var recovered = savedRunForSid(sid);
        if (recovered) {
          ST.sid = runId(recovered); ST.lastSaved = runId(recovered);
          sendSummary(recovered);
        }
      }
    } else if (!finalizeRecovery(ip)) {
      sendState(null, false);
      return;
    }
  }

  if (ST.recording) {
    if (p.DQ) ST.watchDq = 1;
    if (sid && sid !== (ST.sid >>> 0) && (ws === 1 || ws === 2 || ws === 3)) {
      // Never replace an authoritative live phone session with a second id.
      sendState(null, false);
      return;
    }
    if ((!sid || sid === (ST.sid >>> 0)) && seq > ST.lastCmdSeq) {
      ST.lastCmdSeq = seq;
      if (ws === 2 && !ST.paused && !ST.autopaused) pauseRun();
      else if (ws === 1 && (ST.paused || ST.autopaused)) resumeRun();
      else if (ws === 3) { stopRun(); sendState(); return; }
      persistInProgress();
    }
    if (watchActive !== null && watchActive > ST.activeS) {
      ST.activeS = watchActive;
      ST.activeAt = (ST.paused || ST.autopaused) ? 0 : now();
    }
    restoreGeoForSession();
    sendState();
    return;
  }

  var saved = sid ? savedRunForSid(sid) : null;
  if (saved) {
    ST.sid = runId(saved);
    ST.lastSaved = runId(saved);
    ST.lastCmdSeq = saved.cmdSeq || seq;
    ST.startAt = saved.start;
    ST.activeS = saved.active || saved.mov || 0;
    sendSummary(saved);
    sendState();
    return;
  }

  if (sid && (ws === 1 || ws === 2)) {
    startRun(sid, p.STARTTS ? p.STARTTS * 1000 : 0);
    if (!ST.recording) { sendState(null, false); return; }
    ST.activeS = watchActive !== null ? watchActive : 0;
    ST.lastCmdSeq = seq;
    if (p.DQ) ST.watchDq = 1;
    if (ws === 2) {
      ST.autopaused = !!p.APAUSE;
      ST.paused = !ST.autopaused;
      ST.activeAt = 0;
    } else {
      ST.paused = false; ST.autopaused = false; ST.activeAt = now();
    }
    restoreGeoForSession();
    persistInProgress();
    sendState();
    return;
  }

  if (ws === 3) {
    var unsavedSid = sid;
    ST.sid = 0;
    send({ NOSAVE: 1, PROTO: 3, SID: wireSid(unsavedSid) }, true);
    sendState();
    return;
  }

  // The watch is genuinely foreground and idle: preserve the existing warm
  // start behavior here, but never burn GPS for a phone-only config page.
  ST.sid = 0;
  startGeo();
  armIdleGpsRelease();
  sendState();
}

function handleCommand(p) {
  var cmd = p.CMD;
  var protocol = p.PROTO >= 2 && p.SID !== undefined && p.SEQ !== undefined;
  if (!protocol) {
    if (cmd === 1) startRun();
    else if (cmd === 2) pauseRun();
    else if (cmd === 3) resumeRun();
    else if (cmd === 4) stopRun();
    else if (cmd === 5) openRunLogPage(0);
    else if (cmd === 6) discardLast();
    else if (cmd === 7) uploadLast();
    else if (cmd === 8 || p.RENAME !== undefined) renameLast(p.RENAME);
    return;
  }

  var sid = p.SID >>> 0, seq = p.SEQ >>> 0;
  var cached = loadLastAck();
  if (cached && cached.sid === sid && cached.seq === seq && cached.cmd === cmd) {
    if (cmd === 4 && cached.result) {
      var prior = savedRunForSid(sid);
      if (prior) sendSummary(prior);
    }
    sendState(seq, !!cached.result);
    return;
  }

  var result = false;
  if (cmd === 1) {
    if (ST.pendingRecovery && sid === (ST.pendingRecovery.sid >>> 0)) {
      restoreFromInprogress(ST.pendingRecovery);
      ST.pendingRecovery = null;
    } else if (!ST.recording) {
      startRun(sid, p.STARTTS ? p.STARTTS * 1000 : 0);
    }
    result = ST.recording && sid === (ST.sid >>> 0);
    if (result && seq >= ST.lastCmdSeq) {
      ST.lastCmdSeq = seq;
      persistInProgress();
    }
  } else if (cmd >= 2 && cmd <= 4) {
    if (!ST.recording && p.PROTO >= 3 && sid && !savedRunForSid(sid)) {
      // The phone may have missed START and every intermediate control. A v3
      // packet is a complete state snapshot, and its sensor journal was ingested
      // before this handler, so reconstruct the session before applying intent.
      startRun(sid, p.STARTTS ? p.STARTTS * 1000 : 0);
      if (ST.recording) {
        ST.activeS = (p.ACTIVE !== undefined && p.ACTIVE >= 0) ? p.ACTIVE : 0;
        ST.activeAt = now();
        if (p.DQ) ST.watchDq = 1;
      }
    }
    if (ST.recording && sid === (ST.sid >>> 0) && seq >= ST.lastCmdSeq) {
      ST.lastCmdSeq = seq;
      if (cmd === 2) pauseRun();
      else if (cmd === 3) resumeRun();
      else stopRun();
      result = true;
    } else if (cmd === 4 && savedRunForSid(sid)) {
      sendSummary(savedRunForSid(sid));
      result = true;
    }
  } else if (cmd === 5) {
    openRunLogPage(0);
    result = true;
  } else if (cmd === 6) {
    result = discardLast(sid);
  } else if (cmd === 7) {
    result = uploadLast(sid);
  } else if (cmd === 8) {
    result = renameLast(p.RENAME, sid);
  }

  cacheAck(sid, seq, cmd, result);
  sendState(seq, result);
}

function jsafe(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function runId(r) {
  return (r && r.sid !== undefined && r.sid !== null && r.sid !== 0) ? r.sid : (r ? r.start : 0);
}
function runIndexById(runs, id) {
  for (var i = 0; i < runs.length; i++) if (runId(runs[i]) === id) return i;
  return -1;
}
function pageCfg(c) {
  return {
    auto: c.auto ? 1 : 0, preset: c.preset, url: c.url || '',
    user: c.user || '', name: c.name || '', fmt: c.fmt || 'gpx',
    hasAuth: !!c.auth, hasKey: !!c.key, hasPass: !!c.pass,
    hasTarget: hasTarget(c), target: normaliseWorkoutTarget(c.target),
    active: ST.recording ? 1 : 0,
    watch: { mi: WSET.mi ? 1 : 0, ap: WSET.ap ? 1 : 0,
             splits: WSET.splits ? 1 : 0, maxHr: WSET.maxHr,
             restHr: WSET.restHr, zone: WSET.zone ? 1 : 0 }
  };
}
function listRun(r) {
  return {
    name: r.name, start: r.start, sid: r.sid || 0, dist: r.dist,
    dur: r.dur, active: r.active, mov: r.mov, avgp: r.avgp, avgHr: r.avgHr,
    maxHr: r.maxHr, vo2max: r.vo2max, egain: r.egain, cad: r.cad,
    steps: r.steps, mi: r.mi, act: r.act, up: r.up, upMeta: r.upMeta,
    route: r.route === 0 ? 0 : 1, dq: r.dq ? 1 : 0, laps: r.laps || []
  };
}

function bestFullSplitPace(r) {
  var unit = unitM(!!r.mi) * C.SPLIT_MULT[activityIndex(r.act)], best = 0;
  for (var i = 0; i < (r.splits || []).length; i++) {
    var s = r.splits[i];
    if (s.d >= unit * 0.99 && s.s > 0) {
      var p = s.s / (s.d / 1000);
      if (!best || p < best) best = p;
    }
  }
  return best;
}

/* Comparisons are generated against the current saved index when detail opens,
 * rather than baked forever into a workout. Deleting/retyping an activity
 * therefore cannot leave behind a misleading "record" badge. */
function analysisContext(run, index) {
  var same = [], prior = null, i;
  for (i = 0; i < index.length; i++) {
    var r = index[i];
    if (runId(r) === runId(run) || activityIndex(r.act) !== activityIndex(run.act)) continue;
    same.push(r);
    if (r.start < run.start && (!prior || r.start > prior.start)) prior = r;
  }
  var ctx = { savedPeers: same.length, records: [] };
  if (prior) {
    ctx.previous = { start: prior.start };
    if (run.avgp > 0 && prior.avgp > 0)
      ctx.previous.pacePct = Math.round((prior.avgp - run.avgp) / prior.avgp * 1000) / 10;
    if (run.avgHr > 0 && prior.avgHr > 0) ctx.previous.hrDelta = run.avgHr - prior.avgHr;
    if (run.dist > 0 && prior.dist > 0)
      ctx.previous.distancePct = Math.round((run.dist - prior.dist) / prior.dist * 1000) / 10;
  }
  if (!same.length) return ctx;                 // first saved activity sets a baseline

  var maxD = 0, maxT = 0, maxE = 0, best = 0;
  for (i = 0; i < same.length; i++) {
    maxD = Math.max(maxD, same[i].dist || 0);
    maxT = Math.max(maxT, same[i].active || same[i].mov || 0);
    maxE = Math.max(maxE, same[i].egain || 0);
    if (!!same[i].mi === !!run.mi) {
      var bp = bestFullSplitPace(same[i]);
      if (bp && (!best || bp < best)) best = bp;
    }
  }
  if ((run.dist || 0) > maxD + 10) ctx.records.push('longest_distance');
  if ((run.active || run.mov || 0) > maxT + 5) ctx.records.push('longest_time');
  if ((run.egain || 0) >= 10 && run.egain > maxE + 3) ctx.records.push('most_ascent');
  var ownBest = bestFullSplitPace(run);
  if (ownBest && (!best || ownBest < best - 1)) ctx.records.push('fastest_split');
  return ctx;
}

function detailRunForPage(meta, index) {
  var run = hydrateRun(meta);
  if (!run.analysis && run.pts) recomputeDerived(run);
  run.analysis = run.analysis || {};
  run.analysis.context = analysisContext(run, index);
  // The page must receive every route in its one supported openURL call. Pack
  // each one as binary varints and let the page expand only the selected run.
  if (run.pts) {
    run.ptn = run.pts.length;
    run.ptb = encodePagePoints(run.pts);
    delete run.pts;
  }
  delete run._j;                                  // storage internals never enter page source
  return run;
}

function openRunLogPage(initialId) {
  var all = loadRunIndex(), detail = false, pageRuns = [], idx;
  if (initialId) {
    idx = runIndexById(all, initialId);
    if (idx >= 0) detail = true;
    else initialId = 0;
  }
  // Do not close and reopen the phone settings WebView to hydrate a selected
  // row. Current Pebble mobile builds close the settings screen after
  // webviewclosed and do not consume the second openURL request. All routes
  // travel compactly in this first page instead.
  for (var i = 0; i < all.length; i++)
    pageRuns.push(detailRunForPage(all[i], all));
  var runs = jsafe(pageRuns);
  var cfg = jsafe(pageCfg(loadCfg()));
  var mi = WSET.mi ? 'true' : 'false';
  var initial = jsafe(initialId || 0);
  var log = [];
  try {
    var rawLog = localStorage.getItem('runlog.log');
    var parsedLog = rawLog ? JSON.parse(rawLog) : [];
    if (Object.prototype.toString.call(parsedLog) === '[object Array]') log = parsedLog;
  } catch (eL) {}
  var html = PAGE
    .replace('"__RUNLOG_RUNS__"', function () { return runs; })
    .replace('"__RUNLOG_CFG__"', function () { return cfg; })
    .replace('"__RUNLOG_MILES__"', function () { return mi; })
    .replace('"__RUNLOG_INITIAL__"', function () { return initial; })
    .replace('"__RUNLOG_LOG__"', function () { return jsafe(log); })
    .replace('"__RUNLOG_DETAIL__"', function () { return detail ? 'true' : 'false'; });
  // Route streams are already URL-safe base64. Percent-encoding the HTML adds
  // one layer of overhead, whereas base64-wrapping the entire page would add a
  // second 4/3 expansion to every retained route.
  var url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  if (url.length > C.MAX_PAGE_URL_CHARS) {
    rlog('WARNING: activity page remains large (' + Math.round(url.length / 1024) +
         ' KB) despite lossless route compaction');
  }
  Pebble.openURL(url);
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

  if (act.act === 'open') {
    openRunLogPage(act.id);
    return;
  } else if (act.act === 'list') {
    openRunLogPage(0);
    return;
  } else if (act.act === 'cfg' && act.cfg) {
    var oldCfg = loadCfg(), nc = act.cfg;
    var authSet = (nc.authSet !== undefined) ? !!nc.authSet : nc.hasOwnProperty('auth');
    var keySet = (nc.keySet !== undefined) ? !!nc.keySet : nc.hasOwnProperty('key');
    var passSet = (nc.passSet !== undefined) ? !!nc.passSet : nc.hasOwnProperty('pass');
    var nextCfg = {
      auto: nc.auto ? 1 : 0,
      preset: nc.preset || 'custom',
      url: nc.url || '',
      auth: nc.clearAuth ? '' : (authSet ? (nc.auth || '') : oldCfg.auth),
      key: nc.clearKey ? '' : (keySet ? (nc.key || '') : oldCfg.key),
      user: nc.user || '',
      pass: nc.clearPass ? '' : (passSet ? (nc.pass || '') : oldCfg.pass),
      name: nc.name || '',
      target: normaliseWorkoutTarget(nc.target),
      fmt: (['gpx', 'tcx', 'fit'].indexOf(nc.fmt) >= 0) ? nc.fmt : 'gpx'
    };
    var workoutTargetChanged = JSON.stringify(oldCfg.target) !== JSON.stringify(nextCfg.target);
    var watchSettingsChanged = false;
    if (nc.watch && !ST.recording) {
      var nw = normaliseWatchConfig(nc.watch);
      watchSettingsChanged = nw.mi !== WSET.mi || nw.ap !== WSET.ap ||
        nw.splits !== WSET.splits || nw.maxHr !== WSET.maxHr ||
        nw.restHr !== WSET.restHr || nw.zone !== WSET.zone;
      if (watchSettingsChanged) {
        WSET.mi = nw.mi; WSET.ap = nw.ap; WSET.splits = nw.splits;
        WSET.maxHr = nw.maxHr; WSET.restHr = nw.restHr; WSET.zone = nw.zone;
        WSET.pending = true;
        storeWatchSet();
      }
    } else if (nc.watch && ST.recording) {
      rlog('watch settings unchanged: finish the active workout first');
    }
    rlog('settings saved (' + (act.cfg.preset || 'custom') + ')');
    storeCfg(nextCfg);
    if (workoutTargetChanged || watchSettingsChanged || WSET.pending)
      sendState(); // one protected packet carries target + any pending watch settings
    // Keep a valid FitTrackee token across unrelated edits (name/format).
    if (oldCfg.preset !== nextCfg.preset || oldCfg.url !== nextCfg.url ||
        oldCfg.user !== nextCfg.user || oldCfg.pass !== nextCfg.pass ||
        oldCfg.key !== nextCfg.key) {
      try { localStorage.removeItem('runlog.ftok'); } catch (eft) {}
    }
  } else if (act.act === 'trim') {
    trimSavedRun(act.id, act.first, act.last);
  } else if (act.act === 'retype' &&
             activityIndex(act.to) === Number(act.to)) {
    var rr = loadRunIndex();
    var rix = (act.id !== undefined) ? runIndexById(rr, act.id) : act.idx;
    if (rix >= 0 && rix < rr.length) {
      var rv = hydrateRun(rr[rix]);
      var newType = activityIndex(act.to);
      var oldName = rv.name;
      var wasUploaded = rv.up === 1;
      rv.act = newType;
      rv.name = nameFromTemplate(loadCfg().name, newType, rv.start);  // re-derive for the new activity
      recomputeDerived(rv);    // raw samples stay immutable; every activity-dependent field is rebuilt
      if (wasUploaded) rv.up = 3;   // local record no longer matches the uploaded copy
      rr[rix] = rv;
      storeRuns(rr);
      rlog('retyped "' + oldName + '" -> ' + C.ACT_NAME[newType] + ' ("' + rv.name + '")');
      if (wasUploaded) rlog('note: re-upload to update the server copy');
    }
  } else if (act.act === 'del') {
    var runs = loadRunIndex();
    var dix = (act.id !== undefined) ? runIndexById(runs, act.id) : act.idx;
    if (dix >= 0 && dix < runs.length) {
      runs.splice(dix, 1);
      storeRuns(runs);
    }
  } else if (act.act === 'retry') {
    var runs2 = loadRunIndex();
    var uix = (act.id !== undefined) ? runIndexById(runs2, act.id) : act.idx;
    if (uix >= 0 && uix < runs2.length) uploadRun(hydrateRun(runs2[uix]));
  } else if (act.act === 'clear') {
    if (storeRuns([], true)) {
      try { localStorage.removeItem('runlog.runs.corrupt'); } catch (eClear) {}
      ST.lastSaved = null;
    }
  }
});
