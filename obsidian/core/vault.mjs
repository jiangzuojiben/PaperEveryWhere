import { parseDocument } from 'yaml';

/** Pure vault operations. Paths are vault-relative, slash separated; lines are 1-based. */
const defaults = { alwaysUpdateLinks: true, newLinkFormat: 'shortest', useMarkdownLinks: false };
const dirname = value => value.slice(0, Math.max(0, value.lastIndexOf('/')));
const basename = value => value.slice(value.lastIndexOf('/') + 1);
const withoutMarkdown = value => value.replace(/\.md$/i, '');
const lower = value => value.toLocaleLowerCase('en-US');
const external = value => /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value);
const escaped = (text, offset) => { let n = 0; while (offset > 0 && text[--offset] === '\\') n++; return n % 2 === 1; };
const unescapeMarkdown = value => value.replace(/\\([\\`*{}\[\]()#+.!_<>|~-])/g, '$1');
const decodeDestination = value => { try { return decodeURIComponent(unescapeMarkdown(value)); } catch { return unescapeMarkdown(value); } };

export function normalizePath(value) {
  const parts = [];
  for (const part of String(value).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

function pathList(paths) {
  if (paths instanceof Map) return [...paths.keys()];
  if (paths instanceof Set || Array.isArray(paths)) return [...paths].map(p => typeof p === 'string' ? p : p.path).filter(Boolean);
  return Object.keys(paths || {});
}

/** Raw linkpath resolution deliberately does not percent-decode; Markdown parsing does. */
const preparedLinkIndexes = new WeakMap();
function prepareLinks(paths) {
  const all=pathList(paths),index=new Map(),basenames=new Map();
  for(const path of all){index.set(lower(path),path);const name=lower(basename(path));if(!basenames.has(name))basenames.set(name,[]);basenames.get(name).push(path);}
  return {all,index,basenames};
}
/** Immutable snapshot index. Call again after changing the vault path list. */
export function createLinkIndex(paths) {const value=prepareLinks(paths),token=Object.freeze({size:value.all.length});preparedLinkIndexes.set(token,value);return token;}
export function resolveLink(linkpath, sourcePath = '', paths = []) {
  const {all,index,basenames} = preparedLinkIndexes.get(paths)||prepareLinks(paths);
  let query = String(linkpath ?? '').replace(/\\/g, '/').split('|', 1)[0].split('#', 1)[0];
  if (external(query)) return null;
  if (!query) return index.get(lower(sourcePath)) || null;
  const names = candidateNames(query);
  const exact = value => {
    if (value === null) return null;
    for (const name of candidateNames(value)) { const found = index.get(lower(name)); if (found) return found; }
    return null;
  };
  if (query.startsWith('/')) return exact(normalizePath(query));
  if (/^\.\.?\//.test(query)) return exact(normalizePath(`${dirname(sourcePath)}/${query}`));
  const root = exact(normalizePath(query));
  if (root) return root;
  // The observed reference uses string suffixes and directory prefixes, without a
  // segment boundary. Keep these semantics separate from explicit path handling.
  const sourceDirectory = lower(dirname(sourcePath));
  for (const name of names) {
    const suffix = lower(name);
    const candidates = (basenames.get(basename(suffix))||[]).filter(path => lower(path).endsWith(suffix));
    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      const aLocal = sourceDirectory && lower(dirname(a)).startsWith(sourceDirectory) ? 0 : 1;
      const bLocal = sourceDirectory && lower(dirname(b)).startsWith(sourceDirectory) ? 0 : 1;
      return aLocal - bLocal || a.length - b.length || a.localeCompare(b, 'en');
    });
    return candidates[0];
  }
  return null;
}

function candidateNames(value) {
  return /\.[^./]+$/.test(value) ? [value, `${value}.md`] : [`${value}.md`, value];
}

function frontmatterRange(text) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  if (!opening) return null;
  const rest = text.slice(opening[0].length);
  const ending = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!ending) return null;
  return { start: 0, contentStart: opening[0].length, contentEnd: opening[0].length + ending.index, end: opening[0].length + ending.index + ending[0].length };
}

function maskRange(chars, start, end) {
  for (let index = start; index < end; index++) if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
}

/** Produce an equal-length view so all metadata retains exact source offsets. */
function markdownMask(text, frontmatter) {
  const chars = text.split('');
  if (frontmatter) maskRange(chars, frontmatter.start, frontmatter.end);
  let fence = null;
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0]);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const match = lines[lineIndex];
    const offset = match.index;
    if (frontmatter && offset < frontmatter.end) continue;
    const line = match[0];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      maskRange(chars, offset, offset + line.length);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      maskRange(chars, offset, offset + line.length);
    } else if (/^(?: {4}|\t)/.test(line)) {
      // Indented code cannot interrupt a paragraph. Lists are deliberately left
      // intact because four-space indentation is common for nested list content.
      const previous = lines[lineIndex - 1]?.[0] || '';
      if (!previous.trim() || /^(?: {4}|\t)/.test(previous)) maskRange(chars, offset, offset + line.length);
    }
  }
  let visible = chars.join('');
  for (let index = 0; index < visible.length; index++) {
    if (visible[index] !== '`' || escaped(text, index)) continue;
    let length = 1;
    while (visible[index + length] === '`') length++;
    let cursor = index + length;
    let end = -1;
    while (cursor < visible.length) {
      const next = visible.indexOf('`', cursor);
      if (next < 0) break;
      let count = 1;
      while (visible[next + count] === '`') count++;
      if (count === length) { end = next + count; break; }
      cursor = next + count;
    }
    if (end >= 0) { maskRange(chars, index, end); index = end - 1; }
    else index += length - 1;
  }
  visible = chars.join('');
  for (const match of visible.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) maskRange(chars, match.index, match.index + match[0].length);
  return chars.join('');
}

function splitSubpath(link) {
  const hash = link.indexOf('#');
  return hash < 0 ? { linkpath: link, subpath: '' } : { linkpath: link.slice(0, hash), subpath: link.slice(hash) };
}

function lineLocator(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return offset => {
    let left = 0;
    let right = starts.length;
    while (left + 1 < right) { const middle = (left + right) >>> 1; if (starts[middle] > offset) right = middle; else left = middle; }
    return left + 1;
  };
}

function makeReference(text, start, end, destinationStart, destinationEnd, kind, syntax, lineAt, extra = {}) {
  const rawDestination = text.slice(destinationStart, destinationEnd);
  const link = syntax === 'markdown' ? decodeDestination(rawDestination) : unescapeMarkdown(rawDestination);
  if (external(link)) return null;
  const { linkpath, subpath } = splitSubpath(link);
  const rawHash = rawDestination.indexOf('#');
  return {
    kind, link, subpath, linkpath, original: text.slice(start, end), path: null,
    start, end, offset: start, line: lineAt(start), syntax,
    pathStart: destinationStart, pathEnd: rawHash < 0 ? destinationEnd : destinationStart + rawHash,
    ...extra,
  };
}

function extractWiki(text, visible, lineAt, kindOverride) {
  const references = [];
  const expression = /(!?)\[\[([^\]\r\n]+)\]\]/g;
  for (const match of visible.matchAll(expression)) {
    if (escaped(text, match.index)) continue;
    const start = match.index;
    const destinationStart = start + match[1].length + 2;
    let pipe = -1;
    for (let index = 0; index < match[2].length; index++) if (match[2][index] === '|' && !escaped(match[2], index)) { pipe = index; break; }
    const destinationEnd = destinationStart + (pipe < 0 ? match[2].length : pipe);
    const reference = makeReference(text, start, start + match[0].length, destinationStart, destinationEnd, kindOverride || (match[1] ? 'embed' : 'link'), 'wiki', lineAt, { display: pipe < 0 ? null : match[2].slice(pipe + 1) });
    if (reference) references.push(reference);
  }
  return references;
}

