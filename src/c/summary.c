/* RunLog — post-run watch debrief
 *
 * Three fixed, button-paged screens pushed when the phone confirms a save:
 *   route -> stats -> pace/heart-rate trends.
 *
 * Route + graph data arrive from the phone as byte arrays (TRACK, PACEG, HRG);
 * the visible page refreshes in place as each packet lands. There is no tall
 * scroll surface: one UP/DOWN press always means exactly one screen.
 */
#include <pebble.h>
#include "runlog.h"
#include "hintbar.h"

static Window *s_win = NULL;
static Layer *s_page_layer;
static Layer *s_bar = NULL;             // fixed right-edge action bar
static TextLayer *s_banner;
static int s_menu = 0;     // 0 pages, 1 menu, 2 confirm-discard, 3 confirm-upload
enum { PAGE_ROUTE = 0, PAGE_STATS, PAGE_TRENDS, PAGE_COUNT };
static int s_page = PAGE_ROUTE;
/* The route and graphs stream in a moment after the stats. If the user has
 * already walked away from the debrief, a late TRACK/PACEG packet must not
 * shove it back in their face. */
static bool s_dismissed = false;

static char s_dist_buf[20], s_upload_buf[32], s_title_buf[16];
static char s_v[6][16];                       // stat grid values
static char s_vo2_buf[24];                    // VO2max cell (runs only)
static char s_pace_rng[24], s_hr_rng[16];     // graph caption ranges
static int s_upload_state = -1;               // -1 hidden, 0 uploading, 1 ok, 2 failed, 3 no track
static int s_upload_err = 0;                  // HTTP status of a failure, 0 = network
static bool s_big = true;
static GFont s_banner_fitted_font;

static void prv_apply_mode(void);

/* s_win outlives a single showing (see summary_deinit), so "do we have a window"
 * is not the same question as "is the user looking at it". */
static bool prv_visible(void) {
  return s_win && window_stack_contains_window(s_win);
}

static GColor prv_accent(void) { return PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack); }
static GColor prv_muted(void)  { return PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack); }

/* Immediate-mode text does not have TextLayer's persistent font state, so fit
 * every string at draw time. The final 09 face is intentionally tiny but it is
 * still preferable to clipping, wrapping a two-word caption, or hiding the end
 * of a value. */
static GFont prv_fitted_font(const char *text, const char *preferred,
                             int available) {
  static const char *const keys[] = {
    FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_GOTHIC_24_BOLD,
    FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_14_BOLD,
    FONT_KEY_GOTHIC_14, FONT_KEY_GOTHIC_09
  };
  int start = 0;
  for (size_t i = 0; i < ARRAY_LENGTH(keys); i++) {
    if (strcmp(preferred, keys[i]) == 0) { start = (int)i; break; }
  }
  for (size_t i = (size_t)start; i < ARRAY_LENGTH(keys); i++) {
    GFont font = fonts_get_system_font(keys[i]);
    GSize measured = graphics_text_layout_get_content_size(
        text, font, GRect(0, 0, 1000, 40),
        GTextOverflowModeFill, GTextAlignmentLeft);
    if (measured.w <= available) return font;
  }
  return fonts_get_system_font(FONT_KEY_GOTHIC_09);
}

static void prv_draw_text(GContext *ctx, const char *text, const char *font,
                          GRect frame, GTextAlignment align, GColor color) {
  graphics_context_set_text_color(ctx, color);
  const int available = frame.size.w > 2 ? frame.size.w - 2 : 1;
  graphics_draw_text(ctx, text,
                     prv_fitted_font(text, font, available), frame,
                     GTextOverflowModeFill, align, NULL);
}

static void prv_draw_value(GContext *ctx, const char *text, const char *font,
                           GRect frame, GTextAlignment align, GColor color) {
  prv_draw_text(ctx, text, font, frame, align, color);
}

/* ---------------- route card ---------------- */
static GPoint prv_track_point(GRect plot, int i) {
  int scale = (plot.size.w < plot.size.h) ? plot.size.w : plot.size.h;
  int ox = plot.origin.x + (plot.size.w - scale) / 2;
  int oy = plot.origin.y + (plot.size.h - scale) / 2;
  return GPoint(ox + g_stats.trk[i].x * scale / 200,
                oy + g_stats.trk[i].y * scale / 200);
}

