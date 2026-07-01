/*
 * RunLog export-format unit tests — GPX, TCX, and the binary FIT encoder.
 * Includes a small FIT reader so the bytes are validated structurally
 * (definition/data messages, CRC, decoded lat/long/HR), not just by length.
 *
 *   node tools/test_formats.js
 */
'use strict';
var assert = require('assert');
var gpx = require('../src/pkjs/gpx');
var tcx = require('../src/pkjs/tcx');
var fit = require('../src/pkjs/fit');

/* ---- sample run: 4 fixes, a pause at #2, last fix has no ele and no HR ---- */
function sample(act) {
  return {
    name: 'Test ' + act, start: 1750000000000, act: act,
    dist: 1234, dur: 60, mov: 58, avgHr: 150, maxHr: 170, steps: 170, egain: 8,
    pts: [
      [1750000000, -31.9500, 115.8500, 20, 148, 0, 168],
      [1750000020, -31.9505, 115.8512, 22, 152, 0, 170],
      [1750000040, -31.9510, 115.8524, 25, 160, 1, 172],   // seg flag (after pause)
      [1750000060, -31.9515, 115.8536, '', 0, 0, 0]        // no ele, no HR
    ]
  };
}
var SEMI = 2147483648 / 180;

/* ---------------- GPX ---------------- */
(function () {
  var r = sample(0), g = gpx.build(r);
  assert(g.indexOf('<?xml') === 0, 'gpx: xml header');
  assert.strictEqual((g.match(/<trkpt /g) || []).length, 4, 'gpx: trkpt per fix');
  assert.strictEqual((g.match(/<trkseg>/g) || []).length, 2, 'gpx: pause splits segments');
  assert(g.indexOf('<gpxtpx:hr>148</gpxtpx:hr>') >= 0, 'gpx: HR extension');
  assert(g.indexOf('<gpxtpx:cad>84</gpxtpx:cad>') >= 0, 'gpx: cadence halved (168->84)');
  assert(g.indexOf('NaN') < 0 && g.indexOf('undefined') < 0, 'gpx: clean');
  console.log('GPX OK');
})();

/* ---------------- TCX ---------------- */
(function () {
  var r = sample(0), t = tcx.build(r);
  assert(t.indexOf('<?xml') === 0, 'tcx: xml header');
  assert(/<Activity Sport="Running">/.test(t), 'tcx: run -> Running');
  assert.strictEqual((t.match(/<Trackpoint>/g) || []).length, 4, 'tcx: one trackpoint per fix');
  assert(/<TotalTimeSeconds>60<\/TotalTimeSeconds>/.test(t), 'tcx: lap time');
  assert(/<DistanceMeters>1234<\/DistanceMeters>/.test(t), 'tcx: lap distance');
  assert(/<AverageHeartRateBpm><Value>150<\/Value>/.test(t), 'tcx: avg HR');
  assert(/<HeartRateBpm><Value>148<\/Value>/.test(t), 'tcx: trackpoint HR');
  assert(/ns3:RunCadence>84</.test(t), 'tcx: run cadence via extension (168->84)');
  assert(/<AltitudeMeters>20<\/AltitudeMeters>/.test(t), 'tcx: altitude present');
  // cumulative DistanceMeters must be non-decreasing
  var dm = (t.match(/<DistanceMeters>([\d.]+)<\/DistanceMeters>/g) || []).map(function (s) {
    return parseFloat(s.replace(/[^\d.]/g, ''));
  });
  for (var i = 2; i < dm.length; i++) assert(dm[i] >= dm[i - 1] - 1e-6, 'tcx: distance non-decreasing');
  // sport mapping
  assert(/Sport="Biking"/.test(tcx.build(sample(2))), 'tcx: cycle -> Biking');
  assert(/<Cadence>/.test(tcx.build(sample(2))), 'tcx: bike uses <Cadence>');
  assert(/Sport="Other"/.test(tcx.build(sample(1))), 'tcx: walk -> Other');
  console.log('TCX OK');
})();

