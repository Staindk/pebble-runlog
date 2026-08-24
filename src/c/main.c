/*
 * RunLog — watch side
 *
 * A simple workout tracker for Pebble Time 2 (emery), Pebble 2 (diorite)
 * and Pebble Time (basalt).
 *
 * The watch shows live stats and reads the on-board heart-rate sensor;
 * the phone (PebbleKit JS, src/pkjs/index.js) records GPS, computes
 * distance/pace, and builds + exports the GPX file.
 *
 * Buttons:
 *   SELECT        start / pause / resume
 *   SELECT (hold) finish + save activity
 *   BACK          exit (blocked while recording — finish first)
 */

#include <pebble.h>

// ---------------- Tunables ----------------
#define SAMPLE_PERIOD_S       5   // active health cadence for run/walk/ride
#define HIKE_SAMPLE_PERIOD_S 30   // align hike Health reads with its low-duty HR period
#define SAMPLE_KEEPALIVE_S   10   // unchanged active sample refresh for run/walk/ride
#define HIKE_KEEPALIVE_S     60   // tolerate one missed hike sample before a keepalive
#define PAUSE_SAMPLE_PERIOD_S 60  // paused HR display; step totals are sampled at both boundaries
#define HR_RUN_PERIOD_S      10   // optical sensor period for run/walk/ride
#define HR_HIKE_PERIOD_S     30   // firmware refreshes active BPM slowly; avoid redundant LED work
#define HR_PAUSE_PERIOD_S    60   // paused HR is informational and excluded from workout aggregates
#define HR_AVG_N              3   // running mean of the last N health peeks
#define HR_PEAK_MAX_STEP_BPM 20   // a larger one-sample jump must be corroborated
#define WORKOUT_PAGE_COUNT    3
#define JOURNAL_RECORD_BYTES 12
#define JOURNAL_MAX_RECORDS 1024  // 8.5 h at 30 s; hikes retain 17 h at 60 s
#define JOURNAL_BATCH_RECORDS 25  // 300 bytes, safely inside the 512-byte outbox
#define JOURNAL_NORMAL_S     30
#define JOURNAL_HIKE_S       60
#define TARGET_ALERT_HOLD_S  20
#define TARGET_ALERT_GAP_S  120
#define LINK_RETRY_MIN_MS  1400
#define LINK_RETRY_MAX_MS 30000
#define REFRESH_TAP_GAP_MS     2500  // debounce deliberate screen taps


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

