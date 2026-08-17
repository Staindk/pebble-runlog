# Map-free position & distance estimator — implementation guide

Self-contained. Everything needed to build and validate the estimator, with no reference to
the research report. Constants below were read directly out of the validated implementation
(`est2d.py`, function `CF` with `blend=True, fine_psi=True`), not from memory.

**Target:** Android phone (all estimation) + Pebble companion watch (display only).
**Activities:** running, walking, cycling, coasting, stationary.
**Inputs:** phone accelerometer + gyroscope at ~50 Hz, raw GNSS at ~1 Hz.
**Outputs:** position at 10 Hz with zero added latency, speed, heading, cumulative distance,
and a 95% error radius.

---

## 0. Read this first — the decision

There are two designs here. Pick deliberately.

| | **CI** (this guide) | **CB** (§10, ~150 lines) |
|---|---|---|
| distance bias | **−1.6% … +1.3%** | +27% … +61% |
| distance added while stopped | **7–22 m/run** | 92–175 m/run |
| catastrophic map jumps | **0.00/run** | 0.52/run |
| track wiggle (turn ratio, 1=ideal) | **5.3** | 13.0 |
| heading error | **13.4°** | 21.5° |
| **median position error** | 10.3 m | **5.6 m** |
| p95 / cross-track / Fréchet | worse | **better** |
| CPU per 300 s of data | 0.36 s | 0.10 s |
| code size | ~600 lines | ~150 lines |

**Build CI if distance and pace are your product.** Users cannot perceive a 10 m vs 6 m
position offset, but they absolutely notice being told they ran 6.2 km on a 5 km course. A
+50% distance error is unshippable; that is what every Kalman variant tested produced,
because integrating a noisy velocity accumulates noise as distance.

**Build CB instead if absolute position is your product** — segment matching, turn-by-turn,
geofenced laps, heatmap contributions. On a position-only scoring, CB wins.

**Or build both.** CB is ~4× cheaper than CI. Display CB's coordinates, report CI's distance
and pace. This is standard practice — Garmin and Strava already derive distance from a
footpod or wheel sensor independently of the GPS track.

Verified across 56 held-out runs, CI beats the best of three tuned Kalman filters on 7 of 12
metrics, wins 56/56 paired runs on a balanced composite, and P(CI better) = 0.996–0.9996 under
20 000 random metric weightings. All four losses are in one cluster: absolute position.

---

## 1. The core idea in one page

Do not double-integrate acceleration, and do not filter the trajectory.

**(a) Everything needed is invariant to how the phone is carried.** For a rigidly attached
device with unknown mounting rotation $R$, the gyro reads $\omega^b = R^\top\omega^n$ and the
low-passed accelerometer gives $\hat g^b = R^\top \hat g^n$, so

$$\omega^b\cdot\hat g^b = \omega^n\cdot\hat g^n$$

**Vertical angular rate is measurable with zero knowledge of the mounting.** Measured: 0.045
rad/s RMS error against a 0.395 rad/s signal — 89% clean. Likewise $\lVert a\rVert$,
$\lVert\omega\rVert$, $a\cdot\hat g$. Horizontal acceleration in the nav frame is *not*
invariant, which is why strapdown fails here.

**(b) Count, don't integrate.** A tilt error $\varepsilon$ is indistinguishable from an accel
bias and injects $g\varepsilon$, giving position error $\tfrac12 g\varepsilon t^2$. At
$\varepsilon = 1°$: 8.6 m at 10 s, 77 m at 30 s, 308 m at 60 s. Stride counting at 5% error
gives 1.5 / 4.5 / 9 m. Counting turns $O(t^2)$ into $O(s)$.

**(c) Build the path as an affine image of a moment sum.**

$$\boxed{\,p(t) = b + a\,q(t),\qquad q(t)=\int ds\;e^{i\psi(t)}\,}$$

Positions are complex numbers. $b\in\mathbb C$ is the anchor, $a\in\mathbb C$ is a
rotation×scale — **4 real degrees of freedom total**. Fitting them is a closed-form complex
Procrustes problem. Crucially, **no temporal filter is ever applied to the trajectory**: the
output is an exact affine image of the raw intrinsic path, which is why corners survive at
zero latency while GNSS noise still averages down.

