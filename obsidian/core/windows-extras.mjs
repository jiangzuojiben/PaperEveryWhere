/** Portable bookmark trees and explicit Markdown conversion plans. */
import { parseDocument } from 'yaml';
export const BOOKMARK_TYPES = ['file', 'heading', 'block', 'search', 'url', 'group'];

const text = value => typeof value === 'string' ? value : '';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => value && typeof value === 'object' ? structuredClone(value) : value;
const hash = value => {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return (result >>> 0).toString(36);
};

/** Obsidian stores heading/block bookmarks as file records with a subpath. */
export function bookmarkKind(item) {
  if (item?.type === 'file' && text(item.subpath).startsWith('#^')) return 'block';
  if (item?.type === 'file' && item.subpath && !/^#page=\d+(?:&|$)/i.test(item.subpath)) return 'heading';
  return item?.type || 'file';
}

export function bookmarkLabel(item) {
  if (text(item?.title).trim()) return item.title.trim();
  if (item?.type === 'group') return '未命名分组';
  if (item?.type === 'search') return item.query || '未命名搜索';
  if (item?.type === 'url') return item.url || '未命名网页';
  const name = text(item?.path).replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') || '未命名书签';
  return item?.subpath ? `${name} ${item.subpath}` : name;
}

export function bookmarkTarget(item) {
  if (item?.type === 'url') return text(item.url);
  if (item?.type === 'search') return text(item.query);
  if (item?.type === 'group') return '';
  return text(item?.path) + text(item?.subpath);
}

/** Stable ids make migration safe to repeat before the caller persists it. */
export function normalizeBookmarks(value) {
  const ids = new Set(), parents = new WeakSet();
  const visit = (items, trail = '') => {
    if (!Array.isArray(items)) return [];
    if (parents.has(items)) throw new Error('书签分组不能形成循环。');
    parents.add(items);
    const result = [];
    for (const [index, input] of items.entries()) {
      if (typeof input !== 'string' && (!input || typeof input !== 'object' || Array.isArray(input))) continue;
      const item = typeof input === 'string' ? { type: 'file', path: input } : { ...input };
      item.type ||= Array.isArray(item.items) ? 'group' : item.url ? 'url' : own(item, 'query') ? 'search' : 'file';
      if (['file', 'heading', 'block'].includes(item.type)) {
        item.path = text(item.path).replace(/\\/g, '/');
        item.subpath = text(item.subpath);
        if (item.subpath && !item.subpath.startsWith('#')) item.subpath = `#${item.subpath}`;
        item.type = 'file';
      }
      if (item.type === 'url') item.url = text(item.url);
      if (item.type === 'search') item.query = text(item.query);
      item.title = text(item.title);
      const seed = `${trail}/${index}:${item.type}:${bookmarkTarget(item)}:${item.title}`;
      let id = text(item.id).trim() || `bookmark-${hash(seed)}`;
      const base = id;
      for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
      ids.add(id); item.id = id;
      if (item.type === 'group') {
        item.items = visit(item.items || [], `${trail}/${index}`);
        if (typeof item.collapsed !== 'boolean') item.collapsed = item.expanded === false;
      }
      result.push(item);
    }
    parents.delete(items);
    return result;
  };
  return visit(value);
}

export function flattenBookmarks(items) {
  const result = [];
  const visit = (list, parentId = null, depth = 0) => {
    for (const [index, item] of list.entries()) {
      result.push({ item, parentId, index, depth });
      if (item.type === 'group') visit(item.items || [], item.id, depth + 1);
    }
  };
  visit(items || []);
  return result;
}

export function validateBookmark(item) {
  if (!item || !BOOKMARK_TYPES.includes(item.type)) return '请选择有效的书签类型。';
  if (item.type === 'group') return text(item.title).trim() ? '' : '请填写分组名称。';
  if (item.type === 'search') return text(item.query).trim() ? '' : '请填写搜索内容。';
  if (item.type === 'url') {
    try {
      const url = new URL(text(item.url).trim());
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return '网页书签仅支持 http、https 或 mailto 地址。';
      return '';
    } catch { return '请填写完整、有效的网页地址。'; }
  }
  const path = text(item.path).trim().replace(/\\/g, '/');
  if (!path) return '请选择一个文件。';
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path) || path.split('/').some(part => part === '..') || /[\r\n\0]/.test(path)) return '请输入知识库内的相对文件路径。';
  const kind = bookmarkKind(item);
  if (kind === 'heading' && !/^#[^^\s][^\r\n]*$/.test(text(item.subpath))) return '请填写标题名称。';
  if (kind === 'block' && !/^#\^[\p{L}\p{N}-]+$/u.test(text(item.subpath))) return '块标识只能包含字母、数字或连字符。';
  return '';
}

function locate(items, id) {
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.id === id) return { item, list: items, index };
    if (item.type === 'group') { const nested = locate(item.items || [], id); if (nested) return nested; }
  }
  return null;
}