static void prv_draw_track(GContext *ctx, GRect b) {
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  graphics_fill_rect(ctx, b, 6, GCornersAll);
#if !defined(PBL_COLOR)
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_round_rect(ctx, b, 6);
#endif

  prv_draw_text(ctx, "ROUTE", FONT_KEY_GOTHIC_14,
                GRect(b.origin.x + 8, b.origin.y, b.size.w - 16, 16),
                GTextAlignmentLeft, prv_muted());

  if (g_stats.trk_n < 2) {
    const bool no_route = (g_stats.route == 0);
    prv_draw_text(ctx, no_route ? "NO GPS ROUTE" : "LOADING ROUTE",
                  FONT_KEY_GOTHIC_18_BOLD,
                  GRect(b.origin.x + 4, b.origin.y + b.size.h / 2 - 21,
                        b.size.w - 8, 24), GTextAlignmentCenter, prv_muted());
    prv_draw_text(ctx, no_route ? "TIME + SENSORS" : "FROM PHONE",
                  FONT_KEY_GOTHIC_14,
                  GRect(b.origin.x + 4, b.origin.y + b.size.h / 2 + 1,
                        b.size.w - 8, 20), GTextAlignmentCenter, prv_muted());
    return;
  }

  GRect plot = GRect(b.origin.x + 8, b.origin.y + 18,
                     b.size.w - 16, b.size.h - 26);

  // faint crosshair through the card centre — orients the eye without
  // pretending to be a street map
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack));
  int cx = plot.origin.x + plot.size.w / 2;
  int cy = plot.origin.y + plot.size.h / 2;
  for (int x = plot.origin.x; x < plot.origin.x + plot.size.w; x += 3)
    graphics_draw_pixel(ctx, GPoint(x, cy));
  for (int yy = plot.origin.y; yy < plot.origin.y + plot.size.h; yy += 3)
    graphics_draw_pixel(ctx, GPoint(cx, yy));

  // white casing under an accent route makes it pop off the grey card
#if defined(PBL_COLOR)
  graphics_context_set_stroke_width(ctx, 5);
  graphics_context_set_stroke_color(ctx, GColorWhite);
  GPoint cp = prv_track_point(plot, 0);
  for (int i = 1; i < g_stats.trk_n; i++) {
    GPoint p = prv_track_point(plot, i);
    graphics_draw_line(ctx, cp, p);
    cp = p;
  }
#endif

  graphics_context_set_stroke_width(ctx, 3);
  graphics_context_set_stroke_color(ctx, prv_accent());
  GPoint prev = prv_track_point(plot, 0);
  for (int i = 1; i < g_stats.trk_n; i++) {
    GPoint p = prv_track_point(plot, i);
    graphics_draw_line(ctx, prev, p);
    prev = p;
  }

  GPoint start = prv_track_point(plot, 0);
  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack));
  graphics_fill_circle(ctx, start, 4);
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack));
  graphics_draw_circle(ctx, start, 4);
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorRed, GColorWhite));
  graphics_fill_circle(ctx, prev, 4);
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack));
  graphics_draw_circle(ctx, prev, 4);

  // north marker (top-right) — the route is drawn map-oriented, north up
  prv_draw_text(ctx, "N", FONT_KEY_GOTHIC_14_BOLD,
                GRect(b.origin.x + b.size.w - 18, b.origin.y + 16, 14, 16),
                GTextAlignmentCenter, prv_muted());

  // span label (bottom-left) so the sketch has a sense of scale
  if (g_stats.trk_span_m > 0) {
    char sb[24];
    if (g_set.miles) {
      int ft = (int)((int64_t)g_stats.trk_span_m * 3281 / 1000);
      if (ft >= 528) snprintf(sb, sizeof(sb), "%d.%d mi", ft / 5280, (ft * 10 / 5280) % 10);
      else           snprintf(sb, sizeof(sb), "%d ft", ft);
    } else {
      if (g_stats.trk_span_m >= 1000)
        snprintf(sb, sizeof(sb), "%d.%d km", g_stats.trk_span_m / 1000, (g_stats.trk_span_m / 100) % 10);
      else
        snprintf(sb, sizeof(sb), "%d m", g_stats.trk_span_m);
    }
    prv_draw_text(ctx, sb, FONT_KEY_GOTHIC_14,
                  GRect(b.origin.x + 8, b.origin.y + b.size.h - 17,
                        b.size.w - 16, 16),
                  GTextAlignmentLeft, prv_muted());
  }
}

