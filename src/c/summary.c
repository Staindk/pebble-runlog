/* RunLog — post-run watch debrief
 *
 * Scrollable summary pushed when the phone confirms a save:
 *   distance hero -> route card -> pace + heart-rate mini graphs
 *   -> 3x2 stat grid -> upload status.
 *
 * Route + graph data arrive from the phone as byte arrays (TRACK,
 * PACEG, HRG); each section quietly shows a placeholder until its
 * data lands, then refreshes in place.
 */
#include <pebble.h>
#include "runlog.h"
#include "hintbar.h"

static Window *s_win = NULL;
static ScrollLayer *s_scroll;
static Layer *s_track_layer, *s_graphs_layer, *s_stats_layer;
static Layer *s_bar = NULL;             // fixed right-edge action bar
static TextLayer *s_title, *s_dist, *s_upload, *s_hint, *s_banner;
static int s_menu = 0;     // 0 scroll, 1 menu, 2 confirm-discard, 3 confirm-upload
static int s_off = 0, s_content_h = 0, s_scr_h = 0;   // manual scrolling

static char s_dist_buf[20], s_upload_buf[32];
static char s_v[6][16];                       // stat grid values
static char s_vo2_buf[24];                    // VO2max cell (runs only)
static char s_pace_rng[24], s_hr_rng[16];     // graph caption ranges
static int s_upload_state = -1;               // -1 hidden, 0 uploading, 1 ok, 2 failed
static int s_upload_err = 0;                  // HTTP status of a failure, 0 = network
static bool s_big = true;

static GColor prv_accent(void) { return PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack); }
static GColor prv_muted(void)  { return PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack); }

static void prv_draw_text(GContext *ctx, const char *text, const char *font,
                          GRect frame, GTextAlignment align, GColor color) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, fonts_get_system_font(font), frame,
                     GTextOverflowModeTrailingEllipsis, align, NULL);
}

/* ---------------- route card ---------------- */
static GPoint prv_track_point(GRect plot, int i) {
  int scale = (plot.size.w < plot.size.h) ? plot.size.w : plot.size.h;
  int ox = plot.origin.x + (plot.size.w - scale) / 2;
  int oy = plot.origin.y + (plot.size.h - scale) / 2;
  return GPoint(ox + g_stats.trk[i].x * scale / 200,
                oy + g_stats.trk[i].y * scale / 200);
}

static void prv_track_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);

  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  graphics_fill_rect(ctx, b, 6, GCornersAll);
#if !defined(PBL_COLOR)
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_round_rect(ctx, b, 6);
#endif

  prv_draw_text(ctx, "ROUTE", FONT_KEY_GOTHIC_14, GRect(8, 0, b.size.w - 16, 16),
                GTextAlignmentLeft, prv_muted());

  if (g_stats.trk_n < 2) {
    prv_draw_text(ctx, "waiting for phone...", FONT_KEY_GOTHIC_14,
                  GRect(0, b.size.h / 2 - 9, b.size.w, 18),
                  GTextAlignmentCenter, prv_muted());
    return;
  }

  GRect plot = GRect(8, 18, b.size.w - 16, b.size.h - 26);

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
                GRect(b.size.w - 18, 16, 14, 16), GTextAlignmentCenter, prv_muted());

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
    prv_draw_text(ctx, sb, FONT_KEY_GOTHIC_14, GRect(8, b.size.h - 17, b.size.w - 16, 16),
                  GTextAlignmentLeft, prv_muted());
  }
}

