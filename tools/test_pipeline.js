/*
 * RunLog pipeline test — drives src/pkjs/index.js with stubbed
 * Pebble / geolocation / localStorage / XHR / clock and checks every
 * wire message and stored record.
 *
 * Run from anywhere:  node tools/test_pipeline.js
 */
'use strict';
var path = require('path');
var assert = require('assert');

var APP = path.join(__dirname, '..', 'src', 'pkjs', 'index.js');

function openedHtml(url) {
  var b64p = 'data:text/html;charset=utf-8;base64,';
  var plain = 'data:text/html;charset=utf-8,';
  if (url.indexOf(b64p) === 0)
    return Buffer.from(url.slice(b64p.length), 'base64').toString('utf8');
  return decodeURIComponent(url.replace(plain, ''));
}

/* ---------------- stubs ---------------- */
function makeWorld() {
  var W = {
    msgs: [],          // everything sent to the watch
    listeners: {},
    geoCb: null,
    opened: [],        // openURL captures
    store: {},
    xhrs: [],
    glances: [],       // Pebble.appGlanceReload payloads
    geoStarts: 0,
    geoStops: 0,
    geoOptions: [],
    storeWrites: {},
    intervalCalls: 0,
    clockMs: 0
  };

  var Pebble = {
    addEventListener: function (n, f) {
      (W.listeners[n] = W.listeners[n] || []).push(f);
    },
    sendAppMessage: function (d, ok) {
      W.msgs.push(JSON.parse(JSON.stringify(d)));
      if (ok) ok();
    },
    openURL: function (u) { W.opened.push(u); },
    appGlanceReload: function (slices, ok) { W.glances.push(slices); if (ok) ok(slices, {}); }
  };

  var navigatorStub = {
    geolocation: {
      watchPosition: function (cb, err, options) {
        W.geoCb = cb; W.geoStarts++;
        W.geoOptions.push(JSON.parse(JSON.stringify(options || {})));
        return W.geoStarts;
      },
      clearWatch: function () { W.geoStops++; }
    }
  };

  var localStorageStub = {
    getItem: function (k) { return (k in W.store) ? W.store[k] : null; },
    setItem: function (k, v) {
      if (W.failStore && W.failStore(k, String(v))) throw new Error('simulated storage failure');
      W.store[k] = String(v);
      W.storeWrites[k] = (W.storeWrites[k] || 0) + 1;
    },
    removeItem: function (k) { delete W.store[k]; },
    key: function (i) { return Object.keys(W.store)[i] || null; }
  };
  Object.defineProperty(localStorageStub, 'length', {
    get: function () { return Object.keys(W.store).length; }
  });

  function XHR() { this.headers = {}; W.xhrs.push(this); }
  XHR.prototype.open = function (m, u) { this.method = m; this.url = u; };
  XHR.prototype.setRequestHeader = function (k, v) { this.headers[k] = v; };
  XHR.prototype.send = function (b) { this.body = b; };
  XHR.prototype.respond = function (status, text) {
    this.status = status;
    this.responseText = text || '';
    if (status > 0) { if (this.onload) this.onload(); }
    else { if (this.onerror) this.onerror(); }
  };
  XHR.prototype.abort = function () { if (this.onabort) this.onabort(); };

  W.fire = function (name, e) {
    (W.listeners[name] || []).forEach(function (f) { f(e); });
  };
  W.install = function () {
    global.Pebble = Pebble;
    Object.defineProperty(globalThis, 'navigator',
      { value: navigatorStub, configurable: true, writable: true });
    global.localStorage = localStorageStub;
    global.XMLHttpRequest = XHR;
    global.setInterval = function () { W.intervalCalls++; return 0; };
    global.clearInterval = function () {};
    W.timers = [];
    global.setTimeout = function (fn, delay) {
      var id = W.timers.length + 1;
      W.timers.push({ id: id, fn: fn, delay: delay || 0 });
      return id;
    };
    global.clearTimeout = function (id) {
      W.timers = W.timers.filter(function (t) { return t.id !== id; });
    };
    W.flushTimers = function () {
      var t = W.timers;
      W.timers = [];
      t.forEach(function (x) { x.fn(); });
    };
    Date.now = function () { return W.clockMs; };     // app time = sim time
  };
  W.boot = function () {
    W.install();
    var dir = path.dirname(APP);
    [APP, path.join(dir, 'gpx.js'), path.join(dir, 'page.js')].forEach(function (m) {
      try { delete require.cache[require.resolve(m)]; } catch (e) {}
    });
    require(APP);
  };
  return W;
}

/* GPS feed: walks east at v m/s, one fix per dt seconds.
 * Also advances the mocked wall clock so HR/step freshness works.
 * tsMode: 'ms' (sane epoch milliseconds, default), 'none' (timestamp
 * missing) or 's' (epoch seconds — both broken variants seen in the
 * wild).  jitterM adds deterministic position noise to reported coords. */
function makeWalker(W, t0, lat, lon, tsMode) {
  var t = t0, la = lat, lo = lon, seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  W.clockMs = t0 * 1000;
  return {
    step: function (v, dt, ele, acc, jitterM) {
      t += dt;
      W.clockMs = t * 1000;
      lo += (v * dt) / (111320 * Math.cos(la * Math.PI / 180));
      var j = jitterM || 0;
      var rla = la + (j ? (rnd() - 0.5) * 2 * j / 111320 : 0);
      var rlo = lo + (j ? (rnd() - 0.5) * 2 * j / (111320 * Math.cos(la * Math.PI / 180)) : 0);
      var ts = (tsMode === 'none') ? undefined : (tsMode === 's') ? t : t * 1000;
      W.geoCb({
        timestamp: ts,
        coords: { latitude: rla, longitude: rlo, accuracy: acc || 8,
                  altitude: (ele === undefined ? null : ele) }
      });
    }
  };
}

function msgsWith(W, key) {
  return W.msgs.filter(function (m) { return m[key] !== undefined; });
}
function lastWith(W, key) {
  var a = msgsWith(W, key);
  return a.length ? a[a.length - 1] : null;
}
function le16(arr, i) { return arr[i] | (arr[i + 1] << 8); }
function b64dec(s) { return Buffer.from(s, 'base64').toString('utf8'); }
function unpackPagePoints(r) {
  var bytes = Buffer.from(r.ptb.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  var bi = 0;
  function vu() {
    var n = 0, mul = 1, b;
    do {
      assert(bi < bytes.length, 'packed route varint is complete');
      b = bytes[bi++];
      n += (b & 127) * mul;
      mul *= 128;
    } while (b & 128);
    return n;
  }
  function vi() { var n = vu(); return n % 2 ? -(n + 1) / 2 : n / 2; }
  function vic(n) { return n % 2 ? -(n + 1) / 2 : n / 2; }
  function elev(n) { return n === 0 ? '' : vic(n - 1) / 10; }
  var out = [], t = 0, la = 0, lo = 0, el = 0, hr = 0, cad = 0;
  for (var i = 0; i < r.ptn; i++) {
    var seg;
    if (i === 0) {
      t = vu(); la = vi(); lo = vi(); el = vu(); hr = vu(); seg = vu(); cad = vu();
    } else {
      t += vi(); la += vi(); lo += vi(); el += vi(); hr += vi(); seg = vu(); cad += vi();
    }
    out.push([t, la / 1e6, lo / 1e6, elev(el), hr, seg, cad]);
  }
  assert.strictEqual(bi, bytes.length, 'packed route has no trailing bytes');
  return out;
}
function storedRuns(W) {
  var index = JSON.parse(W.store['runlog.runs'] || '[]');
  return index.map(function (meta) {
    if (meta.pts || !meta._j) return meta;       // legacy fixture / metadata-only defensive case
    var run = {};
    Object.keys(meta).forEach(function (k) { if (k !== '_j') run[k] = meta[k]; });
    run.pts = [];
    for (var i = 0; i < meta._j.chunks; i++) {
      var e = JSON.parse(W.store['runlog.j.' + meta._j.id + '.' + i]);
      var t = 0, la = 0, lo = 0;
      e.d.forEach(function (d, n) {
        if (n === 0) { t = d[0]; la = d[1]; lo = d[2]; }
        else { t += d[0]; la += d[1]; lo += d[2]; }
        run.pts.push([t, la / 1e6, lo / 1e6, d[3] === null ? '' : d[3] / 10,
                      d[4] || 0, d[5] || 0, d[6] || 0]);
      });
    }
    return run;
  });
}

/* =======================================================================
 * Unit: the shared chart smoother (gap- and pause-aware Gaussian kernel)
 * ===================================================================== */
(function smootherUnit() {
  var ksmooth = require(path.join(__dirname, '..', 'src', 'pkjs', 'smooth.js'));

  // flat data must come back exactly flat (weighted mean of equals)
  ksmooth([5, 5, 5, 5, 5, 5], 1.5).forEach(function (v) {
    assert(Math.abs(v - 5) < 1e-9, 'flat stays flat');
  });

  // alternating noise gets visibly calmer
  var raw = [], i;
  for (i = 0; i < 30; i++) raw.push(i % 2 ? 10 : 0);
  var sm = ksmooth(raw, 1.5);
  var rawJump = 0, smJump = 0;
  for (i = 1; i < 30; i++) {
    rawJump += Math.abs(raw[i] - raw[i - 1]);
    smJump += Math.abs(sm[i] - sm[i - 1]);
  }
  assert(smJump < rawJump * 0.35, 'noise damped (' + smJump.toFixed(1) +
         ' vs raw ' + rawJump.toFixed(1) + ')');
  assert.strictEqual(sm.length, raw.length, 'length preserved');

  // missing samples stay missing and are skipped, not averaged in
  var g = ksmooth([4, null, 8], 2);
  assert.strictEqual(g[1], null, 'null preserved');
  assert(g[0] > 4 && g[2] < 8, 'neighbours pull toward each other across the hole');

  // a pause is a hard wall: nothing leaks across brk
  var b = ksmooth([0, 0, 0, 100, 100, 100], 2, [false, false, false, true, false, false]);
  assert(Math.abs(b[2] - 0) < 1e-9, 'left of pause untouched by right side');
  assert(Math.abs(b[3] - 100) < 1e-9, 'right of pause untouched by left side');

  console.log('smoother unit tests OK');
})();

/* =======================================================================
 * Scenario 1: full km run — settings, fixes, HR/steps, accuracy wobble,
 * auto-pause, split, save, track + graphs, uploads, page actions
 * ===================================================================== */
(function scenario1() {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});

  assert(lastWith(W, 'GPSOK'), 'GPSOK sent on ready');
  assert.strictEqual(lastWith(W, 'GPSOK').GPSOK, 0, 'no fix yet');

  W.fire('appmessage', { payload: { UNITS: 0, AUTOP: 1, SPLITP: 1 } });
  assert.deepStrictEqual(JSON.parse(W.store['runlog.set']),
    { mi: false, ap: true, splits: true, mode: 0, maxHr: 190, restHr: 0,
      zone: true, pending: false }, 'watch settings persisted');

  W.clockMs = 1750000000000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  assert.strictEqual(W.geoOptions[W.geoOptions.length - 1].frequency, 1000,
                     'Run requests the current Core bridge at one-second intervals');
  assert.strictEqual(W.geoOptions[W.geoOptions.length - 1].enableHighAccuracy, true,
                     'Run requests high-accuracy phone location');
  assert.strictEqual(W.geoOptions[W.geoOptions.length - 1].maximumAge, undefined,
                     'continuous watch does not pretend maximumAge is forwarded');
  assert(W.store['runlog.inprogress'], 'in-progress snapshot created');

  var w = makeWalker(W, 1750000000, -31.9500, 115.8500);
  var steps = 0;

  // 80 fixes * 5 s at 3.333 m/s -> ~1316 m in 400 s (5:00 /km; 1st fix anchors)
  for (var i = 0; i < 80; i++) {
    var ele = i < 30 ? 20 + i * 0.5 : 35;          // +15 m climb early on
    var acc = (i >= 40 && i < 43) ? 15 : 8;        // brief accuracy wobble
    w.step(10 / 3, 5, ele, acc);
    steps += 14;                                    // 168 spm
    W.fire('appmessage', { payload: { HR: 150, STEPS: steps } });
  }

  var split = msgsWith(W, 'SPLIT');
  assert.strictEqual(split.length, 1, 'exactly one split alert');
  assert.strictEqual(split[0].SPLIT, 1, 'split #1');
  assert(split[0].DIST !== undefined, 'split shares the fix telemetry packet');

  var per = lastWith(W, 'PACE');
  assert(Math.abs(per.PACE - 300) <= 6, 'live pace ~5:00/km, got ' + per.PACE);
  assert.strictEqual(per.AVGP, undefined, 'unused average pace omitted from live packets');
  assert.strictEqual(per.EGAIN, undefined, 'unused elevation gain omitted from live packets');
  var distBefore = lastWith(W, 'DIST').DIST;
  assert(Math.abs(distBefore - 1316) < 15, 'distance ~1316 m, got ' + distBefore);

  var accVals = msgsWith(W, 'ACC').map(function (m) { return m.ACC; });
  assert(accVals.length >= 3, 'accuracy changes reported (' + accVals.length + ')');
  assert(accVals.length <= 8, 'accuracy throttled (' + accVals.length + ' sends)');
  assert(accVals.indexOf(15) >= 0, 'wobble value seen');
  assert.strictEqual(accVals[accVals.length - 1], 8, 'settled back to 8');
  assert(msgsWith(W, 'ACC').some(function (m) { return m.DIST !== undefined; }),
         'accuracy and live stats from one fix share a packet');

  // ---- auto-pause: 4 slow fixes pause, 2 fast resume ----
  w.step(0.2, 5, 35); w.step(0.2, 5, 35);
  assert(!lastWith(W, 'APAUSE'), 'not paused after 2 slow fixes');
  w.step(0.2, 5, 35);
  assert(!lastWith(W, 'APAUSE'), 'not paused after 3 slow fixes');
  w.step(0.2, 5, 35);
  var ap = lastWith(W, 'APAUSE');
  assert(ap && ap.APAUSE === 1, 'auto-paused after 4 slow fixes');

  w.step(0.1, 5, 35); w.step(0.1, 5, 35);          // still parked
  w.step(2.0, 5, 35);
  assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 1, 'one fast fix not enough');
  w.step(2.0, 5, 35);
  assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 0, 'resumed after 2 fast fixes');

  // a little more running after the resume, slightly harder effort
  for (var j = 0; j < 12; j++) {
    w.step(10 / 3, 5, 35);
    steps += 14;
    W.fire('appmessage', { payload: { HR: 160, STEPS: steps } });
  }
  var distAfter = lastWith(W, 'DIST').DIST;
  assert(distAfter - distBefore < 280, 'pause did not accumulate distance');
  assert(distAfter - distBefore > 150, 'post-resume distance counted');

  // ---- stop & save ----
  W.fire('appmessage', { payload: { CMD: 4 } });

  var saved = lastWith(W, 'SAVED');
  assert(saved, 'SAVED bundle sent');
  // Active time includes the deliberately conservative fourth slow observation
  // before auto-pause; at this fixture's five-second GPS cadence that is ~5 s/km.
  assert(Math.abs(saved.AVGP - 310) <= 8, 'SAVED debounce-aware avg pace, got ' + saved.AVGP);
  assert(saved.AVGHR >= 150 && saved.AVGHR <= 160, 'SAVED avg HR ' + saved.AVGHR);
  assert.strictEqual(saved.MAXHR, 160, 'SAVED max HR');
  assert(saved.MOVS >= 430 && saved.MOVS <= 480, 'moving secs ' + saved.MOVS);
  assert(saved.DIST > 1450 && saved.DIST < 1620, 'SAVED dist ' + saved.DIST);
  assert(saved.EGAIN >= 8, 'SAVED egain');

  var tspan = lastWith(W, 'TSPAN');
  assert(tspan && tspan.TSPAN > 0, 'route span sent for the scale label');
  assert(tspan.TSPAN > 200 && tspan.TSPAN < 2000, 'span sane for a ~1.3 km loop: ' + tspan.TSPAN);

  var trk = lastWith(W, 'TRACK');
  assert(trk, 'TRACK sent');
  assert(trk.TRACK.length % 2 === 0 && trk.TRACK.length <= 128, 'track size');
  assert(trk.TRACK.length >= 8, 'track has points');
  trk.TRACK.forEach(function (b) { assert(b >= 0 && b <= 200, 'track byte in range'); });
  var xs = trk.TRACK.filter(function (_, k) { return k % 2 === 0; });
  assert(Math.max.apply(null, xs) - Math.min.apply(null, xs) > 150,
         'east-west run spans the x axis');

  // ---- watch debrief graphs ----
  var pg = lastWith(W, 'PACEG'), hg = lastWith(W, 'HRG');
  assert(pg && hg, 'graph messages sent');
  assert.strictEqual(pg.PACEG.length, 4 + 48, 'pace graph length');
  assert.strictEqual(hg.HRG.length, 4 + 48, 'hr graph length');
  var pmin = le16(pg.PACEG, 0), pmax = le16(pg.PACEG, 2);
  assert(pmin >= 280 && pmin <= 330, 'pace graph min ' + pmin);
  assert(pmax >= pmin, 'pace graph max >= min');
  assert.strictEqual(le16(hg.HRG, 0), 150, 'hr graph min');
  assert.strictEqual(le16(hg.HRG, 2), 160, 'hr graph max');
  pg.PACEG.slice(4).concat(hg.HRG.slice(4)).forEach(function (v) {
    assert((v >= 0 && v <= 100) || v === 255, 'graph sample in range: ' + v);
  });

  assert(!W.store['runlog.inprogress'], 'in-progress cleared');

  var runs = storedRuns(W);
  assert.strictEqual(runs.length, 1, 'one stored run');
  var r = runs[0];
  ['name', 'start', 'dist', 'dur', 'mov', 'avgp', 'avgHr', 'maxHr',
   'egain', 'cad', 'steps', 'mi', 'splits', 'up', 'pts'].forEach(function (k) {
    assert(k in r, 'run field ' + k);
  });
  assert(/^\d{4}-\d{2}-\d{2}_\d{4}_run$/.test(r.name), 'templated run name (now time-bearing): ' + r.name);
  assert.strictEqual(r.up, 0, 'not uploaded yet');
  assert(r.cad >= 160 && r.cad <= 176, 'cadence ~168, got ' + r.cad);
  assert(r.pts[0].length === 7, 'points carry cadence column');
  assert(r.pts.some(function (p) { return p[6] > 150; }), 'per-point cadence recorded');
  assert(r.pts.some(function (p) { return p[5] === 1; }), 'segment break after auto-pause');
  assert(r.analysis && r.analysis.zones && r.analysis.zones.total > 300,
         'post-workout HR-zone time computed after save');
  assert.strictEqual(r.analysis.pauses, 1, 'auto-pause captured in the event journal');
  assert(r.events.some(function (e) { return e[1] === 'start'; }) &&
         r.events.some(function (e) { return e[1] === 'auto_pause'; }) &&
         r.events.some(function (e) { return e[1] === 'auto_resume'; }) &&
         r.events.some(function (e) { return e[1] === 'stop'; }),
         'lifecycle event journal is complete');

  var storedIndex = JSON.parse(W.store['runlog.runs']);
  assert(storedIndex[0]._j && !storedIndex[0].pts,
         'committed index is lightweight and points live in route chunks');
  var journalKeys = Object.keys(W.store).filter(function (k) {
    return k.indexOf('runlog.j.' + storedIndex[0]._j.id + '.') === 0;
  });
  assert(journalKeys.length === storedIndex[0]._j.chunks && journalKeys.length >= 1,
         'all committed route chunks exist');
  var writesBeforeUpload = journalKeys.map(function (k) { return W.storeWrites[k]; });

  assert.strictEqual(r.splits.length, 2, 'one full + one partial split');
  assert.strictEqual(r.splits[0].d, 1000, 'split 1 distance');
  assert(Math.abs(r.splits[0].s - 300) <= 8, 'split 1 time ~300 s, got ' + r.splits[0].s);
  assert.strictEqual(r.splits[0].hr, 150, 'split 1 HR');
  assert(r.splits[1].d > 300, 'partial split distance');

  /* ---- uploads are user-driven: cfg save never auto-uploads ---- */
  assert.strictEqual(W.xhrs.length, 0, 'no upload without config');
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg',
    cfg: { auto: true, preset: 'custom', url: 'https://example.test/runs',
           auth: 'Bearer tok123', key: '' }
  })) });

  assert.strictEqual(W.xhrs.length, 0, 'cfg save no longer auto-uploads');
  W.fire('appmessage', { payload: { CMD: 7 } });   // Upload on the debrief
  assert.strictEqual(W.xhrs.length, 1, 'manual upload fired');
  var x = W.xhrs[0];
  assert.strictEqual(x.method, 'POST');
  assert.strictEqual(x.url, 'https://example.test/runs');
  assert.strictEqual(x.headers['Content-Type'], 'application/gpx+xml');
  assert.strictEqual(x.headers.Authorization, 'Bearer tok123',
                     'full header value passes through untouched');
  assert(/\.gpx$/.test(x.headers['X-Filename']), 'filename header');
  assert(x.body.indexOf('<gpx ') >= 0, 'GPX body');
  assert(x.body.indexOf('<gpxtpx:hr>') >= 0, 'GPX heart rate');
  assert(x.body.indexOf('<gpxtpx:cad>') >= 0, 'GPX cadence');
  assert.strictEqual((x.body.match(/<trkseg>/g) || []).length, 2,
                     'pause split into 2 segments');

  var exp = msgsWith(W, 'EXPST').map(function (m) { return m.EXPST; });
  assert.deepStrictEqual(exp, [0], 'EXPST uploading');
  x.respond(201);
  exp = msgsWith(W, 'EXPST').map(function (m) { return m.EXPST; });
  assert.deepStrictEqual(exp, [0, 1], 'EXPST uploaded');
  assert.strictEqual(storedRuns(W)[0].up, 1, 'run marked uploaded');
  journalKeys.forEach(function (k, i) {
    assert.strictEqual(W.storeWrites[k], writesBeforeUpload[i],
      'metadata-only upload state does not rewrite route chunk ' + i);
  });

  /* ---- manual re-upload (retry button), server fails ---- */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  assert.strictEqual(W.xhrs.length, 2, 'retry fired');
  W.xhrs[1].respond(500);
  exp = msgsWith(W, 'EXPST').map(function (m) { return m.EXPST; });
  assert.deepStrictEqual(exp, [0, 1, 0, 2], 'EXPST failure path');
  assert.strictEqual(lastWith(W, 'EXPERR').EXPERR, 500, 'failure reason sent to the watch');
  assert.strictEqual(storedRuns(W)[0].up, 2, 'run marked failed');

  var lg = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg.some(function (m) { return /GPS ok, accuracy 8 m/.test(m); }), 'gps logged');
  assert(lg.some(function (m) { return /^saved "\d{4}-\d{2}-\d{2}_\d{4}_run/.test(m); }), 'save logged');
  assert(lg.some(function (m) { return /upload -> custom example\.test/.test(m); }), 'attempt logged');
  assert(lg.some(function (m) { return /upload FAILED \(HTTP 500\)/.test(m); }), 'failure logged');

  /* ---- debrief page injection ---- */
  W.fire('showConfiguration', {});
  assert.strictEqual(W.opened.length, 2, 'page opened (once after save, once via gear)');
  var html = openedHtml(W.opened[1]);
  assert(html.indexOf('__RUNLOG_') < 0, 'all placeholders replaced');
  assert(html.indexOf('var RUNS = [{') >= 0, 'runs injected');
  assert(/"name":"\d{4}-\d{2}-\d{2}_\d{4}_run/.test(html), "run name in page");
  assert(html.indexOf('var MILES = false') >= 0, 'units injected');
  assert(html.indexOf('var INITIAL = 0') >= 0, 'gear opens on the list view');
  assert(html.indexOf('Bearer tok123') < 0, 'saved authorization is never injected into page source');
  assert(html.indexOf('"hasAuth":true') >= 0, 'page receives only the saved-secret presence flag');
  assert(html.indexOf('"pts":[') < 0 && html.indexOf('"ptb":"') >= 0,
         'one settings page carries retained routes in compact form');
  assert(html.indexOf('var LOGL = [[') >= 0, 'log injected into the page');

  // the auto-open after the save deep-links to that run
  var html0 = openedHtml(W.opened[0]);
  assert(html0.indexOf('var INITIAL = ' + storedRuns(W)[0].sid) >= 0,
         'post-save page deep-links to the new run');

  /* ---- delete ---- */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'del', idx: 0 })) });
  assert.strictEqual(storedRuns(W).length, 0, 'run deleted');

  console.log('scenario 1 (km run, autopause, graphs, upload, page) OK');
})();

