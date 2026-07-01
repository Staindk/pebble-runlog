/*
 * RunLog page test — runs the <script> from tools/page.html inside a
 * minimal DOM stub and checks rendering, the preset settings UI, map
 * math + tile fallback, GPX output and the pebblejs://close payloads.
 *
 * Run from anywhere:  node tools/test_export.js
 */
'use strict';
var fs = require('fs');
var vm = require('vm');
var path = require('path');
var assert = require('assert');

var html = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
var m = html.match(/<script>([\s\S]*)<\/script>/);
assert(m, 'script block found');
var script = m[1];
// inject the shared exporters exactly as build_page.js does, so the page's
// TCX/FIT download paths are exercised here too
var rlExp = ['tcx', 'fit'].map(function (n) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'pkjs', n + '.js'), 'utf8');
}).join('\n');
script = script.replace('/*__RUNLOG_EXPORTERS__*/', rlExp);

// the credential inputs must defuse phone keyboards
assert(/id="cfguser"[^>]*\n?[^>]*autocapitalize="none"/.test(html), 'email: no autocapitalize');
assert(/id="cfguser"[^>]*\n?[^>]*inputmode="email"/.test(html), 'email keyboard layout');
assert(/id="cfgpass"[^>]*\n?[^>]*autocapitalize="none"/.test(html), 'password: no autocapitalize');

/* ---------------- sample data ---------------- */
function mkPts() {
  // L-shaped course in Perth: 16 pts east, then 8 pts north, pause at #10
  var pts = [], t = 1750000000, lat = -31.95, lon = 115.85;
  for (var i = 0; i < 16; i++) {
    pts.push([t, +lat.toFixed(6), +lon.toFixed(6), 20 + i * 0.5,
              148 + (i % 5), i === 10 ? 1 : 0, 168]);
    t += 20; lon += 0.0008;
  }
  for (var j = 0; j < 8; j++) {
    pts.push([t, +lat.toFixed(6), +lon.toFixed(6), 28, 155, 0, 170]);
    t += 20; lat += 0.0007;
  }
  return pts;
}
var RUN_A = {
  name: 'Run 2026-06-10 06.45', start: 1750000000000,
  dist: 1340, dur: 480, mov: 460, avgp: 343, avgHr: 151, maxHr: 162, vo2max: 52,
  egain: 12, cad: 168, steps: 1290, mi: 0,
  splits: [{ d: 1000, s: 343, hr: 150 }, { d: 340, s: 117, hr: 154 }],
  up: 1, pts: mkPts()
};
var RUN_B = {
  name: 'Run 2026-06-08 07.02', start: 1749800000000,
  dist: 412, dur: 150, mov: 150, avgp: 364, avgHr: 0, maxHr: 0,
  egain: 0, cad: 0, steps: 0, mi: 0, splits: [{ d: 412, s: 150, hr: 0 }],
  up: 0, pts: mkPts().slice(0, 6)
};
var RUN_C = {   // a bike ride: speed display, 5-km splits
  name: 'Ride 2026-06-09 17.10', start: 1749900000000,
  dist: 7200, dur: 1330, mov: 1296, avgp: 180, avgHr: 139, maxHr: 158,
  egain: 25, cad: 0, steps: 0, mi: 0, act: 2,
  splits: [{ d: 5000, s: 900, hr: 140 }, { d: 2200, s: 407, hr: 142 }],
  up: 0, pts: mkPts()
};
var CFG = { auto: 1, preset: 'custom', url: 'https://example.test/runs', auth: '', key: '', name: 'morning-{activity}' };

