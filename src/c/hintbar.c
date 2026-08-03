/* hintbar.c — see hintbar.h. A custom layer that blits small icon bitmaps at
 * the three button rows. Bitmaps are loaded once into a shared cache and
 * reused by both the run screen and the debrief bars. */
#include "hintbar.h"
#include "runlog.h"

typedef struct { HbIcon up, sel, sel_sub, down; } HintModel;

// HbIcon -> resource id (HB_NONE has none)
static uint32_t prv_res(HbIcon ic) {
  switch (ic) {
    case HB_SETTINGS: return RESOURCE_ID_ICON_SETTINGS;
    case HB_START:    return RESOURCE_ID_ICON_START;
    case HB_CONFIRM:  return RESOURCE_ID_ICON_CONFIRM;
    case HB_DECLINE:  return RESOURCE_ID_ICON_DECLINE;
    case HB_PAUSE:    return RESOURCE_ID_ICON_PAUSE;
    case HB_STOP:     return RESOURCE_ID_ICON_STOP;
    case HB_RUN:      return RESOURCE_ID_ICON_RUN;
    case HB_WALK:     return RESOURCE_ID_ICON_WALK;
    case HB_BIKE:     return RESOURCE_ID_ICON_BIKE;
    case HB_HIKE:     return RESOURCE_ID_ICON_HIKE;
    case HB_UP:       return RESOURCE_ID_ICON_UP;
    case HB_DOWN:     return RESOURCE_ID_ICON_DOWN;
    case HB_MENU:     return RESOURCE_ID_ICON_MENU;
    case HB_UPLOAD:   return RESOURCE_ID_ICON_UPLOAD;
    case HB_TRASH:    return RESOURCE_ID_ICON_TRASH;
    case HB_MIC:      return RESOURCE_ID_ICON_MIC;
    default:          return 0;
  }
}

static GBitmap *s_cache[HB_COUNT];

static GBitmap *prv_bmp(HbIcon ic) {
  if (ic <= HB_NONE || ic >= HB_COUNT) return NULL;
  if (!s_cache[ic]) s_cache[ic] = gbitmap_create_with_resource(prv_res(ic));
  return s_cache[ic];
}

void hintbar_unload_cache(void) {
  for (int i = 0; i < HB_COUNT; i++) {
    if (s_cache[i]) { gbitmap_destroy(s_cache[i]); s_cache[i] = NULL; }
  }
}

int hintbar_width(int screen_w) {
  return (screen_w >= 180) ? 28 : 24;   // narrower bar (emery vs basalt/diorite)
}

static void prv_blit(GContext *ctx, HbIcon ic, int cx, int cy) {
  GBitmap *b = prv_bmp(ic);
  if (!b) return;
  GRect r = gbitmap_get_bounds(b);              // native icon size, drawn unscaled
  GRect dst = GRect(cx - r.size.w / 2, cy - r.size.h / 2, r.size.w, r.size.h);
  graphics_context_set_compositing_mode(ctx, GCompOpSet);   // respect transparency
  graphics_draw_bitmap_in_rect(ctx, b, dst);
}

static void prv_update(Layer *layer, GContext *ctx) {
  HintModel *m = (HintModel *)layer_get_data(layer);
  GRect b = layer_get_bounds(layer);
  int W = b.size.w, H = b.size.h;

  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  graphics_draw_line(ctx, GPoint(0, 0), GPoint(0, H));

  int cx = W / 2 + 1;
  int up_y = H * 16 / 100, mid_y = H * 50 / 100, dn_y = H * 84 / 100;

  prv_blit(ctx, m->up, cx, up_y);
  if (m->sel_sub != HB_NONE) {
    prv_blit(ctx, m->sel, cx, mid_y - 10);
    prv_blit(ctx, m->sel_sub, cx, mid_y + 12);
  } else {
    prv_blit(ctx, m->sel, cx, mid_y);
  }
  prv_blit(ctx, m->down, cx, dn_y);
}

Layer *hintbar_create(GRect frame) {
  Layer *l = layer_create_with_data(frame, sizeof(HintModel));
  HintModel *m = (HintModel *)layer_get_data(l);
  m->up = m->sel = m->sel_sub = m->down = HB_NONE;
  layer_set_update_proc(l, prv_update);
  return l;
}

void hintbar_destroy(Layer *layer) { if (layer) layer_destroy(layer); }

void hintbar_set_icons(Layer *layer, HbIcon up, HbIcon sel,
                       HbIcon sel_sub, HbIcon down) {
  if (!layer) return;
  HintModel *m = (HintModel *)layer_get_data(layer);
  if (m->up == up && m->sel == sel && m->sel_sub == sel_sub && m->down == down) return;
  m->up = up; m->sel = sel; m->sel_sub = sel_sub; m->down = down;
  layer_mark_dirty(layer);
}
