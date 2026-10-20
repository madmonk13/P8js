import { Pico8 } from './p8/pico8.js';
import { parseCart } from './p8/cart.js';
import { Screen2D } from './render/screen2d.js';
import { Input, controlLegend } from './input.js';
import { InputMode } from './input-mode.js';
import { AudioOut } from './audio-out.js';
import { store, readRomFile, withLoading, toast } from './shared.js';
import { library, renderLibrary } from './library.js';
import { TouchControls } from './touch.js';
import { registerServiceWorker } from './sw-update.js';
import { setupInstall } from './install.js';

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  leftHanded: false,
  eightWay: true,
  dpadSize: 140,
  haptics: true,
  hints: false,      // the touch hints (Move / Fire cards); off by default
  zones: true,       // outline each control's area
  zoneOpacity: 25,   // percent
  zoneOverlap: 25,   // percent: how far the control zones reach over the picture
  sound: true,
  volume: 70,        // percent
  hintsFor: 'auto',  // which controls' hints to show: 'auto' (the input last used), 'touch', 'keys' or 'pad'
};

const p8 = new Pico8();
const input = new Input();
const audio = new AudioOut(p8.audio);
const screen2d = new Screen2D($('screen2d'));
const touch = new TouchControls({
  surface: $('surface'), dpad: $('dpad'), ripples: $('ripples'),
  buttons: [$('menuBtn'), $('pauseBtn'), $('cartBtn')],
});
input.sources.push(touch);

const settings = { ...DEFAULTS, ...(store.get('mobile') || {}) };
// Touch hints became off by default (the zone outlines now introduce the controls); turn
// them off once for settings saved before that.
if (!settings.hintsOffByDefault) { settings.hints = false; settings.hintsOffByDefault = true; store.set('mobile', settings); }
// Touch, keyboard or gamepad: which hints to show (the zone outlines, or a list of the keys or buttons).
const inputMode = new InputMode({ storageKey: 'P8js.inputMode' });
inputMode.override = settings.hintsFor;
inputMode.onChange = () => renderControls();
const state = { romId: null, menuOpen: false, paused: false, loaded: false, flipXO: false };

// Per-cart preferences (for now, whether X and O swap places), kept with the cart's library id.
const PREFS = 'cartprefs:';
function cartPrefs(id) { return (id && store.get(PREFS + id)) || {}; }

// Block page-level zoom/scroll gestures; this is a full-screen app.
for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest('.sheet')) e.preventDefault();
}, { passive: false });

// ---------------------------------------------------------------- audio

// iOS only (re)starts audio inside a user gesture, and only some events count
// (touchend and click, not always pointer events whose default was prevented),
// so try on all of them. Capture phase so nothing can stop them first.
const unlockAudio = () => { if (settings.sound) audio.start(); };
for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
  window.addEventListener(ev, unlockAudio, { capture: true, passive: true });
}
// Coming back from the background often leaves audio suspended or interrupted.
document.addEventListener('visibilitychange', () => { if (!document.hidden && settings.sound) audio.resume(); });

// ---------------------------------------------------------------- saves

