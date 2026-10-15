#!/usr/bin/env node
// Print a cart's sound effects and music: node tools/dump-sfx.mjs cart.p8[.png] [sfx numbers...]
import fs from 'node:fs';
import { parseCart } from '../src/p8/cart.js';

const [file, ...pick] = process.argv.slice(2);
const { rom } = await parseCart(new Uint8Array(fs.readFileSync(file)));
const NOTES = ['c-', 'c#', 'd-', 'd#', 'e-', 'f-', 'f#', 'g-', 'g#', 'a-', 'a#', 'b-'];
const WAVES = ['tri', 'tilt', 'saw', 'sqr', 'pls', 'org', 'noi', 'pha'];
for (let n = 0; n < 64; n++) {
  if (pick.length && !pick.includes(String(n))) continue;
  const a = 0x3200 + n * 68;
  const notes = [];
  for (let i = 0; i < 32; i++) {
    const w = rom[a + i * 2] | (rom[a + i * 2 + 1] << 8);
    const vol = (w >> 9) & 7;
    if (!vol) { notes.push('.'); continue; }
    const p = w & 63, wf = (w >> 6) & 7, fx = (w >> 12) & 7, custom = w >> 15;
    notes.push(`${NOTES[p % 12]}${Math.floor(p / 12)}${custom ? 'i' + wf : WAVES[wf]}${vol}${fx || ''}`);
  }
  if (notes.every((x) => x === '.')) continue;
  const f = rom[a + 64];
  const filt = [(f >> 1) & 1 && 'noiz', (f >> 2) & 1 && 'buzz', Math.floor(f / 8) % 3 && `det${Math.floor(f / 8) % 3}`,
    Math.floor(f / 24) % 3 && `rev${Math.floor(f / 24) % 3}`, Math.floor(f / 72) % 3 && `damp${Math.floor(f / 72) % 3}`].filter(Boolean);
  console.log(`sfx ${n} speed ${rom[a + 65]} loop ${rom[a + 66]}-${rom[a + 67]} ${filt.join(' ')}\n  ${notes.join(' ')}`);
}
if (!pick.length) {
  for (let n = 0; n < 64; n++) {
    const b = [0, 1, 2, 3].map((c) => rom[0x3100 + n * 4 + c]);
    if (b.every((x) => x & 0x40)) continue;
    console.log(`pattern ${n}: ${b.map((x) => (x & 0x40 ? '--' : x & 63)).join(' ')} ${b[0] & 128 ? 'loop-start ' : ''}${b[1] & 128 ? 'loop-end ' : ''}${b[2] & 128 ? 'stop' : ''}`);
  }
}