/* =======================================================================
 * Scenario 2: miles mode + every export preset
 * ===================================================================== */
(function scenario2() {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 1, AUTOP: 0, SPLITP: 1 } });
  W.fire('appmessage', { payload: { CMD: 1 } });

  var w = makeWalker(W, 1750100000, -31.9500, 115.8500);
  for (var i = 0; i < 102; i++) w.step(10 / 3, 5, null);   // ~1683 m

  var splits = msgsWith(W, 'SPLIT');
  assert.strictEqual(splits.length, 1, 'one mile split');
  var dAtSplit = null;
  for (var k = 0; k < W.msgs.length; k++) {
    if (W.msgs[k].SPLIT !== undefined) break;
    if (W.msgs[k].DIST !== undefined) dAtSplit = W.msgs[k].DIST;
  }
  assert(dAtSplit > 1550, 'mile split not at 1 km (DIST before split ' + dAtSplit + ')');

  W.fire('appmessage', { payload: { CMD: 4 } });
  var r = storedRuns(W)[0];
  assert.strictEqual(r.mi, 1, 'run stored in miles mode');
  assert.strictEqual(r.splits[0].d, 1609, 'split distance 1609 m');
  assert(Math.abs(r.splits[0].s - 483) <= 8, 'mile split ~8:03, got ' + r.splits[0].s);
  assert(Math.abs(r.avgp - 300) <= 8 && lastWith(W, 'SAVED').AVGP === r.avgp,
         'avgp stays s/km even in miles mode');

  /* ---- WebDAV preset: PUT, filename appended, user:pass -> Basic ---- */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: { auto: true, preset: 'webdav',
                       url: 'https://dav.test/gpx', auth: 'kai:hunter2', key: '' }
  })) });
  assert.strictEqual(W.xhrs.length, 0, 'webdav cfg does not auto-upload');
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  assert.strictEqual(W.xhrs.length, 1, 'manual upload to webdav');
  var d = W.xhrs[0];
  assert.strictEqual(d.method, 'PUT');
  assert(/^https:\/\/dav\.test\/gpx\/\d{4}-\d{2}-\d{2}_\d{4}_run.*\.gpx$/.test(d.url), 'filename appended: ' + d.url);
  assert(!('X-Filename' in d.headers), 'no X-Filename on PUT');
  assert.strictEqual(b64dec(d.headers.Authorization.replace('Basic ', '')), 'kai:hunter2',
                     'user:pass auto-wrapped as Basic');
  d.respond(201);
  assert.strictEqual(storedRuns(W)[0].up, 1);

  /* ---- intervals.icu preset ---- */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: { auto: true, preset: 'intervals', url: '', auth: '', key: 'sekret123' }
  })) });
  assert.strictEqual(W.xhrs.length, 1, 'no auto-refire for an already-uploaded run');
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  assert.strictEqual(W.xhrs.length, 2, 'manual retry to intervals');
  var iv = W.xhrs[1];
  assert.strictEqual(iv.method, 'POST');
  assert(iv.url.indexOf('https://intervals.icu/api/v1/athlete/0/activities?name=') === 0,
         'intervals endpoint: ' + iv.url);
  assert.strictEqual(b64dec(iv.headers.Authorization.replace('Basic ', '')),
                     'API_KEY:sekret123', 'intervals basic auth');
  assert(iv.headers['Content-Type'].indexOf('multipart/form-data; boundary=') === 0,
         'multipart content type');
  assert(iv.body.indexOf('name="file"; filename="') >= 0 && /filename="\d{4}-\d{2}-\d{2}_\d{4}_run/.test(iv.body), 'multipart file field');
  assert(iv.body.indexOf('<gpx ') >= 0, 'gpx inside multipart');
  iv.respond(200);
  assert.strictEqual(storedRuns(W)[0].up, 1);

  /* ---- Runalyze preset ---- */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: { auto: true, preset: 'runalyze', url: '', auth: '', key: 'rtoken99' }
  })) });
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  var rz = W.xhrs[2];
  assert.strictEqual(rz.method, 'POST');
  assert.strictEqual(rz.url, 'https://runalyze.com/api/v1/activities/uploads');
  assert.strictEqual(rz.headers.token, 'rtoken99', 'runalyze token header');
  assert(rz.headers['Content-Type'].indexOf('multipart/form-data') === 0, 'runalyze multipart');
  rz.respond(200);

  /* ---- legacy v1-style config migrates to webdav behaviour ---- */
  W.store['runlog.cfg'] = JSON.stringify({ auto: 1, method: 'PUT', url: 'https://old.test/dav' });
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  var lg = W.xhrs[3];
  assert.strictEqual(lg.method, 'PUT', 'legacy PUT config still PUTs');
  assert(/^https:\/\/old\.test\/dav\/\d{4}-\d{2}-\d{2}_\d{4}_run.*\.gpx$/.test(lg.url), 'legacy URL + filename');
  lg.respond(201);

  console.log('scenario 2 (miles, webdav/intervals/runalyze/legacy presets) OK');
})();

/* =======================================================================
 * Scenario 3: crash recovery + manual upload of recovered run + clear
 * ===================================================================== */
(function scenario3() {
  var W = makeWorld();
  W.clockMs = 1750200600000;

  var pts = [];
  for (var i = 0; i < 30; i++) {
    pts.push([1750200000 + i * 5, -31.95, 115.85 + i * 0.0002, '', 145, 0, 165]);
  }
  W.store['runlog.inprogress'] = JSON.stringify({
    startAt: 1750200000000, dist: 600, movS: 150, egain: 4, steps: 420, mi: 0, pts: pts
  });
  W.store['runlog.cfg'] = JSON.stringify(
    { auto: 1, preset: 'custom', url: 'https://example.test/runs', auth: '', key: '' });

  W.boot();
  W.fire('ready', {});

  assert(!W.store['runlog.runs'], 'stale checkpoint is retained until the watch reconciles');
  assert(W.store['runlog.inprogress'], 'stale checkpoint is not silently discarded');
  W.fire('appmessage', { payload: { PROTO: 2, HELLO: 1, SID: 0, SEQ: 0, WSTATE: 0 } });

  var runs = storedRuns(W);
  assert.strictEqual(runs.length, 1, 'recovered run stored');
  assert(/\(recovered\)$/.test(runs[0].name), 'recovered suffix');
  assert(runs[0].splits.length >= 1, 'recovered run has splits');
  assert(!W.store['runlog.inprogress'], 'snapshot cleared');

  assert.strictEqual(W.xhrs.length, 0, 'no auto-upload on ready (user-driven)');
  // the user uploads the recovered run from the phone page
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  assert.strictEqual(W.xhrs.length, 1, 'manual upload of the recovered run');
  W.xhrs[0].respond(200);
  assert.strictEqual(storedRuns(W)[0].up, 1, 'marked uploaded');

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'clear' })) });
  assert.strictEqual(storedRuns(W).length, 0, 'clear all');

  console.log('scenario 3 (recovery, manual upload, clear) OK');
})();

/* =======================================================================
 * Scenario 4: walk + ride modes — per-mode auto-pause thresholds,
 * 5-km ride splits, GPX activity types, FitTrackee preset
 * ===================================================================== */
(function scenario4() {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 0, AUTOP: 1, SPLITP: 1, MODE: 1 } });
  assert.strictEqual(JSON.parse(W.store['runlog.set']).mode, 1, 'walk mode stored');

  /* ---- walk: 0.6 m/s must NOT auto-pause (walk slow threshold 0.45) ---- */
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, 1750300000, -31.9500, 115.8500);
  for (var i = 0; i < 30; i++) w.step(1.5, 5, null);
  w.step(0.6, 5, null); w.step(0.6, 5, null); w.step(0.6, 5, null);
  assert(!lastWith(W, 'APAUSE'), 'gentle walking does not auto-pause');
  for (var j = 0; j < 6; j++) w.step(1.5, 5, null);
  W.fire('appmessage', { payload: { CMD: 4 } });

  var walk = storedRuns(W)[0];
  assert(/^\d{4}-\d{2}-\d{2}_\d{4}_walk$/.test(walk.name), 'walk name: ' + walk.name);
  assert.strictEqual(walk.act, 1, 'walk activity stored');

  /* FitTrackee manual export: Bearer token, multipart file + data(sport_id) */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: { auto: true, preset: 'fittrackee',
                       url: 'https://ft.home.lan/', auth: '', key: 'jwt-abc' }
  })) });
  assert.strictEqual(W.xhrs.length, 0, 'fittrackee cfg does not auto-upload');
  W.fire('appmessage', { payload: { CMD: 7 } });   // Upload on the debrief
  assert.strictEqual(W.xhrs.length, 1, 'manual fittrackee upload (key auth)');
  var ft = W.xhrs[0];
  assert.strictEqual(ft.method, 'POST');
  assert.strictEqual(ft.url, 'https://ft.home.lan/api/workouts', 'trailing slash trimmed');
  assert.strictEqual(ft.headers.Authorization, 'Bearer jwt-abc');
  assert(ft.headers['Content-Type'].indexOf('multipart/form-data') === 0, 'multipart');
  assert(/filename="\d{4}-\d{2}-\d{2}_\d{4}_walk/.test(ft.body), 'file field');
  assert(ft.body.indexOf('name="data"') >= 0 &&
         ft.body.indexOf('{"sport_id":6}') >= 0, 'walking sport id');
  assert(ft.body.indexOf('<type>walking</type>') >= 0, 'gpx type walking');
  ft.respond(201);
  assert.strictEqual(storedRuns(W)[0].up, 1);

  /* ---- switch to stored credentials: RunLog manages the token itself ---- */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: { auto: true, preset: 'fittrackee',
                       url: 'https://ft.home.lan/', auth: '', key: '',
                       user: 'kai@home.lan', pass: 'hunter2' }
  })) });
  assert(!W.store['runlog.ftok'], 'cached token cleared on settings change');
  assert.strictEqual(W.xhrs.length, 1, 'walk already uploaded, nothing refires');

  /* ---- ride: 0.8 m/s DOES auto-pause (ride slow threshold 1.0) ---- */
  W.fire('appmessage', { payload: { MODE: 2 } });
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w2 = makeWalker(W, 1750310000, -31.9500, 115.8500);
  for (var k = 0; k < 10; k++) w2.step(8, 5, null);
  w2.step(0.8, 5, null); w2.step(0.8, 5, null); w2.step(0.8, 5, null);
  assert.strictEqual(lastWith(W, 'APAUSE'), null, 'three slow fixes not enough');
  w2.step(0.8, 5, null);
  assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 1,
                     '0.8 m/s pauses a ride (would not pause a run)');
  w2.step(2.5, 5, null); w2.step(2.5, 5, null);
  assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 1,
                     'two fast ride fixes do not resume from a transient burst');
  w2.step(2.5, 5, null);
  assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 0, 'ride resumed after three fast fixes');

  for (var n = 0; n < 130; n++) w2.step(8, 5, null);   // ~5.2 km more
  var sp = msgsWith(W, 'SPLIT');
  assert.strictEqual(sp.length, 1, 'one ride split');
  assert.strictEqual(sp[0].SPLIT, 5, 'ride split announces cumulative 5 km');

  W.fire('appmessage', { payload: { CMD: 4 } });
  var runs = storedRuns(W);
  var ride = runs[runs.length - 1];
  assert(/^\d{4}-\d{2}-\d{2}_\d{4}_ride$/.test(ride.name), 'ride name: ' + ride.name);
  assert.strictEqual(ride.act, 2, 'ride activity stored');
  assert.strictEqual(ride.cad, 0, 'no wrist cadence on rides');
  assert.strictEqual(ride.splits[0].d, 5000, 'first ride split is 5 km');
  // The tuned four-slow/three-fast Ride debounce deliberately retains roughly
  // 15 seconds of evidence before removing the stopped interval.
  assert(Math.abs(ride.splits[0].s - 640) <= 12,
         '5 km ride includes conservative auto-pause debounce, got ' + ride.splits[0].s);

  /* uploads are user-driven: nothing leaves on save */
  assert.strictEqual(W.xhrs.length, 1, 'ride save does not auto-upload');
  W.fire('appmessage', { payload: { CMD: 7 } });   // Upload the ride from the debrief

  /* no cached token yet -> the upload starts with a login */
  assert.strictEqual(W.xhrs.length, 2, 'login fired before first upload');
  var lg = W.xhrs[1];
  assert.strictEqual(lg.method, 'POST');
  assert.strictEqual(lg.url, 'https://ft.home.lan/api/auth/login', 'login endpoint');
  assert.strictEqual(lg.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(lg.body),
    { email: 'kai@home.lan', password: 'hunter2' }, 'credentials in login body');
  lg.respond(200, '{"auth_token":"jwt-1"}');

  assert.strictEqual(W.store['runlog.ftok'], 'jwt-1', 'token cached');
  assert.strictEqual(W.xhrs.length, 3, 'upload follows the login');
  var up1 = W.xhrs[2];
  assert.strictEqual(up1.headers.Authorization, 'Bearer jwt-1', 'fresh token used');
  assert(up1.body.indexOf('{"sport_id":1}') >= 0, 'cycling sport id');
  assert(up1.body.indexOf('<type>cycling</type>') >= 0, 'gpx type cycling');
  up1.respond(201);
  assert.strictEqual(storedRuns(W)[0].up, 1, 'ride uploaded');

  /* cached token reused: a retry goes straight to the workout endpoint */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  assert.strictEqual(W.xhrs.length, 4, 'no needless re-login');
  assert.strictEqual(W.xhrs[3].headers.Authorization, 'Bearer jwt-1');

  /* expired token: 401 -> automatic re-login -> retried with new token */
  W.xhrs[3].respond(401);
  assert.strictEqual(W.xhrs.length, 5, '401 triggers re-login');
  assert.strictEqual(W.xhrs[4].url, 'https://ft.home.lan/api/auth/login');
  W.xhrs[4].respond(200, '{"auth_token":"jwt-2"}');
  assert.strictEqual(W.xhrs[5].headers.Authorization, 'Bearer jwt-2', 'refreshed token used');
  W.xhrs[5].respond(201);
  assert.strictEqual(storedRuns(W)[0].up, 1, 'recovered after expiry');
  assert.strictEqual(W.store['runlog.ftok'], 'jwt-2', 'new token cached');

  /* and if the login itself fails, the run is marked for retry */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  W.xhrs[6].respond(401);
  W.xhrs[7].respond(500);
  assert.strictEqual(W.xhrs.length, 8, 'gave up after failed login');
  assert.strictEqual(storedRuns(W)[0].up, 2, 'marked failed, will retry later');
  assert.strictEqual(lastWith(W, 'EXPST').EXPST, 2, 'watch told about the failure');
  assert.strictEqual(lastWith(W, 'EXPERR').EXPERR, 500, 'login status named as the reason');
  var lg4 = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg4.some(function (m) { return /token rejected \(HTTP 401\)/.test(m); }), '401 logged');
  assert(lg4.some(function (m) { return /fittrackee login FAILED \(HTTP 500\)/.test(m); }), 'login failure logged');
  assert(lg4.some(function (m) { return /fittrackee login ok/.test(m); }), 'earlier login success logged');
  assert(lg4.some(function (m) { return m === 'logging in as "kai@home.lan"'; }), 'login names the email');
  assert(!lg4.some(function (m) { return /password "/.test(m) || /\d+ chars\)/.test(m) || m.indexOf('hunter2') >= 0; }),
         'login never prints the password or its length');

  /* a trailing space in the password is invisible in the form but not in the log */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: { auto: true, preset: 'fittrackee',
                       url: 'https://ft.home.lan/', auth: '', key: '',
                       user: 'kai@home.lan', pass: 'hunter2 ' }
  })) });
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  assert.strictEqual(W.xhrs.length, 9, 'fresh login after credential change');
  W.xhrs[8].respond(401, '{"status":"error"}');
  assert.strictEqual(lastWith(W, 'EXPERR').EXPERR, 401, 'watch shows the 401');
  var lg5 = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg5.some(function (m) { return /password has leading\/trailing whitespace/.test(m); }),
         'sneaky whitespace called out');
  assert(!lg5.some(function (m) { return /password "/.test(m) || /\d+ chars\)/.test(m) || m.indexOf('hunter2') >= 0; }),
         'the password itself is never written to the log');

  console.log('scenario 4 (walk + ride modes, fittrackee credential flow) OK');
})();