// Cart data: the 256 bytes a cart keeps with cartdata() / dset(), saved under the
// cart's own id string (so carts that share an id share it, as on PICO-8). A cart's
// running state (its Lua variables) can't be saved, so there's no resume: a cart
// starts fresh each time it's opened.
const CARTDATA = 'cartdata:';
p8.onCartdata = (id) => {
  const text = store.getRaw(CARTDATA + id);
  if (!text) return null;
  try {
    const bin = atob(text), bytes = new Uint8Array(256);
    for (let i = 0; i < Math.min(256, bin.length); i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch { return null; }
};
p8.onCartdataSave = (id, bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  store.trySet(CARTDATA + id, btoa(bin));
};
document.addEventListener('visibilitychange', () => { if (document.hidden) p8.saveCartdata(true); });
window.addEventListener('pagehide', () => p8.saveCartdata(true));
p8.onLog = (msg, err) => {
  console.log(`[cart] ${msg}`);
  if (err) { console.error(err); toast(`Cart stopped: ${msg}`); }
};

// ---------------------------------------------------------------- ROMs

// Load a cart and record it in the collection.
async function loadRom(bytes, name) {
  if (state.paused) setPaused(false);
  const cart = await parseCart(bytes);
  p8.load(cart);
  state.loaded = true;
  const label = bytes[0] === 0x89 ? '.p8.png' : '.p8';
  const res = library.add(name, bytes, label);
  if (!res.stored) toast('Storage is full, so this cart won\'t be saved. Remove some to make room.');
  state.romId = res.id;
  state.flipXO = !!cartPrefs(res.id).flipXO;
  state.gameName = gameTitle(name);
  showBooting(state.gameName);
  introduceZones();
  applyControls();
  if (res.stored) library.setLast(res.id);
  refreshLibrary();
}

function refreshLibrary() {
  renderLibrary($('library'), {
    currentId: state.romId,
    onPlay: (entry) => playEntry(entry),
    onRemove: (entry) => {
      library.remove(entry.id);
      store.remove(PREFS + entry.id);
      refreshLibrary();
    },
  });
  const n = library.list().length;
  $('libraryInfo').textContent = n
    ? `${n} saved · ${Math.ceil(library.usage() / 1024)} KB on this device`
    : 'Add a PICO-8 cart (.p8 or .p8.png, or zipped). Carts you add are saved on this device.';
}

async function playEntry(entry) {
  try {
    await withLoading(entry.name, async () => {
      const bytes = library.get(entry.id);
      if (!bytes) throw new Error('its saved data is missing');
      await loadRom(bytes, entry.name);
    });
    closeMenu();
    drawNow();
  } catch (err) {
    toast(`Couldn't load ${entry.name}: ${err.message}`);
  }
}

async function loadFile(file) {
  try {
    await withLoading(file.name, async () => {
      const { bytes, name } = await readRomFile(file);
      await loadRom(bytes, name);
    });
    closeMenu();
    drawNow();
  } catch (err) {
    toast(`Couldn't load ${file.name}: ${err.message}`);
  }
}

$('loadBtn').addEventListener('click', () => $('romFile').click());
$('romFile').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });

// ---------------------------------------------------------------- menu

// Settings and the cartridge list are full-screen takeovers. The game pauses and
// the touch controls go inert while either is open.
const SHEETS = { menu: 'closeMenu', cartsMenu: 'closeCarts' }; // backdrop id → close button id

function openSheet(id) {
  for (const other of Object.keys(SHEETS)) $(other).hidden = other !== id;
  state.menuOpen = true;
  touch.releaseAll();
  touch.enabled = false;
  audio.setMuted(true);
}
function closeMenu() {
  state.menuOpen = false;
  touch.enabled = !state.paused;
  audio.setMuted(!settings.sound || state.paused);
  for (const id of Object.keys(SHEETS)) $(id).hidden = true;
}
// Pause: stops the game (and its sound) until resumed from the bar button,
// the veil over the game, or P on a keyboard.
function setPaused(paused) {
  state.paused = paused;
  padStartHeld = true;
  if (paused) hideBooting();
  $('pausedGame').textContent = state.gameName || '';
  // The control zones come back up to full strength while paused and fade down again on resume.
  document.body.classList.toggle('zones-intro', paused);
  document.body.classList.toggle('paused', paused);
  $('paused').hidden = !paused;
  $('pauseBtn').setAttribute('aria-pressed', String(paused));
  $('pauseBtn').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  if (paused) touch.releaseAll();
  touch.enabled = !paused && !state.menuOpen;
  audio.setMuted(paused || state.menuOpen || !settings.sound);
}
// Open on release rather than 'click': mobile browsers can drop the click when
// the finger shifts slightly or another finger is already on the screen.
$('pauseBtn').addEventListener('pointerup', (e) => { e.preventDefault(); setPaused(!state.paused); });
$('pauseBtn').addEventListener('click', (e) => { if (e.detail === 0) setPaused(!state.paused); }); // keyboard
$('paused').addEventListener('pointerup', (e) => { e.preventDefault(); setPaused(false); });
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyP' || e.metaKey || e.ctrlKey || e.altKey || state.menuOpen) return;
  e.preventDefault();
  setPaused(!state.paused);
});

for (const [btn, sheet] of [['menuBtn', 'menu'], ['cartBtn', 'cartsMenu']]) {
  $(btn).addEventListener('pointerup', (e) => { e.preventDefault(); openSheet(sheet); });
  $(btn).addEventListener('click', (e) => { if (e.detail === 0) openSheet(sheet); }); // keyboard
}
for (const [sheet, close] of Object.entries(SHEETS)) {
  $(close).addEventListener('click', closeMenu);
  // After rotating, iOS can hit-test a full-screen sheet against its old layout,
  // so the close button (which moves) stops getting taps. Judge by position instead.
  $(sheet).addEventListener('pointerup', (e) => {
    const r = $(close).getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) closeMenu();
  });
}

