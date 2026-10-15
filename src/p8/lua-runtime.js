// Lua values and operators for code compiled by lua.js.
//
// Numbers are PICO-8's 16.16 fixed point, kept as JS numbers that are always
// a multiple of 1/65536 in -32768..32767.99998: results of + - * / wrap and
// truncate the way the fixed-point hardware would.

export class LuaError extends Error {
  constructor(msg, value) { super(msg); this.value = value; }
}

// Several values from a function call or "...". A single value is never wrapped.
export class Multi {
  constructor(v) { this.v = v; }
}
export const $M = (arr) => (arr.length === 1 ? arr[0] : new Multi(arr));
export const $first = (m) => (m instanceof Multi ? m.v[0] : m);
export const $spread = (m) => (m instanceof Multi ? m.v : m === undefined ? [] : [m]);
export const $list = (m) => (m instanceof Multi ? m.v : [m]);

// Tables: one Map for all keys, plus a border for the length operator.
export class LuaTable {
  constructor() { this.h = new Map(); this.n = 0; this.mt = null; }
  get(k) { return this.h.get(k); }
  set(k, v) {
    if (v === undefined) {
      if (this.h.delete(k) && typeof k === 'number' && k <= this.n && k >= 1 && Number.isInteger(k)) this.n = k - 1;
      return;
    }
    if (k === undefined) throw new LuaError('table index is nil');
    if (k !== k) throw new LuaError('table index is NaN');
    this.h.set(k, v);
    if (k === this.n + 1) { let n = k; while (this.h.has(n + 1)) n++; this.n = n; }
  }
  length() { return this.n; }
}

// ---------------------------------------------------------------- fixed point

// Wrap to 16.16's range (a value that's already a multiple of 1/65536).
export function wrap(x) {
  if (x >= 32768 || x < -32768) return ((x * 65536) | 0) / 65536;
  return x;
}
// Truncate to 16.16 (towards -inf, as the hardware's shift does) and wrap.
export function fix(x) {
  if (x !== x) return 0;
  if (x === Infinity) return 32767.99998474121;
  if (x === -Infinity) return -32768;
  return ((Math.floor(x * 65536) | 0) / 65536);
}
// As a 32-bit integer of the fixed-point bits.
export const bits = (x) => Math.floor(x * 65536) | 0;
export const unbits = (b) => (b | 0) / 65536;

// ---------------------------------------------------------------- types

export function type(v) {
  if (v === undefined || v === null) return 'nil';
  const t = typeof v;
  if (t === 'number') return 'number';
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'boolean';
  if (t === 'function') return 'function';
  if (v instanceof LuaTable) return 'table';
  if (v instanceof Coroutine) return 'thread';
  return 'userdata';
}

export const $T = (v) => v !== undefined && v !== false && v !== null;

function metamethod(v, name) {
  return v instanceof LuaTable && v.mt ? v.mt.get(name) : undefined;
}

// A string to a number as Lua's arithmetic coerces it, or undefined.
export function strToNum(s) {
  s = s.trim();
  let m;
  if ((m = /^(-?)0x([0-9a-f]*)(?:\.([0-9a-f]*))?$/i.exec(s)) && (m[2] || m[3])) {
    let v = parseInt(m[2] || '0', 16);
    if (m[3]) v += parseInt(m[3], 16) / 16 ** m[3].length;
    return fix(m[1] ? -v : v);
  }
  if ((m = /^(-?)0b([01]*)(?:\.([01]*))?$/i.exec(s)) && (m[2] || m[3])) {
    let v = parseInt(m[2] || '0', 2);
    if (m[3]) v += parseInt(m[3], 2) / 2 ** m[3].length;
    return fix(m[1] ? -v : v);
  }
  if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return fix(Math.round(parseFloat(s) * 65536) / 65536);
  return undefined;
}

function arith(name, a, b, op) {
  const x = typeof a === 'string' ? strToNum(a) : a, y = typeof b === 'string' ? strToNum(b) : b;
  if (typeof x === 'number' && typeof y === 'number') return op(x, y);
  const mm = metamethod(a, name) ?? metamethod(b, name);
  if (mm !== undefined) return $first($c(mm)(a, b));
  const bad = typeof x !== 'number' ? a : b;
  throw new LuaError(`attempt to perform arithmetic on a ${type(bad)} value`);
}

