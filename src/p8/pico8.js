// The PICO-8 machine: 64K of memory, the 128x128 16-colour screen, input,
// sound, and the API a cart's Lua calls, running code compiled by lua.js.
//
// Memory map: 0x0000 sprite sheet (4 bits a pixel, low nibble = left), 0x1000
// sprites 128-255 / map rows 32-63, 0x2000 map, 0x3000 sprite flags, 0x3100
// music, 0x3200 sound effects, 0x4300 user memory, 0x5e00 cart data, 0x5f00
// draw state, 0x6000 screen (4 bits a pixel), 0x8000 more user memory.

import { compile, LuaError as CompileError } from './lua.js';
import * as L from './lua-runtime.js';
import { LuaTable, Multi, Coroutine, LuaError, $M, $first, $spread, $T, $idx, $set, $c, fix, fmtNum, strToNum, type, bits, unbits } from './lua-runtime.js';
import { GLYPH_W, GLYPH_ROWS } from './font.js';
import { P8Audio } from './audio.js';
import { ROM_SIZE } from './cart.js';

export const WIDTH = 128, HEIGHT = 128;

// The 16 colours, and the 16 extra ones (128-143) the screen palette can pick.
const RGB = [
  0x000000, 0x1d2b53, 0x7e2553, 0x008751, 0xab5236, 0x5f574f, 0xc2c3c7, 0xfff1e8,
  0xff004d, 0xffa300, 0xffec27, 0x00e436, 0x29adff, 0x83769c, 0xff77a8, 0xffccaa,
];
const RGB_EXTRA = [
  0x291814, 0x111d35, 0x422136, 0x125359, 0x742f29, 0x49333b, 0xa28879, 0xf3ef7d,
  0xbe1250, 0xff6c24, 0xa8e72e, 0x00b543, 0x065ab5, 0x754665, 0xff6e59, 0xff9d81,
];
// As little-endian ABGR words for the canvas.
const abgr = (c) => (0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)) >>> 0;
const COLORS = new Uint32Array(256);
for (let i = 0; i < 256; i++) COLORS[i] = abgr(i & 128 ? RGB_EXTRA[i & 15] : RGB[i & 15]);

const P8NUM = '0123456789abcdefghijklmnopqrstuvwxyz';
const pnum = (ch) => { const v = P8NUM.indexOf(ch); return v < 0 ? 0 : v; };

export class Halt extends Error {}

export class Pico8 {
  constructor() {
    this.mem = new Uint8Array(0x10000);
    this.rom = new Uint8Array(ROM_SIZE);
    this.frame = new Uint32Array(WIDTH * HEIGHT);
    this.audio = new P8Audio(this.mem);
    this.buttons = 0;                 // bits 0-5: left right up down O X
    this.prevButtons = 0;
    this.held = new Uint8Array(8);    // frames each button has been down
    this.cart = null;
    this.cartdataId = null;
    this.onCartdata = null;           // (id) -> Uint8Array(256) or null: load saved cart data
    this.onCartdataSave = null;       // (id, bytes)
    this.onLog = null;
    this.error = null;
  }

  // ---------------------------------------------------------------- loading

  load(cart) {
    this.cart = cart;
    this.reset();
  }

  reset() {
    if (this.cartdataId !== null) this.saveCartdata(true);     // keep the outgoing cart's data
    const cart = this.cart;
    this.mem.fill(0);
    this.mem.set(cart.rom);
    this.rom.set(cart.rom);
    this.audio.reset();
    this.resetDrawState();
    this.cartdataId = null;
    this.cartdataDirty = false;
    this.frames = 0;
    this.fps = 30;
    this.sub = 1;
    this.error = null;
    this.rng = [0x12345678 ^ Date.now() | 0, 0x9abcdef0];
    this.menuItems = [];
    this.G = this.makeGlobals();
    this.phase = 'main';               // main chunk running, then 'loop', or 'halted'
    this.resumeGen = null;
    this.lineX = 0; this.lineY = 0; this.lineValid = false;
    try {
      const chunk = compile(cart.code, this.env());
      this.mainGen = chunk();
    } catch (e) {
      this.fail(e);
    }
  }

  resetDrawState() {
    const m = this.mem;
    m.fill(0, 0x5f00, 0x5f80);
    for (let i = 0; i < 16; i++) { m[0x5f00 + i] = i; m[0x5f10 + i] = i; }
    m[0x5f00] = 0x10;                  // colour 0 is transparent for sprites
    m[0x5f22] = 128; m[0x5f23] = 128;  // clip
    m[0x5f25] = 6;                     // pen colour
    m[0x5f55] = 0x60;                  // screen at 0x6000
    m[0x5f5c] = 15; m[0x5f5d] = 4;     // btnp repeat delay / interval (frames at 30fps)
  }

  fail(e) {
    let msg;
    if (e instanceof Halt) {
      if (this.wantRestart) { this.wantRestart = false; this.reset(); return; }
      this.phase = 'halted';
      return;
    }
    if (e instanceof LuaError || e instanceof CompileError) msg = e.message;
    else if (e instanceof RangeError) msg = 'stack overflow';
    else if (e instanceof TypeError || e instanceof ReferenceError) msg = `runtime error: ${e.message}`;
    else msg = String(e && e.message || e);
    this.error = msg;
    this.phase = 'halted';
    this.showError(msg);
    if (this.onLog) this.onLog(`error: ${msg}`, e);
  }

  showError(msg) {
    // Like PICO-8: the message over the last frame, at the top.
    this.mem[0x5f25] = 7;
    this.camera(0, 0);
    this.clip();
    this.resetPalette();
    const lines = [];
    for (const raw of String(msg).toLowerCase().split('\n')) for (let i = 0; i < raw.length || i === 0; i += 31) lines.push(raw.slice(i, i + 31));
    this.rectfill(0, 0, 127, lines.length * 6 + 9, 0);
    this.printStr('runtime error', 1, 1, 8);
    lines.forEach((l, i) => this.printStr(l, 1, 8 + i * 6, 7));
    this.present();
  }

  // ---------------------------------------------------------------- frame

  // Advance 1/60 second: a game frame every time at 60fps, every other time at 30,
  // and sound every time (so it arrives in even, small pieces).
  step() {
    this.sub = (this.sub + 1) & 1;
    if (this.fps === 60 || this.sub === 0) this.runFrame();
    this.audio.frame(60);
  }

  // Run one PICO-8 frame (1/30 or 1/60 second, per this.fps).
  runFrame() {
    if (this.phase === 'halted') return;
    this.updateButtons();
    try {
      if (this.phase === 'main') {
        // The main chunk, which may run its own loop with flip().
        const r = this.mainGen.next();
        if (r.done) {
          this.phase = 'loop';
          const init = this.G._init;
          if (typeof init === 'function' || init instanceof LuaTable) $c(init)();
          if (this.G._update60 !== undefined) this.fps = 60;
          if (this.G._update === undefined && this.G._update60 === undefined && this.G._draw === undefined) this.phase = 'halted';
        }
      } else if (this.phase === 'loop') {
        const G = this.G;
        this.fps = G._update60 !== undefined ? 60 : 30;
        const up = G._update60 !== undefined ? G._update60 : G._update;
        if (up !== undefined) $c(up)();
        if (G._draw !== undefined) $c(G._draw)();
      }
    } catch (e) {
      this.fail(e);
    }
    this.frames++;
    this.present();
    this.saveCartdata();
  }

  updateButtons() {
    const b = this.buttons;
    this.prevButtons = this.curButtons ?? 0;
    this.curButtons = b;
    for (let i = 0; i < 8; i++) this.held[i] = b & (1 << i) ? Math.min(255, this.held[i] + 1) : 0;
  }

