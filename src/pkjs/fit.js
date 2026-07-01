/* FIT activity-file builder (ES5) — dual-use: required by index.js for
 * uploads, injected into tools/page.html for downloads. Emits a minimal but
 * valid FIT file: file_id, record(s), lap, session, activity. Returns a
 * Uint8Array. Shares run.pts: [t, lat, lon, ele|'', hr, seg, cad].
 *
 * FIT is little-endian. Scales: distance cm (x100), speed mm/s (x1000),
 * altitude (m+500)x5, time = unix - 631065600 (FIT epoch 1989-12-31). */
var RL_FIT_EPOCH = 631065600;
var RL_SEMI = 2147483648 / 180;   // degrees -> semicircles

function rlFitCrc(bytes) {
  var table = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
               0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  var crc = 0, i;
  for (i = 0; i < bytes.length; i++) {
    var b = bytes[i], t;
    t = table[crc & 0xF]; crc = ((crc >> 4) & 0x0FFF) ^ t ^ table[b & 0xF];
    t = table[crc & 0xF]; crc = ((crc >> 4) & 0x0FFF) ^ t ^ table[(b >> 4) & 0xF];
  }
  return crc & 0xFFFF;
}

function rlU8(a, v)  { a.push(v & 0xFF); }
function rlU16(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); }
function rlU32(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
function rlT(unix)   { return (Math.round(unix) - RL_FIT_EPOCH) >>> 0; }
function rlRad(d)    { return d * Math.PI / 180; }

// base-type bytes
var B_ENUM = 0x00, B_U8 = 0x02, B_U16 = 0x84, B_U32 = 0x86, B_I32 = 0x85, B_U32Z = 0x8C;

// emit a definition message header + field list for a local type
function rlDef(a, local, global, fields) {
  a.push(0x40 | local, 0x00, 0x00);   // header, reserved, little-endian arch
  rlU16(a, global);
  a.push(fields.length);
  for (var i = 0; i < fields.length; i++) a.push(fields[i][0], fields[i][1], fields[i][2]);
}

// data-message header: the local message type itself (bit6 clear)
function rlData(a, local) { a.push(local & 0x0F); }

function rlFitBuild(run) {
  if (!run || !run.pts || run.pts.length < 1) return null;   // defensive: nothing to export
  var pts = run.pts, act = run.act || 0, i;
  var sport = [1, 11, 2][act];          // FIT sport: run / walk / cycle
  var t0 = pts[0][0], tEnd = pts[pts.length - 1][0];

  // cumulative distance (haversine); carry the total across a pause (seg==1)
  // rather than adding the relocation jump as if it were distance travelled.
  var cum = [0], R = 6371000;
  for (i = 1; i < pts.length; i++) {
    if (pts[i][5] === 1) { cum.push(cum[i - 1]); continue; }
    var a1 = pts[i - 1], b1 = pts[i];
    var dLa = rlRad(b1[1] - a1[1]), dLo = rlRad(b1[2] - a1[2]);
    var hv = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
             Math.cos(rlRad(a1[1])) * Math.cos(rlRad(b1[1])) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    cum.push(cum[i - 1] + 2 * R * Math.asin(Math.min(1, Math.sqrt(hv))));
  }

  var d = [];   // everything after the 14-byte header, before the 2-byte CRC

  // ---- file_id (local 0) ----
  rlDef(d, 0, 0, [[3, 4, B_U32Z], [4, 4, B_U32], [1, 2, B_U16], [2, 2, B_U16], [0, 1, B_ENUM]]);
  rlData(d, 0);                        // file_id data
  rlU32(d, 0);                        // serial_number (0 = unset)
  rlU32(d, rlT(t0));                  // time_created
  rlU16(d, 255);                      // manufacturer = development
  rlU16(d, 0);                        // product
  rlU8(d, 4);                         // type = activity

  // ---- record (local 1): one definition, many data messages ----
  rlDef(d, 1, 20, [[253, 4, B_U32], [0, 4, B_I32], [1, 4, B_I32], [5, 4, B_U32],
                   [2, 2, B_U16], [6, 2, B_U16], [3, 1, B_U8], [4, 1, B_U8]]);
  for (i = 0; i < pts.length; i++) {
    var p = pts[i];
    var spd = 0xFFFF;
    if (i > 0) {
      var dt = p[0] - pts[i - 1][0];
      if (dt > 0) spd = Math.min(65534, Math.round((cum[i] - cum[i - 1]) / dt * 1000));
    }
    var alt = (p[3] !== '' && p[3] !== null && p[3] !== undefined)
                ? Math.max(0, Math.min(65534, Math.round((p[3] + 500) * 5))) : 0xFFFF;
    rlData(d, 1);                                // record data
    rlU32(d, rlT(p[0]));                          // timestamp
    rlU32(d, Math.round(p[1] * RL_SEMI));         // position_lat  (sint32 bit pattern)
    rlU32(d, Math.round(p[2] * RL_SEMI));         // position_long
    rlU32(d, Math.round(cum[i] * 100) >>> 0);     // distance (cm)
    rlU16(d, alt);                                // altitude
    rlU16(d, spd);                                // speed (mm/s)
    rlU8(d, p[4] > 0 ? Math.min(254, p[4]) : 0xFF);                       // heart_rate
    rlU8(d, (p.length > 6 && p[6] > 0) ? Math.min(254, Math.round(p[6] / 2)) : 0xFF);  // cadence (rpm)
  }

  // ---- lap (local 2) ----
  rlDef(d, 2, 19, [[254, 2, B_U16], [253, 4, B_U32], [2, 4, B_U32], [7, 4, B_U32],
                   [8, 4, B_U32], [9, 4, B_U32], [25, 1, B_ENUM]]);
  rlData(d, 2);                        // lap data
  rlU16(d, 0);                         // message_index
  rlU32(d, rlT(tEnd));                 // timestamp
  rlU32(d, rlT(t0));                   // start_time
  rlU32(d, Math.round((run.dur || 0) * 1000) >>> 0);   // total_elapsed_time
  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0); // total_timer_time
  rlU32(d, Math.round((run.dist || 0) * 100) >>> 0);   // total_distance
  rlU8(d, sport);

  // ---- session (local 3) ----
  rlDef(d, 3, 18, [[254, 2, B_U16], [253, 4, B_U32], [2, 4, B_U32], [7, 4, B_U32],
                   [8, 4, B_U32], [9, 4, B_U32], [5, 1, B_ENUM], [26, 2, B_U16],
                   [25, 2, B_U16], [16, 1, B_U8], [17, 1, B_U8]]);
  rlData(d, 3);                        // session data
  rlU16(d, 0);                         // message_index
  rlU32(d, rlT(tEnd));                 // timestamp
  rlU32(d, rlT(t0));                   // start_time
  rlU32(d, Math.round((run.dur || 0) * 1000) >>> 0);
  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0);
  rlU32(d, Math.round((run.dist || 0) * 100) >>> 0);
  rlU8(d, sport);
  rlU16(d, 1);                         // num_laps
  rlU16(d, 0);                         // first_lap_index
  rlU8(d, run.avgHr > 0 ? Math.min(254, run.avgHr) : 0xFF);
  rlU8(d, run.maxHr > 0 ? Math.min(254, run.maxHr) : 0xFF);

  // ---- activity (local 4) ----
  rlDef(d, 4, 34, [[253, 4, B_U32], [15, 4, B_U32], [1, 2, B_U16],
                   [2, 1, B_ENUM], [3, 1, B_ENUM], [4, 1, B_ENUM], [5, 4, B_U32]]);
  rlData(d, 4);                        // activity data
  rlU32(d, rlT(tEnd));                 // timestamp
  rlU32(d, Math.round((run.mov || run.dur || 0) * 1000) >>> 0);  // total_timer_time
  rlU16(d, 1);                         // num_sessions
  rlU8(d, 0);                          // type = manual
  rlU8(d, 26);                         // event = activity
  rlU8(d, 1);                          // event_type = stop
  rlU32(d, rlT(tEnd));                 // local_timestamp

  // ---- header (14 bytes) ----
  var hdr = [14, 0x20];                // size, protocol 2.0
  rlU16(hdr, 2132);                    // profile version
  rlU32(hdr, d.length);                // data size
  hdr.push(0x2E, 0x46, 0x49, 0x54);    // ".FIT"
  rlU16(hdr, rlFitCrc(hdr));           // header CRC over the first 12 bytes

  var all = hdr.concat(d);
  rlU16(all, rlFitCrc(all));           // file CRC over header + data

  var out = new Uint8Array(all.length);
  for (i = 0; i < all.length; i++) out[i] = all[i];
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { build: rlFitBuild, crc: rlFitCrc };