/* ---------------- mini graphs ---------------- */
static void prv_graph(GContext *ctx, GRect r, const char *cap, const char *rng,
                      const uint8_t *g, int n, bool invert, GColor line) {
  const int range_w = s_big ? 90 : 58;
  const int gap = rng[0] ? 4 : 0;
  prv_draw_text(ctx, cap, FONT_KEY_GOTHIC_14_BOLD, GRect(r.origin.x, r.origin.y,
                rng[0] ? r.size.w - range_w - gap : r.size.w, 16),
                GTextAlignmentLeft, prv_muted());
  prv_draw_text(ctx, rng, FONT_KEY_GOTHIC_14,
                GRect(r.origin.x + r.size.w - range_w,
                      r.origin.y, range_w, 16),
                GTextAlignmentRight, prv_muted());

  GRect c = GRect(r.origin.x, r.origin.y + 18, r.size.w, r.size.h - 20);
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
  graphics_draw_line(ctx, GPoint(c.origin.x, c.origin.y + c.size.h),
                          GPoint(c.origin.x + c.size.w, c.origin.y + c.size.h));

  if (n < 2) {
    prv_draw_text(ctx, "no data", FONT_KEY_GOTHIC_14,
                  GRect(c.origin.x, c.origin.y + c.size.h / 2 - 10, c.size.w, 16),
                  GTextAlignmentCenter, prv_muted());
    return;
  }

  int h = c.size.h - 2;
  GPoint prev = GPoint(0, 0);
  bool pen = false;

  // a clean polyline only — no area fill, so it reads as a sparkline
  graphics_context_set_stroke_width(ctx, 2);
  graphics_context_set_stroke_color(ctx, line);
  for (int i = 0; i < n; i++) {
    if (g[i] == GRAPH_GAP) { pen = false; continue; }
    int v = invert ? (100 - g[i]) : g[i];
    GPoint p = GPoint(c.origin.x + i * (c.size.w - 1) / (n - 1),
                      c.origin.y + 1 + (h - v * h / 100));
    if (pen) graphics_draw_line(ctx, prev, p);
    prev = p;
    pen = true;
  }
}