/* ---------------- FIT (binary) ---------------- */
function fitParse(b) {
  assert.strictEqual(b[0], 14, 'fit: header size 14');
  assert.strictEqual(String.fromCharCode(b[8], b[9], b[10], b[11]), '.FIT', 'fit: signature');
  var dataSize = b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24);
  assert.strictEqual(dataSize, b.length - 16, 'fit: data_size matches');
  // CRCs
  var arr = Array.prototype.slice.call(b);
  assert.strictEqual(fit.crc(arr.slice(0, 12)), b[12] | (b[13] << 8), 'fit: header CRC');
  assert.strictEqual(fit.crc(arr.slice(0, arr.length - 2)),
                     b[b.length - 2] | (b[b.length - 1] << 8), 'fit: file CRC');

  var sizeOf = { 0x00: 1, 0x02: 1, 0x84: 2, 0x86: 4, 0x85: 4, 0x8C: 4 };
  var defs = {}, msgs = { records: [], file_id: null, session: null }, pos = 14, end = b.length - 2;
  function u(p, n) { var v = 0; for (var k = n - 1; k >= 0; k--) v = v * 256 + b[p + k]; return v; }
  function i32(p) { var v = u(p, 4); return v >= 0x80000000 ? v - 0x100000000 : v; }
  while (pos < end) {
    var hdr = b[pos++];
    var local = hdr & 0x0F;
    if (hdr & 0x40) {                                  // definition
      pos += 2;                                        // reserved + arch (LE)
      var global = b[pos] | (b[pos + 1] << 8); pos += 2;
      var nf = b[pos++]; var fields = [];
      for (var f = 0; f < nf; f++) { fields.push([b[pos], b[pos + 1], b[pos + 2]]); pos += 3; }
      defs[local] = { global: global, fields: fields };
    } else {                                           // data
      var d = defs[local]; assert(d, 'fit: data before definition');
      var rec = {}, p0 = pos;
      for (var j = 0; j < d.fields.length; j++) {
        var fd = d.fields[j], num = fd[0], sz = fd[1], base = fd[2];
        rec[num] = (base === 0x85) ? i32(p0) : u(p0, sz);
        p0 += sz;
      }
      pos = p0;
      if (d.global === 20) msgs.records.push(rec);
      else if (d.global === 0) msgs.file_id = rec;
      else if (d.global === 18) msgs.session = rec;
    }
  }
  return msgs;
}

(function () {
  var r = sample(0), b = fit.build(r);
  assert(b.constructor.name === 'Uint8Array', 'fit: returns Uint8Array');
  var m = fitParse(b);
  assert.strictEqual(m.records.length, 4, 'fit: one record per fix');
  // decode first record position back to degrees
  var lat = m.records[0][0] / SEMI, lon = m.records[0][1] / SEMI;
  assert(Math.abs(lat - (-31.95)) < 1e-4, 'fit: latitude round-trips');
  assert(Math.abs(lon - 115.85) < 1e-4, 'fit: longitude round-trips');
  assert.strictEqual(m.records[0][3], 148, 'fit: heart_rate field');           // field 3
  assert.strictEqual(m.records[0][4], 84, 'fit: cadence rpm (168->84)');        // field 4
  // last fix: no ele -> altitude invalid 0xFFFF; no HR -> 0xFF
  assert.strictEqual(m.records[3][2], 0xFFFF, 'fit: missing altitude = invalid');
  assert.strictEqual(m.records[3][3], 0xFF, 'fit: missing HR = invalid');
  assert.strictEqual(m.file_id[0], 4, 'fit: file type = activity');            // field 0
  assert.strictEqual(m.session[5], 1, 'fit: session sport = running');         // field 5
  assert.strictEqual(fit.build(sample(2)) && fitParse(fit.build(sample(2))).session[5], 2, 'fit: cycle sport = 2');
  assert.strictEqual(fitParse(fit.build(sample(1))).session[5], 11, 'fit: walk sport = 11');
  console.log('FIT OK');
})();

console.log('\nALL FORMAT TESTS PASSED');

/* -------------------- GPS Kalman filter -------------------- */
(function () {
  var K = require('../src/pkjs/kalman');
  function hav(a, b) {
    var R = 6371000, r = Math.PI / 180;
    var dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r, la1 = a[0] * r, la2 = b[0] * r;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function dist(a) { var d = 0; for (var i = 1; i < a.length; i++) d += hav(a[i - 1], a[i]); return d; }
  var lat = -31.95, coslat = Math.cos(lat * Math.PI / 180);

  // (1) clean constant-velocity track is preserved (filter must not eat real distance)
  var lon = 115.85, t = 0, f = K.make(), clean = [];
  for (var i = 0; i < 60; i++) { lon += (3.333 * 5) / (111320 * coslat); var o = f.update(lat, lon, 8, t); clean.push([o.lat, o.lon]); t += 5; }
  var trueClean = 60 * 3.333 * 5;
  assert(Math.abs(dist(clean) - trueClean) / trueClean < 0.02, 'kalman: clean track preserved within 2%');

  // (2) jittery 1 Hz track: filtered distance is much closer to truth than raw
  var lon2 = 115.85, t2 = 0, f2 = K.make(), raw = [], filt = [], seed = 7;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; }
  for (var j = 0; j < 240; j++) {
    lon2 += (3.0 * 1) / (111320 * coslat);
    var jl = lat + rnd() * 2 * 2.5 / 110540, jo = lon2 + rnd() * 2 * 2.5 / (111320 * coslat);
    raw.push([jl, jo]);
    var p = f2.update(jl, jo, 8, t2); filt.push([p.lat, p.lon]); t2 += 1;
  }
  var truth = 240 * 3.0, eRaw = Math.abs(dist(raw) - truth) / truth, eFilt = Math.abs(dist(filt) - truth) / truth;
  assert(eRaw > 0.10, 'kalman: raw 1 Hz jitter inflates distance >10% (sanity, got ' + (eRaw * 100).toFixed(1) + '%)');
  assert(eFilt < 0.05, 'kalman: filtered distance within 5% of truth (got ' + (eFilt * 100).toFixed(1) + '%)');
  assert(eFilt < eRaw / 3, 'kalman: filter cuts distance error to <1/3 of raw');
  console.log('KALMAN OK');
})();

