/* RunLog — settings menu (UP button from the run screen) */
#include <pebble.h>
#include "runlog.h"

static Window *s_win = NULL;
static SimpleMenuLayer *s_menu;
static char s_sub_mode[8], s_sub_units[16], s_sub_autop[8], s_sub_splits[16], s_sub_maxhr[12], s_sub_resthr[12];
static char s_sub_export[16];
static SimpleMenuItem s_items[7];
static SimpleMenuSection s_sections[1];

static void prv_fill_subtitles(void) {
  const char *mode = g_set.mode == MODE_WALK ? "Walk"
                   : g_set.mode == MODE_CYCLE ? "Ride"
                   : g_set.mode == MODE_HIKE ? "Hike" : "Run";
  snprintf(s_sub_mode, sizeof(s_sub_mode), "%s", mode);
  snprintf(s_sub_units,  sizeof(s_sub_units),  g_set.miles ? "Miles" : "Kilometres");
  snprintf(s_sub_autop,  sizeof(s_sub_autop),  g_set.autopause ? "On" : "Off");
  if (g_set.splits) {
    snprintf(s_sub_splits, sizeof(s_sub_splits), "Every %d %s",
             split_mult(), g_set.miles ? "mi" : "km");
  } else {
    snprintf(s_sub_splits, sizeof(s_sub_splits), "Off");
  }
  snprintf(s_sub_maxhr,  sizeof(s_sub_maxhr),  "%d bpm", g_set.max_hr);
  if (g_set.rest_hr) snprintf(s_sub_resthr, sizeof(s_sub_resthr), "%d bpm", g_set.rest_hr);
  else               snprintf(s_sub_resthr, sizeof(s_sub_resthr), "Off");
  snprintf(s_sub_export, sizeof(s_sub_export), "Open on phone");
}

static void prv_select(int index, void *context) {
  (void)context;
  switch (index) {
    case 0: g_set.mode = (g_set.mode + 1) % MODE_COUNT; break;
    case 1: g_set.miles = !g_set.miles; break;
    case 2: g_set.autopause = !g_set.autopause; break;
    case 3: g_set.splits = !g_set.splits; break;
    case 4:
      g_set.max_hr += 5;
      if (g_set.max_hr > 205) g_set.max_hr = 150;
      break;
    case 5:
      g_set.rest_hr = (g_set.rest_hr == 0) ? 40 : g_set.rest_hr + 5;
      if (g_set.rest_hr > 90) g_set.rest_hr = 0;   // wraps back to Off
      break;
    case 6:
      phone_config_open();
      return;
  }
  settings_save_and_sync();
  prv_fill_subtitles();
  layer_mark_dirty(simple_menu_layer_get_layer(s_menu));
}

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  prv_fill_subtitles();
  s_items[0] = (SimpleMenuItem){ .title = "Activity",       .subtitle = s_sub_mode,   .callback = prv_select };
  s_items[1] = (SimpleMenuItem){ .title = "Units",          .subtitle = s_sub_units,  .callback = prv_select };
  s_items[2] = (SimpleMenuItem){ .title = "Auto-pause",     .subtitle = s_sub_autop,  .callback = prv_select };
  s_items[3] = (SimpleMenuItem){ .title = "Split alerts",   .subtitle = s_sub_splits, .callback = prv_select };
  s_items[4] = (SimpleMenuItem){ .title = "Max heart rate", .subtitle = s_sub_maxhr,  .callback = prv_select };
  s_items[5] = (SimpleMenuItem){ .title = "Resting HR",     .subtitle = s_sub_resthr, .callback = prv_select };
  s_items[6] = (SimpleMenuItem){ .title = "Export setup",   .subtitle = s_sub_export, .callback = prv_select };
  s_sections[0] = (SimpleMenuSection){ .title = "Settings", .items = s_items, .num_items = 7 };

  s_menu = simple_menu_layer_create(b, window, s_sections, 1, NULL);
  layer_add_child(root, simple_menu_layer_get_layer(s_menu));
}

/* Frees only what prv_load built; the Window itself is released in
 * settings_deinit. window_destroy() from inside the window's own unload handler
 * hands the stack a pointer it is still unwinding through. */
static void prv_unload(Window *window) {
  (void)window;
  simple_menu_layer_destroy(s_menu);
  s_menu = NULL;
}

void settings_window_push(void) {
  if (!s_win) {
    s_win = window_create();
    window_set_window_handlers(s_win, (WindowHandlers) {
      .load = prv_load,
      .unload = prv_unload,
    });
  }
  if (window_stack_contains_window(s_win)) return;   // already showing
  window_stack_push(s_win, true);
}

void settings_deinit(void) {
  if (s_win) { window_destroy(s_win); s_win = NULL; }
}