static void prv_draw_graphs(GContext *ctx, GRect b) {
  int gh = b.size.h / 2;
  const char *pcap = (g_stats.act == MODE_CYCLE)
      ? (g_set.miles ? (s_big ? "SPEED MPH" : "MPH")
                     : (s_big ? "SPEED KMH" : "KM/H"))
      : (g_set.miles ? "PACE/MI" : "PACE/KM");
  prv_graph(ctx, GRect(b.origin.x, b.origin.y, b.size.w, gh - 4),
            pcap, s_pace_rng,
            g_stats.pace_g, g_stats.pace_n, true, prv_accent());
  prv_graph(ctx, GRect(b.origin.x, b.origin.y + gh, b.size.w, gh - 4),
            s_big ? "HEART RATE" : "HR", s_hr_rng,
            g_stats.hr_g, g_stats.hr_n, false,
            PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
}

/* ---------------- stat grid ---------------- */
static void prv_metric(GContext *ctx, GRect r, const char *cap,
                       const char *val, GColor value_color, bool big) {
  prv_draw_text(ctx, cap, FONT_KEY_GOTHIC_14, GRect(r.origin.x, r.origin.y,
                r.size.w, 16), GTextAlignmentCenter, prv_muted());
  const char *font = big && strlen(val) <= 7
      ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD;
  prv_draw_value(ctx, val, font,
                 GRect(r.origin.x + 1, r.origin.y + 12,
                       r.size.w - 2, r.size.h - 12),
                 GTextAlignmentCenter, value_color);
}

static void prv_draw_stats(GContext *ctx, GRect b) {
  bool run  = (g_stats.act == MODE_RUN);    // only runs carry a VO2max estimate
  int rows  = run ? 4 : 3;                  // extra full-width row for VO2max
  int row_h = b.size.h / rows;
  int col_w = b.size.w / 2;
  bool ride = (g_stats.act == MODE_CYCLE);
  const char *caps[6] = { "MOVING", ride ? "AVG SPEED" : "AVG PACE",
                          "HR AVG/MAX", "ELEV GAIN",
                          ride ? "MAX SPEED" : "CADENCE",
                          ride ? "ELAPSED" : "STEPS" };

  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
  for (int rrow = 1; rrow < rows; rrow++) {                 // dividers between every row
    int y = b.origin.y + rrow * row_h;
    graphics_draw_line(ctx, GPoint(b.origin.x + 10, y),
                            GPoint(b.origin.x + b.size.w - 10, y));
  }
  for (int rrow = 0; rrow < 3; rrow++) {                    // column split for the paired rows
    graphics_draw_line(ctx, GPoint(b.origin.x + col_w,
                                   b.origin.y + rrow * row_h + 6),
                            GPoint(b.origin.x + col_w,
                                   b.origin.y + (rrow + 1) * row_h - 6));
  }

  for (int i = 0; i < 6; i++) {
    GRect cell = GRect(b.origin.x + (i % 2) * col_w,
                       b.origin.y + (i / 2) * row_h,
                       (i % 2) ? (b.size.w - col_w) : col_w, row_h);
    prv_metric(ctx, cell, caps[i], s_v[i],
               (i == 1) ? prv_accent() : GColorBlack, s_big);
  }
  if (run) {   // VO2max spans the full width of the 4th row
    prv_metric(ctx, GRect(b.origin.x, b.origin.y + 3 * row_h,
                          b.size.w, row_h),
               "VO2 MAX", s_vo2_buf, prv_accent(), false);
  }
}

/* ---------------- text content ---------------- */
static void prv_fill_texts(void) {
  char d[12], lo[10], hi[10];
  int moving = g_stats.mov_s > 0 ? g_stats.mov_s : g_stats.dur_s;
  int cad = (g_stats.mov_s > 0) ? g_stats.steps * 60 / g_stats.mov_s : 0;

  fmt_dist(d, sizeof(d), g_stats.dist_m);
  snprintf(s_dist_buf, sizeof(s_dist_buf), "%s %s", d, g_set.miles ? "mi" : "km");
  snprintf(s_title_buf, sizeof(s_title_buf), "%s SAVED", mode_label_for(g_stats.act));

  bool ride = (g_stats.act == MODE_CYCLE);
  fmt_dur(s_v[0], sizeof(s_v[0]), moving);
  if (ride) fmt_speed(s_v[1], sizeof(s_v[1]), g_stats.avgp_s);
  else      fmt_pace(s_v[1], sizeof(s_v[1]), g_stats.avgp_s);
  if (g_stats.avg_hr > 0 || g_stats.max_hr > 0) {
    snprintf(s_v[2], sizeof(s_v[2]), "%d/%d", g_stats.avg_hr, g_stats.max_hr);
  } else {
    snprintf(s_v[2], sizeof(s_v[2]), "--");
  }
  snprintf(s_v[3], sizeof(s_v[3]), "+%d %s",
           egain_display(g_stats.egain_m), g_set.miles ? "ft" : "m");
  if (g_stats.vo2 > 0) snprintf(s_vo2_buf, sizeof(s_vo2_buf), "%d ml/kg/min", g_stats.vo2);
  else                 snprintf(s_vo2_buf, sizeof(s_vo2_buf), "--");
  if (ride) {
    // fastest sustained speed comes from the pace graph's fastest bucket
    if (g_stats.pace_n >= 2) fmt_speed(s_v[4], sizeof(s_v[4]), g_stats.pace_min);
    else snprintf(s_v[4], sizeof(s_v[4]), "--");
  } else if (cad > 0) {
    snprintf(s_v[4], sizeof(s_v[4]), "%d", cad);
  } else {
    snprintf(s_v[4], sizeof(s_v[4]), "--");
  }
  if (ride) fmt_dur(s_v[5], sizeof(s_v[5]), g_stats.dur_s);   // total incl. stops
  else      snprintf(s_v[5], sizeof(s_v[5]), "%d", g_stats.steps);

  if (g_stats.pace_n >= 2) {
    if (ride) {   // show as speeds, fastest first
      fmt_speed(lo, sizeof(lo), g_stats.pace_min);
      fmt_speed(hi, sizeof(hi), g_stats.pace_max);
    } else {
      fmt_pace(lo, sizeof(lo), g_stats.pace_min);
      fmt_pace(hi, sizeof(hi), g_stats.pace_max);
    }
    snprintf(s_pace_rng, sizeof(s_pace_rng), "%s-%s", lo, hi);
  } else s_pace_rng[0] = 0;
  if (g_stats.hr_n >= 2) {
    snprintf(s_hr_rng, sizeof(s_hr_rng), "%d-%d", g_stats.hr_min, g_stats.hr_max);
  } else s_hr_rng[0] = 0;

  if (s_page_layer) layer_mark_dirty(s_page_layer);
}

static void prv_show_upload(void) {
  if (s_upload_state == 0) {
    snprintf(s_upload_buf, sizeof(s_upload_buf), "UPLOADING");
  } else if (s_upload_state == 1) {
    snprintf(s_upload_buf, sizeof(s_upload_buf), "UPLOADED");
  } else if (s_upload_state == 3) {
    // The phone had no GPS track to send. Saying "Saved on phone" here (the old
    // default branch) reported a failure as a success.
    snprintf(s_upload_buf, sizeof(s_upload_buf), "NO ROUTE");
  } else if (s_upload_state == 2) {
    // surface the reason so a failure is diagnosable from the wrist
    if (s_upload_err > 0) {
      snprintf(s_upload_buf, sizeof(s_upload_buf), "FAILED / %d", s_upload_err);
    } else {
      snprintf(s_upload_buf, sizeof(s_upload_buf), "FAILED / NETWORK");
    }
  } else {
    // RUN SAVED already conveys the normal local state. Keep the route page
    // quiet until there is an upload outcome that genuinely needs attention.
    s_upload_buf[0] = 0;
  }
  if (s_page_layer) layer_mark_dirty(s_page_layer);
}

static GColor prv_upload_color(void) {
  if (s_upload_state == 1)
    return PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack);
  if (s_upload_state == 2 || s_upload_state == 3)
    return PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
  return prv_muted();
}

