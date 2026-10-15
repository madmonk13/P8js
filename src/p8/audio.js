// The sound: four channels playing the cart's sound effects (and music
// patterns, which are four sound effects played together), synthesised into a
// sample ring buffer that AudioOut drains.
//
// Sound effect data (68 bytes each at 0x3200): 32 notes of 16 bits (pitch 0-5,
// waveform 6-8, volume 9-11, effect 12-14, bit 15 = waveform is a custom
// instrument: sound effect 0-7), then filter flags, speed, loop start, loop end.
// Music (4 bytes per pattern at 0x3100): per channel a sound effect number
// (bit 6 = channel off) and a flag in bit 7: loop start, loop end, stop.

export const SAMPLE_RATE = 22050;
const TICK = 183;                       // samples per speed unit (1/120 s)
const GAIN = 2.2;
const HIGH_PASS = Math.exp(-2 * Math.PI * 40 / 22050);

const frac = (x) => x - Math.floor(x);

// The waveforms over one period (t in 0..1), at their relative loudness: the
// smooth waves (triangle, saws, organ) a little above the square waves.
// `u` is the unwrapped phase, for the phaser's slow sweep.
function wave(w, t, u, ch) {
  switch (w) {
    case 0: return 0.36 * (Math.abs(4 * t - 2) - 1);                          // triangle
    case 1: return 0.36 * (t < 0.9 ? 2 * t / 0.9 - 1 : 2 * (1 - t) / 0.1 - 1);  // tilted saw
    case 2: return 0.5 * (t < 0.5 ? t : t - 1);                             // saw
    case 3: return t < 0.5 ? 0.25 : -0.25;                                    // square
    case 4: return t < 1 / 3 ? 0.25 : -0.25;                                  // pulse
    case 5: return (t < 0.5 ? 3 - Math.abs(24 * t - 6) : 1 - Math.abs(16 * t - 12)) / 9;   // organ
    case 6: return ch.noise;                                                  // noise
    case 7: {                                                                 // phaser
      // Two triangle waves drifting in and out of phase at 1/128 of the pitch.
      const k = Math.abs(2 * frac(u / 128) - 1);
      const v = frac(t + 0.5 * k);
      return (Math.abs(4 * v - 2) - Math.abs(8 * t - 4)) / 6;
    }
  }
  return 0;
}

const pitchFreq = (pitch) => 440 * 2 ** ((pitch - 33) / 12);

// Sound effect byte 64: bit 0 the editor mode, then noiz (2), buzz (4), and three
// filters with levels 0-2 packed in base 3: detune (x8), reverb (x24), dampen (x72).
function decodeFilters(b) {
  return {
    noiz: (b >> 1) & 1, buzz: (b >> 2) & 1,
    detune: Math.floor(b / 8) % 3, reverb: Math.floor(b / 24) % 3, dampen: Math.floor(b / 72) % 3,
  };
}

// One sound effect playing (on a channel, or as a custom instrument under a note).
class Voice {
  constructor() { this.reset(); }
  reset() {
    this.sfx = -1;
    this.note = 0;        // note index
    this.t = 0;           // samples into the current note
    this.elapsed = 0;     // samples since the effect started
    this.phase = 0;
    this.end = 32;
    this.prevPitch = 24; this.prevVol = 0;
    this.released = false;
    this.inst = null;     // a Voice for a custom-instrument note
    this.instNote = -1;
  }
}

export class P8Audio {
  constructor(mem) {
    this.mem = mem;
    this.buffer = new Float32Array(1 << 15);
    this.readPos = 0;
    this.writePos = 0;
    this.ch = Array.from({ length: 4 }, () => ({
      v: new Voice(), music: false, noise: 0, noise1: 0, noise2: 0, noiseF: -1, noiseK: 1, noiseG: 1,
      filterByte: -1, filters: decodeFilters(0), damp: 0, damp2: 0,
      echo: new Float32Array(1024), echoPos: 0,
    }));
    this.music = { pattern: -1, start: -1, t: 0, len: 0, mask: 15, fade: 0, fadeStep: 0, vol: 1 };
    this.dcIn = 0; this.dcOut = 0;
    this.carry = 0;
  }

  // ---- control from the cart

