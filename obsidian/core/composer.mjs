import { isMap, parseDocument } from 'yaml';
import { getReferences, normalizePath, parseMarkdown, resolveLink } from './vault.mjs';

/** Pure note-composer plans. No filesystem, clock, random values or mutations.
 * changes/writes are ordered: destination first, other edits next, deletion last.
 * A host must check every before/mtime, create new targets exclusively, and only
 * trash a merge source after every write succeeds.
 */
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const lower = value => String(value).toLocaleLowerCase('en-US');
const directory = value => value.slice(0, Math.max(0, value.lastIndexOf('/')));
const headingSlug = value => String(value).replace(/<[^>]*>/g, '').replace(/[*_`]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
const isExternal = value => /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value);
const escaped = (text, offset) => { let count = 0; while (offset > 0 && text[--offset] === '\\') count++; return count % 2 === 1; };
const inside = (offset, ranges) => ranges.some(range => offset >= range.start && offset < range.end);
const lineEnd = (text, start) => { const next = text.indexOf('\n', start); return next < 0 ? text.length : (text[next - 1] === '\r' ? next - 1 : next); };

function safePath(value) {
  if (typeof value !== 'string' || !value || value !== normalizePath(value) || /[\\<>:"|?*\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) {
    throw new Error('Composer requires canonical, safe vault-relative paths.');
  }
  for (const part of value.split('/')) {
    if (!part || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('Composer path contains an unsupported filename.');
  }
  return value;
}

function prepare(files, sourcePath, targetPath, operation) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Composer requires a file map.');
  safePath(sourcePath); safePath(targetPath);
  if (!/\.md$/i.test(sourcePath) || !/\.md$/i.test(targetPath)) throw new Error('Note composition supports Markdown .md files only.');
  if (lower(sourcePath) === lower(targetPath)) throw new Error('Source and destination must be different notes.');
  if (/[#\[\]|]/.test(targetPath)) throw new Error('Destination contains characters that cannot be represented safely in a wiki link.');
  if (!own(files, sourcePath) || typeof files[sourcePath] !== 'string') throw new Error('Source note does not exist or its text is unavailable.');
  const paths = Object.keys(files);
  const byCase = new Set();
  for (const name of paths) {
    safePath(name);
    if (byCase.has(lower(name))) throw new Error('Case-colliding file paths must be resolved before note composition.');
    byCase.add(lower(name));
    if (/\.(?:md|canvas)$/i.test(name) && typeof files[name] !== 'string') throw new Error(`Text is unavailable for ${name}; reload the vault before composition.`);
  }
  if (operation === 'extract' && byCase.has(lower(targetPath))) throw new Error('Extraction destination already exists; choose a new note.');
  if (operation === 'merge' && (!own(files, targetPath) || typeof files[targetPath] !== 'string')) throw new Error('Merge destination must be an existing Markdown note.');
  if (paths.some(name => name !== targetPath && (lower(name).startsWith(lower(targetPath) + '/') || lower(targetPath).startsWith(lower(name) + '/')))) {
    throw new Error('Destination collides with an existing file or directory.');
  }
  return paths;
}

function protectedRanges(text) {
  const ranges = [];
  const metadata = parseMarkdown(text);
  if (metadata.frontmatterRange) ranges.push({ start: 0, end: metadata.frontmatterRange.end, kind: 'frontmatter' });
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0]);
  let fence;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (metadata.frontmatterRange && line.index < metadata.frontmatterRange.end) continue;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line[0]);
    if (fence) {
      if (match && match[1][0] === fence.character && match[1].length >= fence.length && !match[2].trim()) {
        ranges.push({ start: fence.start, end: lineEnd(text, line.index), kind: 'fenced code' });
        fence = null;
      }
    } else if (match && (match[1][0] !== '`' || !match[2].includes('`'))) {
      fence = { character: match[1][0], length: match[1].length, start: line.index };
    } else if (/^(?: {4}|\t)/.test(line[0]) && (!lines[index - 1]?.[0].trim() || /^(?: {4}|\t)/.test(lines[index - 1][0]))) {
      ranges.push({ start: line.index, end: lineEnd(text, line.index), kind: 'indented code' });
    }
  }
  if (fence) ranges.push({ start: fence.start, end: text.length, kind: 'fenced code', unclosed: true });
  for (const comment of text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
    if (!inside(comment.index, ranges)) ranges.push({ start: comment.index, end: comment.index + comment[0].length, kind: 'HTML comment', unclosed: !comment[0].endsWith('-->') });
  }
  for (let offset = 0; offset < text.length; offset++) {
    if (text[offset] !== '`' || escaped(text, offset) || inside(offset, ranges)) continue;
    let length = 1;
    while (text[offset + length] === '`') length++;
    let cursor = offset + length;
    while (cursor < text.length) {
      const next = text.indexOf('`', cursor);
      if (next < 0) break;
      let count = 1;
      while (text[next + count] === '`') count++;
      if (count === length) {
        ranges.push({ start: offset, end: next + count, kind: 'inline code' });
        offset = next + count - 1;
        break;
      }
      cursor = next + count;
    }
  }
  return ranges;
}

