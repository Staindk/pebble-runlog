/*
 * RunLog — watch side
 *
 * A simple run tracker for Pebble Time 2 (emery), Pebble 2 (diorite)
 * and Pebble Time (basalt).
 *
 * The watch shows live stats and reads the on-board heart-rate sensor;
 * the phone (PebbleKit JS, src/pkjs/index.js) records GPS, computes
 * distance/pace, and builds + exports the GPX file.
 *
 * Buttons:
 *   SELECT        start / pause / resume
 *   SELECT (hold) finish + save run
 *   BACK          exit (blocked while recording — finish first)
 */

#include <pebble.h>

// ---------------- Tunables ----------------
#define SAMPLE_PERIOD_S 5   // how often HR/steps are pushed to the phone
#define HR_RUN_PERIOD_S 10  // HR sensor sample period, s. The optical sensor is the
                            // biggest battery draw on the watch, and during running the
                            // firmware only refreshes BPM every ~50 s anyway, so a short
                            // period burns LED power for resolution we never get. Lower
                            // this for finer HR at the cost of battery.
#define HR_AVG_N        3   // running mean of the last N HR samples (peeked every SAMPLE_PERIOD_S)


typedef enum {
  STATE_READY = 0,
  STATE_RUNNING,
  STATE_PAUSED,
  STATE_SAVING,
  STATE_DONE,
} RunState;

// ---------------- State ----------------
// Persisted user settings (units, autopause, split alerts, max HR)
// and the last run statistics live here.  These symbols are defined
// here so they have a true definition rather than just a tentative
// definition via extern.  Without a definition the linker may
// synthesise common symbols which can lead to unpredictable results.
#include "runlog.h"
#include "hintbar.h"

// Define g_set with sensible defaults.  Kilometres and auto‑pause
// enabled mirrors the defaults used on the phone side.  Splits
// default on, max HR defaults to 180 (edit to taste).
Settings g_set = {
  .miles = false,
  .autopause = true,
  .splits = true,
  .max_hr = 190,
  .rest_hr = 0,
  .mode = MODE_RUN,
};

// Latest run summary used by the post‑run summary window.  All
// members are initialised to zero.  g_stats.trk will be filled with
// normalised track bytes from the phone on save.
RunStats g_stats;
static Window *s_window;
static Layer *s_chrome_layer;
static TextLayer *s_state_layer, *s_time_layer;
static TextLayer *s_dist_cap, *s_dist_layer;
static TextLayer *s_pace_cap, *s_pace_layer;
static TextLayer *s_hr_cap, *s_hr_layer;
static TextLayer *s_steps_cap, *s_steps_layer;
static AppTimer *s_flash_timer = NULL;
static int s_tick_unit = -1;     // active tick subscription (TimeUnits as int); -1 = none

static RunState s_state = STATE_READY;
static bool s_autopaused = false;
static bool s_gps_ok = false;
static int s_acc_m = -1;     // GPS horizontal accuracy in metres, -1 unknown
static int s_elapsed_s = 0;
static int s_hr = 0;
static int s_hr_ring[HR_AVG_N];   // recent valid bpm samples for the running mean
static int s_hr_ring_n = 0, s_hr_ring_i = 0;
static int s_dist_m = 0;
static int s_pace_s = 0;   // seconds per km, 0 = n/a
static int s_steps = 0;
static HealthValue s_steps_at_start = 0;
static int s_steps_paused = 0;      // steps taken during paused stretches — excluded from the activity total
static int s_steps_gross_last = 0;  // last gross (since-start) reading, to measure per-refresh deltas
static bool s_have_step_base = false;

static char s_time_buf[16], s_dist_buf[12], s_pace_buf[12];
static char s_hr_buf[12], s_steps_buf[8], s_flash_buf[20], s_acc_buf[20];
static TextLayer *s_acc_layer;

// chrome geometry (set during layout)
static int s_grid_top = 0, s_grid_mid = 0, s_grid_bot = 0, s_col_x = 0;
static Layer *s_actionbar = NULL;
static int s_content_w = 0;        // usable width left of the action bar
static GRect s_hr_cell;            // HR value cell, for the zone bar
static TextLayer *s_clock_layer = NULL;   // wall-clock time, top-right
static char s_clock_buf[12];
static void prv_update_actionbar(void);

// Forward declarations for settings helpers
static void prv_update_caps(void);
static void settings_load(void);
void settings_save_and_sync(void);
static void prv_up_click(ClickRecognizerRef rec, void *ctx);
static void prv_tick(struct tm *tick_time, TimeUnits units);
static void prv_apply_tick(void);

