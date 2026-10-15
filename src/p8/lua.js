// A compiler from PICO-8's Lua to JavaScript.
//
// PICO-8's Lua is Lua 5.2 with extras: != for ~=, compound assignment
// (+= -= *= /= %= ^= ..= \= |= &= ^^= <<= >>= >>>= <<>= >><=), integer
// division \, bitwise operators (& | ^^ ~ << >> >>> <<> >><), peek operators
// (@ % $), one-line "if (cond) stmt [else stmt]" and "while (cond) stmt",
// "?" as print at the start of a line, // comments, and binary literals.
// Source text here is P8SCII: one character per byte, glyphs at 128-255.
//
// Each Lua function becomes two JavaScript functions: a plain one, and a
// generator for running inside a coroutine (where yield() suspends the whole
// call chain). Inside the generator version, every call goes through
// yield*, so a yield deep in a call chain reaches the coroutine. The plain
// version is what normal code calls, at full speed.
//
// Values: nil is undefined, numbers are JS numbers, strings JS strings,
// tables LuaTable (see runtime.js), functions JS functions. A function
// returning several values returns a Multi.

// ---------------------------------------------------------------- lexer

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
// Longest first.
const OPS = ['>>>=', '<<>=', '>><=', '...', '..=', '>>>', '<<>', '>><', '^^=', '<<=', '>>=', '==', '~=', '!=', '<=', '>=', '..',
  '+=', '-=', '*=', '/=', '%=', '^=', '\\=', '|=', '&=', '<<', '>>', '^^', '::',
  '+', '-', '*', '/', '%', '^', '#', '&', '|', '~', '<', '>', '=', '(', ')', '{', '}', '[', ']', ';', ':', ',', '.', '\\', '@', '$', '?'];
const ESCAPES = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34, "'": 39, '\n': 10, '*': 1, '#': 2, '-': 3, '|': 4, '+': 5, '^': 6 };

export class LuaError extends Error {}

function isIdStart(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128; }
function isDigit(c) { return c >= 48 && c <= 57; }