**(d) The arc-length increment is the only mode-specific object.**

| activity | detector | $ds$ contribution |
|---|---|---|
| walk / run | regular cadence present | $w_c\,\ell(f_k)$ at each stride event |
| cycle / coast | no cadence, fresh Doppler | $(1-w_c)\,u_{\rm dopp}\,dt$ |
| stationary | neither | $0$ |

with $\ell(f) = \theta_0 + \theta_1 f$ and $w_c$ a precision-weighted blend (§4.4).
Blending the *source* is continuous in $q$, hence continuous in $p$ — no switching, no offset
latching. Switching *estimators* instead is discontinuous and cost 276 m of false distance
when I tried it.

**(e) Distance is $\int|a|\,ds$, not track length.** GNSS noise therefore cannot inject
distance, and stationary intervals cannot accumulate it. This is the single most valuable
property in the design.

**Three timescales, from three information channels:**

| channel | what it fixes | why |
|---|---|---|
| IMU invariants | path *shape* | mounting-invariant, no bias integration |
| GNSS Doppler speed/course | *scale* and heading anchor | rate-domain, immune to position multipath |
| GNSS position (18 s window) | absolute *anchor* | bias-limited; reported honestly, never removed |

---

## 2. Constants

Every value validated. Do not retune without rerunning §7.

```
DT        = 0.02     # IMU period, 50 Hz
OUT_DT    = 0.10     # output period, 10 Hz
G         = 9.80665

# --- feature extraction -------------------------------------------------
GRAV_LP   = 0.15 Hz  # low-pass giving the gravity direction
BP_LO     = 0.5 Hz   # band-pass on ||a||, low corner
BP_HI     = 4.5 Hz   # band-pass on ||a||, high corner
ENV_LP    = 0.6 Hz   # envelope smoothing
MOVE_THR  = 0.9      # envelope threshold for gait-moving
REFRACT   = 0.22 s   # stride-event refractory period
CAD_SMOOTH= 5        # median window on per-step cadence (steps)

# --- step-length law  l(f) = th0 + th1*f --------------------------------
TH_PRIOR  = (0.42, 0.36)      # fallback / ridge centre
TH_PRIOR_SD = (0.35, 0.30)    # ridge strength
TH0_CLAMP = (0.05, 1.20)
TH1_CLAMP = (-0.10, 0.85)
L_PLAUS   = (0.15, 2.60) m over f in [1.2, 3.4] Hz   # else revert to prior
CALIB_TUK = 2.5      # Tukey constant, 1-D residuals
CALIB_ITER= 6

# --- heading (PI observer on GNSS course) -------------------------------
KP_H      = 0.25
KI_H      = 0.020
BH_CLAMP  = +/-0.15 rad/s
COURSE_ACC_MAX = 20 deg      # gate
COURSE_SPD_MIN = 1.2 m/s     # gate

# --- arc-length blend ---------------------------------------------------
CAD_LO, CAD_HI = 1.2, 3.9 Hz # plausible stride rate
CAD_WINDOW = 6.0 s           # look-back for the rate estimate
CAD_HOLD   = 3.0 s           # hysteresis on cadence availability
CV_REF     = 0.15            # stride-interval CV reference
AGREE_SD   = 0.60 m/s        # cadence-vs-Doppler agreement scale
SIG_CAD    = 0.12 m/s        # cadence-speed precision scale
SIG_DOP    = 0.25 m/s        # Doppler-speed precision scale
WC_TAU     = 0.5 s           # smoothing on w_c
DOP_FRESH  = 3.0 s           # Doppler staleness limit
DOP_DECAY  = 0.97 per tick   # applied once Doppler is >2.0 s stale
DOP_DEADBAND = 1.0 m/s       # below this, Doppler contributes nothing
WHEEL_MIN  = 1.5 m/s

# --- anchor fit (robust complex Procrustes) -----------------------------
W_WIN     = 18.0 s   # fix window.  DO NOT LENGTHEN - see Pitfall P10
MIN_FIX   = 5        # fixes needed before fitting
IRLS_ITER = 5
TUK       = 2.5
A_MAG_CLAMP = (0.80, 1.25)
A_ARG_CLAMP = +/-0.40 rad
SCALE_FLOOR = 1.0 m  # floor on the robust residual scale

# --- coherent-residual detector ----------------------------------------
COH_THR   = 0.90     # |mean of unit residuals| over the last 5 fixes
COH_MAG   = max(2.0*MAD, 9.0) m
FREEZE_T  = 8.0 s
SB_INFLATE= hypot(sig_beta, 0.7*mag), capped at 32 m

# --- output rate limiter ------------------------------------------------
RL_K      = 0.35
RL_C      = 0.40
V_FREEZE  = 0.04 m/s # when ds == 0 and still.  CRITICAL - Pitfall P3

# --- uncertainty --------------------------------------------------------
SIG_BETA  = 6.0 m    # irreducible correlated GNSS error
SB_RELAX  = 45.0 s   # relaxation of sb back to SIG_BETA
RHO_S     = 0.069    # per-metre dead-reckoning growth
GAP_K     = 0.5      # per-second growth after fix age > 1.5 s
STALE_K   = 0.25
```