  sfx(n, channel = -1, offset = 0, length = 32) {
    n = Math.floor(n); channel = Math.floor(channel); offset = Math.max(0, Math.floor(offset));
    if (n === -1) {                                     // stop the channel (or all)
      if (channel < 0) for (const c of this.ch) { if (!c.music) c.v.reset(); }
      else if (channel < 4) this.ch[channel].v.reset();
      return;
    }
    if (n === -2) {                                     // let a looping sound play out
      if (channel >= 0 && channel < 4) this.ch[channel].v.released = true;
      return;
    }
    if (n < 0 || n > 63) return;
    if (channel === -2) { for (const c of this.ch) if (c.v.sfx === n) c.v.reset(); return; }
    if (channel < 0 || channel > 3) {
      // A free channel, else one not used by music, else channel 0... prefer replacing the same sound.
      channel = this.ch.findIndex((c) => c.v.sfx === n && !c.music);
      if (channel < 0) channel = this.ch.findIndex((c) => c.v.sfx < 0);
      if (channel < 0) channel = this.ch.findIndex((c) => !c.music);
      if (channel < 0) channel = 3;
    }
    const c = this.ch[channel];
    c.music = false;
    this.start(c.v, n, offset, offset + Math.floor(length));
  }

  start(v, n, offset = 0, end = 32) {
    v.reset();
    v.sfx = n;
    v.note = offset;
    v.end = Math.min(32, end);
  }

  musicPlay(n, fadeMs = 0, mask = 15) {
    n = Math.floor(n);
    const m = this.music;
    if (n < 0) {
      if (fadeMs > 0 && m.pattern >= 0) { m.fadeStep = -m.vol / (fadeMs / 1000 * SAMPLE_RATE); return; }
      this.stopMusic();
      return;
    }
    this.stopMusic();
    m.mask = mask & 15 || 15;
    m.vol = fadeMs > 0 ? 0 : 1;
    m.fadeStep = fadeMs > 0 ? 1 / (fadeMs / 1000 * SAMPLE_RATE) : 0;
    m.start = -1;
    this.playPattern(n & 63);
  }

  stopMusic() {
    const m = this.music;
    m.pattern = -1;
    m.fadeStep = 0;
    for (const c of this.ch) if (c.music) { c.v.reset(); c.music = false; }
  }

  playPattern(n) {
    const m = this.music, mem = this.mem, a = 0x3100 + n * 4;
    m.pattern = n; m.t = 0;
    if (mem[a] & 0x80) m.start = n;
    // The pattern lasts as long as its leftmost non-looping sound effect (or the leftmost one at all).
    let lenNonLoop = -1, lenAny = -1;
    for (let i = 0; i < 4; i++) {
      const b = mem[a + i];
      const c = this.ch[i];
      if (b & 0x40 || !(m.mask & (1 << i))) { if (c.music) { c.v.reset(); c.music = false; } continue; }
      const s = b & 63;
      c.music = true;
      this.start(c.v, s);
      const { len, loops } = this.sfxLength(s);
      if (lenAny < 0) lenAny = len;
      if (!loops && lenNonLoop < 0) lenNonLoop = len;
    }
    m.len = lenNonLoop >= 0 ? lenNonLoop : lenAny >= 0 ? lenAny : 32 * TICK;
  }

  sfxInfo(n) {
    const a = 0x3200 + n * 68, mem = this.mem;
    return { speed: Math.max(1, mem[a + 65]), loopStart: mem[a + 66], loopEnd: mem[a + 67] };
  }
  sfxLength(n) {
    const { speed, loopStart, loopEnd } = this.sfxInfo(n);
    const loops = loopEnd > loopStart;
    const notes = loopEnd === 0 && loopStart > 0 ? loopStart : 32;
    return { len: (loops ? 32 : notes) * speed * TICK, loops };
  }

  endPattern() {
    const m = this.music, mem = this.mem, a = 0x3100 + m.pattern * 4;
    if (mem[a + 2] & 0x80) { this.stopMusic(); return; }
    if (mem[a + 1] & 0x80) { this.playPattern(m.start >= 0 ? m.start : 0); return; }
    if (m.pattern + 1 > 63) { this.stopMusic(); return; }
    // Running into an empty pattern (all channels off) ends the music.
    const next = m.pattern + 1, b = 0x3100 + next * 4;
    if ((mem[b] & 0x40) && (mem[b + 1] & 0x40) && (mem[b + 2] & 0x40) && (mem[b + 3] & 0x40)) { this.stopMusic(); return; }
    this.playPattern(next);
  }

  // ---- status (stat())

  channelSfx(i) { const v = this.ch[i]?.v; return v && v.sfx >= 0 ? v.sfx : -1; }
  channelNote(i) { const v = this.ch[i]?.v; return v && v.sfx >= 0 ? v.note : -1; }

  // ---- synthesis

