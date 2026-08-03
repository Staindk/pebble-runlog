#pragma once
/* hintbar — a slim strip down the right edge that shows, as small bundled
 * icons, what the three physical side buttons (UP / SELECT / DOWN) do now.
 * Icons are GBitmap resources rendered from Kai's SVGs. */
#include <pebble.h>

typedef enum {
  HB_NONE = 0,
  HB_SETTINGS,   // gear
  HB_START,      // play triangle (start / resume)
  HB_CONFIRM,    // check (commit a confirm)
  HB_DECLINE,    // cross (cancel a confirm)
  HB_PAUSE,      // pause bars
  HB_STOP,       // stop square
  HB_RUN,        // activity: run
  HB_WALK,       // activity: walk
  HB_BIKE,       // activity: ride
  HB_HIKE,       // activity: hike
  HB_UP,         // chevron up (scroll)
  HB_DOWN,       // chevron down (scroll)
  HB_MENU,       // kebab (open actions)
  HB_UPLOAD,     // upload
  HB_TRASH,      // discard
  HB_MIC,        // voice rename
  HB_COUNT
} HbIcon;

int hintbar_width(int screen_w);

Layer *hintbar_create(GRect frame);
void hintbar_destroy(Layer *layer);

// set the icons for the three buttons; HB_NONE leaves a button blank.
// sel_sub is an optional smaller icon under SELECT (currently unused; pass HB_NONE).
void hintbar_set_icons(Layer *layer, HbIcon up, HbIcon sel,
                       HbIcon sel_sub, HbIcon down);

// free the shared icon-bitmap cache (call once at app exit)
void hintbar_unload_cache(void);
