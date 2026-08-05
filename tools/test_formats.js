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
    cad: 168, active: 58,   // run-level averages: wrist spm, and the timer clock
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
  assert(!/<gpxtpx:cad>/.test(gpx.build(sample(2))), 'gpx: ride suppresses wrist cadence');
  assert(gpx.build(sample(3)).indexOf('<type>hiking</type>') >= 0, 'gpx: hike type');
  assert(/<gpxtpx:cad>84</.test(gpx.build(sample(3))), 'gpx: hike keeps foot cadence');
  assert(g.indexOf('NaN') < 0 && g.indexOf('undefined') < 0, 'gpx: clean');
  console.log('GPX OK');
})();

/* ---------------- TCX ---------------- */
(function () {
  var r = sample(0), t = tcx.build(r);
  assert(t.indexOf('<?xml') === 0, 'tcx: xml header');
  assert(/<Activity Sport="Running">/.test(t), 'tcx: run -> Running');
  assert.strictEqual((t.match(/<Trackpoint>/g) || []).length, 4, 'tcx: one trackpoint per fix');
  assert.strictEqual((t.match(/<Track>/g) || []).length, 2, 'tcx: pause creates a track boundary');
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
  assert(!/<Cadence>/.test(tcx.build(sample(2))), 'tcx: wrist steps are not mislabeled as bike cadence');
  assert(!/RunCadence>/.test(tcx.build(sample(2))), 'tcx: ride suppresses wrist run cadence');
  assert(/Sport="Other"/.test(tcx.build(sample(1))), 'tcx: walk -> Other');
  assert(/Sport="Other"/.test(tcx.build(sample(3))), 'tcx: hike -> Other');
  assert(/RunCadence>84</.test(tcx.build(sample(3))), 'tcx: hike keeps foot cadence');
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
  var defs = {}, msgs = {
    records: [], events: [], file_id: null, lap: null, session: null, activity: null,
    file_creator: null, declared: {}
  }, pos = 14, end = b.length - 2;
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
      msgs.declared[global] = fields.map(function (fd) { return fd[0]; });
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
      else if (d.global === 21) msgs.events.push(rec);
      else if (d.global === 0) msgs.file_id = rec;
      else if (d.global === 19) msgs.lap = rec;
      else if (d.global === 18) msgs.session = rec;
      else if (d.global === 34) msgs.activity = rec;
      else if (d.global === 49) msgs.file_creator = rec;
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
  assert.deepStrictEqual(m.events.map(function (e) { return e[1]; }), [0, 1, 0, 4],
                         'fit: timer start, pause stop/start, final stop_all');
  assert.strictEqual(fit.build(sample(2)) && fitParse(fit.build(sample(2))).session[5], 2, 'fit: cycle sport = 2');
  assert.strictEqual(fitParse(fit.build(sample(2))).records[0][4], 0xFF,
                     'fit: ride suppresses wrist cadence');
  assert.strictEqual(fitParse(fit.build(sample(1))).session[5], 11, 'fit: walk sport = 11');
  assert.strictEqual(fitParse(fit.build(sample(3))).session[5], 17, 'fit: hike sport = 17');
  assert.strictEqual(fitParse(fit.build(sample(3))).records[0][4], 84,
                     'fit: hike keeps foot cadence');

  /* Field NUMBERS, checked against the FIT profile rather than against whatever
   * the writer happened to emit. total_timer_time in the activity message was
   * written as field 15 (undefined in message 34) until 1.28.0, so every decoder
   * silently dropped it — and a decoder that trusts the definition message, like
   * the one above, cannot notice. Note lap and session deliberately differ:
   * avg_speed is 13 in lap and 14 in session; HR is 15/16 vs 16/17. */
  assert.deepStrictEqual(m.declared[34], [253, 0, 1, 2, 3, 4, 5],
                         'fit: activity fields (total_timer_time MUST be 0, not 15)');
  assert.deepStrictEqual(m.declared[19], [254, 253, 2, 7, 8, 9, 13, 21, 15, 16, 17, 25],
                         'fit: lap field numbers match the profile');
  assert.deepStrictEqual(m.declared[18], [254, 253, 2, 7, 8, 9, 14, 22, 26, 25, 5, 16, 17, 18],
                         'fit: session field numbers match the profile');
  assert.deepStrictEqual(m.declared[20], [253, 0, 1, 5, 2, 6, 3, 4],
                         'fit: record field numbers match the profile');
  assert.deepStrictEqual(m.declared[0], [3, 4, 1, 2, 0], 'fit: file_id field numbers');
  assert.deepStrictEqual(m.declared[49], [0, 1], 'fit: file_creator field numbers');

  /* The summary values those fields now carry. */
  var r0 = sample(0);
  var timerS = r0.active || r0.mov || r0.dur;
  assert.strictEqual(m.activity[0], Math.round(timerS * 1000),
                     'fit: activity total_timer_time is readable at field 0');
  assert.strictEqual(m.session[8], Math.round(timerS * 1000), 'fit: session total_timer_time');
  var expectSpeed = Math.round(r0.dist / timerS * 1000);
  assert.strictEqual(m.session[14], expectSpeed, 'fit: session avg_speed = dist/timer');
  assert.strictEqual(m.lap[13], expectSpeed, 'fit: lap avg_speed (field 13, not 14)');
  assert.strictEqual(m.session[22], r0.egain, 'fit: session total_ascent');
  assert.strictEqual(m.lap[21], r0.egain, 'fit: lap total_ascent');
  assert.strictEqual(m.session[16], r0.avgHr, 'fit: session avg_heart_rate');
  assert.strictEqual(m.lap[15], r0.avgHr, 'fit: lap avg_heart_rate (field 15, not 16)');
  assert.strictEqual(m.lap[16], r0.maxHr, 'fit: lap max_heart_rate');
  assert.strictEqual(m.session[18], Math.round(r0.cad / 2),
                     'fit: session avg_cadence is strides/min');
  assert.strictEqual(fitParse(fit.build(sample(2))).session[18], 0xFF,
                     'fit: ride suppresses avg_cadence too');
  assert(m.file_creator, 'fit: file_creator message present');

  /* A measured flat route has a real 0 m ascent. Only a track with no altitude
   * samples at all should emit FIT's invalid marker. */
  var flat = sample(0);
  flat.egain = 0; flat.cad = 0;
  var fm2 = fitParse(fit.build(flat));
  assert.strictEqual(fm2.session[22], 0, 'fit: measured flat route keeps 0 m ascent');
  assert.strictEqual(fm2.session[18], 0xFF, 'fit: no cadence -> invalid, not 0 rpm');
  var noElevation = sample(0);
  noElevation.egain = 0;
  noElevation.pts = noElevation.pts.map(function (p) {
    var q = p.slice();
    q[3] = '';
    return q;
  });
  assert.strictEqual(fitParse(fit.build(noElevation)).session[22], 0xFFFF,
                     'fit: absent elevation data -> invalid ascent');

  console.log('FIT OK');
})();

