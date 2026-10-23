// Inert syntax inspection only. Never loads the inspected ReadPaper modules.
// The optional REA sample consists of exact declarator/function slices; its
// provenance is explicit and does not imply a complete-application analysis.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const [source, output, parserPackage] = process.argv.slice(2);
if (!source || !output || !parserPackage) throw Error('Usage: node research_readpaper_cloud.mjs SOURCE OUTPUT BABEL_PARSER');
const require = createRequire(import.meta.url);
const { parse } = require(path.resolve(parserPackage));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const names = ['iconfont-5f81c8a0.js', 'useVipPayConfig-f9cb04db.js', 'index-64368679.js', 'useWordNote-8e5f18ba.js'];
const modules = new Map();
for (const name of names) {
  const bytes = fs.readFileSync(path.join(source, name));
  const text = bytes.toString('utf8');
  const ast = parse(text, { sourceType: 'module' });
  const item = { name, bytes, text, ast, vars: new Map(), imports: new Map(), exports: new Map() };
  for (const node of ast.program.body) {
    if (node.type === 'VariableDeclaration') for (const decl of node.declarations) {
      if (decl.id.type === 'Identifier') item.vars.set(decl.id.name, { node: decl, kind: node.kind });
    }
    if (node.type === 'FunctionDeclaration' && node.id) item.vars.set(node.id.name, { node, kind: 'function' });
    if (node.type === 'ImportDeclaration') for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier') item.imports.set(spec.local.name, { module: path.posix.basename(node.source.value), name: spec.imported.name });
    }
    if (node.type === 'ExportNamedDeclaration') for (const spec of node.specifiers) {
      if (spec.type === 'ExportSpecifier') item.exports.set(spec.exported.name, spec.local.name);
    }
  }
  modules.set(name, item);
}

function resolve(node, item, seen = new Set()) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    let result = '';
    for (let i = 0; i < node.quasis.length; i++) {
      result += node.quasis[i].value.cooked;
      if (i < node.expressions.length) result += resolve(node.expressions[i], item, seen) ?? '{dynamic}';
    }
    return result;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = resolve(node.left, item, seen), right = resolve(node.right, item, seen);
    return left === null && right === null ? null : (left ?? '{dynamic}') + (right ?? '{dynamic}');
  }
  if (node.type === 'Identifier') {
    const key = item.name + ':' + node.name;
    if (seen.has(key)) return null;
    const next = new Set([...seen, key]);
    const decl = item.vars.get(node.name);
    if (decl) return resolve(decl.node.init, item, next);
    const imported = item.imports.get(node.name);
    if (imported && modules.has(imported.module)) {
      const other = modules.get(imported.module), original = other.exports.get(imported.name);
      if (original) return resolve({ type: 'Identifier', name: original }, other, next);
    }
  }
  return null;
}

function walk(node, fn, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node, ancestors);
  const next = node.type ? [...ancestors, node] : ancestors;
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'comments', 'tokens', 'extra'].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, fn, next);
    else if (value && typeof value === 'object') walk(value, fn, next);
  }
}

const requests = [], slices = [];
const selected = new Map([
  ['useVipPayConfig-f9cb04db.js', new Set(['getVipProfile', 'postOcrRemainCount', 'getBeansInfo', 'getTranslateTabList', 'fetchYouDaoTranslate', 'fetchTranslate', 'ssePostFetcher', 'useTranslateSSE', 'usePollingSSE', 'getReference', 'getCitation', 'getReferenceMarkers', 'getFiguresAndTables'])],
  ['index-64368679.js', new Set(['JM', 'eq', 'tq', 'nq', 'sq', 'oq', 'rq', 'cq', 'uq', 'mq', 'gq', 'S$e', '$$e', 'D$e', 'X$e', 'K$e'])],
  ['useWordNote-8e5f18ba.js', new Set(['dr'])],
  ['iconfont-5f81c8a0.js', new Set(['SEe', 'R1'])],
]);
fs.mkdirSync(output, { recursive: true });
const sample = path.join(output, 'focused-sample');
fs.mkdirSync(sample, { recursive: true });
for (const item of modules.values()) {
  walk(item.ast.program, (node, ancestors) => {
    if (node.type !== 'CallExpression' || !node.arguments.length || node.callee?.type !== 'MemberExpression') return;
    const method = node.callee.property?.name;
    if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) return;
    const url = resolve(node.arguments[0], item);
    if (!url || !/\/(micro[Ss]ervice|microservice|readpaper-pay)\b/.test(url)) return;
    const owner = [...ancestors].reverse().find(x => x.type === 'VariableDeclarator' && x.id.type === 'Identifier');
    requests.push({ file: item.name, source_sha256: hash(item.bytes), start_utf16: node.start,
      end_utf16: node.end, method: method.toUpperCase(), path: url,
      owner: owner?.id?.name ?? null,
      arguments: node.arguments.slice(1).map(a => ({ type: a.type,
        fields: a.type === 'ObjectExpression' ? a.properties.map(p => p.key?.name ?? p.key?.value ?? '[spread]') : [],
      })),
      authority: 'supplemental-static-syntax; not a runtime observation',
    });
  });
  const chunks = [];
  for (const name of selected.get(item.name) ?? []) {
    const decl = item.vars.get(name);
    if (!decl) continue;
    const raw = item.text.slice(decl.node.start, decl.node.end);
    const prefix = decl.kind === 'function' ? '' : decl.kind + ' ';
    const generated = prefix + raw + (decl.kind === 'function' ? '' : ';');
    chunks.push(generated);
    slices.push({ file: item.name, symbol: name, original_sha256: hash(item.bytes),
      original_start_utf16: decl.node.start, original_end_utf16: decl.node.end,
      original_start_byte: Buffer.byteLength(item.text.slice(0, decl.node.start)),
      original_end_byte: Buffer.byteLength(item.text.slice(0, decl.node.end)),
      original_slice_sha256: hash(raw), wrapper: prefix ? prefix + '<original-declarator>;' : '<original-function>',
      limitation: 'Imports, dependencies, initialization and runtime context intentionally omitted; unresolved identifiers are unknown.' });
  }
  if (chunks.length) fs.writeFileSync(path.join(sample, item.name), chunks.join('\n'));
}
const report = { format: 'paperdesk-readpaper-cloud-static-research-v1',
  inspected_sources: [...modules.values()].map(m => ({ file: m.name, bytes: m.bytes.length, sha256: hash(m.bytes) })),
  requests, selected_slices: slices,
  limitations: ['Original JavaScript is parsed as inert syntax only.', 'Locally resolved constants/imports do not prove server acceptance.',
    'Focused REA samples are derived extracts with omitted dependencies, not complete authenticated original applications.'] };
fs.writeFileSync(path.join(output, 'static-request-inventory.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ request_candidates: requests.length, focused_declarations: slices.length,
  focused_bytes: fs.readdirSync(sample).reduce((n, f) => n + fs.statSync(path.join(sample, f)).size, 0) }));