/* All banner copy is fitted before it reaches its one-line layer. Status and
 * confirmation text must never degrade into an ellipsis on 144 px watches. */
static void prv_set_banner(const char *text, GColor background) {
  if (!s_banner) return;
  static const char *const keys[] = {
    FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_14_BOLD, FONT_KEY_GOTHIC_09
  };
  GRect bounds = layer_get_bounds(text_layer_get_layer(s_banner));
  GFont fitted = fonts_get_system_font(keys[ARRAY_LENGTH(keys) - 1]);
  for (size_t i = 0; i < ARRAY_LENGTH(keys); i++) {
    GFont candidate = fonts_get_system_font(keys[i]);
    GSize measured = graphics_text_layout_get_content_size(
        text, candidate, GRect(0, 0, 1000, 30),
        GTextOverflowModeFill, GTextAlignmentCenter);
    if (measured.w <= bounds.size.w - 4) { fitted = candidate; break; }
  }
  if (fitted != s_banner_fitted_font) {
    s_banner_fitted_font = fitted;
    text_layer_set_font(s_banner, fitted);
  }
  text_layer_set_background_color(s_banner, background);
  text_layer_set_text_color(s_banner, GColorWhite);
  text_layer_set_text(s_banner, text);
}

/* ---------------- fixed page composition ---------------- */
static int prv_draw_header(GContext *ctx, GRect b, const char *title) {
  const int h = s_big ? 27 : 22;
  const char *pos = s_page == PAGE_ROUTE ? "1/3" :
                    s_page == PAGE_STATS ? "2/3" : "3/3";

  GColor title_color = (s_page == PAGE_ROUTE)
      ? PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack) : GColorBlack;
  bool compact = !s_big && strlen(title) > 7;
  prv_draw_text(ctx, title, compact ? FONT_KEY_GOTHIC_14_BOLD
                                    : FONT_KEY_GOTHIC_18_BOLD,
                GRect(b.origin.x + 7, b.origin.y + (compact ? 1 : -2),
                      b.size.w - 48, h),
                GTextAlignmentLeft, title_color);
  prv_draw_text(ctx, pos, FONT_KEY_GOTHIC_14_BOLD,
                GRect(b.origin.x + b.size.w - 40, b.origin.y,
                      34, h - 2), GTextAlignmentRight, prv_muted());

  int y = b.origin.y + h - 2;
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  graphics_fill_rect(ctx, GRect(b.origin.x + 7, y, b.size.w - 14, 1), 0, GCornerNone);
  graphics_context_set_fill_color(ctx, prv_accent());
  graphics_fill_rect(ctx, GRect(b.origin.x + 7, y, s_big ? 34 : 26, 2), 0, GCornerNone);
  return h;
}