export function tokenize(src) {
  const toks = [];
  let i = 0, line = 1, nl = true;
  const n = src.length;
  const err = (m) => { throw new LuaError(`line ${line}: ${m}`); };
  const longBracket = () => {          // at '[': returns the level of [==[ or -1
    let j = i + 1, lvl = 0;
    while (src[j] === '=') { lvl++; j++; }
    return src[j] === '[' ? lvl : -1;
  };
  const readLong = (lvl) => {          // i at the opening '['; returns the content
    i += lvl + 2;
    if (src[i] === '\r') i++;
    if (src[i] === '\n') { i++; line++; }
    const close = ']' + '='.repeat(lvl) + ']';
    const end = src.indexOf(close, i);
    if (end < 0) err('unfinished long string');
    const s = src.slice(i, end);
    for (const ch of s) if (ch === '\n') line++;
    i = end + close.length;
    return s;
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) { line++; nl = true; i++; continue; }
    if (c === 32 || c === 9 || c === 13) { i++; continue; }
    // Comments: -- and //, block --[[ ]].
    if ((c === 45 && src[i + 1] === '-') || (c === 47 && src[i + 1] === '/')) {
      i += 2;
      if (c === 45 && src[i] === '[') { const lvl = longBracket(); if (lvl >= 0) { readLong(lvl); continue; } }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const tok = { t: '', v: null, line, nl };
    nl = false;
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n) { const d = src.charCodeAt(j); if (isIdStart(d) || isDigit(d)) j++; else break; }
      const w = src.slice(i, j);
      i = j;
      if (KEYWORDS.has(w)) { tok.t = 'kw'; tok.v = w; } else { tok.t = 'name'; tok.v = w; }
      toks.push(tok);
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      let v;
      if (c === 48 && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        let j = i + 2, int = 0, frac = 0, scale = 1;
        while (j < n && /[0-9a-fA-F]/.test(src[j])) int = int * 16 + parseInt(src[j++], 16);
        if (src[j] === '.') { j++; while (j < n && /[0-9a-fA-F]/.test(src[j])) { scale /= 16; frac += parseInt(src[j++], 16) * scale; } }
        v = int + frac; i = j;
      } else if (c === 48 && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
        let j = i + 2, int = 0, frac = 0, scale = 1;
        while (src[j] === '0' || src[j] === '1') int = int * 2 + (src[j++] === '1' ? 1 : 0);
        if (src[j] === '.') { j++; while (src[j] === '0' || src[j] === '1') { scale /= 2; frac += (src[j++] === '1' ? 1 : 0) * scale; } }
        v = int + frac; i = j;
      } else {
        let j = i;
        while (j < n && (isDigit(src.charCodeAt(j)) || src[j] === '.')) j++;
        if ((src[j] === 'e' || src[j] === 'E') && /[-+0-9]/.test(src[j + 1] || '')) { j += 2; while (isDigit(src.charCodeAt(j))) j++; }
        v = parseFloat(src.slice(i, j)); i = j;
      }
      // Numbers are 16.16 fixed point: values past 32767 wrap.
      v = toFix(v);
      tok.t = 'number'; tok.v = v;
      toks.push(tok);
      continue;
    }
    if (c === 34 || c === 39) {
      const q = src[i++];
      let s = '';
      while (true) {
        if (i >= n) err('unfinished string');
        const ch = src[i];
        if (ch === q) { i++; break; }
        if (ch === '\n') err('unfinished string');
        if (ch === '\\') {
          const e = src[i + 1];
          if (e in ESCAPES) { s += String.fromCharCode(ESCAPES[e]); i += 2; if (e === '\n') line++; continue; }
          if (e === 'x') { s += String.fromCharCode(parseInt(src.substr(i + 2, 2), 16)); i += 4; continue; }
          if (e === 'z') { i += 2; while (i < n && /\s/.test(src[i])) { if (src[i] === '\n') line++; i++; } continue; }
          if (isDigit(src.charCodeAt(i + 1))) {
            let j = i + 1, num = '';
            while (j < i + 4 && isDigit(src.charCodeAt(j))) num += src[j++];
            s += String.fromCharCode(parseInt(num, 10) & 255); i = j; continue;
          }
          s += e; i += 2; continue;
        }
        s += ch; i++;
      }
      tok.t = 'string'; tok.v = s;
      toks.push(tok);
      continue;
    }
    if (c === 91) {
      const lvl = longBracket();
      if (lvl >= 0) { tok.t = 'string'; tok.v = readLong(lvl); toks.push(tok); continue; }
    }
    let op = null;
    for (const o of OPS) if (src.startsWith(o, i)) { op = o; break; }
    if (!op) err(`unexpected character '${src[i]}'`);
    if (op === '!=') op = '~=';
    i += op.length;
    tok.t = 'op'; tok.v = op;
    toks.push(tok);
  }
  toks.push({ t: 'eof', v: null, line, nl: true });
  return toks;
}

// The nearest 16.16 fixed-point value, wrapped to -32768..32767.99998.
export function toFix(v) {
  let x = Math.round(v * 65536) | 0;     // |0 wraps to 32 bits
  return x / 65536;
}

// ---------------------------------------------------------------- parser

const BINARY = {
  or: [1, 1], and: [2, 2],
  '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
  '|': [4, 4], '^^': [5, 5], '&': [6, 6],
  '<<': [7, 7], '>>': [7, 7], '>>>': [7, 7], '<<>': [7, 7], '>><': [7, 7],
  '..': [9, 8],                                 // right associative
  '+': [10, 10], '-': [10, 10],
  '*': [11, 11], '/': [11, 11], '\\': [11, 11], '%': [11, 11],
  '^': [14, 13],                                // right associative, above unary
};
const UNARY_PRI = 12;
const COMPOUND = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '^=': '^', '..=': '..', '\\=': '\\', '|=': '|', '&=': '&',
  '^^=': '^^', '<<=': '<<', '>>=': '>>', '>>>=': '>>>', '<<>=': '<<>', '>><=': '>><' };