// Define g_set with sensible defaults.  Kilometres and auto-pause
// enabled mirrors the defaults used on the phone side.  Splits
// default on, max HR defaults to 190 (settings menu adjusts 150-205).
Settings g_set = {
  .miles = false,
  .autopause = true,
  .splits = true,
  .show_hr_zone = true,
  .max_hr = 190,
  .rest_hr = 0,
  .mode = MODE_RUN,
  .target_type = TARGET_OFF,
  .target_lo = 0,
  .target_hi = 0,
  .target_value = 0,
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
static TextLayer *s_hr_zone_layer;
static TextLayer *s_steps_cap, *s_steps_layer;
static AppTimer *s_flash_timer = NULL;
static AppTimer *s_send_timer = NULL;
static AppTimer *s_pause_sample_timer = NULL;
static int s_tick_unit = -1;     // active tick subscription (TimeUnits as int); -1 = none
static int s_hr_period_s = -1;   // avoid resetting the sensor when state text refreshes

static RunState s_state = STATE_READY;
// A SAVED packet may be retried after the watchapp has been closed. Accept it
// only while this process owns a live/finishing session; otherwise opening the
// app could resurrect yesterday's debrief over the fresh READY screen.
static bool s_accept_saved = false;
static bool s_autopaused = false;
static bool s_gps_ok = false;
static int s_acc_m = -1;     // GPS horizontal accuracy in metres, -1 unknown
static int s_elapsed_s = 0;
static int s_active_base_s = 0;
static time_t s_run_anchor = 0;
static time_t s_started_at = 0;
static int s_hr = 0;
static int s_hr_rendered = -1;
static int s_hr_ring[HR_AVG_N];   // recent valid bpm samples for the running mean
static int s_hr_ring_n = 0, s_hr_ring_i = 0;
static int s_dist_m = 0;
static int s_pace_s = 0;   // seconds per km, 0 = n/a
static int s_egain_live_m = 0;
static int s_moving_live_s = 0;
static int s_avg_hr_live = 0;
static int s_steps = 0;
static int s_steps_rendered = -999999;
static HealthValue s_steps_at_start = 0;
static int s_steps_paused = 0;      // steps taken during paused stretches — excluded from the activity total
static int s_steps_gross_last = 0;  // last gross (since-start) reading, to measure per-refresh deltas
static bool s_have_step_base = false;
static int s_last_sent_hr = -1;
static int s_last_sent_steps = -1;
static int s_last_sent_hr_peak = -1;
static time_t s_last_sample_sent_at = 0;
static int s_queued_hr = 0, s_queued_steps = 0, s_queued_hr_peak = 0;
static time_t s_queued_sample_at = 0;
// Resettable fixed-cadence countdown. Unlike a wall-clock deadline it cannot be
// disrupted by phone/watch time correction, and every RUNNING edge resets it.
static int s_health_countdown_s = 0;
// Peak of corroborated raw readings. s_hr remains a 3-sample mean for a readable
// display and a conservative fallback; a lone optical-sensor spike is rejected.
static int s_hr_peak_raw = 0;
static int s_hr_raw_prev = 0;
static time_t s_hr_raw_prev_at = 0;
static bool s_health_events_active = false;
static bool s_hr_read_from_event = false;
static int s_hr_access_mask = 0;
// Set false when AppMessage could not be opened at the size the protocol needs.
static bool s_msg_ok = false;
static uint32_t s_msg_out_size = 256;
// Sticky flag: any dict_write_* that did not return DICT_OK while building the
// message currently in the outbox.
static bool s_dict_full = false;

// A compact, unacknowledged watch-side sensor journal. It is carried in the
// same health packets we already send, and is removed only after the phone has
// durably stored it. A workout therefore remains useful when GPS/phone contact
// disappears; no distance is ever inferred from wrist data.
static uint8_t s_journal[JOURNAL_MAX_RECORDS][JOURNAL_RECORD_BYTES];
static int s_journal_n = 0;
static uint32_t s_journal_last_added_at = 0;
static uint32_t s_journal_last_sent_at = 0;
static bool s_journal_overflow = false;
static bool s_journal_flush_pending = false;

// Versioned watch<->phone session protocol. Control intents remain pending
// until the phone acknowledges their sequence number; reconnects send a full
// state/settings snapshot so either side can repair an independent restart.
static uint32_t s_sid = 0;
static uint32_t s_seq = 0;
static uint32_t s_pending_seq = 0;
static uint8_t s_pending_cmd = 0;
static char s_pending_name[64];
static bool s_hello_pending = true;
// A local watch edit must win over an older phone edit that was queued while
// disconnected. CFGSET=2 marks the full watch snapshot until the phone echoes it.
static bool s_local_settings_pending = false;
static bool s_outbox_busy = false;
static uint8_t s_outbox_kind = 0;   // 1 control, 2 hello/settings, 3 health, 4 journal flush
static bool s_queued_had_journal = false;
// ConnectionService gives us edge-triggered reconnects. In particular, never
// run an AppMessage retry timer while the phone is absent: sub-second retries
// can otherwise become one of the watch's largest battery costs on a long hike.
static bool s_phone_connected = false;
static uint32_t s_link_retry_ms = LINK_RETRY_MIN_MS;

// Switchable workout pages and local lap state. Page changes only redraw
// existing layers; they do not alter sensor or radio cadence.
static int s_page = 0;
static int s_lap_n = 1;
static int s_lap_start_active_s = 0;
static int s_lap_start_dist_m = 0;
static time_t s_target_bad_since = 0;
static time_t s_target_last_alert = 0;
static bool s_target_complete_alerted = false;
static uint32_t s_last_refresh_ms = 0;

static char s_time_buf[16], s_dist_buf[12], s_pace_buf[12];
static char s_hr_buf[12], s_hr_cap_buf[12], s_hr_zone_buf[4], s_steps_buf[16];
static char s_flash_buf[20], s_acc_buf[20], s_state_buf[32];
static char s_cap_buf[4][20];
static TextLayer *s_acc_layer;
static GFont s_acc_fitted_font;

// chrome geometry (set during layout)
static int s_header_bot = 0, s_grid_top = 0, s_grid_mid = 0;
static int s_grid_bot = 0, s_col_x = 0;
static Layer *s_actionbar = NULL;
static int s_content_w = 0;        // usable width left of the action bar
static TextLayer *s_clock_layer = NULL;   // wall-clock time, top-right
static char s_clock_buf[12];
// Metric values normally use the large LECO face. Longer values select the
// largest bundled font that genuinely fits, so TextLayer never substitutes an
// ellipsis. Keeping the chosen font avoids redundant layer changes.
static const char *s_time_preferred_font = FONT_KEY_LECO_28_LIGHT_NUMBERS;
static const char *s_metric_preferred_font = FONT_KEY_LECO_28_LIGHT_NUMBERS;
static GFont s_time_fitted_font = NULL, s_dist_fitted_font = NULL;
static GFont s_pace_fitted_font = NULL, s_hr_fitted_font = NULL;
static GFont s_steps_fitted_font = NULL;
static GFont s_state_fitted_font = NULL, s_cap_fitted_font[4];
static const char *s_caption_preferred_font = FONT_KEY_GOTHIC_14_BOLD;
static size_t s_time_fitted_len = 0;
static void prv_update_actionbar(void);
static void prv_render_page(void);
static int prv_elapsed_now(void);
static void prv_flash(const char *txt);

// Forward declarations for settings helpers
static void prv_update_caps(void);
static void settings_load(void);
void settings_save_and_sync(void);
static void prv_up_click(ClickRecognizerRef rec, void *ctx);
static void prv_select_click(ClickRecognizerRef rec, void *ctx);
static void prv_down_click(ClickRecognizerRef rec, void *ctx);
static void prv_back_click(ClickRecognizerRef rec, void *ctx);
static void prv_tick(struct tm *tick_time, TimeUnits units);
static void prv_apply_tick(void);
static void prv_apply_hr_period(void);
static void prv_sample_hr(void);
static void prv_refresh_steps(void);
static void prv_send_sample(bool force);
static void prv_try_send(void);
static void prv_session_persist(void);
static void prv_send_hello(void);
static void prv_open_appmessage(void);
static void prv_journal_add(bool lap_marker);
static void prv_connection_changed(bool connected);

// ---------------- Helpers ----------------
/* Zones are 60/70/80/90 % of the configurable max HR (UP -> settings). */
GColor hr_zone_color(int hr) {
#if defined(PBL_COLOR)
  if (hr <= 0) return GColorDarkGray;
  int mx = g_set.max_hr;
  if (hr < mx * 60 / 100) return GColorCobaltBlue;
  if (hr < mx * 70 / 100) return GColorDarkGreen;
  if (hr < mx * 80 / 100) return GColorWindsorTan;
  if (hr < mx * 90 / 100) return GColorOrange;
  return GColorDarkCandyAppleRed;
#else
  (void)hr;
  return GColorBlack;
#endif
}

static int prv_hr_zone_index(int hr) {
  if (hr <= 0) return 0;
  int mx = g_set.max_hr;
  if (hr < mx * 60 / 100) return 1;
  if (hr < mx * 70 / 100) return 2;
  if (hr < mx * 80 / 100) return 3;
  if (hr < mx * 90 / 100) return 4;
  return 5;
}

/* Return the largest built-in face that fits the layer with a little breathing
 * room. Gothic 09 is a last-resort safety net for the full range of our integer
 * buffers; ordinary workout values stay in the much larger LECO faces. */
static GFont prv_fitted_number_font(TextLayer *layer, const char *text,
                                    const char *preferred_key) {
  static const char *const fallback_keys[] = {
    FONT_KEY_LECO_32_BOLD_NUMBERS,
    FONT_KEY_LECO_28_LIGHT_NUMBERS,
    FONT_KEY_GOTHIC_24_BOLD,
    FONT_KEY_LECO_20_BOLD_NUMBERS,
    FONT_KEY_GOTHIC_18_BOLD,
    FONT_KEY_GOTHIC_14_BOLD,
    FONT_KEY_GOTHIC_09,
  };
  GRect bounds = layer_get_bounds(text_layer_get_layer(layer));
  int available = bounds.size.w > 4 ? bounds.size.w - 4 : bounds.size.w;
  GRect measure_box = GRect(0, 0, 1000, 100);
  GFont preferred = fonts_get_system_font(preferred_key);
  GSize measured = graphics_text_layout_get_content_size(
      text, preferred, measure_box, GTextOverflowModeFill, GTextAlignmentCenter);
  if (measured.w <= available) return preferred;

  for (size_t i = 0; i < ARRAY_LENGTH(fallback_keys); ++i) {
    GFont font = fonts_get_system_font(fallback_keys[i]);
    if (font == preferred) continue;
    measured = graphics_text_layout_get_content_size(
        text, font, measure_box, GTextOverflowModeFill, GTextAlignmentCenter);
    if (measured.w <= available) return font;
  }
  return fonts_get_system_font(FONT_KEY_GOTHIC_09);
}

static void prv_set_fitted_number(TextLayer *layer, const char *text,
                                  const char *preferred_key, GFont *shown_font) {
  if (!layer) return;
  bool word = false;
  for (const char *p = text; *p; p++) {
    if ((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z')) {
      word = true;
      break;
    }
  }
  GFont font;
  if (word) {
    static const char *const word_keys[] = {
      FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_18_BOLD,
      FONT_KEY_GOTHIC_14_BOLD, FONT_KEY_GOTHIC_09
    };
    GRect bounds = layer_get_bounds(text_layer_get_layer(layer));
    int available = bounds.size.w > 4 ? bounds.size.w - 4 : bounds.size.w;
    font = fonts_get_system_font(word_keys[ARRAY_LENGTH(word_keys) - 1]);
    for (size_t i = 0; i < ARRAY_LENGTH(word_keys); i++) {
      GFont candidate = fonts_get_system_font(word_keys[i]);
      GSize measured = graphics_text_layout_get_content_size(
          text, candidate, GRect(0, 0, 1000, 50),
          GTextOverflowModeFill, GTextAlignmentCenter);
      if (measured.w <= available) { font = candidate; break; }
    }
  } else {
    font = prv_fitted_number_font(layer, text, preferred_key);
  }
  if (*shown_font != font) {
    *shown_font = font;
    text_layer_set_font(layer, font);
  }
  text_layer_set_text(layer, text);
}

static GFont prv_fitted_label_font(TextLayer *layer, const char *text,
                                   const char *preferred_key) {
  static const char *const fallback_keys[] = {
    FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_14_BOLD,
    FONT_KEY_GOTHIC_14, FONT_KEY_GOTHIC_09
  };
  GRect bounds = layer_get_bounds(text_layer_get_layer(layer));
  int available = bounds.size.w > 2 ? bounds.size.w - 2 : bounds.size.w;
  GFont preferred = fonts_get_system_font(preferred_key);
  GSize measured = graphics_text_layout_get_content_size(
      text, preferred, GRect(0, 0, 1000, 40),
      GTextOverflowModeFill, GTextAlignmentLeft);
  if (measured.w <= available) return preferred;
  for (size_t i = 0; i < ARRAY_LENGTH(fallback_keys); i++) {
    GFont font = fonts_get_system_font(fallback_keys[i]);
    if (font == preferred) continue;
    measured = graphics_text_layout_get_content_size(
        text, font, GRect(0, 0, 1000, 40),
        GTextOverflowModeFill, GTextAlignmentLeft);
    if (measured.w <= available) return font;
  }
  return fonts_get_system_font(FONT_KEY_GOTHIC_09);
}

static void prv_set_caption(int index, TextLayer *layer, const char *text) {
  if (!layer || index < 0 || index >= 4) return;
  if (strcmp(s_cap_buf[index], text) == 0) return;
  snprintf(s_cap_buf[index], sizeof(s_cap_buf[index]), "%s", text);
  GFont font = prv_fitted_label_font(layer, s_cap_buf[index],
                                     s_caption_preferred_font);
  if (s_cap_fitted_font[index] != font) {
    s_cap_fitted_font[index] = font;
    text_layer_set_font(layer, font);
  }
  text_layer_set_text(layer, s_cap_buf[index]);
}

static void prv_set_state_line(const char *text) {
  if (!s_state_layer || !text) return;
  if (strcmp(s_state_buf, text) == 0) return;
  snprintf(s_state_buf, sizeof(s_state_buf), "%s", text);
  GFont font = prv_fitted_label_font(s_state_layer, s_state_buf,
                                     FONT_KEY_GOTHIC_14_BOLD);
  if (s_state_fitted_font != font) {
    s_state_fitted_font = font;
    text_layer_set_font(s_state_layer, font);
  }
  text_layer_set_text(s_state_layer, s_state_buf);
}

static int prv_gps_visual_state(bool ok, int acc_m) {
  if (!ok) return 0;
  return (acc_m >= 0 && acc_m <= 20) ? 1 : 2;
}

static void prv_update_acc(void) {
  if (!s_acc_layer) return;
  char next[sizeof(s_acc_buf)];
  if (!s_gps_ok || s_acc_m < 0) {
    // The coloured/hollow dot already says "GPS". Keep the adjacent text
    // compact enough for Basalt: activity + exact accuracy, with no truncation
    snprintf(next, sizeof(next), "%s --", mode_label());
  } else {
    snprintf(next, sizeof(next), "%s %dm", mode_label(), s_acc_m);
  }
  if (strcmp(next, s_acc_buf) == 0) return;
  snprintf(s_acc_buf, sizeof(s_acc_buf), "%s", next);

  GFont preferred = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  GRect bounds = layer_get_bounds(text_layer_get_layer(s_acc_layer));
  GSize measured = graphics_text_layout_get_content_size(
      s_acc_buf, preferred, GRect(0, 0, 1000, 30),
      GTextOverflowModeFill, GTextAlignmentLeft);
  GFont fitted = measured.w <= bounds.size.w ? preferred
      : fonts_get_system_font(FONT_KEY_GOTHIC_09);
  if (fitted != s_acc_fitted_font) {
    s_acc_fitted_font = fitted;
    text_layer_set_font(s_acc_layer, fitted);
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
  // LECO digits are tabular; the timer needs refitting only when its character
  // count grows (normally at one hour and 100 hours), not on every second tick.
  size_t len = strlen(s_time_buf);
  if (!s_time_fitted_font || len != s_time_fitted_len) {
    s_time_fitted_len = len;
    s_time_fitted_font = prv_fitted_number_font(
        s_time_layer, s_time_buf, s_time_preferred_font);
    text_layer_set_font(s_time_layer, s_time_fitted_font);
  }
  text_layer_set_text(s_time_layer, s_time_buf);
}

static void prv_update_dist(void) {
  prv_render_page();
}

static void prv_update_pace(void) {
  prv_render_page();
}

static void prv_update_hr(void) {
  prv_render_page();
}

static void prv_update_steps(void) {
  prv_render_page();
}

static void prv_metric_text(TextLayer *layer, char *buf, size_t n,
                            const char *value, GFont *font) {
  if (!layer || !value) return;
  if (strcmp(buf, value) == 0) return;
  snprintf(buf, n, "%s", value);
  prv_set_fitted_number(layer, buf, s_metric_preferred_font, font);
}

static int prv_live_avg_pace(void) {
  int moving = s_moving_live_s > 0 ? s_moving_live_s : prv_elapsed_now();
  return (s_dist_m >= 20 && moving > 0)
           ? (int)((int64_t)moving * 1000 / s_dist_m) : 0;
}

static bool prv_target_bad(void) {
  if (g_set.target_type == TARGET_HR_ZONE) {
    return s_hr > 0 && prv_hr_zone_index(s_hr) != g_set.target_value;
  }
  if (g_set.target_type == TARGET_PACE) {
    return s_pace_s > 0 &&
           ((g_set.target_lo > 0 && s_pace_s < g_set.target_lo) ||
            (g_set.target_hi > 0 && s_pace_s > g_set.target_hi));
  }
  return false;
}

/* Target checks piggyback on existing UI updates. They create no timers, sensor
 * reads or radio messages. A brief GPS/HR wobble is ignored and reminders are
 * rate-limited so a long workout never becomes a stream of vibrations. */
static void prv_check_target(void) {
  if (s_state != STATE_RUNNING || g_set.target_type == TARGET_OFF) {
    s_target_bad_since = 0;
    return;
  }
  bool complete =
      (g_set.target_type == TARGET_DURATION && g_set.target_value > 0 &&
       prv_elapsed_now() >= g_set.target_value) ||
      (g_set.target_type == TARGET_DISTANCE && g_set.target_value > 0 &&
       s_dist_m >= g_set.target_value);
  if (complete && !s_target_complete_alerted) {
    s_target_complete_alerted = true;
    vibes_double_pulse();
    light_enable_interaction();
    prv_flash("TARGET COMPLETE");
  }
  if (g_set.target_type != TARGET_HR_ZONE && g_set.target_type != TARGET_PACE)
    return;
  time_t at = time(NULL);
  if (!prv_target_bad()) {
    s_target_bad_since = 0;
    return;
  }
  if (!s_target_bad_since) s_target_bad_since = at;
  if (at >= s_target_bad_since + TARGET_ALERT_HOLD_S &&
      (!s_target_last_alert || at >= s_target_last_alert + TARGET_ALERT_GAP_S)) {
    s_target_last_alert = at;
    vibes_short_pulse();
    prv_flash("CHECK TARGET");
  }
}

static void prv_render_page(void) {
  if (!s_dist_layer || !s_dist_cap) return;
  char a[16], b[16], c[16], d[16];
  const char *cap_a, *cap_b, *cap_c, *cap_d;
  GColor cap_col = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);
  text_layer_set_text_color(s_dist_cap, cap_col);
  text_layer_set_text_color(s_pace_cap, cap_col);
  text_layer_set_text_color(s_hr_cap, cap_col);
  text_layer_set_text_color(s_hr_zone_layer, cap_col);
  text_layer_set_text_color(s_steps_cap, cap_col);
  text_layer_set_text(s_hr_zone_layer, "");

  if (s_page == 1) {
    int lap_active = prv_elapsed_now() - s_lap_start_active_s;
    int lap_dist = s_dist_m - s_lap_start_dist_m;
    int lap_pace = (lap_dist >= 10 && lap_active > 0)
                     ? (int)((int64_t)lap_active * 1000 / lap_dist) : 0;
    cap_a = "LAP";
    cap_b = g_set.miles ? "LAP MI" : "LAP KM";
    cap_c = "LAP TIME";
    cap_d = g_set.mode == MODE_CYCLE ? "LAP SPEED" : "LAP PACE";
    snprintf(a, sizeof(a), "%d", s_lap_n);
    fmt_dist(b, sizeof(b), lap_dist);
    fmt_dur(c, sizeof(c), lap_active);
    if (g_set.mode == MODE_CYCLE) fmt_speed(d, sizeof(d), lap_pace);
    else                          fmt_pace(d, sizeof(d), lap_pace);
  } else if (s_page == 2) {
    int avgp = prv_live_avg_pace();
    cap_a = g_set.mode == MODE_CYCLE ? "AVG SPEED" : "AVG PACE";
    cap_b = "AVG HR";
    cap_c = g_set.miles ? "ASCENT FT" : "ASCENT M";
    if (g_set.mode == MODE_CYCLE) fmt_speed(a, sizeof(a), avgp);
    else                          fmt_pace(a, sizeof(a), avgp);
    if (s_avg_hr_live > 0) snprintf(b, sizeof(b), "%d", s_avg_hr_live);
    else snprintf(b, sizeof(b), "--");
    snprintf(c, sizeof(c), "%d", egain_display(s_egain_live_m));
    if (g_set.target_type == TARGET_DURATION) {
      int left = g_set.target_value - prv_elapsed_now();
      cap_d = "TIME LEFT";
      if (left > 0) fmt_dur(d, sizeof(d), left); else snprintf(d, sizeof(d), "DONE");
    } else if (g_set.target_type == TARGET_DISTANCE) {
      int left = g_set.target_value - s_dist_m;
      cap_d = "DIST LEFT";
      if (left > 0) fmt_dist(d, sizeof(d), left); else snprintf(d, sizeof(d), "DONE");
    } else if (g_set.target_type == TARGET_HR_ZONE) {
      int z = prv_hr_zone_index(s_hr);
      cap_d = "HR TARGET";
      if (!z) snprintf(d, sizeof(d), "Z%d --", g_set.target_value);
      else if (z == g_set.target_value) snprintf(d, sizeof(d), "Z%d OK", z);
      else snprintf(d, sizeof(d), "Z%d %s", z, z > g_set.target_value ? "HIGH" : "LOW");
    } else if (g_set.target_type == TARGET_PACE) {
      cap_d = g_set.mode == MODE_CYCLE ? "SPEED GOAL" : "PACE GOAL";
      if (!s_pace_s) snprintf(d, sizeof(d), "--");
      else if (g_set.target_lo > 0 && s_pace_s < g_set.target_lo) snprintf(d, sizeof(d), "FAST");
      else if (g_set.target_hi > 0 && s_pace_s > g_set.target_hi) snprintf(d, sizeof(d), "SLOW");
      else snprintf(d, sizeof(d), "OK");
    } else {
      cap_d = "MOVING";
      fmt_dur(d, sizeof(d), s_moving_live_s > 0 ? s_moving_live_s : prv_elapsed_now());
    }
  } else {
    cap_a = g_set.miles ? "DIST MI" : "DIST KM";
    cap_b = g_set.mode == MODE_CYCLE
              ? (g_set.miles ? "MPH" : "KM/H")
              : (g_set.miles ? "PACE/MI" : "PACE/KM");
    int zone = prv_hr_zone_index(s_hr);
    bool zone_visible = g_set.show_hr_zone && zone > 0;
#if defined(PBL_HEALTH)
    if (s_hr_access_mask & HealthServiceAccessibilityMaskNoPermission) {
      snprintf(s_hr_cap_buf, sizeof(s_hr_cap_buf), "HR OFF");
      zone_visible = false;
    } else if (s_hr_access_mask & HealthServiceAccessibilityMaskNotSupported) {
      snprintf(s_hr_cap_buf, sizeof(s_hr_cap_buf), "HR N/A");
      zone_visible = false;
    } else
#endif
      snprintf(s_hr_cap_buf, sizeof(s_hr_cap_buf), "HR");
    cap_c = s_hr_cap_buf;
    if (zone_visible) {
      snprintf(s_hr_zone_buf, sizeof(s_hr_zone_buf), "Z%d", zone);
      text_layer_set_text(s_hr_zone_layer, s_hr_zone_buf);
      text_layer_set_text_color(s_hr_zone_layer,
                                PBL_IF_COLOR_ELSE(hr_zone_color(s_hr), GColorBlack));
    }
    cap_d = g_set.mode == MODE_CYCLE
              ? (g_set.miles ? "ASCENT FT" : "ASCENT M") : "STEPS";
    fmt_dist(a, sizeof(a), s_dist_m);
    if (g_set.mode == MODE_CYCLE) fmt_speed(b, sizeof(b), s_pace_s);
    else                          fmt_pace(b, sizeof(b), s_pace_s);
    if (s_hr > 0) snprintf(c, sizeof(c), "%d", s_hr); else snprintf(c, sizeof(c), "--");
    if (g_set.mode == MODE_CYCLE) snprintf(d, sizeof(d), "%d", egain_display(s_egain_live_m));
    else snprintf(d, sizeof(d), "%d", s_steps);
  }

  prv_set_caption(0, s_dist_cap, cap_a);
  prv_set_caption(1, s_pace_cap, cap_b);
  prv_set_caption(2, s_hr_cap, cap_c);
  prv_set_caption(3, s_steps_cap, cap_d);

  // One page-specific value gets the same restrained orange accent as the
  // debrief. HR remains black; its tiny Z label alone carries zone colour.
  GColor accent = PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack);
  text_layer_set_text_color(s_dist_layer,
      (s_state == STATE_RUNNING || s_state == STATE_PAUSED) && s_page == 2
          ? accent : GColorBlack);
  text_layer_set_text_color(s_pace_layer,
      (s_state == STATE_RUNNING || s_state == STATE_PAUSED) && s_page == 0
          ? accent : GColorBlack);
  text_layer_set_text_color(s_hr_layer, GColorBlack);
  text_layer_set_text_color(s_steps_layer,
      (s_state == STATE_RUNNING || s_state == STATE_PAUSED) && s_page == 1
          ? accent : GColorBlack);

  prv_metric_text(s_dist_layer, s_dist_buf, sizeof(s_dist_buf), a, &s_dist_fitted_font);
  prv_metric_text(s_pace_layer, s_pace_buf, sizeof(s_pace_buf), b, &s_pace_fitted_font);
  prv_metric_text(s_hr_layer, s_hr_buf, sizeof(s_hr_buf), c, &s_hr_fitted_font);
  prv_metric_text(s_steps_layer, s_steps_buf, sizeof(s_steps_buf), d, &s_steps_fitted_font);
  prv_check_target();
}

static void prv_set_state_text(void) {
  // The big timer carries run state by COLOUR: black = recording, red =
  // paused, grey = idle/saving. The compact line under it names the current
  // Pebble-style page unless a more important state needs the space.
  GColor timer_col = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);  // idle
  GColor status_col = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);
  char status[32];
  const char *page_name = s_page == 1 ? "LAP" : s_page == 2 ? "TOTALS" : "LIVE";
  switch (s_state) {
    case STATE_RUNNING: timer_col = GColorBlack;
                        if (!s_phone_connected) snprintf(status, sizeof(status), "PHONE OFFLINE");
                        else if (!s_gps_ok) snprintf(status, sizeof(status), "GPS LOST");
                        else snprintf(status, sizeof(status), "%s %d/3", page_name, s_page + 1);
                        break;
    case STATE_PAUSED:  timer_col = PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
                        status_col = PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
                        if (!s_phone_connected) snprintf(status, sizeof(status), "PHONE OFFLINE");
                        else if (s_autopaused && !s_gps_ok) snprintf(status, sizeof(status), "GPS LOST");
                        else snprintf(status, sizeof(status), "%s %d/3",
                                      s_autopaused ? "AUTO-PAUSE" : "PAUSED", s_page + 1);
                        break;
    case STATE_SAVING:  snprintf(status, sizeof(status), "SAVING"); break;
    case STATE_DONE:    snprintf(status, sizeof(status), "SAVED"); break;
    case STATE_READY:
    default:            snprintf(status, sizeof(status), "%s",
                                 s_phone_connected ? "READY" : "PHONE OFFLINE"); break;
  }
  // START/PAUSE/RESUME take effect locally and are reconciled later. Do not
  // mask the true workout state with an indefinite PAUSING label merely
  // because the phone is offline. STOP is different: saving completes only
  // after the phone durably stores the workout.
  if (s_pending_cmd == CMD_STOP) snprintf(status, sizeof(status), "SAVING");
  if (s_time_layer)  text_layer_set_text_color(s_time_layer, timer_col);
  if (s_state_layer) {
    text_layer_set_text_color(s_state_layer, status_col);
    prv_set_state_line(status);
  }
  if (s_chrome_layer) layer_mark_dirty(s_chrome_layer);
  prv_update_caps();
  prv_update_actionbar();
  prv_apply_tick();          // match tick rate to run state (battery)
  prv_apply_hr_period();      // match optical-sensor duty cycle to state/activity
}