static void prv_draw_route_page(GContext *ctx, GRect b) {
  const int header_h = prv_draw_header(ctx, b, s_title_buf);
  const int dist_h = s_big ? 42 : 38;
  const int status_h = s_upload_buf[0] ? 18 : 0;
  int card_y = b.origin.y + header_h + 2;
  int card_h = b.size.h - header_h - dist_h - status_h - 4;
  if (card_h < 62) card_h = 62;

  prv_draw_track(ctx, GRect(b.origin.x + 6, card_y,
                            b.size.w - 12, card_h));

  int dist_y = card_y + card_h;
  prv_draw_value(ctx, s_dist_buf, FONT_KEY_GOTHIC_28_BOLD,
                 GRect(b.origin.x, dist_y - 1, b.size.w, dist_h),
                 GTextAlignmentCenter, GColorBlack);
  if (status_h) {
    prv_draw_text(ctx, s_upload_buf, FONT_KEY_GOTHIC_14_BOLD,
                  GRect(b.origin.x, dist_y + dist_h - 3,
                        b.size.w, status_h),
                  GTextAlignmentCenter, prv_upload_color());
  }
}

static void prv_draw_stats_page(GContext *ctx, GRect b) {
  const int header_h = prv_draw_header(ctx, b, "STATS");
  prv_draw_stats(ctx, GRect(b.origin.x, b.origin.y + header_h,
                            b.size.w, b.size.h - header_h));
}

static void prv_draw_trends_page(GContext *ctx, GRect b) {
  const int header_h = prv_draw_header(ctx, b, "TRENDS");
  prv_draw_graphs(ctx, GRect(b.origin.x + 8, b.origin.y + header_h + 2,
                             b.size.w - 16, b.size.h - header_h - 4));
}

static void prv_page_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  if (s_page == PAGE_ROUTE)      prv_draw_route_page(ctx, b);
  else if (s_page == PAGE_STATS) prv_draw_stats_page(ctx, b);
  else                           prv_draw_trends_page(ctx, b);
}

