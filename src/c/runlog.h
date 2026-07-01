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

// Watch -> phone commands (shared between main.c and summary.c)
enum { CMD_START = 1, CMD_PAUSE = 2, CMD_RESUME = 3, CMD_STOP = 4,
       CMD_CONFIG = 5, CMD_DISCARD = 6, CMD_UPLOAD = 7 };

void comms_send_cmd(uint8_t cmd);        // main.c: send a CMD to the phone
void comms_send_rename(const char *name);// main.c: send a voice-dictated run name
void main_workout_discarded(void);       // main.c: reset the run screen

// Activity modes (DOWN button cycles; also in the settings menu)
enum { MODE_RUN = 0, MODE_WALK = 1, MODE_CYCLE = 2, MODE_COUNT = 3 };

typedef struct {
  bool miles;       // false = kilometres
  bool autopause;
  bool splits;      // split alerts on/off
  int  max_hr;      // zones derived as 60/70/80/90 % of this
  int  rest_hr;     // resting HR for the VO2max reserve model; 0 = off
  int  mode;        // MODE_RUN / MODE_WALK / MODE_CYCLE
} Settings;

extern Settings g_set;

// ---- Stats handed over when a run is saved ----
#define TRACK_MAX_PTS 64
#define GRAPH_MAX_PTS 48
#define GRAPH_GAP 255   // sample value meaning "no data here"

typedef struct {
  int dist_m;
  int dur_s;        // watch elapsed (pauses excluded)
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
const char *mode_label(void);                       // "RUN" / "WALK" / "RIDE"
void fmt_speed(char *buf, size_t n, int s_per_km);  // unit-aware, "24.3"
int egain_display(int meters);                      // m, or ft when miles
int split_mult(void);                               // 1, or 5 for rides

// ---- settings.c ----
void settings_window_push(void);

// ---- summary.c ----
void summary_window_push(void);
void summary_set_upload(int state, int err);  // 0 uploading, 1 ok, 2 failed (+HTTP)