/* =======================================================================
 * Scenario 5: pace robustness — missing / wrong-unit GPS timestamps
 * and realistic 1 Hz jittery fixes
 * ===================================================================== */
(function scenario5() {
  /* (a) timestamp entirely missing -> wall-clock fallback keeps pace alive */
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, 1750400000, -31.9500, 115.8500, 'none');
  for (var i = 0; i < 60; i++) w.step(10 / 3, 5, null);

  var p = lastWith(W, 'PACE');
  assert(p && p.PACE > 0, 'pace computed without GPS timestamps');
  assert(Math.abs(p.PACE - 300) <= 8, 'pace ~5:00/km, got ' + p.PACE);
  assert.strictEqual(p.AVGP, undefined, 'average pace waits for the final summary');

  W.fire('appmessage', { payload: { CMD: 4 } });
  var saved = lastWith(W, 'SAVED');
  assert(Math.abs(saved.AVGP - 300) <= 8, 'final average pace ~5:00/km, got ' + saved.AVGP);
  assert(saved.MOVS >= 280 && saved.MOVS <= 310, 'moving time from wall clock: ' + saved.MOVS);
  assert(lastWith(W, 'PACEG'), 'pace graph still produced');
  var r = storedRuns(W)[0];
  assert(r.pts[0][0] > 1.7e9 && r.pts[0][0] < 4e9, 'GPX gets real epoch seconds');
  assert(r.dur >= 290 && r.dur <= 310, 'duration sane: ' + r.dur);

  /* (b) timestamp in seconds instead of ms -> rejected, wall clock used */
  var W2 = makeWorld();
  W2.boot();
  W2.fire('ready', {});
  W2.fire('appmessage', { payload: { CMD: 1 } });
  var w2 = makeWalker(W2, 1750410000, -31.9500, 115.8500, 's');
  for (var k = 0; k < 40; k++) w2.step(10 / 3, 5, null);
  var p2 = lastWith(W2, 'PACE');
  assert(p2 && Math.abs(p2.PACE - 300) <= 10, 'seconds-unit timestamps survived: ' + (p2 && p2.PACE));

  /* (c) realistic phone GPS: 1 Hz fixes, +-2.5 m jitter, 4 minutes */
  var W3 = makeWorld();
  W3.boot();
  W3.fire('ready', {});
  W3.fire('appmessage', { payload: { CMD: 1 } });
  var w3 = makeWalker(W3, 1750420000, -31.9500, 115.8500);
  for (var n = 0; n < 240; n++) w3.step(3.0, 1, null, 8, 2.5);

  var paceVals = msgsWith(W3, 'PACE').map(function (m) { return m.PACE; });
  var firstIdx = -1;
  for (var q = 0; q < paceVals.length; q++) {
    if (paceVals[q] > 0) { firstIdx = q; break; }
  }
  assert(firstIdx >= 0, 'pace appears on noisy 1 Hz fixes');
  assert(firstIdx <= 10, 'pace appears promptly (first reading at update #' + (firstIdx + 1) + ')');
  var late = paceVals.slice(firstIdx);
  assert(late.length >= 15, 'pace keeps updating (' + late.length + ' readings)');
  late.forEach(function (v) {
    assert(v >= 250 && v <= 460, 'noisy pace stays sane (3 m/s ~ 5:33/km), got ' + v);
  });

  console.log('scenario 5 (missing/odd timestamps, 1 Hz jitter) OK');
})();

/* =======================================================================
 * Scenario 6: close-payload transport — every decode habit a phone app
 * might have, plus hostile passwords reaching the login byte-exact
 * ===================================================================== */
(function scenario6() {
  function b64u(str) {
    return Buffer.from(str, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_');
  }
  var NASTY = 'p+%2B çat ';
  var cfgJson = JSON.stringify({
    act: 'cfg',
    cfg: { auto: true, preset: 'fittrackee', url: 'https://ft.home.lan',
           auth: '', key: '', user: 'kai+fit@home.lan', pass: NASTY }
  });

  // the four ways e.response can arrive
  var forms = {
    'encoded b64 (spec)':   encodeURIComponent('b64.' + b64u(cfgJson)),
    'pre-decoded b64':      'b64.' + b64u(cfgJson),
    'legacy encoded json':  encodeURIComponent(cfgJson),
    'legacy decoded json':  cfgJson
  };

  Object.keys(forms).forEach(function (name) {
    var W = makeWorld();
    W.boot();
    W.fire('ready', {});
    W.fire('appmessage', { payload: { CMD: 1 } });
    var w = makeWalker(W, 1750500000, -31.95, 115.85);
    for (var i = 0; i < 12; i++) w.step(10 / 3, 5, null);
    W.fire('appmessage', { payload: { CMD: 4 } });

    W.fire('webviewclosed', { response: forms[name] });
    var c = JSON.parse(W.store['runlog.cfg']);
    assert.strictEqual(c.user, 'kai+fit@home.lan', name + ': email intact');
    assert.strictEqual(c.pass, NASTY, name + ': password intact');

    // manual upload from the watch -> the login body must carry the exact bytes
    W.fire('appmessage', { payload: { CMD: 7 } });
    assert(W.xhrs.length >= 1, name + ': login fired');
    var body = JSON.parse(W.xhrs[0].body);
    assert.strictEqual(body.email, 'kai+fit@home.lan', name + ': email on the wire');
    assert.strictEqual(body.password, NASTY, name + ': password on the wire');
    W.xhrs[0].respond(401, '{"message":"invalid credentials","status":"error"}');
    var lg = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
    assert(lg.some(function (m) {
      return m.indexOf('server said: "invalid credentials"') >= 0;
    }), name + ': server message logged');
    assert(!lg.some(function (m) {
      return m.indexOf(NASTY) >= 0 || /\d+ chars\)/.test(m) || /password "/.test(m);
    }), name + ': hostile password never reaches the log');
  });

  console.log('scenario 6 (transport robustness, hostile passwords) OK');
})();

/* =======================================================================
 * Scenario 7: discarding from the watch (in-flight guard)
 * and re-typing a saved workout on the phone
 * ===================================================================== */
(function scenario7() {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: { auto: true, preset: 'custom',
                       url: 'https://example.test/runs', auth: '', key: '', user: '', pass: '' }
  })) });

  function quickRun(t0) {
    W.clockMs = t0 * 1000;                 // run starts at a real wall time
    W.fire('appmessage', { payload: { CMD: 1 } });
    var w = makeWalker(W, t0, -31.95, 115.85);
    var steps = 0;
    for (var i = 0; i < 12; i++) {
      w.step(10 / 3, 5, null);
      steps += 14;
      W.fire('appmessage', { payload: { HR: 150, STEPS: steps } });
    }
    W.fire('appmessage', { payload: { CMD: 4 } });
  }

  /* discard within the grace window: run gone, upload never fires */
  quickRun(1750600000);
  assert.strictEqual(storedRuns(W).length, 1, 'run saved');
  assert.strictEqual(W.xhrs.length, 0, 'nothing uploaded on save (user-driven)');
  W.fire('appmessage', { payload: { CMD: 6 } });
  assert.strictEqual(storedRuns(W).length, 0, 'discarded');
  W.flushTimers();
  assert.strictEqual(W.xhrs.length, 0, 'scheduled upload was cancelled');
  var lg = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg.some(function (m) { return /^discarded "\d{4}-\d{2}-\d{2}_\d{4}_run/.test(m); }), 'discard logged');

  /* discard while the upload is already in flight: result is ignored */
  quickRun(1750601000);
  W.fire('appmessage', { payload: { CMD: 7 } });   // user starts an upload
  assert.strictEqual(W.xhrs.length, 1, 'upload in flight');
  var expBefore = msgsWith(W, 'EXPST').length;
  W.fire('appmessage', { payload: { CMD: 6 } });
  assert.strictEqual(storedRuns(W).length, 0, 'discarded mid-flight');
  W.xhrs[0].respond(201);
  assert.strictEqual(msgsWith(W, 'EXPST').length, expBefore,
                     'no upload status for a discarded workout');
  assert(JSON.parse(W.store['runlog.log']).some(function (e) {
    return /discarded workout ignored/.test(e[1]);
  }), 'late result logged and dropped');

  /* retype: Run -> Walk -> Ride -> Hike -> Run, splits and cadence follow */
  quickRun(1750602000);
  W.fire('appmessage', { payload: { CMD: 7 } });
  W.xhrs[1].respond(201);
  var r0 = storedRuns(W)[0];
  assert(/_run\b/.test(r0.name) && r0.cad > 0, 'baseline run with cadence: ' + r0.name);

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retype', idx: 0, to: 1 })) });
  var r1 = storedRuns(W)[0];
  assert(/_walk\b/.test(r1.name), 'renamed to Walk: ' + r1.name);
  assert.strictEqual(r1.act, 1, 'act updated');
  assert.strictEqual(r1.up, 3, 'uploaded run is marked changed locally');
  var lg7 = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg7.some(function (m) { return /retyped ".* -> Walk/.test(m); }), 'retype logged');
  assert(lg7.some(function (m) { return /re-upload to update the server copy/.test(m); }), 'server note');

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retype', idx: 0, to: 2 })) });
  var r2 = storedRuns(W)[0];
  assert.strictEqual(r2.cad, 0, 'ride presentation suppresses cadence');
  assert(r2.pts.some(function (p) { return p[6] > 0; }), 'ride retype preserves raw wrist samples');
  assert.strictEqual(r2.splits.length, 1, 'ride splits recomputed (partial only)');
  assert(r2.splits[0].d < 1000, '183 m never makes a 5 km split');

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retype', idx: 0, to: 3 })) });
  var r3 = storedRuns(W)[0];
  assert(/_hike\b/.test(r3.name) && r3.act === 3, 'retyped to a Hike: ' + r3.name);
  assert(r3.cad > 150, 'Hike cadence recovered from raw samples, got ' + r3.cad);
  assert(r3.splits.length >= 1 && r3.splits[0].d < 1000,
         'short Hike keeps a one-unit partial split');

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retype', idx: 0, to: 0 })) });
  var r4 = storedRuns(W)[0];
  assert(/_run\b/.test(r4.name) && r4.act === 0, 'back to a run: ' + r4.name);
  assert(r4.cad > 150, 'run cadence retained, got ' + r4.cad);

  console.log('scenario 7 (watch discard, in-flight guard, retype) OK');
})();

/* =======================================================================
 * Scenario 8: manual "Upload now" from the debrief actions menu (CMD 7).
 * Proves there is NO auto-upload timer any more — saving schedules nothing —
 * and that CMD 7 uploads immediately, and still works after success.
 * ===================================================================== */
(function scenario8() {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});

  // a valid upload target is configured, but uploads are still user-driven
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg',
    cfg: { auto: true, preset: 'custom', url: 'https://up.test/runs',
           auth: 'Bearer tok', key: '' }
  })) });
  assert.strictEqual(W.xhrs.length, 0, 'cfg with no saved run uploads nothing');

  W.fire('appmessage', { payload: { UNITS: 0, AUTOP: 0, SPLITP: 0 } });
  W.clockMs = 1750100000000;
  W.fire('appmessage', { payload: { CMD: 1 } });

  var w = makeWalker(W, 1750100000, -31.95, 115.85);
  for (var i = 0; i < 20; i++) { w.step(10 / 3, 5, 20, 8); W.fire('appmessage', { payload: { HR: 150 } }); }
  W.fire('appmessage', { payload: { CMD: 4 } });        // stop -> save

  // the auto-upload timer is GONE: saving uploads nothing and schedules nothing
  assert.strictEqual(W.xhrs.length, 0, 'save never auto-uploads (user-driven)');
  assert.strictEqual(W.timers.length, 0, 'no upload timer is ever scheduled');

  // the watch's debrief "Upload" action
  W.fire('appmessage', { payload: { CMD: 7 } });
  assert.strictEqual(W.xhrs.length, 1, 'CMD 7 uploads immediately');
  var x = W.xhrs[0];
  assert.strictEqual(x.method, 'POST');
  assert.strictEqual(x.url, 'https://up.test/runs', 'uploads to the configured target');
  assert.strictEqual(lastWith(W, 'EXPST').EXPST, 0, 'watch shown uploading');
  x.respond(201);
  assert.strictEqual(lastWith(W, 'EXPST').EXPST, 1, 'watch shown uploaded');
  assert.strictEqual(storedRuns(W)[0].up, 1, 'run marked uploaded');

  var lg = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg.some(function (m) { return /manual upload from watch/.test(m); }), 'manual upload logged');

  // pressing Upload again after success re-sends (manual override always works)
  W.fire('appmessage', { payload: { CMD: 7 } });
  assert.strictEqual(W.xhrs.length, 2, 'manual re-upload fires again post-success');
  W.xhrs[1].respond(201);

  console.log('scenario 8 (manual upload from debrief, CMD 7) OK');
})();

/* =======================================================================
 * Scenario 9: the run-name template (ask: default run name setting).
 * Custom template expands every token; a blank template falls back to the
 * default, and re-typing regenerates the name for the new activity.
 * ===================================================================== */
(function scenario9() {
  function enc(o) { return encodeURIComponent(JSON.stringify(o)); }
  function p2(x) { return (x < 10 ? '0' : '') + x; }
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});

  // a custom template with literal text + every token
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '',
                       name: '{Part} {activity} {date} @{time} session' } }) });

  var t0 = 1750100000;            // epoch seconds
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { MODE: 0 } });   // run
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, t0, -31.95, 115.85);
  for (var i = 0; i < 12; i++) w.step(10 / 3, 5, null);
  W.fire('appmessage', { payload: { CMD: 4 } });

  // expected name, derived exactly as the app does it (timezone-independent)
  var d = new Date(t0 * 1000), h = d.getHours();
  var part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  var Part = part.charAt(0).toUpperCase() + part.slice(1);
  var date = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  var time = p2(h) + '.' + p2(d.getMinutes());
  var r = storedRuns(W)[0];
  assert.strictEqual(r.name, Part + ' run ' + date + ' @' + time + ' session',
                     'template expands all tokens: ' + r.name);

  // blank template -> built-in default {part}-{activity}_{date};
  // re-typing to Walk regenerates the name for the new activity
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '', name: '' } }) });
  W.fire('webviewclosed', { response: enc({ act: 'retype', idx: 0, to: 1 }) });
  var r2 = storedRuns(W)[0];
  assert(/^\d{4}-\d{2}-\d{2}_\d{4}_walk$/.test(r2.name),
                     'blank template -> new time-bearing default, regenerated for walk: ' + r2.name);

  // unknown tokens are left untouched
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '', name: '{bogus}-{activity}' } }) });
  W.fire('webviewclosed', { response: enc({ act: 'retype', idx: 0, to: 0 }) });
  assert.strictEqual(storedRuns(W)[0].name, '{bogus}-run',
                     'unknown token passes through verbatim');

  // strftime-style %-codes expand from the run's start time
  function p2s(x) { return (x < 10 ? '0' : '') + x; }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '',
                       name: '%F_%H%M%S-%a-%b-{activity}' } }) });
  W.fire('webviewclosed', { response: enc({ act: 'retype', idx: 0, to: 0 }) });
  var rs = new Date(storedRuns(W)[0].start);
  var expF = rs.getFullYear() + '-' + p2s(rs.getMonth() + 1) + '-' + p2s(rs.getDate());
  var expHMS = p2s(rs.getHours()) + p2s(rs.getMinutes()) + p2s(rs.getSeconds());
  assert.strictEqual(storedRuns(W)[0].name,
    expF + '_' + expHMS + '-' + DOW[rs.getDay()] + '-' + MON3[rs.getMonth()] + '-run',
    'strftime %F/%H%M%S/%a/%b expand: ' + storedRuns(W)[0].name);

  // %% is a literal percent; bare % followed by a non-code is left alone
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '', name: '%H%% effort {activity}' } }) });
  W.fire('webviewclosed', { response: enc({ act: 'retype', idx: 0, to: 0 }) });
  assert.strictEqual(storedRuns(W)[0].name,
    p2s(rs.getHours()) + '% effort run', 'strftime %% -> literal percent');

  console.log('scenario 9 (run-name template) OK');
})();