  // One sample of a voice playing sound effect v.sfx, or undefined once it ends.
  // pitchOfs/volScale apply when it's a custom instrument under another note.
  voiceSample(v, ch, pitchOfs = 0, volScale = 1) {
    if (v.sfx < 0) return 0;
    const mem = this.mem, a = 0x3200 + v.sfx * 68;
    const speed = Math.max(1, mem[a + 65]), loopStart = mem[a + 66], loopEnd = mem[a + 67];
    const noteLen = speed * TICK;
    if (v.t >= noteLen) {
      v.t -= noteLen;
      const w0 = mem[a + v.note * 2] | (mem[a + v.note * 2 + 1] << 8);
      v.prevPitch = w0 & 63; v.prevVol = (w0 >> 9) & 7;
      v.note++;
      if (loopEnd > loopStart && !v.released && v.note >= loopEnd) v.note = loopStart;
      const stop = loopEnd === 0 && loopStart > 0 ? loopStart : v.end;
      if (v.note >= Math.min(32, stop)) { v.reset(); return 0; }
    }
    const w = mem[a + v.note * 2] | (mem[a + v.note * 2 + 1] << 8);
    const pitch = w & 63, vol = (w >> 9) & 7;
    const wf = (w >> 6) & 7, fx = (w >> 12) & 7, custom = (w >> 15) & 1;
    const pos = v.t / noteLen;
    let vf = vol / 7;
    let f = pitchFreq(pitch + pitchOfs);
    switch (fx) {
      case 1: {                                   // slide: from the last note's frequency and volume
        const f0 = pitchFreq(v.prevPitch + pitchOfs);
        f = f0 + (f - f0) * pos;
        vf = (v.prevVol + (vol - v.prevVol) * pos) / 7;
        break;
      }
      case 2: {                                   // vibrato: a quarter semitone either way at 7.5 Hz
        const k = Math.abs(frac(7.5 * v.elapsed / SAMPLE_RATE) - 0.5) - 0.25;
        f *= 1 + (2 ** (1 / 12) - 1) * k;
        break;
      }
      case 3: f *= 1 - pos; break;                // drop
      case 4: vf *= pos; break;                   // fade in
      case 5: vf *= 1 - pos; break;               // fade out
      case 6: case 7: {                           // arpeggio over the note's group of four
        const step = (fx === 6 ? (speed <= 8 ? 2 : 4) : (speed <= 8 ? 4 : 8)) * TICK;
        const base = v.note & ~3, k = Math.floor(v.elapsed / step) & 3;
        const wa = mem[a + (base + k) * 2] | (mem[a + (base + k) * 2 + 1] << 8);
        f = pitchFreq((wa & 63) + pitchOfs);
        break;
      }
    }
    v.t++;
    v.elapsed++;
    if (!vf) { if (v.inst && fx !== 1) v.inst = null; return 0; }
    let s;
    if (custom) {
      // The note plays sound effect 0-7 as its instrument, transposed (C-2 = as written).
      if (!v.inst || v.instNote !== v.note) {
        const keep = v.inst && fx === 1 ? v.inst : null;           // slides carry on the instrument
        v.inst = keep || new Voice();
        if (!keep) this.start(v.inst, wf);
        v.instNote = v.note;
      }
      const semis = f > 1 ? 12 * Math.log2(f / 440) + 33 : -60;      // the note's (effected) pitch
      s = this.voiceSample(v.inst, ch, semis - 24, 1);
    } else {
      const flags = ch.filters;
      v.phase += f / SAMPLE_RATE;
      if (v.phase >= 128 * 4096) v.phase -= 128 * 4096;              // keeps the phaser's 1/128 cycle whole
      const t = frac(v.phase);
      if (wf === 6) {
        // Noise: white noise through a low-pass that opens up with the pitch (the noiz filter: pure white).
        const white = Math.random() * 2 - 1;
        {
          // The pitch sets a two-stage low-pass: low notes rumble (explosions), high
          // ones hiss. The gain keeps the level about even as the filter closes. The
          // noiz filter's whiter noise opens the filter further, but still follows the pitch.
          const open = flags.noiz ? 10 : 4;
          if (ch.noiseF !== f * open) {
            ch.noiseF = f * open;
            const fc = Math.min(10000, Math.max(20, f * open));
            const k = 1 - Math.exp(-2 * Math.PI * fc / SAMPLE_RATE), r = (1 - k) ** 2;
            ch.noiseK = k;
            ch.noiseG = Math.min(12, 0.22 / Math.sqrt(k ** 4 * (1 + r) / (1 - r) ** 3 / 3) * Math.sqrt(1 / 3));
          }
          ch.noise1 += (white - ch.noise1) * ch.noiseK;
          ch.noise2 += (ch.noise1 - ch.noise2) * ch.noiseK;
          ch.noise = ch.noise2 * ch.noiseG;
        }
      }
      s = wave(wf, t, v.phase, ch);
      if (flags.detune) {
        // A second voice, slightly (or, at level 2, an octave and a bit) off.
        v.phase2 = (v.phase2 || 0) + f * (flags.detune === 1 ? 1.006 : 2.01) / SAMPLE_RATE;
        if (v.phase2 >= 128 * 4096) v.phase2 -= 128 * 4096;
        s = (s + wave(wf, frac(v.phase2), v.phase2, ch) * (flags.detune === 1 ? 1 : 0.5)) * 0.6;
      }
      // Buzz: a sawtooth edge mixed in.
      if (flags.buzz && wf !== 6) s = s * 0.85 + 0.653 * (t < 0.5 ? t : t - 1) * 0.2;
    }
    return s * vf * volScale;
  }