/* ---- voice rename (Dictation API) ---- */
static void prv_show_comms_error(void) {
  s_menu = 0;
  prv_apply_mode();
  prv_set_banner("PHONE UNAVAILABLE",
                 PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
}

#if defined(PBL_MICROPHONE)
static DictationSession *s_dictation = NULL;
static char s_name_buf[64];
static void prv_dictation_cb(DictationSession *session, DictationSessionStatus status,
                             char *transcription, void *context) {
  (void)session; (void)context;
  if (status == DictationSessionStatusSuccess && transcription && transcription[0]) {
    if (comms_send_rename(transcription) && s_banner) { // phone renames the just-saved run
      prv_set_banner("RENAMING",
                     PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack));
    } else prv_show_comms_error();
  }
}
static bool prv_start_rename(void) {
  if (!s_dictation)
    s_dictation = dictation_session_create(sizeof(s_name_buf), prv_dictation_cb, NULL);
  if (s_dictation) {
    dictation_session_start(s_dictation);
    return true;
  }
  return false;
}
#else
static bool prv_start_rename(void) {
  if (s_banner) {
    prv_set_banner("NO MICROPHONE",
                   PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  }
  return false;
}
#endif

/* ---- paging + the SELECT "\u22ee" actions menu ----
 * The run is already saved on the phone; this menu is for optional extras.
 * Page mode: UP/DOWN move one complete screen, SELECT opens the actions menu.
 * Menu: UP = upload to server (confirmed), SELECT = rename by voice,
 *       DOWN = discard (confirmed); BACK closes the menu.
 * Confirm modes: SELECT commits (upload / discard), UP or BACK cancels. */
static void prv_apply_mode(void) {
  if (s_bar) {
    if (s_menu == 0)      hintbar_set_icons(s_bar,
                                           s_page > PAGE_ROUTE ? HB_UP : HB_NONE,
                                           HB_MENU, HB_NONE,
                                           s_page < PAGE_TRENDS ? HB_DOWN : HB_NONE);
    else if (s_menu == 1) hintbar_set_icons(s_bar, HB_UPLOAD, HB_MIC, HB_NONE, HB_TRASH);
    else if (s_menu <= 3) hintbar_set_icons(s_bar, HB_DECLINE, HB_CONFIRM, HB_NONE, HB_NONE);
    else                  hintbar_set_icons(s_bar, HB_NONE, HB_NONE, HB_NONE, HB_NONE);
  }
  if (s_banner) {
    if (s_menu == 0) {
      prv_set_banner("", GColorClear);
    } else if (s_menu == 1) {
      prv_set_banner("ACTIONS",
                     PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack));
    } else if (s_menu == 2) {
      prv_set_banner("DISCARD ACTIVITY?",
                     PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
    } else if (s_menu == 3) {
      prv_set_banner("UPLOAD TO SERVER?",
                     PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack));
    } else {
      prv_set_banner(s_menu == 4 ? "DISCARDING" : "REQUESTING",
                     PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack));
    }
  }
}

static void prv_change_page(int delta) {
  int next = s_page + delta;
  if (next < PAGE_ROUTE) next = PAGE_ROUTE;
  if (next > PAGE_TRENDS) next = PAGE_TRENDS;
  if (next == s_page) return;
  s_page = next;
  if (s_page_layer) layer_mark_dirty(s_page_layer);
  prv_apply_mode();
}

static void prv_up_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_menu == 0)      prv_change_page(-1);
  else if (s_menu == 1) { s_menu = 3; prv_apply_mode(); }       // Upload -> confirm
  else if (s_menu <= 3) { s_menu = 1; prv_apply_mode(); }       // confirm -> cancel (keep)
}

static void prv_down_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_menu == 0)      prv_change_page(+1);
  else if (s_menu == 1) { s_menu = 2; prv_apply_mode(); }       // Discard -> confirm
  /* confirm modes: DOWN is intentionally inert */
}

static void prv_select_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_menu == 0)      { s_menu = 1; prv_apply_mode(); }       // open menu
  else if (s_menu == 1) { s_menu = 0; prv_apply_mode(); prv_start_rename(); }  // Rename (voice)
  else if (s_menu == 2) {                                       // confirm discard
    if (comms_send_cmd(CMD_DISCARD)) { s_menu = 4; prv_apply_mode(); }
    else prv_show_comms_error();
  } else if (s_menu == 3) {                                     // confirm upload (to server)
    if (comms_send_cmd(CMD_UPLOAD)) { s_menu = 5; prv_apply_mode(); }
    else prv_show_comms_error();
  }
}

static void prv_back_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_menu != 0) { s_menu = 0; prv_apply_mode(); }  // leave menu, stay on debrief
  else { s_dismissed = true; window_stack_pop(true); }
}

