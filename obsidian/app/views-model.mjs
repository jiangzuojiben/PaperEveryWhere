import { parseDocument, parse, stringify } from 'yaml';
import { getReferences } from '../core/vault.mjs';

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
  try { if (!error) data = document.toJSON() || {}; } catch (e) { error = e.message; }
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

function splitOutside(text, separator) {
  let depth = 0, quote = '', start = 0; const result = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') depth++; if (c === ')' || c === ']') depth--;
    if (!depth && text.slice(i, i + separator.length) === separator) { result.push(text.slice(start, i).trim()); start = i + separator.length; i += separator.length - 1; }
  }
  if (result.length) { result.push(text.slice(start).trim()); return result; }
  return null;
}

export function baseRecords(files) {
  return Object.entries(files).map(([path, text]) => {
    const props = /\.md$/i.test(path) ? frontmatterDocument(text).data : {};
    return { path, text, props, file: { name: basename(path), basename: basename(path), path, ext: fileExtension(path), folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', size: new TextEncoder().encode(text || '').length } };
  });
}

export function propertyValue(record, property) {
  if (property.startsWith('file.')) return record.file[property.slice(5)];
  const key = property.replace(/^note\./, '');
  return record.props[key];
}

export function evaluateBaseExpression(expression, record) {
  let expr = String(expression).trim();
  if (!expr) return true;
  if (expr.startsWith('(') && expr.endsWith(')')) {
    let level = 0, complete = true, quote = '';
    for (let i = 0; i < expr.length - 1; i++) { const c = expr[i]; if (quote) { if (c === quote && expr[i - 1] !== '\\') quote = ''; continue; } if (c === '"' || c === "'") { quote = c; continue; } if (c === '(') level++; if (c === ')') level--; if (!level) { complete = false; break; } }
    if (complete) return evaluateBaseExpression(expr.slice(1, -1), record);
  }
  for (const op of ['||', '&&']) { const parts = splitOutside(expr, op); if (parts) return op === '||' ? parts.some(p => !!evaluateBaseExpression(p, record)) : parts.every(p => !!evaluateBaseExpression(p, record)); }
  for (const op of ['==', '!=', '>=', '<=', '>', '<']) {
    const parts = splitOutside(expr, op);
    if (parts?.length === 2) {
      const a = evaluateBaseExpression(parts[0], record), b = evaluateBaseExpression(parts[1], record);
      return ({ '==': () => a === b, '!=': () => a !== b, '>=': () => a >= b, '<=': () => a <= b, '>': () => a > b, '<': () => a < b })[op]();
    }
  }
  if (expr.startsWith('!')) return !evaluateBaseExpression(expr.slice(1), record);
  if (/^(true|false|null)$/.test(expr)) return JSON.parse(expr);
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  if (/^(["']).*\1$/s.test(expr)) { if (expr[0] === '"') return JSON.parse(expr); return expr.slice(1, -1).replaceAll("\\'", "'"); }
  if (expr.startsWith('[') && expr.endsWith(']')) return parse(expr);
  const method = expr.match(/^(.+)\.(contains|startsWith|endsWith|isEmpty|containsAny|containsAll)\((.*)\)$/s);
  if (method) {
    const value = evaluateBaseExpression(method[1], record), arg = method[3] ? evaluateBaseExpression(method[3], record) : null;
    if (method[2] === 'isEmpty') return value == null || value === '' || (Array.isArray(value) && !value.length);
    if (method[2] === 'contains') return Array.isArray(value) ? value.includes(arg) : String(value ?? '').includes(String(arg));
    if (method[2] === 'startsWith') return String(value ?? '').startsWith(String(arg));
    if (method[2] === 'endsWith') return String(value ?? '').endsWith(String(arg));
    const args = Array.isArray(arg) ? arg : [arg];
    return method[2] === 'containsAny' ? args.some(v => (value || []).includes(v)) : args.every(v => (value || []).includes(v));
  }
  const fn = expr.match(/^file\.(inFolder|hasTag|hasLink)\((.*)\)$/s);
  if (fn) {
    const arg = String(evaluateBaseExpression(fn[2], record));
    if (fn[1] === 'inFolder') { const folder = arg.replace(/^\/+|\/+$/g, ''); return record.file.folder === folder || record.file.folder.startsWith(folder + '/'); }
    if (fn[1] === 'hasTag') { const tags = Array.isArray(record.props.tags) ? record.props.tags : String(record.props.tags || '').split(/[, ]+/); const tag = arg.replace(/^#/, ''); return tags.some(t => String(t).replace(/^#/, '') === tag) || new RegExp(`(^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$|/)`, 'm').test(record.text); }
    if (fn[1] === 'hasLink') return record.text.includes(`[[${arg}]]`) || record.text.includes(`[[${arg}|`) || record.text.includes(`](${arg})`);
  }
  if (/^(?:file\.|note\.)?[\p{L}\p{N}_\- .]+$/u.test(expr)) return propertyValue(record, expr);
  const bracket = expr.match(/^(?:note|file)\[(".*"|'.*')\]$/s);
  if (bracket) return propertyValue(record, `${expr.startsWith('file') ? 'file.' : ''}${evaluateBaseExpression(bracket[1], record)}`);
  throw new Error(`暂不支持此表达式：${expr}`);
}

export function matchesBaseFilter(filter, record) {
  if (filter == null) return true;
  if (typeof filter === 'string') return !!evaluateBaseExpression(filter, record);
  if (Array.isArray(filter)) return filter.every(item => matchesBaseFilter(item, record));
  if (typeof filter === 'object') {
    if (filter.and) return filter.and.every(item => matchesBaseFilter(item, record));
    if (filter.or) return filter.or.some(item => matchesBaseFilter(item, record));
    if (filter.not) return !(Array.isArray(filter.not) ? filter.not.every(item => matchesBaseFilter(item, record)) : matchesBaseFilter(filter.not, record));
  }
  throw new Error('此筛选配置尚不受支持。');
}

export const displayValue = value => value == null ? '' : Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