/* ---------------- DOM stub ---------------- */
function makeDom() {
  var ids = {}, hrefs = [], anchors = [];

  function el(tag) {
    var e = {
      tag: tag || 'div', style: {}, children: [], attrs: {},
      _html: '', value: '', checked: false, textContent: '', placeholder: '',
      clientWidth: 320, clientHeight: 250,
      getBoundingClientRect: function () {
        return { left: 0, top: 0, width: e.clientWidth, height: e.clientHeight,
                 right: e.clientWidth, bottom: e.clientHeight };
      },
      appendChild: function (c) { c.parentNode = e; e.children.push(c); return c; },
      removeChild: function (c) { e.children = e.children.filter(function (x) { return x !== c; }); },
      setAttribute: function (k, v) { e.attrs[k] = String(v); },
      getAttribute: function (k) { return (k in e.attrs) ? e.attrs[k] : null; },
      removeAttribute: function (k) { delete e.attrs[k]; },
      addEventListener: function () {},
      click: function () { e._clicked = true; },
      getContext: function () {
        if (e.ctx) return e.ctx;
        e.ctx = { nCalls: {}, texts: [] };
        ['scale', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath']
          .forEach(function (n) {
            e.ctx[n] = function () { e.ctx.nCalls[n] = (e.ctx.nCalls[n] || 0) + 1; };
          });
        e.ctx.fillText = function (t) {
          e.ctx.texts.push(String(t));
          e.ctx.nCalls.fillText = (e.ctx.nCalls.fillText || 0) + 1;
        };
        return e.ctx;
      }
    };
    Object.defineProperty(e, 'innerHTML', {
      get: function () { return e._html; },
      set: function (v) { e._html = v; if (!v) e.children = []; }
    });
    return e;
  }

  var body = el('body');
  var documentStub = {
    body: body,
    getElementById: function (id) { return ids[id] || (ids[id] = el('div')); },
    createElement: function (tag) { var x = el(tag); if (tag === 'a') anchors.push(x); return x; },
    createElementNS: function (ns, tag) { return el(tag); }
  };
  var locationStub = {};
  Object.defineProperty(locationStub, 'href', {
    set: function (v) { hrefs.push(v); },
    get: function () { return hrefs[hrefs.length - 1]; }
  });

  var dom = { ids: ids, hrefs: hrefs, anchors: anchors, blobs: [] };
  dom.sandbox = {
    document: documentStub,
    window: { devicePixelRatio: 1 },
    location: locationStub,
    URL: { createObjectURL: function () { return 'blob:stub'; }, revokeObjectURL: function () {} },
    Blob: function (parts) { dom.blobs.push(parts.join('')); },
    confirm: function () { return true; },
    setTimeout: function () {},
    console: console
  };
  return dom;
}

function boot(runs, cfg, miles, initial, logl) {
  var dom = makeDom();
  var src = script
    .replace('"__RUNLOG_RUNS__"', function () { return JSON.stringify(runs); })
    .replace('"__RUNLOG_CFG__"', function () { return JSON.stringify(cfg); })
    .replace('"__RUNLOG_MILES__"', function () { return miles ? 'true' : 'false'; })
    .replace('"__RUNLOG_INITIAL__"', function () { return JSON.stringify(initial || 0); })
    .replace('"__RUNLOG_LOG__"', function () { return JSON.stringify(logl || []); });
  assert(src.indexOf('__RUNLOG_') < 0, 'placeholders replaced');
  vm.createContext(dom.sandbox);
  vm.runInContext(src, dom.sandbox);
  return dom;
}

function lastAction(dom) {
  var h = dom.hrefs[dom.hrefs.length - 1];
  assert(h.indexOf('pebblejs://close#') === 0, 'close URL');
  var payload = decodeURIComponent(h.slice('pebblejs://close#'.length));
  if (!payload) return '';
  assert(payload.slice(0, 4) === 'b64.', 'payload is decode-proof base64');
  var b64 = payload.slice(4).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/* =======================================================================
 * km mode: list, settings UI, detail, charts, splits, map, gpx, actions
 * ===================================================================== */
(function kmMode() {
  var dom = boot([RUN_B, RUN_A], CFG, false, 0, [
    [1750000000, 'GPS ok, accuracy 8 m'],
    [1750000400, 'upload FAILED (HTTP 401) <oops>']
  ]);
  var S = dom.sandbox;

  // log card: newest first, failures highlighted, html escaped
  var ll = dom.ids.loglines.innerHTML;
  assert(ll.indexOf('upload FAILED') >= 0 && ll.indexOf('GPS ok') >= 0, 'log lines rendered');
  assert(ll.indexOf('upload FAILED') < ll.indexOf('GPS ok'), 'log newest first');
  assert(ll.indexOf('lm lbad') >= 0, 'failures highlighted');
  assert(ll.indexOf('&lt;oops>') >= 0 && ll.indexOf('<oops>') < 0, 'log html escaped');

  // list view
  var sub = dom.ids.subline.innerHTML;
  assert(sub.indexOf('2 saved runs') === 0, 'subline: ' + sub);
  var list = dom.ids.list.innerHTML;
  assert(list.indexOf(RUN_A.name) >= 0 && list.indexOf(RUN_B.name) >= 0, 'both runs listed');
  assert(list.indexOf(RUN_A.name) < list.indexOf(RUN_B.name), 'newest first');
  assert((list.match(/badge b1/g) || []).length === 1, 'one uploaded badge');
  assert(list.indexOf('1.34') >= 0, 'distance formatted');
  assert(list.indexOf('5:43') >= 0, 'avg pace 343 s -> 5:43');
  assert(!dom.ids.vdetail, 'list view stays put with INITIAL 0');

  // settings card prefilled + preset UI behaviour
  assert.strictEqual(dom.ids.cfgname.value, 'morning-{activity}', 'name template prefilled');
  assert.strictEqual(dom.ids.cfgpreset.value, 'custom');
  assert.strictEqual(dom.ids.cfgurl.value, CFG.url);
  assert.strictEqual(dom.ids.cfgurlrow.style.display, '', 'url row visible for custom');
  assert.strictEqual(dom.ids.cfgkeyrow.style.display, 'none', 'key row hidden for custom');

  dom.ids.cfgpreset.value = 'intervals'; S.cfgUi();
  assert.strictEqual(dom.ids.cfgurlrow.style.display, 'none', 'url row hidden for intervals');
  assert.strictEqual(dom.ids.cfgkeyrow.style.display, '', 'key row shown for intervals');
  assert(dom.ids.cfgkeyhint.textContent.indexOf('Developer Settings') >= 0, 'intervals hint');
  dom.ids.cfgpreset.value = 'runalyze'; S.cfgUi();
  assert(dom.ids.cfgkeyhint.textContent.indexOf('Personal API') >= 0, 'runalyze hint');
  dom.ids.cfgpreset.value = 'webdav'; S.cfgUi();
  assert(dom.ids.cfgurl.placeholder.indexOf('remote.php/dav') >= 0, 'webdav placeholder');
  assert.strictEqual(dom.ids.cfgkeyrow.style.display, 'none', 'key row hidden for webdav');
  dom.ids.cfgpreset.value = 'fittrackee'; S.cfgUi();
  assert.strictEqual(dom.ids.cfgurlrow.style.display, '', 'fittrackee shows URL row');
  assert.strictEqual(dom.ids.cfguserrow.style.display, '', 'fittrackee shows email row');
  assert.strictEqual(dom.ids.cfgpassrow.style.display, '', 'fittrackee shows password row');
  assert.strictEqual(dom.ids.cfgkeyrow.style.display, 'none', 'no manual token field');
  assert.strictEqual(dom.ids.cfgauthrow.style.display, 'none', 'fittrackee hides auth row');
  dom.ids.cfgpreset.value = 'custom'; S.cfgUi();
  assert.strictEqual(dom.ids.cfguserrow.style.display, 'none', 'email row hidden again');

  // detail view of RUN_A (index 1 in injected order)
  S.showDetail(1);
  assert.strictEqual(dom.ids.vdetail.style.display, '', 'detail shown');
  var stats = dom.ids.dstats.innerHTML;
  ['DISTANCE', 'MOVING TIME', 'AVG PACE', 'AVG HR', 'ELEV GAIN',
   'CADENCE', 'STEPS', 'BEST KM'].forEach(function (cap) {
    assert(stats.indexOf(cap) >= 0, 'stat ' + cap);
  });
  assert(stats.indexOf('ml/kg/min') >= 0 && stats.indexOf('52') >= 0, 'VO2max stat rendered for a run');
  assert(stats.indexOf('1.34') >= 0, 'detail distance');
  assert(stats.indexOf('7:40') >= 0, 'moving time 460 s');
  assert(stats.indexOf('151') >= 0 && stats.indexOf('162 max') >= 0, 'HR stats');
  assert(stats.indexOf('12 m') >= 0, 'elev gain');
  assert.strictEqual(dom.ids.upbtn.textContent, 'Re-upload', 'button label for up=1');
  assert(dom.ids.hspeed.textContent.indexOf('SPEED') === 0, 'speed chart header');

  // the page's smoother copy behaves like the module
  var ks = S.ksmooth([3, 3, 3, 3], 1.5);
  assert(Math.abs(ks[1] - 3) < 1e-9, 'page ksmooth flat');
  var kb = S.ksmooth([0, 0, 100, 100], 2, [false, false, true, false]);
  assert(Math.abs(kb[1]) < 1e-9, 'page ksmooth respects pause walls');
  assert.strictEqual(S.ksmooth([1, null, 5], 2)[1], null, 'page ksmooth keeps gaps');

  // charts drew lines and axis labels
  ['cspeed', 'chr', 'cele'].forEach(function (id) {
    var ctx = dom.ids[id].ctx;
    assert(ctx && (ctx.nCalls.lineTo || 0) > 5, id + ' drew a line');
    assert(ctx.texts.indexOf('no data') < 0, id + ' has data');
  });

  // splits: one full split highlighted as best
  var sp = dom.ids.splits.innerHTML;
  assert((sp.match(/bar best/g) || []).length === 1, 'best split highlighted');
  assert(sp.indexOf('5:43') >= 0, 'split pace shown');
  assert(sp.indexOf('&#9829; 150') >= 0, 'split HR shown');

  // map: CARTO tiles with no-referrer + OSM fallback wired
  var inner = dom.ids.mapinner;
  var tiles = inner.children.filter(function (c) {
    return c.tag === 'img' && /cartocdn\.com\/rastertiles\/voyager\/\d+\/\d+\/\d+\.png/.test(c.src);
  });
  assert(tiles.length >= 4, 'CARTO tiles requested (' + tiles.length + ')');
  tiles.forEach(function (t) {
    assert.strictEqual(t.referrerPolicy, 'no-referrer', 'tile referrer policy');
    assert(/tile\.openstreetmap\.org/.test(t.getAttribute('data-fallback')), 'OSM fallback attr');
  });

  // first error -> swap to OSM; second error -> hide + note once most fail
  assert.strictEqual(dom.ids.tilenote.style.display, 'none', 'note hidden initially');
  tiles.forEach(function (t) { t.onerror.call(t); });
  assert(/tile\.openstreetmap\.org/.test(tiles[0].src), 'fallback swapped to OSM');
  assert.strictEqual(dom.ids.tilenote.style.display, 'none', 'note still hidden after 1st errors');
  tiles.forEach(function (t) { if (t.onerror) t.onerror.call(t); });
  assert.strictEqual(tiles[0].style.display, 'none', 'failed tile hidden');
  assert.strictEqual(dom.ids.tilenote.style.display, '', 'tiles-unavailable note shown');

  // route overlay: pen lifts at the pause, all points drawn
  var svg = inner.children[inner.children.length - 1];
  assert(svg.children.length >= 4, 'casing + route + 2 dots');
  var route = svg.children[1];
  assert.strictEqual(route.attrs.stroke, '#ff5a1f', 'route colour');
  var dpath = route.attrs.d;
  assert(dpath.charAt(0) === 'M', 'path starts with move');
  assert.strictEqual((dpath.match(/M/g) || []).length, 2, 'seg break = pen lift');
  assert.strictEqual((dpath.match(/L/g) || []).length, RUN_A.pts.length - 2, 'all points drawn');

  // zoom gestures are wired up
  assert(html.indexOf("addEventListener('dblclick'") >= 0, 'double-tap zoom wired');
  assert(html.indexOf('function zoomAt(') >= 0 && html.indexOf('function touchStart(') >= 0,
         'pinch handlers present');
  assert(html.indexOf('pinch or double-tap to zoom') >= 0, 'gesture hint shown');

  // zoomAt anchored on the map centre just changes zoom, centre unmoved
  S.MZ = 14; S.MC = { lat: -31.95, lon: 115.86 };
  var before = { lat: S.MC.lat, lon: S.MC.lon };
  var elc = dom.ids.map.getBoundingClientRect();
  S.zoomAt(1, { x: elc.left + dom.ids.map.clientWidth / 2, y: elc.top + dom.ids.map.clientHeight / 2 });
  assert.strictEqual(S.MZ, 15, 'zoom incremented');
  assert(Math.abs(S.MC.lat - before.lat) < 1e-6 && Math.abs(S.MC.lon - before.lon) < 1e-6,
         'centre-anchored zoom keeps centre fixed');

  // slippy math sanity
  var c = S.ll2w(0, 0, 1);
  assert(Math.abs(c.x - 256) < 1e-6 && Math.abs(c.y - 256) < 1e-6, 'll2w centre');
  assert(Math.abs(S.ll2w(0, 180, 1).x - 512) < 1e-6, 'll2w east edge');
  assert(S.ll2w(60, 0, 1).y < 256, 'north is up');

  // GPX
  var g = S.gpx(RUN_A);
  assert(g.indexOf('<?xml') === 0, 'xml header');
  assert.strictEqual((g.match(/<trkpt /g) || []).length, RUN_A.pts.length, 'all trkpts');
  assert.strictEqual((g.match(/<trkseg>/g) || []).length, 2, 'pause -> 2 segments');
  assert(g.indexOf('<gpxtpx:hr>148</gpxtpx:hr>') >= 0, 'hr extension');
  assert(g.indexOf('<gpxtpx:cad>84</gpxtpx:cad>') >= 0, 'cad halved (168 spm -> 84)');
  assert(g.indexOf('<ele>20</ele>') >= 0, 'elevation');
  assert(g.indexOf('undefined') < 0 && g.indexOf('NaN') < 0, 'clean output');

  // injected page exporters: TCX (text) + FIT (binary)
  var tcxOut = S.rlTcxBuild(RUN_A);
  assert(/<TrainingCenterDatabase/.test(tcxOut) && /<Trackpoint>/.test(tcxOut), 'page TCX builds');
  assert.strictEqual((tcxOut.match(/<Trackpoint>/g) || []).length, RUN_A.pts.length, 'TCX: one trackpoint per fix');
  assert(/<HeartRateBpm><Value>148<\/Value>/.test(tcxOut), 'TCX heart rate');
  var fitOut = S.rlFitBuild(RUN_A);
  assert(fitOut && fitOut.constructor && fitOut.constructor.name === 'Uint8Array', 'page FIT is bytes');
  assert.strictEqual(String.fromCharCode(fitOut[8], fitOut[9], fitOut[10], fitOut[11]), '.FIT', 'page FIT signature');

  // download builds a .gpx blob without closing the page
  S.dl();
  assert.strictEqual(dom.hrefs.length, 0, 'download does not navigate');
  assert.strictEqual(dom.blobs.length, 1, 'blob created');
  assert(dom.blobs[0].indexOf('<gpx ') >= 0, 'blob is GPX');
  assert(/\.gpx$/.test(dom.anchors[0].download), 'download filename');
  assert(dom.anchors[0]._clicked, 'anchor clicked');

  // type row: current type highlighted, switching closes with a retype action
  var ty = dom.ids.dtype.innerHTML;
  assert(/class="ton on"[^>]*>Run</.test(ty), 'Run highlighted for a run');
  assert(ty.indexOf('>Walk<') >= 0 && ty.indexOf('>Ride<') >= 0, 'all three types offered');
  var hrefsBefore = dom.hrefs.length;
  S.retype(0);
  assert.strictEqual(dom.hrefs.length, hrefsBefore, 'same type is a no-op');
  S.retype(1);
  assert.deepStrictEqual(lastAction(dom), { act: 'retype', idx: 1, to: 1 }, 'retype action');

  // actions
  S.uploadNow();
  assert.deepStrictEqual(lastAction(dom), { act: 'retry', idx: 1 }, 'retry action');
  S.delRun();
  assert.deepStrictEqual(lastAction(dom), { act: 'del', idx: 1 }, 'delete action');
  S.clearAll();
  assert.deepStrictEqual(lastAction(dom), { act: 'clear' }, 'clear action');
  dom.ids.cfgname.value = 'evening-{activity}';
  dom.ids.cfgpreset.value = 'intervals';
  dom.ids.cfgurl.value = '';
  dom.ids.cfgauth.value = '';
  dom.ids.cfgkey.value = '  abc123  ';
  dom.ids.cfguser.value = ' kai+fit@home.lan ';
  dom.ids.cfgpass.value = 'p+%2B çat ';
  S.saveCfg();
  assert.deepStrictEqual(lastAction(dom), {
    act: 'cfg', cfg: { auto: 0, name: 'evening-{activity}', fmt: 'gpx', preset: 'intervals', url: '', auth: '', key: 'abc123',
                       user: 'kai+fit@home.lan', pass: 'p+%2B çat ' }
  }, 'plus signs, percents, unicode and spaces survive the close payload verbatim');

  // the chosen file format is carried in the close payload
  dom.ids.cfgfmt.value = 'fit';
  S.saveCfg();
  assert.strictEqual(lastAction(dom).cfg.fmt, 'fit', 'selected file format is saved');

  // show/hide password toggle
  S.togglePw();
  assert.strictEqual(dom.ids.cfgpass.type, 'text', 'password revealed');
  assert.strictEqual(dom.ids.pwtoggle.textContent, 'Hide', 'toggle label flips');
  S.togglePw();
  assert.strictEqual(dom.ids.cfgpass.type, 'password', 'password hidden again');
  S.closePage('');
  assert.strictEqual(lastAction(dom), '', 'plain done close');

  console.log('km-mode page test OK');
})();

/* =======================================================================
 * miles mode, empty state, INITIAL deep-link
 * ===================================================================== */
(function variants() {
  var dom = boot([RUN_A], CFG, true, 0);
  var S = dom.sandbox;
  assert.strictEqual(S.fmtPace(300), '8:03', 'pace converts to /mi');
  assert.strictEqual(S.fmtDist(1609.344), '1.00', 'distance converts to mi');
  assert.strictEqual(S.fmtEg(10), '33 ft', 'elevation converts to ft');
  S.showDetail(0);
  // #12: RUN_A was recorded in km, so its splits stay in km even though the page
  // is in miles mode — aggregate stats convert, but splits keep their recorded unit.
  assert(dom.ids.dstats.innerHTML.indexOf('BEST KM') >= 0, 'best split keeps the run\'s km unit');
  assert(dom.ids.hsplits.textContent.indexOf('(KM)') >= 0, 'splits header keeps the run\'s km unit');

  var empty = boot([], CFG, false, 0);
  assert(empty.ids.list.innerHTML.indexOf('No runs saved yet') >= 0, 'empty state');
  assert(empty.ids.loglines.innerHTML.indexOf('Nothing logged yet') >= 0, 'empty log state');
  assert(empty.ids.subline.innerHTML.indexOf('0 saved runs') === 0, 'zero count');

  // deep link straight to the run that just finished
  var dl1 = boot([RUN_B, RUN_A], CFG, false, RUN_A.start);
  assert.strictEqual(dl1.ids.vdetail.style.display, '', 'deep link opens detail');
  assert(dl1.ids.dtitle.innerHTML.indexOf(RUN_A.name) >= 0, 'deep link picks the right run');

  // unknown start falls back to the newest run
  var dl2 = boot([RUN_B, RUN_A], CFG, false, 12345);
  assert.strictEqual(dl2.ids.vdetail.style.display, '', 'fallback opens detail');
  assert(dl2.ids.dtitle.innerHTML.indexOf(RUN_A.name) >= 0, 'fallback picks newest');

  console.log('miles-mode + empty-state + deep-link page test OK');
})();

/* =======================================================================
 * ride mode: speed everywhere, 5-km splits, gpx type
 * ===================================================================== */
(function rideMode() {
  var dom = boot([RUN_C], CFG, false, 0);
  var S = dom.sandbox;

  var list = dom.ids.list.innerHTML;
  assert(list.indexOf('20 km/h') >= 0, 'list chip shows speed for rides');

  S.showDetail(0);
  var stats = dom.ids.dstats.innerHTML;
  assert(stats.indexOf('AVG SPEED') >= 0 && stats.indexOf('AVG PACE') < 0, 'speed stat');
  assert(stats.indexOf('20 <small>km/h') >= 0, 'avg speed 180 s/km -> 20 km/h');
  assert(stats.indexOf('BEST 5KM') >= 0, 'best-5km caption');
  assert(stats.indexOf('MAX SPEED') >= 0, 'ride shows max speed');
  assert(stats.indexOf('ELAPSED') >= 0, 'ride shows elapsed instead of steps');
  assert(stats.indexOf('CADENCE') < 0 && stats.indexOf('STEPS') < 0, 'ride hides cadence/steps');
  assert.strictEqual(dom.ids.hsplits.textContent, 'SPLITS (5 KM)', 'splits header');

  var sp = dom.ids.splits.innerHTML;
  assert(sp.indexOf('<div class="n">5</div>') >= 0, 'split labelled by cumulative km');
  assert(sp.indexOf('"t">20<') >= 0, 'split value as speed');
  assert((sp.match(/bar best/g) || []).length === 1, 'best ride split highlighted');

  assert(/class="ton on"[^>]*>Ride</.test(dom.ids.dtype.innerHTML), 'Ride highlighted for a ride');

  var g = S.gpx(RUN_C);
  assert(g.indexOf('<type>cycling</type>') >= 0, 'gpx type cycling');
  var g2 = S.gpx({ name: 'x', pts: RUN_C.pts });  // legacy record, no act field
  assert(g2.indexOf('<type>running</type>') >= 0, 'legacy records default to running');

  console.log('ride-mode page test OK');
})();

console.log('\nALL PAGE TESTS PASSED');