// ---------------- Helpers ----------------
/* Zones are 60/70/80/90 % of the configurable max HR (UP -> settings). */
GColor hr_zone_color(int hr) {
#if defined(PBL_COLOR)
  if (hr <= 0) return GColorDarkGray;
  int mx = g_set.max_hr;
  if (hr < mx * 60 / 100) return GColorVividCerulean;
  if (hr < mx * 70 / 100) return GColorIslamicGreen;
  if (hr < mx * 80 / 100) return GColorChromeYellow;
  if (hr < mx * 90 / 100) return GColorOrange;
  return GColorRed;
#else
  (void)hr;
  return GColorBlack;
#endif
}

static void prv_update_acc(void) {
  if (!s_acc_layer) return;
  if (!s_gps_ok || s_acc_m < 0) {
    snprintf(s_acc_buf, sizeof(s_acc_buf), "%s GPS--", mode_label());
  } else {
    snprintf(s_acc_buf, sizeof(s_acc_buf), "%s \xc2\xb1%dm", mode_label(), s_acc_m);
  }
  text_layer_set_text(s_acc_layer, s_acc_buf);
}

static void prv_update_time(void) {
  int h = s_elapsed_s / 3600, m = (s_elapsed_s % 3600) / 60, s = s_elapsed_s % 60;
  if (h > 0) {
    snprintf(s_time_buf, sizeof(s_time_buf), "%d:%02d:%02d", h, m, s);
  } else {
    snprintf(s_time_buf, sizeof(s_time_buf), "%02d:%02d", m, s);
  }
  text_layer_set_text(s_time_layer, s_time_buf);
}

static void prv_update_dist(void) {
  fmt_dist(s_dist_buf, sizeof(s_dist_buf), s_dist_m);
  text_layer_set_text(s_dist_layer, s_dist_buf);
}

static void prv_update_pace(void) {
  if (g_set.mode == MODE_CYCLE) fmt_speed(s_pace_buf, sizeof(s_pace_buf), s_pace_s);
  else                          fmt_pace(s_pace_buf, sizeof(s_pace_buf), s_pace_s);
  text_layer_set_text(s_pace_layer, s_pace_buf);
}

static void prv_update_hr(void) {
  if (s_hr <= 0) {
    snprintf(s_hr_buf, sizeof(s_hr_buf), "--");
  } else {
    snprintf(s_hr_buf, sizeof(s_hr_buf), "%d", s_hr);
  }
  text_layer_set_text_color(s_hr_layer, GColorBlack);  // always high-contrast
  text_layer_set_text(s_hr_layer, s_hr_buf);
  if (s_chrome_layer) layer_mark_dirty(s_chrome_layer);  // redraw the zone bar
}

static void prv_update_steps(void) {
  if (g_set.mode == MODE_CYCLE) { text_layer_set_text(s_steps_layer, "--"); return; }  // steps/cadence aren't shown for rides
  snprintf(s_steps_buf, sizeof(s_steps_buf), "%d", s_steps);
  text_layer_set_text(s_steps_layer, s_steps_buf);
}

static void prv_set_state_text(void) {
  // The big timer carries run state by COLOUR: black = recording, red =
  // paused, grey = idle/saving. The small line under it only shows extra
  // context (auto-pause / saving / transient flashes).
  GColor timer_col = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);  // idle
  const char *status = "";
  switch (s_state) {
    case STATE_RUNNING: timer_col = GColorBlack; break;
    case STATE_PAUSED:  timer_col = PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
                        status = s_autopaused ? "AUTO-PAUSE" : "PAUSED"; break;
    case STATE_SAVING:  status = "SAVING..."; break;
    default: break;
  }
  if (s_time_layer)  text_layer_set_text_color(s_time_layer, timer_col);
  if (s_state_layer) {
    text_layer_set_text_color(s_state_layer, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    text_layer_set_text(s_state_layer, status);
  }
  prv_update_caps();
  prv_update_actionbar();
  prv_apply_tick();          // match tick rate to run state (battery)
}

// right-edge labels: what UP / SELECT / DOWN do in the current state
static void prv_update_actionbar(void) {
  if (!s_actionbar) return;
  HbIcon mode_ic = (g_set.mode == MODE_CYCLE) ? HB_BIKE
                 : (g_set.mode == MODE_WALK)  ? HB_WALK : HB_RUN;
  switch (s_state) {
    case STATE_RUNNING:
      hintbar_set_icons(s_actionbar, HB_NONE, HB_PAUSE, HB_NONE, HB_NONE);
      break;
    case STATE_PAUSED:
      hintbar_set_icons(s_actionbar, HB_NONE, HB_START, HB_NONE, HB_NONE);
      break;
    case STATE_SAVING:
      hintbar_set_icons(s_actionbar, HB_NONE, HB_NONE, HB_NONE, HB_NONE);
      break;
    case STATE_READY:
    case STATE_DONE:
    default:
      // UP gear (settings) · SELECT check (start) · DOWN activity icon
      hintbar_set_icons(s_actionbar, HB_SETTINGS, HB_START, HB_NONE, mode_ic);
      break;
  }
}