---

## 3. Data structures

Total working memory is well under 5 kB.

```
FixRing[18]      : {t, z (complex), acc, u_dopp, course, course_acc}
QRing[~300]      : {t, q (complex), psi}    # 30 s at 10 Hz, for fix-time lookup
StrideRing[5]    : last 5 stride intervals  # for the CV regularity term
CalibAccum       : running sums for the theta regression

State:
  q        complex   accumulated moment path (metres)
  psi_int  float     integrated invariant yaw
  dlt, bh  float     heading offset, gyro-z bias
  b, a     complex   anchor, rotation x scale
  p_out    complex   displayed position
  corr     complex   pending correction
  theta    float[2]  step-length law
  wc       float     blend weight
  uh, t_ud float     held Doppler speed and its timestamp
  s0, sb   float     fit scale, inflated correlated-error term
  dist     float     cumulative distance
  frozen   float     detector freeze countdown
```

---

## 4. Algorithm

### 4.1 Per IMU sample (50 Hz) — O(1), ~20 flops

```
g       <- LP(accel, GRAV_LP)             # 3-vector, first-order
ghat    <- g / |g|
wz      <- dot(gyro, ghat)                # THE INVARIANT. no mounting knowledge needed
an      <- |accel|
bp      <- LP(an, BP_HI) - LP(an, BP_LO)  # band-pass on the norm
env     <- LP(|bp|, ENV_LP)
gait_moving <- env > MOVE_THR

# stride event: rising zero crossing of bp, while moving, past the refractory
if bp[k-1] <= 0 < bp[k] and gait_moving and (t - t_last_ev) > REFRACT:
    f_inst <- 1 / (t - t_last_ev)
    push f_inst; f_k <- median(last CAD_SMOOTH values)     # Pitfall P6
    push (t - t_last_ev) into StrideRing
    emit STRIDE_EVENT(t, f_k)
    t_last_ev <- t

# accumulate the gait-gated yaw integral at IMU RATE, not output rate (P7)
psi_cum_gated += (gait_moving ? wz : 0) * DT
```

`LP(x, fc)` is one-pole: `y += (1 - exp(-2*pi*fc*DT)) * (x - y)`.

### 4.2 Step-length law $\theta$ — robust ridge regression on Doppler

Since $u = \ell f = \theta_0 f + \theta_1 f^2$, regress **Doppler speed** on $[f, f^2]$. This
is a rate-domain observable, so it is immune to position multipath.

```
collect pairs (f_k, u_dopp) where course_acc < 40 deg, u_dopp > 0.6, f_k > 0.9
require >= 8 pairs, else theta <- TH_PRIOR
A <- [[f, f^2]];  lam <- diag(1/TH_PRIOR_SD^2);  pr <- TH_PRIOR
w <- 1
repeat CALIB_ITER:
    theta <- solve(A'WA + lam, A'W y + lam*pr)
    r <- y - A*theta
    s <- 1.4826 * MAD(r) + 1e-3
    w <- clip(1 - (r/(CALIB_TUK*s))^2, 0, inf)^2
clamp theta to TH0_CLAMP, TH1_CLAMP
if l(f) outside L_PLAUS anywhere on f in [1.2, 3.4]:  theta <- TH_PRIOR
```