function definitions(text, sourcePath, paths) {
  const protectedText = protectedRanges(text);
  const result = [];
  const pattern = /^( {0,3}\[([^\]\r\n]+)\]:[ \t]*)(?:<([^>\r\n]+)>|(\S+))/gm;
  for (const match of text.matchAll(pattern)) {
    if (inside(match.index, protectedText) || match[2].startsWith('^')) continue;
    const raw = match[3] ?? match[4];
    const pathStart = match.index + match[1].length + (match[3] === undefined ? 0 : 1);
    const parsed = getReferences(`[reference](<${raw}>)`, sourcePath, paths)[0];
    const rawHash = raw.indexOf('#');
    result.push({ label: lower(match[2].trim().replace(/\s+/g, ' ')), start: match.index, end: lineEnd(text, match.index),
      reference: parsed ? { ...parsed, start: match.index, end: lineEnd(text, match.index), pathStart, pathEnd: pathStart + (rawHash < 0 ? raw.length : rawHash), definition: true } : null });
  }
  return result;
}

function references(text, sourcePath, paths) {
  return [...getReferences(text, sourcePath, paths), ...definitions(text, sourcePath, paths).flatMap(item => item.reference ? [item.reference] : [])];
}

function relativePath(fromPath, target) {
  const from = directory(fromPath).split('/').filter(Boolean);
  const to = target.split('/');
  while (from.length && to.length && lower(from[0]) === lower(to[0])) { from.shift(); to.shift(); }
  const value = [...from.map(() => '..'), ...to].join('/');
  return value.startsWith('../') ? value : `./${value}`;
}

