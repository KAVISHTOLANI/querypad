/*
 * A small, read-only SQL engine for in-browser CSV tables.
 * Supports: SELECT [DISTINCT] … FROM t [AS a] [[LEFT] JOIN u [AS b] ON …] [WHERE …]
 *           [GROUP BY …] [HAVING …] [ORDER BY … [ASC|DESC]] [LIMIT n [OFFSET m]]
 * Expressions: + - * / %, comparisons, AND/OR/NOT, LIKE, IN (…), BETWEEN, IS [NOT] NULL,
 * COUNT/SUM/AVG/MIN/MAX (with DISTINCT), and LOWER, UPPER, LENGTH, ROUND, ABS, COALESCE, SUBSTR, TRIM.
 */
import { parseCSV } from '../shared/csv';

export type Value = string | number | null;
export interface Table { name: string; columns: string[]; types: ('number' | 'text')[]; rows: Value[][] }
export class SqlError extends Error {
  constructor(message: string, public pos?: number) { super(message); }
}

/* ---------- Tables ---------- */
export const NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
export function tableName(file: string): string {
  const base = file.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z_]/.test(base) ? base : `t_${base || 'data'}`;
}
export function tableFromCSV(name: string, text: string): Table {
  const p = parseCSV(text, { header: true });
  if (!p.headers.length || !p.rows.length) throw new SqlError('The file has no data rows.');
  const seen = new Map<string, number>();
  const columns = p.headers.map((h, i) => {
    let c = h.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || `col${i + 1}`;
    if (/^\d/.test(c)) c = `c_${c}`;
    const n = seen.get(c) ?? 0;
    seen.set(c, n + 1);
    return n ? `${c}_${n + 1}` : c;
  });
  const types = columns.map((_, i) => {
    const vals = p.rows.map((r) => (r[i] ?? '').trim()).filter(Boolean);
    return vals.length && vals.every((v) => NUM_RE.test(v)) ? 'number' as const : 'text' as const;
  });
  const rows = p.rows.map((r) => columns.map((_, i) => {
    const v = (r[i] ?? '').trim();
    if (v === '') return null;
    return types[i] === 'number' ? Number(v) : v;
  }));
  return { name, columns, types, rows };
}

/* ---------- Tokenizer ---------- */
type Tok = { t: 'id' | 'num' | 'str' | 'op' | 'kw' | 'end'; v: string; pos: number };
const KEYWORDS = new Set(['SELECT', 'DISTINCT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'LIKE', 'IN', 'IS', 'NULL', 'BETWEEN', 'JOIN', 'INNER', 'LEFT', 'OUTER', 'ON', 'TRUE', 'FALSE']);
const WRITE = /^\s*(insert|update|delete|drop|create|alter|replace|truncate)\b/i;

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      while (i < sql.length && /[0-9.]/.test(sql[i])) i++;
      out.push({ t: 'num', v: sql.slice(start, i), pos: start });
    } else if (/[A-Za-z_]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      const w = sql.slice(start, i);
      out.push(KEYWORDS.has(w.toUpperCase()) ? { t: 'kw', v: w.toUpperCase(), pos: start } : { t: 'id', v: w.toLowerCase(), pos: start });
    } else if (c === '"' || c === '`') {
      const end = sql.indexOf(c, i + 1);
      if (end < 0) throw new SqlError('Unclosed quoted name.', start);
      out.push({ t: 'id', v: sql.slice(i + 1, end).toLowerCase(), pos: start });
      i = end + 1;
    } else if (c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= sql.length) throw new SqlError('Unclosed string — add a closing quote.', start);
        if (sql[i] === "'") { if (sql[i + 1] === "'") { v += "'"; i += 2; continue; } i++; break; }
        v += sql[i++];
      }
      out.push({ t: 'str', v, pos: start });
    } else {
      const two = sql.slice(i, i + 2);
      if (['<=', '>=', '<>', '!=', '||'].includes(two)) { out.push({ t: 'op', v: two === '<>' ? '!=' : two, pos: start }); i += 2; }
      else if ('=<>*(),.+-/%;'.includes(c)) { out.push({ t: 'op', v: c, pos: start }); i++; }
      else throw new SqlError(`Unexpected character “${c}”.`, start);
    }
  }
  out.push({ t: 'end', v: '', pos: sql.length });
  return out;
}