/* ---------------- mini graphs ---------------- */
static void prv_graph(GContext *ctx, GRect r, const char *cap, const char *rng,
                      const uint8_t *g, int n, bool invert, GColor line) {
  prv_draw_text(ctx, cap, FONT_KEY_GOTHIC_14_BOLD, GRect(r.origin.x, r.origin.y,
                r.size.w - 70, 16), GTextAlignmentLeft, prv_muted());
  prv_draw_text(ctx, rng, FONT_KEY_GOTHIC_14, GRect(r.origin.x + r.size.w - 90,
                r.origin.y, 90, 16), GTextAlignmentRight, prv_muted());

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

static void prv_graphs_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  int gh = b.size.h / 2;
  const char *pcap = (g_set.mode == MODE_CYCLE)
      ? (g_set.miles ? "SPEED MPH" : "SPEED KMH")
      : (g_set.miles ? "PACE /MI" : "PACE /KM");
  prv_graph(ctx, GRect(0, 0, b.size.w, gh - 4),
            pcap, s_pace_rng,
            g_stats.pace_g, g_stats.pace_n, true, prv_accent());
  prv_graph(ctx, GRect(0, gh, b.size.w, gh - 4),
            "HEART RATE", s_hr_rng,
            g_stats.hr_g, g_stats.hr_n, false,
            PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
}

/* ---------------- stat grid ---------------- */
static void prv_metric(GContext *ctx, GRect r, const char *cap,
                       const char *val, GColor value_color, bool big) {
  prv_draw_text(ctx, cap, FONT_KEY_GOTHIC_14, GRect(r.origin.x, r.origin.y,
                r.size.w, 16), GTextAlignmentCenter, prv_muted());
  prv_draw_text(ctx, val, big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD,
                GRect(r.origin.x, r.origin.y + 12, r.size.w, r.size.h - 12),
                GTextAlignmentCenter, value_color);
}

static void prv_stats_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  bool run  = (g_set.mode == MODE_RUN);     // only runs carry a VO2max estimate
  int rows  = run ? 4 : 3;                  // extra full-width row for VO2max
  int row_h = b.size.h / rows;
  int col_w = b.size.w / 2;
  bool ride = (g_set.mode == MODE_CYCLE);
  const char *caps[6] = { "MOVING", ride ? "AVG SPEED" : "AVG PACE",
                          "HR AVG/MAX", "ELEV GAIN",
                          ride ? "MAX SPEED" : "CADENCE",
                          ride ? "ELAPSED" : "STEPS" };

  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
  for (int rrow = 1; rrow < rows; rrow++) {                 // dividers between every row
    graphics_draw_line(ctx, GPoint(10, rrow * row_h), GPoint(b.size.w - 10, rrow * row_h));
  }
  for (int rrow = 0; rrow < 3; rrow++) {                    // column split for the paired rows
    graphics_draw_line(ctx, GPoint(col_w, rrow * row_h + 6),
                            GPoint(col_w, (rrow + 1) * row_h - 6));
  }

  for (int i = 0; i < 6; i++) {
    GRect cell = GRect((i % 2) * col_w, (i / 2) * row_h,
                       (i % 2) ? (b.size.w - col_w) : col_w, row_h);
    prv_metric(ctx, cell, caps[i], s_v[i],
               (i == 1) ? prv_accent() : GColorBlack, s_big);
  }
  if (run) {   // VO2max spans the full width of the 4th row
    prv_metric(ctx, GRect(0, 3 * row_h, b.size.w, row_h),
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

  bool ride = (g_set.mode == MODE_CYCLE);
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

  if (s_dist) text_layer_set_text(s_dist, s_dist_buf);
  if (s_stats_layer) layer_mark_dirty(s_stats_layer);
  if (s_graphs_layer) layer_mark_dirty(s_graphs_layer);
}

static void prv_show_upload(void) {
  if (!s_win || !s_upload) return;
  GColor c = prv_muted();
  if (s_upload_state == 0) {
    snprintf(s_upload_buf, sizeof(s_upload_buf), "Uploading...");
  } else if (s_upload_state == 1) {
    snprintf(s_upload_buf, sizeof(s_upload_buf), "Uploaded");
    c = PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack);
  } else if (s_upload_state == 2) {
    // surface the reason so a failure is diagnosable from the wrist
    if (s_upload_err > 0) {
      snprintf(s_upload_buf, sizeof(s_upload_buf), "Upload failed (%d)", s_upload_err);
    } else {
      snprintf(s_upload_buf, sizeof(s_upload_buf), "Upload failed (net)");
    }
    c = PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
  } else {
    snprintf(s_upload_buf, sizeof(s_upload_buf), "Saved on phone");
  }
  text_layer_set_text_color(s_upload, c);
  text_layer_set_text(s_upload, s_upload_buf);
}

/* ---- voice rename (Dictation API) ---- */
#if defined(PBL_MICROPHONE)
static DictationSession *s_dictation = NULL;
static char s_name_buf[64];
static void prv_dictation_cb(DictationSession *session, DictationSessionStatus status,
                             char *transcription, void *context) {
  (void)session; (void)context;
  if (status == DictationSessionStatusSuccess && transcription && transcription[0]) {
    comms_send_rename(transcription);          // phone renames the just-saved run
    if (s_banner) {
      text_layer_set_background_color(s_banner, PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack));
      text_layer_set_text_color(s_banner, GColorWhite);
      text_layer_set_text(s_banner, "Renamed");
    }
  }
}
static void prv_start_rename(void) {
  if (!s_dictation)
    s_dictation = dictation_session_create(sizeof(s_name_buf), prv_dictation_cb, NULL);
  if (s_dictation) dictation_session_start(s_dictation);
}
#else
static void prv_start_rename(void) {
  if (s_banner) {
    text_layer_set_background_color(s_banner, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    text_layer_set_text_color(s_banner, GColorWhite);
    text_layer_set_text(s_banner, "No mic on this watch");
  }
}
#endif

/* ---- scrolling + the SELECT "\u22ee" actions menu ----
 * The run is already saved on the phone; this menu is for optional extras.
 * Scroll mode: UP/DOWN scroll, SELECT opens the actions menu.
 * Menu: UP = upload to server (confirmed), SELECT = rename by voice,
 *       DOWN = discard (confirmed); BACK closes the menu.
 * Confirm modes: SELECT commits (upload / discard), UP or BACK cancels. */
static void prv_apply_mode(void) {
  if (s_bar) {
    if (s_menu == 0)      hintbar_set_icons(s_bar, HB_UP, HB_MENU, HB_NONE, HB_DOWN);
    else if (s_menu == 1) hintbar_set_icons(s_bar, HB_UPLOAD, HB_MIC, HB_NONE, HB_TRASH);
    else                  hintbar_set_icons(s_bar, HB_DECLINE, HB_CONFIRM, HB_NONE, HB_NONE);
  }
  if (s_banner) {
    if (s_menu == 0) {
      text_layer_set_background_color(s_banner, GColorClear);
      text_layer_set_text(s_banner, "");
    } else if (s_menu == 1) {
      text_layer_set_background_color(s_banner, PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack));
      text_layer_set_text_color(s_banner, GColorWhite);
      text_layer_set_text(s_banner, "Actions");
    } else if (s_menu == 2) {
      text_layer_set_background_color(s_banner, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
      text_layer_set_text_color(s_banner, GColorWhite);
      text_layer_set_text(s_banner, "Discard this run?");
    } else {
      text_layer_set_background_color(s_banner, PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack));
      text_layer_set_text_color(s_banner, GColorWhite);
      text_layer_set_text(s_banner, "Upload to server?");
    }
  }
}