static void prv_flash_done(void *data) {
  (void)data;
  s_flash_timer = NULL;
  prv_set_state_text();
}

static void prv_flash(const char *txt) {
  text_layer_set_text(s_state_layer, txt);
  if (s_flash_timer) {
    app_timer_reschedule(s_flash_timer, 1600);
  } else {
    s_flash_timer = app_timer_register(1600, prv_flash_done, NULL);
  }
}

// ---------------- Health ----------------
static void prv_set_hr_fast(bool fast) {
#if defined(PBL_HEALTH)
  health_service_set_heart_rate_sample_period(fast ? HR_RUN_PERIOD_S : 0);
#else
  (void)fast;
#endif
}

// The wall clock only changes by the minute — recompute it then, not every tick.
static void prv_update_clock(void) {
  if (!s_clock_layer) return;
  clock_copy_time_string(s_clock_buf, sizeof(s_clock_buf));
  text_layer_set_text(s_clock_layer, s_clock_buf);
}

// Called every SAMPLE_PERIOD_S while active (we're already awake for the timer).
// The sensor now samples slowly to save power, so we peek at the same cadence and
// keep a short running mean to take the shimmer off the reading. The smoothed value
// is what's shown and what's pushed to the phone.
static void prv_sample_hr(void) {
#if defined(PBL_HEALTH)
  time_t nowt = time(NULL);
  if (!(health_service_metric_accessible(HealthMetricHeartRateBPM, nowt, nowt)
        & HealthServiceAccessibilityMaskAvailable)) {
    return;   // HR unsupported / permission denied / unavailable — hold the last shown value
  }
  int v = (int)health_service_peek_current_value(HealthMetricHeartRateBPM);
  if (v > 0) {
    s_hr_ring[s_hr_ring_i] = v;
    s_hr_ring_i = (s_hr_ring_i + 1) % HR_AVG_N;
    if (s_hr_ring_n < HR_AVG_N) s_hr_ring_n++;
    int sum = 0, k;
    for (k = 0; k < s_hr_ring_n; k++) sum += s_hr_ring[k];
    s_hr = sum / s_hr_ring_n;
  }
  prv_update_hr();   // hold the last mean on a brief dropout rather than flicker
#endif
}

// Step count moves slowly and is only pushed every SAMPLE_PERIOD_S, so the
// today-sum (a health DB read) is refreshed at that cadence, not every second.
static void prv_refresh_steps(void) {
#if defined(PBL_HEALTH)
  HealthValue today = health_service_sum_today(HealthMetricStepCount);
  if (!s_have_step_base || today < s_steps_at_start) {   // start / midnight rollover
    s_steps_at_start = today - s_steps - s_steps_paused;  // keep the net count continuous across a rollover
    s_steps_gross_last = s_steps + s_steps_paused;
    s_have_step_base = true;
  }
  int gross = (int)(today - s_steps_at_start);           // steps since start, including any taken while paused
  // While paused (manual OR auto — both set STATE_PAUSED), fold the increment
  // into the paused offset so the net total stays frozen. The watch only *sends*
  // samples while RUNNING, so the phone receives this already-corrected count.
  if (s_state == STATE_PAUSED && gross > s_steps_gross_last)
    s_steps_paused += gross - s_steps_gross_last;
  s_steps_gross_last = gross;
  s_steps = gross - s_steps_paused;
  prv_update_steps();
#endif
}

// ---------------- Comms ----------------
void comms_send_cmd(uint8_t cmd);   /* public face of prv_send_cmd */
static void prv_send_cmd(uint8_t cmd) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_uint8(out, MESSAGE_KEY_CMD, cmd);
  app_message_outbox_send();
}

void comms_send_cmd(uint8_t cmd) { prv_send_cmd(cmd); }

void comms_send_rename(const char *name) {
  if (!name || !name[0]) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_cstring(out, MESSAGE_KEY_RENAME, name);
  app_message_outbox_send();
}

/* Summary screen confirmed a discard: wipe the run screen back to READY. */
void main_workout_discarded(void) {
  s_state = STATE_READY;
  s_autopaused = false;
  s_elapsed_s = 0; s_dist_m = 0; s_pace_s = 0; s_steps = 0;
  prv_update_time();
  prv_update_dist();
  prv_update_pace();
  prv_update_steps();
  prv_set_state_text();
  prv_flash("DISCARDED");
}

