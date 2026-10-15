// PICO-8 cartridges: the .p8 text format and the .p8.png picture format.
//
// Either way a cart comes out as { rom, code, label }: rom is the 0x4300 bytes
// of sprite sheet, map, flags, music and sound loaded at address 0; code is the
// Lua source as P8SCII (one character per byte); label is the cart's picture
// (128x128 colour indices) when it has one.

export const ROM_SIZE = 0x4300;

// P8SCII 16-31 and 128-255 as Unicode, for reading .p8 text (written as UTF-8).
const GLYPHS_16 = '▮■□⁙⁘‖◀▶「」¥•、。゛゜';
const GLYPHS_128 = ['█', '▒', '🐱', '⬇', '░', '✽', '●', '♥', '☉', '웃', '⌂', '⬅', '😐', '♪', '🅾', '◆',
  '…', '➡', '★', '⧗', '⬆', 'ˇ', '∧', '❎', '▤', '▥'];
const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんっゃゅょ'
  + 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンッャュョ◜◝';
const FROM_UNICODE = new Map();
[...GLYPHS_16].forEach((g, i) => FROM_UNICODE.set(g, 16 + i));
GLYPHS_128.forEach((g, i) => FROM_UNICODE.set(g, 128 + i));
[...KANA].forEach((g, i) => FROM_UNICODE.set(g, 154 + i));

// UTF-8 text to P8SCII.
function toP8scii(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0xFE0F) continue;                 // emoji presentation selector
    if (c < 128) out += ch;
    else out += String.fromCharCode(FROM_UNICODE.get(ch) ?? 63);
  }
  return out;
}

// ---------------------------------------------------------------- .p8 text

function parseP8(text) {
  const rom = new Uint8Array(ROM_SIZE);
  const sections = {};
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^__(\w+)__\s*$/.exec(line);
    if (m) { cur = m[1]; sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  if (!sections.lua && !sections.gfx) throw new Error('not a PICO-8 cart');
  const hex = (s, i) => parseInt(s[i], 16) || 0;

  (sections.gfx || []).slice(0, 128).forEach((line, y) => {
    for (let x = 0; x < 128 && x < line.length; x += 2) rom[y * 64 + (x >> 1)] = hex(line, x) | (hex(line, x + 1) << 4);
  });
  (sections.gff || []).slice(0, 2).forEach((line, y) => {
    for (let i = 0; i < 128 && i * 2 < line.length; i++) rom[0x3000 + y * 128 + i] = parseInt(line.substr(i * 2, 2), 16) || 0;
  });
  (sections.map || []).slice(0, 32).forEach((line, y) => {
    for (let i = 0; i < 128 && i * 2 < line.length; i++) rom[0x2000 + y * 128 + i] = parseInt(line.substr(i * 2, 2), 16) || 0;
  });
  (sections.sfx || []).slice(0, 64).forEach((line, n) => {
    if (line.length < 8) return;
    const a = 0x3200 + n * 68;
    const byte = (i) => parseInt(line.substr(i, 2), 16) || 0;
    rom[a + 64] = byte(0); rom[a + 65] = byte(2); rom[a + 66] = byte(4); rom[a + 67] = byte(6);
    for (let k = 0; k < 32; k++) {
      const o = 8 + k * 5;
      if (o + 5 > line.length) break;
      const pitch = byte(o), wave = hex(line, o + 2), vol = hex(line, o + 3), fx = hex(line, o + 4);
      const w = (pitch & 63) | ((wave & 7) << 6) | ((vol & 7) << 9) | ((fx & 7) << 12) | ((wave & 8) << 12);
      rom[a + k * 2] = w & 255;
      rom[a + k * 2 + 1] = w >> 8;
    }
  });
  (sections.music || []).slice(0, 64).forEach((line, n) => {
    const m = /^([0-9a-f]{2}) ([0-9a-f]{8})/i.exec(line);
    if (!m) return;
    const flags = parseInt(m[1], 16);
    for (let c = 0; c < 4; c++) rom[0x3100 + n * 4 + c] = (parseInt(m[2].substr(c * 2, 2), 16) & 0x7f) | (((flags >> c) & 1) << 7);
  });

  let label = null;
  if (sections.label) {
    label = new Uint8Array(128 * 128);
    sections.label.slice(0, 128).forEach((line, y) => {
      for (let x = 0; x < 128 && x < line.length; x++) {
        // Label pixels are 0-9, a-v: 16 and up are the secret colours.
        const v = parseInt(line[x], 32) || 0;
        label[y * 128 + x] = v & 15;
      }
    });
  }
  return { rom, code: toP8scii((sections.lua || []).join('\n')), label };
}

// ---------------------------------------------------------------- .p8.png

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decode a PNG to RGBA, without the browser's colour handling (which would
// damage the low bits that hold the cart).
async function decodePng(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos), kind = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      depth = body[8]; ctype = body[9]; interlace = body[12];
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error('unsupported PNG layout');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error('unsupported PNG colour type');
  const total = idat.reduce((n, c) => n + c.length, 0), z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = await inflate(z);
  const stride = width * channels, px = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v & 255;
    }
    prev = out;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (ctype === 6) { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    else if (ctype === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (ctype === 3) { const k = px[i]; r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]; a = trns && k < trns.length ? trns[k] : 255; }
    else if (ctype === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
    else { r = g = b = px[i]; }
    rgba.set([r, g, b, a], i * 4);
  }
  return { width, height, rgba };
}