/* ---------- Parser ---------- */
export type Expr =
  | { k: 'lit'; v: Value | boolean }
  | { k: 'col'; table?: string; name: string; pos: number }
  | { k: 'star'; table?: string }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'neg'; e: Expr }
  | { k: 'agg'; fn: string; arg: Expr | null; distinct: boolean }
  | { k: 'fn'; name: string; args: Expr[]; pos: number }
  | { k: 'in'; e: Expr; list: Expr[]; not: boolean }
  | { k: 'like'; e: Expr; pat: Expr; not: boolean }
  | { k: 'isnull'; e: Expr; not: boolean }
  | { k: 'between'; e: Expr; lo: Expr; hi: Expr; not: boolean };
export interface SelectItem { e: Expr; alias?: string; text: string }
export interface Query {
  distinct: boolean; items: SelectItem[];
  from: { table: string; alias: string; pos: number };
  joins: { table: string; alias: string; on: Expr; left: boolean; pos: number }[];
  where?: Expr; groupBy: Expr[]; having?: Expr; orderBy: { e: Expr; desc: boolean }[]; limit?: number; offset?: number;
}
const AGGS = new Set(['count', 'sum', 'avg', 'min', 'max']);
const FNS: Record<string, [number, number]> = { lower: [1, 1], upper: [1, 1], length: [1, 1], round: [1, 2], abs: [1, 1], coalesce: [1, 9], substr: [2, 3], trim: [1, 1] };

