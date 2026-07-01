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
      watchPosition: function (cb) { W.geoCb = cb; return 1; },
      clearWatch: function () {}
    }
  };

  var localStorageStub = {
    getItem: function (k) { return (k in W.store) ? W.store[k] : null; },
    setItem: function (k, v) { W.store[k] = String(v); },
    removeItem: function (k) { delete W.store[k]; }
  };

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

  W.fire = function (name, e) {
    (W.listeners[name] || []).forEach(function (f) { f(e); });
  };
  W.install = function () {
    global.Pebble = Pebble;
    Object.defineProperty(globalThis, 'navigator',
      { value: navigatorStub, configurable: true, writable: true });
    global.localStorage = localStorageStub;
    global.XMLHttpRequest = XHR;
    global.setInterval = function () { return 0; };   // silence watchdog
    global.clearInterval = function () {};
    W.timers = [];
    global.setTimeout = function (fn) {
      var id = W.timers.length + 1;
      W.timers.push({ id: id, fn: fn });
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
    { mi: false, ap: true, splits: true, mode: 0, maxHr: 190, restHr: 0 }, 'watch settings persisted');

  W.clockMs = 1750000000000;
  W.fire('appmessage', { payload: { CMD: 1 } });
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

  var per = lastWith(W, 'PACE');
  assert(Math.abs(per.PACE - 300) <= 6, 'live pace ~5:00/km, got ' + per.PACE);
  assert(Math.abs(per.AVGP - 300) <= 6, 'avg pace ~5:00/km, got ' + per.AVGP);
  assert(per.EGAIN >= 8 && per.EGAIN <= 16, 'elev gain sane, got ' + per.EGAIN);
  var distBefore = lastWith(W, 'DIST').DIST;
  assert(Math.abs(distBefore - 1316) < 15, 'distance ~1316 m, got ' + distBefore);

  var accVals = msgsWith(W, 'ACC').map(function (m) { return m.ACC; });
  assert(accVals.length >= 3, 'accuracy changes reported (' + accVals.length + ')');
  assert(accVals.length <= 8, 'accuracy throttled (' + accVals.length + ' sends)');
  assert(accVals.indexOf(15) >= 0, 'wobble value seen');
  assert.strictEqual(accVals[accVals.length - 1], 8, 'settled back to 8');

  // ---- auto-pause: 3 slow fixes pause, 2 fast resume ----
  w.step(0.2, 5, 35); w.step(0.2, 5, 35);
  assert(!lastWith(W, 'APAUSE'), 'not paused after 2 slow fixes');
  w.step(0.2, 5, 35);
  var ap = lastWith(W, 'APAUSE');
  assert(ap && ap.APAUSE === 1, 'auto-paused after 3 slow fixes');

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
  assert(Math.abs(saved.AVGP - 300) <= 8, 'SAVED avg pace, got ' + saved.AVGP);
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

  var runs = JSON.parse(W.store['runlog.runs']);
  assert.strictEqual(runs.length, 1, 'one stored run');
  var r = runs[0];
  ['name', 'start', 'dist', 'dur', 'mov', 'avgp', 'avgHr', 'maxHr',
   'egain', 'cad', 'steps', 'mi', 'splits', 'up', 'pts'].forEach(function (k) {
    assert(k in r, 'run field ' + k);
  });
  assert(/^\d{4}-\d{2}-\d{2}_run$/.test(r.name), 'templated run name: ' + r.name);
  assert.strictEqual(r.up, 0, 'not uploaded yet');
  assert(r.cad >= 160 && r.cad <= 176, 'cadence ~168, got ' + r.cad);
  assert(r.pts[0].length === 7, 'points carry cadence column');
  assert(r.pts.some(function (p) { return p[6] > 150; }), 'per-point cadence recorded');
  assert(r.pts.some(function (p) { return p[5] === 1; }), 'segment break after auto-pause');

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
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 1, 'run marked uploaded');

  /* ---- manual re-upload (retry button), server fails ---- */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  assert.strictEqual(W.xhrs.length, 2, 'retry fired');
  W.xhrs[1].respond(500);
  exp = msgsWith(W, 'EXPST').map(function (m) { return m.EXPST; });
  assert.deepStrictEqual(exp, [0, 1, 0, 2], 'EXPST failure path');
  assert.strictEqual(lastWith(W, 'EXPERR').EXPERR, 500, 'failure reason sent to the watch');
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 2, 'run marked failed');

  var lg = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg.some(function (m) { return /GPS ok, accuracy 8 m/.test(m); }), 'gps logged');
  assert(lg.some(function (m) { return /^saved "\d{4}-\d{2}-\d{2}_run/.test(m); }), 'save logged');
  assert(lg.some(function (m) { return /upload -> custom example\.test/.test(m); }), 'attempt logged');
  assert(lg.some(function (m) { return /upload FAILED \(HTTP 500\)/.test(m); }), 'failure logged');

  /* ---- debrief page injection ---- */
  W.fire('showConfiguration', {});
  assert.strictEqual(W.opened.length, 2, 'page opened (once after save, once via gear)');
  var html = decodeURIComponent(W.opened[1].replace('data:text/html;charset=utf-8,', ''));
  assert(html.indexOf('__RUNLOG_') < 0, 'all placeholders replaced');
  assert(html.indexOf('var RUNS = [{') >= 0, 'runs injected');
  assert(/"name":"\d{4}-\d{2}-\d{2}_run/.test(html), "run name in page");
  assert(html.indexOf('var MILES = false') >= 0, 'units injected');
  assert(html.indexOf('var INITIAL = 0') >= 0, 'gear opens on the list view');
  assert(html.indexOf('"auth":"Bearer tok123"') >= 0, 'cfg injected');
  assert(html.indexOf('var LOGL = [[') >= 0, 'log injected into the page');

  // the auto-open after the save deep-links to that run
  var html0 = decodeURIComponent(W.opened[0].replace('data:text/html;charset=utf-8,', ''));
  assert(html0.indexOf('var INITIAL = ' + JSON.parse(W.store['runlog.runs'])[0].start) >= 0,
         'post-save page deep-links to the new run');

  /* ---- delete ---- */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'del', idx: 0 })) });
  assert.strictEqual(JSON.parse(W.store['runlog.runs']).length, 0, 'run deleted');

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
  var r = JSON.parse(W.store['runlog.runs'])[0];
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
  assert(/^https:\/\/dav\.test\/gpx\/\d{4}-\d{2}-\d{2}_run.*\.gpx$/.test(d.url), 'filename appended: ' + d.url);
  assert(!('X-Filename' in d.headers), 'no X-Filename on PUT');
  assert.strictEqual(b64dec(d.headers.Authorization.replace('Basic ', '')), 'kai:hunter2',
                     'user:pass auto-wrapped as Basic');
  d.respond(201);
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 1);

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
  assert(iv.body.indexOf('name="file"; filename="') >= 0 && /filename="\d{4}-\d{2}-\d{2}_run/.test(iv.body), 'multipart file field');
  assert(iv.body.indexOf('<gpx ') >= 0, 'gpx inside multipart');
  iv.respond(200);
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 1);

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
  assert(/^https:\/\/old\.test\/dav\/\d{4}-\d{2}-\d{2}_run.*\.gpx$/.test(lg.url), 'legacy URL + filename');
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

  var runs = JSON.parse(W.store['runlog.runs']);
  assert.strictEqual(runs.length, 1, 'recovered run stored');
  assert(/\(recovered\)$/.test(runs[0].name), 'recovered suffix');
  assert(runs[0].splits.length >= 1, 'recovered run has splits');
  assert(!W.store['runlog.inprogress'], 'snapshot cleared');

  assert.strictEqual(W.xhrs.length, 0, 'no auto-upload on ready (user-driven)');
  // the user uploads the recovered run from the phone page
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  assert.strictEqual(W.xhrs.length, 1, 'manual upload of the recovered run');
  W.xhrs[0].respond(200);
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 1, 'marked uploaded');

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'clear' })) });
  assert.strictEqual(JSON.parse(W.store['runlog.runs']).length, 0, 'clear all');

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

  var walk = JSON.parse(W.store['runlog.runs'])[0];
  assert(/^\d{4}-\d{2}-\d{2}_walk$/.test(walk.name), 'walk name: ' + walk.name);
  assert.strictEqual(walk.act, 1, 'walk activity stored');

  /* FitTrackee auto-export: Bearer token, multipart file + data(sport_id) */
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
  assert(/filename="\d{4}-\d{2}-\d{2}_walk/.test(ft.body), 'file field');
  assert(ft.body.indexOf('name="data"') >= 0 &&
         ft.body.indexOf('{"sport_id":6}') >= 0, 'walking sport id');
  assert(ft.body.indexOf('<type>walking</type>') >= 0, 'gpx type walking');
  ft.respond(201);
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 1);

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
  w2.step(0.8, 5, null); w2.step(0.8, 5, null);
  assert.strictEqual(lastWith(W, 'APAUSE'), null, 'two slow fixes not enough');
  w2.step(0.8, 5, null);
  assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 1,
                     '0.8 m/s pauses a ride (would not pause a run)');
  w2.step(2.5, 5, null); w2.step(2.5, 5, null);
  assert.strictEqual(lastWith(W, 'APAUSE').APAUSE, 0, 'ride resumed');

  for (var n = 0; n < 130; n++) w2.step(8, 5, null);   // ~5.2 km more
  var sp = msgsWith(W, 'SPLIT');
  assert.strictEqual(sp.length, 1, 'one ride split');
  assert.strictEqual(sp[0].SPLIT, 5, 'ride split announces cumulative 5 km');

  W.fire('appmessage', { payload: { CMD: 4 } });
  var runs = JSON.parse(W.store['runlog.runs']);
  var ride = runs[runs.length - 1];
  assert(/^\d{4}-\d{2}-\d{2}_ride$/.test(ride.name), 'ride name: ' + ride.name);
  assert.strictEqual(ride.act, 2, 'ride activity stored');
  assert.strictEqual(ride.cad, 0, 'no wrist cadence on rides');
  assert.strictEqual(ride.splits[0].d, 5000, 'first ride split is 5 km');
  assert(Math.abs(ride.splits[0].s - 625) <= 10, '5 km at 8 m/s ~625 s, got ' + ride.splits[0].s);

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
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 1, 'ride uploaded');

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
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 1, 'recovered after expiry');
  assert.strictEqual(W.store['runlog.ftok'], 'jwt-2', 'new token cached');

  /* and if the login itself fails, the run is marked for retry */
  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retry', idx: 0 })) });
  W.xhrs[6].respond(401);
  W.xhrs[7].respond(500);
  assert.strictEqual(W.xhrs.length, 8, 'gave up after failed login');
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 2, 'marked failed, will retry later');
  assert.strictEqual(lastWith(W, 'EXPST').EXPST, 2, 'watch told about the failure');
  assert.strictEqual(lastWith(W, 'EXPERR').EXPERR, 500, 'login status named as the reason');
  var lg4 = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg4.some(function (m) { return /token rejected \(HTTP 401\)/.test(m); }), '401 logged');
  assert(lg4.some(function (m) { return /fittrackee login FAILED \(HTTP 500\)/.test(m); }), 'login failure logged');
  assert(lg4.some(function (m) { return /fittrackee login ok/.test(m); }), 'earlier login success logged');
  assert(lg4.some(function (m) {
    return m === 'logging in as "kai@home.lan" (password "h\u2026" + "2", 7 chars)'.replace('" + "', '') ||
           m === 'logging in as "kai@home.lan" (password "h\u20262", 7 chars)';
  }), 'login attempts name the email, fingerprint and length');

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
  assert(lg5.some(function (m) { return /\(password "h\u2026 ", 8 chars\)/.test(m); }),
         'fingerprint exposes the trailing space and the extra character');

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
  assert(Math.abs(p.AVGP - 300) <= 8, 'avg pace alive too, got ' + p.AVGP);

  W.fire('appmessage', { payload: { CMD: 4 } });
  var saved = lastWith(W, 'SAVED');
  assert(saved.MOVS >= 280 && saved.MOVS <= 310, 'moving time from wall clock: ' + saved.MOVS);
  assert(lastWith(W, 'PACEG'), 'pace graph still produced');
  var r = JSON.parse(W.store['runlog.runs'])[0];
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
    assert(lg.some(function (m) {
      return m.indexOf('(password "p\u2026 ", 10 chars)') >= 0;
    }), name + ': fingerprint shows first/last char + length');
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
  assert.strictEqual(JSON.parse(W.store['runlog.runs']).length, 1, 'run saved');
  assert.strictEqual(W.xhrs.length, 0, 'nothing uploaded on save (user-driven)');
  W.fire('appmessage', { payload: { CMD: 6 } });
  assert.strictEqual(JSON.parse(W.store['runlog.runs']).length, 0, 'discarded');
  W.flushTimers();
  assert.strictEqual(W.xhrs.length, 0, 'scheduled upload was cancelled');
  var lg = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg.some(function (m) { return /^discarded "\d{4}-\d{2}-\d{2}_run/.test(m); }), 'discard logged');

  /* discard while the upload is already in flight: result is ignored */
  quickRun(1750601000);
  W.fire('appmessage', { payload: { CMD: 7 } });   // user starts an upload
  assert.strictEqual(W.xhrs.length, 1, 'upload in flight');
  var expBefore = msgsWith(W, 'EXPST').length;
  W.fire('appmessage', { payload: { CMD: 6 } });
  assert.strictEqual(JSON.parse(W.store['runlog.runs']).length, 0, 'discarded mid-flight');
  W.xhrs[0].respond(201);
  assert.strictEqual(msgsWith(W, 'EXPST').length, expBefore,
                     'no upload status for a discarded workout');
  assert(JSON.parse(W.store['runlog.log']).some(function (e) {
    return /discarded workout ignored/.test(e[1]);
  }), 'late result logged and dropped');

  /* retype: Run -> Walk -> Ride -> Run, splits and cadence follow */
  quickRun(1750602000);
  W.fire('appmessage', { payload: { CMD: 7 } });
  W.xhrs[1].respond(201);
  var r0 = JSON.parse(W.store['runlog.runs'])[0];
  assert(/_run\b/.test(r0.name) && r0.cad > 0, 'baseline run with cadence: ' + r0.name);

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retype', idx: 0, to: 1 })) });
  var r1 = JSON.parse(W.store['runlog.runs'])[0];
  assert(/_walk\b/.test(r1.name), 'renamed to Walk: ' + r1.name);
  assert.strictEqual(r1.act, 1, 'act updated');
  assert.strictEqual(r1.up, 1, 'upload state untouched');
  var lg7 = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg7.some(function (m) { return /retyped ".* -> Walk/.test(m); }), 'retype logged');
  assert(lg7.some(function (m) { return /re-upload to update the server copy/.test(m); }), 'server note');

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retype', idx: 0, to: 2 })) });
  var r2 = JSON.parse(W.store['runlog.runs'])[0];
  assert.strictEqual(r2.cad, 0, 'ride drops cadence');
  assert.strictEqual(r2.splits.length, 1, 'ride splits recomputed (partial only)');
  assert(r2.splits[0].d < 1000, '183 m never makes a 5 km split');

  W.fire('webviewclosed', { response: encodeURIComponent(JSON.stringify({ act: 'retype', idx: 0, to: 0 })) });
  var r3 = JSON.parse(W.store['runlog.runs'])[0];
  assert(/_run\b/.test(r3.name) && r3.act === 0, 'back to a run: ' + r3.name);
  assert(r3.cad > 150, 'cadence recovered from steps, got ' + r3.cad);

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
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].up, 1, 'run marked uploaded');

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
  var r = JSON.parse(W.store['runlog.runs'])[0];
  assert.strictEqual(r.name, Part + ' run ' + date + ' @' + time + ' session',
                     'template expands all tokens: ' + r.name);

  // blank template -> built-in default {part}-{activity}_{date};
  // re-typing to Walk regenerates the name for the new activity
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '', name: '' } }) });
  W.fire('webviewclosed', { response: enc({ act: 'retype', idx: 0, to: 1 }) });
  var r2 = JSON.parse(W.store['runlog.runs'])[0];
  assert.strictEqual(r2.name, date + '_walk',
                     'blank template -> new default %Y-%m-%d_{activity}, regenerated for walk: ' + r2.name);

  // unknown tokens are left untouched
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '', name: '{bogus}-{activity}' } }) });
  W.fire('webviewclosed', { response: enc({ act: 'retype', idx: 0, to: 0 }) });
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].name, '{bogus}-run',
                     'unknown token passes through verbatim');

  // strftime-style %-codes expand from the run's start time
  function p2s(x) { return (x < 10 ? '0' : '') + x; }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '',
                       name: '%F_%H%M%S-%a-%b-{activity}' } }) });
  W.fire('webviewclosed', { response: enc({ act: 'retype', idx: 0, to: 0 }) });
  var rs = new Date(JSON.parse(W.store['runlog.runs'])[0].start);
  var expF = rs.getFullYear() + '-' + p2s(rs.getMonth() + 1) + '-' + p2s(rs.getDate());
  var expHMS = p2s(rs.getHours()) + p2s(rs.getMinutes()) + p2s(rs.getSeconds());
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].name,
    expF + '_' + expHMS + '-' + DOW[rs.getDay()] + '-' + MON3[rs.getMonth()] + '-run',
    'strftime %F/%H%M%S/%a/%b expand: ' + JSON.parse(W.store['runlog.runs'])[0].name);

  // %% is a literal percent; bare % followed by a non-code is left alone
  W.fire('webviewclosed', { response: enc({
    act: 'cfg', cfg: { auto: 0, preset: 'custom', url: '', auth: '', key: '', name: '%H%% effort {activity}' } }) });
  W.fire('webviewclosed', { response: enc({ act: 'retype', idx: 0, to: 0 }) });
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].name,
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

  var before = JSON.parse(W.store['runlog.runs'])[0].name;
  W.fire('appmessage', { payload: { RENAME: '  Sunset   River Loop  ' } });
  var r = JSON.parse(W.store['runlog.runs'])[0];
  assert.strictEqual(r.name, 'Sunset River Loop', 'voice name applied + whitespace tidied: ' + r.name);
  assert.notStrictEqual(r.name, before, 'name actually changed');
  var lg = JSON.parse(W.store['runlog.log']).map(function (e) { return e[1]; });
  assert(lg.some(function (m) { return /renamed ".*" -> "Sunset River Loop" \(voice\)/.test(m); }),
         'rename logged');

  // a blank/whitespace transcription is ignored, and the run stays on the phone
  W.fire('appmessage', { payload: { RENAME: '   ' } });
  assert.strictEqual(JSON.parse(W.store['runlog.runs'])[0].name, 'Sunset River Loop', 'blank rename ignored');
  assert.strictEqual(JSON.parse(W.store['runlog.runs']).length, 1, 'run still kept on the phone');

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
  assert(JSON.parse(W.store['runlog.runs']).length >= 1, 'run saved for export');

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

  var run = JSON.parse(W.store['runlog.runs'])[0];
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
  var pts = JSON.parse(W.store['runlog.runs'])[0].pts;
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
  var pts = JSON.parse(W.store['runlog.runs'])[0].pts;
  var cad = pts.map(function (p) { return p[6]; }).filter(function (c) { return c > 0; }).slice(2);
  var lo = Math.min.apply(null, cad), hi = Math.max.apply(null, cad);
  assert(lo >= 140 && hi <= 175, 'cadence stays near 156 despite BLE jitter: ' + lo + '..' + hi);
  assert(hi - lo <= 30, 'no 2x/0.5x cadence spikes (old code would span ~111..260): range ' + (hi - lo));
  console.log('scenario 15 (cadence jitter robustness) OK');
})();

console.log('\nALL PIPELINE TESTS PASSED');