Run this incrementally (every few seconds is ample) or as a batch over a trailing window.
**The cadence regressor must be median-smoothed** — see Pitfall P6.

### 4.3 Heading — PI observer on GNSS course

The invariant's bias is $b_g\!\cdot\!\hat g^{\,b}$, which **jumps discontinuously whenever the
phone is moved** (measured 0.044 rad/s error → 750° of drift over 300 s). So a static
de-biasing is inadmissible; the bias must be tracked.

```
each output tick:  dlt -= bh * OUT_DT
                   psi_int += (psi_cum_gated delta over this tick)   # see P7
                   psi_h = psi_int + dlt

on each fix with course_acc < COURSE_ACC_MAX and u_dopp > COURSE_SPD_MIN and moving:
    psi_at <- interpolate psi_int from QRing at t_fix     # Pitfall P8
    err    <- wrap_to_pi(course - (psi_at + dlt))
    dlt    += KP_H * err
    bh     <- clamp(bh - KI_H * err, BH_CLAMP)
```

**Do not robustify or gate these innovations.** Two attempts failed (on reported accuracy, and
on observed innovation scatter). The innovations *carry* the gyro-bias signal the observer
exists to correct; suppressing large ones suppresses exactly the needed corrections. A
magnetometer is not required and is not recommended — GNSS course plus gyro is a strictly
better pair with no magnetic-anomaly exposure.

### 4.4 Arc-length blend — precision-normalised

```
# cadence availability, from the invariant only
rate <- (#stride events in last CAD_WINDOW) / (elapsed since oldest of them)
cad_ok <- CAD_LO < rate < CAD_HI ;  hold CAD_HOLD seconds of hysteresis

dopp_fresh <- (t - t_ud) < DOP_FRESH
if (t - t_ud) > 2.0:  uh *= DOP_DECAY        # a dead channel cannot persist
u_eff <- (dopp_fresh and uh > DOP_DEADBAND) ? uh : 0     # deadband => stationary freeze

# regularity: real gait has stride-interval CV 5-8%; spurious detections are far higher
if StrideRing has >= 3 entries and (t - t_last_ev) < 1.5:
    reg <- 1 / (1 + (CV(StrideRing) / CV_REF)^2)
else:
    reg <- 0

u_cad <- l(f_k) * f_k
if dopp_fresh and uh > 0.5:
    agree    <- exp(-(u_cad - uh)^2 / (2 * AGREE_SD^2))
    prec_dop <- 1 / SIG_DOP^2
else:
    agree    <- 1
    prec_dop <- 0                            # ABSENT, not merely uncertain

prec_cad <- reg * agree / SIG_CAD^2
w_target <- (prec_cad + prec_dop > 0) ? prec_cad/(prec_cad + prec_dop) : 0
wc       <- wc + (w_target - wc) * OUT_DT / WC_TAU        # clamp [0,1]
```

**The normalisation is load-bearing.** With un-normalised $w_c = \text{reg}\cdot\text{agree}$,
a missing Doppler channel silently discards ~22% of arc length because nothing takes up the
slack. Normalising over *available* sources makes $\text{prec\_dop}=0 \Rightarrow w_c=1$
exactly, so the estimator degrades to a pure stride count rather than under-reporting.

### 4.5 Accumulate $q$ — incrementally, never by re-evaluation

```
ds <- 0
on each STRIDE_EVENT:
    l_k <- max(theta0 + theta1*f_k, 0)
    ds  += wc * l_k
    q   += wc * l_k * exp(i*psi_h)           # INCREMENTAL. Pitfall P2

if wc < 1:
    dsw <- (1 - wc) * u_eff * OUT_DT
    ds  += dsw ;  q += dsw * exp(i*psi_h)

dist += |a| * ds                             # distance from ds, NOT track length

# intra-stride interpolation so heading changes show up before the next step lands
frac    <- clamp((t - t_last_ev) * f_k, 0, 1)   # 0 if not gait-moving
q_live  <- q + frac * wc * l(f_k) * exp(i*psi_h)
push (t, q_live, psi_int) into QRing
```

### 4.6 Anchor fit — robust complex Procrustes, closed form

Run **only when a new fix arrives**, over the trailing `W_WIN` of fixes.