function save() { store.set('mobile', settings); }

function applyControls() {
  queueMicrotask(renderControls);   // once the controller below is settled
  document.body.classList.toggle('lefty', settings.leftHanded);
  touch.leftHanded = settings.leftHanded;
  input.flipXO = state.flipXO;
  $('flipXO').checked = state.flipXO;
  const [top, bottom] = state.flipXO ? ['O', 'X'] : ['X', 'O'];
  document.querySelector('.box.a b').textContent = top;
  document.querySelector('.box.b b').textContent = bottom;
  $('hintXO').textContent = `${top} · ${bottom}`;
  $('hintXOText').textContent = `Top half is ${top}, bottom half is ${bottom}`;
  touch.eightWay = settings.eightWay;
  touch.haptics = settings.haptics;
  touch.setSize(settings.dpadSize);
  $('dpadSizeVal').textContent = `${settings.dpadSize}px`;
  const ctrl = settings.eightWay ? '8' : '4';
  for (const b of document.querySelectorAll('[data-ctrl]')) b.classList.toggle('active', b.dataset.ctrl === ctrl);
  document.body.classList.toggle('show-zones', settings.zones);
  document.documentElement.style.setProperty('--zone-opacity', settings.zoneOpacity / 100);
  $('zoneOpacityVal').textContent = `${settings.zoneOpacity}%`;
  $('zoneOpacity').disabled = !settings.zones;
  $('zoneOverlapVal').textContent = `${settings.zoneOverlap}%`;
}

function syncMenu() {
  $('leftHanded').checked = settings.leftHanded;
  $('dpadSize').value = settings.dpadSize;
  $('haptics').checked = settings.haptics;
  $('hints').checked = settings.hints;
  $('zones').checked = settings.zones;
  $('zoneOpacity').value = settings.zoneOpacity;
  $('zoneOverlap').value = settings.zoneOverlap;
  $('sound').checked = settings.sound;
  $('volume').value = settings.volume;
  applySound();
  $('hapticsRow').hidden = !navigator.vibrate;
  applyControls();
}

// The controls for a keyboard or gamepad: the card shown as a game starts and while paused, and
// the list in Settings. Touch players have the zone outlines instead.
const MODE_NAMES = { touch: 'touch', keys: 'keyboard', pad: 'gamepad' };
function renderControls() {
  const mode = inputMode.mode;
  const rows = mode !== 'touch' ? controlLegend(mode) : [];
  for (const id of ['keyHelpList', 'controlList']) {
    const dl = $(id);
    dl.textContent = '';
    for (const [keys, what] of rows) {
      dl.append(Object.assign(document.createElement('dt'), { textContent: keys }), Object.assign(document.createElement('dd'), { textContent: what }));
    }
  }
  for (const b of $('hintsFor').children) b.classList.toggle('active', b.dataset.mode === settings.hintsFor);
  $('hintsForInfo').textContent = settings.hintsFor === 'auto'
    ? `Showing ${MODE_NAMES[mode]} hints: Auto follows whichever you last used.`
    : `Always showing ${MODE_NAMES[mode]} hints.`;
}
$('hintsFor').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.hintsFor = b.dataset.mode; save();
  inputMode.override = settings.hintsFor;
  renderControls();
});

let hintTimer = 0;
function flashHints(ms) {
  if (!settings.hints) return;
  document.body.classList.add('show-hints');
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => document.body.classList.remove('show-hints'), ms);
}