const OLD_LUT = '\n 0123456789abcdefghijklmnopqrstuvwxyz!#%(){}[]<>+=/*:;.,~_';

// The old (pre-0.2.0) code compression.
function decompressOld(b) {
  const len = (b[4] << 8) | b[5];
  let out = '';
  let i = 8;
  while (out.length < len && i < b.length) {
    const c = b[i++];
    if (c === 0) out += String.fromCharCode(b[i++]);
    else if (c < 0x3c) out += OLD_LUT[c - 1];
    else {
      const c2 = b[i++];
      const offset = (c - 0x3c) * 16 + (c2 & 15), n = (c2 >> 4) + 2;
      const start = out.length - offset;
      for (let k = 0; k < n; k++) out += out[start + k];
    }
  }
  return out;
}

// The PXA code compression (0.2.0 and later): move-to-front literals and back references.
function decompressPxa(b) {
  const len = (b[4] << 8) | b[5];
  let bit = 8 * 8;
  const read = () => { const v = (b[bit >> 3] >> (bit & 7)) & 1; bit++; return v; };
  const readN = (n) => { let v = 0; for (let k = 0; k < n; k++) v |= read() << k; return v; };
  const mtf = Array.from({ length: 256 }, (_, i) => i);
  const out = [];
  while (out.length < len && (bit >> 3) < b.length) {
    if (read()) {
      let unary = 0;
      while (read()) unary++;
      const idx = readN(4 + unary) + (((1 << unary) - 1) << 4);
      const c = mtf[idx];
      mtf.splice(idx, 1);
      mtf.unshift(c);
      out.push(c);
    } else {
      const obits = read() ? (read() ? 5 : 10) : 15;
      const offset = readN(obits) + 1;
      if (obits === 10 && offset === 1) {
        // A run of raw bytes, ending at a zero.
        for (let c = readN(8); c; c = readN(8)) out.push(c);
        continue;
      }
      let n = 3, part;
      do { part = readN(3); n += part; } while (part === 7);
      const start = out.length - offset;
      for (let k = 0; k < n; k++) out.push(out[start + k]);
    }
  }
  let s = '';
  for (const c of out) s += String.fromCharCode(c);
  return s;
}

export function decodeCode(b) {
  if (b[0] === 0x3a && b[1] === 0x63 && b[2] === 0x3a && b[3] === 0) return decompressOld(b);
  if (b[0] === 0 && b[1] === 0x70 && b[2] === 0x78 && b[3] === 0x61) return decompressPxa(b);
  let end = b.indexOf(0);
  if (end < 0) end = b.length;
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

async function parsePng(bytes) {
  const { width, height, rgba } = await decodePng(bytes);
  if (width !== 160 || height !== 205) throw new Error('not a PICO-8 cart picture (should be 160x205)');
  const data = new Uint8Array(0x8020);
  for (let i = 0; i < data.length && i < width * height; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    data[i] = ((a & 3) << 6) | ((r & 3) << 4) | ((g & 3) << 2) | (b & 3);
  }
  const rom = data.slice(0, ROM_SIZE);
  const code = decodeCode(data.subarray(0x4300, 0x8000));
  return { rom, code, label: null };
}

// ---------------------------------------------------------------- entry

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
export async function parseCart(bytes) {
  if (PNG_SIG.every((v, i) => bytes[i] === v)) return parsePng(bytes);
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*pico-8 cartridge/i.test(text) && !/__lua__/.test(text)) throw new Error('not a PICO-8 cart (.p8 or .p8.png)');
  return parseP8(text);
}