```
require >= MIN_FIX fixes in window
q_i   <- QRing lookup of q_live at each fix time t_i
q_ref <- QRing lookup at the NEWEST fix time
qc    <- q_i - q_ref              # centre on the newest fix
zz    <- fix positions (complex)

# --- coherent-residual detector: FREEZE and INFLATE, never translate -----
r0  <- zz - (b + a*qc)
mad <- 1.4826 * MAD(|r0|)
tail <- last 5 of r0
coh  <- | mean( tail / |tail| ) |          # 1.0 = perfectly aligned
mag  <- | mean(tail) |
if coh > COH_THR and mag > max(2*mad, 9.0):
    frozen <- FREEZE_T
    sb     <- min(hypot(sb, 0.7*mag), 32.0)

# --- IRLS. Weights FROZEN on the final pass so a, b, centroid agree (P5) --
w <- 1
for it in 0..IRLS_ITER:
    W  <- sum(w);  mq <- sum(w*qc)/W;  mz <- sum(w*zz)/W
    a_new <- ( sum(w*conj(qc)*zz) - conj(mq)*mz*W )
             / ( sum(w*|qc|^2) - |mq|^2*W )
    r  <- zz - (mz + a_new*(qc - mq))
    s  <- max(1.4826*MAD(|r|), SCALE_FLOOR)
    if it < IRLS_ITER - 1:
        w <- clip(1 - (|r|/(TUK*s))^2, 0, inf)^2

if frozen <= 0:
    a <- clamp(|a_new|, A_MAG_CLAMP) * exp(i * clamp(arg(a_new), A_ARG_CLAMP))
b  <- mz - a*mq                   # value at qc = 0, i.e. at the newest fix
s0 <- max(s / sqrt(sum(w)), 1.5)

corr <- (b + a*(q_live - q_ref)) - p_out    # pending correction
```

Note `s = 1.4826*MAD(|r|)` here is the *validated* choice even though it under-estimates
$\sigma$ for 2-D residuals — the statistically correct `median(|r|)/1.177` with a looser
constant measured worse. See Pitfall P9.

**Divergence guard:** if 5 consecutive fixes are gated out, reset `b` to the fix and inflate
`sb`. Never reset `a` or `theta` on a *position* anomaly.

### 4.7 Output tick (10 Hz)

```
dq   <- q_live - q_live_prev

# v_max must reflect the LIVE motion state (Pitfall P3)
if cad_ok and gait_moving:  usp <- |a| * l(f_k) * f_k
elif wheeled:               usp <- uh
else:                       usp <- 0

freeze <- still and ds == 0            # still = not gait_moving and u_eff < 0.5
v_max  <- freeze ? V_FREEZE : RL_K * max(usp, 0.5) + RL_C

stp  <- (|corr| > v_max*OUT_DT) ? corr/|corr| * v_max*OUT_DT : corr
corr -= stp
p_out += a*dq + stp                    # shape passes through UNDELAYED
```

`a*dq` is the true motion increment and is never rate-limited; only the anchor correction is.
This is why there are zero catastrophic jumps and why corners survive at zero latency.

Emit: `p_out`, `speed = usp`, `heading = psi_h + arg(a)`, `distance = dist`.

### 4.8 Uncertainty

```
sb   += (SIG_BETA - sb) * OUT_DT / SB_RELAX      # relax after inflation
gap   = max(t - t_newest_fix - 1.5, 0)
dr    = |q_live - q_ref|
stale = wheeled ? max(t - t_ud - 1.5, 0) : 0

r95 = 1.96 * sqrt( s0^2 + sb^2 + (RHO_S*dr)^2 + (GAP_K*gap)^2
                   + (STALE_K*stale*max(uh,1))^2 + |corr|^2 )
```

`sb` is **carried as irreducible and reported — never estimated and removed.** Six separate
attempts to model out the correlated GNSS bias all failed, and each drove coverage from 0.98
to 0.13–0.44. Position and bias enter the measurement identically; only a weak
temporal-spectrum prior distinguishes them, and acting on it converts a bounded error into an
unbounded one. Measured coverage with this formula: **0.97–1.00 against a 0.95 target.**

### 4.9 Fixed-lag revision (optional, W = 3 s)