  // The screen (through the screen palette) as RGBA.
  present() {
    const m = this.mem, out = this.frame, base = (m[0x5f55] << 8) & 0xffff;
    const pal = new Uint32Array(16);
    for (let i = 0; i < 16; i++) pal[i] = COLORS[m[0x5f10 + i] & 0x8f];
    for (let i = 0; i < 8192; i++) {
      const v = m[(base + i) & 0xffff];
      out[i * 2] = pal[v & 15];
      out[i * 2 + 1] = pal[v >> 4];
    }
  }

  // ---------------------------------------------------------------- pixels

  // Prepare the colour state for a shape: pen colour (setting it if given), fill pattern.
  pen(col) {
    const m = this.mem;
    if (col !== undefined && col !== null) {
      const c = typeof col === 'number' ? col : +col || 0;
      m[0x5f25] = Math.floor(c) & 255;
      // Colours with fill pattern bits (fillp in the fraction) set the pattern too.
      if (m[0x5f34] & 1 && c !== Math.floor(c)) this.fillp(c);
    }
    const pc = m[0x5f25];
    this.c1 = m[0x5f00 + (pc & 15)] & 15;
    this.c2 = m[0x5f00 + (pc >> 4)] & 15;
    this.fpat = m[0x5f31] | (m[0x5f32] << 8);
    this.ftrans = m[0x5f33] & 1;
    this.scr = (m[0x5f55] << 8) & 0xffff;
    this.cx0 = m[0x5f20]; this.cy0 = m[0x5f21]; this.cx1 = Math.min(128, m[0x5f22]); this.cy1 = Math.min(128, m[0x5f23]);
    this.camX = (m[0x5f28] | (m[0x5f29] << 8)) << 16 >> 16;
    this.camY = (m[0x5f2a] | (m[0x5f2b] << 8)) << 16 >> 16;
  }

  // Plot at screen coordinates (camera applied, integers), with the prepared colour.
  plot(x, y) {
    if (x < this.cx0 || x >= this.cx1 || y < this.cy0 || y >= this.cy1) return;
    let c = this.c1;
    if (this.fpat && (this.fpat >> (15 - (((y & 3) << 2) | (x & 3)))) & 1) {
      if (this.ftrans) return;
      c = this.c2;
    }
    const a = this.scr + (y << 6) + (x >> 1), m = this.mem;
    m[a] = x & 1 ? (m[a] & 0x0f) | (c << 4) : (m[a] & 0xf0) | c;
  }

  // Raw pixel write (already mapped colour), clipped.
  putc(x, y, c) {
    if (x < this.cx0 || x >= this.cx1 || y < this.cy0 || y >= this.cy1) return;
    const a = this.scr + (y << 6) + (x >> 1), m = this.mem;
    m[a] = x & 1 ? (m[a] & 0x0f) | (c << 4) : (m[a] & 0xf0) | c;
  }

  hline(x0, x1, y) {
    if (y < this.cy0 || y >= this.cy1) return;
    if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
    if (x0 < this.cx0) x0 = this.cx0;
    if (x1 >= this.cx1) x1 = this.cx1 - 1;
    for (let x = x0; x <= x1; x++) this.plot(x, y);
  }

  getPixel(x, y) {
    if (x < 0 || x > 127 || y < 0 || y > 127) return 0;
    const v = this.mem[(((this.mem[0x5f55] << 8) & 0xffff) + (y << 6) + (x >> 1))];
    return x & 1 ? v >> 4 : v & 15;
  }

  // ---------------------------------------------------------------- drawing API

  cls(c = 0) {
    c = Math.floor(c) & 15;
    const base = (this.mem[0x5f55] << 8) & 0xffff;
    this.mem.fill(c | (c << 4), base, base + 0x2000);
    this.mem[0x5f26] = 0; this.mem[0x5f27] = 0;
    this.clip();
  }

  pset(x, y, c) {
    this.pen(c);
    this.plot(Math.floor(x) - this.camX, Math.floor(y) - this.camY);
  }

  pget(x, y) {
    this.pen();
    return this.getPixel(Math.floor(x) - this.camX, Math.floor(y) - this.camY);
  }

  line(x0, y0, x1, y1, c) {
    if (x1 === undefined || y1 === undefined) {
      // line(x1, y1, [c]) continues from the last end point.
      if (x0 === undefined) { this.lineValid = false; return; }
      c = x1 === undefined ? undefined : x1;
      [x1, y1] = [x0, y0];
      if (!this.lineValid) { this.lineX = x1; this.lineY = y1; this.lineValid = true; return; }
      [x0, y0] = [this.lineX, this.lineY];
    }
    this.pen(c);
    x0 = Math.floor(x0) - this.camX; y0 = Math.floor(y0) - this.camY;
    x1 = Math.floor(x1) - this.camX; y1 = Math.floor(y1) - this.camY;
    this.lineX = x1 + this.camX; this.lineY = y1 + this.camY; this.lineValid = true;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, n = 0;
    while (n++ < 1000) {
      this.plot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  rect(x0, y0, x1, y1, c) {
    this.pen(c);
    x0 = Math.floor(x0) - this.camX; y0 = Math.floor(y0) - this.camY;
    x1 = Math.floor(x1) - this.camX; y1 = Math.floor(y1) - this.camY;
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    this.hline(x0, x1, y0); this.hline(x0, x1, y1);
    for (let y = y0 + 1; y < y1; y++) { this.plot(x0, y); this.plot(x1, y); }
  }

  rectfill(x0, y0, x1, y1, c) {
    this.pen(c);
    x0 = Math.floor(x0) - this.camX; y0 = Math.floor(y0) - this.camY;
    x1 = Math.floor(x1) - this.camX; y1 = Math.floor(y1) - this.camY;
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    y0 = Math.max(y0, this.cy0); y1 = Math.min(y1, this.cy1 - 1);
    for (let y = y0; y <= y1; y++) this.hline(x0, x1, y);
  }

  circ(x, y, r = 4, c) { this.ellipse(x, y, r, r, c, false); }
  circfill(x, y, r = 4, c) { this.ellipse(x, y, r, r, c, true); }
  oval(x0, y0, x1, y1, c) { this.ovalBox(x0, y0, x1, y1, c, false); }
  ovalfill(x0, y0, x1, y1, c) { this.ovalBox(x0, y0, x1, y1, c, true); }

  ovalBox(x0, y0, x1, y1, c, fill) {
    this.pen(c);
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.floor(x1); y1 = Math.floor(y1);
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    const cx = (x0 + x1) / 2 - this.camX, cy = (y0 + y1) / 2 - this.camY, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    this.drawEllipse(cx, cy, rx, ry, fill);
  }

  ellipse(x, y, rx, ry, c, fill) {
    this.pen(c);
    x = Math.floor(x) - this.camX; y = Math.floor(y) - this.camY;
    rx = Math.floor(rx); ry = Math.floor(ry);
    if (rx < 0) return;
    if (rx === ry) { this.drawCircle(x, y, rx, fill); return; }
    this.drawEllipse(x, y, rx, ry, fill);
  }

  // Midpoint circle.
  drawCircle(cx, cy, r, fill) {
    let x = r, y = 0, d = 1 - r;
    const span = (a, b, yy) => { if (fill) this.hline(cx - a, cx + a, yy); else { this.plot(cx - a, yy); this.plot(cx + a, yy); } };
    while (y <= x) {
      span(x, y, cy + y); span(x, y, cy - y);
      span(y, x, cy + x); span(y, x, cy - x);
      y++;
      if (d < 0) d += 2 * y + 1;
      else { x--; d += 2 * (y - x) + 1; }
    }
  }

  drawEllipse(cx, cy, rx, ry, fill) {
    if (rx <= 0 || ry <= 0) {
      if (fill || true) for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) this.hline(Math.ceil(cx - rx), Math.floor(cx + rx), y);
      return;
    }
    let prev = null;
    for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
      const t = (y - cy) / ry, w = rx * Math.sqrt(Math.max(0, 1 - t * t));
      const a = Math.round(cx - w), b = Math.round(cx + w);
      if (fill) this.hline(a, b, y);
      else {
        // Join to the previous row's ends so steep parts stay connected.
        const pa = prev ? prev[0] : a, pb = prev ? prev[1] : b;
        const top = y === Math.ceil(cy - ry) || y === Math.floor(cy + ry);
        if (top) this.hline(a, b, y);
        else {
          this.hline(Math.min(a, pa + (pa < a ? 1 : 0)), a, y);
          this.hline(b, Math.max(b, pb - (pb > b ? 1 : 0)), y);
        }
      }
      prev = [a, b];
    }
  }