void phone_config_open(void) {
  prv_send_cmd(CMD_CONFIG);
  prv_flash("OPEN PHONE");
}

static void prv_send_sample(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int32(out, MESSAGE_KEY_HR, s_hr);
  dict_write_int32(out, MESSAGE_KEY_STEPS, s_steps);
  app_message_outbox_send();
}

/* Graph byte arrays: [minLo, minHi, maxLo, maxHi, sample0..N-1],
 * samples 0..100 with GRAPH_GAP marking holes. */
static void prv_parse_graph(Tuple *t, uint8_t *dst, int *n, int *mn, int *mx) {
  if (t->length < 5) { *n = 0; return; }
  const uint8_t *d = t->value->data;
  *mn = d[0] | (d[1] << 8);
  *mx = d[2] | (d[3] << 8);
  int k = (int)t->length - 4;
  if (k > GRAPH_MAX_PTS) k = GRAPH_MAX_PTS;
  memcpy(dst, d + 4, (size_t)k);
  *n = k;
}

static void prv_inbox(DictionaryIterator *iter, void *context) {
  (void)context;
  Tuple *t;
  bool saved = (dict_find(iter, MESSAGE_KEY_SAVED) != NULL);
  bool stats_changed = false;
  bool track_changed = false;

  if (dict_find(iter, MESSAGE_KEY_NOSAVE)) {
    // The phone had nothing to store (no usable GPS, or storage was full). Reset
    // to a clean READY screen and say NOT SAVED — don't hang on "SAVING..." and
    // don't leave the attempted run's numbers on screen.
    s_state = STATE_READY;
    s_autopaused = false;
    prv_set_hr_fast(false);
    s_elapsed_s = 0; s_dist_m = 0; s_pace_s = 0; s_steps = 0; s_hr = 0;
    s_hr_ring_n = 0; s_hr_ring_i = 0; s_steps_paused = 0;
    prv_update_time(); prv_update_dist(); prv_update_pace(); prv_update_steps(); prv_update_hr();
    prv_update_actionbar();
    prv_set_state_text();
    vibes_double_pulse();
    prv_flash("NOT SAVED");     // flash LAST, so prv_set_state_text can't overwrite it
    return;
  }

  if (saved) {
    s_state = STATE_DONE;
    vibes_long_pulse();
    prv_set_state_text();
    g_stats.dur_s = s_elapsed_s;
    g_stats.steps = s_steps;
    g_stats.dist_m = s_dist_m;
    g_stats.mov_s = 0;
    g_stats.avgp_s = 0;
    g_stats.avg_hr = 0;
    g_stats.max_hr = 0;
    g_stats.vo2 = 0;
    g_stats.egain_m = 0;
    g_stats.trk_n = 0;
    g_stats.trk_span_m = 0;
    g_stats.pace_n = 0;
    g_stats.hr_n = 0;
  }

  if ((t = dict_find(iter, MESSAGE_KEY_DIST))) {
    s_dist_m = (int)t->value->int32;
    prv_update_dist();
    // capture final distance for summary
    g_stats.dist_m = s_dist_m;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_PACE))) {
    s_pace_s = (int)t->value->int32;
    prv_update_pace();
  }
  if ((t = dict_find(iter, MESSAGE_KEY_GPSOK))) {
    s_gps_ok = (t->value->int32 != 0);
    if (!s_gps_ok) s_acc_m = -1;
    layer_mark_dirty(s_chrome_layer);
    prv_update_acc();
  }
  if ((t = dict_find(iter, MESSAGE_KEY_ACC))) {
    s_acc_m = (int)t->value->int32;
    layer_mark_dirty(s_chrome_layer);
    prv_update_acc();
  }
  if ((t = dict_find(iter, MESSAGE_KEY_SPLIT))) {
    vibes_double_pulse();
    light_enable_interaction();
    snprintf(s_flash_buf, sizeof(s_flash_buf), "%s %d",
             g_set.miles ? "MI" : "KM", (int)t->value->int32);
    prv_flash(s_flash_buf);
  }
  if ((t = dict_find(iter, MESSAGE_KEY_AVGP))) {
    g_stats.avgp_s = (int)t->value->int32;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_AVGHR))) {
    g_stats.avg_hr = (int)t->value->int32;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_MAXHR))) {
    g_stats.max_hr = (int)t->value->int32;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_VO2))) {
    g_stats.vo2 = (int)t->value->int32;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_MOVS))) {
    g_stats.mov_s = (int)t->value->int32;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_EGAIN))) {
    g_stats.egain_m = (int)t->value->int32;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_TSPAN))) {
    g_stats.trk_span_m = (int)t->value->int32;
    track_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_TRACK))) {
    // track bytes come as even‑length sequence of x,y pairs in 0..200
    uint8_t *bytes = t->value->data;
    size_t len = t->length;
    size_t n = len / 2;
    if (n > TRACK_MAX_PTS) n = TRACK_MAX_PTS;
    g_stats.trk_n = (int)n;
    for (size_t i = 0; i < n; i++) {
      g_stats.trk[i].x = bytes[2*i];
      g_stats.trk[i].y = bytes[2*i + 1];
    }
    track_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_EXPST))) {
    Tuple *te = dict_find(iter, MESSAGE_KEY_EXPERR);
    int experr = te ? (int)te->value->int32 : 0;
    // upload status: 0 uploading, 1 ok, 2 failed
    int st = (int)t->value->int32;
    summary_set_upload(st, experr);
  }
  if ((t = dict_find(iter, MESSAGE_KEY_APAUSE))) {
    // phone-driven auto-pause: stop/restart the timer and show it in the pill
    if (t->value->int32) {
      if (s_state == STATE_RUNNING) {
        s_state = STATE_PAUSED;
        s_autopaused = true;
        vibes_short_pulse();
      }
    } else {
      if (s_state == STATE_PAUSED && s_autopaused) {
        s_state = STATE_RUNNING;
        s_autopaused = false;
        vibes_short_pulse();
      }
    }
    prv_set_state_text();
  }
  if ((t = dict_find(iter, MESSAGE_KEY_PACEG))) {
    prv_parse_graph(t, g_stats.pace_g, &g_stats.pace_n,
                    &g_stats.pace_min, &g_stats.pace_max);
    track_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_HRG))) {
    prv_parse_graph(t, g_stats.hr_g, &g_stats.hr_n,
                    &g_stats.hr_min, &g_stats.hr_max);
    track_changed = true;
  }

  if (saved || track_changed || (s_state == STATE_DONE && stats_changed)) {
    summary_window_push();
  }
}

