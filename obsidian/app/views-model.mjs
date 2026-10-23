import { parseDocument, parse, stringify } from 'yaml';
import { getReferences, parseMarkdown, resolveLink } from '../core/vault.mjs';

export const basename = path => String(path).split('/').pop().replace(/\.(md|canvas|base)$/i, '');
export const fileExtension = path => String(path).split('.').pop().toLowerCase();
export const makeId = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function frontmatterDocument(text = '') {
  const source = String(text), opening = source.match(/^(\uFEFF?)---[ \t]*\r?\n/);
  const closing = opening ? source.slice(opening[0].length).match(/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m) : null;
  const present = !!(opening && closing), bodyOffset = present ? opening[0].length + closing.index + closing[0].length : 0;
  const yaml = present ? source.slice(opening[0].length, opening[0].length + closing.index) : '';
  const document = parseDocument(yaml || '{}', { uniqueKeys: true });
  let data = {}, error = opening && !closing ? 'YAML 属性缺少结束分隔线。' : document.errors[0]?.message || '';
  try { if (!error) { data = document.toJSON() || {}; safeDataValue(data); } } catch (e) { error = e.message; }
  if (Array.isArray(data) || typeof data !== 'object') error = '属性必须是 YAML 对象。';
  return { document, error, data: error ? {} : data, body: present ? source.slice(bodyOffset) : source.replace(/^\uFEFF/, ''), present, bom: opening?.[1] || (source[0] === '\uFEFF' ? '\uFEFF' : ''), newline: source.includes('\r\n') ? '\r\n' : '\n' };
}

export function writeFrontmatter(text, mutate) {
  const part = frontmatterDocument(text);
  if (part.error) throw new Error(part.error);
  mutate(part.document);
  const yaml = part.document.toString({ lineWidth: 0 }).trimEnd().replace(/\r?\n/g, part.newline);
  return `${part.bom}---${part.newline}${yaml}${part.newline}---${part.newline}${part.body}`;
}

