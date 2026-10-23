// Parse original desktop syntax as inert text. No original code is executed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const [source, output, parserPath] = process.argv.slice(2);
if (!source || !output || !parserPath || fs.existsSync(output)) throw Error('Supply SOURCE, absent OUTPUT and parser path');
const {parse} = createRequire(import.meta.url)(path.resolve(parserPath));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const names = new Set(['IDEAAnnotateType', 'ToolType', 'DrawShapeType', 'getHandwrite',
  'deleteHandwrite', 'postSaveAnnotation', 'createPathList', 'renderHandwrite', 'getIpadUnit']);
const report = {format: 'paperdesk-native-ink-static-audit-v1', sources: [], slices: [], calls: [],
  limitations: ['Inert static syntax only; does not prove server acceptance.',
    'Original module imports and initialization omitted; unresolved names remain unknown.',
    'Absence of a literal route is not proof that a dynamic or native writer cannot exist.']};
fs.mkdirSync(path.join(output, 'focused-sample'), {recursive: true});
for (const file of ['useVipPayConfig-f9cb04db.js', 'index-64368679.js']) {
  const bytes = fs.readFileSync(path.join(source, file)), text = bytes.toString('utf8');
  const ast = parse(text, {sourceType: 'module'}), chunks = [], selected = new Set();
  report.sources.push({file, bytes: bytes.length, sha256: sha(bytes)});
  function retain(node, symbol, prefix, suffix) {
    if (selected.has(node.start)) return;
    selected.add(node.start);
    const raw = text.slice(node.start, node.end);
    chunks.push(prefix + raw + suffix);
    report.slices.push({file, symbol, start_utf16: node.start, end_utf16: node.end,
      start_byte: Buffer.byteLength(text.slice(0, node.start)), end_byte: Buffer.byteLength(text.slice(0, node.end)),
      slice_sha256: sha(raw), wrapper_prefix: prefix, wrapper_suffix: suffix});
  }
  function visit(node, parent, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (['FunctionDeclaration', 'VariableDeclarator'].includes(node.type) && node.id?.type === 'Identifier') {
      const raw = text.slice(node.start, node.end);
      if (names.has(node.id.name) || (raw.length < 6000 && raw.includes('/pdfMark/v3/web/getByNote'))) {
        retain(node, node.id.name, node.type === 'VariableDeclarator' ? `${parent.kind} ` : '',
          node.type === 'VariableDeclarator' ? ';' : '');
      }
    }
    if (node.type === 'ClassMethod' && node.key?.name === 'onlineSaveAnnotation' &&
        text.slice(node.start, node.end).includes('postSaveAnnotation')) {
      retain(node, 'desktop-onlineSaveAnnotation', 'class FocusedDesktopWriter extends UnknownBase {', '}');
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
        ['post', 'put', 'get', 'delete'].includes(node.callee.property?.name)) {
      const arg = node.arguments[0];
      const literal = arg?.type === 'TemplateLiteral' ? arg.quasis.map(q => q.value.cooked).join('{dynamic}') : arg?.value;
      if (typeof literal === 'string' && literal.includes('/pdfMark/')) {
        const owner = [...ancestors].reverse().find(a => a.type === 'VariableDeclarator' && a.id?.type === 'Identifier');
        report.calls.push({file, owner: owner?.id.name ?? null, method: node.callee.property.name.toUpperCase(),
          path_template: literal, start_utf16: node.start, end_utf16: node.end});
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'extra', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, node, [...ancestors, node]));
      else if (value && typeof value === 'object') visit(value, node, [...ancestors, node]);
    }
  }
  visit(ast.program, null);
  if (chunks.length) fs.writeFileSync(path.join(output, 'focused-sample', file), chunks.join('\n'));
}
fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({sources: report.sources.length, slices: report.slices.length, pdf_mark_calls: report.calls.length}));
