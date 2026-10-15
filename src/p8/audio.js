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
const GAIN = 0.22;

const frac = (x) => x - Math.floor(x);
const tri = (p) => Math.abs(frac(p) * 4 - 2) - 1;

function wave(w, p, ch) {
  p = frac(p);
  switch (w) {
    case 0: return tri(p);
    case 1: return p < 0.875 ? p / 0.4375 - 1 : (1 - p) / 0.0625 - 1;     // tilted saw
    case 2: return p * 2 - 1;                                               // saw
    case 3: return p < 0.5 ? 0.75 : -0.75;                                  // square
    case 4: return p < 0.3125 ? 0.75 : -0.75;                               // pulse
    case 5: return (tri(p) * 0.6 + tri(p * 2) * 0.4);                       // organ
    case 6: return ch.noise;                                                // noise
    case 7: return (tri(p) + tri(p * 1.0198)) * 0.5;                        // phaser
  }
  return 0;
}

const pitchFreq = (pitch) => 440 * 2 ** ((pitch - 33) / 12);

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
    this.ch = Array.from({ length: 4 }, () => ({ v: new Voice(), music: false, noise: 0, noiseT: 0, lp: 0 }));
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
    let pitch = w & 63, vol = (w >> 9) & 7;
    const wf = (w >> 6) & 7, fx = (w >> 12) & 7, custom = (w >> 15) & 1;
    const pos = v.t / noteLen;
    let vf = vol / 7;
    let p = pitch;
    switch (fx) {
      case 1: p = v.prevPitch + (pitch - v.prevPitch) * pos; vf = (v.prevVol + (vol - v.prevVol) * pos) / 7; break;
      case 2: p = pitch + tri(v.elapsed / SAMPLE_RATE * 7.5) * 0.25; break;
      case 3: p = pitch * (1 - pos); break;
      case 4: vf *= pos; break;
      case 5: vf *= 1 - pos; break;
      case 6: case 7: {
        const step = (fx === 6 ? (speed <= 8 ? 2 : 4) : (speed <= 8 ? 4 : 8)) * TICK;
        const base = v.note & ~3, k = Math.floor(v.elapsed / step) & 3;
        const wa = mem[a + (base + k) * 2] | (mem[a + (base + k) * 2 + 1] << 8);
        p = wa & 63;
        break;
      }
    }
    v.t++;
    v.elapsed++;
    if (!vol && fx !== 1) { if (v.inst) v.inst = null; return 0; }
    let s;
    if (custom) {
      // The note plays sound effect 0-7 as its instrument, transposed (C-2 = as written).
      if (!v.inst || v.instNote !== v.note) {
        const keep = v.inst && fx === 1 ? v.inst : null;           // slides carry on the instrument
        v.inst = keep || new Voice();
        if (!keep) this.start(v.inst, wf);
        v.instNote = v.note;
      }
      s = this.voiceSample(v.inst, ch, p - 24 + pitchOfs, 1);
      if (v.inst.sfx < 0) { this.start(v.inst, wf); }               // instruments loop for the note's length
    } else {
      const f = pitchFreq(p + pitchOfs);
      v.phase += f / SAMPLE_RATE;
      if (v.phase > 1e6) v.phase = frac(v.phase);
      if (wf === 6) {
        // Noise: a new random level at a rate set by the pitch.
        ch.noiseT += f * 8 / SAMPLE_RATE;
        if (ch.noiseT >= 1) { ch.noiseT -= Math.floor(ch.noiseT); ch.noise = Math.random() * 1.6 - 0.8; }
      }
      s = wave(wf, v.phase, ch);
    }
    return s * vf * volScale;
  }

  // Generate `n` samples into the ring buffer.
  render(n) {
    const buf = this.buffer, mask = buf.length - 1, m = this.music;
    for (let i = 0; i < n; i++) {
      let mix = 0;
      for (let c = 0; c < 4; c++) {
        const ch = this.ch[c];
        if (ch.v.sfx < 0) continue;
        let s = this.voiceSample(ch.v, ch);
        if (ch.music) s *= m.vol;
        // A light low-pass takes the edge off the square waves.
        ch.lp += (s - ch.lp) * 0.6;
        mix += ch.lp;
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
      const out = s - this.dcIn + 0.995 * this.dcOut;
      this.dcIn = s; this.dcOut = out;
      buf[this.writePos] = out;
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