export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = (k = 0) => toks[p + k];
  const next = () => toks[p++];
  const err = (m, t = peek()) => { throw new LuaError(`line ${t.line}: ${m}`); };
  const isOp = (v, t = peek()) => t.t === 'op' && t.v === v;
  const isKw = (v, t = peek()) => t.t === 'kw' && t.v === v;
  const expectOp = (v) => { if (!isOp(v)) err(`'${v}' expected near '${peek().v ?? peek().t}'`); return next(); };
  const expectKw = (v) => { if (!isKw(v)) err(`'${v}' expected near '${peek().v ?? peek().t}'`); return next(); };
  const name = () => { const t = next(); if (t.t !== 'name') err(`name expected near '${t.v ?? t.t}'`, t); return t.v; };

  const blockEnds = (t = peek()) => t.t === 'eof' || (t.t === 'kw' && (t.v === 'end' || t.v === 'else' || t.v === 'elseif' || t.v === 'until'));

  function block() {
    const body = [];
    while (!blockEnds()) {
      if (isKw('return')) { body.push(retstat()); break; }
      const s = statement();
      if (s) body.push(s);
    }
    return body;
  }
  // Statements on one line (PICO-8's one-line if / while).
  function lineBlock(line, stopAtElse) {
    const body = [];
    while (peek().t !== 'eof' && peek().line === line && !(stopAtElse && isKw('else')) && !blockEnds()) {
      if (isKw('return')) { body.push(retstat(line)); break; }
      const s = statement();
      if (s) body.push(s);
    }
    return body;
  }
  function retstat(line) {
    next();
    let exps = [];
    if (!blockEnds() && !isOp(';') && !(line !== undefined && peek().line !== line)) exps = explist();
    if (isOp(';')) next();
    return { k: 'return', exps };
  }

  function statement() {
    const t = peek();
    if (isOp(';')) { next(); return null; }
    if (isOp('::')) { next(); const n = name(); expectOp('::'); return { k: 'label', name: n }; }
    if (isOp('?')) {                                 // ?expr,... is print(expr,...)
      next();
      return { k: 'call', exp: { k: 'call', fn: { k: 'name', name: 'print' }, args: explist(), line: t.line } };
    }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'break': next(); return { k: 'break' };
        case 'goto': next(); return { k: 'goto', name: name() };
        case 'do': { next(); const body = block(); expectKw('end'); return { k: 'do', body }; }
        case 'while': {
          next();
          const cond = exp();
          if (isKw('do')) { next(); const body = block(); expectKw('end'); return { k: 'while', cond, body }; }
          return { k: 'while', cond, body: lineBlock(t.line) };       // while (cond) stmt
        }
        case 'repeat': { next(); const body = block(); expectKw('until'); return { k: 'repeat', body, cond: exp() }; }
        case 'if': return ifstat();
        case 'for': return forstat();
        case 'function': {
          next();
          let target = { k: 'name', name: name() }, method = false;
          while (isOp('.')) { next(); target = { k: 'index', obj: target, key: { k: 'string', v: name() } }; }
          if (isOp(':')) { next(); target = { k: 'index', obj: target, key: { k: 'string', v: name() } }; method = true; }
          const f = funcbody(method, target);
          return { k: 'assign', targets: [target], exps: [f] };
        }
        case 'local': {
          next();
          if (isKw('function')) { next(); const n = name(); return { k: 'localfunc', name: n, fn: funcbody(false, { k: 'name', name: n }) }; }
          const names = [name()];
          while (isOp('<')) { next(); name(); expectOp('>'); }      // attributes (<const>), ignored
          while (isOp(',')) { next(); names.push(name()); while (isOp('<')) { next(); name(); expectOp('>'); } }
          let exps = [];
          if (isOp('=')) { next(); exps = explist(); }
          return { k: 'local', names, exps };
        }
      }
    }
    // Expression statement: a call or an assignment.
    const e = suffixedexp();
    if (isOp('=') || isOp(',')) {
      const targets = [e];
      while (isOp(',')) { next(); targets.push(suffixedexp()); }
      expectOp('=');
      for (const tg of targets) if (tg.k !== 'name' && tg.k !== 'index') err('cannot assign to this', t);
      return { k: 'assign', targets, exps: explist() };
    }
    if (peek().t === 'op' && COMPOUND[peek().v]) {
      const op = COMPOUND[next().v];
      if (e.k !== 'name' && e.k !== 'index') err('cannot assign to this', t);
      return { k: 'compound', target: e, op, exp: exp() };
    }
    if (e.k !== 'call' && e.k !== 'method') err('syntax error', t);
    return { k: 'call', exp: e };
  }

  function ifstat() {
    const t = next();
    const cond = exp();
    if (!isKw('then')) {
      // One-line form: if (cond) stmts [else stmts], all on the if's line.
      const body = lineBlock(t.line, true);
      let orelse = null;
      if (isKw('else') && peek().line === t.line) { next(); orelse = lineBlock(t.line, false); }
      return { k: 'if', clauses: [[cond, body]], orelse };
    }
    next();
    const clauses = [[cond, block()]];
    let orelse = null;
    while (true) {
      if (isKw('elseif')) { next(); const c = exp(); expectKw('then'); clauses.push([c, block()]); continue; }
      if (isKw('else')) { next(); orelse = block(); }
      break;
    }
    expectKw('end');
    return { k: 'if', clauses, orelse };
  }

  function forstat() {
    next();
    const n1 = name();
    if (isOp('=')) {
      next();
      const start = exp(); expectOp(',');
      const limit = exp();
      let step = null;
      if (isOp(',')) { next(); step = exp(); }
      expectKw('do');
      const body = block();
      expectKw('end');
      return { k: 'fornum', name: n1, start, limit, step, body };
    }
    const names = [n1];
    while (isOp(',')) { next(); names.push(name()); }
    expectKw('in');
    const exps = explist();
    expectKw('do');
    const body = block();
    expectKw('end');
    return { k: 'forin', names, exps, body };
  }

  function funcbody(method, target) {
    const params = method ? ['self'] : [];
    let vararg = false;
    expectOp('(');
    if (!isOp(')')) {
      while (true) {
        if (isOp('...')) { next(); vararg = true; break; }
        params.push(name());
        if (!isOp(',')) break;
        next();
      }
    }
    expectOp(')');
    const body = block();
    expectKw('end');
    return { k: 'function', params, vararg, body, name: target ? describe(target) : null };
  }
  const describe = (e) => (e.k === 'name' ? e.name : e.k === 'index' && e.key.k === 'string' ? `${describe(e.obj)}.${e.key.v}` : '?');

  function explist() {
    const list = [exp()];
    while (isOp(',')) { next(); list.push(exp()); }
    return list;
  }

  function exp(limit = 0) {
    let left;
    const t = peek();
    if ((t.t === 'kw' && t.v === 'not') || (t.t === 'op' && (t.v === '-' || t.v === '#' || t.v === '~' || t.v === '@' || t.v === '%' || t.v === '$'))) {
      next();
      const arg = exp(UNARY_PRI);
      // Fold negative number literals.
      if (t.v === '-' && arg.k === 'number') left = { k: 'number', v: toFix(-arg.v) };
      else left = { k: 'unop', op: t.v, arg };
    } else left = simpleexp();
    while (true) {
      const o = peek();
      const op = o.t === 'op' ? o.v : o.t === 'kw' && (o.v === 'and' || o.v === 'or') ? o.v : null;
      if (!op || !BINARY[op] || BINARY[op][0] <= limit) break;
      next();
      const right = exp(BINARY[op][1]);
      left = { k: 'binop', op, left, right };
    }
    return left;
  }

  function simpleexp() {
    const t = peek();
    switch (t.t) {
      case 'number': next(); return { k: 'number', v: t.v };
      case 'string': next(); return { k: 'string', v: t.v };
      case 'kw':
        if (t.v === 'nil') { next(); return { k: 'nil' }; }
        if (t.v === 'true') { next(); return { k: 'true' }; }
        if (t.v === 'false') { next(); return { k: 'false' }; }
        if (t.v === 'function') { next(); return funcbody(false, null); }
        break;
      case 'op':
        if (t.v === '...') { next(); return { k: 'vararg' }; }
        if (t.v === '{') return table();
        break;
    }
    return suffixedexp();
  }

  function primaryexp() {
    const t = peek();
    if (t.t === 'name') { next(); return { k: 'name', name: t.v }; }
    if (isOp('(')) { next(); const e = exp(); expectOp(')'); return { k: 'paren', exp: e }; }
    err(`unexpected symbol near '${t.v ?? t.t}'`);
  }

  function suffixedexp() {
    let e = primaryexp();
    while (true) {
      const t = peek();
      if (isOp('.')) { next(); e = { k: 'index', obj: e, key: { k: 'string', v: name() } }; continue; }
      if (isOp('[')) { next(); const key = exp(); expectOp(']'); e = { k: 'index', obj: e, key }; continue; }
      if (isOp(':')) {
        next();
        const m = name();
        e = { k: 'method', obj: e, name: m, args: args(), line: t.line };
        continue;
      }
      // A call's '(' must be on the same line as the function (Lua's ambiguity rule, relaxed).
      if ((isOp('(') && !t.nl) || isOp('{') || t.t === 'string') { e = { k: 'call', fn: e, args: args(), line: t.line }; continue; }
      return e;
    }
  }

  function args() {
    const t = peek();
    if (t.t === 'string') { next(); return [{ k: 'string', v: t.v }]; }
    if (isOp('{')) return [table()];
    expectOp('(');
    if (isOp(')')) { next(); return []; }
    const list = explist();
    expectOp(')');
    return list;
  }

  function table() {
    expectOp('{');
    const items = [];       // { key?, value }
    while (!isOp('}')) {
      if (isOp('[')) { next(); const key = exp(); expectOp(']'); expectOp('='); items.push({ key, value: exp() }); }
      else if (peek().t === 'name' && isOp('=', peek(1))) { const k = name(); next(); items.push({ key: { k: 'string', v: k }, value: exp() }); }
      else items.push({ value: exp() });
      if (isOp(',') || isOp(';')) next(); else break;
    }
    expectOp('}');
    return { k: 'table', items };
  }

  const body = block();
  if (peek().t !== 'eof') err(`'<eof>' expected near '${peek().v}'`);
  return { k: 'function', params: [], vararg: true, body, name: 'main chunk' };
}