/* =======================================================================
 * Scenario 10: voice rename from the debrief (RENAME message). The phone
 * copy is always kept; the dictated text just renames the last run.
 * ===================================================================== */
(function scenario10() {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.clockMs = 1750700000000;
  W.fire('appmessage', { payload: { MODE: 0 } });
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, 1750700000, -31.95, 115.85);
  for (var i = 0; i < 12; i++) w.step(10 / 3, 5, null);
  W.fire('appmessage', { payload: { CMD: 4 } });

  var before = storedRuns(W)[0].name;
  W.fire('appmessage', { payload: { RENAME: '  Sunset   River Loop  ' } });
  var r = storedRuns(W)[0];
  assert.strictEqual(r.name, 'Sunset River Loop', 'voice name applied + whitespace tidied: ' + r.name);
  assert.notStrictEqual(r.name, before, 'name actually changed');
  var lg = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg.some(function (m) { return /renamed ".*" -> "Sunset River Loop" \(voice\)/.test(m); }),
         'rename logged');

  // a blank/whitespace transcription is ignored, and the run stays on the phone
  W.fire('appmessage', { payload: { RENAME: '   ' } });
  assert.strictEqual(storedRuns(W)[0].name, 'Sunset River Loop', 'blank rename ignored');
  assert.strictEqual(storedRuns(W).length, 1, 'run still kept on the phone');

  console.log('scenario 10 (voice rename of last run) OK');
})();

/* =======================================================================
 * Scenario 11: export format selection — the same run uploaded as each of
 * GPX, TCX and FIT produces the right filename, content-type and body.
 * ===================================================================== */
(function () {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.clockMs = 1750300000000;
  W.fire('appmessage', { payload: { CMD: 1 } });          // start
  var w = makeWalker(W, 1750300000, -31.95, 115.85);
  for (var i = 0; i < 40; i++) w.step(10 / 3, 5, 20);     // ~667 m over 40 fixes
  W.fire('appmessage', { payload: { CMD: 4 } });          // stop & save
  assert(storedRuns(W).length >= 1, 'run saved for export');

  function uploadAs(fmt) {
    var n = W.xhrs.length;
    W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
      act: 'cfg', cfg: { auto: 0, preset: 'custom', url: 'https://fmt.test/runs', auth: '', key: '', fmt: fmt }
    })) });
    W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
    assert.strictEqual(W.xhrs.length, n + 1, fmt + ': exactly one upload fired');
    var x = W.xhrs[n];
    x.respond(201);
    return x;
  }

  var g = uploadAs('gpx');
  assert.strictEqual(g.headers['Content-Type'], 'application/gpx+xml', 'gpx: content-type');
  assert(/\.gpx$/.test(g.headers['X-Filename']), 'gpx: .gpx filename');
  assert(typeof g.body === 'string' && g.body.indexOf('<gpx ') >= 0, 'gpx: text body');

  var t = uploadAs('tcx');
  assert.strictEqual(t.headers['Content-Type'], 'application/vnd.garmin.tcx+xml', 'tcx: content-type');
  assert(/\.tcx$/.test(t.headers['X-Filename']), 'tcx: .tcx filename');
  assert(typeof t.body === 'string' && t.body.indexOf('<TrainingCenterDatabase') >= 0, 'tcx: text body');

  var f = uploadAs('fit');
  assert.strictEqual(f.headers['Content-Type'], 'application/vnd.ant.fit', 'fit: content-type');
  assert(/\.fit$/.test(f.headers['X-Filename']), 'fit: .fit filename');
  assert(f.body && f.body.constructor && f.body.constructor.name === 'Uint8Array', 'fit: binary (Uint8Array) body');
  assert.strictEqual(String.fromCharCode(f.body[8], f.body[9], f.body[10], f.body[11]), '.FIT', 'fit: .FIT signature in body');

  console.log('scenario 11 (export format selection: gpx/tcx/fit) OK');
})();

/* =======================================================================
 * Scenario 12: AppGlance — the launcher glance reflects the most recent run
 * and is cleared when no runs remain.
 * ===================================================================== */
(function () {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 0 } });        // km
  W.clockMs = 1750400000000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, 1750400000, -31.95, 115.85);
  for (var i = 0; i < 60; i++) w.step(10 / 3, 5, 20);     // ~1000 m over 300 s
  W.fire('appmessage', { payload: { CMD: 4 } });          // stop & save -> glance set

  assert(W.glances.length > 0, 'glance reloaded after a save');
  var slices = W.glances[W.glances.length - 1];
  assert(Array.isArray(slices) && slices.length === 1, 'one glance slice');
  var sub = slices[0].layout.subtitleTemplateString;
  assert(/km/.test(sub), 'glance subtitle carries distance: ' + sub);
  assert(/\b\d+:\d\d\b/.test(sub), 'glance subtitle carries time: ' + sub);
  assert(/^Run\b/.test(sub), 'glance subtitle names the activity: ' + sub);
  assert(/^system:\/\/images\//.test(slices[0].layout.icon), 'glance uses a system icon');

  // clearing all runs empties the glance
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'clear' })) });
  var last = W.glances[W.glances.length - 1];
  assert(Array.isArray(last) && last.length === 0, 'glance cleared when no runs remain');

  console.log('scenario 12 (app glance: last-run summary) OK');
})();

/* =======================================================================
 * Scenario 13: VO2max estimate — a steady aerobic run with HR produces a
 * plausible running VO2max via the ACSM/Swain submaximal method.
 * ===================================================================== */
(function () {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 0, MHR: 190 } });   // km, user max HR 190
  W.clockMs = 1750500000000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, 1750500000, -31.95, 115.85);
  for (var i = 0; i < 75; i++) {   // long enough that >=20 points outlast the 2 min warm-up cut
    W.fire('appmessage', { payload: { HR: 160 } });   // refresh HR inside the 15 s stale window
    w.step(10 / 3, 5, 25);                             // 3.33 m/s = 200 m/min, steady
  }
  W.fire('appmessage', { payload: { CMD: 4 } });       // stop & save

  var run = storedRuns(W)[0];
  // 200 m/min -> ACSM VO2 43.5; HR 160/190 = 84.2% -> Swain %VO2 ~73.8% -> ~59
  assert(run.vo2max >= 53 && run.vo2max <= 66,
    'running VO2max in plausible band (~59): ' + run.vo2max);
  assert(run.vo2max === Math.round(run.vo2max) && run.vo2max > 0, 'VO2max is a positive integer');

  console.log('scenario 13 (VO2max estimate) OK');
})();

/* =======================================================================
 * Scenario 14: stored (and thus exported) elevation is smoothed, so a flat
 * run with noisy GPS altitude doesn't export a wildly inflated gain.
 * ===================================================================== */
(function () {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 0 } });
  W.clockMs = 1750600000000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, 1750600000, -31.95, 115.85);
  var raw = [];
  for (var i = 0; i < 40; i++) {
    var e = (i % 2 === 0) ? 0 : 8;   // +/-8 m sawtooth: pure GPS vertical noise on flat ground
    raw.push(e); w.step(10 / 3, 5, e);
  }
  W.fire('appmessage', { payload: { CMD: 4 } });
  var pts = storedRuns(W)[0].pts;
  var ele = pts.map(function (p) { return p[3]; }).filter(function (x) { return x !== ''; });
  function tv(a) { var s = 0; for (var i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]); return s; }
  assert(tv(ele) < tv(raw) * 0.5, 'stored elevation smoothed: TV ' + tv(ele).toFixed(0) + ' << raw ' + tv(raw));
  console.log('scenario 14 (elevation smoothing) OK');
})();

/* =======================================================================
 * Scenario 15: per-point cadence survives Bluetooth arrival-time jitter.
 * One interval's steps arrive per message, but at jittery gaps; the old
 * instantaneous rate (steps / arrival-gap) would swing ~0.5x..2x (a 3 s gap
 * reads ~260, a 7 s gap ~111). The snapped trailing window holds it steady.
 * ===================================================================== */
(function () {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 0 } });
  var t0 = 1750700000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, t0, -31.95, 115.85);
  var gaps = [5,3,7,3,7,4,6,3,7,5,4,6,3,7,4,6,5,3,7,4,6,5,4,6,5];  // mean 5 s, heavy jitter
  for (var i = 0; i < gaps.length; i++) {
    w.step(2.6, gaps[i], 30);                                       // ~2.6 m/s, jittery spacing
    W.fire('appmessage', { payload: { HR: 150, STEPS: (i + 1) * 13 } });  // 13 steps/interval = 156 spm
  }
  W.fire('appmessage', { payload: { CMD: 4 } });
  var pts = storedRuns(W)[0].pts;
  var cad = pts.map(function (p) { return p[6]; }).filter(function (c) { return c > 0; }).slice(2);
  var lo = Math.min.apply(null, cad), hi = Math.max.apply(null, cad);
  assert(lo >= 140 && hi <= 175, 'cadence stays near 156 despite BLE jitter: ' + lo + '..' + hi);
  assert(hi - lo <= 30, 'no 2x/0.5x cadence spikes (old code would span ~111..260): range ' + (hi - lo));
  console.log('scenario 15 (cadence jitter robustness) OK');
})();

/* Scenario 16: honest saves (#4). A stop with no usable GPS and no meaningful
 * time reports NOSAVE — never a fake "RUN SAVED"; a no-GPS stop with real
 * elapsed time is kept as a treadmill run instead of vanishing. */
(function scenario16() {
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 0, AUTOP: 1, SPLITP: 1 } });

  // (a) start then immediately stop: no fixes, no time -> NOSAVE, nothing stored
  var t0 = 1750300000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  W.fire('appmessage', { payload: { CMD: 4 } });
  var noSave = lastWith(W, 'NOSAVE');
  assert(noSave, 'empty stop reports NOSAVE');
  assert(noSave.SID, 'NOSAVE is tagged with the session it is allowed to clear');
  assert.strictEqual(noSave.PROTO, 3, 'NOSAVE uses the session-safe protocol');
  assert(!lastWith(W, 'SAVED'), 'empty stop does NOT claim SAVED');
  assert(!W.store['runlog.runs'] || storedRuns(W).length === 0, 'nothing stored for an empty stop');

  // (b) meaningful elapsed time + steps, but no GPS: save a route-less workout.
  // Distance stays unknown/zero and no coordinate is invented; the detail page
  // and all exporters now have explicit route-less representations.
  W.msgs.length = 0;                                    // isolate this leg's messages
  var t1 = 1750301000;
  W.clockMs = t1 * 1000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  W.fire('appmessage', { payload: { STEPS: 1800 } });   // steps arrive, but no GPS fixes ever do
  W.clockMs = (t1 + 900) * 1000;                        // 15 minutes later
  W.fire('appmessage', { payload: { CMD: 4 } });
  assert(lastWith(W, 'SAVED'), 'meaningful no-GPS workout is saved');
  assert(!lastWith(W, 'NOSAVE'), 'meaningful no-GPS workout is not discarded');
  var rl = storedRuns(W)[0];
  assert.strictEqual(rl.route, 0, 'saved workout is explicitly route-less');
  assert.strictEqual(rl.dist, 0, 'route-less workout never fabricates distance');
  assert.strictEqual(rl.steps, 1800, 'route-less workout keeps watch totals');
  assert(rl.pts.length >= 1 && rl.pts.every(function (p) { return p[1] === 0 && p[2] === 0; }),
         'route-less measurement points contain no fabricated coordinates');
  console.log('scenario 16 (honest route-less save; empty stop still NOSAVE) OK');
})();

/* Scenario 17: steps taken while paused must not inflate the total or cadence (#23). */
(function scenario17() {
  // The paused-step EXCLUSION lives on the watch now (src/c/main.c,
  // prv_refresh_steps freezes the count while STATE_PAUSED), and the watch only
  // *sends* samples while RUNNING — never during a pause. This test covers the
  // PHONE's half of that contract with the messages a real watch would actually
  // send: nothing during the pause, and a resumed count that already excludes the
  // paused steps. It asserts the phone takes that count at face value (no phantom
  // paused steps re-added — the old, wrong behaviour) and doesn't carry a stale
  // pre-pause sample across the gap. The watch-side freeze itself is verified by
  // compilation + on-device, not in this JS harness.
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 0, AUTOP: 0, SPLITP: 1 } });
  var t0 = 1750400000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, t0, -31.95, 115.85), i;
  for (i = 1; i <= 6; i++) { w.step(2.6, 5, 30); W.fire('appmessage', { payload: { STEPS: i * 13 } }); }  // 78 moving steps
  W.fire('appmessage', { payload: { CMD: 2 } });                       // pause
  W.clockMs += 60000;                                                  // a minute passes; the watch sends NOTHING while paused
  W.fire('appmessage', { payload: { CMD: 3 } });                       // resume
  // The watch's net count resumes from 78 — the paused steps were already
  // excluded on the watch, so it does NOT jump forward by them.
  for (i = 1; i <= 6; i++) { w.step(2.6, 5, 30); W.fire('appmessage', { payload: { STEPS: 78 + i * 13 } }); }  // 78 more moving steps
  W.fire('appmessage', { payload: { CMD: 4 } });
  var r = storedRuns(W)[0];
  assert.strictEqual(r.steps, 156, 'phone uses the watch net step count as-is (not 276): ' + r.steps);
  assert(r.cad === 0 || (r.cad > 0 && r.cad <= 260), 'stored cadence is sane, no pause-gap spike: ' + r.cad);
  console.log('scenario 17 (phone trusts watch net steps; no double-count) OK');
})();

(function scenario18() {
  // Restart recovery (#3) and command idempotency (#4), end to end.
  var W = makeWorld();
  W.boot();
  W.fire('ready', {});
  W.fire('appmessage', { payload: { UNITS: 0, AUTOP: 0, SPLITP: 1 } });
  var t0 = 1750500000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, t0, -31.95, 115.85), i;
  for (i = 1; i <= 15; i++) w.step(3.0, 5, 30);       // 15 clean fixes -> a checkpoint is written
  assert(W.store['runlog.inprogress'], 'checkpoint persisted mid-run');
  var cp = JSON.parse(W.store['runlog.inprogress']);
  assert.strictEqual(cp.chunked, 1, 'checkpoint uses an appendable chunk journal');
  assert(cp.npts >= 14, 'checkpoint records point count: ' + cp.npts);
  assert(W.store['runlog.ip.' + cp.sid + '.0'], 'first point chunk persisted separately');
  assert(!cp.pts, 'metadata does not rewrite the full route');
  var torn = JSON.parse(W.store['runlog.ip.' + cp.sid + '.0']);
  torn.push([9999999999, 80, 80, '', 0, 0, 0]); // chunk landed, metadata did not
  W.store['runlog.ip.' + cp.sid + '.0'] = JSON.stringify(torn);
  assert(cp.paused === 0 && cp.autopaused === 0, 'checkpoint records pause state');

  // Simulate a phone-JS restart: fresh module + world, SAME persistent storage,
  // clock advanced to just after the checkpoint so the run is resumed (not recovered).
  var store = W.store;
  var W2 = makeWorld();
  W2.store = store;
  W2.boot();
  W2.clockMs = (t0 + 75) * 1000;
  W2.fire('ready', {});
  assert(W2.geoCb, 'GPS re-armed on resume');
  assert(!lastWith(W2, 'SAVED'), 'a fresh restart resumes; it does not finalize+save');
  assert(W2.store['runlog.inprogress'], 'checkpoint kept while the resumed run continues');

  // The first post-restart fix is ~6 km from the pre-restart point (GPS reacquired
  // elsewhere). That gap must NOT be added to distance — only real movement after.
  var w2 = makeWalker(W2, t0 + 80, -31.99, 115.90);
  for (i = 1; i <= 15; i++) w2.step(3.0, 5, 30);
  var repairedChunk = JSON.parse(W2.store['runlog.ip.' + cp.sid + '.0']);
  assert.strictEqual(repairedChunk.length, 30, 'uncommitted chunk tail is replaced, not duplicated');
  assert(repairedChunk.every(function (p) { return p[0] !== 9999999999; }),
         'torn-write marker removed before append');
  W2.fire('appmessage', { payload: { CMD: 4 } });     // stop
  var r = storedRuns(W2)[0];
  assert(r.dist < 2000, 'restart gap excluded from distance (want a few hundred m, not ~6 km): ' + r.dist);
  assert(r.dist > 100, 'real distance still accumulated across the restart: ' + r.dist);

  // A duplicate STOP after the run is over is silent — it must not emit NOSAVE
  // (which would wipe the SAVED the watch just showed) or re-save.
  W2.msgs.length = 0;
  W2.fire('appmessage', { payload: { CMD: 4 } });
  assert(!lastWith(W2, 'NOSAVE'), 'duplicate stop is silent (no NOSAVE over a prior SAVED)');
  assert(!lastWith(W2, 'SAVED'), 'duplicate stop does not re-save');
  console.log('scenario 18 (restart resume, no gap distance, idempotent stop) OK');
})();

/* =======================================================================
 * Scenario 19: protocol v2 sequencing. Duplicate and stale intents converge
 * on one session and one stored workout, with explicit ACK/result snapshots.
 * ===================================================================== */