// ---------------- Buttons ----------------
static void prv_select_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  switch (s_state) {
    case STATE_READY:
    case STATE_DONE:
      s_state = STATE_RUNNING;
      s_autopaused = false;
      s_elapsed_s = 0; s_dist_m = 0; s_pace_s = 0; s_steps = 0;
      s_hr = 0; s_hr_ring_n = 0; s_hr_ring_i = 0;   // don't carry the previous run's HR into this one
      s_steps_paused = 0;                            // and don't carry a paused-step offset
      s_have_step_base = false;
      g_stats.trk_n = 0; g_stats.trk_span_m = 0; g_stats.pace_n = 0; g_stats.hr_n = 0;
      prv_update_time(); prv_update_dist(); prv_update_pace(); prv_update_steps();
      prv_set_hr_fast(true);
      prv_send_cmd(CMD_START);
      vibes_short_pulse();
      break;
    case STATE_RUNNING:
      s_state = STATE_PAUSED;
      s_autopaused = false;
      prv_send_cmd(CMD_PAUSE);
      vibes_short_pulse();
      break;
    case STATE_PAUSED:
      s_state = STATE_RUNNING;
      s_autopaused = false;
      prv_send_cmd(CMD_RESUME);
      vibes_short_pulse();
      break;
    default:
      break;
  }
  prv_set_state_text();
}

static void prv_select_long(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_state == STATE_RUNNING || s_state == STATE_PAUSED) {
    s_state = STATE_SAVING;
    s_autopaused = false;
    prv_send_cmd(CMD_STOP);
    prv_set_hr_fast(false);
    prv_set_state_text();
  } else if (s_state == STATE_SAVING) {
    // escape hatch if the phone never confirms
    s_state = STATE_DONE;
    prv_set_state_text();
  }
}

static void prv_down_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_state == STATE_READY || s_state == STATE_DONE) {
    g_set.mode = (g_set.mode + 1) % MODE_COUNT;
    settings_save_and_sync();
    prv_update_caps();        // PACE <-> SPEED label
    prv_update_actionbar();   // DOWN activity icon (run/walk/bike)
    vibes_short_pulse();
  } else {
    prv_flash("MODE LOCKED");
  }
}

static void prv_back_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_state == STATE_RUNNING || s_state == STATE_PAUSED || s_state == STATE_SAVING) {
    prv_flash("HOLD SEL TO END");
  } else {
    window_stack_pop(true);
  }
}

