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
        lat: Math.round((lat0 + fy / mLat) * 1e6) / 1e6,
        lon: Math.round((lon0 + fx / mLon) * 1e6) / 1e6,
        speed: Math.sqrt(x[1] * x[1] + y[1] * y[1])
      };
    },
    reset: function () { init = false; haveV = false; }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { make: makeGpsFilter };