(function scenario19() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var sid = 0x12345678, t0 = 1750800000;
  W.clockMs = t0 * 1000;

  function cmd(n, seq, state, extra) {
    var p = { PROTO: 2, SID: sid, SEQ: seq, CMD: n, WSTATE: state,
              STARTTS: t0, ACTIVE: 0, SAMPLET: Math.round(W.clockMs / 1000) };
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    W.fire('appmessage', { payload: p });
    var ack = lastWith(W, 'ACK');
    assert(ack && ack.ACK === seq, 'command ' + n + '/' + seq + ' acknowledged');
    return ack;
  }

  var a = cmd(1, 10, 1, { STEPS: 0 });
  assert.strictEqual(a.RESULT, 1, 'start accepted');
  assert.strictEqual(a.SID, sid, 'authoritative session id echoed');
  assert.strictEqual(a.WSTATE, 1, 'phone reports running');

  var w = makeWalker(W, t0, -31.95, 115.85);
  for (var i = 0; i < 18; i++) w.step(3, 5, 20);
  var cp = JSON.parse(W.store['runlog.inprogress']);
  var beforeN = cp.npts;

  cmd(1, 10, 1);                         // duplicate START: ACK, no reset
  assert.strictEqual(JSON.parse(W.store['runlog.inprogress']).npts, beforeN,
                     'duplicate START does not reset the route');
  cmd(2, 11, 2);
  assert.strictEqual(lastWith(W, 'WSTATE').WSTATE, 2, 'pause converged');

  cmd(1, 10, 1);                         // reordered old START
  assert.strictEqual(JSON.parse(W.store['runlog.inprogress']).cmdSeq, 11,
                     'stale START cannot roll the sequence backwards');
  cmd(3, 12, 1);
  for (i = 0; i < 6; i++) w.step(3, 5, 20);
  cmd(4, 13, 3, { STEPS: 77, HR: 155 });

  var runs = storedRuns(W);
  assert.strictEqual(runs.length, 1, 'STOP creates exactly one workout');
  assert.strictEqual(runs[0].sid, sid, 'saved workout keeps protocol session id');
  assert.strictEqual(runs[0].steps, 77, 'transactional STOP includes final sensor sample');

  cmd(4, 13, 3, { STEPS: 77, HR: 155 }); // duplicate STOP: cached ACK + summary
  assert.strictEqual(storedRuns(W).length, 1,
                     'duplicate STOP cannot double-save');

  // A fresh watch launch deliberately reports READY with no session id. The
  // phone keeps the saved activity as an action/history target, but must not
  // push its summary back over the blank recorder screen.
  var summariesBeforeReopen = msgsWith(W, 'SAVED').length;
  W.fire('appmessage', { payload: {
    PROTO: 2, HELLO: 1, SID: 0, SEQ: 13, WSTATE: 0, ACTIVE: 0, STEPS: 0
  } });
  assert.strictEqual(lastWith(W, 'WSTATE').WSTATE, 0,
                     'fresh READY launch remains idle');
  assert.strictEqual(msgsWith(W, 'SAVED').length, summariesBeforeReopen,
                     'fresh READY launch does not replay the previous summary');

  cmd(6, 14, 4);
  assert.strictEqual(storedRuns(W).length, 0,
                     'session-scoped discard removes the intended workout');
  assert.strictEqual(lastWith(W, 'ACK').RESULT, 1, 'discard success is acknowledged');

  // A protocol-v3 empty stop first clears the affected SID with NOSAVE, then
  // ACKs the command from the genuinely blank READY state. It must not
  // re-advertise the discarded identifier in that trailing snapshot.
  var E = makeWorld(), emptySid = 0x23456789;
  E.boot(); E.fire('ready', {}); E.clockMs = (t0 + 1000) * 1000;
  E.fire('appmessage', { payload: {
    PROTO: 3, SID: emptySid, SEQ: 1, CMD: 1, WSTATE: 1,
    STARTTS: t0 + 1000, ACTIVE: 0
  } });
  E.fire('appmessage', { payload: {
    PROTO: 3, SID: emptySid, SEQ: 2, CMD: 4, WSTATE: 3,
    STARTTS: t0 + 1000, ACTIVE: 0
  } });
  assert.strictEqual(lastWith(E, 'NOSAVE').SID, emptySid,
                     'empty-stop NOSAVE identifies only the discarded session');
  var emptyAck = lastWith(E, 'ACK');
  assert.strictEqual(emptyAck.ACK, 2, 'empty STOP is acknowledged');
  assert.strictEqual(emptyAck.SID, 0, 'trailing READY ACK has no stale SID');
  assert.strictEqual(emptyAck.WSTATE, 0, 'trailing ACK describes a blank recorder');
  console.log('scenario 19 (versioned session protocol, duplicates/reordering) OK');
})();

/* =======================================================================
 * Scenario 20: a checkpoint older than the old 20-minute cutoff remains live
 * when the watch says that same session is still paused.
 * ===================================================================== */
(function scenario20() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var sid = 424242, t0 = 1750900000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: {
    PROTO: 2, SID: sid, SEQ: 1, CMD: 1, WSTATE: 1, STARTTS: t0, ACTIVE: 0
  } });
  var w = makeWalker(W, t0, -31.95, 115.85);
  for (var i = 0; i < 18; i++) w.step(2.5, 5, 20);
  W.fire('appmessage', { payload: {
    PROTO: 2, SID: sid, SEQ: 2, CMD: 2, WSTATE: 2, ACTIVE: 90
  } });
  var store = W.store;

  var W2 = makeWorld();
  W2.store = store;
  W2.clockMs = (t0 + 7200) * 1000;       // two-hour pause
  W2.boot(); W2.fire('ready', {});
  assert(!W2.store['runlog.runs'], 'old checkpoint is not finalized from age alone');
  assert(W2.store['runlog.inprogress'], 'two-hour paused session remains recoverable');
  W2.fire('appmessage', { payload: {
    PROTO: 2, HELLO: 1, SID: sid, SEQ: 2, WSTATE: 2, APAUSE: 0,
    ACTIVE: 90, STARTTS: t0, STEPS: 250, SAMPLET: t0 + 7200
  } });
  assert.strictEqual(lastWith(W2, 'WSTATE').WSTATE, 2, 'watch and phone reconcile to paused');
  assert(!W2.store['runlog.runs'], 'reconciliation resumes rather than recovers/saves');

  W2.fire('appmessage', { payload: {
    PROTO: 2, SID: sid, SEQ: 3, CMD: 3, WSTATE: 1, ACTIVE: 90
  } });
  var w2 = makeWalker(W2, t0 + 7200, -31.96, 115.86);
  for (i = 0; i < 8; i++) w2.step(2.5, 5, 20);
  W2.fire('appmessage', { payload: {
    PROTO: 2, SID: sid, SEQ: 4, CMD: 4, WSTATE: 3, ACTIVE: 130, STEPS: 300
  } });
  var r = storedRuns(W2)[0];
  assert.strictEqual(r.sid, sid);
  assert(!/\(recovered\)$/.test(r.name), 'continued session is saved normally');
  console.log('scenario 20 (long-pause watch reconciliation) OK');
})();

/* =======================================================================
 * Scenario 21: hostile page data, secret minimisation, corrupt-store safety,
 * and the upload abort path.
 * ===================================================================== */
(function scenario21() {
  var W = makeWorld();
  var attack = '</script><script>globalThis.RUNLOG_PWNED=1</script>\u2028\u2029';
  W.store['runlog.log'] = JSON.stringify([[1750000000, attack]]);
  W.store['runlog.cfg'] = JSON.stringify({
    preset: 'fittrackee', url: 'https://private.test',
    auth: 'Bearer UNIQUE_AUTH_SECRET', key: 'UNIQUE_KEY_SECRET',
    user: 'runner@example.test', pass: 'UNIQUE_PASSWORD_SECRET'
  });
  W.boot(); W.fire('ready', {}); W.fire('showConfiguration', {});
  var page = openedHtml(W.opened[0]);
  assert(page.indexOf(attack) < 0, 'hostile log cannot close the inline script');
  assert(page.indexOf('\\u003c/script>\\u003cscript>') >= 0,
         'script-breaking less-than characters are escaped before HTML parsing');
  ['UNIQUE_AUTH_SECRET', 'UNIQUE_KEY_SECRET', 'UNIQUE_PASSWORD_SECRET'].forEach(function (s) {
    assert(page.indexOf(s) < 0, 'page source excludes saved secret ' + s);
  });
  assert(page.indexOf('"hasAuth":true') >= 0 && page.indexOf('"hasKey":true') >= 0 &&
         page.indexOf('"hasPass":true') >= 0, 'presence flags preserve secret-edit UX');

  W.store['runlog.ftok'] = 'TOKEN_STAYS';
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: {
      preset: 'fittrackee', url: 'https://private.test',
      user: 'runner@example.test', name: 'new-name', fmt: 'gpx',
      auth: '', authSet: false, clearAuth: false,
      key: '', keySet: false, clearKey: false,
      pass: '', passSet: false, clearPass: false
    }
  })) });
  var kept = JSON.parse(W.store['runlog.cfg']);
  assert.strictEqual(kept.auth, 'Bearer UNIQUE_AUTH_SECRET', 'blank secret field keeps saved authorization');
  assert.strictEqual(kept.key, 'UNIQUE_KEY_SECRET', 'blank secret field keeps saved key');
  assert.strictEqual(kept.pass, 'UNIQUE_PASSWORD_SECRET', 'blank secret field keeps saved password');
  assert.strictEqual(W.store['runlog.ftok'], 'TOKEN_STAYS',
                     'unrelated settings edit preserves a valid FitTrackee token');

  // An aborted request must release the upload mutex so a retry can start.
  W.store['runlog.runs'] = JSON.stringify([{
    name: 'Abort test', start: 1750000000000, sid: 77, act: 0,
    dist: 100, dur: 30, mov: 30, avgp: 300, avgHr: 0, maxHr: 0,
    egain: 0, steps: 0, up: 0,
    pts: [[1750000000,-31.95,115.85,'',0,0,0],
          [1750000030,-31.95,115.851,'',0,0,0]]
  }]);
  W.store['runlog.cfg'] = JSON.stringify({ preset: 'custom', url: 'https://abort.test/up' });
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', id: 77 })) });
  assert.strictEqual(W.xhrs.length, 1, 'first upload started');
  W.xhrs[0].abort();
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', id: 77 })) });
  assert.strictEqual(W.xhrs.length, 2, 'upload can retry after abort');
  W.xhrs[1].respond(201);

  var C = makeWorld();
  C.store['runlog.runs'] = '{malformed';
  C.boot(); C.fire('ready', {});
  assert.strictEqual(C.store['runlog.runs'], '{malformed', 'corrupt primary is never treated as empty');
  assert.strictEqual(C.store['runlog.runs.corrupt'], '{malformed', 'raw malformed copy is retained');
  C.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'clear' })) });
  assert.deepStrictEqual(storedRuns(C), [], 'explicit clear can unblock a corrupt store');
  assert(!C.store['runlog.runs.corrupt'], 'explicit clear removes the raw backup');
  console.log('scenario 21 (hostile page data, secrets, corruption, XHR abort) OK');
})();

/* =======================================================================
 * Scenario 22: HR average is weighted by source time, not GPS point count.
 * ===================================================================== */
(function scenario22() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var t0 = 1751000000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { CMD: 1 } });
  W.fire('appmessage', { payload: { HR: 100, SAMPLET: t0 } });
  var w = makeWalker(W, t0, -31.95, 115.85);
  var i;
  for (i = 0; i < 12; i++) {
    w.step(3, 5, 20);
    W.fire('appmessage', { payload: { HR: 100, SAMPLET: t0 + (i + 1) * 5 } });
  }
  W.fire('appmessage', { payload: { HR: 180, SAMPLET: t0 + 60 } });
  for (i = 0; i < 10; i++) {
    w.step(3, 3, 20);
    W.fire('appmessage', { payload: { HR: 180, SAMPLET: t0 + 60 + (i + 1) * 3 } });
  }
  W.fire('appmessage', { payload: { CMD: 4 } });
  var r = storedRuns(W)[0];
  assert(r.avgHr >= 125 && r.avgHr <= 129,
         '60 s @100 + 30 s @180 is time-weighted to ~127, got ' + r.avgHr);
  assert.strictEqual(r.maxHr, 180, 'peak comes from watch samples, not GPS density');
  console.log('scenario 22 (time-weighted HR) OK');
})();

/* =======================================================================
 * Scenario 23: malformed GPS fields and clocks cannot poison the route.
 * ===================================================================== */
(function scenario23() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var t0 = 1751100000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { CMD: 1 } });

  function fix(sec, lat, lon, acc, alt, stamp) {
    W.clockMs = sec * 1000;
    W.geoCb({
      timestamp: stamp === undefined ? sec * 1000 : stamp,
      coords: { latitude: lat, longitude: lon, accuracy: acc, altitude: alt }
    });
  }
  fix(t0 + 1, -31.95, 115.85, -1, 20);       // negative accuracy
  fix(t0 + 2, 91, 115.85, 8, 20);            // invalid latitude
  fix(t0 + 3, -31.95, 181, 8, 20);           // invalid longitude
  fix(t0 + 5, -31.95, 115.85, 8, 20);        // first valid anchor
  fix(t0 + 6, -31.95, 115.8502, 8, 20, (t0 + 5) * 1000); // duplicate source time
  fix(t0 + 10, 20, 20, 8, 20, (t0 + 3600) * 1000); // future-dated spatial outlier
  fix(t0 + 15, -31.95, 115.8503, 8, Infinity);      // normal fix after it
  W.fire('appmessage', { payload: { CMD: 4 } });

  var r = storedRuns(W)[0];
  assert.strictEqual(r.pts.length, 2, 'only valid, ordered, non-outlier fixes are stored');
  assert.strictEqual(r.pts[1][3], '', 'non-finite altitude becomes missing, not NaN');
  assert(r.dur < 60 && r.mov <= 20, 'future outlier did not pin the monotonic clock');
  assert(!/NaN|Infinity/.test(JSON.stringify(r)), 'stored numeric fields remain finite and serializable');
  assert.strictEqual(lastWith(W, 'SAVED').SAVED, 1, 'normal fixes still save after hostile input');
  console.log('scenario 23 (GPS validation and timestamp commit ordering) OK');
})();

/* =======================================================================
 * Scenario 24: Hike is end-to-end and its explicitly selected fixed profile reduces
 * watch-bound telemetry and route density. A long manual pause releases GPS,
 * while resume reacquires it and starts a new segment.
 * ===================================================================== */
(function scenario24() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var t0 = 1751200000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { MODE: 3, AUTOP: 1, SPLITP: 1 } });
  assert.strictEqual(JSON.parse(W.store['runlog.set']).mode, 3, 'Hike mode stored');
  W.fire('appmessage', { payload: { CMD: 1 } });
  assert.strictEqual(W.geoOptions[W.geoOptions.length - 1].frequency, 2000,
                     'Hike requests the current Core bridge at two-second intervals');
  W.fire('appmessage', { payload: { HR: 118, STEPS: 0, SAMPLET: t0 } });
  W.msgs = [];

  var w = makeWalker(W, t0, -31.95, 115.85);
  var steps = 0, i;
  for (i = 1; i <= 10; i++) {
    w.step(0.55, 5, 20 + i);   // steep-hike speed: above Hike's 0.30 m/s pause gate
    if (i % 6 === 0) {
      steps += 48;
      W.fire('appmessage', { payload: {
        HR: 118 + i, STEPS: steps, SAMPLET: t0 + i * 5
      } });
    }
  }
  assert(!msgsWith(W, 'APAUSE').some(function (m) { return m.APAUSE === 1; }),
         'slow genuine hiking does not false-pause');

  W.fire('appmessage', { payload: { CMD: 2 } });
  assert(W.timers.some(function (t) { return t.delay === 60000; }),
         'manual Hike pause arms one-minute GPS grace');
  var stops = W.geoStops;
  W.flushTimers();
  assert.strictEqual(W.geoStops, stops + 1, 'long manual Hike pause releases GPS');
  assert.strictEqual(lastWith(W, 'GPSOK').GPSOK, 0, 'watch is told GPS was released');

  var starts = W.geoStarts;
  W.fire('appmessage', { payload: { CMD: 3 } });
  assert.strictEqual(W.geoStarts, starts + 1, 'Hike resume reacquires GPS');
  for (i = 11; i <= 25; i++) {
    w.step(1.1, 5, 30 + i);
    if (i % 6 === 0) {
      steps += 48;
      W.fire('appmessage', { payload: {
        HR: 125, STEPS: steps, SAMPLET: t0 + i * 5
      } });
    }
  }

  var liveN = msgsWith(W, 'DIST').length;
  assert(liveN >= 3 && liveN <= 5,
         'Hike sends roughly one live snapshot per 30 s, got ' + liveN);
  W.fire('appmessage', { payload: { CMD: 4, HR: 125, STEPS: steps } });
  var hike = storedRuns(W)[0];
  assert.strictEqual(hike.act, 3, 'saved activity is Hike');
  assert(/_hike$/.test(hike.name), 'Hike name template: ' + hike.name);
  assert.strictEqual(hike.pts.length, 13,
                     'Hike stores the clean route at its reduced point cadence');
  assert(hike.dist >= 95 && hike.dist <= 105,
         'sparser Hike route preserves genuine slow distance, got ' + hike.dist + ' m');
  assert(hike.pts.some(function (p) { return p[5] === 1; }),
         'resume is preserved as an export segment boundary');
  assert(hike.cad > 0, 'Hike keeps foot cadence');

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({
    act: 'cfg', cfg: { preset: 'fittrackee', url: 'https://ft.hike.test',
                       key: 'hike-token', auth: '', user: '', pass: '' }
  })) });
  W.fire('appmessage', { payload: { CMD: 7 } });
  assert.strictEqual(W.xhrs.length, 1, 'Hike upload started');
  assert(W.xhrs[0].body.indexOf('{"sport_id":3}') >= 0, 'FitTrackee Hiking sport id');
  assert(W.xhrs[0].body.indexOf('<type>hiking</type>') >= 0, 'uploaded GPX is hiking');
  console.log('scenario 24 (Hike mode and fixed power profile) OK');
})();

/* =======================================================================
 * Scenario 25: Run and Ride remain predictable beyond one hour: live stats,
 * health freshness and accuracy reporting never silently change cadence.
 * Every manual-pause mode gets the GPS release grace.
 * ===================================================================== */
(function scenario25() {
  function exercise(act, label, speed, testPause) {
    var W = makeWorld(); W.boot(); W.fire('ready', {});
    var t0 = 1751300000 + act * 10000;
    W.clockMs = t0 * 1000;
    W.fire('appmessage', { payload: { MODE: act, AUTOP: 0, SPLITP: 0 } });
    W.fire('appmessage', { payload: { CMD: 1 } });
    assert(W.store['runlog.inprogress'], label + ' checkpoint created');
    assert.strictEqual(W.intervalCalls, 0,
                       label + ' uses no fixed polling intervals');
    assert.strictEqual(W.store['runlog.inprogress.live'], undefined,
                       label + ' full checkpoint is not followed by a duplicate heartbeat write');

    var w = makeWalker(W, t0, -31.95, 115.85);
    for (var i = 0; i < 6; i++) w.step(speed, 5, 20, 8);
    assert.strictEqual(msgsWith(W, 'DIST').length, 6,
                       label + ' starts with five-second live updates');

    // Advance the same continuous session beyond one hour without fabricating
    // distance; elapsed time must not change the selected mode's power profile.
    w.step(0, 3575, 20, 8);
    W.msgs = [];
    for (i = 0; i < 12; i++) w.step(speed, 5, 20, i % 2 ? 8 : 10);
    var live = msgsWith(W, 'DIST');
    assert.strictEqual(live.length, 12,
                       label + ' retains five-second live updates beyond one hour');
    assert.strictEqual(msgsWith(W, 'ACC').length, 12,
                       label + ' retains its normal accuracy reporting beyond one hour');

    if (testPause) {
      W.fire('appmessage', { payload: { CMD: 2 } });
      assert(W.timers.some(function (t) { return t.delay === 60000; }),
             label + ' manual pause gets a one-minute GPS grace');
      var stops = W.geoStops;
      W.flushTimers();
      assert.strictEqual(W.geoStops, stops + 1,
                         label + ' long manual pause releases GPS');
      var starts = W.geoStarts;
      W.fire('appmessage', { payload: { CMD: 3 } });
      assert.strictEqual(W.geoStarts, starts + 1,
                         label + ' resume reacquires GPS');
      w.step(speed, 5, 20, 8);
    }

    W.fire('appmessage', { payload: { CMD: 4 } });
    var saved = storedRuns(W)[0];
    assert.strictEqual(saved.act, act, label + ' type preserved');
    assert(saved.pts.length >= 19 + (testPause ? 1 : 0),
           label + ' keeps accepted GPS points beyond one hour');
  }

  exercise(0, 'Run', 3.0, true);
  exercise(2, 'Ride', 8.0, true);
  console.log('scenario 25 (fixed hour-plus behavior and all-mode pause GPS release) OK');
})();