export function parse(sql: string): Query {
  if (WRITE.test(sql)) throw new SqlError('Only SELECT queries are supported — your data is read-only here.', 0);
  const toks = tokenize(sql);
  let i = 0;
  const peek = () => toks[i];
  const near = (t: Tok) => (t.t === 'end' ? 'the end of the query' : `“${t.t === 'str' ? `'${t.v}'` : t.v}”`);
  const isKw = (v: string) => peek().t === 'kw' && peek().v === v;
  const isOp = (v: string) => peek().t === 'op' && peek().v === v;
  const eatKw = (v: string) => (isKw(v) ? (i++, true) : false);
  const eatOp = (v: string) => (isOp(v) ? (i++, true) : false);
  const needKw = (v: string) => { if (!eatKw(v)) throw new SqlError(`Expected ${v} near ${near(peek())}.`, peek().pos); };
  const needOp = (v: string) => { if (!eatOp(v)) throw new SqlError(`Expected “${v}” near ${near(peek())}.`, peek().pos); };
  const ident = (what: string) => { const t = peek(); if (t.t !== 'id') throw new SqlError(`Expected ${what} near ${near(t)}.`, t.pos); i++; return t; };

  function primary(): Expr {
    const t = peek();
    if (t.t === 'num') { i++; return { k: 'lit', v: Number(t.v) }; }
    if (t.t === 'str') { i++; return { k: 'lit', v: t.v }; }
    if (eatKw('NULL')) return { k: 'lit', v: null };
    if (eatKw('TRUE')) return { k: 'lit', v: 1 };
    if (eatKw('FALSE')) return { k: 'lit', v: 0 };
    if (eatOp('(')) { const e = expr(); needOp(')'); return e; }
    if (eatOp('*')) return { k: 'star' };
    if (t.t === 'id') {
      i++;
      if (eatOp('(')) {
        if (AGGS.has(t.v)) {
          const distinct = eatKw('DISTINCT');
          let arg: Expr | null = null;
          if (eatOp('*')) { if (t.v !== 'count') throw new SqlError(`${t.v.toUpperCase()}(*) isn’t valid — name a column.`, t.pos); }
          else arg = expr();
          needOp(')');
          return { k: 'agg', fn: t.v, arg, distinct };
        }
        if (!FNS[t.v]) throw new SqlError(`Unknown function ${t.v.toUpperCase()}. Available: ${[...AGGS, ...Object.keys(FNS)].map((f) => f.toUpperCase()).join(', ')}.`, t.pos);
        const args: Expr[] = [];
        if (!isOp(')')) do args.push(expr()); while (eatOp(','));
        needOp(')');
        const [lo, hi] = FNS[t.v];
        if (args.length < lo || args.length > hi) throw new SqlError(`${t.v.toUpperCase()} takes ${lo === hi ? lo : `${lo}–${hi}`} argument${hi === 1 ? '' : 's'}.`, t.pos);
        return { k: 'fn', name: t.v, args, pos: t.pos };
      }
      if (eatOp('.')) {
        if (eatOp('*')) return { k: 'star', table: t.v };
        const c = ident('a column name');
        return { k: 'col', table: t.v, name: c.v, pos: t.pos };
      }
      return { k: 'col', name: t.v, pos: t.pos };
    }
    throw new SqlError(`Unexpected ${near(t)}.`, t.pos);
  }
  function unary(): Expr { if (eatOp('-')) return { k: 'neg', e: unary() }; return primary(); }
  function mul(): Expr { let l = unary(); while (isOp('*') || isOp('/') || isOp('%')) { const op = toks[i++].v; l = { k: 'bin', op, l, r: unary() }; } return l; }
  function add(): Expr { let l = mul(); while (isOp('+') || isOp('-') || isOp('||')) { const op = toks[i++].v; l = { k: 'bin', op, l, r: mul() }; } return l; }
  function cmp(): Expr {
    const l = add();
    if (['=', '!=', '<', '>', '<=', '>='].some((o) => isOp(o))) { const op = toks[i++].v; return { k: 'bin', op, l, r: add() }; }
    if (isKw('IS')) { i++; const not = eatKw('NOT'); needKw('NULL'); return { k: 'isnull', e: l, not }; }
    const not = isKw('NOT') && toks[i + 1].t === 'kw' && ['LIKE', 'IN', 'BETWEEN'].includes(toks[i + 1].v) ? (i++, true) : false;
    if (eatKw('LIKE')) return { k: 'like', e: l, pat: add(), not };
    if (eatKw('IN')) { needOp('('); const list: Expr[] = []; do list.push(add()); while (eatOp(',')); needOp(')'); return { k: 'in', e: l, list, not }; }
    if (eatKw('BETWEEN')) { const lo = add(); needKw('AND'); return { k: 'between', e: l, lo, hi: add(), not }; }
    return l;
  }
  function notE(): Expr { if (eatKw('NOT')) return { k: 'not', e: notE() }; return cmp(); }
  function andE(): Expr { let l = notE(); while (eatKw('AND')) l = { k: 'bin', op: 'and', l, r: notE() }; return l; }
  function expr(): Expr { let l = andE(); while (eatKw('OR')) l = { k: 'bin', op: 'or', l, r: andE() }; return l; }
  function alias(): string | undefined {
    if (eatKw('AS')) return ident('an alias').v;
    return peek().t === 'id' ? ident('an alias').v : undefined;
  }
  function source() { const t = ident('a table name'); return { table: t.v, alias: alias() ?? t.v, pos: t.pos }; }

  if (!eatKw('SELECT')) throw new SqlError(`Queries start with SELECT${peek().t === 'end' ? '' : `, not ${near(peek())}`}.`, peek().pos);
  const distinct = eatKw('DISTINCT');
  const items: SelectItem[] = [];
  do {
    const start = peek().pos;
    const e = expr();
    const end = toks[i - 1];
    const text = sql.slice(start, end.pos + (end.t === 'str' ? end.v.length + 2 : end.v.length)).trim();
    items.push({ e, alias: e.k === 'star' ? undefined : alias(), text });
  } while (eatOp(','));
  needKw('FROM');
  const from = source();
  const joins: Query['joins'] = [];
  for (;;) {
    const left = eatKw('LEFT'); if (left) eatKw('OUTER');
    const inner = !left && eatKw('INNER');
    if ((left || inner) && !isKw('JOIN')) throw new SqlError(`Expected JOIN near ${near(peek())}.`, peek().pos);
    if (!eatKw('JOIN')) break;
    const s = source(); needKw('ON'); joins.push({ ...s, on: expr(), left });
  }
  const where = eatKw('WHERE') ? expr() : undefined;
  const groupBy: Expr[] = [];
  if (eatKw('GROUP')) { needKw('BY'); do groupBy.push(expr()); while (eatOp(',')); }
  const having = eatKw('HAVING') ? expr() : undefined;
  const orderBy: Query['orderBy'] = [];
  if (eatKw('ORDER')) { needKw('BY'); do { const e = expr(); const desc = eatKw('DESC'); if (!desc) eatKw('ASC'); orderBy.push({ e, desc }); } while (eatOp(',')); }
  let limit: number | undefined, offset: number | undefined;
  const intAfter = (kw: string) => { const t = peek(); if (t.t !== 'num' || !/^\d+$/.test(t.v)) throw new SqlError(`${kw} needs a whole number.`, t.pos); i++; return Number(t.v); };
  if (eatKw('LIMIT')) { limit = intAfter('LIMIT'); if (eatKw('OFFSET')) offset = intAfter('OFFSET'); }
  const semi = eatOp(';');
  if (peek().t !== 'end') throw new SqlError(`Unexpected ${near(peek())}${semi ? ' — run one query at a time' : ''}.`, peek().pos);
  return { distinct, items, from, joins, where, groupBy, having, orderBy, limit, offset };
}

