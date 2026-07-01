/* TCX (Garmin Training Center) builder (ES5) — dual-use: required by
 * index.js for uploads AND injected into tools/page.html for downloads.
 * Shares the run.pts model with gpx.js: [t, lat, lon, ele|'', hr, seg, cad].
 * Helpers are rl-prefixed so they don't collide with the page's own code. */
function rlTcxIso(t) { return new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function rlTcxEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function rlTcxRad(d) { return d * Math.PI / 180; }
function rlTcxCum(pts) {
  // cumulative metres along the track (haversine between fixes). A point flagged
  // seg==1 is the first fix after a pause; the gap to it is a relocation, not
  // distance travelled, so we carry the running total across it rather than add
  // the straight-line jump (which used to inflate the last trackpoint wildly).
  var out = [0], R = 6371000, i;
  for (i = 1; i < pts.length; i++) {
    if (pts[i][5] === 1) { out.push(out[i - 1]); continue; }
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
  if (!run || !run.pts || run.pts.length < 1) return null;   // defensive: nothing to export
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