/* =======================================================================
 * 26 — validated HR peak, per-run HR settings, recorded activity on the wire
 * ===================================================================== */
(function scenario26() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var t0 = 1751400000;
  W.clockMs = t0 * 1000;

  // Max HR 200 while recording; changed to 150 afterwards. Retyping the run must
  // NOT rescale its VO2max against the new setting.
  W.fire('appmessage', { payload: { MODE: 0, AUTOP: 0, SPLITP: 0, MHR: 200, RHR: 50 } });
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, t0, -31.95, 115.85);

  // Steady 3 m/s, long enough to clear the two-minute warm-up cut and reach the
  // 20-point minimum the estimator needs. HR is the watch's smoothed mean; HRPK
  // is the corroborated raw peak. A lone sensor spike is rejected on-watch,
  // while a real adjacent-sample peak can still exceed the display mean.
  var i;
  for (i = 0; i < 90; i++) {
    W.fire('appmessage', { payload: { HR: 160, HRPK: i >= 60 ? 186 : 160,
                                      STEPS: i * 8 } });
    w.step(3.0, 5, 20, 8);
  }
  W.fire('appmessage', { payload: { CMD: 4 } });

  var runs = storedRuns(W);
  assert.strictEqual(runs.length, 1, 'run saved');
  var run = runs[0];

  // --- the validated raw peak beats the smoothed stream ---
  assert.strictEqual(run.maxHr, 186,
    'maxHr comes from corroborated HRPK (186), not the smoothed 160');
  var summary = lastWith(W, 'SAVED');
  assert.strictEqual(summary.MAXHR, 186, 'watch summary carries the validated peak');

  // --- the watch is told which activity this actually was ---
  assert.strictEqual(summary.MODE, 0, 'summary carries the recorded activity');

  // --- HR settings are captured on the record ---
  assert.strictEqual(run.maxHrSet, 200, 'run records the max HR in force at the time');
  assert.strictEqual(run.restHrSet, 50, 'run records the resting HR in force at the time');
  var vo2 = run.vo2max;
  assert(vo2 > 0, 'a steady run produces a VO2max estimate (got ' + vo2 + ')');

  // --- change the setting, retype twice, confirm the estimate is unchanged ---
  W.fire('appmessage', { payload: { MHR: 150, RHR: 0 } });
  var id = run.sid || run.start;
  W.fire('webviewclosed', { response: JSON.stringify({ act: 'retype', id: id, to: 3 }) });
  var after = storedRuns(W)[0];
  assert.strictEqual(after.act, 3, 'retyped to hike');
  W.fire('webviewclosed', { response: JSON.stringify({ act: 'retype', id: after.sid || after.start, to: 0 }) });
  var back = storedRuns(W)[0];
  assert.strictEqual(back.act, 0, 'retyped back to run');
  assert.strictEqual(back.vo2max, vo2,
    'VO2max recomputes from the STORED max HR, so it survives a settings change (' +
    back.vo2max + ' vs original ' + vo2 + ')');

  console.log('scenario 26 (validated HR peak, per-run HR settings, summary MODE) OK');
})();

/* =======================================================================
 * 27 — Basic credentials are UTF-8, not 8-bit truncated
 * ===================================================================== */
(function scenario27() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var t0 = 1751500000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { MODE: 0, AUTOP: 0, SPLITP: 0 } });
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, t0, -31.95, 115.85);
  for (var i = 0; i < 6; i++) w.step(3.0, 5, 20, 8);
  W.fire('appmessage', { payload: { CMD: 4 } });

  // A password with non-ASCII characters, which is entirely ordinary outside the
  // English-speaking world, plus an emoji to exercise the surrogate-pair path.
  var user = 'j\u00f6rn';
  var pass = 'p\u00e4ssw\u00f6rd-\u65e5\u672c\u8a9e-\ud83d\ude80';
  W.fire('webviewclosed', { response: JSON.stringify({
    act: 'cfg',
    cfg: { preset: 'webdav', url: 'https://dav.test/runs/', auth: user + ':' + pass, authSet: 1 }
  }) });

  var run = storedRuns(W)[0];
  W.fire('webviewclosed', { response: JSON.stringify({ act: 'retry', id: run.sid || run.start }) });

  var req = W.xhrs[W.xhrs.length - 1];
  assert(req, 'an upload request was built');
  var hdr = req.headers.Authorization;
  assert(hdr && hdr.slice(0, 6) === 'Basic ', 'Basic scheme used');
  var decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  assert.strictEqual(decoded, user + ':' + pass,
    'credential round-trips as UTF-8 (RFC 7617); got ' + JSON.stringify(decoded));
  assert.strictEqual(Buffer.from(hdr.slice(6), 'base64').length,
                     Buffer.byteLength(user + ':' + pass, 'utf8'),
    'encoded length is the UTF-8 byte length, not one byte per UTF-16 unit');

  req.respond(201, '');
  assert.strictEqual(storedRuns(W)[0].up, 1, 'upload recorded as ok');

  // Malformed UTF-16 should never produce malformed UTF-8 on the wire. JavaScript
  // strings can contain a lone surrogate even though a normal keyboard cannot.
  var malformedUser = 'bad\ud800';
  W.fire('webviewclosed', { response: JSON.stringify({
    act: 'cfg',
    cfg: { preset: 'webdav', url: 'https://dav.test/runs/',
           auth: malformedUser + ':x', authSet: 1 }
  }) });
  W.fire('webviewclosed', { response: JSON.stringify({ act: 'retry', id: run.sid || run.start }) });
  var req2 = W.xhrs[W.xhrs.length - 1];
  var repaired = Buffer.from(req2.headers.Authorization.slice(6), 'base64').toString('utf8');
  assert.strictEqual(repaired, 'bad\ufffd:x', 'lone surrogate is replaced with U+FFFD');
  req2.respond(201, '');

  console.log('scenario 27 (UTF-8 Basic credentials) OK');
})();

/* =======================================================================
 * 28 — Endurain uses its least-privilege upload API key endpoint.
 * ===================================================================== */
(function scenario28() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var t0 = 1751600000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { MODE: 3, AUTOP: 0, SPLITP: 0 } });
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, t0, -31.95, 115.85);
  for (var i = 0; i < 8; i++) w.step(2.0, 5, 20 + i, 8);
  W.fire('appmessage', { payload: { CMD: 4 } });
  var run = storedRuns(W)[0];

  W.fire('webviewclosed', { response: JSON.stringify({
    act: 'cfg',
    cfg: {
      preset: 'endurain', url: 'https://endurain.home/runlog/api/v1/docs/',
      key: 'endurain_upload_only_123', keySet: 1, fmt: 'gpx'
    }
  }) });
  W.fire('webviewclosed', { response: JSON.stringify({
    act: 'retry', id: run.sid || run.start
  }) });

  var x = W.xhrs[W.xhrs.length - 1];
  assert.strictEqual(x.method, 'POST');
  assert.strictEqual(x.url, 'https://endurain.home/runlog/api/v1/activities/create/upload');
  assert.strictEqual(x.headers['X-API-Key'], 'endurain_upload_only_123');
  assert(!x.headers.Authorization && !x.headers['X-Client-Type'],
         'API-key upload needs neither bearer nor client-type headers');
  assert(/^multipart\/form-data; boundary=/.test(x.headers['Content-Type']));
  assert(x.body instanceof Uint8Array, 'Endurain text uploads use deterministic UTF-8 bytes');
  var gpxMultipart = Buffer.from(x.body);
  assert(gpxMultipart.indexOf(Buffer.from('name="file"')) >= 0 &&
         gpxMultipart.indexOf(Buffer.from('<gpx ')) >= 0,
         'Endurain receives the selected activity file as multipart');
  assert.strictEqual(x.timeout, 90000, 'synchronous Endurain import gets a long-file timeout');
  x.respond(202, '');
  assert.strictEqual(storedRuns(W)[0].up, 1, 'Endurain 202 is accepted as success');
  assert.strictEqual(storedRuns(W)[0].upMeta.dest, 'endurain', 'destination recorded');

  W.fire('webviewclosed', { response: JSON.stringify({
    act: 'cfg',
    cfg: {
      preset: 'endurain', url: 'https://endurain.home',
      key: '', keySet: 0, clearKey: 0, fmt: 'fit'
    }
  }) });
  W.fire('webviewclosed', { response: JSON.stringify({
    act: 'retry', id: run.sid || run.start
  }) });
  var xf = W.xhrs[W.xhrs.length - 1];
  assert.strictEqual(xf.headers['X-API-Key'], 'endurain_upload_only_123',
                     'blank settings key keeps the saved Endurain key');
  assert(xf.body instanceof Uint8Array, 'FIT multipart upload remains binary');
  var fitMultipart = Buffer.from(xf.body);
  assert(fitMultipart.indexOf(Buffer.from('filename="' + run.name + '.fit"')) >= 0 &&
         fitMultipart.indexOf(Buffer.from('.FIT')) >= 0,
         'Endurain FIT multipart contains the filename and FIT payload');
  xf.respond(201, '');
  assert.strictEqual(storedRuns(W)[0].upMeta.fmt, 'fit', 'successful FIT format recorded');

  W.fire('webviewclosed', { response: JSON.stringify({
    act: 'retry', id: run.sid || run.start
  }) });
  var xe = W.xhrs[W.xhrs.length - 1];
  xe.respond(403, JSON.stringify({ detail: 'API key lacks activities:upload scope' }));
  var elog = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(elog.some(function (m) {
    return /HTTP 403.*activities:upload scope/.test(m);
  }), 'Endurain response detail is visible in the phone log');

  console.log('scenario 28 (Endurain API-key upload) OK');
})();

/* =======================================================================
 * 29 — legacy migration is atomic; completed route chunks are independently
 * salvageable and an orphan left before the index commit is garbage-collected.
 * ===================================================================== */
(function scenario29() {
  var pts = [], t0 = 1751700000, lat = -31.95, lon = 115.85;
  for (var i = 0; i < 205; i++) {
    pts.push([t0 + i * 5, lat, lon + i * 0.0001,
              20 + Math.min(i, 120) * 0.1, 145, 0, 166]);
  }
  var legacy = [{
    name: 'Legacy long hike', start: t0 * 1000, sid: 909090, act: 3,
    dist: 2100, dur: 1025, active: 1020, mov: 1020, avgp: 486,
    avgHr: 145, maxHr: 145, maxHrSet: 190, restHrSet: 0,
    hrArea: 147900, hrSecs: 1020, hrPeak: 145,
    egain: 12, cad: 166, steps: 2822, mi: 0, up: 0,
    splits: [], events: [[t0, 'start'], [t0 + 1025, 'stop']], pts: pts
  }];
  var legacyRaw = JSON.stringify(legacy);

  var F = makeWorld();
  F.store['runlog.runs'] = legacyRaw;
  F.failStore = function (k) { return k.indexOf('runlog.j.') === 0; };
  F.boot(); F.fire('ready', {});
  assert.strictEqual(F.store['runlog.runs'], legacyRaw,
                     'failed migration leaves the byte-for-byte legacy store authoritative');
  assert.strictEqual(Object.keys(F.store).filter(function (k) {
    return k.indexOf('runlog.j.') === 0;
  }).length, 0, 'failed migration removes partial new chunks');

  var W = makeWorld();
  W.store['runlog.runs'] = legacyRaw;
  W.store['runlog.j.orphan.0'] = 'uncommitted';
  W.boot(); W.fire('ready', {});
  var index = JSON.parse(W.store['runlog.runs']);
  assert(index[0]._j && !index[0].pts && index[0]._j.chunks === 3,
         'legacy route migrated to a three-chunk lightweight index');
  assert.strictEqual(storedRuns(W)[0].pts.length, 205, 'migration round-trips every point');
  assert(storedRuns(W)[0].analysis && storedRuns(W)[0].analysis.pacing,
         'migration backfills post-workout analysis');
  assert.strictEqual(storedRuns(W)[0].analysis.climbs.count, 1,
                     'sustained climb is detected from the smoothed legacy track');
  assert(!W.store['runlog.j.orphan.0'], 'uncommitted orphan chunk garbage-collected');

  var lastKey = 'runlog.j.' + index[0]._j.id + '.2';
  W.store[lastKey] = '{"v":1,"broken"';
  W.fire('showConfiguration', {});
  var page = openedHtml(W.opened[W.opened.length - 1]);
  assert(page.indexOf('"journalWarning":{"damaged":1,"expected":205,"recovered":192}') >= 0,
         'detail reports a damaged final chunk and the exact salvaged prefix');
  assert(page.indexOf('"ptb":"') >= 0 && page.indexOf('"ptn":192') >= 0 &&
         page.indexOf('"name":"Legacy long hike"') >= 0,
         'one damaged chunk cannot erase the otherwise usable workout');

  console.log('scenario 29 (atomic migration and chunk salvage) OK');
})();

/* =======================================================================
 * 30 — the first phone WebView contains a very long activity without dropping
 * a point. Expanding a row must not require an unsupported close/reopen cycle.
 * ===================================================================== */
(function scenario30() {
  var W = makeWorld(), pts = [], t0 = 1751800000, sid = 303030;
  for (var i = 0; i < 12000; i++) {
    pts.push([t0 + i * 5, +(-31.95 + (i % 200) / 1e6).toFixed(6),
              +(115.85 + i * 0.000012).toFixed(6),
              +(20 + (i % 40) / 10).toFixed(1),
              130 + (i % 20), i === 6000 ? 1 : 0, 108 + (i % 4)]);
  }
  W.store['runlog.runs'] = JSON.stringify([{
    name: 'Long hike', start: t0 * 1000, sid: sid, act: 3,
    dist: 144000, dur: 60000, active: 59800, mov: 59800, avgp: 415,
    avgHr: 139, maxHr: 149, maxHrSet: 190, restHrSet: 0,
    hrArea: 8312200, hrSecs: 59800, hrPeak: 149,
    egain: 900, cad: 110, steps: 109633, mi: 0, up: 0,
    hrv: { pre: { rmssd: 50 } }, pts: pts
  }]);
  W.boot(); W.fire('ready', {});
  W.fire('showConfiguration', {});

  var url = W.opened[W.opened.length - 1];
  assert(url.indexOf('data:text/html;charset=utf-8,') === 0,
         'phone receives one self-contained settings page');
  assert(url.length < 900000,
         'twelve-thousand-point detail stays below the known webview danger size');
  assert(url.length < encodeURIComponent(JSON.stringify(pts)).length,
         'complete detail page is smaller than percent-encoding the raw route alone');

  var page = openedHtml(url);
  var begin = page.indexOf('var RUNS = ') + 'var RUNS = '.length;
  var end = page.indexOf(';\nvar CFG', begin);
  var injected = JSON.parse(page.slice(begin, end))[0];
  assert(!injected.pts && injected.ptn === pts.length && injected.ptb,
         'every route sample is carried in the initial page as packed data');
  assert(!injected.hrv, 'retired health metadata is removed during migration');

  var restored = unpackPagePoints(injected);
  assert.deepStrictEqual(restored, pts,
                         'page-side expansion reproduces every stored sample losslessly');

  console.log('scenario 30 (single-page lossless long-activity detail) OK');
})();

/* =======================================================================
 * 31 — protocol-v3 watch journal: batches are durably ACKed, duplicate flushes
 * deduplicate, and a phone that missed START reconstructs an honest route-less
 * workout (including HR, steps and a manual lap) from STOP's full snapshot.
 * ===================================================================== */
(function scenario31() {
  var W = makeWorld(), sid = 313131, t0 = 1752000000;
  W.clockMs = (t0 + 180) * 1000;
  W.boot(); W.fire('ready', {});
  function rec(at, active, hr, peak, steps, state, lap) {
    return [at&255,(at>>>8)&255,(at>>>16)&255,(at>>>24)&255,
            active&255,(active>>>8)&255,hr,peak,
            steps&255,(steps>>>8)&255,(steps>>>16)&255,(state&7)|(lap?128:0)];
  }
  var bytes = [].concat(rec(t0,0,125,125,0,1,0),
                        rec(t0+60,60,135,138,300,1,0),
                        rec(t0+120,120,145,148,620,1,1),
                        rec(t0+180,180,150,152,900,3,0));
  var flush = { PROTO:3, SID:sid, STARTTS:t0, ACTIVE:180, WSTATE:3,
                WSAMPLES:bytes, WSFLUSH:1, DQ:1 };
  W.fire('appmessage', { payload: flush });
  assert.strictEqual(lastWith(W, 'WSACK').WSACK, t0 + 180,
                     'flush ACK covers the last durably stored sample');
  W.fire('appmessage', { payload: flush });              // retry before ACK reached watch
  var pm = JSON.parse(W.store['runlog.prew.' + sid + '.meta']);
  assert.strictEqual(pm.n, 4, 'repeated flush does not duplicate samples');
  assert.strictEqual(pm.dq, 1, 'durable journal metadata retains the watch data-quality warning');

  W.fire('appmessage', { payload: { PROTO:3, SID:sid, SEQ:7, CMD:4,
    WSTATE:3, STARTTS:t0, ACTIVE:180, STEPS:900, MODE:0, DQ:0 } });
  var r = storedRuns(W)[0];
  assert(r && r.route === 0, 'missed START is reconstructed as route-less');
  assert.strictEqual(r.dist, 0, 'journal reconstruction invents no distance');
  assert.strictEqual(r.steps, 900, 'journal reconstruction retains steps');
  assert.strictEqual(r.dq, 1, 'reconstructed workout retains the earlier data-quality warning');
  assert(r.avgHr >= 135 && r.avgHr <= 150 && r.maxHr === 152,
         'journal reconstruction derives HR average and corroborated peak');
  assert.strictEqual(r.laps.length, 1, 'manual lap marker survives disconnection');
  assert(r.events.some(function (e) { return e[1] === 'lap'; }), 'manual lap is in lifecycle journal');
  assert.strictEqual(lastWith(W, 'ROUTE').ROUTE, 0, 'watch summary explicitly says no route');
  console.log('scenario 31 (durable sensor journal and route-less reconstruction) OK');
})();

/* =======================================================================
 * 32 — converting AUTO-PAUSE to manual pause is atomic on the phone: PAUSE
 * clears the auto flag without a resume event or a fake active segment.
 * ===================================================================== */