/* Route-less workouts retain time/HR/cadence without ever encoding (0,0) as a
 * real position. GPX stays metadata-only; TCX omits Position; FIT uses profile
 * invalid markers for coordinates, distance and speed. */
(function () {
  var r = {
    name: 'No GPS hike', start: 1750000000000, act: 3, route: 0,
    dist: 0, dur: 180, mov: 150, active: 150, avgHr: 138, maxHr: 151,
    steps: 360, cad: 144, egain: 0, tz: 480,
    pts: [
      [1750000000, 0, 0, '', 130, 0, 140],
      [1750000060, 0, 0, '', 138, 0, 144],
      [1750000120, 0, 0, '', 151, 1, 148]
    ]
  };
  var gx = gpx.build(r);
  assert(gx.indexOf('<trk><name>No GPS hike</name><desc>No GPS route or distance was recorded.</desc><type>hiking</type>') >= 0,
         'route-less GPX retains activity metadata');
  assert(!/<trkpt\b/.test(gx) && gx.indexOf('lat="0"') < 0,
         'route-less GPX emits no fabricated trackpoint');
  var tx = tcx.build(r);
  assert.strictEqual((tx.match(/<Trackpoint>/g) || []).length, 3,
                     'route-less TCX retains sensor trackpoints');
  assert(tx.indexOf('<HeartRateBpm><Value>138</Value>') >= 0,
         'route-less TCX retains HR');
  assert(tx.indexOf('<Position>') < 0,
         'route-less TCX omits coordinates entirely');
  assert(tx.indexOf('<Notes>No GPS route or distance was recorded.</Notes>') >= 0,
         'route-less TCX explains its schema-required zero lap distance');
  var fm = fitParse(fit.build(r));
  assert.strictEqual(fm.records[0][0], 0x7FFFFFFF, 'route-less FIT latitude invalid');
  assert.strictEqual(fm.records[0][1], 0x7FFFFFFF, 'route-less FIT longitude invalid');
  assert.strictEqual(fm.records[1][5], 0xFFFFFFFF, 'route-less FIT record distance invalid');
  assert.strictEqual(fm.records[1][6], 0xFFFF, 'route-less FIT speed invalid');
  assert.strictEqual(fm.session[9], 0xFFFFFFFF, 'route-less FIT total distance invalid');
  assert.strictEqual(fm.records[1][3], 138, 'route-less FIT retains HR');
  console.log('ROUTE-LESS EXPORTS OK');
})();