/* ---------- Evaluation ---------- */
interface Src { alias: string; table: Table }
type Row = (Value[] | null)[]; // one array per source (null for unmatched LEFT JOIN rows)
interface Ctx { srcs: Src[]; row: Row; group?: Row[]; out?: Record<string, Value> }

const truthy = (v: Value | boolean) => v !== null && v !== 0 && v !== '' && v !== false;
function toNum(v: Value): number | null { if (v === null) return null; if (typeof v === 'number') return v; const s = v.trim(); return NUM_RE.test(s) ? Number(s) : null; }
export function compare(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1; // nulls last
  const na = toNum(a), nb = toNum(b);
  if (typeof a === 'number' || typeof b === 'number') { if (na !== null && nb !== null) return na - nb; }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function likeRe(pat: string) { return new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\*]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'is'); }

function resolve(srcs: Src[], e: { table?: string; name: string; pos: number }): [number, number] {
  if (e.table) {
    const s = srcs.findIndex((x) => x.alias === e.table);
    if (s < 0) throw new SqlError(`No table or alias named ${e.table} in this query.`, e.pos);
    const c = srcs[s].table.columns.indexOf(e.name);
    if (c < 0) throw new SqlError(`No column ${e.name} in ${srcs[s].table.name}. Columns: ${srcs[s].table.columns.join(', ')}.`, e.pos);
    return [s, c];
  }
  const hits = srcs.map((s, si) => [si, s.table.columns.indexOf(e.name)] as [number, number]).filter(([, c]) => c >= 0);
  if (!hits.length) throw new SqlError(`No column named ${e.name}. Columns: ${srcs.map((s) => s.table.columns.map((c) => (srcs.length > 1 ? `${s.alias}.${c}` : c)).join(', ')).join('; ')}.`, e.pos);
  if (hits.length > 1) throw new SqlError(`Column ${e.name} is in more than one table — write ${hits.map(([si]) => `${srcs[si].alias}.${e.name}`).join(' or ')}.`, e.pos);
  return hits[0];
}

const hasAgg = (e: Expr | undefined): boolean => {
  if (!e) return false;
  switch (e.k) {
    case 'agg': return true;
    case 'bin': return hasAgg(e.l) || hasAgg(e.r);
    case 'not': case 'neg': case 'isnull': return hasAgg(e.e);
    case 'fn': return e.args.some(hasAgg);
    case 'in': return hasAgg(e.e) || e.list.some(hasAgg);
    case 'like': return hasAgg(e.e) || hasAgg(e.pat);
    case 'between': return hasAgg(e.e) || hasAgg(e.lo) || hasAgg(e.hi);
    default: return false;
  }
};