static void prv_summary_clicks(void *ctx) {
  (void)ctx;
  window_single_click_subscribe(BUTTON_ID_UP, prv_up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_single_click_subscribe(BUTTON_ID_BACK, prv_back_click);
}

void summary_set_upload(int state, int err) {
  s_upload_state = state;
  s_upload_err = err;
  prv_show_upload();
  if (!prv_visible() || !s_banner || s_menu != 0) return;
  prv_set_banner(s_upload_buf,
      (state == 1) ? PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack) :
      (state == 2 || state == 3) ? PBL_IF_COLOR_ELSE(GColorRed, GColorBlack) :
                                  PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack));
}

void summary_action_result(int cmd, bool ok) {
  if (cmd == CMD_DISCARD && ok) {
    // The phone's acknowledgement is authoritative even if the user backed out
    // while it was in flight. Always clear the main workout state; visibility
    // only controls whether there is a summary window left to pop.
    main_workout_discarded();
    s_dismissed = true;
    if (prv_visible()) window_stack_pop(true);
    return;
  }
  if (!prv_visible()) return;
  s_menu = 0;
  prv_apply_mode();
  if (ok) {
    prv_set_banner(cmd == CMD_RENAME ? "RENAMED" :
                   cmd == CMD_UPLOAD ? "UPLOAD REQUESTED" : "DONE",
                   PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack));
  } else {
    prv_set_banner(cmd == CMD_RENAME ? "RENAME FAILED" :
                   cmd == CMD_UPLOAD ? "UPLOAD UNAVAILABLE" : "DISCARD FAILED",
                   PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
  }
}

/* ---------------- window plumbing ---------------- */
static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  const int W = b.size.w;
  s_big = (W >= 180);
  const int ab_w = hintbar_width(W);
  const int CW = W - ab_w;

  s_menu = 0;
  window_set_background_color(window, GColorWhite);

  s_page_layer = layer_create(GRect(0, 0, CW, b.size.h));
  layer_set_update_proc(s_page_layer, prv_page_update);
  layer_add_child(root, s_page_layer);

  // Fixed chrome: pages redraw only inside CW; the button guide never moves.
  s_bar = hintbar_create(GRect(CW, 0, ab_w, b.size.h));
  layer_add_child(root, s_bar);

  s_banner = text_layer_create(GRect(0, 0, CW, 26));
  s_banner_fitted_font = NULL;
  text_layer_set_font(s_banner, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_banner, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_banner, GTextOverflowModeFill);
  layer_add_child(root, text_layer_get_layer(s_banner));

  window_set_click_config_provider(window, prv_summary_clicks);

  prv_fill_texts();
  prv_show_upload();
  prv_apply_mode();
}

/* Destroys only what prv_load built. The Window itself is freed in
 * summary_deinit: calling window_destroy() from inside a window's own unload
 * handler frees memory the window stack is still unwinding through, and this
 * handler can be reached from an AppMessage callback (see summary_action_result),
 * which is exactly when that goes wrong. */
static void prv_unload(Window *window) {
  (void)window;
#if defined(PBL_MICROPHONE)
  if (s_dictation) { dictation_session_destroy(s_dictation); s_dictation = NULL; }
#endif
  hintbar_destroy(s_bar); s_bar = NULL;
  text_layer_destroy(s_banner);      s_banner = NULL;
  layer_destroy(s_page_layer);       s_page_layer = NULL;
}

/* A newly saved activity gets a clean debrief: no stale upload result, and the
 * previous run's dismissal doesn't suppress it. */
void summary_reset_for_new_run(void) {
  s_upload_state = -1;
  s_upload_err = 0;
  s_dismissed = false;
  s_menu = 0;
  s_page = PAGE_ROUTE;
}

void summary_window_push(void) {
  if (!s_win) {
    s_win = window_create();
    window_set_window_handlers(s_win, (WindowHandlers) {
      .load = prv_load,
      .unload = prv_unload,
    });
  }
  if (window_stack_contains_window(s_win)) {
    // Every page owns the same fixed frame, so late activity/track/graph fields
    // can refresh in place without tearing down the window or moving the user.
    prv_fill_texts();
    return;
  }
  if (s_dismissed) return;   // late route/graph data must not resurrect it
  window_stack_push(s_win, true);
}

void summary_deinit(void) {
  if (s_win) { window_destroy(s_win); s_win = NULL; }
}
