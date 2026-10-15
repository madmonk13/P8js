# P8js

A touch-first player for [PICO-8](https://www.lexaloffle.com/pico-8.php) carts on phones and
desktop, in plain JavaScript with no dependencies. It's a sibling of 6502js (Atari 2600), 2A03js
(NES), SM83js (Game Boy) and z80js (arcade), and shares their app shell: gesture controls, a saved
cart library, pause, and an installable web app.

**Play it:** [madmonk13.github.io/P8js](https://madmonk13.github.io/P8js/)

P8js is not PICO-8 and isn't affiliated with Lexaloffle. It's an independent runtime for carts
made with it: it reads `.p8` and `.p8.png` files and runs their Lua. Its font and sound synthesis
are its own designs, so carts look and sound close to, not exactly like, the real thing.

## Running

```bash
npm start
```

Then open http://localhost:2608 and add a `.p8` or `.p8.png` cart (zipped is fine). No carts are
included.

## Controls

| Touch | Keyboard | Gamepad | PICO-8 |
| --- | --- | --- | --- |
| Drag on the d-pad side | Arrows / WASD | D-pad, left stick | ⬅️ ➡️ ⬆️ ⬇️ |
| Bottom of the button side | Z, C, N | Bottom / left face button | 🅾️ (O) |
| Top of the button side | X, V, M | Right / top face button | ❎ (X) |

P pauses. Settings are behind the gear button.

## How it works

- **Carts** (`src/p8/cart.js`): `.p8` text sections, and `.p8.png` pictures (the cart in the low
  bits of each pixel, decoded without the browser's colour handling). Code compressed in either
  the old format or PXA is unpacked.
- **Lua** (`src/p8/lua.js`, `lua-runtime.js`): the cart's Lua, in PICO-8's dialect (`+=`, `!=`,
  `\`, the bitwise operators, one-line `if (...)`, `?`, peek operators, glyph names), compiled to
  JavaScript. Each function is compiled twice: a plain version, and a generator version that runs
  inside coroutines so `yield()` can suspend a whole call chain. Numbers are 16.16 fixed point,
  wrapping and truncating as on PICO-8.
- **Machine** (`src/p8/pico8.js`): 64K of memory with the usual map (sprites, map, flags, music,
  sound, draw state, screen), drawing, text, input, memory and table functions, coroutines and
  cart data.
- **Sound** (`src/p8/audio.js`): the eight waveforms, the note effects, custom instruments, and
  music patterns, synthesised at 22,050 Hz.

`node tools/run-cart.mjs cart.p8 [frames]` runs a cart headless and reports errors and timing.

## Saves

Carts that use `cartdata()` keep their data on the device, under the cart's own id. A cart's
running state can't be saved, so carts start fresh each time they're opened rather than resuming.

## Not supported (yet)

The pause menu and `menuitem()`, mouse and keyboard (devkit) input, the `\^` print commands beyond
the basics, `\a` audio in print, screen modes (`0x5f2c`), sound filters (noiz, buzz, detune,
reverb, dampen), multi-cart `load()`, and the second player.

## Offline and install

The app is a PWA: open it once while online and a service worker (`sw.js`) caches it, so it then
starts and plays without a network. `sw.js` is generated: `npm start` rebuilds it, or run
`npm run sw` after changing files, and commit it with them. Service workers only run on **https**
or **localhost**.