  // A channel's sound effect filters: dampen (a low-pass) and reverb (an echo).
  effects(ch, s) {
    const fl = ch.filters;
    if (fl.dampen) {
      const k = fl.dampen === 1 ? 0.3 : 0.15;     // two-stage low-pass at about 1.3 kHz / 570 Hz
      ch.damp += (s - ch.damp) * k;
      ch.damp2 += (ch.damp - ch.damp2) * k;
      s = ch.damp2;
    }
    const e = ch.echo, mask = e.length - 1;
    if (fl.reverb) {
      // Echoes 2 or 4 ticks back (about 17 or 33 ms).
      const d = fl.reverb === 1 ? 366 : 732;
      if (e.length < 1024) ch.echo = new Float32Array(1024);
      const out = s + e[(ch.echoPos - d) & mask] * 0.45;
      e[ch.echoPos] = out;
      ch.echoPos = (ch.echoPos + 1) & mask;
      return out;
    }
    if (e[ch.echoPos]) e.fill(0);
    return s;
  }

  // Generate `n` samples into the ring buffer.
  render(n) {
    const buf = this.buffer, mask = buf.length - 1, m = this.music;
    for (let i = 0; i < n; i++) {
      let mix = 0;
      for (let c = 0; c < 4; c++) {
        const ch = this.ch[c];
        if (ch.v.sfx < 0) continue;
        const a = 0x3200 + ch.v.sfx * 68;
        if (ch.filterByte !== this.mem[a + 64]) ch.filters = decodeFilters(ch.filterByte = this.mem[a + 64]);
        let s = this.voiceSample(ch.v, ch);
        if (ch.music) s *= m.vol;
        s = this.effects(ch, s);
        mix += s;
      }
      if (m.pattern >= 0) {
        if (m.fadeStep) {
          m.vol += m.fadeStep;
          if (m.vol >= 1) { m.vol = 1; m.fadeStep = 0; }
          if (m.vol <= 0) { this.stopMusic(); }
        }
        if (m.pattern >= 0 && ++m.t >= m.len) this.endPattern();
      }
      const s = mix * GAIN;
      // A gentle high-pass (about 40 Hz) keeps DC and sub-bass rumble out, and leaves kicks their weight.
      const out = s - this.dcIn + HIGH_PASS * this.dcOut;
      this.dcIn = s; this.dcOut = out;
      // Four loud channels can pass full scale: round off just the top of the peaks rather than clip.
      const mag = Math.abs(out);
      buf[this.writePos] = mag > 0.85 ? Math.sign(out) * (0.85 + 0.15 * Math.tanh((mag - 0.85) / 0.15)) : out;
      this.writePos = (this.writePos + 1) & mask;
      if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
    }
  }

  // One frame's worth of samples at `fps`.
  frame(fps) {
    const want = SAMPLE_RATE / fps + this.carry;
    const n = Math.floor(want);
    this.carry = want - n;
    this.render(n);
  }

  reset() {
    this.stopMusic();
    for (const c of this.ch) { c.v.reset(); c.music = false; }
  }

  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }

  // Fallback output path (ScriptProcessor): resample into `out` at `outRate`.
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1, step = SAMPLE_RATE / outRate;
    if (this.available() > SAMPLE_RATE * 0.075) this.readPos = (this.writePos - Math.floor(SAMPLE_RATE * 0.035)) & mask;
    let pos = this.frac || 0, last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos; this.last = last;
  }
}