Re-run §4.6 with fixes up to $t$ and re-apply to the buffered $q$ over $[t-W, t]$. Monotone
$ds$ and positive $|a|$ make backward motion and kinks structurally impossible. $W\approx2$–5 s
is not arbitrary: a level shift is indistinguishable from an outlier until 2–3 samples after
onset, which at 1 Hz is 2–3 s.

---

## 5. Pitfalls — every one of these actually happened

Highest-value section. Each has a symptom you can test for (§7).

| # | Mistake | Symptom |
|---|---|---|
| **P1** | Rate-limiting the **trajectory** instead of the slow parameters | median 38 m, 230 m, 309 m — I did this **three times** |
| **P2** | Evaluating $q=\theta_0N+\theta_1F$ with the *current* $\theta$ instead of accumulating incrementally | every $\theta$ update retroactively rescales the whole path from the origin |
| **P3** | $v_{\max}$ gated on the *held* cadence flag, or a stale $f_k$ | 24–88 m of false distance **while $ds\equiv0$**; and without `V_FREEZE`, a 120 s stop wanders 66 m — the "GPS blob at the start line" |
| **P4** | Decaying the mode-switch offset instead of latching it | 276 m of false distance |
| **P5** | Updating IRLS weights on the final pass | $a$ and $b$ inconsistent; heading error 11° → 20° |
| **P6** | Using *instantaneous* per-step cadence as the calibration regressor | errors-in-variables dilution biases $\theta$ — and distance — ~23% low |
| **P7** | Gating the heading increment at the **output** rate | mis-assigns ≤100 ms of gyro rate per stop/start; invisible normally, costs ~9% of outage p95 |
| **P8** | Back-computing fix-time heading from an *ungated* cumulative sum | over-subtracts across every stop; use the buffer |
| **P9** | Using `median(\|r\|)/1.177` (correct for 2-D) with a loose Tukey constant | weights too mild; anchor stops averaging. The validated pair is `1.4826*MAD(\|r\|)` with `TUK=2.5` |
| **P10** | Lengthening `W_WIN` past 18 s | worse. Bounded by heading *drift within* the window, which the rotation cannot absorb. 18 s optimal; 30/45/60/90 s all measured worse |
| **P11** | Applying a static gyro-bias estimate | the invariant's bias jumps at every placement change → 750° of drift |
| **P12** | Gating or robustifying the heading-observer innovations | two attempts, both worse. Those innovations are the signal |
| **P13** | Modelling and subtracting the GNSS bias | six attempts, all failed; coverage collapses 0.98 → 0.13–0.44 |
| **P14** | Feeding the estimator from a **fused/filtered** location provider | distance bias +0.6% → **+37%**, heading 11° → 27° |
| **P15** | Streaming the watch IMU and fusing it | measured worse in *every* scenario; cross-device cadence checks false-fire (−38…−46% distance) |

Also rejected after measurement, so don't spend time on them: strapdown INS on the phone IMU
(worst of 8 methods); feeding the cadence channel into a Cartesian filter as a speed
pseudo-measurement (harmful in three independent tests); low-pass filtering the yaw rate
(destroys as much turn signal as noise); a centripetal speedometer
$u=\sqrt{\lVert\bar f\rVert^2-g^2}/|\dot\psi|$ (needs $\lVert f\rVert$ to 0.63% of $g$, but
accelerometer scale error alone is 0.8%, and 75% of cycling has $|\dot\psi|<0.1$).

---

## 6. Android platform notes

Verified against current documentation, August 2026. Re-check before committing.

**Use the raw GNSS provider.** The fused provider blends GPS with Wi-Fi and cell, and when
navigating may snap to the nearest road by non-public logic. Both break the model: pre-smoothing
destroys the Doppler/position independence the architecture relies on, and road snapping
invalidates the multipath model. Cost of getting this wrong is P14. Use `GPS_PROVIDER` via
`LocationManager`, or `FusedLocationProviderClient` with `PRIORITY_HIGH_ACCURACY` **only** if
you have verified on your target devices that it is not filtering.

**Validate the accuracy fields per device.** `getSpeedAccuracyMetersPerSecond()` and
`getBearingAccuracyDegrees()` drive the $\theta$ calibration, the heading observer, and the
blend gate. Good news: if the fields are *absent* and you substitute a constant (e.g. 10°),
the estimator is unharmed. The dangerous case is fields present and wrong, and there is no
in-algorithm remedy (P12). Check with Google's GnssLogger before trusting them.