const add = (a, b) => wrap(a + b);
const sub = (a, b) => wrap(a - b);
const mul = (a, b) => fix(a * b);
const div = (a, b) => {
  if (b === 0) return a > 0 ? 32767.99998474121 : a < 0 ? -32768 : 32767.99998474121;
  return fix(a / b);
};
const idiv = (a, b) => (b === 0 ? div(a, b) : wrap(Math.floor(a / b)));
const mod = (a, b) => {
  if (b === 0) return 0;
  const r = a - Math.floor(a / b) * b;
  return fix(r);
};
const pow = (a, b) => fix(a ** b);

export const $add = (a, b) => (typeof a === 'number' && typeof b === 'number' ? wrap(a + b) : arith('__add', a, b, add));
export const $sub = (a, b) => (typeof a === 'number' && typeof b === 'number' ? wrap(a - b) : arith('__sub', a, b, sub));
export const $mul = (a, b) => (typeof a === 'number' && typeof b === 'number' ? fix(a * b) : arith('__mul', a, b, mul));
export const $div = (a, b) => (typeof a === 'number' && typeof b === 'number' ? div(a, b) : arith('__div', a, b, div));
export const $idiv = (a, b) => (typeof a === 'number' && typeof b === 'number' ? idiv(a, b) : arith('__idiv', a, b, idiv));
export const $mod = (a, b) => (typeof a === 'number' && typeof b === 'number' ? mod(a, b) : arith('__mod', a, b, mod));
export const $pow = (a, b) => (typeof a === 'number' && typeof b === 'number' ? pow(a, b) : arith('__pow', a, b, pow));
export function $unm(a) {
  if (typeof a === 'number') return wrap(-a);
  const mm = metamethod(a, '__unm');
  if (mm !== undefined) return $first($c(mm)(a, a));
  return arith('__unm', a, 0, (x) => wrap(-x));
}

// Bitwise operators work on the 32 bits of the fixed-point value.
function bitop(name, a, b, op) {
  if (typeof a === 'number' && typeof b === 'number') return op(a, b);
  return arith(name, a, b, op);
}
const band = (a, b) => unbits(bits(a) & bits(b));
const bor = (a, b) => unbits(bits(a) | bits(b));
const bxor = (a, b) => unbits(bits(a) ^ bits(b));
const shl = (a, n) => { n = Math.floor(n); return n >= 32 ? 0 : n < 0 ? shr(a, -n) : unbits(bits(a) << n); };
const shr = (a, n) => { n = Math.floor(n); return n >= 32 ? (a < 0 ? -1 / 65536 : 0) : n < 0 ? shl(a, -n) : unbits(bits(a) >> n); };
const lshr = (a, n) => { n = Math.floor(n); return n >= 32 ? 0 : n < 0 ? shl(a, -n) : unbits(bits(a) >>> n); };
const rotl = (a, n) => { n = Math.floor(n) & 31; const x = bits(a); return unbits((x << n) | (x >>> (32 - n))); };
const rotr = (a, n) => { n = Math.floor(n) & 31; const x = bits(a); return unbits((x >>> n) | (x << (32 - n))); };
export const $band = (a, b) => bitop('__and', a, b, band);
export const $bor = (a, b) => bitop('__or', a, b, bor);
export const $bxor = (a, b) => bitop('__xor', a, b, bxor);
export const $shl = (a, b) => bitop('__shl', a, b, shl);
export const $shr = (a, b) => bitop('__shr', a, b, shr);
export const $lshr = (a, b) => bitop('__lshr', a, b, lshr);
export const $rotl = (a, b) => bitop('__rotl', a, b, rotl);
export const $rotr = (a, b) => bitop('__rotr', a, b, rotr);
export function $bnot(a) {
  if (typeof a === 'number') return unbits(~bits(a));
  const mm = metamethod(a, '__not');
  if (mm !== undefined) return $first($c(mm)(a, a));
  throw new LuaError(`attempt to perform bitwise operation on a ${type(a)} value`);
}

export function $eq(a, b) {
  if (a === b) return true;
  if (a instanceof LuaTable && b instanceof LuaTable) {
    const mm = metamethod(a, '__eq') ?? metamethod(b, '__eq');
    if (mm !== undefined) return $T($first($c(mm)(a, b)));
  }
  return false;
}
export const $ne = (a, b) => !$eq(a, b);
function compare(name, a, b) {
  const mm = metamethod(a, name) ?? metamethod(b, name);
  if (mm !== undefined) return $T($first($c(mm)(a, b)));
  throw new LuaError(`attempt to compare ${type(a)} with ${type(b)}`);
}
export function $lt(a, b) {
  if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) return a < b;
  return compare('__lt', a, b);
}
export function $le(a, b) {
  if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) return a <= b;
  return compare('__le', a, b);
}
export const $gt = (a, b) => $lt(b, a);
export const $ge = (a, b) => $le(b, a);