// right-edge labels: what UP / SELECT / DOWN do in the current state
static void prv_update_actionbar(void) {
  if (!s_actionbar) return;
  HbIcon mode_ic = (g_set.mode == MODE_CYCLE) ? HB_BIKE
                 : (g_set.mode == MODE_WALK)  ? HB_WALK
                 : (g_set.mode == MODE_HIKE)  ? HB_HIKE : HB_RUN;
  switch (s_state) {
    case STATE_RUNNING:
      hintbar_set_icons(s_actionbar, HB_UP, HB_PAUSE, HB_NONE, HB_DOWN);
      break;
    case STATE_PAUSED:
      if (s_autopaused)
        // Either outer button makes this a deliberate/manual pause; SELECT is
        // the only resume action. This directly matches physical intent.
        hintbar_set_icons(s_actionbar, HB_PAUSE, HB_START, HB_NONE, HB_PAUSE);
      else
        hintbar_set_icons(s_actionbar, HB_UP, HB_START, HB_NONE, HB_DOWN);
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
  prv_set_state_line(txt);
  if (s_flash_timer) {
    app_timer_reschedule(s_flash_timer, 1600);
  } else {
    s_flash_timer = app_timer_register(1600, prv_flash_done, NULL);
  }
}

// ---------------- Health ----------------
static int prv_sample_period_s(void) {
  return g_set.mode == MODE_HIKE ? HIKE_SAMPLE_PERIOD_S : SAMPLE_PERIOD_S;
}

static int prv_sample_keepalive_s(void) {
  return g_set.mode == MODE_HIKE ? HIKE_KEEPALIVE_S : SAMPLE_KEEPALIVE_S;
}

static void prv_set_hr_period(int period_s) {
  if (period_s == s_hr_period_s) return;
#if defined(PBL_HEALTH)
  health_service_set_heart_rate_sample_period(period_s);
#endif
  s_hr_period_s = period_s;
}

#if defined(PBL_HEALTH)
static void prv_health_event(HealthEventType event, void *context) {
  (void)context;
  if (s_state != STATE_RUNNING) return;
  if (event == HealthEventHeartRateUpdate || event == HealthEventSignificantUpdate) {
    s_hr_read_from_event = event == HealthEventHeartRateUpdate;
    prv_sample_hr();
    s_hr_read_from_event = false;
  }
}
#endif

static void prv_apply_health_events(void) {
#if defined(PBL_HEALTH)
  bool want = s_state == STATE_RUNNING;
  if (want && !s_health_events_active) {
    s_health_events_active = health_service_events_subscribe(prv_health_event, NULL);
    // Seed the display immediately; subsequent active reads are driven by real
    // firmware samples. If allocation failed, the fixed tick cadence polls.
    prv_sample_hr();
  } else if (!want && s_health_events_active) {
    health_service_events_unsubscribe();
    s_health_events_active = false;
  }
#endif
}

static void prv_apply_hr_period(void) {
  int period_s = 0;   // 0 restores Pebble's default outside an active workout
  if (s_state == STATE_RUNNING)
    period_s = g_set.mode == MODE_HIKE ? HR_HIKE_PERIOD_S : HR_RUN_PERIOD_S;
  else if (s_state == STATE_PAUSED)
    period_s = HR_PAUSE_PERIOD_S;
  prv_set_hr_period(period_s);
  prv_apply_health_events();
}

// The wall clock only changes by the minute — recompute it then, not every tick.
static void prv_update_clock(void) {
  if (!s_clock_layer) return;
  clock_copy_time_string(s_clock_buf, sizeof(s_clock_buf));
  text_layer_set_text(s_clock_layer, s_clock_buf);
}

static int prv_elapsed_now(void) {
  if (s_state == STATE_RUNNING && s_run_anchor > 0) {
    time_t n = time(NULL);
    time_t d = n >= s_run_anchor ? n - s_run_anchor : 0;
    return s_active_base_s + (int)d;
  }
  return s_active_base_s;
}

static void prv_freeze_elapsed(void) {
  s_elapsed_s = prv_elapsed_now();
  s_active_base_s = s_elapsed_s;
  s_run_anchor = 0;
  prv_update_time();
}

static void prv_resume_elapsed(void) {
  s_run_anchor = time(NULL);
  s_elapsed_s = s_active_base_s;
  prv_update_time();
}

static uint32_t prv_new_sid(void) {
  time_t sec;
  uint16_t ms;
  time_ms(&sec, &ms);
  uint32_t v = (uint32_t)sec * 1000u + (uint32_t)ms;
  v ^= ((s_seq + 1) * 2654435761u);
  return v ? v : 1;
}

static uint32_t prv_get_le32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
         ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void prv_put_le16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
}

static void prv_put_le32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

static void prv_fill_journal_record(uint8_t *r, uint32_t at, bool lap_marker) {
  int active = prv_elapsed_now();
  int steps = s_steps < 0 ? 0 : s_steps;
  if (active > 65535) active = 65535;
  if (steps > 0xFFFFFF) steps = 0xFFFFFF;
  prv_put_le32(r, at);
  prv_put_le16(r + 4, (uint16_t)active);
  r[6] = (uint8_t)(s_hr > 254 ? 254 : (s_hr < 0 ? 0 : s_hr));
  r[7] = (uint8_t)(s_hr_peak_raw > 254 ? 254 : (s_hr_peak_raw < 0 ? 0 : s_hr_peak_raw));
  r[8] = (uint8_t)steps; r[9] = (uint8_t)(steps >> 8); r[10] = (uint8_t)(steps >> 16);
  r[11] = (uint8_t)s_state | (lap_marker ? 0x80 : 0);
}

static void prv_journal_add(bool lap_marker) {
  if (!s_sid || (s_state != STATE_RUNNING && s_state != STATE_PAUSED &&
                 s_state != STATE_SAVING)) return;
  uint32_t at = (uint32_t)time(NULL);
  if (s_journal_n > 0 && prv_get_le32(s_journal[s_journal_n - 1]) == at) {
    bool had_lap = (s_journal[s_journal_n - 1][11] & 0x80) != 0;
    prv_fill_journal_record(s_journal[s_journal_n - 1], at, lap_marker || had_lap);
    return;
  }
  if (s_journal_n >= JOURNAL_MAX_RECORDS) {
    // Retain the beginning and the latest aggregate boundary. The phone receives
    // DQ=1 so it can describe the gap honestly rather than pretending fidelity.
    s_journal_overflow = true;
    prv_fill_journal_record(s_journal[JOURNAL_MAX_RECORDS - 1], at, lap_marker);
  } else {
    prv_fill_journal_record(s_journal[s_journal_n++], at, lap_marker);
  }
  s_journal_last_added_at = at;
}

static void prv_persist_int_if_changed(uint32_t key, int32_t value) {
  if (!persist_exists(key) || persist_read_int(key) != value)
    persist_write_int(key, value);
}

static void prv_persist_bool_if_changed(uint32_t key, bool value) {
  if (!persist_exists(key) || persist_read_bool(key) != value)
    persist_write_bool(key, value);
}

static void prv_persist_delete_if_present(uint32_t key) {
  if (persist_exists(key)) persist_delete(key);
}

static void prv_delete_removed_state(void) {
  // 1.30 briefly used these slots. Clear them on upgrade and keep the numeric
  // range reserved in runlog.h so stale values can never acquire new meaning.
  for (uint32_t key = 33; key <= 40; key++)
    prv_persist_delete_if_present(key);
}

static void prv_session_persist(void) {
  prv_persist_int_if_changed(PKEY_SESSION_SEQ, (int32_t)s_seq);
  if (!s_sid) {
    prv_persist_delete_if_present(PKEY_SESSION_SID);
    prv_persist_delete_if_present(PKEY_SESSION_STATE);
    prv_persist_delete_if_present(PKEY_SESSION_ACTIVE);
    prv_persist_delete_if_present(PKEY_SESSION_ANCHOR);
    prv_persist_delete_if_present(PKEY_SESSION_START);
    prv_persist_delete_if_present(PKEY_SESSION_PENDING);
    prv_persist_delete_if_present(PKEY_SESSION_AUTOPAUSE);
    prv_persist_delete_if_present(PKEY_SESSION_NAME);
    prv_persist_delete_if_present(PKEY_SESSION_STEPS);
    prv_persist_delete_if_present(PKEY_SESSION_STEPBASE);
    prv_persist_delete_if_present(PKEY_SESSION_STEPPAUSE);
    prv_persist_delete_if_present(PKEY_SESSION_STEPGROSS);
    prv_persist_delete_if_present(PKEY_SESSION_UNACKED);
    prv_persist_delete_if_present(PKEY_SESSION_LAPN);
    prv_persist_delete_if_present(PKEY_SESSION_LAPACTIVE);
    prv_persist_delete_if_present(PKEY_SESSION_LAPDIST);
    prv_persist_delete_if_present(PKEY_SESSION_PAGE);
    return;
  }
  prv_persist_int_if_changed(PKEY_SESSION_SID, (int32_t)s_sid);
  prv_persist_int_if_changed(PKEY_SESSION_STATE, (int32_t)s_state);
  prv_persist_int_if_changed(PKEY_SESSION_ACTIVE, (int32_t)s_active_base_s);
  prv_persist_int_if_changed(PKEY_SESSION_ANCHOR, (int32_t)s_run_anchor);
  prv_persist_int_if_changed(PKEY_SESSION_START, (int32_t)s_started_at);
  prv_persist_int_if_changed(PKEY_SESSION_PENDING, (int32_t)s_pending_cmd);
  prv_persist_bool_if_changed(PKEY_SESSION_AUTOPAUSE, s_autopaused);
  prv_persist_int_if_changed(PKEY_SESSION_STEPS, s_steps);
  prv_persist_int_if_changed(PKEY_SESSION_STEPBASE, (int32_t)s_steps_at_start);
  prv_persist_int_if_changed(PKEY_SESSION_STEPPAUSE, s_steps_paused);
  prv_persist_int_if_changed(PKEY_SESSION_STEPGROSS, s_steps_gross_last);
  prv_persist_bool_if_changed(PKEY_SESSION_UNACKED,
                              s_journal_n > 0 || s_journal_overflow);
  prv_persist_int_if_changed(PKEY_SESSION_LAPN, s_lap_n);
  prv_persist_int_if_changed(PKEY_SESSION_LAPACTIVE, s_lap_start_active_s);
  prv_persist_int_if_changed(PKEY_SESSION_LAPDIST, s_lap_start_dist_m);
  prv_persist_int_if_changed(PKEY_SESSION_PAGE, s_page);
  if (s_pending_cmd == CMD_RENAME && s_pending_name[0]) {
    char old_name[sizeof(s_pending_name)];
    bool changed = !persist_exists(PKEY_SESSION_NAME) ||
                   persist_read_string(PKEY_SESSION_NAME, old_name, sizeof(old_name)) <= 0 ||
                   strcmp(old_name, s_pending_name) != 0;
    if (changed) persist_write_string(PKEY_SESSION_NAME, s_pending_name);
  } else {
    prv_persist_delete_if_present(PKEY_SESSION_NAME);
  }
}

