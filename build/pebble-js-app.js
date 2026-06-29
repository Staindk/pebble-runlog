/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;
/******/
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

	__webpack_require__(1);
	module.exports = __webpack_require__(2);


/***/ }),
/* 1 */
/***/ (function(module, exports) {

	/**
	 * Copyright 2024 Google LLC
	 *
	 * Licensed under the Apache License, Version 2.0 (the "License");
	 * you may not use this file except in compliance with the License.
	 * You may obtain a copy of the License at
	 *
	 *     http://www.apache.org/licenses/LICENSE-2.0
	 *
	 * Unless required by applicable law or agreed to in writing, software
	 * distributed under the License is distributed on an "AS IS" BASIS,
	 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	 * See the License for the specific language governing permissions and
	 * limitations under the License.
	 */
	
	(function(p) {
	  if (!p === undefined) {
	    console.error('Pebble object not found!?');
	    return;
	  }
	
	  // Aliases:
	  p.on = p.addEventListener;
	  p.off = p.removeEventListener;
	
	  // For Android (WebView-based) pkjs, print stacktrace for uncaught errors:
	  if (typeof window !== 'undefined' && window.addEventListener) {
	    window.addEventListener('error', function(event) {
	      if (event.error && event.error.stack) {
	        console.error('' + event.error + '\n' + event.error.stack);
	      }
	    });
	  }
	
	})(Pebble);


/***/ }),
/* 2 */
/***/ (function(module, exports, __webpack_require__) {

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
	
	var gpx = __webpack_require__(3);
	var tcx = __webpack_require__(4);
	var fit = __webpack_require__(5);
	
	/* Choose the export body/filename/content-type for the selected format. */
	function exportRun(run, fmt) {
	  fmt = (fmt === 'tcx' || fmt === 'fit') ? fmt : 'gpx';
	  var base = run.name.replace(/[^\w.\-]+/g, '_');
	  if (fmt === 'tcx') return { fname: base + '.tcx', contentType: 'application/vnd.garmin.tcx+xml', body: tcx.build(run), binary: false };
	  if (fmt === 'fit') return { fname: base + '.fit', contentType: 'application/vnd.ant.fit', body: fit.build(run), binary: true };
	  return { fname: base + '.gpx', contentType: 'application/gpx+xml', body: gpx.build(run), binary: false };
	}
	var ksmooth = __webpack_require__(6);
	var gps = __webpack_require__(7);
	
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
	var PAGE = __webpack_require__(8).TEMPLATE;
	
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


/***/ }),
/* 3 */
/***/ (function(module, exports) {

	/* GPX 1.1 builder (ES5) — used for uploads from the phone JS.
	 * Heart rate + cadence via Garmin TrackPointExtension; pauses become
	 * separate track segments.  Matches the builder inside tools/page.html.
	 *
	 * run.pts entries: [t, lat, lon, ele|'', hr, segFlag, cad]
	 *   t    unix seconds          ele  metres ('' if unknown)
	 *   hr   bpm (0 = unknown)     cad  steps/min (0 = unknown)
	 *   segFlag 1 = first point after a pause (new <trkseg>)
	 */
	
	function iso(t) {
	  return new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
	}
	
	function esc(s) {
	  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
	}
	
	function build(run) {
	  var o = [];
	  o.push('<?xml version="1.0" encoding="UTF-8"?>\n');
	  o.push('<gpx version="1.1" creator="RunLog for Pebble" ' +
	         'xmlns="http://www.topografix.com/GPX/1/1" ' +
	         'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n');
	  o.push('<metadata><time>' + iso(run.pts[0][0]) + '</time></metadata>\n');
	  var type = ['running', 'walking', 'cycling'][run.act || 0];
	  o.push('<trk><name>' + esc(run.name) + '</name><type>' + type + '</type>\n<trkseg>\n');
	  for (var i = 0; i < run.pts.length; i++) {
	    var p = run.pts[i];
	    if (p[5] && i > 0) o.push('</trkseg>\n<trkseg>\n');
	    o.push('<trkpt lat="' + p[1] + '" lon="' + p[2] + '">');
	    if (p[3] !== '' && p[3] !== null && p[3] !== undefined) o.push('<ele>' + p[3] + '</ele>');
	    o.push('<time>' + iso(p[0]) + '</time>');
	    var hr = p[4] > 0, cad = p.length > 6 && p[6] > 0;
	    if (hr || cad) {
	      o.push('<extensions><gpxtpx:TrackPointExtension>');
	      if (hr)  o.push('<gpxtpx:hr>' + p[4] + '</gpxtpx:hr>');
	      if (cad) o.push('<gpxtpx:cad>' + Math.round(p[6] / 2) + '</gpxtpx:cad>');
	      o.push('</gpxtpx:TrackPointExtension></extensions>');
	    }
	    o.push('</trkpt>\n');
	  }
	  o.push('</trkseg>\n</trk>\n</gpx>\n');
	  return o.join('');
	}
	
	module.exports = { build: build, iso: iso };


/***/ }),
/* 4 */
/***/ (function(module, exports) {

	/* TCX (Garmin Training Center) builder (ES5) — dual-use: required by
	 * index.js for uploads AND injected into tools/page.html for downloads.
	 * Shares the run.pts model with gpx.js: [t, lat, lon, ele|'', hr, seg, cad].
	 * Helpers are rl-prefixed so they don't collide with the page's own code. */
	function rlTcxIso(t) { return new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
	function rlTcxEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
	function rlTcxRad(d) { return d * Math.PI / 180; }
	function rlTcxCum(pts) {
	  // cumulative metres along the track (haversine between fixes)
	  var out = [0], R = 6371000, i;
	  for (i = 1; i < pts.length; i++) {
	    var a = pts[i - 1], b = pts[i];
	    var dLa = rlTcxRad(b[1] - a[1]), dLo = rlTcxRad(b[2] - a[2]);
	    var la1 = rlTcxRad(a[1]), la2 = rlTcxRad(b[1]);
	    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
	            Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
	    out.push(out[i - 1] + 2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
	  }
	  return out;
	}
	
	function rlTcxBuild(run) {
	  var pts = run.pts, act = run.act || 0;
	  var sport = ['Running', 'Other', 'Biking'][act];   // TCX has no "Walking"
	  var cum = rlTcxCum(pts);
	  var o = [];
	  o.push('<?xml version="1.0" encoding="UTF-8"?>\n');
	  o.push('<TrainingCenterDatabase ' +
	         'xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" ' +
	         'xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">\n');
	  o.push('<Activities><Activity Sport="' + sport + '">\n');
	  o.push('<Id>' + rlTcxIso(pts[0][0]) + '</Id>\n');
	  o.push('<Lap StartTime="' + rlTcxIso(pts[0][0]) + '">\n');
	  o.push('<TotalTimeSeconds>' + (run.dur || 0) + '</TotalTimeSeconds>');
	  o.push('<DistanceMeters>' + (run.dist || 0) + '</DistanceMeters>');
	  o.push('<Calories>0</Calories>');
	  if (run.avgHr > 0) o.push('<AverageHeartRateBpm><Value>' + run.avgHr + '</Value></AverageHeartRateBpm>');
	  if (run.maxHr > 0) o.push('<MaximumHeartRateBpm><Value>' + run.maxHr + '</Value></MaximumHeartRateBpm>');
	  o.push('<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>\n');
	  o.push('<Track>\n');
	  for (var i = 0; i < pts.length; i++) {
	    var p = pts[i];
	    o.push('<Trackpoint><Time>' + rlTcxIso(p[0]) + '</Time>');
	    o.push('<Position><LatitudeDegrees>' + p[1] + '</LatitudeDegrees>' +
	           '<LongitudeDegrees>' + p[2] + '</LongitudeDegrees></Position>');
	    if (p[3] !== '' && p[3] !== null && p[3] !== undefined)
	      o.push('<AltitudeMeters>' + p[3] + '</AltitudeMeters>');
	    o.push('<DistanceMeters>' + Math.round(cum[i] * 10) / 10 + '</DistanceMeters>');
	    if (p[4] > 0) o.push('<HeartRateBpm><Value>' + p[4] + '</Value></HeartRateBpm>');
	    var cad = (p.length > 6 && p[6] > 0) ? Math.round(p[6] / 2) : -1;   // rpm, matches GPX
	    if (cad >= 0) {
	      if (act === 2) o.push('<Cadence>' + Math.min(254, cad) + '</Cadence>');
	      else o.push('<Extensions><ns3:TPX><ns3:RunCadence>' + Math.min(254, cad) +
	                  '</ns3:RunCadence></ns3:TPX></Extensions>');
	    }
	    o.push('</Trackpoint>\n');
	  }
	  o.push('</Track>\n</Lap>\n');
	  o.push('<Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
	         '<Name>RunLog for Pebble</Name></Creator>\n');
	  o.push('</Activity></Activities></TrainingCenterDatabase>\n');
	  return o.join('');
	}
	
	if (typeof module !== 'undefined' && module.exports) module.exports = { build: rlTcxBuild };


/***/ }),
/* 5 */
/***/ (function(module, exports) {

	/* FIT activity-file builder (ES5) — dual-use: required by index.js for
	 * uploads, injected into tools/page.html for downloads. Emits a minimal but
	 * valid FIT file: file_id, record(s), lap, session, activity. Returns a
	 * Uint8Array. Shares run.pts: [t, lat, lon, ele|'', hr, seg, cad].
	 *
	 * FIT is little-endian. Scales: distance cm (x100), speed mm/s (x1000),
	 * altitude (m+500)x5, time = unix - 631065600 (FIT epoch 1989-12-31). */
	var RL_FIT_EPOCH = 631065600;
	var RL_SEMI = 2147483648 / 180;   // degrees -> semicircles
	
	function rlFitCrc(bytes) {
	  var table = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
	               0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
	  var crc = 0, i;
	  for (i = 0; i < bytes.length; i++) {
	    var b = bytes[i], t;
	    t = table[crc & 0xF]; crc = ((crc >> 4) & 0x0FFF) ^ t ^ table[b & 0xF];
	    t = table[crc & 0xF]; crc = ((crc >> 4) & 0x0FFF) ^ t ^ table[(b >> 4) & 0xF];
	  }
	  return crc & 0xFFFF;
	}
	
	function rlU8(a, v)  { a.push(v & 0xFF); }
	function rlU16(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); }
	function rlU32(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
	function rlT(unix)   { return (Math.round(unix) - RL_FIT_EPOCH) >>> 0; }
	function rlRad(d)    { return d * Math.PI / 180; }
	
	// base-type bytes
	var B_ENUM = 0x00, B_U8 = 0x02, B_U16 = 0x84, B_U32 = 0x86, B_I32 = 0x85, B_U32Z = 0x8C;
	
	// emit a definition message header + field list for a local type
	function rlDef(a, local, global, fields) {
	  a.push(0x40 | local, 0x00, 0x00);   // header, reserved, little-endian arch
	  rlU16(a, global);
	  a.push(fields.length);
	  for (var i = 0; i < fields.length; i++) a.push(fields[i][0], fields[i][1], fields[i][2]);
	}
	
	// data-message header: the local message type itself (bit6 clear)
	function rlData(a, local) { a.push(local & 0x0F); }
	
	function rlFitBuild(run) {
	  var pts = run.pts, act = run.act || 0, i;
	  var sport = [1, 11, 2][act];          // FIT sport: run / walk / cycle
	  var t0 = pts[0][0], tEnd = pts[pts.length - 1][0];
	
	  // cumulative distance (haversine)
	  var cum = [0], R = 6371000;
	  for (i = 1; i < pts.length; i++) {
	    var a1 = pts[i - 1], b1 = pts[i];
	    var dLa = rlRad(b1[1] - a1[1]), dLo = rlRad(b1[2] - a1[2]);
	    var hv = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
	             Math.cos(rlRad(a1[1])) * Math.cos(rlRad(b1[1])) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
	    cum.push(cum[i - 1] + 2 * R * Math.asin(Math.min(1, Math.sqrt(hv))));
	  }
	
	  var d = [];   // everything after the 14-byte header, before the 2-byte CRC
	
	  // ---- file_id (local 0) ----
	  rlDef(d, 0, 0, [[3, 4, B_U32Z], [4, 4, B_U32], [1, 2, B_U16], [2, 2, B_U16], [0, 1, B_ENUM]]);
	  rlData(d, 0);                        // file_id data
	  rlU32(d, 0);                        // serial_number (0 = unset)
	  rlU32(d, rlT(t0));                  // time_created
	  rlU16(d, 255);                      // manufacturer = development
	  rlU16(d, 0);                        // product
	  rlU8(d, 4);                         // type = activity
	
	  // ---- record (local 1): one definition, many data messages ----
	  rlDef(d, 1, 20, [[253, 4, B_U32], [0, 4, B_I32], [1, 4, B_I32], [5, 4, B_U32],
	                   [2, 2, B_U16], [6, 2, B_U16], [3, 1, B_U8], [4, 1, B_U8]]);
	  for (i = 0; i < pts.length; i++) {
	    var p = pts[i];
	    var spd = 0xFFFF;
	    if (i > 0) {
	      var dt = p[0] - pts[i - 1][0];
	      if (dt > 0) spd = Math.min(65534, Math.round((cum[i] - cum[i - 1]) / dt * 1000));
	    }
	    var alt = (p[3] !== '' && p[3] !== null && p[3] !== undefined)
	                ? Math.max(0, Math.min(65534, Math.round((p[3] + 500) * 5))) : 0xFFFF;
	    rlData(d, 1);                                // record data
	    rlU32(d, rlT(p[0]));                          // timestamp
	    rlU32(d, Math.round(p[1] * RL_SEMI));         // position_lat  (sint32 bit pattern)
	    rlU32(d, Math.round(p[2] * RL_SEMI));         // position_long
	    rlU32(d, Math.round(cum[i] * 100) >>> 0);     // distance (cm)
	    rlU16(d, alt);                                // altitude
	    rlU16(d, spd);                                // speed (mm/s)
	    rlU8(d, p[4] > 0 ? Math.min(254, p[4]) : 0xFF);                       // heart_rate
	    rlU8(d, (p.length > 6 && p[6] > 0) ? Math.min(254, Math.round(p[6] / 2)) : 0xFF);  // cadence (rpm)
	  }
	
	  // ---- lap (local 2) ----
	  rlDef(d, 2, 19, [[254, 2, B_U16], [253, 4, B_U32], [2, 4, B_U32], [7, 4, B_U32],
	                   [8, 4, B_U32], [9, 4, B_U32], [25, 1, B_ENUM]]);
	  rlData(d, 2);                        // lap data
	  rlU16(d, 0);                         // message_index
	  rlU32(d, rlT(tEnd));                 // timestamp
	  rlU32(d, rlT(t0));                   // start_time
	  rlU32(d, Math.round((run.dur || 0) * 1000) >>> 0);   // total_elapsed_time
	  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0); // total_timer_time
	  rlU32(d, Math.round((run.dist || 0) * 100) >>> 0);   // total_distance
	  rlU8(d, sport);
	
	  // ---- session (local 3) ----
	  rlDef(d, 3, 18, [[254, 2, B_U16], [253, 4, B_U32], [2, 4, B_U32], [7, 4, B_U32],
	                   [8, 4, B_U32], [9, 4, B_U32], [5, 1, B_ENUM], [26, 2, B_U16],
	                   [25, 2, B_U16], [16, 1, B_U8], [17, 1, B_U8]]);
	  rlData(d, 3);                        // session data
	  rlU16(d, 0);                         // message_index
	  rlU32(d, rlT(tEnd));                 // timestamp
	  rlU32(d, rlT(t0));                   // start_time
	  rlU32(d, Math.round((run.dur || 0) * 1000) >>> 0);
	  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0);
	  rlU32(d, Math.round((run.dist || 0) * 100) >>> 0);
	  rlU8(d, sport);
	  rlU16(d, 1);                         // num_laps
	  rlU16(d, 0);                         // first_lap_index
	  rlU8(d, run.avgHr > 0 ? Math.min(254, run.avgHr) : 0xFF);
	  rlU8(d, run.maxHr > 0 ? Math.min(254, run.maxHr) : 0xFF);
	
	  // ---- activity (local 4) ----
	  rlDef(d, 4, 34, [[253, 4, B_U32], [15, 4, B_U32], [1, 2, B_U16],
	                   [2, 1, B_ENUM], [3, 1, B_ENUM], [4, 1, B_ENUM], [5, 4, B_U32]]);
	  rlData(d, 4);                        // activity data
	  rlU32(d, rlT(tEnd));                 // timestamp
	  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0);  // total_timer_time
	  rlU16(d, 1);                         // num_sessions
	  rlU8(d, 0);                          // type = manual
	  rlU8(d, 26);                         // event = activity
	  rlU8(d, 1);                          // event_type = stop
	  rlU32(d, rlT(tEnd));                 // local_timestamp
	
	  // ---- header (14 bytes) ----
	  var hdr = [14, 0x20];                // size, protocol 2.0
	  rlU16(hdr, 2132);                    // profile version
	  rlU32(hdr, d.length);                // data size
	  hdr.push(0x2E, 0x46, 0x49, 0x54);    // ".FIT"
	  rlU16(hdr, rlFitCrc(hdr));           // header CRC over the first 12 bytes
	
	  var all = hdr.concat(d);
	  rlU16(all, rlFitCrc(all));           // file CRC over header + data
	
	  var out = new Uint8Array(all.length);
	  for (i = 0; i < all.length; i++) out[i] = all[i];
	  return out;
	}
	
	if (typeof module !== 'undefined' && module.exports) module.exports = { build: rlFitBuild, crc: rlFitCrc };


/***/ }),
/* 6 */
/***/ (function(module, exports) {

	/* RunLog — chart smoothing.
	 *
	 * A centered Gaussian-weighted moving average. Chosen over alternatives
	 * deliberately:
	 *   - trailing moving averages lag (peaks drift right);
	 *   - polynomial / spline fits can overshoot and invent features that
	 *     were never in the data, which is worse than chop for workout data;
	 *   - a centered kernel keeps every feature where it happened and just
	 *     takes the shimmer off.
	 *
	 * vals  : array of numbers, null = missing sample (kept as null)
	 * sigma : kernel width in samples (~window of +-3*sigma)
	 * brk   : optional array; brk[i] truthy means a new segment starts at i
	 *         (a pause) — smoothing never blends across it
	 */
	'use strict';
	
	function ksmooth(vals, sigma, brk) {
	  var n = vals.length;
	  if (n < 3 || !(sigma > 0)) return vals.slice();
	  var halfW = Math.max(1, Math.round(sigma * 3));
	  var w = [1], j;
	  for (j = 1; j <= halfW; j++) w.push(Math.exp(-(j * j) / (2 * sigma * sigma)));
	
	  var out = new Array(n);
	  for (var i = 0; i < n; i++) {
	    if (vals[i] === null || vals[i] === undefined) { out[i] = null; continue; }
	    var acc = vals[i], wt = 1;
	    for (j = 1; j <= halfW; j++) {              // walk left, stop at a pause
	      var L = i - j;
	      if (L < 0 || (brk && brk[L + 1])) break;
	      if (vals[L] !== null && vals[L] !== undefined) { acc += vals[L] * w[j]; wt += w[j]; }
	    }
	    for (j = 1; j <= halfW; j++) {              // walk right, stop at a pause
	      var R = i + j;
	      if (R >= n || (brk && brk[R])) break;
	      if (vals[R] !== null && vals[R] !== undefined) { acc += vals[R] * w[j]; wt += w[j]; }
	    }
	    out[i] = acc / wt;
	  }
	  return out;
	}
	
	if (typeof module !== 'undefined' && module.exports) module.exports = ksmooth;


/***/ }),
/* 7 */
/***/ (function(module, exports) {

	/* RunLog — GPS track filter (state-of-the-art for GPS-only input).
	 *
	 * A constant-velocity Kalman filter. Each fix is (lat, lon, accuracy, t):
	 *   - measurement noise R comes from the GPS horizontal accuracy (m^2), so
	 *     confident fixes pull hard and fuzzy ones barely move the estimate;
	 *   - process noise comes from a plausible human acceleration (m/s^2), so a
	 *     constant-velocity stride/pedal is tracked tightly while genuine turns
	 *     and pace changes still come through;
	 *   - velocity is seeded from the first step so there's no startup lag.
	 * Runs in a local metre plane anchored at the first fix; lat and lon are
	 * independent position+velocity filters. This is the right tool when GPS is
	 * the only signal (no onboard accel/baro to fuse on this hardware).
	 *
	 * dual-use: required by index.js, unit-tested in tools/test_formats.js.
	 */
	'use strict';
	
	function makeGpsFilter(opts) {
	  opts = opts || {};
	  var SIGMA_A = opts.accelStd || 0.7;     // process noise, m/s^2
	  var MIN_ACC = opts.minAccuracy || 3;    // floor on reported accuracy, m
	  var lat0 = 0, lon0 = 0, mLat = 0, mLon = 0;
	  var init = false, haveV = false, lastT = 0;
	  var x = [0, 0], y = [0, 0];              // per-axis [position_m, velocity_mps]
	  var Px = [[0, 0], [0, 0]], Py = [[0, 0], [0, 0]];
	
	  // one axis: constant-velocity predict over dt, then correct toward z (var R)
	  function step(s, P, z, dt, R) {
	    var dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt2 * dt2, q = SIGMA_A * SIGMA_A;
	    var p = s[0] + s[1] * dt;                       // predicted position
	    var a = P[0][0], b = P[0][1], c = P[1][0], d = P[1][1];
	    var p00 = a + dt * (b + c) + dt2 * d + q * dt4 / 4;   // F P F^T + Q
	    var p01 = b + dt * d + q * dt3 / 2;
	    var p10 = c + dt * d + q * dt3 / 2;
	    var p11 = d + q * dt2;
	    var Sinv = 1 / (p00 + R);                        // H = [1 0], meas var R
	    var k0 = p00 * Sinv, k1 = p10 * Sinv;
	    var innov = z - p;
	    s[0] = p + k0 * innov;
	    s[1] = s[1] + k1 * innov;
	    P[0][0] = (1 - k0) * p00; P[0][1] = (1 - k0) * p01;
	    P[1][0] = p10 - k1 * p00; P[1][1] = p11 - k1 * p01;
	    return s[0];
	  }
	
	  return {
	    update: function (lat, lon, accM, tSec) {
	      var acc = Math.max(MIN_ACC, (accM > 0 ? accM : 30));
	      var R = acc * acc;
	      if (!init) {
	        lat0 = lat; lon0 = lon;
	        mLat = 110540; mLon = 111320 * Math.cos(lat * Math.PI / 180);
	        x = [0, 0]; y = [0, 0];
	        Px = [[R, 0], [0, 1e4]]; Py = [[R, 0], [0, 1e4]];
	        init = true; haveV = false; lastT = tSec;
	        return { lat: lat, lon: lon, speed: 0 };
	      }
	      var dt = tSec - lastT;
	      if (dt <= 0) dt = 0.001;
	      lastT = tSec;
	      var mx = (lon - lon0) * mLon, my = (lat - lat0) * mLat;
	      if (!haveV) { x[1] = mx / dt; y[1] = my / dt; haveV = true; }  // seed velocity
	      var fx = step(x, Px, mx, dt, R);
	      var fy = step(y, Py, my, dt, R);
	      return {
	        lat: +(lat0 + fy / mLat).toFixed(6),
	        lon: +(lon0 + fx / mLon).toFixed(6),
	        speed: Math.sqrt(x[1] * x[1] + y[1] * y[1])
	      };
	    },
	    reset: function () { init = false; haveV = false; }
	  };
	}
	
	if (typeof module !== 'undefined' && module.exports) module.exports = { make: makeGpsFilter };


/***/ }),
/* 8 */
/***/ (function(module, exports) {

	/* GENERATED by tools/build_page.js from tools/page.html — do not edit. */
	module.exports.TEMPLATE = "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>RunLog</title>\n<style>\n  body{margin:0;padding:18px 14px 40px;background:#0f1419;color:#e8edf2;\n       font-family:-apple-system,Roboto,\"Segoe UI\",sans-serif;\n       font-variant-numeric:tabular-nums}\n  h1{font-size:17px;letter-spacing:.18em;margin:0 0 2px;color:#ff5a1f}\n  .sub{color:#7d8a96;font-size:13px;margin:0 0 16px}\n  .card{background:#1a2128;border-radius:12px;padding:14px;margin-bottom:12px}\n  .rcard{display:flex;align-items:center;cursor:pointer}\n  .rcard .km{font-size:30px;font-weight:700;line-height:1;min-width:104px}\n  .rcard .km small{font-size:12px;font-weight:400;color:#7d8a96;margin-left:3px}\n  .rcard .info{flex:1;min-width:0}\n  .rcard .name{font-size:13px;color:#aeb9c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .rcard .chips{font-size:13px;color:#7d8a96;margin-top:3px}\n  .badge{font-size:11px;border-radius:6px;padding:2px 6px;margin-left:8px;vertical-align:1px}\n  .b1{background:#143d23;color:#5ad17f}.b2{background:#46201a;color:#ff8d70}\n  .empty{color:#7d8a96;padding:30px 0;text-align:center}\n  button{appearance:none;border:0;border-radius:9px;padding:11px 14px;\n         font-size:14px;font-weight:600;cursor:pointer}\n  .dl{background:#ff5a1f;color:#fff}\n  .ghost{background:#26303a;color:#cfd8e0}\n  .danger{background:#26303a;color:#ff8d70}\n  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}\n  .row button{flex:1;min-width:120px}\n  /* detail */\n  .back{color:#7d8a96;font-size:14px;margin:0 0 10px;cursor:pointer;display:inline-block}\n  #map{position:relative;height:250px;overflow:hidden;border-radius:12px;\n       background:#1a2128 repeating-linear-gradient(0deg,transparent,transparent 23px,#222b33 24px),\n                  repeating-linear-gradient(90deg,transparent,transparent 23px,#222b33 24px);\n       touch-action:none;margin-bottom:4px}\n  #tilenote{position:absolute;left:8px;top:8px;z-index:5;font-size:11px;color:#9aa6b1;\n       background:rgba(15,20,25,.7);padding:2px 7px;border-radius:5px;display:none}\n  .maptip{font-size:11px;color:#7d8a96;margin-left:6px}\n  #mapinner{will-change:transform}\n  #mapinner{position:absolute;left:0;top:0;will-change:transform}\n  #mapinner img{position:absolute;width:256px;height:256px;user-select:none;\n                -webkit-user-drag:none;pointer-events:none}\n  #mapsvg{position:absolute;left:0;top:0;pointer-events:none}\n  .mapbtns{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:6px;z-index:5}\n  .mapbtns button{width:36px;height:36px;padding:0;font-size:19px;background:rgba(15,20,25,.82);color:#e8edf2}\n  .attrib{position:absolute;right:6px;bottom:4px;font-size:10px;color:#9aa6b1;\n          background:rgba(15,20,25,.6);padding:1px 5px;border-radius:4px;z-index:5}\n  .statgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0 4px}\n  .stat .cap{font-size:11px;letter-spacing:.1em;color:#7d8a96}\n  .stat .v{font-size:21px;font-weight:700;margin-top:1px}\n  .stat .v small{font-size:12px;font-weight:400;color:#7d8a96}\n  h2{font-size:12px;letter-spacing:.14em;color:#7d8a96;margin:20px 0 8px;font-weight:600}\n  canvas{width:100%;height:120px;display:block}\n  .split{display:flex;align-items:center;font-size:13px;margin:5px 0}\n  .split .n{width:26px;color:#7d8a96}\n  .split .bar{height:16px;background:#26303a;border-radius:4px;margin-right:8px}\n  .split .bar.best{background:#ff5a1f}\n  .split .t{width:46px}\n  .split .h{color:#7d8a96}\n  /* settings */\n  label{display:block;font-size:13px;color:#aeb9c4;margin:12px 0 4px}\n  input[type=text],input[type=password],select{width:100%;box-sizing:border-box;background:#0d1116;\n       color:#e8edf2;border:1px solid #26303a;border-radius:8px;padding:10px;font-size:14px}\n  .tog{display:flex;align-items:center;gap:10px;font-size:14px;margin-top:4px}\n  .tog input{width:20px;height:20px}\n  .note{font-size:12px;color:#7d8a96;margin-top:10px}\n  .logline{display:flex;gap:8px;font-size:12px;padding:3px 0;\n           border-bottom:1px solid #222b33;align-items:baseline}\n  .logline:last-child{border-bottom:none}\n  .lt{color:#7d8a96;white-space:nowrap;font-variant-numeric:tabular-nums}\n  .lm{color:#c7d0d9;word-break:break-word}\n  .lm.lbad{color:#ff8585}\n  #logcard code{background:#0d1116;border-radius:4px;padding:1px 5px;font-size:11px}\n  #pwtoggle{background:#26303a;color:#c7d0d9;border:none;border-radius:8px;\n            padding:9px 12px;font-size:13px}\n  #dtype{display:flex;gap:8px;margin:2px 0 14px}\n  #dtype button{flex:1;background:#1a2128;color:#7d8a96;border:1px solid #26303a;\n            border-radius:8px;padding:8px 0;font-size:13px}\n  #dtype button.on{background:#26303a;color:#fff;border-color:#ff5a1f}\n  .foot{margin-top:20px}.foot button{width:100%}\n</style>\n</head>\n<body>\n\n<div id=\"vlist\">\n  <h1>RUNLOG</h1>\n  <p class=\"sub\" id=\"subline\"></p>\n  <div id=\"list\"></div>\n\n  <div class=\"card\" id=\"setcard\">\n    <h2 style=\"margin-top:0\">RUN NAME</h2>\n    <label>Default run name template</label>\n    <input type=\"text\" id=\"cfgname\" placeholder=\"%Y-%m-%d_{activity}\"\n           autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\">\n    <p class=\"note\" id=\"cfgnamehint\">Date/time codes (strftime): %Y year, %y 2-digit year, %m month, %d day, %H hour, %M min, %S sec, %F date (YYYY-MM-DD), %T time (HH:MM:SS), %R HH:MM, %a/%A weekday, %b/%B month name, %p AM/PM, %j day-of-year, %D US date, %% literal %. Extras: {activity}/{Activity}, {part}/{Part} (morning/afternoon/evening/night). ({date} and {time} still work.) Blank = default %Y-%m-%d_{activity}.</p>\n    <h2>FILE FORMAT</h2>\n    <label>Export / upload format</label>\n    <select id=\"cfgfmt\">\n      <option value=\"gpx\">GPX (universal, text)</option>\n      <option value=\"tcx\">TCX (Garmin, text)</option>\n      <option value=\"fit\">FIT (binary)</option>\n    </select>\n    <p class=\"note\">GPX and TCX upload anywhere. FIT is binary &mdash; ideal for Strava/Garmin/intervals, but the destination must accept .fit.</p>\n    <h2>UPLOAD</h2>\n    <p class=\"note\" style=\"margin-top:0\">Uploads are manual &mdash; press Upload on the watch debrief, or \"Upload now\" on a run below. Nothing leaves your phone on its own.</p>\n    <label>Destination</label>\n    <select id=\"cfgpreset\" onchange=\"cfgUi()\">\n      <option value=\"intervals\">intervals.icu (API key)</option>\n      <option value=\"runalyze\">Runalyze (personal token)</option>\n      <option value=\"fittrackee\">FitTrackee (self-hosted)</option>\n      <option value=\"webdav\">WebDAV / Nextcloud (PUT)</option>\n      <option value=\"custom\">Custom webhook (POST)</option>\n    </select>\n    <div id=\"cfgurlrow\">\n      <label>Endpoint URL</label>\n      <input type=\"text\" id=\"cfgurl\" placeholder=\"https://example.com/runs/upload\">\n    </div>\n    <div id=\"cfgauthrow\">\n      <label>Authorization (optional) &mdash; header value or user:pass</label>\n      <input type=\"text\" id=\"cfgauth\" placeholder=\"Bearer xxxx &middot; Basic xxxx &middot; user:password\">\n    </div>\n    <div id=\"cfgkeyrow\" style=\"display:none\">\n      <label id=\"cfgkeylab\">API key</label>\n      <input type=\"text\" id=\"cfgkey\" placeholder=\"\">\n      <p class=\"note\" id=\"cfgkeyhint\"></p>\n    </div>\n    <div id=\"cfguserrow\" style=\"display:none\">\n      <label>FitTrackee email</label>\n      <input type=\"text\" id=\"cfguser\" placeholder=\"you@example.com\"\n             autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\"\n             inputmode=\"email\" autocomplete=\"email\">\n    </div>\n    <div id=\"cfgpassrow\" style=\"display:none\">\n      <label>FitTrackee password</label>\n      <div style=\"display:flex;gap:8px;align-items:center\">\n        <input type=\"password\" id=\"cfgpass\" placeholder=\"\" style=\"flex:1\"\n               autocapitalize=\"none\" autocorrect=\"off\" autocomplete=\"current-password\">\n        <button type=\"button\" id=\"pwtoggle\" onclick=\"togglePw()\">Show</button>\n      </div>\n      <p class=\"note\">RunLog logs in to your instance itself and refreshes the token automatically when it expires. Credentials stay in the Pebble app on this phone.</p>\n    </div>\n    <div class=\"row\">\n      <button class=\"dl\" onclick=\"saveCfg()\">Save settings &amp; close</button>\n    </div>\n    <p class=\"note\">Settings and per-run actions apply when this page closes. Download buttons work without closing.</p>\n  </div>\n\n  <div class=\"card\" id=\"logcard\">\n    <h2 style=\"margin-top:0\">LOG</h2>\n    <div id=\"loglines\"></div>\n    <p class=\"note\">Newest first &mdash; uploads, logins, GPS and saves. The same lines appear in <code>pebble logs</code>.</p>\n  </div>\n\n  <div class=\"foot\">\n    <button class=\"ghost\" onclick=\"clearAll()\">Delete all runs</button>\n    <div style=\"height:10px\"></div>\n    <button class=\"dl\" onclick=\"closePage('')\">Done</button>\n  </div>\n</div>\n\n<div id=\"vdetail\" style=\"display:none\">\n  <span class=\"back\" onclick=\"showList()\">&#8592; All runs</span>\n  <div id=\"dtitle\" class=\"sub\" style=\"margin:0 0 8px\"></div>\n\n  <div id=\"map\">\n    <div id=\"mapinner\"></div>\n    <div id=\"tilenote\">map tiles unavailable &mdash; route on grid</div>\n    <div class=\"mapbtns\">\n      <button onclick=\"zoomBy(1)\">+</button>\n      <button onclick=\"zoomBy(-1)\">&#8722;</button>\n      <span class=\"maptip\">pinch or double-tap to zoom</span>\n    </div>\n    <div class=\"attrib\">&copy; OpenStreetMap contributors &copy; CARTO</div>\n  </div>\n\n  <div class=\"statgrid\" id=\"dstats\"></div>\n\n  <h2 id=\"hspeed\"></h2><canvas id=\"cspeed\"></canvas>\n  <h2 id=\"hele\"></h2><canvas id=\"cele\"></canvas>\n  <h2>HEART RATE <span style=\"float:right;letter-spacing:0\" id=\"hrsum\"></span></h2><canvas id=\"chr\"></canvas>\n\n  <div id=\"dtype\"></div>\n  <h2 id=\"hsplits\"></h2>\n  <div id=\"splits\"></div>\n\n  <div class=\"row\">\n    <button class=\"dl\" id=\"dlbtn\" onclick=\"dl()\">Download</button>\n    <button class=\"ghost\" id=\"upbtn\" onclick=\"uploadNow()\" style=\"display:none\">Upload now</button>\n    <button class=\"danger\" onclick=\"delRun()\">Delete run</button>\n  </div>\n</div>\n\n<script>\nvar RUNS = \"__RUNLOG_RUNS__\";\nvar CFG  = \"__RUNLOG_CFG__\";\nvar MILES = \"__RUNLOG_MILES__\";\nvar INITIAL = \"__RUNLOG_INITIAL__\";\nvar LOGL = \"__RUNLOG_LOG__\";\nvar CUR = -1;\nvar UD = MILES ? 1609.344 : 1000;\nvar UN = MILES ? 'mi' : 'km';\n\nfunction $(id){ return document.getElementById(id); }\nfunction z2(n){ return (n < 10 ? '0' : '') + n; }\nfunction fmtDur(s){ s = Math.round(s); var h = Math.floor(s/3600), m = Math.floor(s%3600/60);\n  return (h ? h + ':' + z2(m) : m) + ':' + z2(s%60); }\nfunction fmtDist(m){ return (m/UD).toFixed(2); }\nfunction fmtPace(skm){ if (!skm) return '--:--';\n  var s = Math.round(MILES ? skm*1.609344 : skm);\n  return Math.floor(s/60) + ':' + z2(s%60); }\nfunction fmtSpeed(v){ if (!v) return '--';\n  return v >= 10 ? String(Math.round(v)) : v.toFixed(1); }\nfunction fmtEg(m){ return MILES ? Math.round(m*3.28084)+' ft' : Math.round(m)+' m'; }\nfunction actOf(r){ return (r.act >= 0 && r.act <= 2) ? r.act : 0; }\nfunction splitUnit(r){ return UD * (actOf(r) === 2 ? 5 : 1); }\nfunction paceOrSpeed(r, skm){          // rides read in km/h (mph), the rest in pace\n  if (!skm) return '--';\n  if (actOf(r) === 2) return fmtSpeed((3600/skm) * (MILES ? 0.6213712 : 1)) + ' ' + (MILES ? 'mph' : 'km/h');\n  return fmtPace(skm) + ' /' + UN;\n}\n\n/* ---------- exporters: TCX + FIT injected here by tools/build_page.js ---------- */\n/* TCX (Garmin Training Center) builder (ES5) — dual-use: required by\n * index.js for uploads AND injected into tools/page.html for downloads.\n * Shares the run.pts model with gpx.js: [t, lat, lon, ele|'', hr, seg, cad].\n * Helpers are rl-prefixed so they don't collide with the page's own code. */\nfunction rlTcxIso(t) { return new Date(t * 1000).toISOString().replace(/\\.\\d{3}Z$/, 'Z'); }\nfunction rlTcxEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }\nfunction rlTcxRad(d) { return d * Math.PI / 180; }\nfunction rlTcxCum(pts) {\n  // cumulative metres along the track (haversine between fixes)\n  var out = [0], R = 6371000, i;\n  for (i = 1; i < pts.length; i++) {\n    var a = pts[i - 1], b = pts[i];\n    var dLa = rlTcxRad(b[1] - a[1]), dLo = rlTcxRad(b[2] - a[2]);\n    var la1 = rlTcxRad(a[1]), la2 = rlTcxRad(b[1]);\n    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) +\n            Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);\n    out.push(out[i - 1] + 2 * R * Math.asin(Math.min(1, Math.sqrt(h))));\n  }\n  return out;\n}\n\nfunction rlTcxBuild(run) {\n  var pts = run.pts, act = run.act || 0;\n  var sport = ['Running', 'Other', 'Biking'][act];   // TCX has no \"Walking\"\n  var cum = rlTcxCum(pts);\n  var o = [];\n  o.push('<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n');\n  o.push('<TrainingCenterDatabase ' +\n         'xmlns=\"http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2\" ' +\n         'xmlns:ns3=\"http://www.garmin.com/xmlschemas/ActivityExtension/v2\">\\n');\n  o.push('<Activities><Activity Sport=\"' + sport + '\">\\n');\n  o.push('<Id>' + rlTcxIso(pts[0][0]) + '</Id>\\n');\n  o.push('<Lap StartTime=\"' + rlTcxIso(pts[0][0]) + '\">\\n');\n  o.push('<TotalTimeSeconds>' + (run.dur || 0) + '</TotalTimeSeconds>');\n  o.push('<DistanceMeters>' + (run.dist || 0) + '</DistanceMeters>');\n  o.push('<Calories>0</Calories>');\n  if (run.avgHr > 0) o.push('<AverageHeartRateBpm><Value>' + run.avgHr + '</Value></AverageHeartRateBpm>');\n  if (run.maxHr > 0) o.push('<MaximumHeartRateBpm><Value>' + run.maxHr + '</Value></MaximumHeartRateBpm>');\n  o.push('<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>\\n');\n  o.push('<Track>\\n');\n  for (var i = 0; i < pts.length; i++) {\n    var p = pts[i];\n    o.push('<Trackpoint><Time>' + rlTcxIso(p[0]) + '</Time>');\n    o.push('<Position><LatitudeDegrees>' + p[1] + '</LatitudeDegrees>' +\n           '<LongitudeDegrees>' + p[2] + '</LongitudeDegrees></Position>');\n    if (p[3] !== '' && p[3] !== null && p[3] !== undefined)\n      o.push('<AltitudeMeters>' + p[3] + '</AltitudeMeters>');\n    o.push('<DistanceMeters>' + Math.round(cum[i] * 10) / 10 + '</DistanceMeters>');\n    if (p[4] > 0) o.push('<HeartRateBpm><Value>' + p[4] + '</Value></HeartRateBpm>');\n    var cad = (p.length > 6 && p[6] > 0) ? Math.round(p[6] / 2) : -1;   // rpm, matches GPX\n    if (cad >= 0) {\n      if (act === 2) o.push('<Cadence>' + Math.min(254, cad) + '</Cadence>');\n      else o.push('<Extensions><ns3:TPX><ns3:RunCadence>' + Math.min(254, cad) +\n                  '</ns3:RunCadence></ns3:TPX></Extensions>');\n    }\n    o.push('</Trackpoint>\\n');\n  }\n  o.push('</Track>\\n</Lap>\\n');\n  o.push('<Creator xsi:type=\"Device_t\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">' +\n         '<Name>RunLog for Pebble</Name></Creator>\\n');\n  o.push('</Activity></Activities></TrainingCenterDatabase>\\n');\n  return o.join('');\n}\n\nif (typeof module !== 'undefined' && module.exports) module.exports = { build: rlTcxBuild };\n\n/* FIT activity-file builder (ES5) — dual-use: required by index.js for\n * uploads, injected into tools/page.html for downloads. Emits a minimal but\n * valid FIT file: file_id, record(s), lap, session, activity. Returns a\n * Uint8Array. Shares run.pts: [t, lat, lon, ele|'', hr, seg, cad].\n *\n * FIT is little-endian. Scales: distance cm (x100), speed mm/s (x1000),\n * altitude (m+500)x5, time = unix - 631065600 (FIT epoch 1989-12-31). */\nvar RL_FIT_EPOCH = 631065600;\nvar RL_SEMI = 2147483648 / 180;   // degrees -> semicircles\n\nfunction rlFitCrc(bytes) {\n  var table = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,\n               0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];\n  var crc = 0, i;\n  for (i = 0; i < bytes.length; i++) {\n    var b = bytes[i], t;\n    t = table[crc & 0xF]; crc = ((crc >> 4) & 0x0FFF) ^ t ^ table[b & 0xF];\n    t = table[crc & 0xF]; crc = ((crc >> 4) & 0x0FFF) ^ t ^ table[(b >> 4) & 0xF];\n  }\n  return crc & 0xFFFF;\n}\n\nfunction rlU8(a, v)  { a.push(v & 0xFF); }\nfunction rlU16(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); }\nfunction rlU32(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }\nfunction rlT(unix)   { return (Math.round(unix) - RL_FIT_EPOCH) >>> 0; }\nfunction rlRad(d)    { return d * Math.PI / 180; }\n\n// base-type bytes\nvar B_ENUM = 0x00, B_U8 = 0x02, B_U16 = 0x84, B_U32 = 0x86, B_I32 = 0x85, B_U32Z = 0x8C;\n\n// emit a definition message header + field list for a local type\nfunction rlDef(a, local, global, fields) {\n  a.push(0x40 | local, 0x00, 0x00);   // header, reserved, little-endian arch\n  rlU16(a, global);\n  a.push(fields.length);\n  for (var i = 0; i < fields.length; i++) a.push(fields[i][0], fields[i][1], fields[i][2]);\n}\n\n// data-message header: the local message type itself (bit6 clear)\nfunction rlData(a, local) { a.push(local & 0x0F); }\n\nfunction rlFitBuild(run) {\n  var pts = run.pts, act = run.act || 0, i;\n  var sport = [1, 11, 2][act];          // FIT sport: run / walk / cycle\n  var t0 = pts[0][0], tEnd = pts[pts.length - 1][0];\n\n  // cumulative distance (haversine)\n  var cum = [0], R = 6371000;\n  for (i = 1; i < pts.length; i++) {\n    var a1 = pts[i - 1], b1 = pts[i];\n    var dLa = rlRad(b1[1] - a1[1]), dLo = rlRad(b1[2] - a1[2]);\n    var hv = Math.sin(dLa / 2) * Math.sin(dLa / 2) +\n             Math.cos(rlRad(a1[1])) * Math.cos(rlRad(b1[1])) * Math.sin(dLo / 2) * Math.sin(dLo / 2);\n    cum.push(cum[i - 1] + 2 * R * Math.asin(Math.min(1, Math.sqrt(hv))));\n  }\n\n  var d = [];   // everything after the 14-byte header, before the 2-byte CRC\n\n  // ---- file_id (local 0) ----\n  rlDef(d, 0, 0, [[3, 4, B_U32Z], [4, 4, B_U32], [1, 2, B_U16], [2, 2, B_U16], [0, 1, B_ENUM]]);\n  rlData(d, 0);                        // file_id data\n  rlU32(d, 0);                        // serial_number (0 = unset)\n  rlU32(d, rlT(t0));                  // time_created\n  rlU16(d, 255);                      // manufacturer = development\n  rlU16(d, 0);                        // product\n  rlU8(d, 4);                         // type = activity\n\n  // ---- record (local 1): one definition, many data messages ----\n  rlDef(d, 1, 20, [[253, 4, B_U32], [0, 4, B_I32], [1, 4, B_I32], [5, 4, B_U32],\n                   [2, 2, B_U16], [6, 2, B_U16], [3, 1, B_U8], [4, 1, B_U8]]);\n  for (i = 0; i < pts.length; i++) {\n    var p = pts[i];\n    var spd = 0xFFFF;\n    if (i > 0) {\n      var dt = p[0] - pts[i - 1][0];\n      if (dt > 0) spd = Math.min(65534, Math.round((cum[i] - cum[i - 1]) / dt * 1000));\n    }\n    var alt = (p[3] !== '' && p[3] !== null && p[3] !== undefined)\n                ? Math.max(0, Math.min(65534, Math.round((p[3] + 500) * 5))) : 0xFFFF;\n    rlData(d, 1);                                // record data\n    rlU32(d, rlT(p[0]));                          // timestamp\n    rlU32(d, Math.round(p[1] * RL_SEMI));         // position_lat  (sint32 bit pattern)\n    rlU32(d, Math.round(p[2] * RL_SEMI));         // position_long\n    rlU32(d, Math.round(cum[i] * 100) >>> 0);     // distance (cm)\n    rlU16(d, alt);                                // altitude\n    rlU16(d, spd);                                // speed (mm/s)\n    rlU8(d, p[4] > 0 ? Math.min(254, p[4]) : 0xFF);                       // heart_rate\n    rlU8(d, (p.length > 6 && p[6] > 0) ? Math.min(254, Math.round(p[6] / 2)) : 0xFF);  // cadence (rpm)\n  }\n\n  // ---- lap (local 2) ----\n  rlDef(d, 2, 19, [[254, 2, B_U16], [253, 4, B_U32], [2, 4, B_U32], [7, 4, B_U32],\n                   [8, 4, B_U32], [9, 4, B_U32], [25, 1, B_ENUM]]);\n  rlData(d, 2);                        // lap data\n  rlU16(d, 0);                         // message_index\n  rlU32(d, rlT(tEnd));                 // timestamp\n  rlU32(d, rlT(t0));                   // start_time\n  rlU32(d, Math.round((run.dur || 0) * 1000) >>> 0);   // total_elapsed_time\n  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0); // total_timer_time\n  rlU32(d, Math.round((run.dist || 0) * 100) >>> 0);   // total_distance\n  rlU8(d, sport);\n\n  // ---- session (local 3) ----\n  rlDef(d, 3, 18, [[254, 2, B_U16], [253, 4, B_U32], [2, 4, B_U32], [7, 4, B_U32],\n                   [8, 4, B_U32], [9, 4, B_U32], [5, 1, B_ENUM], [26, 2, B_U16],\n                   [25, 2, B_U16], [16, 1, B_U8], [17, 1, B_U8]]);\n  rlData(d, 3);                        // session data\n  rlU16(d, 0);                         // message_index\n  rlU32(d, rlT(tEnd));                 // timestamp\n  rlU32(d, rlT(t0));                   // start_time\n  rlU32(d, Math.round((run.dur || 0) * 1000) >>> 0);\n  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0);\n  rlU32(d, Math.round((run.dist || 0) * 100) >>> 0);\n  rlU8(d, sport);\n  rlU16(d, 1);                         // num_laps\n  rlU16(d, 0);                         // first_lap_index\n  rlU8(d, run.avgHr > 0 ? Math.min(254, run.avgHr) : 0xFF);\n  rlU8(d, run.maxHr > 0 ? Math.min(254, run.maxHr) : 0xFF);\n\n  // ---- activity (local 4) ----\n  rlDef(d, 4, 34, [[253, 4, B_U32], [15, 4, B_U32], [1, 2, B_U16],\n                   [2, 1, B_ENUM], [3, 1, B_ENUM], [4, 1, B_ENUM], [5, 4, B_U32]]);\n  rlData(d, 4);                        // activity data\n  rlU32(d, rlT(tEnd));                 // timestamp\n  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0);  // total_timer_time\n  rlU16(d, 1);                         // num_sessions\n  rlU8(d, 0);                          // type = manual\n  rlU8(d, 26);                         // event = activity\n  rlU8(d, 1);                          // event_type = stop\n  rlU32(d, rlT(tEnd));                 // local_timestamp\n\n  // ---- header (14 bytes) ----\n  var hdr = [14, 0x20];                // size, protocol 2.0\n  rlU16(hdr, 2132);                    // profile version\n  rlU32(hdr, d.length);                // data size\n  hdr.push(0x2E, 0x46, 0x49, 0x54);    // \".FIT\"\n  rlU16(hdr, rlFitCrc(hdr));           // header CRC over the first 12 bytes\n\n  var all = hdr.concat(d);\n  rlU16(all, rlFitCrc(all));           // file CRC over header + data\n\n  var out = new Uint8Array(all.length);\n  for (i = 0; i < all.length; i++) out[i] = all[i];\n  return out;\n}\n\nif (typeof module !== 'undefined' && module.exports) module.exports = { build: rlFitBuild, crc: rlFitCrc };\n\n\n/* ---------- GPX ---------- */\nfunction iso(t){ return new Date(t*1000).toISOString().replace(/\\.\\d{3}Z$/, 'Z'); }\nfunction gpx(r){\n  var o = ['<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n',\n    '<gpx version=\"1.1\" creator=\"RunLog for Pebble\" ',\n    'xmlns=\"http://www.topografix.com/GPX/1/1\" ',\n    'xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\">\\n',\n    '<metadata><time>' + iso(r.pts[0][0]) + '</time></metadata>\\n',\n    '<trk><name>' + r.name + '</name><type>' +\n      ['running','walking','cycling'][actOf(r)] + '</type>\\n<trkseg>\\n'];\n  for (var i = 0; i < r.pts.length; i++) {\n    var p = r.pts[i];\n    if (p[5] && i > 0) o.push('</trkseg>\\n<trkseg>\\n');\n    o.push('<trkpt lat=\"' + p[1] + '\" lon=\"' + p[2] + '\">');\n    if (p[3] !== '' && p[3] !== null) o.push('<ele>' + p[3] + '</ele>');\n    o.push('<time>' + iso(p[0]) + '</time>');\n    var hr = p[4] > 0, cad = p.length > 6 && p[6] > 0;\n    if (hr || cad) {\n      o.push('<extensions><gpxtpx:TrackPointExtension>');\n      if (hr)  o.push('<gpxtpx:hr>' + p[4] + '</gpxtpx:hr>');\n      if (cad) o.push('<gpxtpx:cad>' + Math.round(p[6]/2) + '</gpxtpx:cad>');\n      o.push('</gpxtpx:TrackPointExtension></extensions>');\n    }\n    o.push('</trkpt>\\n');\n  }\n  o.push('</trkseg>\\n</trk>\\n</gpx>\\n');\n  return o.join('');\n}\n\n/* ---------- list view ---------- */\nfunction badge(up){\n  if (up === 1) return '<span class=\"badge b1\">uploaded</span>';\n  if (up === 2) return '<span class=\"badge b2\">upload failed</span>';\n  return '';\n}\nfunction showList(){\n  $('vdetail').style.display = 'none';\n  $('vlist').style.display = '';\n  CUR = -1;\n}\nfunction renderList(){\n  $('subline').innerHTML = RUNS.length + ' saved run' + (RUNS.length === 1 ? '' : 's') +\n    ' &middot; tap a run for the full debrief';\n  if (!RUNS.length) {\n    $('list').innerHTML = '<p class=\"empty\">No runs saved yet.<br>Finish a run on the watch, then come back here.</p>';\n    return;\n  }\n  var h = '';\n  for (var i = RUNS.length - 1; i >= 0; i--) {\n    var r = RUNS[i];\n    h += '<div class=\"card rcard\" onclick=\"showDetail(' + i + ')\">' +\n      '<div class=\"km\">' + fmtDist(r.dist) + '<small>' + UN + '</small></div>' +\n      '<div class=\"info\"><div class=\"name\">' + r.name + badge(r.up) + '</div>' +\n      '<div class=\"chips\">' + fmtDur(r.mov || r.dur) + ' &middot; ' + paceOrSpeed(r, r.avgp) +\n      (r.avgHr ? ' &middot; &#9829; ' + r.avgHr : '') + '</div></div>' +\n      '<div style=\"color:#7d8a96\">&#8250;</div></div>';\n  }\n  $('list').innerHTML = h;\n}\n\n/* ---------- detail view ---------- */\nfunction stat(cap, v, sub){\n  return '<div class=\"stat\"><div class=\"cap\">' + cap + '</div><div class=\"v\">' + v +\n         (sub ? ' <small>' + sub + '</small>' : '') + '</div></div>';\n}\nfunction showDetail(i){\n  CUR = i;\n  var r = RUNS[i];\n  $('vlist').style.display = 'none';\n  $('vdetail').style.display = '';\n  $('dtitle').innerHTML = r.name + badge(r.up);\n\n  var best = bestSplit(r);\n  var ride = actOf(r) === 2;\n  var su = splitUnit(r) / UD;            // 1 or 5\n  $('dstats').innerHTML =\n    stat('DISTANCE', fmtDist(r.dist), UN) +\n    stat('MOVING TIME', fmtDur(r.mov || r.dur), r.mov && r.dur > r.mov + 5 ? fmtDur(r.dur) + ' total' : '') +\n    (ride ? stat('AVG SPEED', r.avgp ? fmtSpeed((3600/r.avgp) * (MILES ? 0.6213712 : 1)) : '--', MILES ? 'mph' : 'km/h')\n          : stat('AVG PACE', fmtPace(r.avgp), '/' + UN)) +\n    stat('AVG HR', r.avgHr || '--', r.maxHr ? r.maxHr + ' max' : '') +\n    stat('ELEV GAIN', fmtEg(r.egain || 0), '') +\n    (ride ? stat('MAX SPEED', best ? fmtSpeed((3600/best) * (MILES ? 0.6213712 : 1)) : '--', MILES ? 'mph' : 'km/h')\n          : stat('CADENCE', r.cad || '--', 'spm')) +\n    (ride ? stat('ELAPSED', fmtDur(r.dur), r.dur > (r.mov||r.dur) + 5 ? 'incl. stops' : '')\n          : stat('STEPS', r.steps || '--', '')) +\n    (ride ? stat('BEST ' + su + UN.toUpperCase(), best ? fmtSpeed((3600/best) * (MILES ? 0.6213712 : 1)) : '--', MILES ? 'mph' : 'km/h')\n          : stat('BEST ' + UN.toUpperCase(), best ? fmtPace(best) : '--', '/' + UN));\n\n  $('hspeed').textContent = 'SPEED ' + (MILES ? 'MPH' : 'KM/H');\n  $('hele').textContent = 'ELEVATION';\n  $('hsplits').textContent = 'SPLITS (' + (actOf(r) === 2 ? '5 ' : '') + UN.toUpperCase() + ')';\n  var tns = ['Run', 'Walk', 'Ride'], th = '';\n  for (var ti = 0; ti < 3; ti++) {\n    th += '<button class=\"' + (actOf(r) === ti ? 'ton on' : 'ton') +\n          '\" onclick=\"retype(' + ti + ')\">' + tns[ti] + '</button>';\n  }\n  $('dtype').innerHTML = th;\n  $('hrsum').textContent = r.avgHr ? r.avgHr + ' avg / ' + r.maxHr + ' max' : '';\n  $('upbtn').style.display = ((CFG.url || CFG.key) ? '' : 'none');\n  $('upbtn').textContent = (r.up === 1) ? 'Re-upload' : 'Upload now';\n\n  series(r);\n  renderSplits(r);\n  initMap(r);\n}\nfunction bestSplit(r){\n  var b = 0, SU = splitUnit(r);\n  if (r.splits) for (var i = 0; i < r.splits.length; i++) {\n    var s = r.splits[i];\n    if (s.d > SU * 0.99) { var p = s.s / (s.d / 1000); if (!b || p < b) b = p; }\n  }\n  return b;\n}\n\n/* ---------- charts ---------- */\n/* Centered Gaussian moving average — same algorithm as src/pkjs/smooth.js\n * (the page is standalone, so it carries a copy). null = missing sample,\n * brk[i] = a pause starts at point i, never smoothed across. */\nfunction ksmooth(vals, sigma, brk){\n  var n = vals.length;\n  if (n < 3 || !(sigma > 0)) return vals.slice();\n  var halfW = Math.max(1, Math.round(sigma * 3));\n  var w = [1], j;\n  for (j = 1; j <= halfW; j++) w.push(Math.exp(-(j*j) / (2*sigma*sigma)));\n  var out = new Array(n);\n  for (var i = 0; i < n; i++) {\n    if (vals[i] === null || vals[i] === undefined) { out[i] = null; continue; }\n    var acc = vals[i], wt = 1;\n    for (j = 1; j <= halfW; j++) {\n      var L = i - j;\n      if (L < 0 || (brk && brk[L + 1])) break;\n      if (vals[L] !== null && vals[L] !== undefined) { acc += vals[L]*w[j]; wt += w[j]; }\n    }\n    for (j = 1; j <= halfW; j++) {\n      var R = i + j;\n      if (R >= n || (brk && brk[R])) break;\n      if (vals[R] !== null && vals[R] !== undefined) { acc += vals[R]*w[j]; wt += w[j]; }\n    }\n    out[i] = acc / wt;\n  }\n  return out;\n}\nfunction rad(x){ return x * Math.PI / 180; }\nfunction hav(a, b){\n  var R = 6371000, dla = rad(b[1]-a[1]), dlo = rad(b[2]-a[2]);\n  var s = Math.sin(dla/2)*Math.sin(dla/2) +\n          Math.cos(rad(a[1]))*Math.cos(rad(b[1]))*Math.sin(dlo/2)*Math.sin(dlo/2);\n  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));\n}\nfunction series(r){\n  var xs = [0], rawSpd = [null], hr = [r.pts[0][4] || null], ele = [r.pts[0][3] === '' ? null : r.pts[0][3]];\n  var brk = [false], cum = 0;\n  for (var i = 1; i < r.pts.length; i++) {\n    var a = r.pts[i-1], b = r.pts[i];\n    var d = b[5] ? 0 : hav(a, b);\n    var dt = b[0] - a[0];\n    cum += d;\n    xs.push(cum / UD);\n    brk.push(!!b[5]);\n    rawSpd.push((b[5] || dt <= 0) ? null : d / dt);   // m/s, null across pauses\n    hr.push(b[4] > 0 ? b[4] : null);\n    ele.push(b[3] === '' ? null : b[3]);\n  }\n  // kernel width scales with how dense the recording is; elevation is the\n  // noisiest signal (GPS altitude) so it gets a wider one\n  var sg = Math.max(2, Math.min(10, r.pts.length / 120));\n  var speed = ksmooth(rawSpd, sg, brk).map(function(v){\n    return (v && v > 0.2) ? v * (MILES ? 2.236936 : 3.6) : null;\n  });\n  var hrS  = ksmooth(hr,  sg,       brk);\n  var eleS = ksmooth(ele, sg * 1.5, brk);\n  chart('cspeed', xs, speed, { color:'#ff5a1f',\n        fmt:function(v){ return fmtSpeed(v); } });\n  chart('cele', xs, eleS, { color:'#8fa3b5', area:true,\n        fmt:function(v){ return Math.round(MILES ? v*3.28084 : v); } });\n  chart('chr', xs, hrS, { color:'#ff4d6a',\n        fmt:function(v){ return Math.round(v); } });\n}\nfunction chart(id, xs, ys, o){\n  var c = $(id), dpr = window.devicePixelRatio || 1;\n  var W = c.clientWidth || 320, H = 120;\n  c.width = W * dpr; c.height = H * dpr;\n  var g = c.getContext('2d'); g.scale(dpr, dpr);\n  var mn = Infinity, mx = -Infinity, n = xs.length, i;\n  for (i = 0; i < n; i++) if (ys[i] !== null) { if (ys[i] < mn) mn = ys[i]; if (ys[i] > mx) mx = ys[i]; }\n  if (mn === Infinity) { g.fillStyle = '#7d8a96'; g.font = '12px sans-serif';\n    g.fillText('no data', 10, 60); return; }\n  if (mx - mn < 1e-6) { mx += 1; mn -= 1; }\n  var pad = (mx - mn) * 0.12; mn -= pad; mx += pad;\n  var L = 38, R = 6, T = 8, B = 16;\n  var xmax = xs[n-1] || 1;\n  function X(x){ return L + (W-L-R) * x / xmax; }\n  function Y(v){ var f = (v-mn)/(mx-mn); if (o.invert) f = 1-f; return T + (H-T-B)*(1-f); }\n  g.strokeStyle = '#26303a'; g.fillStyle = '#7d8a96'; g.font = '10px sans-serif';\n  g.lineWidth = 1;\n  for (i = 0; i <= 2; i++) {\n    var v = mn + (mx-mn)*i/2, y = Y(v);\n    g.beginPath(); g.moveTo(L, y); g.lineTo(W-R, y); g.stroke();\n    g.fillText(o.fmt(v), 2, y + 3);\n  }\n  for (i = 1; i <= 3; i++) {\n    var xv = xmax*i/3;\n    g.fillText(xv.toFixed(1), X(xv) - 8, H - 4);\n  }\n  g.strokeStyle = o.color; g.lineWidth = 2; g.lineJoin = 'round';\n  g.beginPath();\n  var pen = false;\n  var step = Math.max(1, Math.floor(n / 300));\n  for (i = 0; i < n; i += step) {\n    if (ys[i] === null) { pen = false; continue; }\n    var px = X(xs[i]), py = Y(ys[i]);\n    if (!pen) { g.moveTo(px, py); pen = true; } else g.lineTo(px, py);\n  }\n  g.stroke();\n  if (o.area) {\n    g.lineTo(X(xs[n-1]), Y(mn)); g.lineTo(L, Y(mn)); g.closePath();\n    g.fillStyle = 'rgba(143,163,181,.18)'; g.fill();\n  }\n}\n\n/* ---------- splits ---------- */\nfunction renderSplits(r){\n  if (!r.splits || !r.splits.length) { $('splits').innerHTML = '<p class=\"note\">No splits.</p>'; return; }\n  var SU = splitUnit(r), mult = SU / UD, ride = actOf(r) === 2;\n  var worst = 0, best = 1e9, i, paces = [];\n  for (i = 0; i < r.splits.length; i++) {\n    var s = r.splits[i], p = s.s / (s.d / 1000);\n    paces.push(p);\n    if (p > worst) worst = p;\n    if (s.d > SU*0.99 && p < best) best = p;\n  }\n  var h = '';\n  for (i = 0; i < r.splits.length; i++) {\n    var s2 = r.splits[i], p2 = paces[i];\n    var full = s2.d > SU*0.99;\n    var wpx = Math.max(8, Math.round(140 * (worst ? (worst/p2) : 1)));\n    var label = full ? ((i+1) * mult) : (s2.d/UD).toFixed(1);\n    var val = ride ? fmtSpeed((3600/p2) * (MILES ? 0.6213712 : 1)) : fmtPace(p2);\n    h += '<div class=\"split\"><div class=\"n\">' + label + '</div>' +\n      '<div class=\"bar' + (full && Math.abs(p2-best) < 0.5 ? ' best' : '') + '\" style=\"width:' + wpx + 'px\"></div>' +\n      '<div class=\"t\">' + val + '</div>' +\n      '<div class=\"h\">' + (s2.hr ? '&#9829; ' + s2.hr : '') + '</div></div>';\n  }\n  $('splits').innerHTML = h;\n}\n\n/* ---------- map (OSM slippy tiles) ---------- */\nvar MZ = 15, MC = null, MDRAG = null, MPINCH = null;\nfunction ll2w(lat, lon, z){            // world pixel coords at zoom z\n  var n = 256 * Math.pow(2, z);\n  var la = rad(lat);\n  return { x: (lon + 180) / 360 * n,\n           y: (1 - Math.log(Math.tan(la) + 1/Math.cos(la)) / Math.PI) / 2 * n };\n}\nfunction initMap(r){\n  var mnLa = 90, mxLa = -90, mnLo = 180, mxLo = -180, i;\n  for (i = 0; i < r.pts.length; i++) {\n    var p = r.pts[i];\n    if (p[1] < mnLa) mnLa = p[1]; if (p[1] > mxLa) mxLa = p[1];\n    if (p[2] < mnLo) mnLo = p[2]; if (p[2] > mxLo) mxLo = p[2];\n  }\n  var el = $('map'), W = el.clientWidth || 320, H = el.clientHeight || 250;\n  var z;\n  for (z = 17; z > 3; z--) {\n    var a = ll2w(mxLa, mnLo, z), b = ll2w(mnLa, mxLo, z);\n    if (b.x - a.x < W - 50 && b.y - a.y < H - 50) break;\n  }\n  MZ = z;\n  MC = { lat: (mnLa + mxLa) / 2, lon: (mnLo + mxLo) / 2 };\n  renderMap();\n  if (!el._wired) {\n    el._wired = true;\n    el.addEventListener('touchstart', touchStart, {passive:false});\n    el.addEventListener('touchmove', touchMove, {passive:false});\n    el.addEventListener('touchend', touchEnd);\n    el.addEventListener('mousedown', dragStart);\n    el.addEventListener('mousemove', dragMove);\n    el.addEventListener('mouseup', dragEnd);\n    el.addEventListener('mouseleave', dragEnd);\n    el.addEventListener('dblclick', function(e){ zoomAt(1, pt(e)); });\n    el.addEventListener('wheel', function(e){\n      zoomAt(e.deltaY < 0 ? 1 : -1, pt(e));\n      if (e.cancelable) e.preventDefault();\n    }, {passive:false});\n  }\n}\nfunction zoomBy(d){ zoomAt(d, null); }\n/* Zoom keeping the point under the cursor/pinch fixed: convert it to a\n * geo coord at the old zoom, change zoom, then shift the centre so that\n * same coord lands back under the cursor. */\nfunction zoomAt(d, p){\n  var nz = Math.max(4, Math.min(18, MZ + d));\n  if (nz === MZ) return;\n  var el = $('map'), W = el.clientWidth || 320, H = el.clientHeight || 250;\n  if (p) {\n    var rect = el.getBoundingClientRect();\n    var px = p.x - rect.left - W / 2, py = p.y - rect.top - H / 2;\n    var c = ll2w(MC.lat, MC.lon, MZ);\n    var n0 = 256 * Math.pow(2, MZ);\n    var gx = c.x + px, gy = c.y + py;            // world px of the anchor (old z)\n    var lon = gx / n0 * 360 - 180;\n    var tt = Math.PI * (1 - 2 * gy / n0);\n    var lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(tt) - Math.exp(-tt)));\n    MZ = nz;\n    var n1 = 256 * Math.pow(2, MZ);\n    var aw = ll2w(lat, lon, MZ);                  // anchor in new-zoom world px\n    var cx = aw.x - px, cy = aw.y - py;           // new centre world px\n    MC.lon = cx / n1 * 360 - 180;\n    var t2 = Math.PI * (1 - 2 * cy / n1);\n    MC.lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(t2) - Math.exp(-t2)));\n  } else {\n    MZ = nz;\n  }\n  renderMap();\n}\nfunction dist2(a, b){ var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx*dx + dy*dy); }\nfunction mid2(a, b){ return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }\nfunction touchStart(e){\n  if (e.touches.length >= 2){\n    MDRAG = null;\n    var a = { x: e.touches[0].clientX, y: e.touches[0].clientY };\n    var b = { x: e.touches[1].clientX, y: e.touches[1].clientY };\n    MPINCH = { d0: dist2(a, b), z0: MZ, scale: 1, last: mid2(a, b) };\n    if (e.cancelable) e.preventDefault();\n  } else {\n    MPINCH = null;\n    dragStart(e);\n  }\n}\nfunction touchMove(e){\n  if (MPINCH && e.touches.length >= 2){\n    var a = { x: e.touches[0].clientX, y: e.touches[0].clientY };\n    var b = { x: e.touches[1].clientX, y: e.touches[1].clientY };\n    var rect = $('map').getBoundingClientRect();\n    MPINCH.last = mid2(a, b);\n    MPINCH.scale = dist2(a, b) / (MPINCH.d0 || 1);\n    // live visual feedback; the real re-tile happens on release\n    $('mapinner').style.transformOrigin =\n      (MPINCH.last.x - rect.left) + 'px ' + (MPINCH.last.y - rect.top) + 'px';\n    $('mapinner').style.transform = 'scale(' + MPINCH.scale + ')';\n    if (e.cancelable) e.preventDefault();\n  } else {\n    dragMove(e);\n  }\n}\nfunction touchEnd(e){\n  if (MPINCH){\n    if (!e.touches || e.touches.length === 0){\n      $('mapinner').style.transform = '';\n      $('mapinner').style.transformOrigin = '';\n      var steps = Math.round(Math.log(MPINCH.scale || 1) / Math.LN2);\n      var at = MPINCH.last;\n      MPINCH = null;\n      if (steps !== 0) zoomAt(steps, at);\n    }\n    return;\n  }\n  dragEnd();\n}\nfunction pt(e){ var t = e.touches ? e.touches[0] : e; return { x: t.clientX, y: t.clientY }; }\nfunction dragStart(e){ MDRAG = { s: pt(e), dx: 0, dy: 0 }; }\nfunction dragMove(e){\n  if (!MDRAG) return;\n  var p = pt(e);\n  MDRAG.dx = p.x - MDRAG.s.x; MDRAG.dy = p.y - MDRAG.s.y;\n  $('mapinner').style.transform = 'translate(' + MDRAG.dx + 'px,' + MDRAG.dy + 'px)';\n  if (e.cancelable) e.preventDefault();\n}\nfunction dragEnd(){\n  if (!MDRAG) return;\n  if (MDRAG.dx || MDRAG.dy) {\n    var c = ll2w(MC.lat, MC.lon, MZ);\n    var n = 256 * Math.pow(2, MZ);\n    var nx = c.x - MDRAG.dx, ny = c.y - MDRAG.dy;\n    MC.lon = nx / n * 360 - 180;\n    var t = Math.PI * (1 - 2 * ny / n);\n    MC.lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));\n    renderMap();\n  }\n  MDRAG = null;\n}\nfunction renderMap(){\n  var r = RUNS[CUR]; if (!r) return;\n  var el = $('map'), W = el.clientWidth || 320, H = el.clientHeight || 250;\n  var inner = $('mapinner');\n  inner.style.transform = '';\n  inner.innerHTML = '';\n  var c = ll2w(MC.lat, MC.lon, MZ);\n  var ox = c.x - W/2, oy = c.y - H/2;            // viewport origin in world px\n  var tx0 = Math.floor(ox/256) - 1, ty0 = Math.floor(oy/256) - 1;\n  var tx1 = Math.floor((ox+W)/256) + 1, ty1 = Math.floor((oy+H)/256) + 1;\n  var maxT = Math.pow(2, MZ) - 1;\n  var fx = tx0*256 - ox, fy = ty0*256 - oy;      // field offset in viewport\n  var tTotal = 0, tFail = 0;\n  $('tilenote').style.display = 'none';\n  function tileFailed(){\n    tFail++;\n    if (tFail > tTotal / 2) $('tilenote').style.display = '';\n  }\n  for (var tx = tx0; tx <= tx1; tx++) {\n    for (var ty = Math.max(0, ty0); ty <= Math.min(maxT, ty1); ty++) {\n      var im = document.createElement('img');\n      var wx = ((tx % (maxT+1)) + maxT + 1) % (maxT+1);\n      tTotal++;\n      im.referrerPolicy = 'no-referrer';\n      im.onerror = function(){\n        // CARTO failed -> try OSM once; if that fails too, count it\n        var fb = this.getAttribute('data-fallback');\n        if (fb) {\n          this.removeAttribute('data-fallback');\n          this.src = fb;\n        } else {\n          this.onerror = null;\n          this.style.display = 'none';\n          tileFailed();\n        }\n      };\n      im.setAttribute('data-fallback', 'https://tile.openstreetmap.org/' + MZ + '/' + wx + '/' + ty + '.png');\n      im.src = 'https://basemaps.cartocdn.com/rastertiles/voyager/' + MZ + '/' + wx + '/' + ty + '.png';\n      im.style.left = (fx + (tx-tx0)*256) + 'px';\n      im.style.top  = (fy + (ty-ty0)*256) + 'px';\n      inner.appendChild(im);\n    }\n  }\n  // route overlay\n  var NS = 'http://www.w3.org/2000/svg';\n  var svg = document.createElementNS(NS, 'svg');\n  svg.setAttribute('id', 'mapsvg');\n  svg.setAttribute('width', W); svg.setAttribute('height', H);\n  var d = '', started = false;\n  for (var i = 0; i < r.pts.length; i++) {\n    var w = ll2w(r.pts[i][1], r.pts[i][2], MZ);\n    var px = (w.x - ox).toFixed(1), py = (w.y - oy).toFixed(1);\n    d += (started && !r.pts[i][5] ? 'L' : 'M') + px + ' ' + py;\n    started = true;\n  }\n  var casing = document.createElementNS(NS, 'path');\n  casing.setAttribute('d', d); casing.setAttribute('fill', 'none');\n  casing.setAttribute('stroke', '#0f1419'); casing.setAttribute('stroke-width', '7');\n  casing.setAttribute('stroke-linejoin', 'round'); casing.setAttribute('opacity', '.6');\n  var path = document.createElementNS(NS, 'path');\n  path.setAttribute('d', d); path.setAttribute('fill', 'none');\n  path.setAttribute('stroke', '#ff5a1f'); path.setAttribute('stroke-width', '3.5');\n  path.setAttribute('stroke-linejoin', 'round');\n  svg.appendChild(casing); svg.appendChild(path);\n  function dot(p, col){\n    var w2 = ll2w(p[1], p[2], MZ);\n    var cc = document.createElementNS(NS, 'circle');\n    cc.setAttribute('cx', w2.x - ox); cc.setAttribute('cy', w2.y - oy);\n    cc.setAttribute('r', 5.5); cc.setAttribute('fill', col);\n    cc.setAttribute('stroke', '#fff'); cc.setAttribute('stroke-width', '2');\n    svg.appendChild(cc);\n  }\n  dot(r.pts[0], '#27c466');\n  dot(r.pts[r.pts.length-1], '#ff4d6a');\n  inner.appendChild(svg);\n}\n\n/* ---------- actions ---------- */\nfunction dl(){\n  var r = RUNS[CUR];\n  var fmt = CFG.fmt || 'gpx';\n  var base = r.name.replace(/[^\\w.\\-]+/g, '_');\n  var blob, ext;\n  if (fmt === 'tcx')      { blob = new Blob([rlTcxBuild(r)], { type: 'application/vnd.garmin.tcx+xml' }); ext = '.tcx'; }\n  else if (fmt === 'fit') { blob = new Blob([rlFitBuild(r)], { type: 'application/octet-stream' }); ext = '.fit'; }\n  else                    { blob = new Blob([gpx(r)], { type: 'application/gpx+xml' }); ext = '.gpx'; }\n  var a = document.createElement('a');\n  a.href = URL.createObjectURL(blob);\n  a.download = base + ext;\n  document.body.appendChild(a);\n  a.click();\n  setTimeout(function(){ URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); }, 4000);\n}\nfunction togglePw(){\n  var f = $('cfgpass');\n  var show = f.type !== 'text';\n  f.type = show ? 'text' : 'password';\n  $('pwtoggle').textContent = show ? 'Hide' : 'Show';\n}\n/* The close payload rides in a URL fragment that different phone apps\n * decode differently (some not at all, some once, some with '+' -> space\n * semantics). URL-safe base64 only uses [A-Za-z0-9-_=], which every one\n * of those passes leaves untouched, so credentials survive verbatim. */\nvar B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';\nfunction b64u(str){\n  var s = unescape(encodeURIComponent(str));   // UTF-8 bytes\n  var out = '', i = 0, a, b, c;\n  while (i < s.length) {\n    a = s.charCodeAt(i++) & 255;\n    b = i < s.length ? s.charCodeAt(i++) & 255 : -1;\n    c = i < s.length ? s.charCodeAt(i++) & 255 : -1;\n    out += B64C.charAt(a >> 2);\n    out += B64C.charAt(((a & 3) << 4) | (b < 0 ? 0 : b >> 4));\n    out += b < 0 ? '=' : B64C.charAt(((b & 15) << 2) | (c < 0 ? 0 : c >> 6));\n    out += c < 0 ? '=' : B64C.charAt(c & 63);\n  }\n  return out;\n}\nfunction closePage(act){\n  var payload = act ? 'b64.' + b64u(act) : '';\n  location.href = 'pebblejs://close#' + encodeURIComponent(payload);\n}\nfunction uploadNow(){ closePage(JSON.stringify({ act:'retry', idx: CUR })); }\nfunction retype(to){\n  if (actOf(RUNS[CUR]) === to) return;          // already that type\n  closePage(JSON.stringify({ act:'retype', idx: CUR, to: to }));\n}\nfunction delRun(){\n  if (confirm('Delete this run?')) closePage(JSON.stringify({ act:'del', idx: CUR }));\n}\nfunction clearAll(){\n  if (confirm('Delete all saved runs?')) closePage(JSON.stringify({ act:'clear' }));\n}\nfunction renderLog(){\n  if (!LOGL || !LOGL.length) {\n    $('loglines').innerHTML = '<p class=\"note\">Nothing logged yet.</p>';\n    return;\n  }\n  function p2(x){ return (x < 10 ? '0' : '') + x; }\n  var h = '';\n  for (var i = LOGL.length - 1; i >= 0; i--) {\n    var d = new Date(LOGL[i][0] * 1000);\n    var msg = String(LOGL[i][1]).replace(/&/g,'&amp;').replace(/</g,'&lt;');\n    var bad = /FAILED|unusable|rejected/.test(msg);\n    h += '<div class=\"logline\"><span class=\"lt\">' +\n         p2(d.getMonth()+1) + '-' + p2(d.getDate()) + ' ' +\n         p2(d.getHours()) + ':' + p2(d.getMinutes()) + '</span>' +\n         '<span class=\"lm' + (bad ? ' lbad' : '') + '\">' + msg + '</span></div>';\n  }\n  $('loglines').innerHTML = h;\n}\nfunction cfgUi(){\n  var p = $('cfgpreset').value;\n  var hosted = (p === 'intervals' || p === 'runalyze');\n  var ft = (p === 'fittrackee');\n  $('cfgurlrow').style.display = hosted ? 'none' : '';\n  $('cfgauthrow').style.display = (hosted || ft) ? 'none' : '';\n  $('cfgkeyrow').style.display = hosted ? '' : 'none';\n  $('cfguserrow').style.display = ft ? '' : 'none';\n  $('cfgpassrow').style.display = ft ? '' : 'none';\n  $('cfgurl').placeholder =\n    (p === 'webdav') ? 'https://cloud.example.com/remote.php/dav/files/you/Runs/' :\n    ft               ? 'https://fittrackee.your-server.lan' :\n                       'https://example.com/runs/upload';\n  if (p === 'intervals') {\n    $('cfgkeylab').textContent = 'intervals.icu API key';\n    $('cfgkeyhint').textContent = 'intervals.icu \\u2192 Settings \\u2192 Developer Settings \\u2192 API key. Runs upload to your account via the official API.';\n  } else if (p === 'runalyze') {\n    $('cfgkeylab').textContent = 'Runalyze personal token';\n    $('cfgkeyhint').textContent = 'runalyze.com \\u2192 Account \\u2192 Personal API \\u2192 create token (activity_push).';\n  }\n}\nfunction saveCfg(){\n  closePage(JSON.stringify({ act:'cfg', cfg:{\n    auto: 0,\n    name: $('cfgname').value.replace(/^\\s+|\\s+$/g, ''),\n    fmt: $('cfgfmt').value,\n    preset: $('cfgpreset').value,\n    url: $('cfgurl').value.replace(/^\\s+|\\s+$/g, ''),\n    auth: $('cfgauth').value.replace(/^\\s+|\\s+$/g, ''),\n    key: $('cfgkey').value.replace(/^\\s+|\\s+$/g, ''),\n    user: $('cfguser').value.replace(/^\\s+|\\s+$/g, ''),\n    pass: $('cfgpass').value\n  }}));\n}\n\n/* ---------- boot ---------- */\n$('cfgname').value = CFG.name || '';\n$('cfgfmt').value = CFG.fmt || 'gpx';\nif ($('dlbtn')) $('dlbtn').textContent = 'Download .' + (CFG.fmt || 'gpx');\n$('cfgpreset').value = CFG.preset || 'custom';\n$('cfgurl').value = CFG.url || '';\n$('cfgauth').value = CFG.auth || '';\n$('cfgkey').value = CFG.key || '';\n$('cfguser').value = CFG.user || '';\n$('cfgpass').value = CFG.pass || '';\ncfgUi();\nrenderLog();\nrenderList();\nif (INITIAL) {\n  var initIdx = -1;\n  for (var ri = 0; ri < RUNS.length; ri++) {\n    if (RUNS[ri].start === INITIAL) { initIdx = ri; break; }\n  }\n  if (initIdx < 0 && RUNS.length) initIdx = RUNS.length - 1;\n  if (initIdx >= 0) showDetail(initIdx);\n}\n</script>\n</body>\n</html>\n";


/***/ })
/******/ ]);
//# sourceMappingURL=pebble-js-app.js.map