$('flipXO').addEventListener('change', (e) => {
  state.flipXO = e.target.checked;
  if (state.romId) store.set(PREFS + state.romId, { ...cartPrefs(state.romId), flipXO: state.flipXO });
  applyControls(); flashHints(2500);
});
$('leftHanded').addEventListener('change', (e) => {
  settings.leftHanded = e.target.checked; applyControls(); layout2D(); save(); flashHints(2500);
});
for (const b of document.querySelectorAll('[data-ctrl]')) {
  b.addEventListener('click', () => { settings.eightWay = b.dataset.ctrl === '8'; applyControls(); save(); });
}
$('zones').addEventListener('change', (e) => { settings.zones = e.target.checked; applyControls(); save(); });
$('zoneOpacity').addEventListener('input', (e) => { settings.zoneOpacity = +e.target.value; applyControls(); save(); });
$('zoneOverlap').addEventListener('input', (e) => { settings.zoneOverlap = +e.target.value; applyControls(); layout2D(); save(); });
$('dpadSize').addEventListener('input', (e) => { settings.dpadSize = +e.target.value; applyControls(); save(); });
$('haptics').addEventListener('change', (e) => {
  settings.haptics = e.target.checked; applyControls(); save();
  if (settings.haptics && navigator.vibrate) navigator.vibrate(15);
});
$('hints').addEventListener('change', (e) => {
  settings.hints = e.target.checked; save();
  if (settings.hints) flashHints(2500); else document.body.classList.remove('show-hints');
});
function applySound() {
  audio.setVolume(settings.volume / 100);
  $('volumeVal').textContent = `${settings.volume}%`;
  $('volume').disabled = !settings.sound;
}
$('sound').addEventListener('change', (e) => {
  settings.sound = e.target.checked; save();
  if (settings.sound) audio.start();
  audio.setMuted(!settings.sound || state.menuOpen);
  applySound();
});
$('volume').addEventListener('input', (e) => { settings.volume = +e.target.value; applySound(); save(); });
$('volume').addEventListener('change', () => audio.preview());
$('powerBtn').addEventListener('click', () => {
  if (!state.loaded) return;
  p8.reset(); closeMenu();
});

// A game's display name: its file name without the extension.
function gameTitle(name) { return (name || '').replace(/\.zip$/i, '').replace(/\.p8(\.png)?$/i, '').replace(/\.png$/i, ''); }

// Loading: a card naming the cart as it starts; it fades after 3 seconds, or on a tap.
let bootTimer = 0;
function showBooting(title) {
  $('bootingGame').textContent = title;
  const el = $('booting');
  el.hidden = true; void el.offsetWidth; el.hidden = false;      // restart the fade
  clearTimeout(bootTimer);
  bootTimer = setTimeout(hideBooting, 3000);
}
function hideBooting() { clearTimeout(bootTimer); $('booting').hidden = true; }
$('booting').addEventListener('pointerdown', hideBooting);

// When a game loads, the control zones show at full strength over a dark backing; the
// first touch (or key / gamepad press) fades them to the chosen opacity and the backing away.
function introduceZones() { document.body.classList.add('zones-intro'); }

// The touch-zone hints and the zone introduction fade once the player starts playing,
// whether by touch, mouse, keyboard or gamepad.
function dismissHints() {
  document.body.classList.remove('zones-intro');
  if (document.body.classList.contains('show-hints')) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => document.body.classList.remove('show-hints'), 600);
  }
}
touch.onTouch = dismissHints;
input.onActivity = dismissHints;

// ---------------------------------------------------------------- display

// Safe-area insets in px, measured from a probe that uses env().
const probe = document.createElement('div');
probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
  'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
document.body.appendChild(probe);

function layout2D() {
  const c = $('screen2d');
  const ps = getComputedStyle(probe);
  const sl = parseFloat(ps.paddingLeft) || 0, sr = parseFloat(ps.paddingRight) || 0;
  const st = parseFloat(ps.paddingTop) || 0, sb = parseFloat(ps.paddingBottom) || 0;
  const W = window.innerWidth, H = window.innerHeight;
  const pad = 10;
  const aspect = 1;
  const barH = $('bar').offsetHeight;
  const availW = W - sl - sr - pad * 2;
  const portrait = H > W;
  // Portrait sits below the bar and keeps the lower part of the screen free for
  // thumbs. Landscape uses the full height, running up behind the bar.
  const availH = portrait ? (H - barH - sb) * 0.6 : H - st - sb;
  const w = Math.max(80, Math.min(availW, availH * aspect));
  const h = w / aspect;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  c.style.left = `${sl + pad + (availW - w) / 2}px`;
  const top = portrait ? barH + 4 : st + (availH - h) / 2;
  c.style.top = `${top}px`;
  const left = sl + pad + (availW - w) / 2;
  layoutZones(portrait, { left, top, right: left + w, bottom: top + h, w, h });
}