function formatTarget(target, sourcePath, reference) {
  if (target === sourcePath && reference.subpath) return '';
  if (reference.syntax === 'wiki') {
    if (/[#\[\]|]/.test(target)) throw new Error(`Cannot safely preserve a wiki link to ${target}; use a filename without wiki delimiters.`);
    return '/' + target.replace(/\.md$/i, '');
  }
  return relativePath(sourcePath, target).split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

function rawHtmlReferences(text, sourcePath, paths) {
  const hidden = protectedRanges(text);
  const found = [];
  const tag = /<[a-z][^>]*>/gi;
  for (const match of text.matchAll(tag)) {
    if (inside(match.index, hidden)) continue;
    for (const attribute of match[0].matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const value = attribute[1] ?? attribute[2] ?? attribute[3];
      if (!value || isExternal(value) || value.startsWith('data:')) continue;
      const ref = getReferences(`[html](<${value}>)`, sourcePath, paths)[0];
      if (ref) found.push(ref);
    }
  }
  return found;
}

function rewrite(text, beforePath, afterPath, beforePaths, afterPaths, redirect = target => target) {
  for (const reference of rawHtmlReferences(text, beforePath, beforePaths)) {
    const intended = reference.path && redirect(reference.path, reference.subpath);
    if (beforePath !== afterPath || intended !== reference.path || resolveLink(reference.linkpath, afterPath, afterPaths) !== reference.path) {
      throw new Error(`Raw HTML links in ${beforePath} cannot be moved safely; convert them to Markdown links first.`);
    }
  }
  const replacements = [];
  for (const reference of references(text, beforePath, beforePaths)) {
    let intended = reference.path && redirect(reference.path, reference.subpath);
    const unresolvedRelative = /^\.\.?\//.test(reference.linkpath) || (reference.syntax === 'markdown' && reference.linkpath && !reference.linkpath.startsWith('/'));
    if (!intended && beforePath !== afterPath && unresolvedRelative) {
      intended = normalizePath(`${directory(beforePath)}/${reference.linkpath}`);
      if (!intended) throw new Error(`Relative link escapes the vault in ${beforePath}.`);
    }
    if (!intended) continue;
    const current = resolveLink(reference.linkpath, afterPath, afterPaths);
    if (reference.path && current === intended) continue;
    const value = formatTarget(intended, afterPath, reference);
    if (value !== text.slice(reference.pathStart, reference.pathEnd)) replacements.push({ start: reference.pathStart, end: reference.pathEnd, value });
  }
  let output = text;
  let previousStart = Infinity;
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    if (edit.end > previousStart) throw new Error('Overlapping link syntax cannot be rewritten safely.');
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
    previousStart = edit.start;
  }
  if (output !== text && !parseMarkdown(text).frontmatterErrors.length && parseMarkdown(output).frontmatterErrors.length) {
    throw new Error(`Link rewriting would invalidate frontmatter in ${beforePath}; rename or quote the property manually first.`);
  }
  return output;
}

function rewriteCanvas(text, canvasPath, beforePaths, afterPaths, redirect) {
  let canvas;
  try { canvas = JSON.parse(text); } catch { throw new Error(`Canvas ${canvasPath} is invalid JSON; repair it before updating references.`); }
  if (!canvas || !Array.isArray(canvas.nodes)) throw new Error(`Canvas ${canvasPath} has no valid nodes array; repair it before updating references.`);
  let changed = false;
  const pathsByCase = new Map(beforePaths.map(name => [lower(name), name]));
  for (const node of canvas.nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'file' && typeof node.file === 'string') {
      const original = pathsByCase.get(lower(normalizePath(node.file) || ''));
      const intended = original && redirect(original, typeof node.subpath === 'string' ? node.subpath : '');
      if (intended && intended !== node.file) { node.file = intended; changed = true; }
    } else if (node.type === 'text' && typeof node.text === 'string') {
      const updated = rewrite(node.text, canvasPath, canvasPath, beforePaths, afterPaths, redirect);
      if (updated !== node.text) { node.text = updated; changed = true; }
    }
  }
  return changed ? JSON.stringify(canvas, null, 2) + (text.endsWith('\n') ? '\n' : '') : text;
}

function composePlan(operation, original, files, sourcePath, targetPath, warnings) {
  const order = [targetPath, ...Object.keys(original).filter(name => name !== targetPath && name !== sourcePath), sourcePath];
  const changes = [];
  for (const name of order) {
    const before = own(original, name) ? original[name] : null;
    const after = own(files, name) ? files[name] : null;
    if (before === after) continue;
    changes.push({ kind: before === null ? 'create' : after === null ? 'delete' : 'edit', path: name, before, after });
  }
  return { operation, sourcePath, targetPath, files, changes, writes: changes.filter(change => change.kind !== 'delete'), deletes: changes.filter(change => change.kind === 'delete').map(change => change.path), warnings };
}

function anchorKey(subpath) {
  if (!subpath || !subpath.startsWith('#')) return '';
  let value = subpath.slice(1);
  try { value = decodeURIComponent(value); } catch { /* Preserve literal malformed escapes. */ }
  return value.startsWith('^') ? '^' + value.slice(1) : headingSlug(value);
}

function anchors(text) {
  const metadata = parseMarkdown(text);
  const result = new Map();
  for (const item of metadata.headings) {
    const key = headingSlug(item.heading);
    result.set(key, (result.get(key) || 0) + 1);
  }
  for (const item of metadata.blocks) {
    const key = '^' + item.id;
    result.set(key, (result.get(key) || 0) + 1);
  }
  return result;
}

function balancedLinkRanges(text) {
  const result = [];
  const close = (start, opening, closing) => {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      if (escaped(text, index)) continue;
      if (text[index] === opening) depth++;
      if (text[index] === closing && --depth === 0) return index;
    }
    return -1;
  };
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '[' || escaped(text, index)) continue;
    if (text[index + 1] === '[') {
      const end = text.indexOf(']]', index + 2);
      if (end >= 0) { result.push({ start: text[index - 1] === '!' ? index - 1 : index, end: end + 2, kind: 'wiki link' }); index = end + 1; }
      continue;
    }
    const bracket = close(index, '[', ']');
    if (bracket < 0 || text[bracket + 1] !== '(') continue;
    const end = close(bracket + 1, '(', ')');
    if (end >= 0) { result.push({ start: text[index - 1] === '!' ? index - 1 : index, end: end + 1, kind: 'Markdown link' }); index = end; }
  }
  return result;
}

