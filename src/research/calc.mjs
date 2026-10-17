export class CalcError extends Error {}

const FUNCTIONS = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  round: (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits,
  sqrt: Math.sqrt,
  pow: Math.pow,
};

function tokenize(formula) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^%(),]))/gy;
  let match;
  let consumed = 0;
  while ((match = re.exec(formula)) !== null) {
    if (match[0].length === 0) break;
    consumed = re.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: 'num', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: 'id', value: match[2] });
    else tokens.push({ type: 'op', value: match[3] === '**' ? '^' : match[3] });
  }
  if (formula.slice(consumed).trim().length) throw new CalcError(`unexpected input near "${formula.slice(consumed, consumed + 12)}"`);
  return tokens;
}

class Parser {
  constructor(tokens, vars) {
    this.tokens = tokens;
    this.vars = vars;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  take(value) {
    const token = this.tokens[this.pos];
    if (value !== undefined && (!token || token.value !== value)) throw new CalcError(`expected "${value}"`);
    this.pos++;
    return token;
  }

  parse() {
    const value = this.expression();
    if (this.pos < this.tokens.length) throw new CalcError(`unexpected "${this.peek().value}"`);
    return value;
  }

  expression() {
    let left = this.term();
    while (this.peek() && ['+', '-'].includes(this.peek().value)) {
      const op = this.take().value;
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  term() {
    let left = this.power();
    while (this.peek() && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.take().value;
      const right = this.power();
      if (op === '*') left *= right;
      else if (op === '/') left /= right;
      else left %= right;
    }
    return left;
  }

  power() {
    const base = this.unary();
    if (this.peek() && this.peek().value === '^') {
      this.take();
      return base ** this.power();
    }
    return base;
  }

  unary() {
    if (this.peek() && this.peek().value === '-') {
      this.take();
      return -this.unary();
    }
    if (this.peek() && this.peek().value === '+') {
      this.take();
      return this.unary();
    }
    return this.primary();
  }

  primary() {
    const token = this.take();
    if (!token) throw new CalcError('unexpected end of formula');
    if (token.type === 'num') return token.value;
    if (token.type === 'id') {
      if (this.peek() && this.peek().value === '(') return this.call(token.value);
      if (!(token.value in this.vars)) throw new CalcError(`unknown variable "${token.value}"`);
      return this.vars[token.value];
    }
    if (token.value === '(') {
      const value = this.expression();
      this.take(')');
      return value;
    }
    throw new CalcError(`unexpected "${token.value}"`);
  }

  call(name) {
    const fn = FUNCTIONS[name];
    if (!fn) throw new CalcError(`unknown function "${name}"`);
    this.take('(');
    const args = [];
    if (this.peek() && this.peek().value !== ')') {
      args.push(this.expression());
      while (this.peek() && this.peek().value === ',') {
        this.take();
        args.push(this.expression());
      }
    }
    this.take(')');
    return fn(...args);
  }
}

export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'value' in value) return toNumber(value.value);
  const cleaned = String(value ?? '').replace(/[\s,]/g, '').replace(/[^0-9eE.+-]/g, '');
  const n = Number(cleaned);
  if (cleaned === '' || !Number.isFinite(n)) throw new CalcError(`not a number: "${value}"`);
  return n;
}

export function evaluate(formula, inputs = {}) {
  const vars = {};
  for (const [name, raw] of Object.entries(inputs)) vars[name] = toNumber(raw);
  const value = new Parser(tokenize(String(formula)), vars).parse();
  if (!Number.isFinite(value)) throw new CalcError('result is not a finite number');
  return value;
}

export function sameNumber(a, b, relativeTolerance = 0.01) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale <= relativeTolerance || Math.abs(a - b) < 1e-6;
}
