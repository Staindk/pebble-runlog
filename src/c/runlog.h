/* RunLog — shared definitions */
#pragma once
#include <pebble.h>

// ---- Persisted settings ----
#define PKEY_MILES   1
#define PKEY_AUTOP   2
#define PKEY_SPLITS  3
#define PKEY_MAXHR   4
#define PKEY_MODE    5
#define PKEY_RESTHR  6
#define PKEY_SESSION_SID       20
#define PKEY_SESSION_SEQ       21
#define PKEY_SESSION_STATE     22
#define PKEY_SESSION_ACTIVE    23
#define PKEY_SESSION_ANCHOR    24
#define PKEY_SESSION_START     25
#define PKEY_SESSION_PENDING   26
#define PKEY_SESSION_AUTOPAUSE 27
#define PKEY_SESSION_NAME      28
#define PKEY_SESSION_STEPS     29
#define PKEY_SESSION_STEPBASE  30
#define PKEY_SESSION_STEPPAUSE 31
#define PKEY_SESSION_STEPGROSS 32
// Keys 33..40 were used by a removed 1.30 experiment. Keep them reserved so
// an upgrade can never reinterpret stale values as a future feature.
#define PKEY_TARGET_TYPE       41
#define PKEY_TARGET_LO         42
#define PKEY_TARGET_HI         43
#define PKEY_TARGET_VALUE      44
#define PKEY_SESSION_UNACKED   45
#define PKEY_SESSION_LAPN      46
#define PKEY_SESSION_LAPACTIVE 47
#define PKEY_SESSION_LAPDIST   48
#define PKEY_SESSION_PAGE      49

#define RUNLOG_PROTOCOL_VERSION 3

// Watch -> phone commands (shared between main.c and summary.c)
enum { CMD_START = 1, CMD_PAUSE = 2, CMD_RESUME = 3, CMD_STOP = 4,
       CMD_CONFIG = 5, CMD_DISCARD = 6, CMD_UPLOAD = 7, CMD_RENAME = 8 };

// Phone-configured, optional workout targets. Values on the wire are canonical:
// seconds, metres and seconds/km, so changing display units never changes a goal.
enum {
  TARGET_OFF = 0,
  TARGET_HR_ZONE = 1,
  TARGET_DURATION = 2,
  TARGET_DISTANCE = 3,
  TARGET_PACE = 4,
};

bool comms_send_cmd(uint8_t cmd);         // main.c: queue a CMD for the phone
bool comms_send_rename(const char *name); // main.c: queue a voice-dictated run name
void main_workout_discarded(void);       // main.c: reset the run screen

// Activity modes (DOWN button cycles; also in the settings menu).
// Existing numeric values are part of the persisted/watch-phone format, so
// append new modes rather than reordering them.
enum {
  MODE_RUN = 0,
  MODE_WALK = 1,
  MODE_CYCLE = 2,
  MODE_HIKE = 3,
  MODE_COUNT = 4
};

typedef struct {
  bool miles;       // false = kilometres
  bool autopause;
  bool splits;      // split alerts on/off
  int  max_hr;      // zones derived as 60/70/80/90 % of this
  int  rest_hr;     // resting HR for the VO2max reserve model; 0 = off
  int  mode;        // MODE_RUN / MODE_WALK / MODE_CYCLE / MODE_HIKE
  int  target_type; // TARGET_*
  int  target_lo;   // pace fast bound, seconds/km
  int  target_hi;   // pace slow bound, seconds/km
  int  target_value;// HR zone, duration seconds, or distance metres
} Settings;

extern Settings g_set;

// ---- Stats handed over when a run is saved ----
#define TRACK_MAX_PTS 64
#define GRAPH_MAX_PTS 48
#define GRAPH_GAP 255   // sample value meaning "no data here"

typedef struct {
  int act;          // activity the run was RECORDED as (MODE_*), not the current
                    // g_set.mode: the mode can be cycled again from the run
                    // screen while a debrief is still in play.
  int dist_m;
  int dur_s;        // true wall-clock elapsed from phone (includes pauses)
  int mov_s;        // phone moving time
  int avgp_s;       // average pace, seconds per km
  int avg_hr, max_hr;
  int vo2;          // estimated VO2max (ml/kg/min), 0 = n/a; runs only
  int steps;
  int egain_m;
  GPoint trk[TRACK_MAX_PTS];  // normalised 0..200, y top-down
  int trk_n;
  int trk_span_m;             // world metres across the longer plot axis
  // mini graphs (post-run debrief): samples 0..100, GRAPH_GAP = gap
  uint8_t pace_g[GRAPH_MAX_PTS]; int pace_n; int pace_min, pace_max; // s/km
  uint8_t hr_g[GRAPH_MAX_PTS];   int hr_n;   int hr_min, hr_max;     // bpm
} RunStats;

extern RunStats g_stats;

// ---- main.c ----
void settings_save_and_sync(void);
void phone_config_open(void);
GColor hr_zone_color(int hr);
void fmt_dur(char *buf, size_t n, int secs);
void fmt_dist(char *buf, size_t n, int meters);     // unit-aware, "5.03"
void fmt_pace(char *buf, size_t n, int s_per_km);   // unit-aware, "5:32"
const char *unit_dist_label(void);                  // "KM" / "MI"
const char *mode_label(void);                       // "RUN" / "WALK" / "RIDE" / "HIKE"
void fmt_speed(char *buf, size_t n, int s_per_km);  // unit-aware, "24.3"
int egain_display(int meters);                      // m, or ft when miles
int split_mult(void);                               // 1, or 5 for rides

// ---- settings.c ----
void settings_window_push(void);

// ---- summary.c ----
void summary_window_push(void);
void summary_set_upload(int state, int err);  // 0 uploading, 1 ok, 2 failed (+HTTP), 3 nothing to upload
void summary_action_result(int cmd, bool ok);
void summary_reset_for_new_run(void);         // clear upload state + the dismissed flag
void summary_deinit(void);                    // free the window at app exit

// ---- settings.c ----
void settings_deinit(void);                   // free the window at app exit

// Activity label for an explicit mode, rather than the current setting.
const char *mode_label_for(int mode);