function matchingBracket(text, start, open, close) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (escaped(text, index)) continue;
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return index;
  }
  return -1;
}

function extractMarkdown(text, visible, lineAt) {
  const references = [];
  for (let index = 0; index < visible.length; index++) {
    if (visible[index] !== '[' || visible[index + 1] === '[' || visible[index - 1] === '[' || escaped(text, index)) continue;
    const close = matchingBracket(visible, index, '[', ']');
    if (close < 0 || visible[close + 1] !== '(') continue;
    const end = matchingBracket(visible, close + 1, '(', ')');
    if (end < 0) continue;
    let destinationStart = close + 2;
    while (/\s/.test(visible[destinationStart] || '') && destinationStart < end) destinationStart++;
    let destinationEnd;
    if (visible[destinationStart] === '<') {
      destinationStart++;
      destinationEnd = visible.indexOf('>', destinationStart);
      if (destinationEnd < 0 || destinationEnd > end) continue;
    } else {
      destinationEnd = destinationStart;
      let depth = 0;
      while (destinationEnd < end) {
        const char = visible[destinationEnd];
        if (!escaped(text, destinationEnd)) {
          if (/\s/.test(char) && depth === 0) break;
          if (char === '(') depth++;
          if (char === ')') depth--;
        }
        destinationEnd++;
      }
    }
    const embed = visible[index - 1] === '!' && !escaped(text, index - 1);
    const start = embed ? index - 1 : index;
    const reference = makeReference(text, start, end + 1, destinationStart, destinationEnd, embed ? 'embed' : 'link', 'markdown', lineAt, { display: text.slice(index + 1, close) });
    if (reference) references.push(reference);
    index = end;
  }
  return references;
}