function validateSelection(text, selection, sourcePath, paths) {
  const { from, to, text: selected } = selection || {};
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || to <= from || typeof selected !== 'string' || selected !== text.slice(from, to)) {
    throw new Error('Selection is stale or invalid; select the current text again before extracting.');
  }
  if (!selected.trim()) throw new Error('Select nonempty note content before extracting.');
  if (escaped(text, from)) throw new Error('Selection starts after a Markdown escape; include the escape character before extracting.');
  for (const offset of [from, to]) {
    if ((/[\uD800-\uDBFF]/.test(text[offset - 1] || '') && /[\uDC00-\uDFFF]/.test(text[offset] || '')) || (text[offset - 1] === '\r' && text[offset] === '\n')) {
      throw new Error('Selection splits a Unicode character or CRLF line ending.');
    }
  }
  const protectedText = protectedRanges(text);
  const frontmatter = parseMarkdown(text).frontmatterRange;
  if (frontmatter && from < frontmatter.end) throw new Error('Frontmatter must stay with its note; extract body text only.');
  const ranges = [...protectedText.filter(range => range.kind !== 'frontmatter'), ...balancedLinkRanges(text)];
  for (const tag of text.matchAll(/<[a-z/!][^>]*>/gi)) {
    if (!inside(tag.index, protectedText)) ranges.push({ start: tag.index, end: tag.index + tag[0].length, kind: 'HTML tag or autolink' });
  }
  const metadata = parseMarkdown(text);
  for (const heading of metadata.headings) {
    let end = lineEnd(text, heading.offset);
    const nextLine = text.indexOf('\n', end);
    if (nextLine >= 0 && /^ {0,3}(?:=+|-+)\s*$/.test(text.slice(nextLine + 1, lineEnd(text, nextLine + 1)))) end = lineEnd(text, nextLine + 1);
    ranges.push({ start: heading.offset, end, kind: 'heading' });
  }
  for (const block of metadata.blocks) ranges.push({ start: text.lastIndexOf('\n', block.offset - 1) + 1, end: lineEnd(text, block.offset), kind: 'block reference' });
  for (const range of ranges) {
    if (from < range.end && to > range.start && !(from <= range.start && to >= range.end)) {
      throw new Error(`Selection splits ${range.kind}; include the complete construct before extracting.`);
    }
  }
  const definitionNames = new Set(definitions(text, sourcePath, paths).map(item => item.label));
  const selectedHidden = protectedRanges(selected);
  const referenceUse = /!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g;
  for (const match of selected.matchAll(referenceUse)) {
    if (inside(match.index, selectedHidden) || selected[match.index - 1] === '[' || match[1].startsWith('[') || selected[match.index + match[0].length] === '(') continue;
    const label = lower((match[2] || match[1]).trim().replace(/\s+/g, ' '));
    if (label.startsWith('^') || match[2] !== undefined || definitionNames.has(label)) {
      throw new Error('Selection uses footnotes or reference-style links; convert them to inline Markdown links before extracting.');
    }
  }
}

