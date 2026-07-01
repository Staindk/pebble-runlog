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
  if (!run || !run.pts || run.pts.length < 1) return null;   // defensive: nothing to export
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