static void prv_click_config(void *ctx) {
  (void)ctx;
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 1000, prv_select_long, NULL);  // deliberate hold to end (was 600 ms — too easy to trigger by accident)
  window_single_click_subscribe(BUTTON_ID_BACK, prv_back_click);
  // Allow the UP button to open the settings menu.  Users can adjust
  // units, auto‑pause and split alerts at any time when not recording.
  window_single_click_subscribe(BUTTON_ID_UP, prv_up_click);
  // DOWN cycles run / walk / ride while idle
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click);
}

// ---------------- Ticks ----------------
static void prv_tick(struct tm *tick_time, TimeUnits units) {
  (void)tick_time;
  static int cnt = 0;
  cnt++;
  if (s_state == STATE_RUNNING) {
    s_elapsed_s++;
    prv_update_time();
  }
  if (s_state == STATE_RUNNING || s_state == STATE_PAUSED) {
    if (cnt % SAMPLE_PERIOD_S == 0) { prv_sample_hr(); prv_refresh_steps(); }
  }
  if (units & MINUTE_UNIT) prv_update_clock();         // clock only ticks by the minute
  if (s_state == STATE_RUNNING && (cnt % SAMPLE_PERIOD_S == 0)) prv_send_sample();
}

/* The per-second tick is only needed while a run is active — the elapsed timer
 * counts seconds. On the READY screen and the post-run debrief only the wall
 * clock moves, so drop to MINUTE_UNIT there and cut tick wakeups ~60x. */
static void prv_apply_tick(void) {
  TimeUnits want = (s_state == STATE_RUNNING || s_state == STATE_PAUSED)
                     ? SECOND_UNIT : MINUTE_UNIT;
  if ((int)want != s_tick_unit) {
    s_tick_unit = (int)want;
    tick_timer_service_subscribe(want, prv_tick);
  }
}

// ---------------- Chrome (GPS dot + grid lines) ----------------
static void prv_chrome_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);

  // GPS dot: green = good fix (<=20 m), orange = weak fix, red = none
  GColor dot;
  if (!s_gps_ok)                          dot = PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
  else if (s_acc_m >= 0 && s_acc_m <= 20) dot = PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack);
  else                                    dot = PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack);
  graphics_context_set_fill_color(ctx, dot);
  graphics_fill_circle(ctx, GPoint(12, 12), 5);
#if !defined(PBL_COLOR)
  if (!s_gps_ok) {  // hollow dot = no fix on B&W
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, GPoint(12, 12), 3);
  }
#endif

  // grid lines (kept left of the action bar)
  int gw = s_content_w > 0 ? s_content_w : b.size.w;
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
  graphics_draw_line(ctx, GPoint(8, s_grid_top), GPoint(gw - 8, s_grid_top));
  graphics_draw_line(ctx, GPoint(8, s_grid_mid), GPoint(gw - 8, s_grid_mid));
  graphics_draw_line(ctx, GPoint(s_col_x, s_grid_top + 6), GPoint(s_col_x, s_grid_bot - 6));

  // heart-rate zone: a colour bar under the (always-black) HR number, so the
  // zone reads at a glance without tinting the digits an unreadable yellow
  if (s_hr > 0 && s_hr_cell.size.w > 0) {
    int bw = s_hr_cell.size.w / 2;
    int bx = s_hr_cell.origin.x + (s_hr_cell.size.w - bw) / 2;
    int by = s_hr_cell.origin.y + s_hr_cell.size.h - 9;
    GRect zb = GRect(bx, by, bw, 6);
    graphics_context_set_fill_color(ctx, hr_zone_color(s_hr));
    graphics_fill_rect(ctx, zb, 3, GCornersAll);
    graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    graphics_draw_round_rect(ctx, zb, 3);   // outline keeps even yellow legible
  }
}