/** Extract a current UTF-16 selection to a NEW Markdown note, preserving links. */
export function planExtract(inputFiles, sourcePath, selection, targetPath) {
  const beforePaths = prepare(inputFiles, sourcePath, targetPath, 'extract');
  const original = inputFiles[sourcePath];
  validateSelection(original, selection, sourcePath, beforePaths);
  const warnings = [];
  let selected = selection.text;
  // A body horizontal-rule block must not accidentally become YAML properties.
  if (parseMarkdown(selected).frontmatterRange) {
    selected = '\n' + selected;
    warnings.push('A leading blank line was added so extracted body text is not interpreted as frontmatter.');
  }
  const movedAnchors = anchors(selected);
  const originalAnchors = anchors(original);
  const redirect = (target, subpath) => {
    if (target !== sourcePath || !movedAnchors.has(anchorKey(subpath))) return target;
    if (originalAnchors.get(anchorKey(subpath)) !== 1) throw new Error('A selected heading or block anchor is ambiguous in the source; rename duplicate anchors before extracting.');
    return targetPath;
  };
  const afterPaths = [...beforePaths, targetPath];
  const files = { ...inputFiles };
  files[targetPath] = rewrite(selected, sourcePath, targetPath, beforePaths, afterPaths, redirect);
  const link = `[[/${targetPath.replace(/\.md$/i, '')}]]`;
  for (const [name, content] of Object.entries(inputFiles)) {
    if (/\.md$/i.test(name)) {
      const text = name === sourcePath ? original.slice(0, selection.from) + link + original.slice(selection.to) : content;
      files[name] = rewrite(text, name, name, beforePaths, afterPaths, redirect);
    } else if (/\.canvas$/i.test(name)) files[name] = rewriteCanvas(content, name, beforePaths, afterPaths, redirect);
  }
  return composePlan('extract', inputFiles, files, sourcePath, targetPath, warnings);
}