**Raw carrier phase is opportunistic, not a requirement.** Accumulated delta range (ADR) is
optional and chipset-dependent — broadly Pixel and non-Snapdragon flagships expose it, Samsung
Exynos yes, Samsung Snapdragon no. Usable only when `ADR_STATE_VALID` is set and neither
`ADR_STATE_RESET` nor `ADR_STATE_CYCLE_SLIP`; duty-cycling breaks continuous phase tracking. A
device reporting zero usable ADR in open sky with duty-cycling off does not support it.

**IMU delivery is batched and irregular.** The estimator tolerates ~15% frozen-sensor duty, but
don't rely on it: timestamp every sample from the sensor event, gate the heading integration on
real elapsed time rather than a nominal $\Delta t$, and hold a foreground service so doze does
not silently kill the stream mid-run.

**The watch.** Pebble Time 2 / Pebble 2 Duo run open-source PebbleOS; Core Devices has stated it
does not intend to add GPS, cellular, or faster processors — these are phone companions. So all
GNSS and all estimation live on the phone. Health tracking is among PebbleOS's largest power
consumers, reinforcing P15: send a **1 Hz, ~8-byte** summary packet (envelope RMS, dominant
frequency, HR, quality) used only for display and a stationarity cross-check. Do not stream
watch IMU. PebbleOS and both mobile apps are open source on GitHub.

**Log from day one** or field failures are undiagnosable: $w_c$, $\theta$, $|a|$, $\arg a$,
active $ds$ source, `sb`, `r95`, stride events, the ZV flag, detector firings — plus raw sensor
streams so you can replay offline.

---

## 7. Acceptance tests

`tests_ci.py` implements all 12 against the reference. Port these; each maps to a real bug.

| # | Test | Assertion | Guards |
|---|---|---|---|
| T1a | Stationary distance | 120 s stationary → reported distance < 5 m | design claim |
| T1b | Stationary wander | committed track moves < 15 m over 120 s | **P3** |
| T2 | Distance vs GNSS noise | vary GNSS $\sigma$ 2→14 m; distance spread < 5% | headline claim |
| T3a | Step bound | no output step exceeds a plausible speed | **P1** |
| T3b | Jumps | zero steps > 15 m in 1 s | **P1** |
| T4 | Causality | extending the horizon cannot change committed past output (bit-identical) | **P2** |
| T5 | Blend normalisation | kill Doppler entirely → distance changes < 15% | §4.4 |
| T6 | Mounting invariance | rotate *both* sensor streams by arbitrary $R$ → $\omega\cdot\hat g$ unchanged to 1e-9 | soundness |
| T7 | Heading gate rate | IMU-rate beats output-rate on outage p95 (8 seeds, 2 scenarios — effect is only ~9%, so a 3-seed test is underpowered) | **P7** |
| T8 | IRLS consistency | weighted residual mean is zero at the returned solution | **P5** |
| T9 | Robust scale | `median(\|r\|)/1.177` recovers $\sigma$ for 2-D residuals (documents the P9 trap) | **P9** |
| T10 | Calibration | coverage in [0.90, 1.00] on nominal *and* with lying accuracy metadata | **P13** |
| T11 | Provider | raw gives far better distance bias than fused | **P14** |
| T12 | Cycling | cycling distance bias within ±15% | blend works |

T2, T1a/T1b and T10 are the ones that matter most — they test the three structural claims.

---

## 8. Validation gate — do this before you commit

Everything above comes from a simulator, which encodes its author's assumptions about gait and
GNSS error. One session breaks that circularity.

**Setup:** a 400 m athletics track (geometry known to <0.1 m, no RTK needed). Cones every 50 m.
Ideally a surveyed ~30 m covered section for repeatable GNSS denial.

**Protocol (~50 min):** 8 laps running with announced phone transitions (pocket → hand →
armband → backpack); 4 laps walking; 6 laps cycling including one coast-down and two cone
slaloms; 3 × 60 s stationary holds at a marked cone; 2 laps with the watch removed. Log raw
phone IMU + raw GNSS (position, Doppler speed, course, all accuracy fields, satellite count).