export function parseMarkdown(value = '') {
  const text = String(value ?? '');
  const lineAt = lineLocator(text);
  const range = frontmatterRange(text);
  let frontmatter = {};
  const frontmatterErrors = [];
  if (range) {
    try {
      const document = parseDocument(text.slice(range.contentStart, range.contentEnd), { uniqueKeys: true });
      frontmatterErrors.push(...document.errors.map(error => error.message));
      const parsed = document.toJS({ maxAliasCount: 100 });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed;
    } catch (error) { frontmatterErrors.push(error.message); }
  }
  const visible = markdownMask(text, range);
  const headings = [];
  const blocks = [];
  const lines = visible.split('\n');
  const sourceLines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
    if (atx) headings.push({ heading: sourceLines[index].replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '').trim(), level: atx[1].length, line: index + 1, offset });
    else if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line) && lines[index - 1].trim() && !/^ {0,3}(?:[-*+] |\d+[.)] )/.test(lines[index - 1])) {
      headings.push({ heading: sourceLines[index - 1].trim(), level: line.trim()[0] === '=' ? 1 : 2, line: index, offset: offset - lines[index - 1].length - 1 });
    }
    const block = /(?:^|\s)\^([\p{L}\p{N}-]+)\s*$/u.exec(line);
    if (block) blocks.push({ id: block[1], line: index + 1, offset: offset + block.index });
    offset += line.length + 1;
  }
  const references = [...extractWiki(text, visible, lineAt), ...extractMarkdown(text, visible, lineAt)];
  if (range) {
    const prefix = ' '.repeat(range.contentStart);
    references.push(...extractWiki(text, prefix + text.slice(range.contentStart, range.contentEnd), lineAt, 'frontmatter'));
  }
  const order = { link: 0, embed: 1, frontmatter: 2 };
  references.sort((a, b) => order[a.kind] - order[b.kind] || a.start - b.start);
  const tagSet = new Set();
  for (const match of visible.matchAll(/(^|[\s([{])#([\p{L}\p{N}_/-]+)/gu)) {
    if (!/^\d+$/.test(match[2]) && !escaped(text, match.index + match[1].length)) tagSet.add(`#${match[2]}`);
  }
  const yamlTags = frontmatter.tags ?? frontmatter.tag ?? [];
  for (const tag of Array.isArray(yamlTags) ? yamlTags : String(yamlTags).split(/[\s,]+/)) if (tag != null && String(tag).trim()) tagSet.add(`#${String(tag).trim().replace(/^#/, '')}`);
  return { headings, tags: [...tagSet], frontmatter, references, blocks, frontmatterRange: range, frontmatterErrors };
}

export function getReferences(text, sourcePath = '', paths = [], metadata) {
  return (metadata||parseMarkdown(text)).references.map(reference => ({ ...reference, path: resolveLink(reference.linkpath, sourcePath, paths) }));
}

function relativePath(fromDirectory, target) {
  const from = fromDirectory.split('/').filter(Boolean);
  const to = target.split('/').filter(Boolean);
  while (from.length && to.length && lower(from[0]) === lower(to[0])) { from.shift(); to.shift(); }
  return [...from.map(() => '..'), ...to].join('/');
}

function formatLink(target, source, paths, reference, settings) {
  if (!reference.linkpath && target === source) return '';
  let path;
  if (settings.newLinkFormat === 'relative') path = relativePath(dirname(source), target);
  else if (settings.newLinkFormat === 'absolute') path = target;
  else {
    const name = basename(target);
    const ambiguous = paths.filter(candidate => lower(basename(candidate)) === lower(name)).length > 1;
    path = ambiguous ? target : name;
  }
  if (reference.syntax === 'wiki') return withoutMarkdown(path);
  // Encode Markdown URL separators that would terminate or alter its destination.
  return path.replace(/%/g, '%25').replace(/ /g, '%20').replace(/#/g, '%23').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function maintainTextReferences(text, sourceBefore, sourceAfter, beforePaths, afterPaths, moved, settings) {
  const replacements = [];
  for (const reference of getReferences(text, sourceBefore, beforePaths)) {
    if (!reference.path) continue;
    const intendedTarget = moved.get(reference.path) || reference.path;
    const currentTarget = resolveLink(reference.linkpath, sourceAfter, afterPaths);
    const needsUpdate = intendedTarget !== reference.path || dirname(sourceBefore) !== dirname(sourceAfter) || currentTarget !== intendedTarget;
    if (!needsUpdate) continue;
    const replacement = formatLink(intendedTarget, sourceAfter, afterPaths, reference, settings);
    if (text.slice(reference.pathStart, reference.pathEnd) !== replacement) replacements.push({ start: reference.pathStart, end: reference.pathEnd, value: replacement });
  }
  let updated = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) updated = updated.slice(0, replacement.start) + replacement.value + updated.slice(replacement.end);
  return updated;
}

// Canvas maintenance is an independent product behavior, outside the frozen REA
// corpus. File nodes store vault-root paths; text nodes contain normal Markdown.
function maintainCanvasReferences(text, sourceBefore, sourceAfter, beforePaths, afterPaths, moved, settings) {
  let canvas;
  try { canvas = JSON.parse(text); } catch { return text; }
  if (!canvas || !Array.isArray(canvas.nodes)) return text;
  let changed = false;
  const pathsByCase = new Map(beforePaths.map(path => [lower(path), path]));
  for (const node of canvas.nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'file' && typeof node.file === 'string') {
      const normalized = normalizePath(node.file);
      const target = normalized && pathsByCase.get(lower(normalized));
      const intended = target && moved.get(target);
      if (intended && node.file !== intended) { node.file = intended; changed = true; }
    } else if (node.type === 'text' && typeof node.text === 'string') {
      const updated = maintainTextReferences(node.text, sourceBefore, sourceAfter, beforePaths, afterPaths, moved, settings);
      if (updated !== node.text) { node.text = updated; changed = true; }
    }
  }
  return changed ? JSON.stringify(canvas, null, 2) + (text.endsWith('\n') ? '\n' : '') : text;
}

/** Plan a whole-file/folder move while preserving every previously resolved target. */
export function planRename(inputFiles, oldPath, newPath, options = {}) {
  const settings = { ...defaults, ...options };
  const old = normalizePath(oldPath);
  const next = normalizePath(newPath);
  if (!old || !next || old !== String(oldPath).replace(/\\/g, '/').replace(/\/$/, '') || next !== String(newPath).replace(/\\/g, '/').replace(/\/$/, '')) throw new Error('Rename requires valid vault-relative paths');
  if (old === next) return { files: { ...inputFiles }, changes: [], settings };
  if (next.startsWith(`${old}/`)) throw new Error('Cannot move a folder inside itself');
  const beforePaths = Object.keys(inputFiles);
  const moved = new Map(beforePaths.filter(path => path === old || path.startsWith(`${old}/`)).map(path => [path, next + path.slice(old.length)]));
  if (!moved.size) throw new Error(`File or folder does not exist: ${old}`);
  const targets = new Set([...moved.values()].map(lower));
  if (beforePaths.some(path => !moved.has(path) && targets.has(lower(path)))) throw new Error(`Rename target already exists: ${next}`);
  const files = {};
  for (const [path, content] of Object.entries(inputFiles)) files[moved.get(path) || path] = content;
  const afterPaths = Object.keys(files);
  const maintain = settings.via !== 'storage' && (settings.alwaysUpdateLinks || settings.decision === 'once' || settings.decision === 'always');
  if (maintain) {
    for (const [sourceBefore, text] of Object.entries(inputFiles)) {
      if (!/\.(?:md|canvas)$/i.test(sourceBefore) || typeof text !== 'string') continue;
      const sourceAfter = moved.get(sourceBefore) || sourceBefore;
      files[sourceAfter] = /\.canvas$/i.test(sourceBefore)
        ? maintainCanvasReferences(text, sourceBefore, sourceAfter, beforePaths, afterPaths, moved, settings)
        : maintainTextReferences(text, sourceBefore, sourceAfter, beforePaths, afterPaths, moved, settings);
    }
  }
  const changes = [];
  for (const [source, before] of Object.entries(inputFiles)) {
    const path = moved.get(source) || source;
    if (path !== source || files[path] !== before) changes.push({ path, oldPath: path !== source ? source : undefined, before, after: files[path], kind: path !== source ? 'rename' : 'edit' });
  }
  if (settings.decision === 'always' && settings.via !== 'storage') settings.alwaysUpdateLinks = true;
  return { files, changes, settings };
}

function queryTokens(query) {
  return query.match(/(?:[\w-]+:)?(?:"(?:\\.|[^"\\])*"|\/(?:\\.|[^/\\])+\/[gimsuy]*|\[[^\]]*\]|[^\s()]+)|[()]/g) || [];
}

function queryTree(tokens) {
  let cursor = 0;
  const atom = () => {
    const token = tokens[cursor++];
    if (token === '(') { const tree = disjunction(); if (tokens[cursor] === ')') cursor++; return tree; }
    if (token === '-' || token === 'NOT') return { kind: 'not', child: atom() };
    if (token?.startsWith('-')) return { kind: 'not', child: { kind: 'term', value: token.slice(1) } };
    return { kind: 'term', value: token || '' };
  };
  const conjunction = () => {
    const children = [atom()];
    while (cursor < tokens.length && tokens[cursor] !== ')' && tokens[cursor] !== 'OR') { if (tokens[cursor] === 'AND') cursor++; children.push(atom()); }
    return { kind: 'and', children };
  };
  const disjunction = () => { const children = [conjunction()]; while (tokens[cursor] === 'OR') { cursor++; children.push(conjunction()); } return { kind: 'or', children }; };
  return disjunction();
}

function textMatcher(value) {
  if (/^\/.*\/[gimsuy]*$/.test(value)) {
    const end = value.lastIndexOf('/');
    try { const expression = new RegExp(value.slice(1, end), value.slice(end + 1).replace(/[gy]/g, '')); return text => expression.test(text); } catch { return () => false; }
  }
  const needle = lower(value.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
  return text => lower(String(text)).includes(needle);
}

/** Search AND/OR/NOT, quoted/regex terms, path/file/content/tag and task filters. */
export function searchFiles(files, query = '') {
  if (!String(query).trim()) return [];
  const tree = queryTree(queryTokens(String(query)));
  const results = [];
  for (const [path, value] of Object.entries(files)) {
    if (typeof value !== 'string' || !/\.(?:md|canvas|base|txt)$/i.test(path)) continue;
    const metadata = parseMarkdown(value);
    const lines = value.split(/\r?\n/);
    const matches = new Set();
    const test = node => {
      if (node.kind === 'and') return node.children.every(test);
      if (node.kind === 'or') return node.children.map(test).some(Boolean);
      if (node.kind === 'not') return !test(node.child);
      const term = node.value;
      const property = /^\[([^:\]]+)(?::\s*(.*))?\]$/.exec(term);
      if (property) return Object.hasOwn(metadata.frontmatter, property[1]) && (property[2] == null || textMatcher(property[2])(JSON.stringify(metadata.frontmatter[property[1]])));
      const filter = /^([\w-]+):(.*)$/.exec(term);
      const field = filter?.[1] || 'content';
      const needle = filter ? filter[2] : term;
      const match = textMatcher(needle);
      if (field === 'path') return match(path);
      if (field === 'file') return match(basename(path));
      if (field === 'tag') return metadata.tags.some(tag => match(tag.replace(/^#/, '')) || match(tag));
      let found = false;
      for (let index = 0; index < lines.length; index++) {
        const task = /^\s*[-*+] \[([ xX])\]\s*(.*)$/.exec(lines[index]);
        if (field.startsWith('task') && (!task || field === 'task-todo' && task[1] !== ' ' || field === 'task-done' && task[1] === ' ')) continue;
        if (match(lines[index])) { matches.add(index); found = true; }
      }
      return found;
    };
    if (test(tree)) {
      const found = [...matches].sort((a, b) => a - b).map(line => ({ line: line + 1, text: lines[line] }));
      results.push({ path, matches: found, score: found.length, snippet: (found[0]?.text || lines.find(line => line.trim()) || '').slice(0, 240) });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
