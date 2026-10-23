import { isMap, parseDocument, stringify } from 'yaml';

export function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new TypeError('Expected an ArrayBuffer or typed array');
}

export function encodeBinary(value) {
  const bytes = new Uint8Array(toArrayBuffer(value));
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(result);
}

export function decodeBinary(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new TypeError('Expected canonical base64 data');
  const binary = atob(value), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encodeBinary(bytes) !== value) throw new TypeError('Expected canonical base64 data');
  return bytes.buffer;
}

function frontmatterRange(source) {
  const opening = source.match(/^(?:\uFEFF)?---[ \t]*\r?\n/);
  if (!opening) return null;
  const rest = source.slice(opening[0].length), closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error('Frontmatter has no closing delimiter');
  return { from: opening[0].length, to: opening[0].length + closing.index, end: opening[0].length + closing.index + closing[0].length };
}

// Deliberately preserve original bytes for a no-op and never hand the callback
// a live metadata-cache object. Only changed YAML keys are replaced in the AST.
export function transformFrontmatter(source, callback) {
  if (typeof source !== 'string' || typeof callback !== 'function') throw new TypeError('Expected Markdown text and a synchronous callback');
  const range = frontmatterRange(source), raw = range ? source.slice(range.from, range.to) : '';
  const document = parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid frontmatter: ${document.errors[0].message}`);
  const parsed = document.toJS({ maxAliasCount: 100 });
  if (parsed != null && !isMap(document.contents)) throw new Error('Frontmatter must be a YAML mapping');
  const original = parsed || {};
  const draft = Object.assign(Object.create(null), structuredClone(original));
  const before = stringify(draft), result = callback(draft);
  if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw new TypeError('processFrontMatter callback must be synchronous'); }
  const after = stringify(draft);
  if (range && !Object.keys(draft).length) return (source.startsWith('\uFEFF') ? '\uFEFF' : '') + source.slice(range.end);
  if (before === after) return source;
  if (parsed == null) document.contents = null;
  for (const key of Object.keys(original)) if (!Object.prototype.hasOwnProperty.call(draft, key)) document.delete(key);
  for (const key of Object.keys(draft)) {
    if (!Object.prototype.hasOwnProperty.call(original, key) || stringify(original[key]) !== stringify(draft[key])) document.set(key, draft[key]);
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const yaml = document.toString({ lineWidth: 0 }).replace(/\r?\n/g, newline);
  if (range) return source.slice(0, range.from) + yaml + source.slice(range.to);
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  return `${bom}---${newline}${yaml}---${newline}${source.slice(bom.length)}`;
}