function evalE(e: Expr, c: Ctx): Value {
  switch (e.k) {
    case 'lit': return typeof e.v === 'boolean' ? (e.v ? 1 : 0) : e.v;
    case 'star': throw new SqlError('* can only be used on its own or in COUNT(*).');
    case 'col': {
      if (!e.table && c.out && e.name in c.out) return c.out[e.name];
      const [s, col] = resolve(c.srcs, e);
      return c.row[s]?.[col] ?? null;
    }
    case 'neg': { const n = toNum(evalE(e.e, c)); return n === null ? null : -n; }
    case 'not': { const v = evalE(e.e, c); return v === null ? null : truthy(v) ? 0 : 1; }
    case 'isnull': { const isNull = evalE(e.e, c) === null; return (e.not ? !isNull : isNull) ? 1 : 0; }
    case 'like': {
      const v = evalE(e.e, c), p = evalE(e.pat, c);
      if (v === null || p === null) return null;
      const m = likeRe(String(p)).test(String(v));
      return (e.not ? !m : m) ? 1 : 0;
    }
    case 'in': {
      const v = evalE(e.e, c);
      if (v === null) return null;
      const m = e.list.some((x) => { const w = evalE(x, c); return w !== null && compare(v, w) === 0; });
      return (e.not ? !m : m) ? 1 : 0;
    }
    case 'between': {
      const v = evalE(e.e, c), lo = evalE(e.lo, c), hi = evalE(e.hi, c);
      if (v === null || lo === null || hi === null) return null;
      const m = compare(v, lo) >= 0 && compare(v, hi) <= 0;
      return (e.not ? !m : m) ? 1 : 0;
    }
    case 'bin': {
      if (e.op === 'and') { const l = evalE(e.l, c); if (l !== null && !truthy(l)) return 0; const r = evalE(e.r, c); if (r !== null && !truthy(r)) return 0; return l === null || r === null ? null : 1; }
      if (e.op === 'or') { const l = evalE(e.l, c); if (l !== null && truthy(l)) return 1; const r = evalE(e.r, c); if (r !== null && truthy(r)) return 1; return l === null || r === null ? null : 0; }
      const l = evalE(e.l, c), r = evalE(e.r, c);
      if (l === null || r === null) return null;
      if (e.op === '||') return String(l) + String(r);
      if (['=', '!=', '<', '>', '<=', '>='].includes(e.op)) {
        const d = compare(l, r);
        const ok = e.op === '=' ? d === 0 : e.op === '!=' ? d !== 0 : e.op === '<' ? d < 0 : e.op === '>' ? d > 0 : e.op === '<=' ? d <= 0 : d >= 0;
        return ok ? 1 : 0;
      }
      const a = toNum(l), b = toNum(r);
      if (a === null || b === null) throw new SqlError(`Can’t do arithmetic with text (“${a === null ? l : r}”).`);
      if (e.op === '+') return a + b;
      if (e.op === '-') return a - b;
      if (e.op === '*') return a * b;
      if (b === 0) return null;
      return e.op === '/' ? a / b : a % b;
    }
    case 'fn': {
      const a = e.args.map((x) => evalE(x, c));
      switch (e.name) {
        case 'coalesce': return a.find((v) => v !== null) ?? null;
        case 'lower': return a[0] === null ? null : String(a[0]).toLowerCase();
        case 'upper': return a[0] === null ? null : String(a[0]).toUpperCase();
        case 'trim': return a[0] === null ? null : String(a[0]).trim();
        case 'length': return a[0] === null ? null : String(a[0]).length;
        case 'abs': { const n = toNum(a[0]); return n === null ? null : Math.abs(n); }
        case 'round': { const n = toNum(a[0]); const d = a[1] == null ? 0 : toNum(a[1]) ?? 0; if (n === null) return null; const f = 10 ** d; return Math.round(n * f) / f; }
        case 'substr': { if (a[0] === null) return null; const s = String(a[0]), st = (toNum(a[1]) ?? 1) - 1; return a[2] == null ? s.slice(st) : s.slice(st, st + (toNum(a[2]) ?? 0)); }
      }
      return null;
    }
    case 'agg': {
      if (!c.group) throw new SqlError(`${e.fn.toUpperCase()}() can’t be used in WHERE — use HAVING to filter groups.`);
      if (!e.arg) return c.group.length;
      let vals = c.group.map((row) => evalE(e.arg!, { ...c, row, group: undefined })).filter((v): v is string | number => v !== null);
      if (e.distinct) vals = [...new Map(vals.map((v) => [typeof v === 'number' ? `n${v}` : `s${v}`, v])).values()];
      if (e.fn === 'count') return vals.length;
      if (!vals.length) return null;
      if (e.fn === 'min') return vals.reduce((m, v) => (compare(v, m) < 0 ? v : m));
      if (e.fn === 'max') return vals.reduce((m, v) => (compare(v, m) > 0 ? v : m));
      const nums = vals.map(toNum).filter((n): n is number => n !== null);
      if (!nums.length) return null;
      const sum = nums.reduce((s, n) => s + n, 0);
      return e.fn === 'sum' ? Math.round(sum * 1e9) / 1e9 : Math.round((sum / nums.length) * 1e9) / 1e9;
    }
  }
}