/* Session clocks come from START/STOP; trackpoints keep actual fix time. */
(function () {
  var r = sample(0);
  r.start -= 30000;                       // GPS acquired 30 s after START
  r.dur = 90;
  r.active = 60;
  r.tz = 480;
  var startIso = new Date(r.start).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert(gpx.build(r).indexOf('<metadata><time>' + startIso + '</time>') >= 0,
         'gpx: metadata time is session START, not first fix');
  var tx = tcx.build(r);
  assert(tx.indexOf('<Id>' + startIso + '</Id>') >= 0, 'tcx: activity id uses session START');
  var fm = fitParse(fit.build(r));
  var fitStart = (Math.round(r.start / 1000) - 631065600) >>> 0;
  var fitEnd = (Math.round(r.start / 1000 + r.dur) - 631065600) >>> 0;
  assert.strictEqual(fm.session[2], fitStart, 'fit: session start_time uses START');
  assert.strictEqual(fm.session[253], fitEnd, 'fit: session timestamp uses elapsed STOP');
  assert.strictEqual(fm.activity[5], (fitEnd + r.tz * 60) >>> 0,
                     'fit: local_timestamp applies stored timezone offset');
  console.log('EXPORT SESSION CLOCKS OK');
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

  function xy(f, east, north, sec, acc) {
    var o = f.update(lat + north / 110540,
                     115.85 + east / (111320 * coslat), acc, sec);
    return { x: (o.lon - 115.85) * 111320 * coslat,
             y: (o.lat - lat) * 110540, speed: o.speed };
  }

  // (3) an equal/reordered timestamp is ignored. The old 1 ms coercion turned
  // a harmless 3 m delta into a 3000 m/s state and threw later points forward.
  var fd = K.make({ maxSpeed: 12 });
  var da = xy(fd, 0, 0, 10, 8);
  var dd = xy(fd, 3, 0, 10, 8);
  var dn = xy(fd, 6, 0, 11, 8);
  assert(Math.abs(dd.x - da.x) < 0.2, 'kalman: duplicate timestamp does not move state');
  assert(dn.speed <= 12.001 && dn.x > 0 && dn.x < 10,
         'kalman: sample after duplicate remains bounded and forward');

  // (4) a real 90-degree turn must not produce the old wide hook. This is the
  // failure a straight-only distance test cannot expose.
  var ft = K.make({ maxSpeed: 12, accelStd: 1.0 }), turn = [], maxEast = 0;
  for (var u = 0; u <= 20; u++) turn.push(xy(ft, 3 * u, 0, u, 8));
  for (var v = 21; v <= 40; v++) {
    var tv = xy(ft, 60, 3 * (v - 20), v, 8);
    turn.push(tv); if (tv.x > maxEast) maxEast = tv.x;
  }
  var turnPairs = turn.map(function (p) {
    return [lat + p.y / 110540, 115.85 + p.x / (111320 * coslat)];
  });
  assert(Math.abs(dist(turnPairs) - 120) / 120 < 0.03,
         'kalman: right-angle route distance stays within 3%');
  assert(maxEast < 63,
         'kalman: turn overshoot stays below 3 m (got ' + maxEast.toFixed(1) + ' m)');

  // (5) W3C accuracy is a 95%-confidence radius. A precise fix should pull
  // much harder than a fuzzy one after the same history.
  function accuracyPull(acc) {
    var fa = K.make({ maxSpeed: 12 });
    xy(fa, 0, 0, 0, 8); xy(fa, 3, 0, 1, 8); xy(fa, 6, 0, 2, 8);
    return xy(fa, 15, 0, 3, acc).x;
  }
  assert(accuracyPull(3) > accuracyPull(40) + 3,
         'kalman: reported confidence materially controls measurement gain');

  // (6) stale velocity is meaningless after a long GPS outage: re-anchor at
  // the returned fix rather than predicting beyond it.
  var fg = K.make({ maxSpeed: 12 });
  xy(fg, 0, 0, 0, 8); xy(fg, 3, 0, 1, 8);
  var gap = xy(fg, 100, 0, 100, 8);
  assert(Math.abs(gap.x - 100) < 0.2 && gap.speed === 0,
         'kalman: long gap re-anchors without stale-velocity overshoot');
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