static void prv_session_clear(void) {
  s_state = STATE_READY;
  s_accept_saved = false;
  s_sid = 0;
  s_pending_cmd = 0;
  s_pending_seq = 0;
  s_pending_name[0] = 0;
  s_active_base_s = 0;
  s_elapsed_s = 0;
  s_run_anchor = 0;
  s_started_at = 0;
  s_autopaused = false;
  s_page = 0; s_lap_n = 1;
  s_lap_start_active_s = s_lap_start_dist_m = 0;
  s_journal_n = 0;
  s_journal_last_added_at = s_journal_last_sent_at = 0;
  s_journal_overflow = false;
  s_journal_flush_pending = false;
  prv_session_persist();
}

static void prv_session_load(void) {
  if (persist_exists(PKEY_SESSION_SEQ))
    s_seq = (uint32_t)persist_read_int(PKEY_SESSION_SEQ);
  if (!persist_exists(PKEY_SESSION_SID) || !persist_exists(PKEY_SESSION_STATE)) return;
  int st = persist_read_int(PKEY_SESSION_STATE);
  // RUNNING/PAUSED/SAVING are resumable and must survive an app restart. DONE
  // is not: the workout is already safely on the phone, so every later launch
  // starts as a blank recorder instead of reopening the previous debrief.
  if (st < STATE_RUNNING || st > STATE_SAVING) {
    prv_session_clear();
    return;
  }
  s_sid = (uint32_t)persist_read_int(PKEY_SESSION_SID);
  if (!s_sid) {
    prv_session_clear();
    return;
  }
  s_accept_saved = true;
  s_state = (RunState)st;
  s_active_base_s = persist_exists(PKEY_SESSION_ACTIVE)
                      ? persist_read_int(PKEY_SESSION_ACTIVE) : 0;
  s_run_anchor = persist_exists(PKEY_SESSION_ANCHOR)
                   ? (time_t)persist_read_int(PKEY_SESSION_ANCHOR) : 0;
  s_started_at = persist_exists(PKEY_SESSION_START)
                   ? (time_t)persist_read_int(PKEY_SESSION_START) : 0;
  s_autopaused = persist_exists(PKEY_SESSION_AUTOPAUSE)
                   ? persist_read_bool(PKEY_SESSION_AUTOPAUSE) : false;
  if (persist_exists(PKEY_SESSION_STEPS)) {
    s_steps = persist_read_int(PKEY_SESSION_STEPS);
    s_steps_at_start = persist_exists(PKEY_SESSION_STEPBASE)
                         ? (HealthValue)persist_read_int(PKEY_SESSION_STEPBASE) : 0;
    s_steps_paused = persist_exists(PKEY_SESSION_STEPPAUSE)
                       ? persist_read_int(PKEY_SESSION_STEPPAUSE) : 0;
    s_steps_gross_last = persist_exists(PKEY_SESSION_STEPGROSS)
                           ? persist_read_int(PKEY_SESSION_STEPGROSS) : 0;
    s_have_step_base = persist_exists(PKEY_SESSION_STEPBASE);
  }
  s_pending_cmd = persist_exists(PKEY_SESSION_PENDING)
                    ? (uint8_t)persist_read_int(PKEY_SESSION_PENDING) : 0;
  s_pending_seq = s_pending_cmd ? s_seq : 0;
  // RAM-backed unacknowledged records cannot survive a watchapp process kill.
  // Mark that interval explicitly; the final snapshot still preserves totals.
  if (persist_exists(PKEY_SESSION_UNACKED) &&
      persist_read_bool(PKEY_SESSION_UNACKED)) s_journal_overflow = true;
  if (persist_exists(PKEY_SESSION_LAPN)) s_lap_n = persist_read_int(PKEY_SESSION_LAPN);
  if (persist_exists(PKEY_SESSION_LAPACTIVE)) s_lap_start_active_s = persist_read_int(PKEY_SESSION_LAPACTIVE);
  if (persist_exists(PKEY_SESSION_LAPDIST)) s_lap_start_dist_m = persist_read_int(PKEY_SESSION_LAPDIST);
  if (persist_exists(PKEY_SESSION_PAGE)) s_page = persist_read_int(PKEY_SESSION_PAGE);
  if (s_lap_n < 1) s_lap_n = 1;
  if (s_page < 0 || s_page >= WORKOUT_PAGE_COUNT) s_page = 0;
  if (s_pending_cmd == CMD_RENAME && persist_exists(PKEY_SESSION_NAME))
    persist_read_string(PKEY_SESSION_NAME, s_pending_name, sizeof(s_pending_name));
  if (s_state == STATE_RUNNING && s_run_anchor <= 0) s_run_anchor = time(NULL);
  s_elapsed_s = prv_elapsed_now();
}

// Called at the activity's health cadence while active (we're already awake for
// the elapsed-time tick).
// The sensor now samples slowly to save power, so we peek at the same cadence and
// keep a short running mean to take the shimmer off the reading. The smoothed value
// is what's shown and what's pushed to the phone.
static void prv_sample_hr(void) {
#if defined(PBL_HEALTH)
  time_t nowt = time(NULL);
  HealthServiceAccessibilityMask access =
      health_service_metric_accessible(HealthMetricHeartRateBPM, nowt, nowt);
  s_hr_access_mask = (int)access;
  if (!(access & HealthServiceAccessibilityMaskAvailable)) {
    // New firmware can explicitly disable Health/HR tracking. Say so instead
    // of leaving an unexplained dash forever; retain the last value on a brief
    // ordinary dropout.
    if (access & (HealthServiceAccessibilityMaskNoPermission |
                  HealthServiceAccessibilityMaskNotSupported)) {
      s_hr = 0;
      s_hr_ring_n = s_hr_ring_i = 0;
      s_hr_raw_prev = 0;
      s_hr_raw_prev_at = 0;
    }
    prv_update_hr();
    return;
  }
  int v = (int)health_service_peek_current_value(HealthMetricHeartRateBPM);
  if (v > 0) {
    // Recover genuine peaks hidden by the display mean without treating one
    // isolated optical-sensor jump as workout truth. A peak is accepted when an
    // adjacent active reading is physiologically close; otherwise the phone
    // still retains the maximum of the smoothed stream.
    bool independent = true;
    if (s_state == STATE_RUNNING) {
      time_t raw_at = time(NULL);
      int independent_after_s = s_hr_period_s > 0 ? s_hr_period_s : HR_RUN_PERIOD_S;
      // health_service_peek_current_value can return the same cached firmware
      // sample on multiple app peeks. Only compare readings far enough apart to
      // represent independent optical samples; otherwise one cached glitch could
      // corroborate itself.
      independent = s_hr_read_from_event || s_hr_raw_prev_at == 0 ||
                    raw_at < s_hr_raw_prev_at ||
                    raw_at - s_hr_raw_prev_at >= independent_after_s;
      if (independent) {
        if (raw_at < s_hr_raw_prev_at) s_hr_raw_prev = 0; // clock correction: restart the pair
        if (s_hr_raw_prev > 0) {
          int delta = v - s_hr_raw_prev;
          if (delta < 0) delta = -delta;
          if (delta <= HR_PEAK_MAX_STEP_BPM) {
            int pair_peak = v > s_hr_raw_prev ? v : s_hr_raw_prev;
            if (pair_peak > s_hr_peak_raw) s_hr_peak_raw = pair_peak;
          }
        }
        s_hr_raw_prev = v;
        s_hr_raw_prev_at = raw_at;
      }
    }
    // A polling fallback may see the same cached firmware value more than once;
    // never let that duplicate overweight the moving mean. Health events are
    // explicitly fresh samples even when the BPM happens to be unchanged.
    if (independent) {
      s_hr_ring[s_hr_ring_i] = v;
      s_hr_ring_i = (s_hr_ring_i + 1) % HR_AVG_N;
      if (s_hr_ring_n < HR_AVG_N) s_hr_ring_n++;
      int sum = 0, k;
      for (k = 0; k < s_hr_ring_n; k++) sum += s_hr_ring[k];
      s_hr = sum / s_hr_ring_n;
    }
  }
  prv_update_hr();   // hold the last mean on a brief dropout rather than flicker
#endif
}

// Step count moves slowly and is pushed on the activity's health cadence, so the
// today-sum (a health DB read) is refreshed there, not every second.
static void prv_begin_steps(void) {
#if defined(PBL_HEALTH)
  HealthValue today = health_service_sum_today(HealthMetricStepCount);
  s_steps_at_start = today;
  s_steps_gross_last = 0;
  s_steps_paused = 0;
  s_steps = 0;
  s_have_step_base = true;
  prv_update_steps();
#endif
}

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
static void prv_send_timer_cb(void *data) {
  (void)data;
  s_send_timer = NULL;
  prv_try_send();
}

static void prv_schedule_send(uint32_t delay_ms) {
  if (s_send_timer) app_timer_reschedule(s_send_timer, delay_ms);
  else s_send_timer = app_timer_register(delay_ms, prv_send_timer_cb, NULL);
}

static void prv_cancel_send_timer(void) {
  if (!s_send_timer) return;
  app_timer_cancel(s_send_timer);
  s_send_timer = NULL;
}

static void prv_reset_link_retry(void) {
  s_link_retry_ms = LINK_RETRY_MIN_MS;
}

static void prv_schedule_link_retry(void) {
  if (!s_phone_connected) return;
  prv_schedule_send(s_link_retry_ms);
  if (s_link_retry_ms < LINK_RETRY_MAX_MS) {
    uint32_t next = s_link_retry_ms * 2;
    s_link_retry_ms = next < LINK_RETRY_MAX_MS ? next : LINK_RETRY_MAX_MS;
  }
}

static void prv_connection_changed(bool connected) {
  if (s_phone_connected == connected) return;
  s_phone_connected = connected;
  prv_reset_link_retry();
  if (!connected) {
    // The compact watch journal and pending full-state command continue locally.
    // A connection edge, rather than a polling loop, wakes comms again.
    prv_cancel_send_timer();
  } else {
    s_hello_pending = true;
    prv_schedule_send(10);
  }
  prv_set_state_text();
}

/* dict_write_* silently stops writing once the outbox is full, which would send
 * a control message the phone reads as a different intent. Every write goes
 * through these so prv_try_send can refuse to transmit a truncated dict. */
static void prv_dw_u8(DictionaryIterator *out, uint32_t key, uint8_t v) {
  if (s_dict_full) return;
  if (dict_write_uint8(out, key, v) != DICT_OK) s_dict_full = true;
}
static void prv_dw_u32(DictionaryIterator *out, uint32_t key, uint32_t v) {
  if (s_dict_full) return;
  if (dict_write_uint32(out, key, v) != DICT_OK) s_dict_full = true;
}
static void prv_dw_i32(DictionaryIterator *out, uint32_t key, int32_t v) {
  if (s_dict_full) return;
  if (dict_write_int32(out, key, v) != DICT_OK) s_dict_full = true;
}
static void prv_dw_data(DictionaryIterator *out, uint32_t key,
                        const uint8_t *data, uint16_t len) {
  if (s_dict_full) return;
  if (dict_write_data(out, key, data, len) != DICT_OK) s_dict_full = true;
}

/* app_message_outbox_begin() leaves PebbleOS in its OUT_WRITING phase. There
 * is no public discard API: after any dictionary error, the documented way to
 * leave that phase is to finish/send the valid prefix. Mark it as kind zero so
 * no delivery bookkeeping is advanced. The public SDK has no close/discard
 * primitive; if this documented send path itself fails, disable comms instead
 * of burning battery in a retry loop that cannot leave OUT_WRITING. */
static void prv_release_partial_outbox(void) {
  s_outbox_kind = 0;
  s_queued_had_journal = false;
  s_outbox_busy = true;
  AppMessageResult r = app_message_outbox_send();
  if (r == APP_MSG_OK) return;
  APP_LOG(APP_LOG_LEVEL_ERROR, "could not release partial outbox (%d)", (int)r);
  s_outbox_busy = false;
  s_msg_ok = false;
  prv_cancel_send_timer();
  prv_flash("PHONE LINK ERROR");
}

/* prv_write_session() has 23 fixed tuples carrying 56 value bytes; CFGSET adds
 * one 1-byte tuple. Preflight the only variable-sized control (voice rename)
 * before beginning an outbox, including the dictionary and tuple headers. */
static uint32_t prv_session_wire_size(void) {
  const uint32_t dictionary_header = 1;
  const uint32_t tuple_header = 7;
  const uint32_t fixed_tuples = 23;
  const uint32_t fixed_values = 56;
  return dictionary_header + fixed_tuples * tuple_header + fixed_values +
         (s_local_settings_pending ? tuple_header + 1 : 0);
}

static uint32_t prv_control_wire_size(uint8_t cmd) {
  const uint32_t tuple_header = 7;
  uint32_t size = prv_session_wire_size() + tuple_header + 1;  // CMD
  if (cmd == CMD_RENAME)
    size += tuple_header + (uint32_t)strlen(s_pending_name) + 1;
  return size;
}

static int prv_write_journal_batch(DictionaryIterator *out) {
  int cap = s_msg_out_size >= 400 ? JOURNAL_BATCH_RECORDS : 12;
  int n = s_journal_n < cap ? s_journal_n : cap;
  if (n > 0)
    prv_dw_data(out, MESSAGE_KEY_WSAMPLES, &s_journal[0][0],
                (uint16_t)(n * JOURNAL_RECORD_BYTES));
  return n;
}

