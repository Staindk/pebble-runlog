/* RunLog — settings menu (UP button from the run screen) */
#include <pebble.h>
#include "runlog.h"

static Window *s_win = NULL;
static SimpleMenuLayer *s_menu;
static char s_sub_mode[8];
static char s_sub_phone[24];
static SimpleMenuItem s_items[2];
static SimpleMenuSection s_sections[1];

static void prv_fill_subtitles(void) {
  const char *mode = g_set.mode == MODE_WALK ? "Walk"
                   : g_set.mode == MODE_CYCLE ? "Ride"
                   : g_set.mode == MODE_HIKE ? "Hike" : "Run";
  snprintf(s_sub_mode, sizeof(s_sub_mode), "%s", mode);
  snprintf(s_sub_phone, sizeof(s_sub_phone), "Workout setup");
}

static void prv_select(int index, void *context) {
  (void)context;
  switch (index) {
    case 0: g_set.mode = (g_set.mode + 1) % MODE_COUNT; break;
    case 1:
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
  s_items[1] = (SimpleMenuItem){ .title = "Phone settings", .subtitle = s_sub_phone,  .callback = prv_select };
  s_sections[0] = (SimpleMenuSection){ .title = "RunLog", .items = s_items, .num_items = 2 };

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
