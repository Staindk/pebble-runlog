/* Validate artifacts produced by test_watch_screenshots.sh without adding an
 * image-library dependency. The PNG header proves platform geometry; hashes,
 * byte sizes and per-screen uniqueness catch failed/blank/stale captures. The
 * original PNGs remain available for the visual part of the regression pass. */
'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var out = process.argv[2] || '/tmp/runlog-watch-screenshots';
var screens = [
  'ready', 'settings', 'live', 'lap', 'totals', 'autopause',
  'route', 'stats', 'trends', 'actions'
];
var platforms = {
  emery: [200, 228],
  basalt: [144, 168]
};
var signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

Object.keys(platforms).forEach(function (platform) {
  var expected = platforms[platform];
  var hashes = {};
  screens.forEach(function (screen) {
    var file = path.join(out, platform + '-' + screen + '.png');
    var png = fs.readFileSync(file);
    assert(png.length > 1000, file + ' is unexpectedly small');
    assert(png.slice(0, 8).equals(signature), file + ' is not a PNG');
    assert.strictEqual(png.readUInt32BE(16), expected[0], file + ' width');
    assert.strictEqual(png.readUInt32BE(20), expected[1], file + ' height');
    var hash = crypto.createHash('sha256').update(png).digest('hex');
    assert(!hashes[hash], platform + ' captured the same pixels for ' +
           hashes[hash] + ' and ' + screen);
    hashes[hash] = screen;
  });
  console.log(platform + ' screenshot set OK (' + screens.length + ' distinct screens)');
});

console.log('ALL WATCH SCREENSHOTS PASSED');