static void prv_write_session(DictionaryIterator *out) {
  prv_dw_u8(out, MESSAGE_KEY_PROTO, RUNLOG_PROTOCOL_VERSION);
  prv_dw_u32(out, MESSAGE_KEY_SID, s_sid);
  prv_dw_u32(out, MESSAGE_KEY_SEQ, s_pending_cmd ? s_pending_seq : s_seq);
  prv_dw_u8(out, MESSAGE_KEY_WSTATE, (uint8_t)s_state);
  prv_dw_u8(out, MESSAGE_KEY_APAUSE, (uint8_t)(s_autopaused ? 1 : 0));
  prv_dw_i32(out, MESSAGE_KEY_ACTIVE, prv_elapsed_now());
  prv_dw_i32(out, MESSAGE_KEY_STARTTS, (int32_t)s_started_at);
  prv_dw_i32(out, MESSAGE_KEY_SAMPLET, (int32_t)time(NULL));
  prv_dw_i32(out, MESSAGE_KEY_HR, s_hr);
  prv_dw_i32(out, MESSAGE_KEY_HRPK, s_hr_peak_raw);
  prv_dw_i32(out, MESSAGE_KEY_STEPS, s_steps);
  prv_dw_u8(out, MESSAGE_KEY_UNITS,  (uint8_t)(g_set.miles ? 1 : 0));
  prv_dw_u8(out, MESSAGE_KEY_AUTOP,  (uint8_t)(g_set.autopause ? 1 : 0));
  prv_dw_u8(out, MESSAGE_KEY_SPLITP, (uint8_t)(g_set.splits ? 1 : 0));
  prv_dw_u8(out, MESSAGE_KEY_MODE,   (uint8_t)g_set.mode);
  prv_dw_u8(out, MESSAGE_KEY_MHR,    (uint8_t)g_set.max_hr);
  prv_dw_u8(out, MESSAGE_KEY_RHR,    (uint8_t)g_set.rest_hr);
  prv_dw_u8(out, MESSAGE_KEY_HRZONE, (uint8_t)(g_set.show_hr_zone ? 1 : 0));
  if (s_local_settings_pending)
    prv_dw_u8(out, MESSAGE_KEY_CFGSET, 2);
  prv_dw_u8(out, MESSAGE_KEY_TGTYPE, (uint8_t)g_set.target_type);
  prv_dw_i32(out, MESSAGE_KEY_TGLO, g_set.target_lo);
  prv_dw_i32(out, MESSAGE_KEY_TGHI, g_set.target_hi);
  prv_dw_i32(out, MESSAGE_KEY_TGVAL, g_set.target_value);
  prv_dw_u8(out, MESSAGE_KEY_DQ, (uint8_t)(s_journal_overflow ? 1 : 0));
}

static void prv_try_send(void) {
  if (!s_msg_ok || !s_phone_connected || s_outbox_busy ||
      (!s_pending_cmd && !s_hello_pending)) return;
  uint8_t cmd = s_pending_cmd;
  bool flushing = cmd == CMD_STOP && s_journal_n > 0;
  if (!flushing && cmd && prv_control_wire_size(cmd) > s_msg_out_size) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox too small for cmd %d (%lu > %lu)",
            (int)cmd, (unsigned long)prv_control_wire_size(cmd),
            (unsigned long)s_msg_out_size);
    if (cmd == CMD_RENAME) {
      s_pending_cmd = 0; s_pending_seq = 0; s_pending_name[0] = 0;
      prv_session_persist();
      summary_action_result(CMD_RENAME, false);
      prv_set_state_text();
    }
    return;
  }
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    prv_schedule_link_retry();
    return;
  }
  s_dict_full = false;
  if (flushing) {
    // Drain durable sensor history before STOP. The phone ACKs only after its
    // journal write succeeds, so STOP can safely finalise a route-less workout.
    prv_dw_u8(out, MESSAGE_KEY_PROTO, RUNLOG_PROTOCOL_VERSION);
    prv_dw_u32(out, MESSAGE_KEY_SID, s_sid);
    prv_dw_i32(out, MESSAGE_KEY_STARTTS, (int32_t)s_started_at);
    prv_dw_u8(out, MESSAGE_KEY_WSTATE, (uint8_t)s_state);
    prv_dw_i32(out, MESSAGE_KEY_ACTIVE, prv_elapsed_now());
    prv_dw_u8(out, MESSAGE_KEY_MODE, (uint8_t)g_set.mode);
    prv_dw_u8(out, MESSAGE_KEY_DQ, (uint8_t)(s_journal_overflow ? 1 : 0));
    prv_dw_u8(out, MESSAGE_KEY_WSFLUSH, 1);
    prv_write_journal_batch(out);
    s_outbox_kind = 4;
  } else {
    prv_write_session(out);
  }
  if (!flushing && cmd) {
    prv_dw_u8(out, MESSAGE_KEY_CMD, cmd);
    if (cmd == CMD_RENAME && s_pending_name[0] &&
        dict_write_cstring(out, MESSAGE_KEY_RENAME, s_pending_name) != DICT_OK)
      s_dict_full = true;
    s_outbox_kind = 1;
  } else if (!flushing) {
    prv_dw_u8(out, MESSAGE_KEY_HELLO, 1);
    s_outbox_kind = 2;
  }
  if (s_dict_full) {
    // The variable-sized rename was preflighted, so this is an unexpected
    // dictionary failure. A rename still fails visibly; fixed-size lifecycle
    // controls remain pending and retry after the partial outbox is released.
    APP_LOG(APP_LOG_LEVEL_ERROR, "dictionary write failed for cmd %d", (int)cmd);
    if (cmd == CMD_RENAME) {
      s_pending_cmd = 0; s_pending_seq = 0; s_pending_name[0] = 0;
      prv_session_persist();
      summary_action_result(CMD_RENAME, false);
      prv_set_state_text();
    }
    prv_release_partial_outbox();
    return;
  }
  s_outbox_busy = true;
  if (app_message_outbox_send() != APP_MSG_OK) {
    s_outbox_busy = false;
    prv_schedule_link_retry();
  }
}

static void prv_outbox_sent(DictionaryIterator *iter, void *context) {
  (void)iter; (void)context;
  uint8_t kind = s_outbox_kind;
  s_outbox_busy = false;
  s_outbox_kind = 0;
  if (kind == 3) {
    // Only advance the delta baseline after Pebble confirms delivery. Otherwise
    // one failed packet could suppress the changed HR/steps/peak until keepalive.
    s_last_sent_hr = s_queued_hr;
    s_last_sent_steps = s_queued_steps;
    s_last_sent_hr_peak = s_queued_hr_peak;
    s_last_sample_sent_at = s_queued_sample_at;
    if (s_queued_had_journal) s_journal_last_sent_at = (uint32_t)time(NULL);
  }
  s_queued_had_journal = false;
  if (kind == 1 || kind == 2 || kind == 4) {
    // AppMessage delivery is not the durable protocol ACK. Retry until the
    // state/ACK arrives, but back off so a wedged phone cannot dominate power.
    prv_schedule_link_retry();
  } else if (s_pending_cmd || s_hello_pending) {
    /*
     * A button/control or reconnect snapshot can be queued while an
     * ordinary health sample owns the outbox. Kick it as soon as that sample
     * completes; the next health tick is suppressed while a control is pending.
     */
    prv_schedule_send(10);
  }
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  (void)iter; (void)reason; (void)context;
  uint8_t kind = s_outbox_kind;
  s_outbox_busy = false;
  s_outbox_kind = 0;
  s_queued_had_journal = false;
  if (kind == 1 || kind == 2 || kind == 4) {
    prv_schedule_link_retry();
  } else if (s_pending_cmd || s_hello_pending) {
    prv_schedule_link_retry();
  }
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  (void)reason; (void)context;
  s_hello_pending = true;
  prv_schedule_link_retry();
}

static bool prv_queue_cmd(uint8_t cmd) {
  if (!s_msg_ok) {
    prv_flash("PHONE LINK ERROR");
    return false;
  }
  if (s_pending_cmd) {
    bool old_lifecycle = s_pending_cmd >= CMD_START && s_pending_cmd <= CMD_STOP;
    bool new_lifecycle = cmd >= CMD_START && cmd <= CMD_STOP;
    if (!old_lifecycle || !new_lifecycle || s_pending_cmd == CMD_STOP) {
      prv_flash("WAITING FOR PHONE");
      return false;
    }
    // Disconnected controls remain usable. The newest full-state intent
    // supersedes the older one; protocol-v3 reconciliation makes it atomic.
  }
  s_seq++;
  s_pending_seq = s_seq;
  s_pending_cmd = cmd;
  if (cmd == CMD_STOP) s_journal_flush_pending = true;
  prv_session_persist();
  prv_reset_link_retry();
  prv_try_send();
  return true;
}

bool comms_send_cmd(uint8_t cmd) { return prv_queue_cmd(cmd); }

bool comms_send_rename(const char *name) {
  if (!name || !name[0]) return false;
  if (!s_msg_ok) { prv_flash("PHONE LINK ERROR"); return false; }
  if (s_pending_cmd) { prv_flash("WAITING FOR PHONE"); return false; }
  snprintf(s_pending_name, sizeof(s_pending_name), "%s", name);
  return prv_queue_cmd(CMD_RENAME);
}

/* Summary screen confirmed a discard: wipe the run screen back to READY. */
void main_workout_discarded(void) {
  s_state = STATE_READY;
  prv_session_clear();
  s_dist_m = 0; s_pace_s = 0; s_steps = 0; s_hr = 0;
  s_egain_live_m = s_moving_live_s = s_avg_hr_live = 0;
  s_page = 0; s_lap_n = 1; s_lap_start_active_s = s_lap_start_dist_m = 0;
  prv_update_time();
  prv_update_dist();
  prv_update_pace();
  prv_update_steps();
  prv_set_state_text();
  prv_flash("DISCARDED");
}

void phone_config_open(void) {
  if (prv_queue_cmd(CMD_CONFIG)) prv_flash("OPEN PHONE");
}

static void prv_send_sample(bool force) {
  time_t sample_at = time(NULL);
  int journal_period = g_set.mode == MODE_HIKE ? JOURNAL_HIKE_S : JOURNAL_NORMAL_S;
  if (s_state == STATE_RUNNING &&
      (!s_journal_last_added_at || (uint32_t)sample_at >= s_journal_last_added_at + (uint32_t)journal_period))
    prv_journal_add(false);
  if (!s_msg_ok || !s_phone_connected || s_outbox_busy || s_pending_cmd)
    return;   // retain locally; connection edges wake comms, controls always win
  bool keepalive_due = s_last_sample_sent_at == 0 ||
                       sample_at < s_last_sample_sent_at ||
                       sample_at - s_last_sample_sent_at >= prv_sample_keepalive_s();
  bool journal_due = s_journal_n > 0 &&
      (force || !s_journal_last_sent_at ||
       (uint32_t)sample_at >= s_journal_last_sent_at + (uint32_t)journal_period);
  if (!force && s_hr == s_last_sent_hr && s_steps == s_last_sent_steps &&
      s_hr_peak_raw == s_last_sent_hr_peak && !keepalive_due && !journal_due) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  s_dict_full = false;
  prv_dw_u8(out, MESSAGE_KEY_PROTO, RUNLOG_PROTOCOL_VERSION);
  prv_dw_u32(out, MESSAGE_KEY_SID, s_sid);
  prv_dw_i32(out, MESSAGE_KEY_SAMPLET, (int32_t)sample_at);
  prv_dw_i32(out, MESSAGE_KEY_HR, s_hr);
  // Peak is cumulative, so retransmit it only when it advances or on a
  // keepalive. The final STOP/full session always carries it as well.
  bool write_peak = force || keepalive_due || s_hr_peak_raw != s_last_sent_hr_peak;
  if (write_peak) prv_dw_i32(out, MESSAGE_KEY_HRPK, s_hr_peak_raw);
  prv_dw_i32(out, MESSAGE_KEY_STEPS, s_steps);
  int journal_written = journal_due ? prv_write_journal_batch(out) : 0;
  if (s_dict_full) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "health sample exceeded outbox; dropping");
    prv_release_partial_outbox();
    return;
  }
  s_outbox_kind = 3;
  s_outbox_busy = true;
  if (app_message_outbox_send() != APP_MSG_OK) {
    s_outbox_busy = false;
    s_outbox_kind = 0;
  } else {
    s_queued_hr = s_hr;
    s_queued_steps = s_steps;
    s_queued_hr_peak = write_peak ? s_hr_peak_raw : s_last_sent_hr_peak;
    s_queued_sample_at = sample_at;
    s_queued_had_journal = journal_written > 0;
  }
}