**Two endpoints discriminate the designs and need no expensive reference:**

1. **False distance across the three stationary holds.** Predicted ~0 for CI; 1–3 m per 60 s
   hold for a Kalman filter.
2. **Per-50 m arc-length bias.** Predicted within a few percent.

Then: lap closure, heading error at slalom apexes, recovery after the covered section, and
`r95` coverage.

**Also measure your own GNSS error autocorrelation time $\tau$** from the position residuals
against the surveyed cones. The design assumes $\tau\approx35$ s. If your real $\tau$ is much
shorter, Kalman filters close part of the gap and you should re-run the comparison.

---

## 9. Expected performance

Measured on held-out seeds, 10 Hz output, zero added latency.

| metric | nominal | 45 s GNSS outage | cycling | mode transitions | hairpins |
|---|---|---|---|---|---|
| median error (m) | 7.3 | 8.2 | 11.8 | 15.6 | 7.6 |
| p95 error (m) | 18.3 | 24.1 | 34.3 | 33.4 | 14.7 |
| **distance bias (%)** | **+1.1** | **−1.8** | **+2.2** | **−1.5** | **−0.2** |
| false distance (m) | 8.4 | 6.7 | 21.5 | 3.9 | 0.0 |
| catastrophic jumps | 0 | 0 | 0 | 0 | 0 |
| r95 coverage (target 0.95) | 0.98 | 0.98 | 1.00 | 0.98 | 0.99 |
| heading error (°) | 11.3 | 10.6 | 13.5 | 22.0 | 10.5 |

CPU: 0.36 s per 300 s trace in unoptimised Python/NumPy on one core (~0.12% duty cycle); a
native implementation will be far below that. Memory < 5 kB.

---

## 10. Fallback: CB, if you decide against CI

Six states $[p_x, p_y, v_x, v_y, \beta_x, \beta_y]$. $\beta$ is a mean-reverting OU multipath
state, $\tau = 35$–60 s, $\sigma_\beta = 6$ m. Measurement $z = p + \beta$ with a two-component
inlier/outlier mixture: compute the posterior inlier weight and scale $R$ by $1/p_{\rm in}$.
Add Doppler velocity as a separate measurement on $v$. Report $r_{95}$ including
$P_{\beta\beta}$ — without it, coverage collapses.

Best median position error of anything tested (5.6 m), ~150 lines, insensitive to $\tau$ and
$\varepsilon_0$. Accept its +27…+61% distance bias, or correct distance with an independent
step counter.

---

## 11. Honest limits

1. **Median position is worse than a Kalman filter** — 10.3 m vs 5.6 m, and likewise p95,
   cross-track and Fréchet. Largely structural: the estimator refuses to chase position noise,
   which is what buys everything else. It sits only 1.4 m above its own 18 s-window oracle
   (5.9 m), so little is reachable without reducing heading error below ~10°, which would let
   `W_WIN` lengthen toward a 5.0 m oracle. That is the lever for future work.
2. **Mode transitions are the weakest scenario** in absolute terms (median 15.6 m) even though
   distance bias is −1.5%.
3. **Wheeled travel depends entirely on GNSS.** Arc length while cycling comes from Doppler, and
   a coasting bike is inertially silent — so stationarity there is detectable *only* via GNSS.
   A long tunnel while cycling has no fallback. There is no inertial alternative (§5, centripetal).
4. **Lying *course* accuracy is an unpatched vulnerability**: p95 degrades ~2.8×. Calibration
   survives (coverage 0.99), and it still beats a Kalman filter there, but the two in-algorithm
   fixes both failed.
5. **The gait-regularity term is heuristic.** `CV_REF = 0.15` came from gait statistics, not
   derivation. Most likely component to misbehave on limping, stairs, or trail running.
6. **Straight-line multipath is irreducible for every method.** On a straight constant-speed
   path, a lateral bias ramp is *exactly* indistinguishable from a constant heading offset.
   Curvature is what makes it observable. CI at least reports the uncertainty honestly.
7. **Untested:** real hardware, real GNSS, real gait, barometer, heart rate, raw GNSS ADR,
   treadmills, swimming, stroller pushing.