// ---------------- UI construction ----------------
static TextLayer *prv_make_text(Layer *root, GRect frame, const char *font_key,
                                GTextAlignment align, GColor color) {
  TextLayer *tl = text_layer_create(frame);
  text_layer_set_background_color(tl, GColorClear);
  text_layer_set_text_color(tl, color);
  text_layer_set_font(tl, fonts_get_system_font(font_key));
  text_layer_set_text_alignment(tl, align);
  layer_add_child(root, text_layer_get_layer(tl));
  return tl;
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  const int W = b.size.w, H = b.size.h;
  const bool big = (W >= 180);  // emery vs basalt/diorite

  window_set_background_color(window, GColorWhite);

  const int ab_w = hintbar_width(W);
  s_content_w = W - ab_w;
  const int CW = s_content_w;

  const int bar_h = 22;
  const int timer_h = big ? 44 : 34;
  const int status_h = 16;
  s_grid_top = bar_h + timer_h + status_h;
  const int row_h = (H - s_grid_top) / 2;
  s_grid_mid = s_grid_top + row_h;
  s_grid_bot = H;
  s_col_x = CW / 2;

  s_chrome_layer = layer_create(b);
  layer_set_update_proc(s_chrome_layer, prv_chrome_update);
  layer_add_child(root, s_chrome_layer);

  // top bar: activity + GPS accuracy by the dot (left), wall-clock time (right).
  // The clock box was 80 px wide but only needs room for "HH:MM"; trimming it and
  // ending the accuracy box exactly where the clock box starts removes the ~30 px
  // frame overlap that let a long accuracy string collide with the time.
  s_acc_layer = prv_make_text(root, GRect(24, 2, CW - 76, 20),
                              FONT_KEY_GOTHIC_14, GTextAlignmentLeft,
                              PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  s_clock_layer = prv_make_text(root, GRect(CW - 52, 2, 44, 20),
                                FONT_KEY_GOTHIC_14, GTextAlignmentRight,
                                PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  prv_update_clock();

  // big elapsed timer — colour carries run state (set in prv_set_state_text)
  s_time_layer = prv_make_text(root, GRect(0, bar_h - 2, CW, timer_h + 4),
                               big ? FONT_KEY_LECO_42_NUMBERS
                                   : FONT_KEY_LECO_28_LIGHT_NUMBERS,
                               GTextAlignmentCenter, GColorBlack);

  // small status line under the timer (auto-pause / saving / transient flashes)
  s_state_layer = prv_make_text(root, GRect(0, bar_h + timer_h - 2, CW, status_h),
                                FONT_KEY_GOTHIC_14, GTextAlignmentCenter,
                                PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));

  // metric numbers in the LECO family, to match the timer
  const char *cap_font = big ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14;
  const char *val_font = big ? FONT_KEY_LECO_32_BOLD_NUMBERS : FONT_KEY_LECO_28_LIGHT_NUMBERS;
  const int cap_h = big ? 20 : 16;
  const int val_y = cap_h + 2;
  GColor cap_col = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);
  const int cw = CW / 2;

  // row 1: distance | pace
  s_dist_cap   = prv_make_text(root, GRect(0,  s_grid_top + 4, cw, cap_h), cap_font, GTextAlignmentCenter, cap_col);
  s_dist_layer = prv_make_text(root, GRect(0,  s_grid_top + val_y, cw, row_h - val_y), val_font, GTextAlignmentCenter, GColorBlack);
  s_pace_cap   = prv_make_text(root, GRect(cw, s_grid_top + 4, CW - cw, cap_h), cap_font, GTextAlignmentCenter, cap_col);
  s_pace_layer = prv_make_text(root, GRect(cw, s_grid_top + val_y, CW - cw, row_h - val_y), val_font, GTextAlignmentCenter, GColorBlack);

  // row 2: heart rate | steps
  s_hr_cap      = prv_make_text(root, GRect(0,  s_grid_mid + 4, cw, cap_h), cap_font, GTextAlignmentCenter, cap_col);
  s_hr_layer    = prv_make_text(root, GRect(0,  s_grid_mid + val_y, cw, row_h - val_y), val_font, GTextAlignmentCenter, GColorBlack);
  s_steps_cap   = prv_make_text(root, GRect(cw, s_grid_mid + 4, CW - cw, cap_h), cap_font, GTextAlignmentCenter, cap_col);
  s_steps_layer = prv_make_text(root, GRect(cw, s_grid_mid + val_y, CW - cw, row_h - val_y), val_font, GTextAlignmentCenter, GColorBlack);

  // remember the HR cell so the chrome layer can draw the zone bar in it
  s_hr_cell = GRect(0, s_grid_mid + val_y, cw, row_h - val_y);

  text_layer_set_text(s_hr_cap, "HR");
  text_layer_set_text(s_steps_cap, "STEPS");
  prv_update_caps();   // distance/pace captions (unit- and mode-aware)

  // right-edge action bar telling the side buttons' jobs
  s_actionbar = hintbar_create(GRect(CW, 0, ab_w, H));
  layer_add_child(root, s_actionbar);

  prv_set_state_text();
  prv_update_time();
  prv_update_dist();
  prv_update_pace();
  prv_update_hr();
  prv_update_steps();
  prv_update_acc();
}

static void prv_window_unload(Window *window) {
  (void)window;
  text_layer_destroy(s_acc_layer);
  text_layer_destroy(s_state_layer);
  text_layer_destroy(s_clock_layer);
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_dist_cap);   text_layer_destroy(s_dist_layer);
  text_layer_destroy(s_pace_cap);   text_layer_destroy(s_pace_layer);
  text_layer_destroy(s_hr_cap);     text_layer_destroy(s_hr_layer);
  text_layer_destroy(s_steps_cap);  text_layer_destroy(s_steps_layer);
  hintbar_destroy(s_actionbar); s_actionbar = NULL;
  layer_destroy(s_chrome_layer);
}