(function scenario32() {
  var W = makeWorld(), sid = 323232, t0 = 1752100000;
  W.clockMs = t0 * 1000; W.boot(); W.fire('ready', {});
  W.fire('appmessage', { payload: { MODE:0, AUTOP:1, PROTO:3, SID:sid,
    SEQ:1, CMD:1, WSTATE:1, STARTTS:t0, ACTIVE:0 } });
  var w = makeWalker(W, t0, -31.95, 115.85);
  for (var i = 0; i < 6; i++) w.step(2.5, 5, 8);
  w.step(0.2, 5, 8); w.step(0.2, 5, 8); w.step(0.2, 5, 8); w.step(0.2, 5, 8);
  assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 1, 'fixture reached auto-pause');
  var before = lastWith(W, 'ACTIVE').ACTIVE;
  W.fire('appmessage', { payload: { PROTO:3, SID:sid, SEQ:2, CMD:2,
    WSTATE:2, APAUSE:0, STARTTS:t0, ACTIVE:before } });
  var manual = lastWith(W, 'ACK');
  assert.strictEqual(manual.APAUSE, 0, 'manual pause clears auto-pause flag');
  assert.strictEqual(manual.WSTATE, 2, 'session remains paused throughout conversion');
  assert.strictEqual(manual.ACTIVE, before, 'conversion does not add fake active time');
  W.fire('appmessage', { payload: { PROTO:3, SID:sid, SEQ:3, CMD:4,
    WSTATE:3, STARTTS:t0, ACTIVE:before } });
  var ev = storedRuns(W)[0].events.map(function (x) { return x[1]; });
  var ai = ev.indexOf('auto_pause'), pi = ev.indexOf('pause');
  assert(ai >= 0 && pi === ai + 1, 'manual pause directly follows auto-pause');
  assert(ev.slice(ai, pi + 1).indexOf('resume') < 0 && ev.slice(ai, pi + 1).indexOf('auto_resume') < 0,
         'no hidden resume segment is created');
  console.log('scenario 32 (atomic auto-to-manual pause) OK');
})();

/* =======================================================================
 * 33 — workout targets migrate independently of upload settings and are sent
 * to the watch in canonical seconds/metres values only when changed.
 * ===================================================================== */
(function scenario33() {
  var W = makeWorld(); W.boot(); W.fire('ready', {}); W.msgs.length = 0;
  W.fire('webviewclosed', { response: JSON.stringify({ act:'cfg', cfg:{
    preset:'custom', url:'', name:'', fmt:'gpx', target:{type:4,lo:300,hi:330,value:0}
  } }) });
  var m = lastWith(W, 'TGTYPE');
  assert(m && m.PROTO === 3 && m.TGTYPE === 4 && m.TGLO === 300 && m.TGHI === 330,
         'changed pace target is synchronised in canonical seconds/km');
  var c = JSON.parse(W.store['runlog.cfg']);
  assert.deepStrictEqual(c.target, {type:4,lo:300,hi:330,value:0}, 'target persists with config');
  W.msgs.length = 0;
  W.fire('webviewclosed', { response: JSON.stringify({ act:'cfg', cfg:{
    preset:'custom', url:'https://new.test', name:'', fmt:'tcx', target:c.target
  } }) });
  assert.strictEqual(lastWith(W, 'TGTYPE'), null,
                     'unrelated export edit creates no unnecessary target radio message');
  console.log('scenario 33 (target configuration and radio discipline) OK');
})();

/* =======================================================================
 * 34 — bidirectional watch settings survive disconnected/stale HELLO packets.
 * Phone edits clear only after a complete watch echo; an explicit local watch
 * edit supersedes an older pending phone value and receives its own full ACK.
 * ===================================================================== */
(function scenario34() {
  var W = makeWorld(); W.boot(); W.fire('ready', {}); W.msgs.length = 0;
  var changed = {mi:true,ap:false,splits:false,maxHr:185,restHr:50,zone:false};
  W.fire('webviewclosed', { response: JSON.stringify({ act:'cfg', cfg:{
    preset:'custom', url:'', name:'', fmt:'gpx', target:{type:0,lo:0,hi:0,value:0},
    watch:changed
  } }) });
  var m = lastWith(W, 'CFGSET');
  assert(m && m.CFGSET === 1 && m.UNITS === 1 && m.AUTOP === 0 &&
         m.SPLITP === 0 && m.MHR === 185 && m.RHR === 50 && m.HRZONE === 0,
         'all phone-managed watch settings share one protected sync packet');
  var stored = JSON.parse(W.store['runlog.set']);
  assert.strictEqual(stored.pending, true, 'unconfirmed phone edit is durable');

  W.msgs.length = 0;
  W.fire('appmessage', { payload:{HELLO:1,PROTO:3,SID:0,SEQ:0,WSTATE:0,
    UNITS:0,AUTOP:1,SPLITP:1,MODE:0,MHR:190,RHR:0,HRZONE:1} });
  stored = JSON.parse(W.store['runlog.set']);
  assert(stored.mi && !stored.ap && !stored.splits && stored.maxHr === 185 &&
         stored.restHr === 50 && !stored.zone && stored.pending,
         'stale watch HELLO cannot overwrite a pending phone edit');
  assert(lastWith(W, 'CFGSET'), 'pending settings are retried during reconciliation');

  W.msgs.length = 0;
  W.fire('appmessage', { payload:{HELLO:1,PROTO:3,SID:0,SEQ:0,WSTATE:0,
    UNITS:1,AUTOP:0,SPLITP:0,MODE:0,MHR:185,RHR:50,HRZONE:0} });
  stored = JSON.parse(W.store['runlog.set']);
  assert.strictEqual(stored.pending, false, 'matching complete watch snapshot acknowledges settings');
  assert.strictEqual(lastWith(W, 'CFGSET'), null, 'acknowledged settings stop consuming radio packets');

  W.msgs.length = 0;
  W.fire('webviewclosed', { response: JSON.stringify({ act:'cfg', cfg:{
    preset:'custom', url:'', name:'', fmt:'tcx', target:{type:0,lo:0,hi:0,value:0},
    watch:changed
  } }) });
  assert.strictEqual(lastWith(W, 'CFGSET'), null,
                     'unrelated export edit does not resend unchanged watch settings');

  // Queue another phone edit, then make a newer change directly on the watch.
  // CFGSET=2 identifies that deliberate local edit; it must not be overwritten
  // by the stale phone snapshot still marked pending.
  var stalePhone = {mi:true,ap:false,splits:true,maxHr:180,restHr:48,zone:false};
  W.fire('webviewclosed', { response: JSON.stringify({ act:'cfg', cfg:{
    preset:'custom', url:'', name:'', fmt:'tcx', target:{type:0,lo:0,hi:0,value:0},
    watch:stalePhone
  } }) });
  assert.strictEqual(JSON.parse(W.store['runlog.set']).pending, true,
                     'second disconnected phone edit is pending');

  // A partial packet carrying the local-edit marker is not authoritative. It
  // must neither discard the pending phone snapshot nor receive a false ACK.
  W.msgs.length = 0;
  W.fire('appmessage', { payload:{HELLO:1,CFGSET:2,PROTO:3,SID:0,SEQ:0,WSTATE:0,
    UNITS:0,AUTOP:1,MODE:0} });
  stored = JSON.parse(W.store['runlog.set']);
  assert.deepStrictEqual(stored,
    {mi:true,ap:false,splits:true,mode:0,maxHr:180,restHr:48,zone:false,pending:true},
    'incomplete watch-local snapshot is ignored and phone edit remains pending');
  assert.strictEqual(W.msgs.some(function (x) { return x.CFGSET === 2; }), false,
                     'incomplete watch-local snapshot receives no acceptance ACK');

  W.msgs.length = 0;
  W.fire('appmessage', { payload:{HELLO:1,CFGSET:2,PROTO:3,SID:0,SEQ:0,WSTATE:0,
    UNITS:2,AUTOP:1,SPLITP:0,MODE:0,MHR:300,RHR:52,HRZONE:1} });
  stored = JSON.parse(W.store['runlog.set']);
  assert.deepStrictEqual(stored,
    {mi:true,ap:false,splits:true,mode:0,maxHr:180,restHr:48,zone:false,pending:true},
    'complete but out-of-range watch-local snapshot is ignored');
  assert.strictEqual(W.msgs.some(function (x) { return x.CFGSET === 2; }), false,
                     'malformed watch-local snapshot receives no acceptance ACK');

  W.msgs.length = 0;
  W.fire('appmessage', { payload:{HELLO:1,CFGSET:2,PROTO:3,SID:0,SEQ:0,WSTATE:0,
    UNITS:0,AUTOP:1,SPLITP:0,MODE:0,MHR:188,RHR:52,HRZONE:1} });
  stored = JSON.parse(W.store['runlog.set']);
  assert.deepStrictEqual(stored,
    {mi:false,ap:true,splits:false,mode:0,maxHr:188,restHr:52,zone:true,pending:false},
    'newer watch edit supersedes the stale pending phone snapshot');
  var localAck = lastWith(W, 'CFGSET');
  assert(localAck && localAck.CFGSET === 2 && localAck.UNITS === 0 &&
         localAck.AUTOP === 1 && localAck.SPLITP === 0 && localAck.MHR === 188 &&
         localAck.RHR === 52 && localAck.HRZONE === 1,
         'phone explicitly acknowledges the complete watch-local snapshot');
  console.log('scenario 34 (durable bidirectional watch settings) OK');
})();

/* =======================================================================
 * 35 — tuned per-activity auto-pause profiles reject borderline slow motion,
 * require four genuinely slow observations, and debounce resume by mode.
 * ===================================================================== */
(function scenario35() {
  var profiles = [
    { act:0, name:'Run',  near:0.67, slow:0.50, fast:1.60, fastN:2 },
    { act:1, name:'Walk', near:0.50, slow:0.30, fast:1.00, fastN:2 },
    { act:2, name:'Ride', near:0.95, slow:0.70, fast:2.50, fastN:3 },
    { act:3, name:'Hike', near:0.40, slow:0.20, fast:0.80, fastN:3 }
  ];

  profiles.forEach(function (p) {
    var W = makeWorld();
    W.clockMs = (1752200000 + p.act * 1000) * 1000;
    W.boot(); W.fire('ready', {});
    W.fire('appmessage', { payload:{MODE:p.act,AUTOP:1,SPLITP:0} });
    W.fire('appmessage', { payload:{CMD:1} });
    var w = makeWalker(W, Math.round(W.clockMs / 1000), -31.95, 115.85);
    for (var i = 0; i < 5; i++) w.step(p.fast, 5, 8);
    W.msgs.length = 0;

    for (i = 0; i < 5; i++) w.step(p.near, 5, 8);
    assert.strictEqual(lastWith(W, 'APAUSE'), null,
                       p.name + ' keeps moving just above its tuned pause gate');

    // Slow evidence is consecutive: real movement in the middle must clear it.
    w.step(p.slow, 5, 8); w.step(p.slow, 5, 8); w.step(p.fast, 5, 8);
    w.step(p.slow, 5, 8); w.step(p.slow, 5, 8);
    assert.strictEqual(lastWith(W, 'APAUSE'), null,
                       p.name + ' resets slow evidence after real movement');

    // A stale GPS return is not stop evidence either. Valid but irregular fixes
    // below the 12 s freshness boundary still count as individual observations.
    w.step(p.slow, 20, 8);
    w.step(p.slow, 2, 8); w.step(p.slow, 8, 8); w.step(p.slow, 2, 8);
    assert.strictEqual(lastWith(W, 'APAUSE'), null,
                       p.name + ' ignores a stale gap plus three fresh slow observations');
    w.step(p.slow, 8, 8);
    assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 1,
                       p.name + ' pauses after four fresh, irregular slow observations');

    // The same stale-boundary rule applies while paused, so a movement fix
    // after an outage cannot resume the workout by itself.
    w.step(p.fast, 20, 8);
    for (i = 0; i < p.fastN - 1; i++) w.step(p.fast, i % 2 ? 8 : 2, 8);
    assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 1,
                       p.name + ' does not resume on insufficient movement evidence');
    w.step(p.fast, 8, 8);
    assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 0,
                       p.name + ' resumes after its full fast-fix debounce');
  });
  console.log('scenario 35 (tuned per-activity auto-pause profiles) OK');
})();

/* =======================================================================
 * 36 — Hike sampling preserves very slow progress, rejects gorge-quality
 * fixes, and treats uncertain back-and-forth multipath as stopped motion.
 * ===================================================================== */
(function scenario36() {
  var W = makeWorld(), t0 = 1752300000;
  W.clockMs = t0 * 1000; W.boot(); W.fire('ready', {});
  W.fire('appmessage', { payload:{MODE:3,AUTOP:0,SPLITP:0} });
  W.fire('appmessage', { payload:{CMD:1} });

  var lat = -31.95, lon = 115.85, east = 0, t = t0;
  var metresLon = 111320 * Math.cos(lat * Math.PI / 180);
  function fix(dt, eastM, northM, acc) {
    t += dt; W.clockMs = t * 1000;
    W.geoCb({ timestamp:t * 1000, coords:{
      latitude:lat + northM / 111320,
      longitude:lon + eastM / metresLon,
      accuracy:acc, altitude:20
    } });
  }

  // Establish a short real approach, then stand still while optimistic
  // 30-m fixes alternate by 16 m. This is below the Hike outlier speed gate,
  // so route cadence + Kalman smoothing—not a contrived rejection—must tame it.
  for (var i = 1; i <= 4; i++) { east = i * 3; fix(5, east, 0, 8); }
  for (i = 0; i < 24; i++) fix(5, east + (i % 2 ? -8 : 8), 0, 30);

  // Openly weak gorge fixes are ignored completely and cannot extend pause
  // evidence across the accuracy outage.
  for (i = 0; i < 12; i++) fix(5, east + (i % 2 ? -20 : 20), 0, 45);
  W.fire('appmessage', { payload:{CMD:4} });

  var hike = storedRuns(W)[0];
  assert.strictEqual(hike.act, 3, 'gorge fixture remains a Hike');
  assert(hike.pts.length >= 3 && hike.pts.length <= 10,
         'Hike thins uncertain stopped route points, got ' + hike.pts.length);
  assert(hike.dist <= 25,
         'stopped multipath adds little route distance, got ' + hike.dist + ' m');
  assert.strictEqual(lastWith(W, 'GPSOK').GPSOK, 0,
                     'watch reports the rejected 45 m gorge fixes as weak GPS');

  // The uncertainty dead-band is measured from the last retained point, not
  // from every incoming fix. A genuinely slow, consistent trail therefore
  // accumulates until it clears the floor instead of being starved forever.
  function slowHike(acc) {
    var S = makeWorld(), s0 = t0 + 1000 + acc;
    S.clockMs = s0 * 1000; S.boot(); S.fire('ready', {});
    S.fire('appmessage', { payload:{MODE:3,AUTOP:1,SPLITP:0} });
    S.fire('appmessage', { payload:{CMD:1} });
    var walker = makeWalker(S, s0, -31.95, 115.85);
    for (var j = 0; j < 180; j++) walker.step(0.35, 2, 20, acc);
    assert(!msgsWith(S, 'APAUSE').some(function (m) { return m.APAUSE === 1; }),
           '0.35 m/s Hike does not false-pause at ' + acc + ' m accuracy');
    S.fire('appmessage', { payload:{CMD:4} });
    var r = storedRuns(S)[0];
    assert(r.pts.length >= 15 && r.pts.length <= 40,
           'slow Hike remains sparse at ' + acc + ' m accuracy, got ' + r.pts.length + ' points');
    assert(r.dist >= 105 && r.dist <= 130,
           'slow Hike preserves ~123 m at ' + acc + ' m accuracy, got ' + r.dist + ' m');
  }
  slowHike(8);
  slowHike(20);

  // With auto-pause enabled, optimistic 30 m fixes alternating across a
  // stationary hiker must pause rather than masquerade as repeated fast legs.
  var A = makeWorld(), a0 = t0 + 2000;
  A.clockMs = a0 * 1000; A.boot(); A.fire('ready', {});
  A.fire('appmessage', { payload:{MODE:3,AUTOP:1,SPLITP:0} });
  A.fire('appmessage', { payload:{CMD:1} });
  var at = a0, ae = 0;
  function afix(dt, eastM, acc) {
    at += dt; A.clockMs = at * 1000;
    A.geoCb({ timestamp:at * 1000, coords:{
      latitude:lat, longitude:lon + eastM / metresLon,
      accuracy:acc, altitude:20
    } });
  }
  for (i = 1; i <= 5; i++) { ae = i * 4; afix(5, ae, 8); }
  A.msgs.length = 0;
  for (i = 0; i < 12; i++) afix(5, ae + (i % 2 ? -8 : 8), 30);
  assert.strictEqual(lastWith(A, 'APAUSE').APAUSE, 1,
                     'uncertain Hike reversals become sustained stop evidence');
  for (i = 0; i < 6; i++) afix(5, ae + (i % 2 ? -8 : 8), 30);
  afix(5, ae + 10, 30);               // one plausible-looking gorge burst
  afix(5, ae - 8, 30);                // reflection returns across the hiker
  assert.strictEqual(lastWith(A, 'APAUSE').APAUSE, 1,
                     'gorge oscillation and one burst cannot auto-resume');
  for (i = 1; i <= 5 && lastWith(A, 'APAUSE').APAUSE === 1; i++)
    afix(5, ae + i * 5, 8);
  assert.strictEqual(lastWith(A, 'APAUSE').APAUSE, 0,
                     'consistent accurate movement still auto-resumes');
  console.log('scenario 36 (Hike slow trail, gorge sampling and auto-pause) OK');
})();

/* =======================================================================
 * 37 — Current Core bridge profile: stale returns create route segments,
 * normalized-innovation rejection is atomic, and guarded receiver speed can
 * drive auto-pause without trusting coordinate jitter.
 * ===================================================================== */
