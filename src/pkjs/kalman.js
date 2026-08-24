/* RunLog — GPS track filter for phone-only position input.
 *
 * A constant-velocity Kalman filter. Each fix is (lat, lon, accuracy, t):
 *   - the current Core Android bridge forwards Location.getAccuracy(), a
 *     68%-confidence radius, which is converted to a per-axis standard
 *     deviation before it becomes measurement noise R;
 *   - a two-dimensional normalized-innovation gate down-weights a borderline
 *     residual and atomically rejects a measurement that is implausible for
 *     both the predicted covariance and its reported accuracy;
 *   - process noise comes from a plausible human acceleration (m/s^2), so a
 *     constant-velocity stride/pedal is tracked tightly while genuine turns
 *     and pace changes still come through;
 *   - velocity is estimated by the filter, bounded to the activity's physically
 *     plausible speed, rather than copied from one potentially noisy interval;
 *   - duplicate timestamps are ignored and long gaps re-anchor the state, so
 *     neither can launch a stale velocity far beyond the measured route.
 * Runs in a local metre plane anchored at the first fix; lat and lon are
 * independent position+velocity filters. This is the right tool when GPS is
 * the only signal (no onboard accel/baro to fuse on this hardware).
 *
 * dual-use: required by index.js, unit-tested in tools/test_formats.js.
 */
'use strict';

function makeGpsFilter(opts) {
  opts = opts || {};
  var SIGMA_A = opts.accelStd > 0 ? opts.accelStd : 1.0;  // process noise, m/s^2
  var MIN_SIGMA = opts.minSigma > 0 ? opts.minSigma : 1.5;
  var MAX_GAP = opts.maxGap > 0 ? opts.maxGap : 30;
  var MAX_SPEED = opts.maxSpeed > 0 ? opts.maxSpeed : 35;
  var INIT_SPEED_SIGMA = opts.initialSpeedStd > 0 ? opts.initialSpeedStd : 5;
  var ACC_CONFIDENCE = opts.accuracyConfidence > 0 && opts.accuracyConfidence < 1
      ? opts.accuracyConfidence : 0.68;
  var RADIUS_TO_SIGMA = 1 / Math.sqrt(-2 * Math.log(1 - ACC_CONFIDENCE));
  var INNOV_SOFT = opts.innovationSoft > 0 ? opts.innovationSoft : 9.21;
  var INNOV_HARD = opts.innovationHard > INNOV_SOFT ? opts.innovationHard : 13.82;
  var lat0 = 0, lon0 = 0, mLat = 0, mLon = 0;
  var init = false, lastT = 0;
  var x = [0, 0], y = [0, 0];              // per-axis [position_m, velocity_mps]
  var Px = [[0, 0], [0, 0]], Py = [[0, 0], [0, 0]];

  function measurementVariance(accM) {
    var radius = (typeof accM === 'number' && isFinite(accM) && accM >= 0)
        ? accM : 30;
    var sigma = Math.max(MIN_SIGMA, radius * RADIUS_TO_SIGMA);
    return sigma * sigma;
  }

  function begin(lat, lon, tSec, R) {
    lat0 = lat; lon0 = lon;
    mLat = 110540;
    mLon = Math.max(1, 111320 * Math.cos(lat * Math.PI / 180));
    x = [0, 0]; y = [0, 0];
    var v = INIT_SPEED_SIGMA * INIT_SPEED_SIGMA;
    Px = [[R, 0], [0, v]]; Py = [[R, 0], [0, v]];
    init = true; lastT = tSec;
  }

  function output(accepted, innovation2, robust, reanchored) {
    return {
      lat: Math.round((lat0 + y[0] / mLat) * 1e6) / 1e6,
      lon: Math.round((lon0 + x[0] / mLon) * 1e6) / 1e6,
      speed: Math.sqrt(x[1] * x[1] + y[1] * y[1]),
      accepted: accepted !== false,
      innovation2: innovation2 === undefined ? 0 : innovation2,
      robust: !!robust,
      reanchored: !!reanchored
    };
  }

  // Predict one axis without mutating it. A hard-rejected 2D observation must
  // leave both axes and lastT untouched so the next good fix predicts over the
  // complete interval since the last accepted measurement.
  function predict(s, P, dt) {
    var dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt2 * dt2, q = SIGMA_A * SIGMA_A;
    var p = s[0] + s[1] * dt;                       // predicted position
    var a = P[0][0], b = P[0][1], c = P[1][0], d = P[1][1];
    var p00 = a + dt * (b + c) + dt2 * d + q * dt4 / 4;   // F P F^T + Q
    var p01 = b + dt * d + q * dt3 / 2;
    var p10 = c + dt * d + q * dt3 / 2;
    var p11 = d + q * dt2;
    return { p: p, v: s[1], p00: p00, p01: p01, p10: p10, p11: p11 };
  }

  function correct(s, P, pred, z, R) {
    var Sinv = 1 / (pred.p00 + R);                   // H = [1 0], meas var R
    var p00 = pred.p00, p01 = pred.p01, p10 = pred.p10, p11 = pred.p11;
    var k0 = p00 * Sinv, k1 = p10 * Sinv;
    var innov = z - pred.p;
    s[0] = pred.p + k0 * innov;
    s[1] = pred.v + k1 * innov;
    P[0][0] = (1 - k0) * p00; P[0][1] = (1 - k0) * p01;
    P[1][0] = p10 - k1 * p00; P[1][1] = p11 - k1 * p01;
  }

  return {
    update: function (lat, lon, accM, tSec) {
      var R = measurementVariance(accM);
      var t = (typeof tSec === 'number' && isFinite(tSec))
          ? tSec : (init ? lastT + 1 : 0);
      if (!init) {
        begin(lat, lon, t, R);
        return output(true, 0, false, true);
      }
      var dt = t - lastT;
      if (!(dt > 0)) return output(false, 0, false, false); // stale/duplicate: never invent velocity
      if (dt > MAX_GAP) {
        begin(lat, lon, t, R);              // stale velocity is meaningless after an outage
        return output(true, 0, false, true);
      }
      var mx = (lon - lon0) * mLon, my = (lat - lat0) * mLat;
      var predX = predict(x, Px, dt), predY = predict(y, Py, dt);
      var ix = mx - predX.p, iy = my - predY.p;
      var d2 = ix * ix / (predX.p00 + R) + iy * iy / (predY.p00 + R);
      if (d2 > INNOV_HARD) return output(false, d2, false, false);

      // Borderline innovations are still useful, especially at a genuine turn,
      // but should pull less strongly than their optimistic reported radius.
      var robust = d2 > INNOV_SOFT;
      var updateR = robust ? R * (d2 / INNOV_SOFT) : R;
      correct(x, Px, predX, mx, updateR);
      correct(y, Py, predY, my, updateR);
      lastT = t;
      var speed = Math.sqrt(x[1] * x[1] + y[1] * y[1]);
      if (speed > MAX_SPEED) {
        var scale = MAX_SPEED / speed;
        x[1] *= scale; y[1] *= scale;
      }
      return output(true, d2, robust, false);
    },
    reset: function () { init = false; lastT = 0; }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { make: makeGpsFilter };