// ---------------- App lifecycle ----------------
static void prv_init(void) {
  // Load persisted settings on startup before constructing the UI.
  settings_load();
  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(prv_inbox);
  app_message_open(512, 256);

  prv_apply_tick();          // READY at boot -> MINUTE cadence
}

static void prv_deinit(void) {
  prv_set_hr_fast(false);  // restore default battery-friendly HR sampling
  tick_timer_service_unsubscribe();
  window_destroy(s_window);
  hintbar_unload_cache();  // free the shared icon bitmaps
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}

// -------------------------------------------------------------------------
// Settings helpers
//
// Persisted settings live in g_set.  These helpers load from the watch's
// persistent storage, save to it and send updates to the phone.  They
// also update UI captions when the unit setting changes.

static void prv_update_caps(void) {
  // distance and pace captions reflect km/mi units and the activity mode
  if (!s_dist_cap || !s_pace_cap) return;
  text_layer_set_text(s_dist_cap, g_set.miles ? "DIST MI" : "DIST KM");
  if (g_set.mode == MODE_CYCLE) {
    text_layer_set_text(s_pace_cap, g_set.miles ? "MPH" : "KM/H");
  } else {
    text_layer_set_text(s_pace_cap, g_set.miles ? "PACE/MI" : "PACE/KM");
  }
}

static void settings_load(void) {
  // Read persisted values or fall back to defaults defined in g_set
  if (persist_exists(PKEY_MILES))   g_set.miles     = persist_read_bool(PKEY_MILES);
  if (persist_exists(PKEY_AUTOP))   g_set.autopause = persist_read_bool(PKEY_AUTOP);
  if (persist_exists(PKEY_SPLITS))  g_set.splits    = persist_read_bool(PKEY_SPLITS);
  if (persist_exists(PKEY_MAXHR))   g_set.max_hr    = persist_read_int(PKEY_MAXHR);
  if (persist_exists(PKEY_MODE))    g_set.mode      = persist_read_int(PKEY_MODE);
  if (persist_exists(PKEY_RESTHR))  g_set.rest_hr   = persist_read_int(PKEY_RESTHR);
  // ensure values are within sensible ranges
  if (g_set.max_hr < 80 || g_set.max_hr > 220) g_set.max_hr = 190;
  if (g_set.rest_hr < 0 || g_set.rest_hr > 120) g_set.rest_hr = 0;
  if (g_set.mode < 0 || g_set.mode >= MODE_COUNT) g_set.mode = MODE_RUN;
}

void settings_save_and_sync(void) {
  // Persist each setting under its dedicated key
  persist_write_bool(PKEY_MILES,   g_set.miles);
  persist_write_bool(PKEY_AUTOP,   g_set.autopause);
  persist_write_bool(PKEY_SPLITS,  g_set.splits);
  persist_write_int(PKEY_MAXHR,    g_set.max_hr);
  persist_write_int(PKEY_MODE,     g_set.mode);
  persist_write_int(PKEY_RESTHR,   g_set.rest_hr);
  // Send the updated settings to the phone so pkjs can mirror them
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_uint8(out, MESSAGE_KEY_UNITS,  (uint8_t)(g_set.miles     ? 1 : 0));
    dict_write_uint8(out, MESSAGE_KEY_AUTOP,  (uint8_t)(g_set.autopause ? 1 : 0));
    dict_write_uint8(out, MESSAGE_KEY_SPLITP, (uint8_t)(g_set.splits    ? 1 : 0));
    dict_write_uint8(out, MESSAGE_KEY_MODE,   (uint8_t)g_set.mode);
    dict_write_uint8(out, MESSAGE_KEY_MHR,    (uint8_t)g_set.max_hr);   // for phone VO2max
    dict_write_uint8(out, MESSAGE_KEY_RHR,    (uint8_t)g_set.rest_hr);  // for VO2max reserve model
    app_message_outbox_send();
  }
  // Update UI to reflect units/mode immediately
  prv_update_caps();
  prv_update_pace();
  prv_update_acc();
}

// UP button: open the settings menu if not actively recording.  If
// recording or saving, ignore the press to avoid disrupting the run.
static void prv_up_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_state == STATE_RUNNING || s_state == STATE_PAUSED || s_state == STATE_SAVING) {
    // ignore during active run
    return;
  }
  settings_window_push();
}