function newlineFor(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function appendText(left, right) {
  if (!left) return right;
  if (!right) return left;
  const newline = newlineFor(left);
  const trailing = (left.match(/(?:\r?\n)+$/)?.[0].match(/\n/g) || []).length;
  return left + newline.repeat(Math.max(0, 2 - trailing)) + right;
}

function frontmatterInfo(text) {
  const range = parseMarkdown(text).frontmatterRange;
  if (!range) return null;
  const raw = text.slice(0, range.end);
  const content = text.slice(range.contentStart, range.contentEnd);
  let document;
  try { document = parseDocument(content, { uniqueKeys: true }); } catch { /* Archived verbatim when unsafe. */ }
  return { range, raw, content, body: text.slice(range.end), document };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function combineFrontmatter(targetText, sourceText, sourcePath, warnings) {
  const source = frontmatterInfo(sourceText);
  if (!source) return appendText(targetText, sourceText);
  const target = frontmatterInfo(targetText);
  const safeMapping = info => info.document && !info.document.errors.length && (!info.document.contents || isMap(info.document.contents));
  if (!target && safeMapping(source)) {
    const body = appendText(targetText, source.body);
    return source.raw + (body && !source.raw.endsWith('\n') ? newlineFor(source.raw) : '') + body;
  }
  if (target && safeMapping(source) && safeMapping(target)) {
    try {
      const sourceValue = source.document.toJS({ maxAliasCount: 100 }) || {};
      const targetValue = target.document.toJS({ maxAliasCount: 100 }) || {};
      if (!Object.keys(sourceValue).some(key => own(targetValue, key))) {
        const newline = newlineFor(targetText);
        const combinedContent = target.content + (target.content && !target.content.endsWith('\n') ? newline : '') + source.content;
        const combined = targetText.slice(0, target.range.contentStart) + combinedContent + (combinedContent && !combinedContent.endsWith('\n') ? newline : '') + targetText.slice(target.range.contentEnd);
        const parsed = frontmatterInfo(combined);
        if (safeMapping(parsed) && JSON.stringify(canonical(parsed.document.toJS({ maxAliasCount: 100 }) || {})) === JSON.stringify(canonical({ ...targetValue, ...sourceValue }))) {
          return appendText(combined, source.body);
        }
      }
    } catch { /* Duplicate anchors, aliases or unsupported shapes are archived. */ }
  }
  const newline = newlineFor(targetText || sourceText);
  const fence = '`'.repeat(Math.max(3, ...[...source.raw.matchAll(/`+/g)].map(match => match[0].length + 1)));
  const name = sourcePath.replace(/[\\`*_{}[\]()#+.!<>|]/g, '\\$&');
  const preserved = `> Preserved source frontmatter from ${name}. Destination properties remain active.${newline}${newline}${fence}yaml${newline}${source.raw}${source.raw.endsWith('\n') ? '' : newline}${fence}${newline}${newline}`;
  warnings.push('Source frontmatter could not be combined without changing properties; its complete YAML is preserved in a labeled code block in the merged note.');
  return appendText(targetText, preserved + source.body);
}

function rejectDefinitionCollisions(source, target, sourcePath, targetPath, paths) {
  const sourceDefinitions = definitions(source, sourcePath, paths);
  const targetNames = new Set(definitions(target, targetPath, paths).map(item => item.label));
  if (sourceDefinitions.some(item => targetNames.has(item.label))) throw new Error('Both notes define the same reference-link label; rename those labels before merging.');
  const footnotes = text => new Set([...text.matchAll(/^ {0,3}\[\^([^\]]+)\]:/gm)].map(match => lower(match[1])));
  const targetFootnotes = footnotes(target);
  if ([...footnotes(source)].some(label => targetFootnotes.has(label))) throw new Error('Both notes define the same footnote; rename duplicate footnotes before merging.');
}

/** Merge source into an EXISTING Markdown destination, then remove source. */
export function planMerge(inputFiles, sourcePath, targetPath) {
  const beforePaths = prepare(inputFiles, sourcePath, targetPath, 'merge');
  const source = inputFiles[sourcePath];
  const target = inputFiles[targetPath];
  if (protectedRanges(target).some(range => range.unclosed)) throw new Error('Destination has an unclosed code fence or HTML comment; close it before appending a note.');
  rejectDefinitionCollisions(source, target, sourcePath, targetPath, beforePaths);
  const sourceAnchors = anchors(source);
  const targetAnchors = anchors(target);
  for (const key of sourceAnchors.keys()) {
    if (key.startsWith('^') && targetAnchors.has(key)) throw new Error('Both notes contain the same block ID; rename duplicate block IDs before merging.');
  }
  const redirect = (name, subpath) => {
    if (name !== sourcePath) return name;
    const key = anchorKey(subpath);
    if (key && sourceAnchors.has(key) && targetAnchors.has(key)) throw new Error('A link to a source heading would become ambiguous in the destination; rename duplicate headings before merging.');
    return targetPath;
  };
  const afterPaths = beforePaths.filter(name => name !== sourcePath);
  const files = { ...inputFiles };
  const warnings = [];
  const relocatedSource = rewrite(source, sourcePath, targetPath, beforePaths, afterPaths, redirect);
  const updatedTarget = rewrite(target, targetPath, targetPath, beforePaths, afterPaths, redirect);
  files[targetPath] = combineFrontmatter(updatedTarget, relocatedSource, sourcePath, warnings);
  for (const [name, content] of Object.entries(inputFiles)) {
    if (name === sourcePath || name === targetPath) continue;
    if (/\.md$/i.test(name)) files[name] = rewrite(content, name, name, beforePaths, afterPaths, redirect);
    else if (/\.canvas$/i.test(name)) files[name] = rewriteCanvas(content, name, beforePaths, afterPaths, redirect);
  }
  delete files[sourcePath];
  return composePlan('merge', inputFiles, files, sourcePath, targetPath, warnings);
}
