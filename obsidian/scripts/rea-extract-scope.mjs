import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// Read-only ASAR inspection. The derived snippets are analysis inputs, never executed.
const [asarPath, outputDir, parserPath] = process.argv.slice(2);
if (!asarPath || !outputDir || !parserPath) throw new Error('Usage: node rea-extract-scope.mjs CORE.asar NEW_OUTPUT_DIR BABEL_PARSER.js');
if (fs.existsSync(outputDir)) throw new Error('Use a fresh output directory.');
const require = createRequire(import.meta.url);
const { parse } = require(path.resolve(parserPath));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = fs.readFileSync(asarPath);
const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString('utf8'));
const dataOffset = 8 + bytes.readUInt32LE(4);
function member(name) {
  const entry = name.split('/').reduce((tree, key) => tree.files[key], header);
  if (entry.unpacked || entry.link) throw new Error('Unsupported member');
  const start = dataOffset + Number(entry.offset);
  if (!Number.isSafeInteger(start) || start < dataOffset || start + entry.size > bytes.length) throw new Error('Invalid bounds');
  return bytes.subarray(start, start + entry.size);
}
const sourceBytes = member('app.js');
const source = sourceBytes.toString('utf8');
const packageInfo = JSON.parse(member('package.json').toString('utf8'));
if (packageInfo.version !== '1.13.7') throw new Error('This extractor is pinned to Obsidian 1.13.7.');
const ast = parse(source, { sourceType: 'unambiguous' });
const registryStart = source.indexOf('a.loadPlugin(new F9)');
const registryEnd = source.indexOf(',[4,a.enable()]', registryStart);
if (registryStart < 0 || registryEnd < registryStart) throw new Error('Pinned registry anchor not found');
const registry = source.slice(registryStart, registryEnd);
const ctorNames = [...registry.matchAll(/a\.loadPlugin\(new ([\w$]+)\)/g)].map(m => m[1]);
if (ctorNames.length !== 31 || new Set(ctorNames).size !== 31) throw new Error('Unexpected core plugin registry size');
const constructors = new Map();
const cloudHelpers = [];
const endpointLiterals = [];
const bridgeDeclarations = [];
function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'extra', 'tokens', 'comments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, fn));
    else if (value && typeof value === 'object') walk(value, fn);
  }
}
walk(ast, node => {
  if (node.type === 'VariableDeclarator' && ctorNames.includes(node.id?.name)) constructors.set(node.id.name, node.init);
  if (node.type === 'FunctionDeclaration' && node.start > 1100000 && node.start < 1250000) {
    const text = source.slice(node.start, node.end);
    if (text.length < 16000 && (/ak\("\/(?:user|vault|sync|publish|subscription)\//.test(text) || node.id?.name === 'ak')) cloudHelpers.push(node);
  }
  if (node.type === 'StringLiteral' && /^\/(?:user|vault|sync|publish|subscription)\//.test(node.value)) endpointLiterals.push({ value: node.value, utf16Offset: node.start });
  if (node.type === 'VariableDeclaration' && node.start > 1160000 && node.start < 1180000 && node.declarations.some(d => d.id?.name === 'tk')) bridgeDeclarations.push(node);
});
fs.mkdirSync(outputDir, { recursive: true });
const derivedDir = path.join(outputDir, 'derived-scope');
fs.mkdirSync(derivedDir);
const segments = [];
function retain(name, start, end, prefix = '', suffix = '') {
  const exact = source.slice(start, end);
  const file = name + '.js';
  const projected = prefix + exact + suffix;
  fs.writeFileSync(path.join(derivedDir, file), projected, { flag: 'wx' });
  segments.push({ file, member: 'app.js', utf16Start: start, utf16End: end,
    byteStart: Buffer.byteLength(source.slice(0, start)), byteEnd: Buffer.byteLength(source.slice(0, end)),
    sourceSliceSha256: sha(exact), projectedSha256: sha(projected), prefix, suffix });
}
retain('registration', registryStart, registryEnd, '', ';\n');
const plugins = [];
for (const symbol of ctorNames) {
  const init = constructors.get(symbol);
  if (!init) throw new Error('Missing constructor ' + symbol);
  let ctor;
  walk(init, node => {
    if (!ctor && node.type === 'FunctionDeclaration' && /\b(?:this|[a-z])\.id="[a-z-]+"/.test(source.slice(node.start, node.end))) ctor = node;
  });
  if (!ctor) throw new Error('Missing ID constructor ' + symbol);
  const text = source.slice(ctor.start, ctor.end);
  const id = text.match(/\b(?:this|[a-z])\.id="([a-z-]+)"/)[1];
  const defaultMatch = text.match(/\.defaultOn=(!0|!1|true|false)/);
  const condition = symbol === 'gte' ? 'Ab.publish' : symbol === 'vne' ? 'Ab.sync' : symbol === 'R4' ? 'rd.isDesktopApp && Ab.webViewer' : 'unconditional registration';
  plugins.push({ id, symbol, registrationCondition: condition,
    defaultOn: defaultMatch ? ['!0', 'true'].includes(defaultMatch[1]) : null,
    constructorUtf16Start: ctor.start, constructorUtf16End: ctor.end,
    enabledAtRuntime: 'not-observed' });
  retain('constructor-' + id, ctor.start, ctor.end);
}
cloudHelpers.sort((a, b) => a.start - b.start);
for (const helper of cloudHelpers) retain('cloud-' + helper.id.name + '-' + helper.start, helper.start, helper.end);
for (const declaration of bridgeDeclarations) retain('cloud-origin-' + declaration.start, declaration.start, declaration.end);
const cloudMethods = [];
for (const symbol of ['vne', 'gte']) {
  walk(constructors.get(symbol), node => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression' || node.right.type !== 'FunctionExpression') return;
    const method = node.left.property?.name;
    if (node.left.object?.property?.name !== 'prototype' || !method) return;
    cloudMethods.push({ plugin: symbol === 'vne' ? 'sync' : 'publish', method, utf16Start: node.start, utf16End: node.end });
    if (['getHost', 'getStatus', 'requestSync', 'uploadFile'].includes(method) && node.end - node.start < 16000) retain('cloud-method-' + symbol + '-' + method, node.start, node.end, '', ';\n');
  });
}
const manifest = { schema: 'obsidian-rea-targeted-scope-v1', authority: 'supplemental-static-artifact-inspection',
  applicationVersion: packageInfo.version, sampleSha256: sha(bytes), memberSha256: sha(sourceBytes),
  sourceMember: 'app.js', sourceByteLength: sourceBytes.length,
  registration: { utf16Start: registryStart, utf16End: registryEnd, registeredConstructorCount: ctorNames.length },
  plugins, endpointLiterals, cloudMethods, segments,
  limitations: ['This derived tree is not the complete application.', 'Wrapper syntax only makes exact slices parseable; external bindings stay unresolved.', 'Registration is not runtime enablement.', 'Static endpoints do not prove server behavior, successful calls or protocol compatibility.'] };
fs.writeFileSync(path.join(outputDir, 'scope-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ outputDir, version: packageInfo.version, sampleSha256: manifest.sampleSha256, plugins, cloudHelperCount: cloudHelpers.length, endpointCount: endpointLiterals.length }, null, 2));
