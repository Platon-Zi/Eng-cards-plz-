/* ==========================================================================
   scripts/make_icon.cjs — generates icon.png (256×256) for the Electron app.
   Pure Node (zlib only, zero deps). Design: Leitner "stack of cards" mark in
   the app's own brand geometry — deep midnight tile, two offset rounded cards
   (slate back, porcelain front), indigo word-lines and a green mastered dot.
   Rounded-square tile (radius 56/256 ≈ Apple squircle feel, flat on Win).
   Run:  node scripts/make_icon.cjs   →  ./icon.png
   ========================================================================== */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------------- drawing helpers (RGBA floats 0..1, supersampled) -------- */
const SIZE = 256, SS = 4;                      // 4x supersampling → AA edges
const W = SIZE * SS;
const img = new Float64Array(W * W * 4);       // RGBA, premultiplied off

function hex(c) {
  return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
}
function setPx(x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4;
  img[i] = rgb[0] * a + img[i] * (1 - a);      // simple over (bg starts opaque)
  img[i + 1] = rgb[1] * a + img[i + 1] * (1 - a);
  img[i + 2] = rgb[2] * a + img[i + 2] * (1 - a);
  img[i + 3] = 1;
}
/* signed distance to rounded box (centre cx,cy half w/2,h/2, radius r) */
function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}
/* antialiased fill of a rounded box (coords in final px → scaled to SS) */
function fillRoundBox(cx, cy, w, h, r, color, alpha = 1) {
  const col = hex(color);
  const C = cx * SS, H = cy * SS, HW = w * SS / 2, HH = h * SS / 2, R = r * SS;
  const x0 = Math.max(0, Math.floor(C - HW - R - 2)), x1 = Math.min(W - 1, Math.ceil(C + HW + R + 2));
  const y0 = Math.max(0, Math.floor(H - HH - R - 2)), y1 = Math.min(W - 1, Math.ceil(H + HH + R + 2));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = sdRoundBox(x + .5, y + .5, C, H, HW, HH, R);
    const a = Math.max(0, Math.min(1, .5 - d / 1.2)) * alpha;   // 1.2px feather
    if (a > 0) setPx(x, y, col, a);
  }
}
function fillCircle(cx, cy, rad, color, alpha = 1) {
  const col = hex(color);
  const C = cx * SS, H = cy * SS, R = rad * SS;
  for (let y = Math.max(0, Math.floor(H - R - 2)); y <= Math.min(W - 1, Math.ceil(H + R + 2)); y++)
    for (let x = Math.max(0, Math.floor(C - R - 2)); x <= Math.min(W - 1, Math.ceil(C + R + 2)); x++) {
      const d = Math.hypot(x + .5 - C, y + .5 - H) - R;
      const a = Math.max(0, Math.min(1, .5 - d / 1.2)) * alpha;
      if (a > 0) setPx(x, y, col, a);
    }
}

/* ---------------- compose (all coords in 256-space) ------------------------ */
/* tile: vertical gradient of the app's night indigo #0f172a → #16213c */
for (let y = 0; y < W; y++) {
  const t = y / W;
  const top = hex('#101c33'), bot = hex('#0a1122');
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    img[i] = top[0] + (bot[0] - top[0]) * t;
    img[i + 1] = top[1] + (bot[1] - top[1]) * t;
    img[i + 2] = top[2] + (bot[2] - top[2]) * t;
    img[i + 3] = 1;
  }
}
/* squircle mask: alpha 0 outside radius 56 */
{
  const R = 56 * SS;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const d = sdRoundBox(x + .5, y + .5, W / 2, W / 2, W / 2, W / 2, R);
    const a = Math.max(0, Math.min(1, .5 + d / 1.2));           // 1 → outside
    if (a > 0) { const i = (y * W + x) * 4; img[i + 3] = 1 - a; }
  }
}
/* back card (slate, rotated look simulated by offset) + front card */
fillRoundBox(140, 112, 118, 92, 16, '#334155');                  // slate-700
fillRoundBox(124, 138, 132, 104, 18, '#e7eef4');                 // porcelain
/* word lines (indigo-600 #4f46e5-ish of beta accent) */
fillRoundBox(124 - 12, 118, 78, 11, 5, '#4338ca');
fillRoundBox(124 - 26, 141, 46, 9, 4, '#94a3b8');
fillRoundBox(124 - 20, 158, 58, 9, 4, '#94a3b8');
/* green "mastered" dot bottom-right of front card */
fillCircle(178, 186, 13, '#10b981');
/* check mark on the dot — two thin porcelain bars */
fillRoundBox(174.6, 186.4, 9, 3.6, 1.8, '#06281f');
{
  /* small check: rotate two rects manually via tiny loop */
  const col = hex('#f8fafc');
  const bar = (cx, cy, len, th, ang) => {
    for (let t = -len / 2; t <= len / 2; t += .25)
      for (let s = -th / 2; s <= th / 2; s += .25) {
        const x = cx + t * Math.cos(ang) - s * Math.sin(ang);
        const y = cy + t * Math.sin(ang) + s * Math.cos(ang);
        setPx(Math.round(x * SS), Math.round(y * SS), col, 1);
      }
  };
  bar(174.8, 187.6, 8, 3.2, Math.PI / 4);
  bar(179.2, 185.6, 12, 3.2, -Math.PI / 4);
}

/* ---------------- downsample SS→1 and write PNG --------------------------- */
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const i = ((y * SS + sy) * W + x * SS + sx) * 4;
    r += img[i]; g += img[i + 1]; b += img[i + 2]; a += img[i + 3];
  }
  const n = SS * SS, o = (y * SIZE + x) * 4;
  out[o] = Math.round(r / n * 255); out[o + 1] = Math.round(g / n * 255);
  out[o + 2] = Math.round(b / n * 255); out[o + 3] = Math.round(a / n * 255);
}

/* minimal PNG encoder */
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; }
  }
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_T[(c ^ b) & 0xFF] ^ (c >>> 8);
  return c ^ 0xFFFFFFFF;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; /* RGBA8 */
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;                                   /* filter: none */
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
const dest = path.join(__dirname, '..', 'icon.png');
fs.writeFileSync(dest, png);
console.log('icon.png written:', dest, png.length, 'bytes');