// ---------------------------------------------------------------- code generator

// Whether a function body (not counting nested functions) contains a call.
function makesCalls(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(makesCalls);
  if (node.k === 'call' || node.k === 'method' || node.k === 'forin') return true;
  if (node.k === 'function') return false;
  // Metamethods (__index functions, operators on tables) can call Lua code too, but
  // they run in plain mode and can't yield there anyway.
  for (const key in node) if (key !== 'k' && makesCalls(node[key])) return true;
  return false;
}

const JS_RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await',
  'arguments', 'eval', 'undefined', 'NaN', 'Infinity']);

const BIN_HELPER = {
  '+': '$add', '-': '$sub', '*': '$mul', '/': '$div', '%': '$mod', '^': '$pow', '\\': '$idiv', '..': '$cat',
  '<': '$lt', '<=': '$le', '>': '$gt', '>=': '$ge', '==': '$eq', '~=': '$ne',
  '&': '$band', '|': '$bor', '^^': '$bxor', '<<': '$shl', '>>': '$shr', '>>>': '$lshr', '<<>': '$rotl', '>><': '$rotr',
};
const UN_HELPER = { '-': '$unm', '#': '$len', '~': '$bnot', '@': '$peek', '%': '$peek2', '$': '$peek4' };

// Compile a parsed chunk to the source of a JS function body that returns the main chunk as a function pair.
export function generate(chunk) {
  let uid = 0;
  const mangle = (n) => {
    let s = '';
    for (const ch of n) { const c = ch.charCodeAt(0); s += /[A-Za-z0-9_]/.test(ch) ? ch : `$${c.toString(16)}`; }
    return `${s}_${++uid}`;
  };

  // A function being compiled: its scopes, temporaries and mode.
  class Fn {
    constructor(parent, gen) { this.parent = parent; this.gen = gen; this.scopes = []; this.temps = 0; this.maxTemps = 0; this.loops = []; }
    tmp() { const n = this.temps++; this.maxTemps = Math.max(this.maxTemps, this.temps); return `_t${n}`; }
    free(k = 1) { this.temps -= k; }
  }
  let fn = null;
  const pushScope = () => fn.scopes.push(new Map());
  const popScope = () => fn.scopes.pop();
  const declare = (name) => { const js = mangle(name); fn.scopes[fn.scopes.length - 1].set(name, js); return js; };
  const resolve = (name) => {
    for (let f = fn; f; f = f.parent) {
      for (let i = f.scopes.length - 1; i >= 0; i--) if (f.scopes[i].has(name)) return f.scopes[i].get(name);
    }
    return null;
  };
  const str = (s) => JSON.stringify(s);
  // Lua loops get JS labels, so break leaves the loop even from inside a goto block's switch.
  const loopLabel = () => { const L = `$L${++uid}`; fn.loops.push(L); return L; };
  const globalRef = (name) => `G[${str(name)}]`;

  // A call: plain mode calls directly; generator mode delegates with yield*.
  const callExpr = (fnJs, argsJs) => (fn.gen ? `(yield* $cg(${fnJs}, [${argsJs}]))` : `$c(${fnJs})(${argsJs})`);

  // Expression lists where the last may expand to several values: returns JS for an array.
  const multiArgs = (exps) => {
    if (!exps.length) return { simple: true, js: '' };
    const last = exps[exps.length - 1];
    const multi = last.k === 'call' || last.k === 'method' || last.k === 'vararg';
    if (!multi) return { simple: true, js: exps.map((e) => ex(e)).join(', ') };
    const head = exps.slice(0, -1).map((e) => ex(e));
    return { simple: false, js: `${head.length ? `${head.join(', ')}, ` : ''}...$spread(${exm(last)})` };
  };

  // An expression in a single-value context.
  function ex(e) {
    switch (e.k) {
      case 'nil': return 'undefined';
      case 'true': return 'true';
      case 'false': return 'false';
      case 'number': return e.v < 0 ? `(${e.v})` : String(e.v);
      case 'string': return str(e.v);
      case 'vararg': return '$va[0]';
      case 'paren': return ex(e.exp);
      case 'name': { const js = resolve(e.name); return js || globalRef(e.name); }
      case 'index': return `$idx(${ex(e.obj)}, ${ex(e.key)})`;
      case 'call': case 'method': return `$first(${exm(e)})`;
      case 'function': return funcExpr(e);
      case 'table': return tableExpr(e);
      case 'unop':
        if (e.op === 'not') return `!$T(${ex(e.arg)})`;
        return `${UN_HELPER[e.op]}(${ex(e.arg)})`;
      case 'binop': {
        if (e.op === 'and' || e.op === 'or') {
          const t = fn.tmp();
          const l = ex(e.left), r = ex(e.right);
          fn.free();
          return e.op === 'and' ? `((${t} = ${l}) === undefined || ${t} === false ? ${t} : ${r})`
            : `((${t} = ${l}) === undefined || ${t} === false ? ${r} : ${t})`;
        }
        return `${BIN_HELPER[e.op]}(${ex(e.left)}, ${ex(e.right)})`;
      }
    }
    throw new LuaError(`cannot compile ${e.k}`);
  }

  // An expression whose result may be several values (calls, ...): JS evaluating to a value or Multi.
  function exm(e) {
    if (e.k === 'vararg') return '$M($va)';
    if (e.k === 'call') {
      const a = multiArgs(e.args);
      return callExpr(ex(e.fn), a.js);
    }
    if (e.k === 'method') {
      const a = multiArgs(e.args);
      if (fn.gen) return `(yield* $mcg(${ex(e.obj)}, ${str(e.name)}, [${a.js}]))`;
      return `$mc(${ex(e.obj)}, ${str(e.name)}, [${a.js}])`;
    }
    return ex(e);
  }

  function tableExpr(e) {
    const arr = [], hash = [];
    e.items.forEach((it, i) => {
      if (it.key) { hash.push(ex(it.key), ex(it.value)); return; }
      const last = i === e.items.length - 1;
      if (last && (it.value.k === 'call' || it.value.k === 'method' || it.value.k === 'vararg')) arr.push(`...$spread(${exm(it.value)})`);
      else arr.push(ex(it.value));
    });
    return `$tbl([${arr.join(', ')}]${hash.length ? `, [${hash.join(', ')}]` : ''})`;
  }

  // A function: both versions, the generator attached to the plain one.
  // A function that calls nothing can't yield, so it needs no generator version.
  function funcExpr(e) {
    const gen = makesCalls(e.body) ? funcCode(e, true) : 'null';
    return `$fn(${funcCode(e, false)}, ${gen}, ${str(e.name || 'function')})`;
  }
  function funcCode(e, gen) {
    const outer = fn;
    fn = new Fn(outer, gen);
    pushScope();
    const params = e.params.map((p) => declare(p));
    if (e.vararg) params.push('...$va');
    const body = stmts(e.body);
    popScope();
    const temps = fn.maxTemps ? `let ${Array.from({ length: fn.maxTemps }, (_, i) => `_t${i}`).join(', ')};\n` : '';
    fn = outer;
    return `function${gen ? '*' : ''} (${params.join(', ')}) {\n${temps}${body}}`;
  }

  // ---- statements

  function stmts(list) { return list.map(stmt).join(''); }

  // A block in its own scope, with goto support: forward gotos to labels later in the
  // block use a labeled block; a goto to a label earlier in the block loops back.
  function blockCode(list) {
    pushScope();
    const labels = list.filter((s) => s.k === 'label');
    let out;
    if (!labels.length) out = stmts(list);
    else out = labeledBlock(list);
    popScope();
    return out;
  }
  function labeledBlock(list) {
    // Split at labels: segment 0 runs first; "goto L" jumps to the segment after label L.
    const segs = [[]], names = [];
    for (const s of list) { if (s.k === 'label') { segs.push([]); names.push(s.name); } else segs[segs.length - 1].push(s); }
    const id = `$g${++uid}`;
    fn.gotos = fn.gotos || [];
    fn.gotos.push({ names, id });
    let out = `let ${id}s = 0;\n${id}: while (true) {\nswitch (${id}s) {\n`;
    segs.forEach((seg, k) => { out += `case ${k}:\n${stmts(seg)}`; });
    out += `}\nbreak;\n}\n`;
    fn.gotos.pop();
    return out;
  }
  function gotoCode(name) {
    for (let i = (fn.gotos || []).length - 1; i >= 0; i--) {
      const g = fn.gotos[i], k = g.names.indexOf(name);
      if (k >= 0) return `{ ${g.id}s = ${k + 1}; continue ${g.id}; }\n`;
    }
    throw new LuaError(`no visible label '${name}' for goto`);
  }

  function assignTo(target, valueJs) {
    if (target.k === 'name') {
      const js = resolve(target.name);
      return `${js || globalRef(target.name)} = ${valueJs};\n`;
    }
    return `$set(${ex(target.obj)}, ${ex(target.key)}, ${valueJs});\n`;
  }

  function stmt(s) {
    switch (s.k) {
      case 'call': return `${exm(s.exp)};\n`;
      case 'local': {
        if (s.exps.length === 1 && s.names.length === 1) { const v = ex(s.exps[0]); return `let ${declare(s.names[0])} = ${v};\n`; }
        if (!s.exps.length) return `let ${s.names.map((n) => declare(n)).join(', ')};\n`;
        const a = multiArgs(s.exps);
        const t = `$v${++uid}`;
        const head = `const ${t} = [${a.js}];\n`;
        return head + s.names.map((n, i) => `let ${declare(n)} = ${t}[${i}];\n`).join('');
      }
      case 'localfunc': { const js = declare(s.name); return `let ${js};\n${js} = ${funcExpr(s.fn)};\n`; }
      case 'assign': {
        if (s.targets.length === 1 && s.exps.length === 1) return assignTo(s.targets[0], ex(s.exps[0]));
        // Evaluate everything first, then assign.
        const a = multiArgs(s.exps);
        const t = `$v${++uid}`;
        let out = `const ${t} = [${a.js}];\n`;
        s.targets.forEach((tg, i) => { out += assignTo(tg, `${t}[${i}]`); });
        return out;
      }
      case 'compound': {
        const helper = BIN_HELPER[s.op];
        if (s.target.k === 'name') {
          const js = resolve(s.target.name) || globalRef(s.target.name);
          return `${js} = ${helper}(${js}, ${ex(s.exp)});\n`;
        }
        const o = `$o${++uid}`, k = `$k${uid}`;
        return `{ const ${o} = ${ex(s.target.obj)}, ${k} = ${ex(s.target.key)}; $set(${o}, ${k}, ${helper}($idx(${o}, ${k}), ${ex(s.exp)})); }\n`;
      }
      case 'do': return `{\n${blockCode(s.body)}}\n`;
      case 'while': { const L = loopLabel(); const out = `${L}: while ($T(${ex(s.cond)})) {\n${blockCode(s.body)}}\n`; fn.loops.pop(); return out; }
      case 'repeat': {
        // The condition can see the body's locals.
        const L = loopLabel();
        pushScope();
        const body = s.body.some((x) => x.k === 'label') ? labeledBlock(s.body) : stmts(s.body);
        const cond = ex(s.cond);
        popScope();
        fn.loops.pop();
        return `${L}: while (true) {\n${body}if ($T(${cond})) break;\n}\n`;
      }
      case 'if': {
        let out = '';
        s.clauses.forEach(([c, body], i) => { out += `${i ? ' else ' : ''}if ($T(${ex(c)})) {\n${blockCode(body)}}`; });
        if (s.orelse) out += ` else {\n${blockCode(s.orelse)}}`;
        return `${out}\n`;
      }
      case 'fornum': {
        const id = ++uid;
        const v = `$i${id}`, lim = `$l${id}`, st = `$s${id}`;
        let out = `{ let ${v} = $num(${ex(s.start)}); const ${lim} = $num(${ex(s.limit)}), ${st} = ${s.step ? `$num(${ex(s.step)})` : '1'};\n`;
        const L = loopLabel();
        out += `${L}: for (; ${st} > 0 ? ${v} <= ${lim} : ${v} >= ${lim}; ${v} += ${st}) {\n`;
        pushScope();
        out += `let ${declare(s.name)} = ${v};\n${blockCode(s.body)}`;
        popScope();
        fn.loops.pop();
        return `${out}}\n}\n`;
      }
      case 'forin': {
        const id = ++uid;
        const f = `$f${id}`, st = `$st${id}`, ctl = `$ctl${id}`, r = `$r${id}`;
        const a = multiArgs(s.exps);
        let out = `{ const [${f}, ${st}, ${ctl}0] = $iter([${a.js}]); let ${ctl} = ${ctl}0;\n`;
        const L = loopLabel();
        out += `${L}: while (true) {\n`;
        out += fn.gen ? `const ${r} = $list(yield* $cg(${f}, [${st}, ${ctl}]));\n` : `const ${r} = $list($c(${f})(${st}, ${ctl}));\n`;
        out += `if (${r}[0] === undefined) break;\n${ctl} = ${r}[0];\n`;
        pushScope();
        s.names.forEach((n, i) => { out += `let ${declare(n)} = ${r}[${i}];\n`; });
        out += blockCode(s.body);
        popScope();
        fn.loops.pop();
        return `${out}}\n}\n`;
      }
      case 'return': {
        if (!s.exps.length) return 'return;\n';
        if (s.exps.length === 1) {
          const e = s.exps[0];
          return `return ${e.k === 'call' || e.k === 'method' || e.k === 'vararg' ? exm(e) : ex(e)};\n`;
        }
        const a = multiArgs(s.exps);
        return `return $M([${a.js}]);\n`;
      }
      case 'break': if (!fn.loops.length) throw new LuaError('break outside a loop'); return `break ${fn.loops[fn.loops.length - 1]};\n`;
      case 'goto': return gotoCode(s.name);
      case 'label': return '';
    }
    throw new LuaError(`cannot compile statement ${s.k}`);
  }

  // The main chunk only runs as a generator (it may loop on flip()).
  fn = null;
  return funcCode(chunk, true);
}

// Compile source to the main chunk's generator function, given the runtime environment.
export function compile(src, env) {
  const ast = parse(src);
  const js = generate(ast);
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `"use strict";\nreturn ${js};`);
  return factory(...names.map((n) => env[n]));
}
