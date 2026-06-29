/* RunLog — chart smoothing.
 *
 * A centered Gaussian-weighted moving average. Chosen over alternatives
 * deliberately:
 *   - trailing moving averages lag (peaks drift right);
 *   - polynomial / spline fits can overshoot and invent features that
 *     were never in the data, which is worse than chop for workout data;
 *   - a centered kernel keeps every feature where it happened and just
 *     takes the shimmer off.
 *
 * vals  : array of numbers, null = missing sample (kept as null)
 * sigma : kernel width in samples (~window of +-3*sigma)
 * brk   : optional array; brk[i] truthy means a new segment starts at i
 *         (a pause) — smoothing never blends across it
 */
'use strict';

function ksmooth(vals, sigma, brk) {
  var n = vals.length;
  if (n < 3 || !(sigma > 0)) return vals.slice();
  var halfW = Math.max(1, Math.round(sigma * 3));
  var w = [1], j;
  for (j = 1; j <= halfW; j++) w.push(Math.exp(-(j * j) / (2 * sigma * sigma)));

  var out = new Array(n);
  for (var i = 0; i < n; i++) {
    if (vals[i] === null || vals[i] === undefined) { out[i] = null; continue; }
    var acc = vals[i], wt = 1;
    for (j = 1; j <= halfW; j++) {              // walk left, stop at a pause
      var L = i - j;
      if (L < 0 || (brk && brk[L + 1])) break;
      if (vals[L] !== null && vals[L] !== undefined) { acc += vals[L] * w[j]; wt += w[j]; }
    }
    for (j = 1; j <= halfW; j++) {              // walk right, stop at a pause
      var R = i + j;
      if (R >= n || (brk && brk[R])) break;
      if (vals[R] !== null && vals[R] !== undefined) { acc += vals[R] * w[j]; wt += w[j]; }
    }
    out[i] = acc / wt;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = ksmooth;