static void prv_send_hello(void) {
  s_hello_pending = true;
  prv_reset_link_retry();
  prv_try_send();
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
  // Any inbound packet proves that the complete phone round trip is alive.
  prv_reset_link_retry();
  Tuple *t;
  bool saved = (dict_find(iter, MESSAGE_KEY_SAVED) != NULL);
  bool no_save = (dict_find(iter, MESSAGE_KEY_NOSAVE) != NULL);
  bool stats_changed = false;
  bool track_changed = false;
  Tuple *t_cfgset = dict_find(iter, MESSAGE_KEY_CFGSET);
  bool config_packet = t_cfgset != NULL;
  int config_kind = t_cfgset ? (int)t_cfgset->value->int32 : 0;
  int acked_cmd = 0;
  bool acked_ok = true;
  Tuple *t_sid = dict_find(iter, MESSAGE_KEY_SID);
  Tuple *t_ack = dict_find(iter, MESSAGE_KEY_ACK);
  Tuple *t_state = dict_find(iter, MESSAGE_KEY_WSTATE);
  Tuple *t_wsack = dict_find(iter, MESSAGE_KEY_WSACK);
  uint32_t incoming_sid = t_sid ? (uint32_t)t_sid->value->uint32 : 0;
  bool exact_pending_ack = t_ack && s_pending_cmd &&
      (uint32_t)t_ack->value->uint32 == s_pending_seq;
  bool session_mutation = t_state || saved || no_save || t_ack || t_wsack;

  // Phone messages are asynchronous and protected packets can survive an app
  // restart. A state, save/no-save or journal ACK for another (or unidentified)
  // session must never roll back the workout currently owned by this process.
  // An exact ACK for our globally persisted command sequence is the sole
  // exception: DISCARD and a rejected START legitimately answer with SID zero.
  if (s_sid && session_mutation && (!t_sid || incoming_sid != s_sid) &&
      !exact_pending_ack) {
    APP_LOG(APP_LOG_LEVEL_INFO, "ignoring stale session packet for %lu (want %lu)",
            (unsigned long)incoming_sid, (unsigned long)s_sid);
    return;
  }

  // Protected AppMessages can outlive the watch process that requested them.
  // Never let an old SAVED retry resurrect a completed workout on launch or
  // replace a different workout the user has already started.
  if (saved) {
    if (!s_accept_saved) {
      APP_LOG(APP_LOG_LEVEL_INFO, "ignoring stale SAVED for %lu",
              (unsigned long)incoming_sid);
      return;
    }
  }

  // Detail-page uploads and delayed summary fragments can concern an older
  // workout. Only authoritative state/ACK/save packets may change the current
  // session; silently ignore other session-scoped packets that do not match.
  if (t_sid) {
    bool authoritative = t_state || saved || no_save;
    if (!authoritative && incoming_sid != s_sid) return;
    if (authoritative) s_sid = incoming_sid;
  }
  if (t_wsack && (!t_sid || (uint32_t)t_sid->value->uint32 == s_sid)) {
    uint32_t ack = (uint32_t)t_wsack->value->uint32;
    int drop = 0;
    while (drop < s_journal_n && prv_get_le32(s_journal[drop]) <= ack) drop++;
    if (drop > 0) {
      if (drop < s_journal_n)
        memmove(s_journal[0], s_journal[drop],
                (size_t)(s_journal_n - drop) * JOURNAL_RECORD_BYTES);
      s_journal_n -= drop;
      s_journal_last_sent_at = 0;
      if (s_journal_n == 0) s_journal_flush_pending = false;
      prv_session_persist();
      if (s_pending_cmd == CMD_STOP) prv_schedule_send(10);
    }
  }
  if (t_ack && s_pending_cmd &&
      (uint32_t)t_ack->value->uint32 == s_pending_seq) {
    acked_cmd = s_pending_cmd;
    Tuple *tr = dict_find(iter, MESSAGE_KEY_RESULT);
    acked_ok = !tr || tr->value->int32 != 0;
    s_pending_cmd = 0;
    s_pending_seq = 0;
    s_pending_name[0] = 0;
    prv_cancel_send_timer();
  }

  if (t_state) {
    int remote = (int)t_state->value->int32;
    RunState old_state = s_state;
    bool old_autopaused = s_autopaused;
    Tuple *tap = dict_find(iter, MESSAGE_KEY_APAUSE);
    bool remote_autopaused = (remote == STATE_PAUSED && tap && tap->value->int32 != 0);
    Tuple *ta = dict_find(iter, MESSAGE_KEY_ACTIVE);
    if (ta) {
      s_active_base_s = (int)ta->value->int32;
      if (s_active_base_s < 0) s_active_base_s = 0;
      s_elapsed_s = s_active_base_s;
    }
    Tuple *tstart = dict_find(iter, MESSAGE_KEY_STARTTS);
    if (tstart) s_started_at = (time_t)tstart->value->int32;
    if (remote >= STATE_READY && remote <= STATE_DONE) {
      // Phone-originated auto-pause/resume still needs an exact health boundary.
      // Manual transitions already changed local state before their ACK arrives,
      // so these reads occur only when the remote snapshot causes the edge.
      if ((old_state == STATE_RUNNING && remote == STATE_PAUSED) ||
          (old_state == STATE_PAUSED && remote == STATE_RUNNING))
        prv_refresh_steps();
      s_state = (RunState)remote;
      if (s_state == STATE_READY)
        s_accept_saved = false;
      else if (s_state >= STATE_RUNNING && s_state <= STATE_SAVING)
        s_accept_saved = true;
      if (s_state == STATE_RUNNING) {
        s_run_anchor = time(NULL);
        if (old_state != STATE_RUNNING) {
          s_health_countdown_s = 0;
          s_hr_raw_prev = 0;
          s_hr_raw_prev_at = 0;
        }
      } else {
        s_run_anchor = 0;
        if (old_state == STATE_RUNNING) {
          s_hr_raw_prev = 0;
          s_hr_raw_prev_at = 0;
        }
      }
      s_autopaused = remote_autopaused;
      if (old_state != s_state || old_autopaused != s_autopaused)
        prv_journal_add(false);
      if ((old_state == STATE_RUNNING && remote_autopaused) ||
          (old_state == STATE_PAUSED && old_autopaused && remote == STATE_RUNNING))
        vibes_short_pulse();
      prv_update_time();
      prv_set_state_text();
    }
    s_hello_pending = false;
    if (!s_pending_cmd) prv_cancel_send_timer();
    prv_session_persist();
  }

  // CFGSET=2 is the phone's explicit acknowledgement of a watch-local settings
  // edit. Clear the durable marker only after the complete echoed snapshot
  // matches; a lost response therefore leaves the watch retryable after restart.
  if (config_kind == 2 && s_local_settings_pending) {
    Tuple *tu = dict_find(iter, MESSAGE_KEY_UNITS);
    Tuple *taut = dict_find(iter, MESSAGE_KEY_AUTOP);
    Tuple *tsp = dict_find(iter, MESSAGE_KEY_SPLITP);
    Tuple *tmh = dict_find(iter, MESSAGE_KEY_MHR);
    Tuple *trh = dict_find(iter, MESSAGE_KEY_RHR);
    Tuple *thz = dict_find(iter, MESSAGE_KEY_HRZONE);
    bool matches = tu && taut && tsp && tmh && trh && thz &&
      (tu->value->int32 == 0 || tu->value->int32 == 1) &&
      (taut->value->int32 == 0 || taut->value->int32 == 1) &&
      (tsp->value->int32 == 0 || tsp->value->int32 == 1) &&
      (thz->value->int32 == 0 || thz->value->int32 == 1) &&
      ((tu->value->int32 != 0) == g_set.miles) &&
      ((taut->value->int32 != 0) == g_set.autopause) &&
      ((tsp->value->int32 != 0) == g_set.splits) &&
      ((int)tmh->value->int32 == g_set.max_hr) &&
      ((int)trh->value->int32 == g_set.rest_hr) &&
      ((thz->value->int32 != 0) == g_set.show_hr_zone);
    if (matches) {
      s_local_settings_pending = false;
      prv_persist_delete_if_present(PKEY_LOCAL_SET_PENDING);
    } else {
      // The ACK may belong to an earlier local toggle. Keep the marker and
      // immediately advertise the newest complete snapshot again.
      prv_send_hello();
    }
  }

  // CFGSET=1 is a phone-originated settings edit. Never change settings under
  // an active workout; the phone retains and retries its pending snapshot. A
  // local edit has no comparable generation number, so it stays authoritative
  // until the phone acknowledges it instead of guessing from arrival order.
  if (config_kind == 1 && (s_state == STATE_READY || s_state == STATE_DONE)) {
    if (s_local_settings_pending) {
      // This may be an older disconnected phone retry. Re-send the watch edit;
      // its matching CFGSET=2 echo is the only safe conflict boundary.
      prv_send_hello();
    } else {
      bool changed = false;
      if ((t = dict_find(iter, MESSAGE_KEY_UNITS))) {
        bool v = t->value->int32 != 0;
        if (v != g_set.miles) { g_set.miles = v; changed = true; }
      }
      if ((t = dict_find(iter, MESSAGE_KEY_AUTOP))) {
        bool v = t->value->int32 != 0;
        if (v != g_set.autopause) { g_set.autopause = v; changed = true; }
      }
      if ((t = dict_find(iter, MESSAGE_KEY_SPLITP))) {
        bool v = t->value->int32 != 0;
        if (v != g_set.splits) { g_set.splits = v; changed = true; }
      }
      if ((t = dict_find(iter, MESSAGE_KEY_MHR))) {
        int v = (int)t->value->int32;
        if (v >= 80 && v <= 220 && v != g_set.max_hr) {
          g_set.max_hr = v; changed = true;
        }
      }
      if ((t = dict_find(iter, MESSAGE_KEY_RHR))) {
        int v = (int)t->value->int32;
        if (v >= 0 && v <= 120 && v != g_set.rest_hr) {
          g_set.rest_hr = v; changed = true;
        }
      }
      if ((t = dict_find(iter, MESSAGE_KEY_HRZONE))) {
        bool v = t->value->int32 != 0;
        if (v != g_set.show_hr_zone) { g_set.show_hr_zone = v; changed = true; }
      }
      if (changed) settings_save_and_sync();
      else         prv_send_hello();  // acknowledge an already-applied retry
    }
  }

  if (no_save) {
    // The phone had nothing to store (no usable GPS, or storage was full). Reset
    // to a clean READY screen and say NOT SAVED — don't hang on SAVING and
    // don't leave the attempted run's numbers on screen.
    s_state = STATE_READY;
    prv_session_clear();
    s_elapsed_s = 0; s_dist_m = 0; s_pace_s = 0; s_steps = 0; s_hr = 0;
    s_hr_ring_n = 0; s_hr_ring_i = 0; s_steps_paused = 0;
    s_hr_peak_raw = 0; s_hr_raw_prev = 0; s_hr_raw_prev_at = 0;
    s_health_countdown_s = 0;
    s_egain_live_m = s_moving_live_s = s_avg_hr_live = 0;
    s_page = 0; s_lap_n = 1; s_lap_start_active_s = s_lap_start_dist_m = 0;
    prv_update_time(); prv_update_dist(); prv_update_pace(); prv_update_steps(); prv_update_hr();
    prv_update_actionbar();
    prv_set_state_text();
    vibes_double_pulse();
    prv_flash("NOT SAVED");
    return;
  }

  if (saved) {
    if (s_state == STATE_RUNNING) prv_freeze_elapsed();
    s_state = STATE_DONE;
    s_run_anchor = 0;
    vibes_long_pulse();
    prv_set_state_text();
    summary_reset_for_new_run();   // fresh activity: no stale upload state or dismissal
    g_stats.dur_s = s_elapsed_s;
    g_stats.steps = s_steps;
    g_stats.dist_m = s_dist_m;
    g_stats.mov_s = 0;
    g_stats.avgp_s = 0;
    g_stats.avg_hr = 0;
    g_stats.max_hr = 0;
    g_stats.vo2 = 0;
    g_stats.egain_m = 0;
    g_stats.route = -1;
    g_stats.trk_n = 0;
    g_stats.trk_span_m = 0;
    g_stats.pace_n = 0;
    g_stats.hr_n = 0;
    prv_session_persist();
  }

  if (!config_packet && (t = dict_find(iter, MESSAGE_KEY_MODE))) {
    // The activity this run was RECORDED as. Deliberately does NOT touch
    // g_set.mode: DOWN can cycle the live setting while a debrief is still open,
    // and the debrief must keep describing the run it belongs to.
    int m = (int)t->value->int32;
    if (m >= 0 && m < MODE_COUNT) {
      if (m != g_stats.act) {
        g_stats.act = m;
        track_changed = true;   // refresh/re-layout the visible debrief if necessary
      }
    }
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
    int old_visual = prv_gps_visual_state(s_gps_ok, s_acc_m);
    bool old_gps_ok = s_gps_ok;
    bool next_gps_ok = (t->value->int32 != 0);
    s_gps_ok = next_gps_ok;
    if (!s_gps_ok) s_acc_m = -1;
    if (old_visual != prv_gps_visual_state(s_gps_ok, s_acc_m) && s_chrome_layer)
      layer_mark_dirty(s_chrome_layer);
    prv_update_acc();
    if (old_gps_ok != s_gps_ok) prv_set_state_text();
  }
  if ((t = dict_find(iter, MESSAGE_KEY_ACC))) {
    int old_visual = prv_gps_visual_state(s_gps_ok, s_acc_m);
    int next_acc_m = (int)t->value->int32;
    s_acc_m = next_acc_m;
    if (old_visual != prv_gps_visual_state(s_gps_ok, s_acc_m) && s_chrome_layer)
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
  if ((t = dict_find(iter, MESSAGE_KEY_DURS))) {
    g_stats.dur_s = (int)t->value->int32;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_EGAIN))) {
    g_stats.egain_m = (int)t->value->int32;
    stats_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_EGLIVE))) {
    s_egain_live_m = (int)t->value->int32;
    prv_render_page();
  }
  if ((t = dict_find(iter, MESSAGE_KEY_MOVLIVE))) {
    s_moving_live_s = (int)t->value->int32;
    prv_render_page();
  }
  if ((t = dict_find(iter, MESSAGE_KEY_AVGHRLIVE))) {
    s_avg_hr_live = (int)t->value->int32;
    prv_render_page();
  }
  Tuple *tlapn = dict_find(iter, MESSAGE_KEY_LAPN);
  Tuple *tlapd = dict_find(iter, MESSAGE_KEY_LAPD);
  Tuple *tlapt = dict_find(iter, MESSAGE_KEY_LAPT);
  if (tlapn && tlapn->value->int32 > 0) s_lap_n = (int)tlapn->value->int32;
  if (tlapd) s_lap_start_dist_m = s_dist_m - (int)tlapd->value->int32;
  if (tlapt) s_lap_start_active_s = prv_elapsed_now() - (int)tlapt->value->int32;
  if (tlapn || tlapd || tlapt || dict_find(iter, MESSAGE_KEY_LAPP)) prv_render_page();

  bool target_changed = false;
  if ((t = dict_find(iter, MESSAGE_KEY_TGTYPE))) {
    int v = (int)t->value->int32;
    if (v >= TARGET_OFF && v <= TARGET_PACE && v != g_set.target_type) {
      g_set.target_type = v; target_changed = true;
    }
  }
  if ((t = dict_find(iter, MESSAGE_KEY_TGLO))) {
    int v = (int)t->value->int32;
    if (v >= 0 && v != g_set.target_lo) { g_set.target_lo = v; target_changed = true; }
  }
  if ((t = dict_find(iter, MESSAGE_KEY_TGHI))) {
    int v = (int)t->value->int32;
    if (v >= 0 && v != g_set.target_hi) { g_set.target_hi = v; target_changed = true; }
  }
  if ((t = dict_find(iter, MESSAGE_KEY_TGVAL))) {
    int v = (int)t->value->int32;
    if (v >= 0 && v != g_set.target_value) { g_set.target_value = v; target_changed = true; }
  }
  if (target_changed) {
    prv_persist_int_if_changed(PKEY_TARGET_TYPE, g_set.target_type);
    prv_persist_int_if_changed(PKEY_TARGET_LO, g_set.target_lo);
    prv_persist_int_if_changed(PKEY_TARGET_HI, g_set.target_hi);
    prv_persist_int_if_changed(PKEY_TARGET_VALUE, g_set.target_value);
    s_target_bad_since = s_target_last_alert = 0;
    s_target_complete_alerted = false;
    prv_render_page();
  }
  if ((t = dict_find(iter, MESSAGE_KEY_TSPAN))) {
    g_stats.trk_span_m = (int)t->value->int32;
    track_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_ROUTE))) {
    g_stats.route = t->value->int32 ? 1 : 0;
    track_changed = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_TRACK))) {
    // track bytes come as even‑length sequence of x,y pairs in 0..200
    uint8_t *bytes = t->value->data;
    size_t len = t->length;
    size_t n = len / 2;
    if (n > TRACK_MAX_PTS) n = TRACK_MAX_PTS;
    g_stats.trk_n = (int)n;
    if (n >= 2) g_stats.route = 1;
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
  if (!t_state && (t = dict_find(iter, MESSAGE_KEY_APAUSE))) {
    // phone-driven auto-pause: stop/restart the timer and show it in the pill
    if (t->value->int32) {
      if (s_state == STATE_RUNNING) {
        prv_refresh_steps();             // account the boundary while still RUNNING
        prv_freeze_elapsed();
        s_state = STATE_PAUSED;
        s_autopaused = true;
        s_hr_raw_prev = 0;
        s_hr_raw_prev_at = 0;
        prv_journal_add(false);
        vibes_short_pulse();
      }
    } else {
      if (s_state == STATE_PAUSED && s_autopaused) {
        prv_refresh_steps();             // account paused steps before switching state
        s_state = STATE_RUNNING;
        s_autopaused = false;
        s_health_countdown_s = 0;         // sample promptly after every auto-resume
        s_hr_raw_prev = 0;
        s_hr_raw_prev_at = 0;
        prv_resume_elapsed();
        prv_journal_add(false);
        vibes_short_pulse();
      }
    }
    prv_set_state_text();
    prv_session_persist();
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
  if (acked_cmd == CMD_DISCARD || acked_cmd == CMD_UPLOAD || acked_cmd == CMD_RENAME)
    summary_action_result(acked_cmd, acked_ok);
  if (acked_cmd && !t_state) prv_session_persist();
}

// ---------------- Buttons ----------------
static void prv_change_page(int delta) {
  s_page = (s_page + delta + WORKOUT_PAGE_COUNT) % WORKOUT_PAGE_COUNT;
  s_dist_buf[0] = s_pace_buf[0] = s_hr_buf[0] = s_steps_buf[0] = '\0';
  prv_set_state_text();
  vibes_short_pulse();
}

static void prv_manual_pause_from_auto(void) {
  if (s_state != STATE_PAUSED || !s_autopaused) return;
  prv_refresh_steps();
  s_autopaused = false;                 // elapsed was already frozen: no fake resume
  s_hr_raw_prev = 0;
  s_hr_raw_prev_at = 0;
  prv_journal_add(false);
  prv_queue_cmd(CMD_PAUSE);             // phone atomically auto-held -> manual-paused
  prv_set_state_text();
  vibes_short_pulse();
}

static void prv_select_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (!s_msg_ok) { prv_flash("PHONE LINK ERROR"); return; }
  switch (s_state) {
    case STATE_READY:
    case STATE_DONE:
      s_state = STATE_RUNNING;
      s_accept_saved = true;
      s_autopaused = false;
      s_active_base_s = 0; s_elapsed_s = 0; s_dist_m = 0; s_pace_s = 0; s_steps = 0;
      s_started_at = time(NULL);
      s_run_anchor = s_started_at;
      s_sid = prv_new_sid();
      s_hr = 0; s_hr_ring_n = 0; s_hr_ring_i = 0;   // don't carry the previous run's HR into this one
      s_hr_peak_raw = 0;
      s_hr_raw_prev = 0;
      s_hr_raw_prev_at = 0;
      s_health_countdown_s = 0;                      // sample on the very next tick
      s_egain_live_m = s_moving_live_s = s_avg_hr_live = 0;
      s_page = 0;
      s_lap_n = 1; s_lap_start_active_s = 0; s_lap_start_dist_m = 0;
      s_target_bad_since = s_target_last_alert = 0;
      s_target_complete_alerted = false;
      s_journal_n = 0; s_journal_last_added_at = s_journal_last_sent_at = 0;
      s_journal_overflow = false; s_journal_flush_pending = false;
      g_stats.act = g_set.mode;                      // locked in now; the phone confirms it via MODE
      s_steps_paused = 0;                            // and don't carry a paused-step offset
      prv_begin_steps();                             // capture the boundary before the first step
      prv_journal_add(false);
      g_stats.trk_n = 0; g_stats.trk_span_m = 0; g_stats.pace_n = 0; g_stats.hr_n = 0;
      prv_update_time(); prv_update_dist(); prv_update_pace(); prv_update_steps(); prv_update_hr();
      prv_queue_cmd(CMD_START);
      vibes_short_pulse();
      break;
    case STATE_RUNNING:
      prv_refresh_steps();             // classify the final delta as running
      prv_freeze_elapsed();
      s_state = STATE_PAUSED;
      s_autopaused = false;
      s_hr_raw_prev = 0;
      s_hr_raw_prev_at = 0;
      prv_journal_add(false);
      prv_queue_cmd(CMD_PAUSE);
      vibes_short_pulse();
      break;
    case STATE_PAUSED:
      prv_refresh_steps();             // classify the final delta as paused
      s_state = STATE_RUNNING;
      s_autopaused = false;
      s_health_countdown_s = 0;        // don't wait out the old period after resuming
      s_hr_raw_prev = 0;
      s_hr_raw_prev_at = 0;
      prv_resume_elapsed();
      prv_journal_add(false);
      prv_queue_cmd(CMD_RESUME);
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
    if (!s_msg_ok) { prv_flash("PHONE LINK ERROR"); return; }
    prv_sample_hr();
    prv_refresh_steps();               // final boundary sample under the old state
    if (s_state == STATE_RUNNING) prv_freeze_elapsed();
    s_state = STATE_SAVING;
    s_autopaused = false;
    s_run_anchor = 0;
    prv_journal_add(false);
    prv_queue_cmd(CMD_STOP);
    prv_set_state_text();
  } else if (s_state == STATE_SAVING) {
    // Do not pretend a save completed. Re-send the pending STOP or request the
    // authoritative state/summary if the phone acknowledged but SAVED was lost.
    if (s_pending_cmd) prv_try_send();
    else prv_send_hello();
    prv_flash("RETRYING SAVE");
  }
}