/* ---- VO2max estimator: accuracy behaviours ---------------------------- */
(function () {
  var src = require('fs').readFileSync(__dirname + '/../src/pkjs/index.js', 'utf8');
  function rad(d){return d*Math.PI/180;}
  function haversine(a,b){var R=6371000;var dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon);
    var s=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return 2*R*Math.asin(Math.min(1,Math.sqrt(s)));}
  var estimateVo2max;
  eval('estimateVo2max = function ' + src.slice(
    src.indexOf('function estimateVo2max') + 'function estimateVo2max'.length,
    src.indexOf('function finalizeRun')));

  // build pts at a steady speed (m/min) and HR, appended to `pts`
  var LAT = -31.95, COS = Math.cos(LAT * Math.PI / 180);
  function seg(pts, vmpm, hr, n) {
    var t = pts.length ? pts[pts.length - 1][0] : 0;
    var lon = pts.length ? pts[pts.length - 1][2] : 115.85;
    for (var i = 0; i < n; i++) {
      t += 5; lon += (vmpm / 60 * 5) / (111320 * COS);
      pts.push([t, LAT, lon, '', hr, 0, 0]);
    }
    return pts;
  }

  // (a) Swain (no resting HR): 200 m/min, HR 160, max 190 -> ~59
  var a = seg([], 200, 160, 60);
  assert(estimateVo2max(a, 0, 190, 0) === 59, 'Swain steady run = 59 (got ' + estimateVo2max(a,0,190,0) + ')');

  // (b) Karvonen (resting HR 50): same run -> ~54, and lower than Swain
  var bv = estimateVo2max(a, 0, 190, 50);
  assert(bv >= 52 && bv <= 56, 'Karvonen reserve model ~54 (got ' + bv + ')');
  assert(bv < estimateVo2max(a, 0, 190, 0), 'reserve model differs from %HRmax model');

  // (c) warm-up excluded: 30 junk low-HR points in the first 2 min, then steady -> still 59
  var c = seg([], 200, 120, 30);   // <2 min, HR 120 (warm-up artefact), all dropped
  seg(c, 200, 160, 50);
  assert(estimateVo2max(c, 0, 190, 0) === 59, 'warm-up points excluded (got ' + estimateVo2max(c,0,190,0) + ')');

  // (d) too little steady aerobic data -> 0 (no estimate)
  assert(estimateVo2max(seg([], 200, 160, 20), 0, 190, 0) === 0, 'short run yields no estimate');
  assert(estimateVo2max(seg([], 90, 150, 80), 0, 190, 0) === 0, 'sub-running pace yields no estimate');

  // (e) non-run activity never estimates
  assert(estimateVo2max(a, 1, 190, 0) === 0 && estimateVo2max(a, 2, 190, 0) === 0, 'walk/ride yield no estimate');

  // (f) steady-state filter is exercised by a surging run and still returns a sane figure
  var g = seg([], 200, 160, 40); seg(g, 330, 160, 8); seg(g, 200, 160, 40);  // mid-run surge (clamped/rejected)
  var gv = estimateVo2max(g, 0, 190, 0);
  assert(gv >= 55 && gv <= 63, 'surge does not corrupt the estimate (got ' + gv + ')');

  console.log('VO2MAX estimator OK');
})();


/* #6: exported cumulative distance must NOT jump across a pause (seg==1). */
(function pauseDistance() {
  var R = {
    name: 'Pause test', start: 1750000000000, act: 0,
    dist: 208, dur: 240, mov: 60, avgHr: 0, maxHr: 0, steps: 0, egain: 0,
    pts: [
      [1750000000, -31.9500, 115.8500, '', 0, 0, 0],
      [1750000030, -31.9500, 115.8511, '', 0, 0, 0],   // ~104 m east
      [1750000200, -31.9500, 116.0500, '', 0, 1, 0],   // resumed ~18 km away — relocation, not distance (seg=1)
      [1750000230, -31.9500, 116.0511, '', 0, 0, 0]     // ~104 m east
    ]
  };
  var t = tcx.build(R);
  var ds = (t.match(/<DistanceMeters>[\d.]+<\/DistanceMeters>/g) || [])
             .map(function (m) { return parseFloat(m.replace(/[^\d.]/g, '')); });
  var lastTp = ds[ds.length - 1];
  assert(lastTp < 400, 'TCX cumulative distance skips the paused relocation (got ' + Math.round(lastTp) + ' m, old code ~18 km)');
  // FIT carries the same fix; just assert it builds without ballooning the total field is exercised elsewhere.
  assert(fit.build(R).length > 0, 'FIT still builds with a paused relocation');
  console.log('#6 pause-aware export distance OK');
})();