export function graphData(files, { query = '', activePath, local = false, depth = 1, attachments = false, unresolved = true, orphans = true } = {}) {
  const paths = Object.keys(files);
  const accepted = path => /\.(md|canvas|base)$/i.test(path) || attachments;
  const map = new Map(paths.filter(accepted).map(path => [path, { id: path, label: basename(path), path, count: 0, missing: false }]));
  const links = [], pairs = new Set();
  for (const [path, content] of Object.entries(files)) {
    if (!/\.md$/i.test(path) || typeof content !== 'string') continue;
    let refs = [];
    try { refs = getReferences(content, path, paths); } catch { /* A malformed note should not hide other notes. */ }
    for (const ref of refs) {
      if (/^(https?:|mailto:|data:|#)/i.test(ref.link || '')) continue;
      let target = ref.path;
      if (!target && unresolved) {
        const link = String(ref.link || '').split('#')[0];
        if (!link) continue;
        target = `unresolved:${link}`;
        if (!map.has(target)) map.set(target, { id: target, path: link, label: basename(link), count: 0, missing: true });
      }
      if (!map.has(target) || !map.has(path) || target === path) continue;
      const key = [path, target].sort().join('\u0000');
      if (pairs.has(key)) continue;
      pairs.add(key); links.push({ source: path, target });
      map.get(path).count++; map.get(target).count++;
    }
  }
  let allowed = new Set(map.keys());
  if (local) {
    allowed = new Set(activePath && map.has(activePath) ? [activePath] : []);
    for (let step = 0; step < depth; step++) {
      const next = new Set(allowed);
      for (const edge of links) {
        if (allowed.has(edge.source)) next.add(edge.target);
        if (allowed.has(edge.target)) next.add(edge.source);
      }
      allowed = next;
    }
  }
  const q = query.toLocaleLowerCase().trim();
  const nodes = [...map.values()].filter(n => allowed.has(n.id) && (!q || n.path.toLocaleLowerCase().includes(q)) && (orphans || n.count));
  allowed = new Set(nodes.map(n => n.id));
  return { nodes, edges: links.filter(e => allowed.has(e.source) && allowed.has(e.target)) };
}

export function layoutGraph(nodes, edges) {
  const positions = new Map(nodes.map((node, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const radius = 24 * Math.sqrt(i + 1);
    return [node.id, { ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 }];
  }));
  const list = [...positions.values()];
  // Pairwise forces are bounded for large vaults; their initial spiral remains usable.
  const count = list.length, rounds = count > 400 ? 15 : 100;
  for (let step = 0; step < rounds; step++) {
    for (let i = 0; i < count; i++) {
      const a = list[i]; a.vx -= a.x * .001; a.vy -= a.y * .001;
      for (let j = i + 1; j < Math.min(count, i + (count > 400 ? 40 : count)); j++) {
        const b = list[j], dx = a.x - b.x || .1, dy = a.y - b.y || .1;
        const d = Math.max(36, dx * dx + dy * dy), force = Math.min(1.5, 100 / d);
        a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
      }
    }
    for (const edge of edges) {
      const a = positions.get(edge.source), b = positions.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 110) * .005;
      a.vx += dx / distance * force; a.vy += dy / distance * force;
      b.vx -= dx / distance * force; b.vy -= dy / distance * force;
    }
    for (const node of list) { node.vx *= .58; node.vy *= .58; node.x += node.vx; node.y += node.vy; }
  }
  return positions;
}

export function parseCanvas(value = '') {
  try {
    const data = value.trim() ? JSON.parse(value) : { nodes: [], edges: [] };
    if (!data || typeof data !== 'object' || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('Canvas 必须包含 nodes 和 edges 数组。');
    const ids = new Set();
    for (const node of data.nodes) {
      if (!node.id || ids.has(node.id) || !['text', 'file', 'link', 'group'].includes(node.type)) throw new Error('存在重复 ID 或不支持的节点类型。');
      if (![node.x, node.y, node.width, node.height].every(Number.isFinite) || node.width <= 0 || node.height <= 0) throw new Error(`节点 ${node.id} 的位置或尺寸无效。`);
      ids.add(node.id);
    }
    for (const edge of data.edges) if (!edge.id || !ids.has(edge.fromNode) || !ids.has(edge.toNode)) throw new Error('连线引用了不存在的节点。');
    return { data, error: '' };
  } catch (error) { return { data: null, error: error.message }; }
}

export const canvasColor = color => ({ 1: '#d96c75', 2: '#db9d61', 3: '#d3bd66', 4: '#76aa79', 5: '#64b2bd', 6: '#a58bd5' }[color] || (/^#[0-9a-f]{6}$/i.test(color || '') ? color : 'var(--border, #444)'));
export const canvasAnchor = (node, side = 'right') => ({ left: { x: node.x, y: node.y + node.height / 2 }, right: { x: node.x + node.width, y: node.y + node.height / 2 }, top: { x: node.x + node.width / 2, y: node.y }, bottom: { x: node.x + node.width / 2, y: node.y + node.height } }[side] || { x: node.x, y: node.y });

export function parseBase(value) {
  try {
    const config = parse(value || 'views:\n  - type: table\n    name: Table\n') || {};
    if (typeof config !== 'object' || Array.isArray(config)) throw new Error('Base 配置必须是 YAML 对象。');
    return { config, error: '' };
  } catch (e) { return { config: {}, error: e.message }; }
}
export const serializeBase = config => stringify(config, { lineWidth: 0 });

// The evaluator only traverses this AST and explicitly allowed values/methods.
// It never resolves JS globals, calls properties from source objects, or compiles code.
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const own = (object, key) => object != null && Object.hasOwn(object, key);
const assertKey = key => { if (forbiddenKeys.has(String(key))) throw new Error('禁止访问属性：' + key); return key; };
const fileRecords = new WeakMap(), recordSets = new WeakMap(), valueKinds = new WeakMap();
const typedValue = (kind, data) => { const result = { ...data }; valueKinds.set(result, kind); return Object.freeze(result); };
export const baseValueType = value => value == null ? 'null' : valueKinds.get(Object(value)) || (value instanceof Date ? 'date' : Array.isArray(value) ? 'list' : typeof value);
const isEmpty = value => value == null || value === '' || Array.isArray(value) && value.length === 0 || baseValueType(value) === 'object' && Object.keys(value).length === 0;
const valueKey = value => value == null ? 'null' : value instanceof Date ? 'date:' + value.getTime() : baseValueType(value) + ':' + JSON.stringify(safeDataValue(value));
const equal = (a, b) => valueKey(a) === valueKey(b);
const bounded = value => { if ((typeof value === 'string' || Array.isArray(value)) && value.length > 100000) throw new Error('表达式结果过大。'); return value; };
const numeric = value => { if (value !== null && typeof value === 'object' && !(value instanceof Date) || typeof value === 'function') throw new Error('需要数字、文本、布尔值或日期。'); const number = Number(value); if (!Number.isFinite(number)) throw new Error('需要有效数字。'); return number; };
function safeDataValue(value, state = { copies: new Map(), active: new Set(), count: 0 }, depth = 0) {
  if (++state.count > 30000 || depth > 100) throw new Error('属性数据嵌套或大小超出计算限制。');
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object') return null;
  if (value instanceof Date) return new Date(value);
  if (state.active.has(value)) throw new Error('属性数据包含循环引用。');
  if (state.copies.has(value)) return state.copies.get(value);
  const result = Array.isArray(value) ? [] : Object.create(null); state.copies.set(value, result); state.active.add(value);
  for (const key of Object.keys(value)) {
    if (forbiddenKeys.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, 'value') || typeof descriptor.value === 'function') continue;
    result[key] = safeDataValue(descriptor.value, state, depth + 1);
  }
  if (valueKinds.has(value)) valueKinds.set(result, valueKinds.get(value));
  state.active.delete(value); return result;
}

export function baseRecords(files, metadata = {}) {
  const paths = Object.keys(files);
  const records = Object.entries(files).map(([path, raw]) => {
    const text = typeof raw === 'string' ? raw : ''; let markdown = null;
    try { if (/\.md$/i.test(path)) markdown = parseMarkdown(text); } catch { /* Invalid metadata is reported by frontmatterDocument below. */ }
    const parsed = /\.md$/i.test(path) ? frontmatterDocument(text) : { data: {}, error: '' };
    const name = path.split('/').pop(), ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const record = { path, text, props: parsed.data, error: parsed.error, file: { name, basename: name.replace(/\.[^.]+$/, ''), path, ext, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', size: metadata[path]?.size ?? new TextEncoder().encode(text).length, properties: parsed.data, tags: markdown?.tags || [], links: [], embeds: [], backlinks: [] } };
    for (const key of ['ctime', 'mtime']) if (metadata[path]?.[key] != null) record.file[key] = new Date(metadata[path][key]);
    for (const ref of markdown?.references || []) {
      const link = typedValue('link', { path: resolveLink(ref.linkpath, path, paths) || ref.linkpath, display: ref.display || null });
      record.file[ref.kind === 'embed' ? 'embeds' : 'links'].push(link);
    }
    fileRecords.set(record.file, record); valueKinds.set(record.file, 'file');
    return record;
  });
  const byPath = new Map(records.map(record => [record.path, record]));
  for (const record of records) {
    recordSets.set(record, records);
    for (const link of [...record.file.links, ...record.file.embeds]) {
      const target = byPath.get(link.path);
      if (target && !target.file.backlinks.some(item => item.path === record.path)) target.file.backlinks.push(typedValue('link', { path: record.path }));
    }
  }
  return records;
}

const expressionCache = new Map();
export function parseBaseExpression(expression) {
  const text = String(expression).trim();
  if (!text) return { type: 'literal', value: true };
  if (text.length > 20000) throw new Error('表达式过长。');
  if (expressionCache.has(text)) return expressionCache.get(text);
  const tokens = []; let i = 0;
  const fail = message => { throw new Error(message + '（位置 ' + (i + 1) + '）'); };
  while (i < text.length) {
    const c = text[i]; if (/\s/.test(c)) { i++; continue; }
    if (tokens.length > 4096) fail('表达式过于复杂');
    if (c === '"' || c === "'") {
      const quote = c; let value = ''; i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] !== '\\') { value += text[i++]; continue; }
        i++; if (i >= text.length) fail('字符串未结束');
        const escape = text[i++];
        if (escape === 'u') { const hex = text.slice(i, i + 4); if (!/^[0-9a-f]{4}$/i.test(hex)) fail('Unicode 转义无效'); value += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        else value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'" })[escape] ?? escape;
      }
      if (text[i] !== quote) fail('字符串未结束'); i++; tokens.push({ type: 'literal', value }); continue;
    }
    const number = text.slice(i).match(/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) { tokens.push({ type: 'literal', value: numeric(number[0]) }); i += number[0].length; continue; }
    const name = text.slice(i).match(/^[\p{L}_$][\p{L}\p{N}_$]*/u);
    if (name) { const value = name[0]; tokens.push(/^(true|false|null)$/.test(value) ? { type: 'literal', value: value === 'null' ? null : value === 'true' } : { type: 'name', value }); i += value.length; continue; }
    const operator = text.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '>=', '<='].includes(operator)) { tokens.push({ type: operator }); i += 2; continue; }
    if ('+-*/%!><().,[]:{}'.includes(c)) { tokens.push({ type: c }); i++; continue; }
    fail('无法识别字符 ' + c);
  }
  tokens.push({ type: 'end' }); let cursor = 0, nesting = 0;
  const peek = () => tokens[cursor], take = type => { if (peek().type !== type) throw new Error('表达式需要 ' + type + '，实际为 ' + peek().type); return tokens[cursor++]; };
  const priorities = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
  function expressionAt(min = 0) {
    if (++nesting > 128) throw new Error('表达式嵌套过深。');
    let node, token = peek();
    if (['!', '-', '+'].includes(token.type)) { cursor++; node = { type: 'unary', operator: token.type, argument: expressionAt(7) }; }
    else if (token.type === 'literal') { cursor++; node = token; }
    else if (token.type === 'name') { cursor++; assertKey(token.value); node = { type: 'identifier', name: token.value }; }
    else if (token.type === '(') { cursor++; node = expressionAt(); take(')'); }
    else if (token.type === '[') {
      cursor++; const elements = [];
      while (peek().type !== ']') { elements.push(expressionAt()); if (peek().type !== ',') break; cursor++; }
      take(']'); node = { type: 'array', elements };
    } else if (token.type === '{') {
      cursor++; const entries = [];
      while (peek().type !== '}') { const key = peek(); if (!['name', 'literal'].includes(key.type) || typeof key.value !== 'string') throw new Error('对象属性名必须是文本。'); cursor++; assertKey(key.value); take(':'); entries.push([key.value, expressionAt()]); if (peek().type !== ',') break; cursor++; }
      take('}'); node = { type: 'object', entries };
    } else throw new Error('无效的表达式：' + token.type);
    while (true) {
      if (peek().type === '.') { cursor++; const key = take('name').value; assertKey(key); node = { type: 'member', object: node, property: { type: 'literal', value: key } }; continue; }
      if (peek().type === '[') { cursor++; const property = expressionAt(); take(']'); node = { type: 'member', object: node, property }; continue; }
      if (peek().type === '(') {
        cursor++; const args = [];
        while (peek().type !== ')') { args.push(expressionAt()); if (peek().type !== ',') break; cursor++; }
        take(')'); node = { type: 'call', callee: node, args }; continue;
      }
      const operator = peek().type, priority = priorities[operator];
      if (priority === undefined || priority < min) break;
      cursor++; node = { type: 'binary', operator, left: node, right: expressionAt(priority + 1) };
    }
    nesting--; return node;
  }
  const result = expressionAt(); take('end');
  if (expressionCache.size > 500) expressionCache.clear();
  expressionCache.set(text, result); return result;
}

function makeContext(record, options = {}) {
  const copies = new WeakMap();
  const cleanRecord = source => {
    if (!source) return null; if (copies.has(source)) return copies.get(source);
    const clean = { path: source.path, text: source.text, props: safeDataValue(source.props || {}), file: safeDataValue(source.file || {}) };
    clean.file.properties = clean.props; valueKinds.set(clean.file, 'file'); fileRecords.set(clean.file, clean); copies.set(source, clean); return clean;
  };
  return { record: cleanRecord(record), cleanRecord, options: { ...options, thisRecord: cleanRecord(options.thisRecord), ...(own(options, 'values') ? { values: safeDataValue(options.values) } : {}) }, formulas: options.formulas || {}, cache: new Map(), stack: new Set(), budget: { steps: 30000, output: 2000000 }, scope: Object.create(null), records: options.records || recordSets.get(record) || [record], now: new Date(options.now ?? Date.now()) };
}
function formulaValue(name, ctx) {
  assertKey(name);
  if (!own(ctx.formulas, name)) return null;
  if (ctx.cache.has(name)) return ctx.cache.get(name);
  if (ctx.stack.has(name)) throw new Error('公式循环引用：' + [...ctx.stack, name].join(' → '));
  if (ctx.stack.size > 100) throw new Error('公式依赖嵌套过深。');
  if (typeof ctx.formulas[name] !== 'string') throw new Error('公式必须是文本：' + name);
  ctx.stack.add(name);
  try { const value = interpret(parseBaseExpression(ctx.formulas[name]), { ...ctx, scope: Object.create(null) }); ctx.cache.set(name, value); return value; }
  finally { ctx.stack.delete(name); }
}
function noteValue(value) {
  if (typeof value === 'string' && /^\[\[[^\]\r\n]+\]\]$/.test(value)) { const [path, display] = value.slice(2, -2).split('|'); return typedValue('link', { path, display: display ?? null }); }
  if (Array.isArray(value)) return value.map(noteValue);
  return value;
}
function readProperty(object, key, ctx) {
  key = assertKey(key);
  if (object === ctx.formulas) return formulaValue(String(key), ctx);
  if (object == null) return null;
  if (object instanceof Date) {
    const fields = { year: 'getFullYear', month: 'getMonth', day: 'getDate', hour: 'getHours', minute: 'getMinutes', second: 'getSeconds', millisecond: 'getMilliseconds' };
    return own(fields, key) ? object[fields[key]]() + (key === 'month' ? 1 : 0) : null;
  }
  if (baseValueType(object) === 'file' && key === 'file') return object;
  if ((typeof object === 'string' || Array.isArray(object)) && key === 'length') return object.length;
  if (typeof object === 'string' || Array.isArray(object)) return /^(0|[1-9]\d*)$/.test(String(key)) ? object[Number(key)] ?? null : null;
  const descriptor = Object.getOwnPropertyDescriptor(Object(object), key);
  return descriptor && own(descriptor, 'value') && typeof descriptor.value !== 'function' ? noteValue(descriptor.value) : null;
}
function identifier(name, ctx) {
  assertKey(name);
  if (own(ctx.scope, name)) return ctx.scope[name];
  if (name === 'note') return ctx.record.props;
  if (name === 'file') return ctx.record.file;
  if (name === 'formula') return ctx.formulas;
  if (name === 'this') {
    if (!ctx.options.thisRecord) throw new Error('此 Base 未提供 this 文件上下文。');
    return { ...ctx.options.thisRecord.props, file: ctx.options.thisRecord.file };
  }
  if (name === 'values' && own(ctx.options, 'values')) return ctx.options.values;
  return readProperty(ctx.record.props, name, ctx);
}
function parseDuration(input) {
  if (baseValueType(input) === 'duration') return input;
  const match = String(input).trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(y|years?|M|months?|w|weeks?|d|days?|h|hours?|m|minutes?|s|seconds?)$/);
  if (!match) throw new Error('无效时长：' + input);
  const unit = match[2], amount = Number(match[1]);
  const months = /^(y|year)/.test(unit) ? amount * 12 : /^(M|month)/.test(unit) ? amount : 0;
  const factor = /^(w|week)/.test(unit) ? 604800000 : /^(d|day)/.test(unit) ? 86400000 : /^(h|hour)/.test(unit) ? 3600000 : /^(m|minute)/.test(unit) ? 60000 : /^(s|second)/.test(unit) ? 1000 : 0;
  return typedValue('duration', { months: numeric(months), milliseconds: numeric(amount * factor) });
}
function dateOffset(date, duration, direction) {
  const d = parseDuration(duration), result = new Date(date);
  if (d.months) { const day = result.getDate(); result.setDate(1); result.setMonth(result.getMonth() + d.months * direction); result.setDate(Math.min(day, new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate())); }
  result.setTime(result.getTime() + d.milliseconds * direction); if (!Number.isFinite(result.getTime())) throw new Error('日期超出有效范围。'); return result;
}
function formatDate(date, format) {
  const two = n => String(n).padStart(2, '0');
  const fields = { YYYY: String(date.getFullYear()), YY: String(date.getFullYear()).slice(-2), MM: two(date.getMonth() + 1), M: date.getMonth() + 1, DD: two(date.getDate()), D: date.getDate(), HH: two(date.getHours()), H: date.getHours(), mm: two(date.getMinutes()), m: date.getMinutes(), ss: two(date.getSeconds()), s: date.getSeconds(), SSS: String(date.getMilliseconds()).padStart(3, '0') };
  return String(format).replace(/\[[^\]]*\]|YYYY|SSS|YY|MM|DD|HH|mm|ss|M|D|H|m|s/g, token => token[0] === '[' ? token.slice(1, -1) : fields[token]);
}
function binary(operator, a, b) {
  if (operator === '==') return equal(a, b); if (operator === '!=') return !equal(a, b);
  if (operator === '<') return a < b; if (operator === '>') return a > b;
  if (operator === '<=') return a <= b; if (operator === '>=') return a >= b;
  if (a instanceof Date) {
    if (b instanceof Date && operator === '-') return a.getTime() - b.getTime();
    if (operator === '+' || operator === '-') return dateOffset(a, b, operator === '+' ? 1 : -1);
  }
  if (baseValueType(a) === 'duration') {
    if (operator === '*' || operator === '/') { const n = numeric(b); if (operator === '/' && n === 0) throw new Error('不能除以零。'); return typedValue('duration', { months: numeric(a.months * (operator === '*' ? n : 1 / n)), milliseconds: numeric(a.milliseconds * (operator === '*' ? n : 1 / n)) }); }
    if (operator === '+' || operator === '-') { const d = parseDuration(b), n = operator === '+' ? 1 : -1; return typedValue('duration', { months: numeric(a.months + d.months * n), milliseconds: numeric(a.milliseconds + d.milliseconds * n) }); }
  }
  if (operator === '+' && (typeof a === 'string' || typeof b === 'string')) return bounded(displayValue(a) + displayValue(b));
  const x = numeric(a), y = numeric(b);
  if ((operator === '/' || operator === '%') && !y) throw new Error('不能除以零。');
  return numeric(({ '+': () => x + y, '-': () => x - y, '*': () => x * y, '/': () => x / y, '%': () => x % y })[operator]());
}
function resolveFile(input, ctx) {
  if (baseValueType(input) === 'file') return input;
  const path = typeof input === 'string' ? input.replace(/^\[\[|\]\]$/g, '').split('|')[0] : input?.path;
  const resolved = resolveLink(path || '', ctx.record.path, ctx.records.map(record => record.path));
  return ctx.cleanRecord(ctx.records.find(record => record.path === resolved))?.file ?? null;
}
function callGlobal(name, args, ctx, callNode) {
  const arg = index => args[index] ? interpret(args[index], ctx) : null;
  if (name === 'if') return arg(0) ? arg(1) : arg(2);
  if (name === 'list') { const value = arg(0); return Array.isArray(value) ? value : [value]; }
  if (name === 'number') return numeric(arg(0));
  if (name === 'date') { const input = arg(0); const date = new Date(typeof input === 'string' ? input.replace(' ', 'T') + (/^\d{4}-\d{2}-\d{2}$/.test(input) ? 'T00:00:00' : '') : input); if (!Number.isFinite(date.getTime())) throw new Error('无效日期：' + input); return date; }
  if (name === 'duration') return parseDuration(arg(0));
  if (name === 'now') return new Date(ctx.now);
  if (name === 'today') { const date = new Date(ctx.now); date.setHours(0, 0, 0, 0); return date; }
  if (name === 'random') {
    const store = ctx.options.randomValues;
    if (!(store instanceof Map)) return Math.random();
    if (!store.has(ctx.record.path)) store.set(ctx.record.path, new WeakMap());
    const row = store.get(ctx.record.path); if (!row.has(callNode)) row.set(callNode, Math.random()); return row.get(callNode);
  }
  if (name === 'max' || name === 'min') return Math[name](...args.map(node => numeric(interpret(node, ctx))));
  if (name === 'file') return resolveFile(arg(0), ctx);
  if (name === 'link' || name === 'image' || name === 'icon' || name === 'html') { const value = arg(0); return typedValue(name, { path: value?.path ?? displayValue(value), display: args[1] ? displayValue(arg(1)) : null }); }
  if (name === 'escapeHTML') return displayValue(arg(0)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  throw new Error('不支持的函数：' + name);
}
function callMethod(value, name, args, ctx) {
  assertKey(name);
  const arg = index => args[index] ? interpret(args[index], ctx) : undefined;
  if (name === 'isEmpty') return isEmpty(value);
  if (name === 'isTruthy') return !!value;
  if (name === 'isType') return baseValueType(value) === arg(0);
  if (name === 'toString') return displayValue(value);
  if (value == null) throw new Error('空值无法调用 ' + name + '()');
  const type = baseValueType(value);
  if (type === 'file') {
    const record = fileRecords.get(value) || ctx.record;
    if (name === 'asLink') return typedValue('link', { path: value.path, display: args[0] ? displayValue(arg(0)) : null });
    if (name === 'inFolder') { const folder = displayValue(arg(0)).replace(/^\/+|\/+$/g, ''); return !folder || value.folder === folder || value.folder.startsWith(folder + '/'); }
    if (name === 'hasTag') return args.some(node => { const tag = displayValue(interpret(node, ctx)).replace(/^#/, ''); return (value.tags || []).some(item => item.replace(/^#/, '') === tag || item.replace(/^#/, '').startsWith(tag + '/')); });
    if (name === 'hasProperty') return own(record.props, assertKey(displayValue(arg(0))));
    if (name === 'hasLink') { const input = arg(0), target = resolveFile(input, ctx), path = target?.path ?? (typeof input === 'string' ? input.replace(/^\[\[|\]\]$/g, '') : input?.path); return [...(value.links || []), ...(value.embeds || [])].some(link => link.path === path || link.path.replace(/\.md$/, '') === String(path).replace(/\.md$/, '')); }
  }
  if (type === 'link') {
    if (name === 'asFile') return resolveFile(value, ctx);
    if (name === 'linksTo') { const file = resolveFile(value, ctx); return file ? callMethod(file, 'hasLink', args, ctx) : false; }
  }
  if (type === 'date') {
    if (name === 'date') { const date = new Date(value); date.setHours(0, 0, 0, 0); return date; }
    if (name === 'format') return formatDate(value, arg(0) ?? 'YYYY-MM-DD');
    if (name === 'time') return formatDate(value, 'HH:mm:ss');
    if (name === 'relative') { const delta = value - ctx.now, unit = Math.abs(delta) >= 86400000 ? 'day' : Math.abs(delta) >= 3600000 ? 'hour' : 'minute', factor = { day: 86400000, hour: 3600000, minute: 60000 }[unit]; return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(delta / factor), unit); }
  }
  if (type === 'string' || type === 'list') {
    const includes = entry => type === 'string' ? value.includes(displayValue(entry)) : value.some(item => equal(item, entry));
    if (name === 'contains') return includes(arg(0));
    if (name === 'containsAll') return args.every(node => includes(interpret(node, ctx)));
    if (name === 'containsAny') return args.some(node => includes(interpret(node, ctx)));
    if (name === 'slice') return value.slice(arg(0), arg(1));
    if (name === 'reverse') return type === 'string' ? [...value].reverse().join('') : [...value].reverse();
  }
  if (type === 'string') {
    if (name === 'lower') return value.toLowerCase(); if (name === 'upper') return value.toUpperCase();
    if (name === 'trim') return value.trim();
    if (name === 'title') return value.replace(/(^|\s)(\S)/gu, (_, space, letter) => space + letter.toUpperCase());
    if (name === 'startsWith') return value.startsWith(arg(0)); if (name === 'endsWith') return value.endsWith(arg(0));
    if (name === 'split') return bounded(value.split(arg(0), arg(1)));
    if (name === 'replace') {
      const pattern = displayValue(arg(0)), replacement = displayValue(arg(1)), parts = []; let offset = 0, length = 0;
      const expand = at => {
        const expanded = []; let start = 0, size = 0;
        for (const match of replacement.matchAll(/\$(\$|&|\x60|')/g)) {
          const text = replacement.slice(start, match.index), token = match[1], insert = token === '$' ? '$' : token === '&' ? pattern : token.charCodeAt(0) === 96 ? value.slice(0, at) : value.slice(at + pattern.length);
          size += text.length + insert.length; if (size > 100000) throw new Error('表达式结果过大。'); expanded.push(text, insert); start = match.index + match[0].length;
        }
        const tail = replacement.slice(start); if (size + tail.length > 100000) throw new Error('表达式结果过大。'); expanded.push(tail); return expanded.join('');
      };
      if (!pattern) { for (let at = 0; at <= value.length; at++) { const insert = expand(at); length += insert.length + (at < value.length ? 1 : 0); if (length > 100000) throw new Error('表达式结果过大。'); parts.push(insert, at < value.length ? value[at] : ''); } return parts.join(''); }
      while (true) { const at = value.indexOf(pattern, offset); if (at < 0) break; const part = value.slice(offset, at), insert = expand(at); length += part.length + insert.length; if (length > 100000) throw new Error('表达式结果过大。'); parts.push(part, insert); offset = at + pattern.length; }
      length += value.length - offset; if (length > 100000) throw new Error('表达式结果过大。'); parts.push(value.slice(offset)); return parts.join('');
    }
    if (name === 'repeat') { const count = numeric(arg(0)); if (count < 0 || count > 100000 || value.length * count > 100000) throw new Error('重复次数过大或无效。'); return value.repeat(count); }
  }
  if (type === 'number') {
    if (['abs', 'ceil', 'floor'].includes(name)) return Math[name](value);
    if (name === 'round') { const digits = arg(0) ?? 0; if (!Number.isInteger(digits) || Math.abs(digits) > 100) throw new Error('小数位数无效。'); const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }
    if (name === 'toFixed') return value.toFixed(arg(0) ?? 0);
  }
  if (type === 'list') {
    if (name === 'map' || name === 'filter' || name === 'reduce') {
      if (!args[0]) throw new Error(name + '() 需要表达式。');
      let accumulator = name === 'reduce' ? arg(1) ?? null : null;
      const result = [];
      for (let index = 0; index < value.length; index++) {
        const entry = value[index], local = { ...ctx, scope: { ...ctx.scope, value: entry, index, acc: accumulator } }, next = interpret(args[0], local);
        if (name === 'reduce') accumulator = next; else if (name === 'map') result.push(next); else if (next) result.push(entry);
      }
      return name === 'reduce' ? accumulator : bounded(result);
    }
    if (name === 'flat') {
      const result = []; const flatten = (items, depth = 0) => { if (depth > 100) throw new Error('列表嵌套过深。'); for (const item of items) { if (--ctx.budget.steps < 0 || result.length >= 100000) throw new Error('列表计算量过大。'); if (Array.isArray(item)) flatten(item, depth + 1); else result.push(item); } }; flatten(value); return result;
    }
    if (name === 'join') { const separator = arg(0) ?? ',', parts = value.map(displayValue); if (parts.reduce((length, part) => length + part.length, 0) + String(separator).length * Math.max(0, parts.length - 1) > 100000) throw new Error('表达式结果过大。'); return parts.join(separator); }
    if (name === 'sort') return [...value].sort(compareBaseValues);
    if (name === 'unique') return [...new Map(value.map(item => [valueKey(item), item])).values()];
    if (['sum', 'mean', 'median', 'min', 'max', 'stddev'].includes(name)) {
      const numbers = value.filter(item => typeof item === 'number' && Number.isFinite(item));
      if (!numbers.length) return name === 'sum' ? 0 : null;
      const total = numbers.reduce((sum, item) => sum + item, 0), mean = total / numbers.length;
      if (name === 'sum') return total; if (name === 'mean') return mean;
      if (name === 'min') return Math.min(...numbers); if (name === 'max') return Math.max(...numbers);
      if (name === 'stddev') return Math.sqrt(numbers.reduce((sum, item) => sum + (item - mean) ** 2, 0) / numbers.length);
      const ordered = [...numbers].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
    }
  }
  if (type === 'object') {
    if (name === 'keys') return Object.keys(value).filter(key => !forbiddenKeys.has(key));
    if (name === 'values') return Object.keys(value).filter(key => !forbiddenKeys.has(key)).map(key => value[key]);
    if (name === 'isEmpty') return Object.keys(value).length === 0;
  }
  throw new Error('不支持 ' + type + '.' + name + '()');
}
function interpret(node, ctx) {
  if (--ctx.budget.steps < 0) throw new Error('表达式计算量过大。');
  const value = bounded(interpretNode(node, ctx));
  if (typeof value === 'string' || Array.isArray(value)) { ctx.budget.output -= value.length; if (ctx.budget.output < 0) throw new Error('表达式累计结果过大。'); }
  return value;
}
function interpretNode(node, ctx) {
  if (node.type === 'literal') return node.value;
  if (node.type === 'identifier') return identifier(node.name, ctx);
  if (node.type === 'array') return node.elements.map(element => interpret(element, ctx));
  if (node.type === 'object') { const result = Object.create(null); for (const [key, entry] of node.entries) result[key] = interpret(entry, ctx); return result; }
  if (node.type === 'member') return readProperty(interpret(node.object, ctx), interpret(node.property, ctx), ctx);
  if (node.type === 'unary') { const value = interpret(node.argument, ctx); return node.operator === '!' ? !value : node.operator === '-' ? -numeric(value) : numeric(value); }
  if (node.type === 'binary') { const left = interpret(node.left, ctx); if (node.operator === '&&') return !!left && !!interpret(node.right, ctx); if (node.operator === '||') return !!left || !!interpret(node.right, ctx); return binary(node.operator, left, interpret(node.right, ctx)); }
  if (node.type === 'call') {
    if (node.callee.type === 'identifier') return callGlobal(node.callee.name, node.args, ctx, node);
    if (node.callee.type === 'member') return callMethod(interpret(node.callee.object, ctx), interpret(node.callee.property, ctx), node.args, ctx);
    throw new Error('只允许调用内置函数。');
  }
  throw new Error('无效的表达式节点。');
}
export function evaluateBaseExpression(expression, record, options = {}) { return interpret(parseBaseExpression(expression), makeContext(record, options)); }
export function propertyValue(record, property, options = {}) {
  if (typeof property !== 'string') throw new Error('属性名称必须是文本。');
  const ctx = makeContext(record, options);
  if (property.startsWith('formula.')) return formulaValue(property.slice(8), ctx);
  if (property.startsWith('file.')) return readProperty(ctx.record.file, property.slice(5), ctx);
  return readProperty(ctx.record.props, property.replace(/^note\./, ''), ctx);
}
export function matchesBaseFilter(filter, record, options = {}) {
  const ctx = makeContext(record, options); let depth = 0;
  function matches(item) {
    if (++depth > 100) throw new Error('筛选嵌套过深。');
    try {
      if (item == null) return true;
      if (typeof item === 'string') return !!interpret(parseBaseExpression(item), ctx);
      if (Array.isArray(item)) return item.every(matches);
      if (typeof item === 'object') {
        const keys = Object.keys(item);
        if (keys.length !== 1 || !['and', 'or', 'not'].includes(keys[0]) || !Array.isArray(item[keys[0]])) throw new Error('筛选对象必须包含一个 and、or 或 not 数组。');
        if (keys[0] === 'and') return item.and.every(matches);
        if (keys[0] === 'or') return item.or.some(matches);
        return !item.not.some(matches);
      }
      throw new Error('筛选条件必须是表达式或逻辑对象。');
    } finally { depth--; }
  }
  return matches(filter);
}
export function compareBaseValues(a, b) {
  if (equal(a, b)) return 0; if (a == null) return -1; if (b == null) return 1;
  if (a instanceof Date && b instanceof Date) return a - b;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return displayValue(a).localeCompare(displayValue(b), undefined, { numeric: true });
}
export function sortBaseRecords(records, sort = [], options = {}) {
  const prepared = records.map(record => ({ record, values: sort.map(item => propertyValue(record, item.property, options)) }));
  prepared.sort((a, b) => { for (let index = 0; index < sort.length; index++) { const difference = compareBaseValues(a.values[index], b.values[index]); if (difference) return difference * (sort[index].direction === 'DESC' ? -1 : 1); } return a.record.path.localeCompare(b.record.path); });
  return prepared.map(item => item.record);
}
export function groupBaseRecords(records, groupBy, groupOrder, options = {}) {
  if (!groupBy?.property) return [{ key: '', value: null, rows: records }];
  const groups = new Map();
  for (const record of records) { const value = propertyValue(record, groupBy.property, options), key = valueKey(value); if (!groups.has(key)) groups.set(key, { key, value, rows: [] }); groups.get(key).rows.push(record); }
  if (Array.isArray(groupOrder)) return [...new Map(groupOrder.map(value => { const key = valueKey(value); return [key, groups.get(key) || { key, value, rows: [] }]; })).values()];
  return [...groups.values()].sort((a, b) => compareBaseValues(a.value, b.value) * (groupBy.direction === 'DESC' ? -1 : 1));
}
export function summarizeBaseValues(name, values, options = {}) {
  const record = options.record || { path: '', props: {}, file: {} }, ctx = makeContext(record, { ...options, values });
  if (own(options.summaries || {}, name)) return interpret(parseBaseExpression(options.summaries[name]), ctx);
  if (name === 'Count') return values.length;
  if (name === 'Empty') return values.filter(isEmpty).length; if (name === 'Filled') return values.filter(value => !isEmpty(value)).length;
  if (name === 'Checked') return values.filter(value => value === true).length; if (name === 'Unchecked') return values.filter(value => value === false).length;
  if (name === 'Unique') return new Set(values.map(valueKey)).size;
  if (name === 'Earliest' || name === 'Latest') { const dates = values.filter(value => value instanceof Date || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)).map(value => new Date(value)).filter(value => Number.isFinite(+value)); return dates.length ? new Date(Math[name === 'Earliest' ? 'min' : 'max'](...dates.map(Number))) : null; }
  if (name === 'Range') { const numbers = values.filter(value => typeof value === 'number'); if (numbers.length) return Math.max(...numbers) - Math.min(...numbers); const early = summarizeBaseValues('Earliest', values), late = summarizeBaseValues('Latest', values); return early && late ? late - early : null; }
  const methods = { Average: 'mean', Min: 'min', Max: 'max', Sum: 'sum', Median: 'median', Stddev: 'stddev' };
  if (own(methods, name)) return callMethod(values, methods[name], [], ctx);
  throw new Error('未知汇总：' + name);
}
export function updateBaseProperty(text, property, value) {
  if (property.startsWith('file.') || property.startsWith('formula.')) throw new Error('文件属性与公式为只读。');
  const key = assertKey(property.replace(/^note\./, '')); if (!key) throw new Error('属性名不能为空。');
  return writeFrontmatter(text, document => document.set(key, value));
}
export const displayValue = value => {
  if (value == null) return '';
  if (value instanceof Date) return formatDate(value, value.getHours() || value.getMinutes() || value.getSeconds() ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD');
  const kind = baseValueType(value);
  if (['link', 'image', 'icon', 'html'].includes(kind)) return value.display ?? value.path;
  if (kind === 'file') return value.name;
  if (kind === 'duration') return value.months + ' months ' + value.milliseconds + ' ms';
  if (Array.isArray(value)) {
    const safe = safeDataValue(value), parts = safe.map(displayValue);
    if (parts.reduce((length, part) => length + part.length, 0) + Math.max(0, parts.length - 1) * 2 > 100000) throw new Error('显示内容过大。');
    return parts.join(', ');
  }
  return typeof value === 'object' ? JSON.stringify(safeDataValue(value)) : String(value);
};