export function $cat(a, b) {
  const ta = typeof a, tb = typeof b;
  if ((ta === 'string' || ta === 'number') && (tb === 'string' || tb === 'number')) return numStr(a) + numStr(b);
  const mm = metamethod(a, '__concat') ?? metamethod(b, '__concat');
  if (mm !== undefined) return $first($c(mm)(a, b));
  const bad = ta === 'string' || ta === 'number' ? b : a;
  throw new LuaError(`attempt to concatenate a ${type(bad)} value`);
}
const numStr = (v) => (typeof v === 'number' ? fmtNum(v) : v);

// Numbers as PICO-8 prints them: up to four decimal places.
export function fmtNum(v) {
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(4);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export function $len(v) {
  if (typeof v === 'string') return v.length;
  if (v instanceof LuaTable) {
    const mm = metamethod(v, '__len');
    if (mm !== undefined) return $first($c(mm)(v));
    return v.n;
  }
  throw new LuaError(`attempt to get length of a ${type(v)} value`);
}

// ---------------------------------------------------------------- indexing and calls

export function $idx(o, k) {
  if (o instanceof LuaTable) {
    const v = o.h.get(k);
    if (v !== undefined || !o.mt) return v;
    const h = o.mt.get('__index');
    if (h === undefined) return undefined;
    if (typeof h === 'function') return $first(h(o, k));
    return $idx(h, k);
  }
  if (typeof o === 'string') return undefined;
  throw new LuaError(`attempt to index a ${type(o)} value${k !== undefined ? ` (field '${typeof k === 'number' ? fmtNum(k) : String(k)}')` : ''}`);
}

export function $set(o, k, v) {
  if (o instanceof LuaTable) {
    if (o.mt && !o.h.has(k)) {
      const h = o.mt.get('__newindex');
      if (h !== undefined) {
        if (typeof h === 'function') { h(o, k, v); return; }
        $set(h, k, v);
        return;
      }
    }
    o.set(k, v);
    return;
  }
  throw new LuaError(`attempt to index a ${type(o)} value${k !== undefined ? ` (field '${String(k)}')` : ''}`);
}

export function $c(f) {
  if (typeof f === 'function') return f;
  const mm = metamethod(f, '__call');
  if (mm !== undefined) return (...a) => $c(mm)(f, ...a);
  throw new LuaError(`attempt to call a ${type(f)} value`);
}
export function $mc(o, name, args) {
  const f = $idx(o, name);
  if (f === undefined) throw new LuaError(`attempt to call a nil value (method '${name}')`);
  return $c(f)(o, ...args);
}

// Generator-mode calls (inside coroutines): Lua functions run their generator
// versions; yield suspends; other builtins run straight.
export const YIELD = Symbol('yield');
export function* $cg(f, args) {
  if (typeof f === 'function') {
    if (f.$g) return yield* f.$g(...args);
    if (f.$yields) return yield { kind: f.$yields, args };
    return f(...args);
  }
  const mm = metamethod(f, '__call');
  if (mm !== undefined) return yield* $cg(mm, [f, ...args]);
  throw new LuaError(`attempt to call a ${type(f)} value`);
}
export function* $mcg(o, name, args) {
  const f = $idx(o, name);
  if (f === undefined) throw new LuaError(`attempt to call a nil value (method '${name}')`);
  return yield* $cg(f, [o, ...args]);
}

export function $fn(plain, gen, name) {
  if (gen) plain.$g = gen;
  plain.$name = name;
  return plain;
}

export function $tbl(arr, hash) {
  const t = new LuaTable();
  for (let i = 0; i < arr.length; i++) if (arr[i] !== undefined) t.h.set(i + 1, arr[i]);
  // The border: the last of the leading run of non-nil values.
  let n = 0;
  while (n < arr.length && arr[n] !== undefined) n++;
  if (n === arr.length) while (t.h.has(n + 1)) n++;
  t.n = n;
  if (hash) for (let i = 0; i < hash.length; i += 2) if (hash[i + 1] !== undefined) t.set(hash[i], hash[i + 1]);
  return t;
}

export function $num(v) {
  const n = typeof v === 'string' ? strToNum(v) : v;
  if (typeof n !== 'number') throw new LuaError("'for' value must be a number");
  return n;
}

// for ... in: the iterator triple (an all()/pairs() result, or a bare function).
export function $iter(vals) {
  return [vals[0], vals[1], vals[2]];
}

// ---------------------------------------------------------------- coroutines

export class Coroutine {
  constructor(f) {
    this.f = f;
    this.gen = null;
    this.status = 'suspended';
  }
}
