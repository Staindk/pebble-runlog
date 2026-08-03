/* RunLog - shared display formatting helpers */
#include <pebble.h>
#include "runlog.h"

void fmt_dur(char *buf, size_t n, int secs) {
  if (secs < 0) secs = 0;
  int h = secs / 3600;
  int m = (secs % 3600) / 60;
  int s = secs % 60;
  if (h > 0) {
    snprintf(buf, n, "%d:%02d:%02d", h, m, s);
  } else {
    snprintf(buf, n, "%d:%02d", m, s);
  }
}

void fmt_dist(char *buf, size_t n, int meters) {
  if (meters < 0) meters = 0;
  int unit_m = g_set.miles ? 1609 : 1000;
  int hundredths = (meters * 100 + unit_m / 2) / unit_m;
  snprintf(buf, n, "%d.%02d", hundredths / 100, hundredths % 100);
}

void fmt_pace(char *buf, size_t n, int s_per_km) {
  if (s_per_km <= 0 || s_per_km > 3599) {
    snprintf(buf, n, "--:--");
    return;
  }
  int secs = g_set.miles ? (s_per_km * 1609 + 500) / 1000 : s_per_km;
  snprintf(buf, n, "%d:%02d", secs / 60, secs % 60);
}

const char *unit_dist_label(void) {
  return g_set.miles ? "MI" : "KM";
}

int egain_display(int meters) {
  if (meters < 0) meters = 0;
  return g_set.miles ? (meters * 328 + 50) / 100 : meters;
}

const char *mode_label_for(int mode) {
  switch (mode) {
    case MODE_WALK:  return "WALK";
    case MODE_CYCLE: return "RIDE";
    case MODE_HIKE:  return "HIKE";
    default:         return "RUN";
  }
}

const char *mode_label(void) { return mode_label_for(g_set.mode); }

int split_mult(void) {
  return (g_set.mode == MODE_CYCLE) ? 5 : 1;
}

/* speed in km/h (or mph) with one decimal, from a pace in s/km */
void fmt_speed(char *buf, size_t n, int s_per_km) {
  if (s_per_km <= 0) {
    snprintf(buf, n, "--");
    return;
  }
  // tenths of a unit per hour: km/h = 3600/pace, mph = km/h / 1.609344
  int tenths = g_set.miles ? (int)(36000000LL / ((int64_t)s_per_km * 1609))
                           : 36000 / s_per_km;
  snprintf(buf, n, "%d.%d", tenths / 10, tenths % 10);
}
