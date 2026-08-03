/* GPX 1.1 builder (ES5) — dual-use: required by index.js for uploads AND
 * injected into tools/page.html for downloads (see tools/build_page.js).
 * Heart rate + cadence via Garmin TrackPointExtension; pauses become
 * separate track segments.
 *
 * Helpers are rl-prefixed so they don't collide with the page's own code.
 *
 * run.pts entries: [t, lat, lon, ele|'', hr, segFlag, cad]
 *   t    unix seconds          ele  metres ('' if unknown)
 *   hr   bpm (0 = unknown)     cad  wrist steps/min (0 = unknown)
 *   segFlag 1 = first point after a pause (new <trkseg>)
 */

function rlGpxIso(t) {
  return new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function rlGpxEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rlGpxBuild(run) {
  if (!run || !run.pts || run.pts.length < 1) return null;   // defensive: nothing to export
  var o = [], act = (run.act >= 0 && run.act <= 3) ? run.act : 0;
  o.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  o.push('<gpx version="1.1" creator="RunLog for Pebble" ' +
         'xmlns="http://www.topografix.com/GPX/1/1" ' +
         'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n');
  o.push('<metadata><time>' + rlGpxIso(run.start ? run.start / 1000 : run.pts[0][0]) + '</time></metadata>\n');
  var type = ['running', 'walking', 'cycling', 'hiking'][act];
  o.push('<trk><name>' + rlGpxEsc(run.name) + '</name>');
  if (run.route === 0) {
    // GPX trackpoints require coordinates. A metadata-only track is preferable
    // to inventing a position for a disconnected/treadmill workout.
    o.push('<desc>No GPS route or distance was recorded.</desc><type>' + type + '</type>\n');
    o.push('</trk>\n</gpx>\n');
    return o.join('');
  }
  o.push('<type>' + type + '</type>\n');
  o.push('<trkseg>\n');
  for (var i = 0; i < run.pts.length; i++) {
    var p = run.pts[i];
    if (p[5] && i > 0) o.push('</trkseg>\n<trkseg>\n');
    o.push('<trkpt lat="' + p[1] + '" lon="' + p[2] + '">');
    if (p[3] !== '' && p[3] !== null && p[3] !== undefined) o.push('<ele>' + p[3] + '</ele>');
    o.push('<time>' + rlGpxIso(p[0]) + '</time>');
    var hr = p[4] > 0, cad = act !== 2 && p.length > 6 && p[6] > 0;
    if (hr || cad) {
      o.push('<extensions><gpxtpx:TrackPointExtension>');
      if (hr)  o.push('<gpxtpx:hr>' + p[4] + '</gpxtpx:hr>');
      // gpxtpx:cad is a per-foot rate; the stored value is the wrist step rate.
      if (cad) o.push('<gpxtpx:cad>' + Math.round(p[6] / 2) + '</gpxtpx:cad>');
      o.push('</gpxtpx:TrackPointExtension></extensions>');
    }
    o.push('</trkpt>\n');
  }
  o.push('</trkseg>\n</trk>\n</gpx>\n');
  return o.join('');
}

if (typeof module !== 'undefined' && module.exports)
  module.exports = { build: rlGpxBuild, iso: rlGpxIso };