static void prv_down_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_state == STATE_READY || s_state == STATE_DONE) {
    g_set.mode = (g_set.mode + 1) % MODE_COUNT;
    settings_save_and_sync();
    prv_update_caps();        // PACE <-> SPEED label
    prv_update_actionbar();   // DOWN activity icon
    vibes_short_pulse();
  } else if (s_state == STATE_PAUSED && s_autopaused) {
    prv_manual_pause_from_auto();
  } else if (s_state == STATE_RUNNING || s_state == STATE_PAUSED) {
    prv_change_page(1);
  }
}

static void prv_down_long(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_state != STATE_RUNNING) return;
  int completed = s_lap_n;
  prv_sample_hr();
  prv_refresh_steps();
  prv_journal_add(true);
  s_lap_n++;
  s_lap_start_active_s = prv_elapsed_now();
  s_lap_start_dist_m = s_dist_m;
  prv_session_persist();
  s_page = 1;
  s_dist_buf[0] = s_pace_buf[0] = s_hr_buf[0] = s_steps_buf[0] = '\0';
  prv_set_state_text();
  prv_send_sample(true);
  snprintf(s_flash_buf, sizeof(s_flash_buf), "LAP %d SAVED", completed);
  prv_flash(s_flash_buf);
  vibes_double_pulse();
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
  // DOWN cycles run / walk / ride / hike while idle
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click);
  window_long_click_subscribe(BUTTON_ID_DOWN, 700, prv_down_long, NULL);
}

// A manual refresh is deliberately a best-effort HELLO/session snapshot, not a
// durable lifecycle command. It can never get in front of PAUSE/STOP in the
// command journal. The fresh local Health values ride in the snapshot, then the
// phone replies with its authoritative distance, pace, lap and GPS values.
static void prv_manual_refresh(void) {
  time_t sec;
  uint16_t ms;
  time_ms(&sec, &ms);
  uint32_t at = (uint32_t)sec * 1000u + ms;
  if (s_last_refresh_ms && at - s_last_refresh_ms < REFRESH_TAP_GAP_MS) return;
  s_last_refresh_ms = at;

  if (s_state == STATE_RUNNING || s_state == STATE_PAUSED) {
    prv_sample_hr();
    prv_refresh_steps();
    prv_render_page();
    // If this occupies the outbox, prv_send_hello() remains pending and is
    // automatically sent by the outbox callback. Controls still take priority.
    prv_send_sample(true);
  }
  prv_send_hello();
  prv_flash(s_phone_connected ? "REFRESHING" : "PHONE OFFLINE");
}

static void prv_touch_tap(const Recognizer *recognizer, RecognizerEvent event) {
  (void)recognizer;
  if (event == RecognizerEvent_Completed) prv_manual_refresh();
}

static void prv_touch_swipe(const Recognizer *recognizer, RecognizerEvent event) {
  if (event != RecognizerEvent_Completed) return;
  switch (swipe_recognizer_get_direction(recognizer)) {
    // Match PebbleOS's touch bridge: content follows the finger vertically,
    // while left/right retain SELECT/BACK semantics.
    case SwipeDirection_Up:    prv_down_click(NULL, NULL); break;
    case SwipeDirection_Down:  prv_up_click(NULL, NULL); break;
    case SwipeDirection_Left:  prv_select_click(NULL, NULL); break;
    case SwipeDirection_Right: prv_back_click(NULL, NULL); break;
    default: break;
  }
}

static void prv_attach_touch_recognizers(Window *window) {
  Recognizer *swipe = swipe_recognizer_create(
      prv_touch_swipe, NULL,
      SwipeDirection_Up | SwipeDirection_Down |
      SwipeDirection_Left | SwipeDirection_Right);
  Recognizer *tap = tap_recognizer_create(prv_touch_tap, NULL);
  if (tap && swipe) recognizer_set_fail_after(tap, swipe);
  if (swipe) window_attach_recognizer(window, swipe);
  if (tap) window_attach_recognizer(window, tap);
}

// ---------------- Ticks ----------------
static void prv_pause_sample_cb(void *data) {
  (void)data;
  s_pause_sample_timer = NULL;
  if (s_state != STATE_PAUSED) return;
  prv_sample_hr();
  prv_refresh_steps();
  s_pause_sample_timer = app_timer_register(PAUSE_SAMPLE_PERIOD_S * 1000,
                                             prv_pause_sample_cb, NULL);
}

static void prv_tick(struct tm *tick_time, TimeUnits units) {
  (void)tick_time;
  if (s_state == STATE_RUNNING) {
    s_elapsed_s = prv_elapsed_now();
    prv_update_time();
    prv_check_target();
    if (s_page != 0) prv_render_page();
    // Fixed per-mode cadence, reset on every transition into RUNNING. This is
    // independent of workout duration and immune to wall-clock adjustments.
    if (s_health_countdown_s <= 0) {
      if (!s_health_events_active) prv_sample_hr();
      prv_refresh_steps();
      prv_send_sample(false);
      s_health_countdown_s = prv_sample_period_s();
    }
    s_health_countdown_s--;
  }
  if (units & MINUTE_UNIT) prv_update_clock();         // clock only ticks by the minute
}

/* The per-second tick is only needed while RUNNING. PAUSED uses one low-duty
 * health timer for its informational HR display; its frozen elapsed timer and
 * the READY/DONE screens need only the minute wall-clock tick. */
static void prv_apply_tick(void) {
  TimeUnits want = (s_state == STATE_RUNNING) ? SECOND_UNIT : MINUTE_UNIT;
  if ((int)want != s_tick_unit) {
    s_tick_unit = (int)want;
    tick_timer_service_subscribe(want, prv_tick);
  }
  if (s_state == STATE_PAUSED) {
    if (!s_pause_sample_timer)
      s_pause_sample_timer = app_timer_register(PAUSE_SAMPLE_PERIOD_S * 1000,
                                                 prv_pause_sample_cb, NULL);
  } else if (s_pause_sample_timer) {
    app_timer_cancel(s_pause_sample_timer);
    s_pause_sample_timer = NULL;
  }
}