// The control zones keep mostly clear of the picture: they reach over its
// edge by the overlap setting's share of its size. In portrait the zones sit
// in the band below the picture (starting that far up it), the button side
// split there with A on top and B below; above the band still counts as A.
// In landscape A takes the top half and B the bottom, and the outlines stop
// short of the middle line where the picture is.
const MIN_ZONE = 80;   // px: a landscape zone never gets narrower than this
function layoutZones(portrait, pic) {
  const sr = $('surface').getBoundingClientRect(), style = $('surface').style;
  const k = settings.zoneOverlap / 100, mid = sr.left + sr.width / 2;
  document.body.classList.toggle('portrait', portrait);
  if (portrait) {
    const band = Math.max(sr.top, pic.bottom - pic.h * k), split = (band + sr.bottom) / 2;
    touch.splitY = split;
    style.setProperty('--band-top', `${band - sr.top}px`);
    style.setProperty('--split', `${split - sr.top}px`);
    style.setProperty('--left-inner', '0px');
    style.setProperty('--right-inner', '0px');
  } else {
    // How far each side's zone stops short of the middle line.
    const room = sr.width / 2 - MIN_ZONE, reach = (pic.w / 2) * k;
    const leftInner = Math.min(room, Math.max(0, mid - (pic.left + reach)));
    const rightInner = Math.min(room, Math.max(0, (pic.right - reach) - mid));
    touch.splitY = sr.top + sr.height / 2;
    style.setProperty('--split', `${sr.height / 2}px`);
    style.setProperty('--left-inner', `${leftInner}px`);
    style.setProperty('--right-inner', `${rightInner}px`);
  }
}
// Rotating can leave iOS with the page scrolled or zoomed a little, which shifts
// where taps land relative to what's drawn. Snap back after every resize, and
// again once the rotation animation has settled.
function onViewportChange() {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  if (state.menuOpen && innerWidth > innerHeight) document.querySelector('.settings-sheet').scrollTop = 0;
  layout2D();
}
let settleTimer = 0;
function onRotate() {
  onViewportChange();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(onViewportChange, 350);
}
window.addEventListener('resize', onRotate);
window.addEventListener('orientationchange', onRotate);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onRotate);

function drawNow() { screen2d.draw(p8.frame); }

// ---------------------------------------------------------------- loop

// A gamepad's Start button resumes a paused game (once it's been let go of since the pause).
let padStartHeld = true;
function resumeFromPad() {
  const pad = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
  const down = !!(pad && pad.buttons[9] && pad.buttons[9].pressed);
  if (down && !padStartHeld) { setPaused(false); input.padStartHeld = true; }
  padStartHeld = down;
}

let acc = 0, lastTime = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  const running = state.loaded && !state.menuOpen && !state.paused && !document.hidden;
  // The pause button only means something with a game loaded.
  const pauseBtn = $('pauseBtn');
  if (pauseBtn.disabled === state.loaded) pauseBtn.disabled = !state.loaded;

  if (running) {
    acc += dt;
    let ran = 0;
    // Steps of 1/60 second; the cart runs at 30 or 60 frames a second within them.
    while (acc >= 1 / 60 && ran < 4) {
      p8.buttons = input.read();
      acc -= 1 / 60;
      p8.step();
      ran++;
    }
    if (ran === 4) acc = 0;
    audio.flush();
    if (ran) drawNow();
  } else {
    acc = 0;
    if (state.paused && !state.menuOpen) resumeFromPad();
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- boot

(async () => {
  syncMenu();
  audio.setMuted(!settings.sound);
  const lastId = library.lastId();
  const last = lastId ? library.entry(lastId) : null;
  const bytes = last && library.get(last.id);
  if (bytes) {
    try {
      await withLoading(last.name, async () => loadRom(bytes, last.name));
    } catch (err) {
      toast(`Couldn't load ${last.name}: ${err.message}`);
    }
  } else {
    $('loading').classList.remove('show');
  }
  refreshLibrary();
  if (!state.loaded) openSheet('cartsMenu');     // first run: ask for a cart
  layout2D();
  flashHints(0);
  requestAnimationFrame(tick);
})();

window.p8 = p8;
window.touch = touch;
window.input = input;
window.audio = audio;

// Offline support: the service worker (sw.js, written by tools/build-sw.mjs)
// caches the app so it runs without a network once installed, and a new
// version shows an update screen while it installs. Browsers only allow it on
// https or localhost.
registerServiceWorker('P8js');
setupInstall($('installBtn'), (msg) => toast(msg, { info: true }));