/** Columns used outside aggregates must be grouped. */
function checkGrouped(e: Expr, groupKeys: string[], srcs: Src[]) {
  const visit = (x: Expr) => {
    if (x.k === 'agg' || x.k === 'lit') return;
    if (x.k === 'col') {
      const [s, c] = resolve(srcs, x);
      if (!groupKeys.includes(`${s}:${c}`)) throw new SqlError(`${x.table ? `${x.table}.` : ''}${x.name} must be in GROUP BY or inside an aggregate such as MAX(${x.name}).`, x.pos);
      return;
    }
    if (x.k === 'bin') { visit(x.l); visit(x.r); }
    else if (x.k === 'not' || x.k === 'neg' || x.k === 'isnull') visit(x.e);
    else if (x.k === 'fn') x.args.forEach(visit);
    else if (x.k === 'in') { visit(x.e); x.list.forEach(visit); }
    else if (x.k === 'like') { visit(x.e); visit(x.pat); }
    else if (x.k === 'between') { visit(x.e); visit(x.lo); visit(x.hi); }
  };
  visit(e);
}

export interface Result { columns: string[]; rows: Value[][]; scanned: number; ms: number }
export const MAX_JOIN = 2_000_000;

export function run(sql: string, tables: Table[]): Result {
  const t0 = performance.now();
  const q = parse(sql);
  const find = (name: string, pos: number) => {
    const t = tables.find((x) => x.name === name);
    if (!t) throw new SqlError(`No table named ${name}. ${tables.length ? `Tables: ${tables.map((x) => x.name).join(', ')}.` : 'Load a CSV first.'}`, pos);
    return t;
  };
  const srcs: Src[] = [{ alias: q.from.alias, table: find(q.from.table, q.from.pos) }];
  for (const j of q.joins) {
    if (srcs.some((x) => x.alias === j.alias)) throw new SqlError(`Two tables are called ${j.alias} — give one an alias, e.g. JOIN ${j.table} AS b.`, j.pos);
    srcs.push({ alias: j.alias, table: find(j.table, j.pos) });
  }

  // FROM / JOINs, left to right. Each row holds one array per source joined so far.
  let rows: Row[] = srcs[0].table.rows.map((r) => [r]);
  q.joins.forEach((j, ji) => {
    const n = ji + 1; // index of the source being joined
    const visible = srcs.slice(0, n + 1);
    const right = srcs[n].table.rows, on = j.on;
    const joined: Row[] = [];
    // Hash join when ON is a single equality between the new table and an earlier one.
    let hash: { leftSrc: number; leftCol: number; rightCol: number } | null = null;
    if (on.k === 'bin' && on.op === '=' && on.l.k === 'col' && on.r.k === 'col') {
      const a = resolve(visible, on.l), b = resolve(visible, on.r);
      if (a[0] === n && b[0] < n) hash = { leftSrc: b[0], leftCol: b[1], rightCol: a[1] };
      else if (b[0] === n && a[0] < n) hash = { leftSrc: a[0], leftCol: a[1], rightCol: b[1] };
    }
    const key = (v: Value) => String(toNum(v) ?? v);
    if (hash) {
      const idx = new Map<string, Value[][]>();
      for (const r of right) { const v = r[hash.rightCol]; if (v === null) continue; const k = key(v); const list = idx.get(k); if (list) list.push(r); else idx.set(k, [r]); }
      for (const row of rows) {
        const v = row[hash.leftSrc]?.[hash.leftCol] ?? null;
        const m = v === null ? undefined : idx.get(key(v));
        if (m) for (const r of m) joined.push([...row, r]);
        else if (j.left) joined.push([...row, null]);
      }
    } else {
      if (rows.length * right.length > MAX_JOIN) throw new SqlError(`That join would compare ${(rows.length * right.length).toLocaleString()} row pairs. Join on a single equality (a.id = b.id) or filter first.`, j.pos);
      for (const row of rows) {
        let any = false;
        for (const r of right) { if (truthy(evalE(on, { srcs: visible, row: [...row, r] }) ?? 0)) { joined.push([...row, r]); any = true; } }
        if (!any && j.left) joined.push([...row, null]);
      }
    }
    rows = joined;
  });
  const scanned = rows.length;
  if (q.where) {
    if (hasAgg(q.where)) throw new SqlError('Aggregates like COUNT() can’t be used in WHERE — use HAVING to filter groups.');
    rows = rows.filter((row) => truthy(evalE(q.where!, { srcs, row }) ?? 0));
  }

  // Expand * into columns.
  const items: SelectItem[] = q.items.flatMap((it) => {
    if (it.e.k !== 'star') return [it];
    const which = it.e.table ? srcs.filter((s) => s.alias === (it.e as { table?: string }).table) : srcs;
    if (!which.length) throw new SqlError(`No table or alias named ${it.e.table}.`);
    return which.flatMap((s) => s.table.columns.map((c) => ({ e: { k: 'col', table: s.alias, name: c, pos: 0 } as Expr, alias: srcs.length > 1 && srcs.every((o) => o === s || o.table.columns.includes(c)) ? `${s.alias}_${c}` : c, text: c })));
  });
  const names = items.map((it) => it.alias ?? (it.e.k === 'col' ? it.e.name : it.text));

  const grouped = q.groupBy.length > 0 || items.some((it) => hasAgg(it.e)) || hasAgg(q.having);
  type Out = { vals: Value[]; ctx: Ctx };
  let out: Out[];
  if (grouped) {
    const keys = q.groupBy.map((g) => (g.k === 'col' ? (() => { const [s, c] = resolve(srcs, g); return `${s}:${c}`; })() : ''));
    // A GROUP BY can name an output alias or position.
    const groupExprs = q.groupBy.map((g) => {
      if (g.k === 'lit' && typeof g.v === 'number') { const it = items[g.v - 1]; if (!it) throw new SqlError(`GROUP BY ${g.v} is out of range.`); return it.e; }
      if (g.k === 'col' && !g.table) { const ai = items.findIndex((it) => it.alias === g.name); if (ai >= 0 && !srcs.some((s) => s.table.columns.includes(g.name))) return items[ai].e; }
      return g;
    });
    for (const it of items) if (q.groupBy.length) checkGrouped(it.e, keys.concat(groupExprs.filter((g) => g.k === 'col').map((g) => { const [s, c] = resolve(srcs, g as never); return `${s}:${c}`; })), srcs);
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const k = JSON.stringify(groupExprs.map((g) => evalE(g, { srcs, row })));
      groups.set(k, [...(groups.get(k) ?? []), row]);
    }
    if (!q.groupBy.length && !groups.size) groups.set('[]', []);
    out = [...groups.values()].map((group) => {
      const ctx: Ctx = { srcs, row: group[0] ?? srcs.map(() => null), group };
      const vals = items.map((it) => evalE(it.e, ctx));
      ctx.out = Object.fromEntries(names.map((n, i) => [n, vals[i]]));
      return { vals, ctx };
    });
    if (q.having) out = out.filter((o) => truthy(evalE(q.having!, o.ctx) ?? 0));
  } else {
    if (q.having) throw new SqlError('HAVING needs GROUP BY or an aggregate.');
    out = rows.map((row) => {
      const ctx: Ctx = { srcs, row };
      const vals = items.map((it) => evalE(it.e, ctx));
      ctx.out = Object.fromEntries(names.map((n, i) => [n, vals[i]]));
      return { vals, ctx };
    });
  }

  if (q.distinct) {
    const seen = new Set<string>();
    out = out.filter((o) => { const k = JSON.stringify(o.vals); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (q.orderBy.length) {
    const keyed = out.map((o) => ({ o, ks: q.orderBy.map((ob) => (ob.e.k === 'lit' && typeof ob.e.v === 'number' ? o.vals[ob.e.v - 1] ?? null : evalE(ob.e, o.ctx))) }));
    keyed.sort((a, b) => { for (let i = 0; i < q.orderBy.length; i++) { const d = compare(a.ks[i], b.ks[i]); if (d) return q.orderBy[i].desc ? (a.ks[i] === null || b.ks[i] === null ? d : -d) : d; } return 0; });
    out = keyed.map((k) => k.o);
  }
  const start = q.offset ?? 0;
  const sliced = q.limit !== undefined ? out.slice(start, start + q.limit) : out.slice(start);
  return { columns: names, rows: sliced.map((o) => o.vals), scanned, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

/** Formats a cell for display: rounds long floats and shows NULL explicitly. */
export function display(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
  return v;
}