// ---------------- Chrome (GPS, page rule + metric dividers) ----------------
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

  // Crisp one-pixel rules and whitespace are closer to Pebble's own UI than
  // four boxed tiles. The orange segment mirrors the debrief's page marker.
  int gw = s_content_w > 0 ? s_content_w : b.size.w;
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
  graphics_draw_line(ctx, GPoint(8, s_header_bot), GPoint(gw - 8, s_header_bot));
  graphics_draw_line(ctx, GPoint(8, s_grid_top), GPoint(gw - 8, s_grid_top));
  graphics_draw_line(ctx, GPoint(8, s_grid_mid), GPoint(gw - 8, s_grid_mid));
  graphics_draw_line(ctx, GPoint(s_col_x, s_grid_top + 7),
                          GPoint(s_col_x, s_grid_mid - 7));
  graphics_draw_line(ctx, GPoint(s_col_x, s_grid_mid + 7),
                          GPoint(s_col_x, s_grid_bot - 7));

  // READY has no page navigation: leave its rule quiet. Once a workout is
  // active, the short segment gives UP/DOWN navigation a visible position.
  if (s_state == STATE_RUNNING || s_state == STATE_PAUSED) {
    int marker_w = gw - 16;
    int gap = 3;
    int segment_w = (marker_w - gap * (WORKOUT_PAGE_COUNT - 1)) /
                    WORKOUT_PAGE_COUNT;
    int marker_x = 8 + s_page * (segment_w + gap);
    graphics_context_set_fill_color(ctx,
        PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack));
    graphics_fill_rect(ctx, GRect(marker_x, s_grid_top - 1, segment_w, 2),
                       0, GCornerNone);
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
  text_layer_set_overflow_mode(tl, GTextOverflowModeFill);
  layer_add_child(root, text_layer_get_layer(tl));
  return tl;
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  const int W = b.size.w, H = b.size.h;
  const bool big = (W >= 180);  // emery vs basalt/diorite
  s_hr_rendered = -1;
  s_steps_rendered = -999999;
  s_dist_buf[0] = s_pace_buf[0] = s_hr_buf[0] = s_steps_buf[0] = s_acc_buf[0] = '\0';
  s_time_fitted_font = s_dist_fitted_font = s_pace_fitted_font = NULL;
  s_hr_fitted_font = s_steps_fitted_font = NULL;
  s_acc_fitted_font = s_state_fitted_font = NULL;
  memset(s_cap_fitted_font, 0, sizeof(s_cap_fitted_font));
  memset(s_cap_buf, 0, sizeof(s_cap_buf));
  s_state_buf[0] = 0;
  s_time_fitted_len = 0;

  window_set_background_color(window, GColorWhite);

  const int ab_w = hintbar_width(W);
  s_content_w = W - ab_w;
  const int CW = s_content_w;

  const int bar_h = 22;
  const int timer_h = big ? 44 : 34;
  const int status_h = 16;
  s_header_bot = bar_h;
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
  const int clock_x = big ? CW - 52 : CW - 44;
  s_acc_layer = prv_make_text(root, GRect(24, 2, clock_x - 26, 20),
                              FONT_KEY_GOTHIC_14, GTextAlignmentLeft,
                              PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  s_clock_layer = prv_make_text(root, GRect(clock_x, 2, CW - clock_x - 8, 20),
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
                                FONT_KEY_GOTHIC_14_BOLD, GTextAlignmentCenter,
                                PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));

  // Metric numbers retain the familiar LECO family. Compact bold captions are
  // left-anchored like Pebble's own cards and fit before they are drawn.
  const char *cap_font = FONT_KEY_GOTHIC_14_BOLD;
  const char *val_font = big ? FONT_KEY_LECO_32_BOLD_NUMBERS : FONT_KEY_LECO_28_LIGHT_NUMBERS;
  s_time_preferred_font = big ? FONT_KEY_LECO_42_NUMBERS
                              : FONT_KEY_LECO_28_LIGHT_NUMBERS;
  s_metric_preferred_font = val_font;
  s_caption_preferred_font = cap_font;
  const int cap_h = 17;
  const int val_y = cap_h + 2;
  GColor cap_col = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);
  const int cw = CW / 2;
  const int inset = big ? 10 : 7;

  // row 1: distance | pace
  s_dist_cap   = prv_make_text(root, GRect(inset, s_grid_top + 4,
                                           cw - inset - 3, cap_h),
                               cap_font, GTextAlignmentLeft, cap_col);
  s_dist_layer = prv_make_text(root, GRect(0,  s_grid_top + val_y, cw, row_h - val_y), val_font, GTextAlignmentCenter, GColorBlack);
  s_pace_cap   = prv_make_text(root, GRect(cw + inset, s_grid_top + 4,
                                           CW - cw - inset - 3, cap_h),
                               cap_font, GTextAlignmentLeft, cap_col);
  s_pace_layer = prv_make_text(root, GRect(cw, s_grid_top + val_y, CW - cw, row_h - val_y), val_font, GTextAlignmentCenter, GColorBlack);

  // row 2: heart rate | steps. HR and its optional Z1..Z5 marker share the
  // caption line as quiet text; there is no detached badge or filled bar.
  s_hr_cap      = prv_make_text(root, GRect(inset, s_grid_mid + 4,
                                            cw - inset - 3, cap_h),
                                cap_font, GTextAlignmentLeft, cap_col);
  s_hr_zone_layer = prv_make_text(root, GRect(inset, s_grid_mid + 4,
                                              cw - inset - 3, cap_h),
                                  cap_font, GTextAlignmentRight, cap_col);
  s_hr_layer    = prv_make_text(root, GRect(0,  s_grid_mid + val_y, cw, row_h - val_y), val_font, GTextAlignmentCenter, GColorBlack);
  s_steps_cap   = prv_make_text(root, GRect(cw + inset, s_grid_mid + 4,
                                            CW - cw - inset - 3, cap_h),
                                cap_font, GTextAlignmentLeft, cap_col);
  s_steps_layer = prv_make_text(root, GRect(cw, s_grid_mid + val_y, CW - cw, row_h - val_y), val_font, GTextAlignmentCenter, GColorBlack);

  // Metric values are deliberately single-line. Font fitting above guarantees
  // they fit before this overflow mode ever has anything to trim.
  text_layer_set_overflow_mode(s_time_layer, GTextOverflowModeFill);
  text_layer_set_overflow_mode(s_acc_layer, GTextOverflowModeFill);
  text_layer_set_overflow_mode(s_dist_layer, GTextOverflowModeFill);
  text_layer_set_overflow_mode(s_pace_layer, GTextOverflowModeFill);
  text_layer_set_overflow_mode(s_hr_layer, GTextOverflowModeFill);
  text_layer_set_overflow_mode(s_steps_layer, GTextOverflowModeFill);

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
  text_layer_destroy(s_hr_zone_layer);
  text_layer_destroy(s_steps_cap);  text_layer_destroy(s_steps_layer);
  hintbar_destroy(s_actionbar); s_actionbar = NULL;
  layer_destroy(s_chrome_layer);
}

// ---------------- App lifecycle ----------------
/* The full session snapshot plus a CMD plus a 64-byte voice name needs ~240
 * bytes, so the old 256-byte outbox had almost no headroom and its result was
 * never checked. Ask for a comfortable buffer, clamp to what the platform
 * allows, and fall back rather than running with no comms at all. */
static void prv_open_appmessage(void) {
  const uint32_t want_in = 512, want_out = 512;
  uint32_t max_in = app_message_inbox_size_maximum();
  uint32_t max_out = app_message_outbox_size_maximum();
  uint32_t in = want_in < max_in ? want_in : max_in;
  uint32_t out = want_out < max_out ? want_out : max_out;
  AppMessageResult r = app_message_open(in, out);
  if (r != APP_MSG_OK) {
    const uint32_t fallback = 256;
    in = fallback < max_in ? fallback : max_in;
    out = fallback < max_out ? fallback : max_out;
    r = app_message_open(in, out);
  }
  s_msg_ok = (r == APP_MSG_OK);
  if (s_msg_ok) s_msg_out_size = out;
  if (!s_msg_ok) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "app_message_open failed (%d)", (int)r);
    prv_flash("PHONE LINK ERROR");
  }
}

static void prv_init(void) {
  // Load persisted settings on startup before constructing the UI.
  settings_load();
  prv_delete_removed_state();
  prv_session_load();
  // Keep native touch navigation globally for settings and debrief windows.
  // The workout window takes ownership so a tap can refresh without also
  // synthesising SELECT and accidentally pausing the activity.
  app_touch_navigation_enable(true);
  s_window = window_create();
  window_set_touch_bridge_disabled(s_window, true);
  prv_attach_touch_recognizers(s_window);
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(prv_inbox);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_sent(prv_outbox_sent);
  app_message_register_outbox_failed(prv_outbox_failed);
  prv_open_appmessage();

  s_phone_connected = connection_service_peek_pebble_app_connection();
  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = prv_connection_changed,
    .pebblekit_connection_handler = NULL,
  });

  prv_apply_hr_period();
  prv_apply_tick();
  prv_set_state_text();
  prv_send_hello();
}

static void prv_deinit(void) {
  app_touch_navigation_enable(false);
  if (s_state == STATE_RUNNING) {
    s_elapsed_s = prv_elapsed_now();
    s_active_base_s = s_elapsed_s;
    s_run_anchor = time(NULL);  // preserve the anchor so wall time continues over a restart
  }
  prv_session_persist();
#if defined(PBL_HEALTH)
  if (s_health_events_active) {
    health_service_events_unsubscribe();
    s_health_events_active = false;
  }
#endif
  prv_set_hr_period(0);  // restore default battery-friendly HR sampling
  if (s_flash_timer) app_timer_cancel(s_flash_timer);
  if (s_send_timer) app_timer_cancel(s_send_timer);
  if (s_pause_sample_timer) app_timer_cancel(s_pause_sample_timer);
  tick_timer_service_unsubscribe();
  connection_service_unsubscribe();
  summary_deinit();        // windows are freed here, not from their unload handlers
  settings_deinit();
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
  prv_render_page();
}

static void settings_load(void) {
  // Read persisted values or fall back to defaults defined in g_set
  if (persist_exists(PKEY_MILES))   g_set.miles     = persist_read_bool(PKEY_MILES);
  if (persist_exists(PKEY_AUTOP))   g_set.autopause = persist_read_bool(PKEY_AUTOP);
  if (persist_exists(PKEY_SPLITS))  g_set.splits    = persist_read_bool(PKEY_SPLITS);
  if (persist_exists(PKEY_MAXHR))   g_set.max_hr    = persist_read_int(PKEY_MAXHR);
  if (persist_exists(PKEY_MODE))    g_set.mode      = persist_read_int(PKEY_MODE);
  if (persist_exists(PKEY_RESTHR))  g_set.rest_hr   = persist_read_int(PKEY_RESTHR);
  if (persist_exists(PKEY_SHOW_HR_ZONE))
    g_set.show_hr_zone = persist_read_bool(PKEY_SHOW_HR_ZONE);
  if (persist_exists(PKEY_LOCAL_SET_PENDING))
    s_local_settings_pending = persist_read_bool(PKEY_LOCAL_SET_PENDING);
  if (persist_exists(PKEY_TARGET_TYPE))  g_set.target_type  = persist_read_int(PKEY_TARGET_TYPE);
  if (persist_exists(PKEY_TARGET_LO))    g_set.target_lo    = persist_read_int(PKEY_TARGET_LO);
  if (persist_exists(PKEY_TARGET_HI))    g_set.target_hi    = persist_read_int(PKEY_TARGET_HI);
  if (persist_exists(PKEY_TARGET_VALUE)) g_set.target_value = persist_read_int(PKEY_TARGET_VALUE);
  // ensure values are within sensible ranges
  if (g_set.max_hr < 80 || g_set.max_hr > 220) g_set.max_hr = 190;
  if (g_set.rest_hr < 0 || g_set.rest_hr > 120) g_set.rest_hr = 0;
  if (g_set.mode < 0 || g_set.mode >= MODE_COUNT) g_set.mode = MODE_RUN;
  if (g_set.target_type < TARGET_OFF || g_set.target_type > TARGET_PACE)
    g_set.target_type = TARGET_OFF;
  if (g_set.target_lo < 0) g_set.target_lo = 0;
  if (g_set.target_hi < 0) g_set.target_hi = 0;
  if (g_set.target_value < 0) g_set.target_value = 0;
}

void settings_save_and_sync(void) {
  // Write only values that actually changed; phone-side edits should not turn
  // one Save tap into a block of redundant watch flash writes.
  if (!persist_exists(PKEY_MILES)  || persist_read_bool(PKEY_MILES)  != g_set.miles)
    persist_write_bool(PKEY_MILES, g_set.miles);
  if (!persist_exists(PKEY_AUTOP)  || persist_read_bool(PKEY_AUTOP)  != g_set.autopause)
    persist_write_bool(PKEY_AUTOP, g_set.autopause);
  if (!persist_exists(PKEY_SPLITS) || persist_read_bool(PKEY_SPLITS) != g_set.splits)
    persist_write_bool(PKEY_SPLITS, g_set.splits);
  if (!persist_exists(PKEY_MAXHR)  || persist_read_int(PKEY_MAXHR)   != g_set.max_hr)
    persist_write_int(PKEY_MAXHR, g_set.max_hr);
  if (!persist_exists(PKEY_MODE)   || persist_read_int(PKEY_MODE)    != g_set.mode)
    persist_write_int(PKEY_MODE, g_set.mode);
  if (!persist_exists(PKEY_RESTHR) || persist_read_int(PKEY_RESTHR)  != g_set.rest_hr)
    persist_write_int(PKEY_RESTHR, g_set.rest_hr);
  if (!persist_exists(PKEY_SHOW_HR_ZONE) ||
      persist_read_bool(PKEY_SHOW_HR_ZONE) != g_set.show_hr_zone)
    persist_write_bool(PKEY_SHOW_HR_ZONE, g_set.show_hr_zone);
  if (!persist_exists(PKEY_TARGET_TYPE) || persist_read_int(PKEY_TARGET_TYPE) != g_set.target_type)
    persist_write_int(PKEY_TARGET_TYPE, g_set.target_type);
  if (!persist_exists(PKEY_TARGET_LO) || persist_read_int(PKEY_TARGET_LO) != g_set.target_lo)
    persist_write_int(PKEY_TARGET_LO, g_set.target_lo);
  if (!persist_exists(PKEY_TARGET_HI) || persist_read_int(PKEY_TARGET_HI) != g_set.target_hi)
    persist_write_int(PKEY_TARGET_HI, g_set.target_hi);
  if (!persist_exists(PKEY_TARGET_VALUE) || persist_read_int(PKEY_TARGET_VALUE) != g_set.target_value)
    persist_write_int(PKEY_TARGET_VALUE, g_set.target_value);
  // HELLO is a full settings/state snapshot and is retried until the phone replies.
  prv_send_hello();
  // Update UI to reflect units/mode immediately
  prv_update_caps();
  prv_update_pace();
  prv_update_steps();  // switching to/from Ride changes whether wrist steps are shown
  prv_update_acc();
  prv_render_page();
}

void settings_save_local_and_sync(void) {
  s_local_settings_pending = true;
  if (!persist_exists(PKEY_LOCAL_SET_PENDING) ||
      !persist_read_bool(PKEY_LOCAL_SET_PENDING))
    persist_write_bool(PKEY_LOCAL_SET_PENDING, true);
  settings_save_and_sync();
}

// UP button: open the settings menu if not actively recording.  If
// recording or saving, ignore the press to avoid disrupting the run.
static void prv_up_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_state == STATE_PAUSED && s_autopaused) {
    prv_manual_pause_from_auto();
    return;
  }
  if (s_state == STATE_RUNNING || s_state == STATE_PAUSED) {
    prv_change_page(-1);
    return;
  }
  if (s_state == STATE_SAVING) return;
  settings_window_push();
}