static void prv_scroll_by(int dy) {
  s_off += dy;
  int min_off = s_scr_h - s_content_h;
  if (min_off > 0) min_off = 0;
  if (s_off > 0) s_off = 0;
  if (s_off < min_off) s_off = min_off;
  scroll_layer_set_content_offset(s_scroll, GPoint(0, s_off), true);
}

static void prv_up_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_menu == 0)      prv_scroll_by(+(s_scr_h * 8 / 10));
  else if (s_menu == 1) { s_menu = 3; prv_apply_mode(); }       // Upload -> confirm
  else                  { s_menu = 1; prv_apply_mode(); }       // confirm -> cancel (keep)
}

static void prv_down_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_menu == 0)      prv_scroll_by(-(s_scr_h * 8 / 10));
  else if (s_menu == 1) { s_menu = 2; prv_apply_mode(); }       // Discard -> confirm
  /* confirm modes: DOWN is intentionally inert */
}

static void prv_select_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_menu == 0)      { s_menu = 1; prv_apply_mode(); }       // open menu
  else if (s_menu == 1) { prv_start_rename(); s_menu = 0; prv_apply_mode(); }  // Rename (voice)
  else if (s_menu == 2) {                                       // confirm discard
    comms_send_cmd(CMD_DISCARD);
    main_workout_discarded();
    window_stack_pop(true);
  } else {                                                      // confirm upload (to server)
    comms_send_cmd(CMD_UPLOAD);
    s_menu = 0; prv_apply_mode();
  }
}

static void prv_back_click(ClickRecognizerRef rec, void *ctx) {
  (void)rec; (void)ctx;
  if (s_menu != 0) { s_menu = 0; prv_apply_mode(); }  // leave menu, stay on debrief
  else window_stack_pop(true);
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
}