  // Sprite sheet pixel.
  sget(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || x > 127 || y < 0 || y > 127) return 0;
    const v = this.mem[((this.mem[0x5f54] << 8) & 0xffff) + (y << 6) + (x >> 1)];
    return x & 1 ? v >> 4 : v & 15;
  }
  sset(x, y, c) {
    x = Math.floor(x); y = Math.floor(y);
    if (c === undefined) c = this.mem[0x5f25];
    if (x < 0 || x > 127 || y < 0 || y > 127) return;
    const a = ((this.mem[0x5f54] << 8) & 0xffff) + (y << 6) + (x >> 1), m = this.mem;
    c = m[0x5f00 + (Math.floor(c) & 15)] & 15;
    m[a] = x & 1 ? (m[a] & 0x0f) | (c << 4) : (m[a] & 0xf0) | c;
  }

  // Blit sprite-sheet pixels: (sx, sy, sw, sh) scaled onto (dx, dy, dw, dh) on screen.
  blit(sx, sy, sw, sh, dx, dy, dw, dh, flipX, flipY) {
    this.pen();
    const m = this.mem, sheet = (m[0x5f54] << 8) & 0xffff;
    dx = Math.floor(dx) - this.camX; dy = Math.floor(dy) - this.camY;
    dw = Math.floor(dw); dh = Math.floor(dh);
    if (dw <= 0 || dh <= 0) return;
    const pal = m.subarray(0x5f00, 0x5f10);
    const fx = sw / dw, fy = sh / dh;
    const x0 = Math.max(dx, this.cx0), x1 = Math.min(dx + dw, this.cx1);
    const y0 = Math.max(dy, this.cy0), y1 = Math.min(dy + dh, this.cy1);
    for (let y = y0; y < y1; y++) {
      const oy = y - dy;
      const py = Math.floor(sy + (flipY ? dh - 1 - oy : oy) * fy);
      if (py < 0 || py > 127) continue;
      for (let x = x0; x < x1; x++) {
        const ox = x - dx;
        const pxx = Math.floor(sx + (flipX ? dw - 1 - ox : ox) * fx);
        if (pxx < 0 || pxx > 127) continue;
        const v = m[sheet + (py << 6) + (pxx >> 1)];
        const p = pal[pxx & 1 ? v >> 4 : v & 15];
        if (p & 0x10) continue;
        this.putc(x, y, p & 15);
      }
    }
  }

  spr(n, x, y, w = 1, h = 1, flipX, flipY) {
    n = Math.floor(n);
    if (n < 0 || n > 255) return;
    this.blit((n & 15) * 8, (n >> 4) * 8, w * 8, h * 8, x, y, Math.round(w * 8), Math.round(h * 8), $T(flipX), $T(flipY));
  }

  sspr(sx, sy, sw, sh, dx, dy, dw = sw, dh = sh, flipX, flipY) {
    sx = Math.floor(sx); sy = Math.floor(sy); sw = Math.floor(sw); sh = Math.floor(sh);
    // A negative destination size draws flipped.
    if (dw < 0) { dw = -dw; dx -= dw; flipX = !$T(flipX); }
    if (dh < 0) { dh = -dh; dy -= dh; flipY = !$T(flipY); }
    this.blit(sx, sy, sw, sh, dx, dy, dw, dh, $T(flipX), $T(flipY));
  }

  mget(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || x > 127 || y < 0 || y > 63) return 0;
    return this.mem[(y < 32 ? 0x2000 : 0x1000 - 32 * 128) + y * 128 + x];
  }
  mset(x, y, v) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || x > 127 || y < 0 || y > 63) return;
    this.mem[(y < 32 ? 0x2000 : 0x1000 - 32 * 128) + y * 128 + x] = Math.floor(v) & 255;
  }

  map(cx = 0, cy = 0, sx = 0, sy = 0, cw = 128, ch = 64, layer = 0) {
    cx = Math.floor(cx); cy = Math.floor(cy); sx = Math.floor(sx); sy = Math.floor(sy);
    cw = Math.floor(cw); ch = Math.floor(ch); layer = Math.floor(layer);
    for (let ty = 0; ty < ch; ty++) {
      const my = cy + ty;
      if (my < 0 || my > 63) continue;
      const py = sy + ty * 8;
      if (py - this.camY >= 128 || py - this.camY <= -8) continue;
      for (let tx = 0; tx < cw; tx++) {
        const mx = cx + tx;
        if (mx < 0 || mx > 127) continue;
        const px = sx + tx * 8;
        if (px - this.camX >= 128 || px - this.camX <= -8) continue;
        const t = this.mget(mx, my);
        if (!t) continue;
        if (layer && (this.mem[0x3000 + t] & layer) !== layer) continue;
        this.blit((t & 15) * 8, (t >> 4) * 8, 8, 8, px, py, 8, 8, false, false);
      }
    }
  }

  // Textured line: map pixels along a line.
  tline(x0, y0, x1, y1, mx, my, mdx = 0.125, mdy = 0, layer = 0) {
    this.pen();
    const m = this.mem;
    x0 = Math.floor(x0) - this.camX; y0 = Math.floor(y0) - this.camY;
    x1 = Math.floor(x1) - this.camX; y1 = Math.floor(y1) - this.camY;
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const maskW = m[0x5f38] || 256, maskH = m[0x5f39] || 256, offX = m[0x5f3a], offY = m[0x5f3b];
    for (let i = 0; i <= n; i++) {
      const x = n ? Math.round(x0 + (x1 - x0) * i / n) : x0, y = n ? Math.round(y0 + (y1 - y0) * i / n) : y0;
      const tx = ((Math.floor(mx) % maskW) + maskW) % maskW + offX, ty = ((Math.floor(my) % maskH) + maskH) % maskH + offY;
      const t = this.mget(tx, ty);
      if (t && (!layer || (m[0x3000 + t] & layer) === layer)) {
        const px = (t & 15) * 8 + (Math.floor(mx * 8) & 7), py = (t >> 4) * 8 + (Math.floor(my * 8) & 7);
        const v = m[(py << 6) + (px >> 1)];
        const p = m[0x5f00 + (px & 1 ? v >> 4 : v & 15)];
        if (!(p & 0x10)) this.putc(x, y, p & 15);
      }
      mx += mdx; my += mdy;
    }
  }

  fget(n, f) {
    const v = this.mem[0x3000 + (Math.floor(n) & 255)];
    if (f === undefined) return v;
    return ((v >> Math.floor(f)) & 1) === 1;
  }
  fset(n, f, v) {
    const a = 0x3000 + (Math.floor(n) & 255);
    if (v === undefined) { this.mem[a] = Math.floor(f) & 255; return; }
    const b = 1 << Math.floor(f);
    this.mem[a] = $T(v) ? this.mem[a] | b : this.mem[a] & ~b;
  }

  resetPalette() {
    const m = this.mem;
    for (let i = 0; i < 16; i++) { m[0x5f00 + i] = i; m[0x5f10 + i] = i; }
    m[0x5f00] = 0x10;
  }

  pal(c0, c1, p = 0) {
    const m = this.mem;
    if (c0 === undefined) { this.resetPalette(); m[0x5f31] = m[0x5f32] = m[0x5f33] = 0; return; }
    if (c0 instanceof LuaTable) {
      p = c1 === undefined ? 0 : Math.floor(c1);
      for (const [k, v] of c0.h) if (typeof k === 'number' && typeof v === 'number') this.pal(k, v, p);
      return;
    }
    if (c1 === undefined) {
      // pal(p): reset one palette.
      const which = Math.floor(c0);
      for (let i = 0; i < 16; i++) {
        if (which === 0) m[0x5f00 + i] = (m[0x5f00 + i] & 0x10) | i;
        else if (which === 1) m[0x5f10 + i] = i;
      }
      return;
    }
    c0 = Math.floor(c0) & 15; c1 = Math.floor(c1) & 255;
    if (Math.floor(p) === 1) m[0x5f10 + c0] = c1;
    else if (Math.floor(p) === 0) m[0x5f00 + c0] = (m[0x5f00 + c0] & 0x10) | (c1 & 15);
  }

  palt(c, t) {
    const m = this.mem;
    if (c === undefined) {
      for (let i = 0; i < 16; i++) m[0x5f00 + i] = (m[0x5f00 + i] & 15) | (i === 0 ? 0x10 : 0);
      return;
    }
    if (t === undefined) {
      // A 16-bit mask: bit 15 is colour 0.
      const mask = Math.floor(c) & 0xffff;
      for (let i = 0; i < 16; i++) m[0x5f00 + i] = (m[0x5f00 + i] & 15) | ((mask >> (15 - i)) & 1 ? 0x10 : 0);
      return;
    }
    const i = Math.floor(c) & 15;
    m[0x5f00 + i] = (m[0x5f00 + i] & 15) | ($T(t) ? 0x10 : 0);
  }

  fillp(p = 0) {
    const b = bits(p) >>> 0;
    const pat = (b >>> 16) & 0xffff;
    this.mem[0x5f31] = pat & 255;
    this.mem[0x5f32] = pat >> 8;
    this.mem[0x5f33] = (b >> 15) & 1;            // 0b0.1: the pattern's 1s are transparent
  }

  camera(x = 0, y = 0) {
    const m = this.mem, ox = (m[0x5f28] | (m[0x5f29] << 8)) << 16 >> 16, oy = (m[0x5f2a] | (m[0x5f2b] << 8)) << 16 >> 16;
    x = Math.floor(x) & 0xffff; y = Math.floor(y) & 0xffff;
    m[0x5f28] = x & 255; m[0x5f29] = x >> 8; m[0x5f2a] = y & 255; m[0x5f2b] = y >> 8;
    return $M([ox, oy]);
  }

  clip(x, y, w, h, prev) {
    const m = this.mem;
    const old = $M([m[0x5f20], m[0x5f21], m[0x5f22] - m[0x5f20], m[0x5f23] - m[0x5f21]]);
    if (x === undefined) { m[0x5f20] = 0; m[0x5f21] = 0; m[0x5f22] = 128; m[0x5f23] = 128; return old; }
    let x0 = Math.floor(x), y0 = Math.floor(y), x1 = x0 + Math.floor(w), y1 = y0 + Math.floor(h);
    if ($T(prev)) { x0 = Math.max(x0, m[0x5f20]); y0 = Math.max(y0, m[0x5f21]); x1 = Math.min(x1, m[0x5f22]); y1 = Math.min(y1, m[0x5f23]); }
    const cl = (v) => Math.max(0, Math.min(128, v));
    m[0x5f20] = cl(x0); m[0x5f21] = cl(y0); m[0x5f22] = cl(Math.max(x0, x1)); m[0x5f23] = cl(Math.max(y0, y1));
    return old;
  }

  color(c = 6) { const old = this.mem[0x5f25]; this.mem[0x5f25] = Math.floor(c) & 255; return old; }

  cursor(x = 0, y = 0, c) {
    const m = this.mem, old = $M([m[0x5f26], m[0x5f27], m[0x5f25]]);
    m[0x5f26] = Math.floor(x) & 255; m[0x5f27] = Math.floor(y) & 255;
    if (c !== undefined) m[0x5f25] = Math.floor(c) & 255;
    return old;
  }

  // ---------------------------------------------------------------- text

  // print(str, [x, y], [col]) or print(str, col). Returns the x after the text.
  print(str, x, y, c) {
    const s = str === undefined ? '' : tostr(str);
    const m = this.mem;
    if (y === undefined && x !== undefined) { c = x; x = undefined; }
    if (c !== undefined) m[0x5f25] = Math.floor(c) & 255;
    if (x === undefined) {
      // At the cursor, then move it down a line (scrolling at the bottom).
      let cy = m[0x5f27];
      if (cy > 122) {
        const base = (m[0x5f55] << 8) & 0xffff;
        m.copyWithin(base, base + 6 * 64, base + 0x2000);
        m.fill(0, base + 0x2000 - 6 * 64, base + 0x2000);
        cy = 116;
      }
      const end = this.printStr(s, m[0x5f26], cy);
      if (!this.noNewline) m[0x5f27] = cy + this.lastLines * 6;
      return end;
    }
    return this.printStr(s, Math.floor(x), Math.floor(y));
  }

  // Draw P8SCII text at (x, y) (before the camera). Handles the common control codes.
  printStr(s, x, y, c) {
    if (c !== undefined) this.mem[0x5f25] = c;
    this.pen();
    const m = this.mem, home = x;
    let fg = m[0x5f00 + (m[0x5f25] & 15)] & 15, bg = -1, maxX = x, lines = 1;
    let wide = false, tall = false;
    this.noNewline = false;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i) & 255;
      if (code < 16) {
        switch (code) {
          case 0: i = s.length; break;
          case 1: {                                   // \* repeat the next character
            const n = pnum(s[++i]);
            const ch = s[++i] || '';
            s = s.slice(0, i + 1) + ch.repeat(Math.max(0, n - 1)) + s.slice(i + 1);
            i--;
            break;
          }
          case 2: bg = m[0x5f00 + pnum(s[++i])] & 15; break;
          case 3: x += pnum(s[++i]) - 16; break;
          case 4: y += pnum(s[++i]) - 16; break;
          case 5: x += pnum(s[++i]) - 16; y += pnum(s[++i]) - 16; break;
          case 6: {                                   // \^ commands
            const cmd = s[++i];
            if (cmd >= '1' && cmd <= '9') break;      // wait frames: not supported
            switch (cmd) {
              case 'c': { const col = pnum(s[++i]); this.cls(col); this.pen(); x = home = 0; y = 0; break; }
              case 'g': x = home; break;
              case 'h': home = x; break;
              case 'j': x = pnum(s[++i]) * 4; y = pnum(s[++i]) * 4; break;
              case 's': case 'r': case 'x': case 'y': i++; break;
              case 'w': wide = true; break;
              case 't': tall = true; break;
              case '-': { const f = s[++i]; if (f === 'w') wide = false; else if (f === 't') tall = false; break; }
              case '#': break;
              case ':': {                             // a custom 8x8 glyph as 16 hex digits
                const hex = s.substr(i + 1, 16); i += 16;
                for (let r = 0; r < 8; r++) {
                  const row = parseInt(hex.substr(r * 2, 2), 16) || 0;
                  for (let b = 0; b < 8; b++) if (row & (1 << b)) this.putc(x + b - this.camX, y + r - this.camY, fg);
                }
                x += 8; break;
              }
              case '.': {                             // the same as 8 raw bytes
                for (let r = 0; r < 8; r++) {
                  const row = s.charCodeAt(i + 1 + r) & 255;
                  for (let b = 0; b < 8; b++) if (row & (1 << b)) this.putc(x + b - this.camX, y + r - this.camY, fg);
                }
                i += 8; x += 8; break;
              }
              default: break;
            }
            break;
          }
          case 7: while (i + 1 < s.length && s[i + 1] !== ' ') i++; break;   // \a audio: not supported
          case 8: x -= 4; break;
          case 9: x = home + (Math.floor((x - home) / 16) + 1) * 16; break;
          case 10: x = home; y += tall ? 12 : 6; lines++; break;
          case 11: i += 2; break;                     // decoration
          case 12: fg = m[0x5f00 + pnum(s[++i])] & 15; break;
          case 13: x = home; break;
          default: break;
        }
        continue;
      }
      const w = GLYPH_W[code], rows = GLYPH_ROWS[code], sx = wide ? 2 : 1, sy = tall ? 2 : 1;
      const px = x - this.camX, py = y - this.camY;
      if (bg >= 0) for (let yy = -1; yy < 5 * sy; yy++) for (let xx = -1; xx < w * sx - 1; xx++) this.putc(px + xx, py + yy, bg);
      for (let r = 0; r < 5; r++) {
        const bitsRow = rows[r];
        if (!bitsRow) continue;
        for (let b = 0; b < 8; b++) {
          if (!(bitsRow & (1 << b))) continue;
          for (let a = 0; a < sy; a++) for (let k = 0; k < sx; k++) this.putc(px + b * sx + k, py + r * sy + a, fg);
        }
      }
      x += w * sx;
      if (x > maxX) maxX = x;
    }
    this.lastLines = lines;
    return maxX;
  }

  // ---------------------------------------------------------------- memory

  peek(a, n = 1) {
    a = Math.floor(a); n = Math.floor(n);
    if (n <= 1) return a >= 0 && a <= 0xffff ? this.readByte(a) : 0;
    const out = [];
    for (let i = 0; i < Math.min(n, 8192); i++) out.push(a + i >= 0 && a + i <= 0xffff ? this.readByte(a + i) : 0);
    return $M(out);
  }
  readByte(a) {
    if (a >= 0x5f4c && a < 0x5f54) return a === 0x5f4c ? this.curButtons & 255 : 0;
    return this.mem[a];
  }
  poke(a, ...vals) {
    a = Math.floor(a);
    if (!vals.length) vals = [0];
    for (let i = 0; i < vals.length; i++) {
      const addr = a + i;
      if (addr < 0 || addr > 0xffff) continue;
      this.mem[addr] = Math.floor(vals[i] ?? 0) & 255;
    }
  }
  peek2(a, n = 1) {
    a = Math.floor(a);
    const one = (p) => ((this.mem[p & 0xffff] | (this.mem[(p + 1) & 0xffff] << 8)) << 16 >> 16);
    if (n <= 1) return one(a);
    const out = [];
    for (let i = 0; i < n; i++) out.push(one(a + i * 2));
    return $M(out);
  }
  poke2(a, ...vals) {
    a = Math.floor(a);
    vals.forEach((v, i) => { const x = Math.floor(v ?? 0) & 0xffff, p = a + i * 2; this.mem[p & 0xffff] = x & 255; this.mem[(p + 1) & 0xffff] = x >> 8; });
  }
  peek4(a, n = 1) {
    a = Math.floor(a);
    const m = this.mem;
    const one = (p) => unbits(m[p & 0xffff] | (m[(p + 1) & 0xffff] << 8) | (m[(p + 2) & 0xffff] << 16) | (m[(p + 3) & 0xffff] << 24));
    if (n <= 1) return one(a);
    const out = [];
    for (let i = 0; i < n; i++) out.push(one(a + i * 4));
    return $M(out);
  }
  poke4(a, ...vals) {
    a = Math.floor(a);
    const m = this.mem;
    vals.forEach((v, i) => {
      const b = bits(v ?? 0), p = a + i * 4;
      m[p & 0xffff] = b & 255; m[(p + 1) & 0xffff] = (b >> 8) & 255; m[(p + 2) & 0xffff] = (b >> 16) & 255; m[(p + 3) & 0xffff] = (b >>> 24) & 255;
    });
  }
  memcpy(dst, src, len) {
    dst = Math.floor(dst); src = Math.floor(src); len = Math.floor(len);
    if (len <= 0 || dst < 0 || src < 0) return;
    len = Math.min(len, 0x10000 - dst, 0x10000 - src);
    this.mem.copyWithin(dst, src, src + len);
  }
  memset(dst, v, len) {
    dst = Math.floor(dst); len = Math.floor(len);
    if (len <= 0 || dst < 0) return;
    this.mem.fill(Math.floor(v) & 255, dst, Math.min(0x10000, dst + len));
  }
  reload(dst = 0, src = 0, len = ROM_SIZE) {
    dst = Math.floor(dst); src = Math.floor(src); len = Math.floor(len);
    for (let i = 0; i < len; i++) {
      const s = src + i, d = dst + i;
      if (d < 0 || d > 0xffff) continue;
      this.mem[d] = s >= 0 && s < ROM_SIZE ? this.rom[s] : 0;
    }
  }
  cstore(dst = 0, src = 0, len = ROM_SIZE) {
    dst = Math.floor(dst); src = Math.floor(src); len = Math.floor(len);
    for (let i = 0; i < len; i++) if (dst + i >= 0 && dst + i < ROM_SIZE) this.rom[dst + i] = this.mem[(src + i) & 0xffff];
  }

  // ---------------------------------------------------------------- cart data

  cartdata(id) {
    if (this.cartdataId !== null) return false;
    this.cartdataId = String(id);
    const saved = this.onCartdata ? this.onCartdata(this.cartdataId) : null;
    if (saved) { this.mem.set(saved.subarray(0, 256), 0x5e00); return true; }
    return false;
  }
  dget(i) { i = Math.floor(i); return i >= 0 && i < 64 ? this.peek4(0x5e00 + i * 4) : 0; }
  dset(i, v) {
    i = Math.floor(i);
    if (i < 0 || i >= 64) return;
    this.poke4(0x5e00 + i * 4, v);
    this.cartdataDirty = true;
  }
  // Store changed cart data: checked about once a second, or now when `force`d (page hidden).
  saveCartdata(force = false) {
    if (this.cartdataId === null || (!force && this.frames % this.fps)) return;
    const cur = this.mem.subarray(0x5e00, 0x5f00);
    // Pokes to 0x5e00 count too: compare with the last saved copy.
    if (!this.cartdataDirty && this.lastCartdata && cur.every((v, i) => v === this.lastCartdata[i])) return;
    this.cartdataDirty = false;
    this.lastCartdata = cur.slice();
    if (this.onCartdataSave) this.onCartdataSave(this.cartdataId, this.lastCartdata);
  }

  // ---------------------------------------------------------------- input

  btn(i, p = 0) {
    const b = this.curButtons ?? 0;
    if (i === undefined) return b & 0x3f;
    if (Math.floor(p) !== 0) return false;
    return ((b >> Math.floor(i)) & 1) === 1;
  }

  // Pressed this frame, or repeating while held.
  btnp(i, p = 0) {
    const delay = this.mem[0x5f5c] === 255 ? 0 : (this.mem[0x5f5c] || 15) * (this.fps / 30);
    const interval = (this.mem[0x5f5d] || 4) * (this.fps / 30);
    const one = (k) => {
      const h = this.held[k];
      if (h === 1) return true;
      if (!delay || h <= delay) return false;
      return (h - 1 - delay) % interval === 0;
    };
    if (i === undefined) { let v = 0; for (let k = 0; k < 6; k++) if (one(k)) v |= 1 << k; return v; }
    if (Math.floor(p) !== 0) return false;
    const k = Math.floor(i);
    return k >= 0 && k < 8 ? one(k) : false;
  }

  // ---------------------------------------------------------------- random

  rnd(x = 1) {
    if (x instanceof LuaTable) {
      const n = x.n;
      return n ? x.get(1 + Math.floor(this.random() * n)) : undefined;
    }
    if (typeof x !== 'number') x = 1;
    return fix(this.random() * x);
  }
  // xorshift64-ish from two 32-bit words.
  random() {
    let [a, b] = this.rng;
    a ^= a << 13; a ^= a >>> 17; a ^= a << 5;
    b = (b + 0x6d2b79f5) | 0;
    this.rng = [a, b];
    return (((a ^ b) >>> 0) % 0x10000000) / 0x10000000;
  }
  srand(x = 0) { const b = bits(x); this.rng = [b ^ 0x5bd1e995 | 1, b * 0x27d4eb2d | 0]; for (let i = 0; i < 8; i++) this.random(); }

  // ---------------------------------------------------------------- the API

  env() {
    return {
      ...pick(L, ['$M', '$first', '$spread', '$list', '$T', '$idx', '$set', '$c', '$mc', '$cg', '$mcg', '$fn', '$tbl', '$num', '$iter',
        '$add', '$sub', '$mul', '$div', '$mod', '$pow', '$idiv', '$cat', '$lt', '$le', '$gt', '$ge', '$eq', '$ne',
        '$band', '$bor', '$bxor', '$shl', '$shr', '$lshr', '$rotl', '$rotr', '$unm', '$len', '$bnot']),
      $peek: (a) => this.peek(a), $peek2: (a) => this.peek2(a), $peek4: (a) => this.peek4(a),
      G: this.G,
    };
  }

  makeGlobals() {
    const G = Object.create(null);
    const self = this;
    const def = (name, f) => { G[name] = f; f.$name = name; };
    const num = (v, d = 0) => (typeof v === 'number' ? v : typeof v === 'string' ? strToNum(v) ?? d : d);

    // Graphics
    def('cls', (c) => this.cls(c === undefined ? 0 : num(c)));
    def('pset', (x, y, c) => this.pset(num(x), num(y), c));
    def('pget', (x, y) => this.pget(num(x), num(y)));
    def('line', (...a) => this.line(...a.map((v) => (v === undefined ? v : num(v)))));
    def('rect', (x0, y0, x1, y1, c) => this.rect(num(x0), num(y0), num(x1), num(y1), c));
    def('rectfill', (x0, y0, x1, y1, c) => this.rectfill(num(x0), num(y0), num(x1), num(y1), c));
    def('circ', (x, y, r, c) => this.circ(num(x), num(y), r === undefined ? 4 : num(r), c));
    def('circfill', (x, y, r, c) => this.circfill(num(x), num(y), r === undefined ? 4 : num(r), c));
    def('oval', (x0, y0, x1, y1, c) => this.oval(num(x0), num(y0), num(x1), num(y1), c));
    def('ovalfill', (x0, y0, x1, y1, c) => this.ovalfill(num(x0), num(y0), num(x1), num(y1), c));
    def('rrect', (x, y, w, h, r, c) => this.rect(num(x), num(y), num(x) + num(w) - 1, num(y) + num(h) - 1, c));
    def('rrectfill', (x, y, w, h, r, c) => this.rectfill(num(x), num(y), num(x) + num(w) - 1, num(y) + num(h) - 1, c));
    def('spr', (n, x, y, w, h, fx, fy) => this.spr(num(n), num(x), num(y), w === undefined ? 1 : num(w), h === undefined ? 1 : num(h), fx, fy));
    def('sspr', (sx, sy, sw, sh, dx, dy, dw, dh, fx, fy) => this.sspr(num(sx), num(sy), num(sw), num(sh), num(dx), num(dy),
      dw === undefined ? num(sw) : num(dw), dh === undefined ? num(sh) : num(dh), fx, fy));
    def('sget', (x, y) => this.sget(num(x), num(y)));
    def('sset', (x, y, c) => this.sset(num(x), num(y), c));
    def('map', (...a) => this.map(...a.map((v) => (v === undefined ? undefined : num(v)))));
    G.mapdraw = G.map;
    def('tline', (...a) => this.tline(...a.map((v) => (v === undefined ? undefined : num(v)))));
    def('mget', (x, y) => this.mget(num(x), num(y)));
    def('mset', (x, y, v) => this.mset(num(x), num(y), num(v)));
    def('fget', (n, f) => this.fget(num(n), f === undefined ? undefined : num(f)));
    def('fset', (n, f, v) => this.fset(num(n), f === undefined ? undefined : f, v));
    def('pal', (a, b, p) => this.pal(a instanceof LuaTable ? a : a === undefined ? undefined : num(a), b === undefined ? undefined : num(b), p === undefined ? 0 : num(p)));
    def('palt', (c, t) => this.palt(c === undefined ? undefined : num(c), t));
    def('fillp', (p) => this.fillp(p === undefined ? 0 : num(p)));
    def('camera', (x, y) => this.camera(x === undefined ? 0 : num(x), y === undefined ? 0 : num(y)));
    def('clip', (x, y, w, h, p) => this.clip(x === undefined ? undefined : num(x), num(y), num(w), num(h), p));
    def('color', (c) => this.color(c === undefined ? 6 : num(c)));
    def('cursor', (x, y, c) => this.cursor(x === undefined ? 0 : num(x), y === undefined ? 0 : num(y), c === undefined ? undefined : num(c)));
    def('print', (s, x, y, c) => this.print(s, x === undefined ? undefined : num(x), y === undefined ? undefined : num(y), c === undefined ? undefined : num(c)));
    def('flip', () => { this.present(); });
    G.flip.$yields = 'flip';

    // The glyphs 128-153 are predefined variables: button numbers for the arrows and
    // O / X, fill patterns (with the transparency bit) for the rest.
    const GLYPH_VALUES = [0, 0x5a5a, 0x511f, 3, 0x7d7d, 0xb81d, 0xf99f, 0x51bf, 0xb5bf, 0x999f, 0xb11f, 0, 0xa0e0, 0x9b3f, 4, 0xb1bf,
      0xf5ff, 1, 0xb15f, 0x1b1f, 2, 0xf5bf, 0x7adf, 5, 0x0f0f, 0x5555];
    const BUTTON_GLYPHS = new Set([131, 139, 142, 145, 148, 151]);
    GLYPH_VALUES.forEach((v, i) => {
      const code = 128 + i;
      G[String.fromCharCode(code)] = BUTTON_GLYPHS.has(code) || code === 128 ? v : unbits(((v << 16) | 0x8000) | 0);
    });

    // Input
    def('btn', (i, p) => this.btn(i === undefined ? undefined : num(i), p === undefined ? 0 : num(p)));
    def('btnp', (i, p) => this.btnp(i === undefined ? undefined : num(i), p === undefined ? 0 : num(p)));

    // Sound
    def('sfx', (n, ch, off, len) => this.audio.sfx(num(n), ch === undefined ? -1 : num(ch), off === undefined ? 0 : num(off), len === undefined ? 32 : num(len)));
    def('music', (n, fade, mask) => this.audio.musicPlay(n === undefined ? 0 : num(n), fade === undefined ? 0 : num(fade), mask === undefined ? 15 : num(mask)));

    // Memory
    def('peek', (a, n) => this.peek(num(a), n === undefined ? 1 : num(n)));
    def('poke', (a, ...v) => this.poke(num(a), ...v.map((x) => num(x))));
    def('peek2', (a, n) => this.peek2(num(a), n === undefined ? 1 : num(n)));
    def('poke2', (a, ...v) => this.poke2(num(a), ...v.map((x) => num(x))));
    def('peek4', (a, n) => this.peek4(num(a), n === undefined ? 1 : num(n)));
    def('poke4', (a, ...v) => this.poke4(num(a), ...v.map((x) => num(x))));
    G.dpeek = G.peek2; G.dpoke = G.poke2;
    def('memcpy', (d, s, n) => this.memcpy(num(d), num(s), num(n)));
    def('memset', (d, v, n) => this.memset(num(d), num(v), num(n)));
    def('reload', (d, s, n) => this.reload(d === undefined ? 0 : num(d), s === undefined ? 0 : num(s), n === undefined ? ROM_SIZE : num(n)));
    def('cstore', (d, s, n) => this.cstore(d === undefined ? 0 : num(d), s === undefined ? 0 : num(s), n === undefined ? ROM_SIZE : num(n)));
    def('cartdata', (id) => this.cartdata(id));
    def('dget', (i) => this.dget(num(i)));
    def('dset', (i, v) => this.dset(num(i), num(v)));

    // Math
    def('flr', (x) => Math.floor(num(x)));
    def('ceil', (x) => Math.ceil(num(x)));
    def('abs', (x) => L.wrap(Math.abs(num(x))));
    def('sgn', (x) => (num(x) < 0 ? -1 : 1));
    def('min', (a, b) => Math.min(num(a), num(b)));
    def('max', (a, b) => Math.max(num(a), num(b)));
    def('mid', (a, b, c) => { a = num(a); b = num(b); c = num(c); return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); });
    def('sqrt', (x) => { x = num(x); return x <= 0 ? 0 : fix(Math.sqrt(x)); });
    def('sin', (x) => fix(-Math.sin(num(x) * 2 * Math.PI)));
    def('cos', (x) => fix(Math.cos(num(x) * 2 * Math.PI)));
    def('atan2', (dx, dy) => {
      dx = num(dx); dy = num(dy);
      if (dx === 0 && dy === 0) return 0.25;
      const a = Math.atan2(-dy, dx) / (2 * Math.PI);
      return fix(a < 0 ? a + 1 : a);
    });
    def('rnd', (x) => this.rnd(x));
    def('srand', (x) => this.srand(num(x)));
    def('band', (a, b) => L.$band(num(a), num(b)));
    def('bor', (a, b) => L.$bor(num(a), num(b)));
    def('bxor', (a, b) => L.$bxor(num(a), num(b)));
    def('bnot', (a) => L.$bnot(num(a)));
    def('shl', (a, b) => L.$shl(num(a), num(b)));
    def('shr', (a, b) => L.$shr(num(a), num(b)));
    def('lshr', (a, b) => L.$lshr(num(a), num(b)));
    def('rotl', (a, b) => L.$rotl(num(a), num(b)));
    def('rotr', (a, b) => L.$rotr(num(a), num(b)));

    // Strings
    def('tostr', (v, f) => tostr(v, f));
    def('tonum', (v, f) => tonum(v, f));
    def('chr', (...a) => a.map((c) => String.fromCharCode(Math.floor(num(c)) & 255)).join(''));
    def('ord', (s, i = 1, n = 1) => {
      if (typeof s === 'number') s = fmtNum(s);
      if (typeof s !== 'string') return undefined;
      i = Math.floor(num(i, 1)); n = Math.floor(num(n, 1));
      const out = [];
      for (let k = 0; k < n; k++) { const p = i - 1 + k; out.push(p >= 0 && p < s.length ? s.charCodeAt(p) & 255 : undefined); }
      return $M(out);
    });
    def('sub', (s, i = 1, j) => {
      if (typeof s === 'number') s = fmtNum(s);
      if (typeof s !== 'string') return '';
      const n = s.length;
      i = Math.floor(num(i, 1));
      if (j === true) j = i;
      j = j === undefined || j === false ? n : Math.floor(num(j, n));
      if (i < 0) i = Math.max(1, n + i + 1); else if (i === 0) i = 1;
      if (j < 0) j = n + j + 1; else if (j > n) j = n;
      return i > j ? '' : s.slice(i - 1, j);
    });
    def('split', (s, sep = ',', conv = true) => {
      if (typeof s === 'number') s = fmtNum(s);
      const t = new LuaTable();
      if (typeof s !== 'string') return t;
      let parts;
      if (typeof sep === 'number') { parts = []; for (let i = 0; i < s.length; i += Math.max(1, sep)) parts.push(s.slice(i, i + Math.max(1, sep))); }
      else if (sep === '') parts = [...s];
      else parts = s.split(sep);
      parts.forEach((p, i) => {
        let v = p;
        if ($T(conv)) { const n = strToNum(p); if (n !== undefined && p !== '') v = n; }
        t.set(i + 1, v);
      });
      return t;
    });

    // Tables
    def('add', (t, v, i) => {
      if (!(t instanceof LuaTable)) return undefined;
      if (i === undefined) { t.set(t.n + 1, v); return v; }
      i = Math.floor(num(i));
      for (let k = t.n; k >= i; k--) t.set(k + 1, t.get(k));
      t.set(i, v);
      return v;
    });
    def('del', (t, v) => {
      if (!(t instanceof LuaTable)) return undefined;
      const n = t.n;
      for (let i = 1; i <= n; i++) {
        if (t.get(i) === v) {
          for (let k = i; k < n; k++) t.set(k, t.get(k + 1));
          t.set(n, undefined);
          return v;
        }
      }
      return undefined;
    });
    def('deli', (t, i) => {
      if (!(t instanceof LuaTable)) return undefined;
      const n = t.n;
      i = i === undefined ? n : Math.floor(num(i));
      if (i < 1 || i > n) return undefined;
      const v = t.get(i);
      for (let k = i; k < n; k++) t.set(k, t.get(k + 1));
      t.set(n, undefined);
      return v;
    });
    def('count', (t, v) => {
      if (!(t instanceof LuaTable)) return 0;
      if (v === undefined) return t.n;
      let c = 0;
      for (let i = 1; i <= t.n; i++) if (t.get(i) === v) c++;
      return c;
    });
    // all(t): values in order; deleting the current one while iterating is fine.
    def('all', (t) => {
      if (!(t instanceof LuaTable)) return () => undefined;
      let i = 0, last;
      return () => {
        if (i > 0 && t.get(i) === last) i++;
        else if (i === 0) i = 1;
        while (i <= t.n && t.get(i) === undefined) i++;
        last = t.get(i);
        return last;
      };
    });
    def('foreach', (t, f) => {
      const it = G.all(t);
      for (let v = it(); v !== undefined; v = it()) $c(f)(v);
    });
    def('pairs', (t) => {
      if (!(t instanceof LuaTable)) {
        if (t === undefined) throw new LuaError("bad argument #1 to 'pairs' (table expected, got nil)");
        return () => undefined;
      }
      const mm = t.mt?.get('__pairs');
      if (mm !== undefined) return $c(mm)(t);
      const it = t.h.entries();
      return $M([() => { const r = it.next(); return r.done ? undefined : $M(r.value); }, t, undefined]);
    });
    def('ipairs', (t) => {
      let i = 0;
      return $M([() => { i++; const v = $idx(t, i); return v === undefined ? undefined : $M([i, v]); }, t, 0]);
    });
    def('next', (t, k) => {
      if (!(t instanceof LuaTable)) throw new LuaError("bad argument #1 to 'next' (table expected)");
      const it = t.h.entries();
      let r = it.next();
      if (k !== undefined) {
        while (!r.done && r.value[0] !== k) r = it.next();
        if (!r.done) r = it.next();
      }
      return r.done ? undefined : $M(r.value);
    });
    def('unpack', (t, i = 1, j) => {
      if (!(t instanceof LuaTable)) return undefined;
      i = Math.floor(num(i, 1)); j = j === undefined ? t.n : Math.floor(num(j));
      const out = [];
      for (let k = i; k <= j; k++) out.push(t.get(k));
      return $M(out);
    });
    def('pack', (...a) => { const t = L.$tbl(a); t.set('n', a.length); return t; });
    def('select', (n, ...a) => {
      if (n === '#') return a.length;
      n = Math.floor(num(n));
      if (n < 0) n = a.length + n + 1;
      return $M(a.slice(n - 1));
    });
    def('type', (v) => type(v));
    def('setmetatable', (t, mt) => { if (t instanceof LuaTable) t.mt = mt instanceof LuaTable ? mt : null; return t; });
    def('getmetatable', (t) => (t instanceof LuaTable ? t.mt ?? undefined : undefined));
    def('rawget', (t, k) => (t instanceof LuaTable ? t.get(k) : undefined));
    def('rawset', (t, k, v) => { if (t instanceof LuaTable) t.set(k, v); return t; });
    def('rawequal', (a, b) => a === b);
    def('rawlen', (t) => (t instanceof LuaTable ? t.n : typeof t === 'string' ? t.length : 0));
    def('assert', (v, msg, ...rest) => {
      if (!$T(v)) throw new LuaError(msg === undefined ? 'assertion failed!' : tostr(msg));
      return $M([v, msg, ...rest]);
    });
    def('error', (msg) => { throw new LuaError(typeof msg === 'string' ? msg : tostr(msg), msg); });
    def('pcall', (f, ...a) => {
      try { return $M([true, ...$spread($c(f)(...a))]); }
      catch (e) { if (e instanceof Halt) throw e; return $M([false, e instanceof LuaError && e.value !== undefined ? e.value : e.message]); }
    });

    // Coroutines
    let current = null;
    def('cocreate', (f) => new Coroutine(f));
    def('costatus', (co) => (co instanceof Coroutine ? co.status : undefined));
    def('coresume', (co, ...args) => {
      if (!(co instanceof Coroutine)) throw new LuaError("bad argument #1 to 'coresume' (coroutine expected)");
      if (co.status === 'dead') return $M([false, 'cannot resume dead coroutine']);
      if (co.status === 'running') return $M([false, 'cannot resume non-suspended coroutine']);
      const prev = current;
      current = co;
      co.status = 'running';
      try {
        let r;
        if (!co.gen) {
          const f = co.f;
          if (typeof f !== 'function' || !f.$g) {
            // A function that can't yield: just run it.
            const v = $c(f)(...args);
            co.status = 'dead';
            return $M([true, ...$spread(v)]);
          }
          co.gen = f.$g(...args);
          r = co.gen.next();
        } else r = co.gen.next($M(args));
        // flip() inside a coroutine shows the frame and carries on.
        while (!r.done && r.value.kind === 'flip') { self.present(); r = co.gen.next(); }
        if (r.done) { co.status = 'dead'; return $M([true, ...$spread(r.value)]); }
        co.status = 'suspended';
        return $M([true, ...r.value.args]);
      } catch (e) {
        if (e instanceof Halt) throw e;
        co.status = 'dead';
        return $M([false, e instanceof LuaError ? e.message : String(e && e.message || e)]);
      } finally {
        current = prev;
      }
    });
    def('yield', () => { throw new LuaError('attempt to yield from outside a coroutine'); });
    G.yield.$yields = 'yield';

    // System
    def('time', () => this.frames / this.fps);
    G.t = G.time;
    def('stat', (n) => this.stat(num(n)));
    def('printh', (s) => { if (this.onLog) this.onLog(tostr(s)); });
    def('stop', () => { throw new Halt(); });
    def('menuitem', () => undefined);
    def('extcmd', () => undefined);
    def('run', () => { this.wantRestart = true; throw new Halt('restart'); });
    def('reset', () => { this.resetDrawState(); });
    def('holdframe', () => undefined);
    def('serial', () => 0);
    def('_set_fps', () => undefined);
    def('_update_buttons', () => this.updateButtons());

    return G;
  }

  stat(n) {
    switch (n) {
      case 0: return 100;               // memory in use (KB)
      case 1: case 2: return 0.2;       // CPU
      case 4: return '';                // clipboard
      case 5: return 41;                // version
      case 6: return '';                // run parameter
      case 7: case 8: case 9: return this.fps;
      case 16: case 17: case 18: case 19: return this.audio.channelSfx(n - 16);
      case 20: case 21: case 22: case 23: return this.audio.channelNote(n - 20);
      case 24: return this.audio.music.pattern;
      case 26: return Math.floor(this.audio.music.t / 183);
      case 46: case 47: case 48: case 49: return this.audio.channelSfx(n - 46);
      case 50: case 51: case 52: case 53: return this.audio.channelNote(n - 50);
      case 54: return this.audio.music.pattern;
      case 57: return this.audio.music.pattern >= 0;
      case 30: return false;            // devkit keyboard
      case 31: return '';
      case 32: case 33: case 34: return 0;
    }
    if (n >= 80 && n <= 95) {
      const d = new Date();
      const utc = n < 90;
      const v = [utc ? d.getUTCFullYear() : d.getFullYear(), (utc ? d.getUTCMonth() : d.getMonth()) + 1, utc ? d.getUTCDate() : d.getDate(),
        utc ? d.getUTCHours() : d.getHours(), utc ? d.getUTCMinutes() : d.getMinutes(), utc ? d.getUTCSeconds() : d.getSeconds()];
      return v[(n - 80) % 10] ?? 0;
    }
    return 0;
  }
}

