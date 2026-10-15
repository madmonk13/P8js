#!/usr/bin/env node
// Run a cart headless for some frames and report errors / a checksum of the screen.
// Usage: node tools/run-cart.mjs cart.p8 [frames] [--dump out.ppm] [--js]
import fs from 'node:fs';
import { parseCart } from '../src/p8/cart.js';
import { Pico8 } from '../src/p8/pico8.js';
import { parse, generate } from '../src/p8/lua.js';

const args = process.argv.slice(2);
const file = args[0], frames = +(args[1] || 120);
const cart = await parseCart(new Uint8Array(fs.readFileSync(file)));
if (args.includes('--js')) { console.log(generate(parse(cart.code))); process.exit(0); }
const p8 = new Pico8();
p8.onLog = (m, e) => { console.log(m); if (e && e.stack && process.env.STACK) console.log(e.stack); };
p8.load(cart);
const t0 = performance.now();
for (let i = 0; i < frames; i++) {
  p8.buttons = args.includes('--press') && (i % 20) < 10 ? 0x10 : 0;
  p8.runFrame();
  if (p8.phase === 'halted' && p8.error) break;
}
const ms = (performance.now() - t0) / frames;
let h = 0;
for (let i = 0x6000; i < 0x8000; i++) h = (h * 31 + p8.mem[i]) >>> 0;
console.log(`${file}: phase=${p8.phase} frames=${p8.frames} fps=${p8.fps} ${ms.toFixed(2)} ms/frame screen=${h.toString(16)}${p8.error ? ` ERROR ${p8.error}` : ''}`);
const di = args.indexOf('--dump');
if (di >= 0) {
  const out = Buffer.alloc(128 * 128 * 3);
  for (let i = 0; i < 128 * 128; i++) { const c = p8.frame[i]; out[i * 3] = c & 255; out[i * 3 + 1] = (c >> 8) & 255; out[i * 3 + 2] = (c >> 16) & 255; }
  fs.writeFileSync(args[di + 1], Buffer.concat([Buffer.from('P6 128 128 255\n'), out]));
}