/* ---------------- window plumbing ---------------- */
static TextLayer *prv_text(GRect r, const char *font, GTextAlignment align, GColor color) {
  TextLayer *tl = text_layer_create(r);
  text_layer_set_background_color(tl, GColorClear);
  text_layer_set_text_color(tl, color);
  text_layer_set_font(tl, fonts_get_system_font(font));
  text_layer_set_text_alignment(tl, align);
  scroll_layer_add_child(s_scroll, text_layer_get_layer(tl));
  return tl;
}

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  const int W = b.size.w;
  s_big = (W >= 180);
  const int ab_w = hintbar_width(W);
  const int CW = W - ab_w;
  s_scr_h = b.size.h;
  const int track_h  = s_big ? 112 : 88;
  const int graph_h  = s_big ? 64 : 56;     // per graph, incl. caption
  const int stats_h  = (s_big ? 42 : 37) * (g_set.mode == MODE_RUN ? 4 : 3);  // +1 row for VO2max on runs

  s_menu = 0; s_off = 0;
  window_set_background_color(window, GColorWhite);

  s_scroll = scroll_layer_create(b);
  layer_add_child(root, scroll_layer_get_layer(s_scroll));

  int y = 2;
  s_title = prv_text(GRect(10, y, CW - 20, 20), FONT_KEY_GOTHIC_18_BOLD,
                     GTextAlignmentLeft, PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack));
  text_layer_set_text(s_title, g_set.mode == MODE_WALK ? "WALK SAVED" : g_set.mode == MODE_CYCLE ? "RIDE SAVED" : "RUN SAVED");
  y += 22;

  s_dist = prv_text(GRect(0, y - 4, CW, 40),
                    FONT_KEY_GOTHIC_28_BOLD, GTextAlignmentCenter, GColorBlack);
  y += 40;

  s_track_layer = layer_create(GRect(8, y, CW - 16, track_h));
  layer_set_update_proc(s_track_layer, prv_track_update);
  scroll_layer_add_child(s_scroll, s_track_layer);
  y += track_h + 8;

  s_graphs_layer = layer_create(GRect(10, y, CW - 20, graph_h * 2));
  layer_set_update_proc(s_graphs_layer, prv_graphs_update);
  scroll_layer_add_child(s_scroll, s_graphs_layer);
  y += graph_h * 2 + 6;

  s_stats_layer = layer_create(GRect(0, y, CW, stats_h));
  layer_set_update_proc(s_stats_layer, prv_stats_update);
  scroll_layer_add_child(s_scroll, s_stats_layer);
  y += stats_h + 2;

  s_upload = prv_text(GRect(0, y, CW, 22), FONT_KEY_GOTHIC_14_BOLD,
                      GTextAlignmentCenter, prv_muted());
  y += 22;

  s_hint = prv_text(GRect(0, y, CW, 20), FONT_KEY_GOTHIC_14,
                    GTextAlignmentCenter, prv_muted());
  text_layer_set_text(s_hint, "SELECT: actions");
  y += 24;

  s_content_h = y + 4;
  scroll_layer_set_content_size(s_scroll, GSize(CW, s_content_h));

  // fixed chrome drawn over the scrolling content
  s_bar = hintbar_create(GRect(CW, 0, ab_w, b.size.h));
  layer_add_child(root, s_bar);

  s_banner = text_layer_create(GRect(0, 0, CW, 26));
  text_layer_set_font(s_banner, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_banner, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_banner));

  window_set_click_config_provider(window, prv_summary_clicks);

  prv_fill_texts();
  prv_show_upload();
  prv_apply_mode();
}

static void prv_unload(Window *window) {
  (void)window;
#if defined(PBL_MICROPHONE)
  if (s_dictation) { dictation_session_destroy(s_dictation); s_dictation = NULL; }
#endif
  hintbar_destroy(s_bar); s_bar = NULL;
  text_layer_destroy(s_banner);
  text_layer_destroy(s_hint);
  text_layer_destroy(s_title);
  text_layer_destroy(s_dist);
  text_layer_destroy(s_upload);
  layer_destroy(s_track_layer);
  layer_destroy(s_graphs_layer);
  layer_destroy(s_stats_layer);
  scroll_layer_destroy(s_scroll);
  window_destroy(s_win);
  s_win = NULL;
}

void summary_window_push(void) {
  if (s_win) {
    prv_fill_texts();
    if (s_track_layer) layer_mark_dirty(s_track_layer);
    return;
  }
  s_upload_state = -1;
  s_menu = 0; s_off = 0;
  s_win = window_create();
  window_set_window_handlers(s_win, (WindowHandlers) {
    .load = prv_load,
    .unload = prv_unload,
  });
  window_stack_push(s_win, true);
}