function pick(obj, names) {
  const out = {};
  for (const n of names) out[n] = obj[n];
  return out;
}

export function tostr(v, f) {
  if (v === undefined || v === null) return f === undefined ? '[nil]' : '[nil]';
  if (typeof v === 'number') {
    const flags = f === true ? 1 : typeof f === 'number' ? f : 0;
    if (flags & 1) {
      // Hex: 0x0000.0000 (or the 32-bit integer with flag 2).
      const b = bits(v) >>> 0;
      if (flags & 2) return `0x${b.toString(16).padStart(8, '0')}`;
      return `0x${(b >>> 16).toString(16).padStart(4, '0')}.${(b & 0xffff).toString(16).padStart(4, '0')}`;
    }
    if (flags & 2) return String(bits(v));
    return fmtNum(v);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof LuaTable) {
    const mm = v.mt?.get('__tostring');
    if (mm !== undefined) return tostr($first($c(mm)(v)));
    return '[table]';
  }
  if (typeof v === 'function') return '[function]';
  if (v instanceof Coroutine) return '[thread]';
  return String(v);
}

function tonum(v, f) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return undefined;
  const flags = typeof f === 'number' ? f : 0;
  if (flags & 1) {
    const h = /^[0-9a-f]+(\.[0-9a-f]*)?$/i.test(v.trim()) ? strToNum(`0x${v.trim()}`) : undefined;
    return h ?? (flags & 4 ? 0 : undefined);
  }
  const n = strToNum(v);
  if (n === undefined) return flags & 4 ? 0 : undefined;
  return flags & 2 ? unbits(Math.floor(n)) : n;
}