function destination(items, parentId) {
  if (parentId == null || parentId === '') return items;
  const parent = locate(items, parentId)?.item;
  if (!parent || parent.type !== 'group') throw new Error('找不到目标书签分组。');
  return parent.items;
}

function insert(items, item, parentId, index) {
  const list = destination(items, parentId);
  const position = Number.isFinite(index) ? Math.max(0, Math.min(list.length, Math.trunc(index))) : list.length;
  list.splice(position, 0, item);
  return items;
}

export function addBookmark(items, input, parentId = null, index = Infinity) {
  const item = { ...input, id: input?.id || globalThis.crypto?.randomUUID?.() || `bookmark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
  if (item.type === 'group') item.items ||= [];
  const error = validateBookmark(item);
  if (error) throw new Error(error);
  const next = normalizeBookmarks(items);
  if (locate(next, item.id)) throw new Error('书签标识已存在。');
  return insert(next, normalizeBookmarks([clone(item)])[0], parentId, index);
}

export function updateBookmark(items, id, patch) {
  const next = normalizeBookmarks(items), match = locate(next, id);
  if (!match) throw new Error('此书签已不存在。');
  if (patch.type && bookmarkKind({ ...match.item, ...patch }) !== bookmarkKind(match.item)) throw new Error('编辑书签时不能更改类型。');
  const changed = { ...match.item, ...clone(patch), id: match.item.id };
  // Moving a group is separate from editing its label and collapse state.
  if (match.item.type === 'group') changed.items = match.item.items;
  const error = validateBookmark(changed);
  if (error) throw new Error(error);
  match.list[match.index] = normalizeBookmarks([changed])[0];
  return next;
}

export function removeBookmark(items, id) {
  const next = normalizeBookmarks(items), match = locate(next, id);
  if (!match) throw new Error('此书签已不存在。');
  match.list.splice(match.index, 1);
  return next;
}

/** index is the insertion position after the item has been removed. */
export function moveBookmark(items, id, parentId = null, index = Infinity) {
  const next = normalizeBookmarks(items), match = locate(next, id);
  if (!match) throw new Error('此书签已不存在。');
  if (match.item.type === 'group' && (parentId === id || flattenBookmarks(match.item.items).some(row => row.item.id === parentId))) throw new Error('不能将分组移入自身或它的子分组。');
  destination(next, parentId); // Validate before removing anything.
  match.list.splice(match.index, 1);
  return insert(next, match.item, parentId, index);
}

export function remapBookmarks(items, oldPath, newPath) {
  const from = text(oldPath).replace(/\\/g, '/').replace(/\/$/, ''), to = text(newPath).replace(/\\/g, '/').replace(/\/$/, '');
  if (!from || !to) throw new Error('书签路径更新需要原路径和新路径。');
  const tree = normalizeBookmarks(items);
  const visit = list => list.map(item => {
    if (item.type === 'group') return { ...item, items: visit(item.items) };
    if (item.type !== 'file') return item;
    return item.path === from || item.path.startsWith(`${from}/`) ? { ...item, path: to + item.path.slice(from.length) } : item;
  });
  return visit(tree);
}

export function hasFileBookmark(items, path) {
  const target = normalizeBookmarks([text(path)])[0];
  if (!target?.path) return false;
  return flattenBookmarks(normalizeBookmarks(items)).some(({ item }) => item.type === 'file' && item.path === target.path && (item.subpath || '') === (target.subpath || ''));
}

export function toggleFileBookmark(items, path) {
  let tree = normalizeBookmarks(items);
  const target = normalizeBookmarks([text(path)])[0];
  const error = validateBookmark(target);
  if (error) throw new Error(error);
  const matches = flattenBookmarks(tree).filter(({ item }) => item.type === 'file' && item.path === target.path && (item.subpath || '') === (target.subpath || ''));
  if (matches.length) for (const { item } of matches) tree = removeBookmark(tree, item.id);
  else tree = addBookmark(tree, { type: 'file', path: target.path, subpath: target.subpath, title: '' });
  return tree;
}

export function splitSlides(value = '') {
  const source = String(value).replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end >= 0) start = end + 1;
  }
  const slides = [], current = [];
  let fence = null;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index], marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], size: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.size && !marker[2].trim()) fence = null;
    }
    if (!fence && /^ {0,3}---[ \t]*$/.test(line)) { slides.push(current.join('\n')); current.length = 0; }
    else current.push(line);
  }
  slides.push(current.join('\n'));
  return slides.length ? slides : [''];
}

export const MARKDOWN_CONVERSION_OPTIONS = [
  { id: 'roamTags', name: 'Roam 标签', description: '#标签、#[[标签]] → [[标签]]' },
  { id: 'roamHighlight', name: 'Roam 高亮', description: '^^高亮^^ → ==高亮==' },
  { id: 'roamTodo', name: 'Roam 待办', description: '{{[[TODO]]}} → [ ]；{{[[DONE]]}} → [x]' },
  { id: 'bearHighlight', name: 'Bear 高亮', description: '::高亮:: → ==高亮==' },
  { id: 'zettelkastenLinks', name: '展开 Zettelkasten UID 链接', description: '[[202001010101]] → [[202001010101 标题]]' },
  { id: 'zettelkastenAliases', name: '美化 Zettelkasten 显示名称', description: '[[202001010101 标题]] → [[202001010101 标题|标题]]' },
  { id: 'frontmatter', name: '规范属性格式', description: '迁移 tags、aliases、cssclasses 的旧格式' },
];

function escapedAt(source, index) {
  let slashes = 0;
  while (index > 0 && source[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

// The observed converter changes fenced code contents, but preserves inline code.
function convertOutsideInlineCode(source, transform) {
  const lines = source.split(/(?<=\n)/);
  let fence = null, pending = '', output = '';
  const inline = line => {
    let result = '', offset = 0, plainStart = 0;
    while (offset < line.length) {
      if (line[offset] !== '`' || escapedAt(line, offset)) { offset++; continue; }
      const run = /^`+/.exec(line.slice(offset))[0];
      let end = offset + run.length;
      while ((end = line.indexOf(run, end)) >= 0 && (line[end - 1] === '`' || line[end + run.length] === '`')) end += run.length;
      if (end < 0) { offset += run.length; continue; }
      result += transform(line.slice(plainStart, offset)) + line.slice(offset, end + run.length);
      offset = end + run.length; plainStart = offset;
    }
    return result + transform(line.slice(plainStart));
  };
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)(\r?\n)?$/);
    if (marker && (!fence || marker[1][0] === fence.character && marker[1].length >= fence.size && !marker[2].trim())) {
      output += inline(pending) + line; pending = '';
      fence = fence ? null : { character: marker[1][0], size: marker[1].length };
    } else pending += line;
  }
  return output + inline(pending);
}

function frontmatterParts(source) {
  const match = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$))/.exec(source);
  return match ? { opening: match[1], yaml: match[2], closing: match[3], body: source.slice(match[0].length) } : null;
}

function migrateFrontmatter(parts, counts, warnings) {
  if (!parts) return '';
  let document;
  try { document = parseDocument(parts.yaml, { uniqueKeys: true }); }
  catch (error) { warnings.push(`属性格式未转换：${error.message}`); return parts.opening + parts.yaml + parts.closing; }
  if (document.errors.length) { warnings.push(`属性格式未转换：${document.errors[0].message}`); return parts.opening + parts.yaml + parts.closing; }
  const values = document.toJS({ maxAliasCount: 100 });
  if (!values || typeof values !== 'object' || Array.isArray(values)) return parts.opening + parts.yaml + parts.closing;
  let changed = 0;
  for (const [legacy, canonical] of [['tag', 'tags'], ['alias', 'aliases'], ['cssclass', 'cssclasses']]) {
    if (own(values, legacy) && own(values, canonical)) { warnings.push(`属性 ${legacy} 与 ${canonical} 同时存在，已保留原文以避免覆盖。`); continue; }
    const key = own(values, canonical) ? canonical : own(values, legacy) ? legacy : null;
    if (!key) continue;
    const value = values[key];
    if (!Array.isArray(value) && typeof value !== 'string') continue;
    const array = Array.isArray(value) ? value : value.split(canonical === 'aliases' ? /,/ : /[,\s]+/).map(item => item.trim()).filter(Boolean);
    if (key !== canonical || !Array.isArray(value)) {
      document.set(canonical, array);
      if (key !== canonical) document.delete(key);
      changed++;
    }
  }
  if (!changed) return parts.opening + parts.yaml + parts.closing;
  counts.set('frontmatter', changed);
  const ending = parts.opening.endsWith('\r\n') ? '\r\n' : '\n';
  return parts.opening + document.toString({ singleQuote: true }).replace(/\r?\n/g, ending).replace(/(?:\r?\n)$/, '') + parts.closing;
}

/** Pure conversion, with every option opt-in. No filesystem access or writes. */
export function convertMarkdownFormat(value, options = {}, { paths = [] } = {}) {
  const source = String(value ?? ''), counts = new Map(), warnings = [];
  const count = (type, amount = 1) => counts.set(type, (counts.get(type) || 0) + amount);
  const knownUids = new Map();
  for (const path of paths) {
    if (typeof path !== 'string' || !/\.md$/i.test(path)) continue;
    const name = path.replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '');
    const match = /^(\d{12,14})[ _-]+(.+)$/.exec(name);
    if (!match) continue;
    const targets = knownUids.get(match[1]) || [];
    targets.push({ name, path: path.replace(/\\/g, '/').replace(/\.md$/i, ''), title: match[2] }); knownUids.set(match[1], targets);
  }
  const transform = raw => {
    let result = raw;
    if (options.roamTags) {
      result = result.replace(/(^|[\s([{])#\[\[([^\]\r\n]+)\]\]/gu, (whole, prefix, tag, offset, text) => {
        if (escapedAt(text, offset + prefix.length)) return whole;
        count('roamTags'); return `${prefix}[[${tag}]]`;
      }).replace(/(^|[\s([{])#([\p{L}\p{N}_/-]+)/gu, (whole, prefix, tag, offset, text) => {
        if (escapedAt(text, offset + prefix.length)) return whole;
        count('roamTags'); return `${prefix}[[${tag}]]`;
      });
    }
    if (options.roamHighlight) result = result.replace(/\^\^([^\r\n]+?)\^\^/g, (whole, content, offset, text) => { if (escapedAt(text, offset)) return whole; count('roamHighlight'); return `==${content}==`; });
    if (options.roamTodo) result = result.replace(/\{\{\[\[(TODO|DONE)\]\]\}\}/g, (whole, status, offset, text) => { if (escapedAt(text, offset)) return whole; count('roamTodo'); return status === 'DONE' ? '[x]' : '[ ]'; });
    if (options.bearHighlight) result = result.replace(/::([^\r\n]+?)::/g, (whole, content, offset, text) => { if (escapedAt(text, offset)) return whole; count('bearHighlight'); return `==${content}==`; });
    if (options.zettelkastenLinks) result = result.replace(/\[\[(\d{12,14})\]\]/g, (whole, uid, offset, text) => {
      if (escapedAt(text, offset)) return whole;
      const targets = knownUids.get(uid) || [];
      if (targets.length !== 1) { if (targets.length > 1) warnings.push(`UID ${uid} 对应多个文件，已保留原链接。`); return whole; }
      count('zettelkastenLinks'); return `[[${targets[0].path}]]`;
    });
    if (options.zettelkastenAliases) result = result.replace(/\[\[([^\]\r\n|#]+)\]\]/g, (whole, target, offset, text) => {
      if (escapedAt(text, offset)) return whole;
      const match = /^(\d{12,14})[ _-]+(.+)$/.exec(target.split('/').pop());
      if (!match) return whole;
      count('zettelkastenAliases'); return `[[${target}|${match[2]}]]`;
    });
    return result;
  };
  const parts = frontmatterParts(source);
  const prefix = parts ? options.frontmatter ? migrateFrontmatter(parts, counts, warnings) : parts.opening + parts.yaml + parts.closing : '';
  const converted = prefix + convertOutsideInlineCode(parts?.body ?? source, transform);
  return { text: converted, changed: converted !== source, changes: MARKDOWN_CONVERSION_OPTIONS.filter(option => counts.has(option.id)).map(option => ({ type: option.id, label: option.name, count: counts.get(option.id) })), warnings: [...new Set(warnings)] };
}

/** A plan can only contain paths that the caller explicitly selected. */
export function createMarkdownConversionPlan(files, selectedPaths, options = {}) {
  if (!Array.isArray(selectedPaths) || !selectedPaths.length) throw new Error('请先明确选择要转换的 Markdown 文件。');
  if (!MARKDOWN_CONVERSION_OPTIONS.some(option => options[option.id] === true)) throw new Error('请至少选择一种格式转换。');
  const selected = [...new Set(selectedPaths)];
  const rows = selected.map(path => {
    if (typeof path !== 'string' || !/\.md$/i.test(path) || !own(files || {}, path) || typeof files[path] !== 'string') throw new Error(`无法读取所选 Markdown 文件：${String(path)}`);
    const before = files[path], result = convertMarkdownFormat(before, options, { paths: Object.keys(files) });
    return { path, before, after: result.text, changes: result.changes, warnings: result.warnings, changed: result.changed };
  });
  return { selectedPaths: selected, rows, changes: rows.filter(row => row.changed), options: Object.fromEntries(MARKDOWN_CONVERSION_OPTIONS.map(option => [option.id, options[option.id] === true])) };
}
