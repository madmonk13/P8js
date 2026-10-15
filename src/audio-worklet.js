// Audio-thread side of AudioOut: receives sound samples from the main thread
// after each emulated frame, resamples them to the output rate, and keeps the
// queue short so sound stays close to the picture.

// Resampling uses a Lanczos (windowed sinc) kernel over 8 input samples, which
// keeps the treble that straight-line interpolation would roll off.
const TAPS = 8, HALF = TAPS / 2, PHASES = 256;
const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const KERNEL = new Float32Array(PHASES * TAPS);
for (let p = 0; p < PHASES; p++) {
  const frac = p / PHASES;
  let sum = 0;
  for (let k = 0; k < TAPS; k++) {
    const x = k - (HALF - 1) - frac;
    sum += KERNEL[p * TAPS + k] = Math.abs(x) < HALF ? sinc(x) * sinc(x / HALF) : 0;
  }
  for (let k = 0; k < TAPS; k++) KERNEL[p * TAPS + k] /= sum;
}

class SoundOutput extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    const rate = processorOptions.rate;
    this.step = rate / sampleRate;
    this.buf = new Float32Array(1 << 14);
    this.mask = this.buf.length - 1;
    this.w = 0; this.r = 0; this.frac = 0; this.last = 0;
    // Enough queued to ride out frame-timing jitter on the main thread, and a
    // ceiling past which we skip ahead instead of letting latency build up.
    this.target = Math.round(rate * 0.035);
    this.ceiling = Math.round(rate * 0.075);
    this.beat = 0;
    this.starved = true;      // wait for a queue before the first sound
    this.starves = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.r = this.w; return; }
      const s = e.data, buf = this.buf, mask = this.mask;
      for (let i = 0; i < s.length; i++) {
        buf[this.w] = s[i];
        this.w = (this.w + 1) & mask;
        if (this.w === this.r) this.r = (this.r + 1) & mask;
      }
    };
  }

  available() { return (this.w - this.r) & this.mask; }

  process(_, outputs) {
    const out = outputs[0][0], buf = this.buf, mask = this.mask;
    if (this.available() > this.ceiling) this.r = (this.w - this.target) & mask;
    let pos = this.frac, last = this.last;
    for (let i = 0; i < out.length; i++) {
      // After running dry, wait for a proper queue before starting again, rather than
      // playing each sample the moment it lands (which chops the sound into fragments).
      if (this.starved) {
        if (this.available() >= this.target) this.starved = false;
        else { out[i] = last *= 0.995; continue; }
      }
      if (this.available() <= TAPS) { this.starved = true; this.starves++; out[i] = last *= 0.995; continue; }
      // Output at r + pos, from samples r-3 .. r+4.
      const kb = Math.min(PHASES - 1, Math.floor(pos * PHASES)) * TAPS, base = this.r - (HALF - 1);
      let v = 0;
      for (let k = 0; k < TAPS; k++) v += buf[(base + k) & mask] * KERNEL[kb + k];
      last = out[i] = v;
      pos += this.step;
      while (pos >= 1 && this.available() > TAPS) { pos -= 1; this.r = (this.r + 1) & mask; }
      if (pos >= 1) pos = 0.999;
    }
    this.frac = pos; this.last = last;
    // Heartbeat about four times a second so the main thread can spot a stall
    // (it carries the count of times the queue ran dry).
    if ((this.beat += out.length) >= sampleRate / 4) { this.beat = 0; this.port.postMessage(this.starves); }
    return true;
  }
}

registerProcessor('sound-output', SoundOutput);