(function scenario37() {
  var lat = -31.95, lon = 115.85;
  var metresLon = 111320 * Math.cos(lat * Math.PI / 180);

  function feeder(W, t0) {
    var t = t0;
    return function (dt, eastM, northM, acc, speed) {
      t += dt; W.clockMs = t * 1000;
      W.geoCb({ coords:{                         // current Core bridge supplies no timestamp
        latitude:lat + northM / 111320,
        longitude:lon + eastM / metresLon,
        accuracy:acc, altitude:20,
        speed:speed
      } });
    };
  }

  // A real callback outage must be a GPX segment break and must not add the
  // 100 m relocation across the unseen interval to distance or moving time.
  var G = makeWorld(), g0 = 1752400000;
  G.clockMs = g0 * 1000; G.boot(); G.fire('ready', {});
  G.fire('appmessage', { payload:{MODE:0,AUTOP:0,SPLITP:0} });
  G.fire('appmessage', { payload:{CMD:1} });
  var gf = feeder(G, g0);
  gf(1, 0, 0, 8, 3); gf(3, 9, 0, 8, 3); gf(3, 18, 0, 8, 3);
  gf(12, 118, 0, 8, 3);                    // beyond the 10 s stale boundary
  gf(3, 127, 0, 8, 3); gf(3, 136, 0, 8, 3);
  G.fire('appmessage', { payload:{CMD:4} });
  var gapRun = storedRuns(G)[0];
  assert.strictEqual(gapRun.pts.filter(function (p) { return p[5] === 1; }).length, 1,
                     'first point after a stale callback gap starts one new route segment');
  assert(gapRun.dist >= 28 && gapRun.dist <= 42,
         'stale gap adds only observed movement, not the 100 m relocation: ' + gapRun.dist + ' m');

  // A plausible-speed lateral jump can pass the physical speed cap but should
  // fail the covariance-aware innovation gate without poisoning the next fix.
  var I = makeWorld(), i0 = g0 + 1000;
  I.clockMs = i0 * 1000; I.boot(); I.fire('ready', {});
  I.fire('appmessage', { payload:{MODE:0,AUTOP:0,SPLITP:0} });
  I.fire('appmessage', { payload:{CMD:1} });
  var inf = feeder(I, i0), k;
  for (k = 0; k <= 10; k++) inf(1, k * 3, 0, 3, 3);
  inf(2, 36, 20, 3, 3);                    // ~10.4 m/s raw: plausible Run, bad innovation
  inf(1, 39, 0, 3, 3);                     // normal continuation must recover immediately
  I.fire('appmessage', { payload:{CMD:4} });
  var innovationRun = storedRuns(I)[0];
  var northSpan = innovationRun.pts.reduce(function (m, p) {
    return Math.max(m, Math.abs((p[1] - lat) * 111320));
  }, 0);
  assert(northSpan < 5, 'innovation-rejected lateral jump stays out of route: ' + northSpan + ' m');
  assert(msgsWith(I, 'GPSOK').some(function (m) { return m.GPSOK === 0; }) &&
         lastWith(I, 'GPSOK').GPSOK === 1,
         'watch sees rejected measurement then healthy GPS recovery');

  // Receiver speed is allowed only as guarded auto-pause evidence. Coordinate
  // jitter says ~0.8 m/s here, but Doppler speed 0 correctly identifies a stop;
  // two genuine 1.6 m/s readings then meet Run's normal resume debounce.
  var S = makeWorld(), s0 = g0 + 2000;
  S.clockMs = s0 * 1000; S.boot(); S.fire('ready', {});
  S.fire('appmessage', { payload:{MODE:0,AUTOP:1,SPLITP:0} });
  S.fire('appmessage', { payload:{CMD:1} });
  var sf = feeder(S, s0), anchor = 0;
  for (k = 1; k <= 5; k++) { anchor = k * 15; sf(5, anchor, 0, 8, 3); }
  S.msgs.length = 0;
  for (k = 0; k < 4; k++) sf(5, anchor + (k % 2 ? -2 : 2), 0, 8, 0);
  assert.strictEqual(lastWith(S, 'APAUSE').APAUSE, 1,
                     'zero receiver speed pauses despite moving coordinates');
  sf(5, anchor + 4, 0, 8, 1.6);
  assert.strictEqual(lastWith(S, 'APAUSE').APAUSE, 1,
                     'one receiver-speed observation cannot resume');
  sf(5, anchor + 8, 0, 8, 1.6);
  assert.strictEqual(lastWith(S, 'APAUSE').APAUSE, 0,
                     'two trustworthy receiver-speed observations resume Run');
  console.log('scenario 37 (Core GPS request, gaps, innovations and receiver speed) OK');
})();

/* =======================================================================
 * 38 — Phone-side start/end trimming rewrites the immutable route journal,
 * preserves pause segments, and rebuilds every route-derived aggregate.
 * ===================================================================== */
(function scenario38() {
  var W = makeWorld(), t0 = 1752500000, t = t0;
  var lat = -31.95, lon = 115.85, east = 0;
  var metresLon = 111320 * Math.cos(lat * Math.PI / 180);
  W.clockMs = t0 * 1000; W.boot(); W.fire('ready', {});
  W.fire('appmessage', { payload:{MODE:0,AUTOP:0,SPLITP:0} });
  W.fire('appmessage', { payload:{CMD:1} });

  function fix(n) {
    t += 5; east += 15; W.clockMs = t * 1000;
    W.fire('appmessage', { payload:{HR:120 + n * 3, STEPS:n * 12, SAMPLET:t} });
    W.geoCb({ timestamp:t * 1000, coords:{
      latitude:lat, longitude:lon + east / metresLon,
      accuracy:8, altitude:20 + n
    } });
  }
  for (var i = 1; i <= 7; i++) fix(i);
  W.fire('appmessage', { payload:{CMD:2} });
  t += 30; W.clockMs = t * 1000;
  W.fire('appmessage', { payload:{CMD:3} });
  for (i = 8; i <= 15; i++) fix(i);
  W.fire('appmessage', { payload:{CMD:4} });

  var original = storedRuns(W)[0];
  assert(original.pts.length >= 12, 'trim fixture has a useful route');
  assert(original.pts.some(function (p) { return p[5] === 1; }),
         'trim fixture contains a pause boundary');
  var rawIndex = JSON.parse(W.store['runlog.runs']);
  rawIndex[0].up = 1;                         // an uploaded copy must become stale
  W.store['runlog.runs'] = JSON.stringify(rawIndex);
  var oldJournal = rawIndex[0]._j.id;
  var first = 2, last = original.pts.length - 3;
  var expected = original.pts.slice(first, last + 1).map(function (p) { return p.slice(); });
  expected[0][5] = 0;
  var stableId = original.sid || original.start;
  W.fire('webviewclosed', { response:JSON.stringify({
    act:'trim', id:stableId, first:first, last:last
  }) });

  var trimmed = storedRuns(W)[0];
  assert.strictEqual(trimmed.pts.length, expected.length, 'only selected points remain');
  assert.strictEqual(JSON.stringify(trimmed.pts), JSON.stringify(expected),
                     'trim preserves retained measurements exactly');
  assert.strictEqual(trimmed.start, expected[0][0] * 1000,
                     'beginning trim updates activity start time');
  assert.strictEqual(trimmed.dur, expected[expected.length - 1][0] - expected[0][0],
                     'both cuts rebuild elapsed duration from retained boundaries');
  assert.strictEqual(trimmed.up, 3, 'uploaded activity is marked changed locally');
  assert(trimmed.steps > 0 && trimmed.steps < original.steps,
         'step aggregate is proportionally reduced');
  assert(trimmed.hrSecs > 0 && trimmed.avgHr > 0 && trimmed.maxHr < original.maxHr,
         'HR aggregates are rebuilt from retained samples');
  assert.strictEqual(trimmed.pts.filter(function (p) { return p[5] === 1; }).length, 1,
                     'pause boundary inside the kept range survives');

  var expectedDist = 0, expectedMov = 0;
  for (i = 1; i < expected.length; i++) {
    if (expected[i][5]) continue;
    expectedDist += (function (a, b) {
      var R = 6371000, rad = Math.PI / 180;
      var dLat = (b[1] - a[1]) * rad, dLon = (b[2] - a[2]) * rad;
      var q = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(a[1] * rad) * Math.cos(b[1] * rad) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
    })(expected[i - 1], expected[i]);
    expectedMov += Math.min(Math.max(expected[i][0] - expected[i - 1][0], 0), 20);
  }
  assert.strictEqual(trimmed.dist, Math.round(expectedDist),
                     'distance is rebuilt without bridging the pause');
  assert.strictEqual(trimmed.mov, Math.round(expectedMov),
                     'moving time is rebuilt without the paused interval');
  assert(trimmed.splits.length >= 1 && trimmed.analysis,
         'splits and post-workout analysis are regenerated');

  var newIndex = JSON.parse(W.store['runlog.runs']);
  assert.notStrictEqual(newIndex[0]._j.id, oldJournal,
                        'trim commits a new immutable route journal');
  assert(!Object.keys(W.store).some(function (k) {
    return k.indexOf('runlog.j.' + oldJournal + '.') === 0;
  }), 'superseded route chunks are removed only after commit');
  var committed = W.store['runlog.runs'];
  W.fire('webviewclosed', { response:JSON.stringify({
    act:'trim', id:stableId, first:0, last:0
  }) });
  assert.strictEqual(W.store['runlog.runs'], committed,
                     'invalid one-point trim cannot change storage');
  assert(JSON.parse(W.store['runlog.log']).some(function (e) {
    return /trimmed .* s \/ .* m/.test(e[1]);
  }), 'successful trim is logged');
  console.log('scenario 38 (phone-side activity trim and journal rewrite) OK');
})();

/* =======================================================================
 * 39 — an active HELLO is a coherent manual-refresh snapshot. The watch can
 * request it after a screen/wrist tap without adding a lifecycle command.
 * ===================================================================== */
(function scenario39() {
  var W = makeWorld(), sid = 393939, t0 = 1752600000;
  W.clockMs = t0 * 1000; W.boot(); W.fire('ready', {});
  W.fire('appmessage', { payload:{MODE:0,AUTOP:0,SPLITP:0} });
  W.fire('appmessage', { payload:{PROTO:3,SID:sid,SEQ:1,CMD:1,WSTATE:1,
                                  STARTTS:t0,ACTIVE:0,MODE:0} });
  var walk = makeWalker(W, t0, -31.95, 115.85);
  for (var i = 1; i <= 6; i++) {
    walk.step(2.8, 5, 24, 7);
    W.fire('appmessage', { payload:{PROTO:3,SID:sid,SAMPLET:t0 + i * 5,
                                    HR:142 + i,STEPS:i * 14} });
  }

  W.msgs.length = 0;
  W.fire('appmessage', { payload:{HELLO:1,PROTO:3,SID:sid,SEQ:1,WSTATE:1,
                                  ACTIVE:30,STARTTS:t0,HR:148,STEPS:84} });
  var snap = lastWith(W, 'DIST');
  assert(snap && snap.WSTATE === 1 && snap.SID === sid,
         'refresh reply is the protected canonical session state');
  ['PACE','EGLIVE','MOVLIVE','AVGHRLIVE','LAPN','LAPD','LAPT','LAPP',
   'GPSOK','ACC'].forEach(function (key) {
    assert(Object.prototype.hasOwnProperty.call(snap, key),
           'refresh snapshot includes ' + key);
  });
  assert(snap.DIST > 0 && snap.LAPD === snap.DIST && snap.GPSOK === 1 && snap.ACC === 7,
         'refresh snapshot values describe the current filtered workout');
  console.log('scenario 39 (screen-tap coherent live-stat refresh) OK');
})();

/* =======================================================================
 * 40 — Strava: refresh-token grant, async upload polling, duplicates,
 * token rotation, 401 renewal and settings-change resets.
 * ===================================================================== */
(function scenario40() {
  var W = makeWorld(); W.boot(); W.fire('ready', {});
  var t0 = 1752700000;
  W.clockMs = t0 * 1000;
  W.fire('appmessage', { payload: { MODE: 0, AUTOP: 0, SPLITP: 0 } });
  W.fire('appmessage', { payload: { CMD: 1 } });
  var w = makeWalker(W, t0, -31.95, 115.85);
  for (var i = 0; i < 8; i++) {
    w.step(3.0, 5, 20, 6);
    W.fire('appmessage', { payload: { HR: 140 + i } });
  }
  W.fire('appmessage', { payload: { CMD: 4 } });
  var run = storedRuns(W)[0], id = run.sid || run.start;
  function cfg(extra) {
    var c = { preset: 'strava', fmt: 'tcx', user: '4242', pass: 'csecret', passSet: 1,
              key: 'rt-pasted', keySet: 1 };
    for (var k in extra) c[k] = extra[k];
    W.fire('webviewclosed', { response: JSON.stringify({ act: 'cfg', cfg: c }) });
  }
  function retry() { W.fire('webviewclosed', { response: JSON.stringify({ act: 'retry', id: id }) }); }
  function last() { return W.xhrs[W.xhrs.length - 1]; }
  function logs() { return JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; }); }
  function tokenReply(at, rt) {
    return JSON.stringify({ access_token: at, refresh_token: rt,
                            expires_at: Math.round(W.clockMs / 1000) + 21600 });
  }

  cfg({});
  var n0 = W.xhrs.length;
  retry();
  var tr = last();
  assert.strictEqual(W.xhrs.length, n0 + 1, 'first upload starts with a token refresh');
  assert.strictEqual(tr.method, 'POST');
  assert.strictEqual(tr.url, 'https://www.strava.com/oauth/token');
  assert.strictEqual(tr.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.strictEqual(tr.body, 'client_id=4242&client_secret=csecret' +
                              '&grant_type=refresh_token&refresh_token=rt-pasted');
  tr.respond(200, tokenReply('at-1', 'rt-rotated'));
  assert.strictEqual(JSON.parse(W.store['runlog.strava']).rt, 'rt-rotated',
                     'rotated refresh token persisted');

  var up = last();
  assert.strictEqual(up.method, 'POST');
  assert.strictEqual(up.url, 'https://www.strava.com/api/v3/uploads');
  assert.strictEqual(up.headers.Authorization, 'Bearer at-1');
  assert(/^multipart\/form-data; boundary=/.test(up.headers['Content-Type']));
  assert(up.body instanceof Uint8Array, 'text upload sent as explicit UTF-8 bytes');
  var mp = Buffer.from(up.body).toString('utf8');
  assert(/name="data_type"\r\n\r\ntcx\r\n/.test(mp), 'data_type follows the export format');
  assert(/name="sport_type"\r\n\r\nRun\r\n/.test(mp), 'sport_type from activity');
  assert(mp.indexOf('name="external_id"\r\n\r\nrunlog-' + id + '.tcx\r\n') >= 0, 'external_id');
  assert(mp.indexOf('name="name"') < 0, 'default-template names are left to Strava');
  assert(mp.indexOf('<HeartRateBpm><Value>') >= 0, 'TCX carries heart rate');
  assert(mp.indexOf('name="data_type"') < mp.indexOf('name="file"'), 'fields precede the file');

  up.respond(201, JSON.stringify({ id_str: '9001', status: 'Your activity is still being processed.',
                                   error: null, activity_id: null }));
  assert.strictEqual(storedRuns(W)[0].up, 0, 'not marked uploaded while Strava processes');
  W.flushTimers();
  var poll = last();
  assert.strictEqual(poll.method, 'GET');
  assert.strictEqual(poll.url, 'https://www.strava.com/api/v3/uploads/9001');
  assert.strictEqual(poll.headers.Authorization, 'Bearer at-1');
  poll.respond(200, JSON.stringify({ id_str: '9001', status: 'Your activity is still being processed.' }));
  W.flushTimers();
  last().respond(200, JSON.stringify({ id_str: '9001', status: 'Your activity is ready.',
                                       activity_id: 555 }));
  var r1 = storedRuns(W)[0];
  assert.strictEqual(r1.up, 1, 'uploaded once Strava reports the activity');
  assert.strictEqual(r1.upMeta.dest, 'strava');
  assert.strictEqual(r1.upMeta.id, '555', 'Strava activity id recorded');
  assert(logs().some(function (m) { return /strava\.com\/activities\/555/.test(m); }),
         'activity link logged');
  assert.strictEqual(lastWith(W, 'EXPST').EXPST, 1, 'watch told upload succeeded');

  /* Re-upload: the cached access token is reused; a duplicate is success. */
  var n1 = W.xhrs.length;
  retry();
  assert.strictEqual(W.xhrs.length, n1 + 1, 'valid cached token: no refresh request');
  assert.strictEqual(last().url, 'https://www.strava.com/api/v3/uploads');
  last().respond(201, JSON.stringify({ id_str: '9002', activity_id: null, error: null }));
  W.flushTimers();
  last().respond(200, JSON.stringify({ id_str: '9002', activity_id: null,
    error: 'run.tcx duplicate of <a href=\'/activities/555\' target=\'_blank\'>Morning Run</a>' }));
  assert.strictEqual(storedRuns(W)[0].up, 1, 'duplicate counts as uploaded');
  assert.strictEqual(storedRuns(W)[0].upMeta.id, '555', 'duplicate keeps the existing id');

  /* A rejected access token is renewed once with the rotated refresh token. */
  retry();
  last().respond(401, JSON.stringify({ message: 'Authorization Error' }));
  var tr2 = last();
  assert.strictEqual(tr2.url, 'https://www.strava.com/oauth/token', '401 triggers a refresh');
  assert(/refresh_token=rt-rotated$/.test(tr2.body), 'refresh uses the rotated token');
  tr2.respond(200, tokenReply('at-2', 'rt-rotated'));
  assert.strictEqual(last().headers.Authorization, 'Bearer at-2', 'upload retried with new token');
  last().respond(201, JSON.stringify({ id_str: '9003', activity_id: 777 }));
  assert.strictEqual(storedRuns(W)[0].upMeta.id, '777', 'immediate activity id skips polling');

  /* Processing errors fail the upload and are logged. */
  retry();
  last().respond(201, JSON.stringify({ id_str: '9004' }));
  W.flushTimers();
  last().respond(200, JSON.stringify({ id_str: '9004', error: 'Time information is missing' }));
  assert.strictEqual(storedRuns(W)[0].up, 2, 'processing error marks the upload failed');
  assert(logs().some(function (m) { return /upload FAILED.*Time information is missing/.test(m); }),
         'Strava processing error is visible in the phone log');

  /* Unrelated edits and destination switches keep the grant; a new token resets it. */
  cfg({ fmt: 'gpx', pass: '', passSet: 0, key: '', keySet: 0 });
  assert.strictEqual(JSON.parse(W.store['runlog.strava']).rt, 'rt-rotated', 'format change keeps grant');
  cfg({ preset: 'intervals', fmt: 'gpx', pass: '', passSet: 0, key: '', keySet: 0 });
  cfg({ fmt: 'gpx', pass: '', passSet: 0, key: '', keySet: 0 });
  assert(W.store['runlog.strava'], 'switching destination and back keeps grant');
  retry();
  var mp2 = Buffer.from(last().body).toString('utf8');
  assert(/name="data_type"\r\n\r\ngpx\r\n/.test(mp2), 'GPX upload declares gpx');
  last().respond(201, JSON.stringify({ id_str: '9005', activity_id: 778 }));
  cfg({ key: 'rt-new', keySet: 1, pass: '', passSet: 0 });
  assert(!W.store['runlog.strava'], 'newly pasted refresh token discards the old grant');

  /* A dead refresh token fails cleanly with a hint. */
  retry();
  assert(/refresh_token=rt-new$/.test(last().body), 'fresh pasted token used');
  last().respond(400, JSON.stringify({ message: 'Bad Request' }));
  assert.strictEqual(storedRuns(W)[0].up, 2, 'refresh failure marks the upload failed');
  assert(logs().some(function (m) { return /strava token refresh FAILED \(HTTP 400\)/.test(m); }),
         'refresh failure logged');

  /* Missing credentials never hit the network. */
  cfg({ user: '', key: '', keySet: 0, pass: '', passSet: 0, clearPass: 1 });
  var n2 = W.xhrs.length;
  retry();
  assert.strictEqual(W.xhrs.length, n2, 'incomplete Strava settings do not upload');
  assert.strictEqual(lastWith(W, 'EXPST').EXPST, 2);
  console.log('scenario 40 (Strava upload, polling and token rotation) OK');
})();

console.log('\nALL PIPELINE TESTS PASSED');
