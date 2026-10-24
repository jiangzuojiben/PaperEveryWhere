import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createExtensionHost, TFile } from '../app/extensions.js';
import { parseMarkdown } from '../core/vault.mjs';

// Match the existing extension fixture's CommonJS/data-module loader. Renderer
// Blob URLs and rich Markdown DOM integration are covered separately.
const moduleLoader = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const version = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = value => typeof value === 'string' ? Buffer.from(value)
  : value instanceof ArrayBuffer ? Buffer.from(new Uint8Array(value))
    : Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

class FakeElement extends EventTarget {
  constructor(tagName = 'div') {
    super(); this.tagName = tagName.toUpperCase(); this.children = []; this.style = {}; this.dataset = {}; this.attributes = new Map(); this.className = ''; this.textContent = '';
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle: (name, enabled) => { enabled ??= !classes.has(name); enabled ? classes.add(name) : classes.delete(name); return enabled; } };
  }
  appendChild(child) { child.remove?.(); this.children.push(child); child.parentNode = this; return child; }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; children.forEach(child => this.appendChild(child)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
}

function installDom(t) {
  const original = globalThis.document;
  const document = new EventTarget(); document.createElement = tag => new FakeElement(tag); document.body = new FakeElement('body');
  globalThis.document = document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
}

function fixture(initial = { 'Home.md': '# Home', 'Target.md': 'Target' }, { stale = false } = {}) {
  let clock = 1;
  const disk = new Map(Object.entries(initial).map(([path, value]) => [path, { path, bytes: bytesOf(value), mtime: clock++ }]));
  const snapshotRecords = () => [...disk.values()].map(record => record.isDirectory
    ? { path: record.path, isDirectory: true }
    : { path: record.path, mtime: record.mtime, size: record.bytes.length, ...(/\.(?:md|txt|json)$/i.test(record.path) ? { content: record.bytes.toString('utf8'), version: version(record.bytes) } : {}) });
  const frozen = snapshotRecords();
  const listeners = new Set(), external = new Set(), commands = new Map(), notices = [], calls = [];
  const getRecord = path => { const record = disk.get(path); if (!record || record.isDirectory) throw new Error('File not found: ' + path); return record; };
  const check = (record, expectedMtime, expectedVersion) => {
    if (expectedMtime != null && Math.abs(expectedMtime - record.mtime) > 0.001) throw Object.assign(new Error('File changed'), { code: 'MTIME_CONFLICT', currentMtime: record.mtime });
    if (expectedVersion != null && expectedVersion !== version(record.bytes)) throw Object.assign(new Error('File changed'), { code: 'VERSION_CONFLICT', currentMtime: record.mtime });
  };
  const put = (path, bytes) => {
    const record = { path, bytes: Buffer.from(bytes), mtime: clock++ }; disk.set(path, record);
    return { path, mtime: record.mtime, size: record.bytes.length, version: version(record.bytes) };
  };
  const bridge = {
    snapshot: async () => ({ vaultPath: 'round3-vault', files: snapshotRecords() }),
    read: async path => { const record = getRecord(path); calls.push({ method: 'read', path }); return { content: record.bytes.toString('utf8'), mtime: record.mtime, version: version(record.bytes) }; },
    write: async (path, content, expectedMtime, expectedVersion) => { calls.push({ method: 'write', path, expectedMtime, expectedVersion }); check(getRecord(path), expectedMtime, expectedVersion); return put(path, Buffer.from(content)); },
    create: async (path, content = '') => { if (disk.has(path)) throw new Error('File exists'); return put(path, Buffer.from(content)); },
    readBinary: async path => { const record = getRecord(path); calls.push({ method: 'readBinary', path }); return { base64: record.bytes.toString('base64'), mtime: record.mtime, version: version(record.bytes) }; },
    writeBinary: async (path, base64) => { calls.push({ method: 'writeBinary', path }); if (disk.has(path)) throw new Error('File exists'); return put(path, Buffer.from(base64, 'base64')); },
    modifyBinary: async (path, base64, expectedMtime, expectedVersion) => { calls.push({ method: 'modifyBinary', path, expectedMtime, expectedVersion }); check(getRecord(path), expectedMtime, expectedVersion); return put(path, Buffer.from(base64, 'base64')); },
    mkdir: async path => { if (disk.has(path)) throw new Error('File exists'); disk.set(path, { path, isDirectory: true }); },
    rename: async (from, to) => { if (disk.has(to)) throw new Error('File exists'); for (const [path, record] of [...disk]) if (path === from || path.startsWith(from + '/')) { disk.delete(path); const next = to + path.slice(from.length); disk.set(next, { ...record, path: next }); } },
    trash: async path => { for (const name of [...disk.keys()]) if (name === path || name.startsWith(path + '/')) disk.delete(name); },
    onChange: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const leaves = new Map([...disk.keys()].filter(path => /\.md$/i.test(path)).slice(0, 2).map((path, index) => [`leaf-${index + 1}`, { id: `leaf-${index + 1}`, type: 'markdown', state: { file: path } }]));
  let activeLeafId = leaves.keys().next().value || null, leafSequence = leaves.size;
  const editors = new Map([...leaves].map(([id, leaf]) => {
    let value = getRecord(leaf.state.file).bytes.toString('utf8');
    const status = { mode: 'source', canEdit: true, readOnly: false };
    return [id, { path: leaf.state.file, status, getStatus: () => ({ ...status }), getValue: () => value, setValue: next => { value = next; }, replaceSelection: next => { value += next; }, focus() {}, hasFocus: () => true }];
  }));
  const workspaceAdapter = {
    getLeaves: () => structuredClone([...leaves.values()]),
    getActiveLeafId: () => activeLeafId,
    createLeaf: () => { const id = `leaf-${++leafSequence}`, leaf = { id, type: 'empty', state: {} }; leaves.set(id, leaf); activeLeafId = id; return leaf; },
    openFile: async (id, path, state) => { leaves.set(id, { id, type: 'markdown', state: { file: path, ...state } }); if (state?.active !== false) activeLeafId = id; },
    setViewState: async (id, state) => { leaves.set(id, { id, ...structuredClone(state) }); },
    revealLeaf: async id => { activeLeafId = id; },
    detachLeaf: async id => { leaves.delete(id); editors.delete(id); if (activeLeafId === id) activeLeafId = leaves.keys().next().value || null; },
    getLayout: () => ({ leaves: structuredClone([...leaves.values()]), activeLeafId }),
    changeLayout: async layout => { leaves.clear(); for (const leaf of layout.leaves) leaves.set(leaf.id, structuredClone(leaf)); activeLeafId = layout.activeLeafId; },
    requestSaveLayout: () => {},
  };
  const host = createExtensionHost({ bridge, moduleLoader, workspaceAdapter,
    getFiles: () => stale ? frozen : snapshotRecords(), getActivePath: () => leaves.get(activeLeafId)?.state?.file || null, getEditor: id => editors.get(id),
    notice: message => notices.push(message), addCommand: command => commands.set(command.id, command), removeCommand: id => commands.delete(id),
    onEvent: listener => { external.add(listener); return () => external.delete(listener); },
  });
  return { host, bridge, disk, commands, notices, calls, leaves, editors, workspaceAdapter,
    text: path => getRecord(path).bytes.toString('utf8'),
    emit: event => external.forEach(listener => listener(event)),
  };
}

const expose = 'const { Plugin, MarkdownView, requestUrl, request } = require("obsidian"); module.exports = class extends Plugin { onload() { globalThis.__round3Extension = { plugin: this, MarkdownView, requestUrl, request }; } };';
async function enable(t, f, id) {
  t.after(() => f.host.dispose());
  t.after(() => { delete globalThis.__round3Extension; });
  await f.host.enable({ id, name: 'Round Three' }, expose);
  return globalThis.__round3Extension;
}

test('addCommand preserves the supplied object while qualifying its id and name', async t => {
  const f = fixture(), { plugin } = await enable(t, f, 'round3-command');
  let calls = 0;
  const command = { id: 'same-object', name: 'Same object', callback: () => { calls++; } };
  assert.equal(plugin.addCommand(command), command);
  assert.equal(command.id, 'round3-command:same-object');
  assert.equal(command.name, 'Round Three: Same object');
  assert.equal(f.commands.get(command.id), command);
  assert.equal(plugin.app.commands.executeCommandById(command.id), true);
  assert.equal(calls, 1);
  assert.equal(plugin.app.commands.executeCommandById('missing'), false);
  await f.host.disable('round3-command');
  await command.callback();
  assert.equal(calls, 1);
});

test('editorCheckCallback executes with checking=false without a preliminary true check', async t => {
  installDom(t);
  const f = fixture(), { plugin, MarkdownView } = await enable(t, f, 'round3-editor-check');
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView), seen = [];
  const command = plugin.addCommand({ id: 'insert', name: 'Insert', editorCheckCallback(checking, editor, receivedView) {
    seen.push({ checking, editor, view: receivedView });
    if (!checking) editor.replaceSelection('\nInserted');
    return true;
  } });
  assert.equal(plugin.app.commands.executeCommandById(command.id), true);
  assert.deepEqual(seen.map(call => call.checking), [false]);
  assert.equal(seen[0].editor, view.editor);
  assert.equal(seen[0].view, view);
  assert.equal(view.editor.getValue(), '# Home\nInserted');
  assert.equal(f.text('Home.md'), '# Home', 'editor commands change the live editor, not a disk-only copy');
  assert.equal(command.checkCallback(true), true);
  assert.deepEqual(seen.map(call => call.checking), [false, true]);
  assert.equal(view.editor.getValue(), '# Home\nInserted');
});

test('reading mode suppresses editor commands while recognized command execution still returns true', async t => {
  installDom(t);
  const f = fixture(), { plugin } = await enable(t, f, 'round3-reading');
  let called = 0;
  const command = plugin.addCommand({ id: 'edit', name: 'Edit', editorCallback(editor) { called++; editor.replaceSelection('!'); } });
  f.editors.get('leaf-1').status.mode = 'reading';
  assert.equal(command.checkCallback(true), false);
  assert.equal(plugin.app.commands.executeCommandById(command.id), true);
  assert.equal(called, 0);
  assert.equal(f.editors.get('leaf-1').getValue(), '# Home');
  f.editors.get('leaf-1').status.mode = 'source';
  assert.equal(plugin.app.commands.executeCommandById(command.id), true);
  assert.equal(called, 1);
  assert.equal(f.editors.get('leaf-1').getValue(), '# Home!');
});

test('public Editor.transaction returns undefined while forwarding the transaction exactly once', async t => {
  installDom(t);
  const f = fixture(), { plugin, MarkdownView } = await enable(t, f, 'round3-transaction-return');
  const calls = [], transaction = { changes: [{ from: { line: 0, ch: 0 }, text: 'Prefix ' }] };
  f.editors.get('leaf-1').transaction = (...args) => { calls.push(args); return true; };
  const editor = plugin.app.workspace.getActiveViewOfType(MarkdownView).editor;
  assert.equal(editor.transaction(transaction, 'public-probe'), undefined);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], transaction); assert.equal(calls[0][1], undefined);
});

test('editor-change supplies the changed leaf cached editor and view identities', async t => {
  installDom(t);
  const f = fixture(), { plugin } = await enable(t, f, 'round3-editor-events');
  const workspace = plugin.app.workspace;
  const changedLeaf = workspace.getLeavesOfType('markdown').find(leaf => leaf.id === 'leaf-2');
  const changedView = changedLeaf.view, changedEditor = changedView.editor, received = [];
  assert.notEqual(workspace.activeLeaf.id, changedLeaf.id);
  const context = { receiver: true };
  workspace.on('editor-change', function (editor, view) { received.push({ editor, view, context: this }); }, context);
  f.emit({ scope: 'workspace', name: 'editor-change', leafId: 'leaf-2', path: 'Target.md' });
  assert.equal(received.length, 1);
  assert.equal(received[0].editor, changedEditor);
  assert.equal(received[0].view, changedView);
  assert.equal(received[0].editor, received[0].view.editor);
  assert.equal(received[0].context, context);
  f.emit({ scope: 'workspace', name: 'editor-change', leafId: 'leaf-2', path: 'Home.md' });
  assert.equal(received.length, 1, 'a delayed event for a different document must not target the new editor');
  await f.host.disable('round3-editor-events');
  f.emit({ scope: 'workspace', name: 'editor-change', leafId: 'leaf-2', path: 'Target.md' });
  assert.equal(received.length, 1);
});

test('binary CRUD preserves exact typed-array ranges, object identity, and independent read buffers', async t => {
  const f = fixture(), { plugin } = await enable(t, f, 'round3-binary');
  const { vault } = plugin.app;
  const backing = Uint8Array.from([99, 0, 255, 128, 99]);
  const file = await vault.createBinary('Assets/data.bin', backing.subarray(1, 4));
  assert.ok(file instanceof TFile);
  assert.equal(file.stat.size, 3);
  assert.equal(vault.getFileByPath(file.path), file);
  const read = await vault.readBinary(file);
  assert.ok(read instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(read)], [0, 255, 128]);
  new Uint8Array(read)[0] = 42;
  assert.deepEqual([...new Uint8Array(await vault.readBinary(file))], [0, 255, 128]);
  const before = await f.bridge.readBinary(file.path);
  const replacement = Uint8Array.from([90, 7, 8, 90]);
  await vault.modifyBinary(file, new DataView(replacement.buffer, 1, 2));
  assert.deepEqual([...new Uint8Array(await vault.readBinary(file))], [7, 8]);
  const write = f.calls.find(call => call.method === 'modifyBinary');
  assert.equal(write.expectedMtime, before.mtime);
  assert.equal(write.expectedVersion, before.version);
  const copied = await vault.copy(file, 'Assets/copy.bin');
  assert.notEqual(copied, file);
  assert.deepEqual([...new Uint8Array(await vault.readBinary(copied))], [7, 8]);
  await assert.rejects(vault.copy(file, copied.path), /exists/);
  await assert.rejects(vault.createBinary(file.path, new Uint8Array([1])), /exists/);
  await vault.rename(file, 'Assets/renamed.bin');
  assert.equal(vault.getFileByPath('Assets/renamed.bin'), file);
  assert.equal(file.path, 'Assets/renamed.bin');
  await vault.trash(copied, false);
  assert.equal(vault.getFileByPath('Assets/copy.bin'), null);
  await vault.adapter.writeBinary('Empty.bin', new ArrayBuffer(0));
  assert.equal((await vault.adapter.readBinary('Empty.bin')).byteLength, 0);
  await vault.adapter.writeBinary('Empty.bin', Uint8Array.of(255));
  assert.deepEqual([...new Uint8Array(await vault.adapter.readBinary('Empty.bin'))], [255]);
});

test('binary updates retain fresh metadata while the application snapshot is stale', async t => {
  const f = fixture({ 'data.bin': Uint8Array.of(1, 2, 3) }, { stale: true });
  const { plugin } = await enable(t, f, 'round3-binary-cache');
  const { vault } = plugin.app, file = vault.getFileByPath('data.bin');
  await vault.modifyBinary(file, Uint8Array.of(1, 2, 3, 4, 5));
  const newMtime = f.disk.get('data.bin').mtime;
  for (let index = 0; index < 2; index++) {
    assert.equal(vault.getFileByPath('data.bin'), file);
    assert.equal(file.stat.mtime, newMtime);
    assert.equal(file.stat.size, 5);
  }
});

test('binary append operations serialize and same-mtime external changes fail the version check', async t => {
  const f = fixture({ 'data.bin': Uint8Array.of(1) });
  const { plugin } = await enable(t, f, 'round3-binary-cas');
  const { vault } = plugin.app, file = vault.getFileByPath('data.bin');
  await Promise.all([vault.appendBinary(file, Uint8Array.of(2)), vault.appendBinary(file, Uint8Array.of(3))]);
  assert.deepEqual([...new Uint8Array(await vault.readBinary(file))], [1, 2, 3]);
  const actualRead = f.bridge.readBinary;
  f.bridge.readBinary = async path => {
    const original = await actualRead(path);
    f.disk.get(path).bytes = Buffer.from([9, 9, 9]);
    f.bridge.readBinary = actualRead;
    return original;
  };
  await assert.rejects(vault.modifyBinary(file, Uint8Array.of(8)), error => error.code === 'VERSION_CONFLICT');
  assert.deepEqual([...new Uint8Array(await vault.readBinary(file))], [9, 9, 9]);
});

test('processFrontMatter serializes updates with vault.process on the same file and forwards both CAS tokens', async t => {
  const initial = '---\r\ncount: 0\r\nkeep: true # retain comment\r\n---\r\n\r\nBody untouched\r\n';
  const f = fixture({ 'Home.md': initial }, { stale: true });
  const { plugin } = await enable(t, f, 'round3-frontmatter-serial');
  const { vault, fileManager } = plugin.app, file = vault.getFileByPath('Home.md');
  const entered = deferred(), release = deferred(), seen = [];
  const actualWrite = f.bridge.write;
  let blocked = false;
  f.bridge.write = async (...args) => { if (!blocked) { blocked = true; entered.resolve(); await release.promise; } return actualWrite(...args); };
  const first = fileManager.processFrontMatter(file, fm => { seen.push(fm.count); fm.count++; });
  await entered.promise;
  const second = fileManager.processFrontMatter(file, fm => { seen.push(fm.count); fm.count++; });
  const third = vault.process(file, text => text + 'Appended\r\n');
  try {
    await tick();
    assert.deepEqual(seen, [0], 'a second callback cannot read the pre-commit file');
  } finally {
    release.resolve();
  }
  await Promise.all([first, second, third]);
  const final = await vault.read(file);
  assert.deepEqual(seen, [0, 1]);
  assert.equal(parseMarkdown(final).frontmatter.count, 2);
  assert.match(final, /keep: true # retain comment\r\n/);
  assert.ok(final.endsWith('\r\n\r\nBody untouched\r\nAppended\r\n'));
  assert.equal(await vault.cachedRead(file), final);
  const writes = f.calls.filter(call => call.method === 'write');
  assert.equal(writes.length, 3);
  assert.equal(writes[0].expectedVersion, version(Buffer.from(initial)));
  assert.ok(writes.every(write => Number.isFinite(write.expectedMtime) && /^[a-f0-9]{64}$/.test(write.expectedVersion)));
  assert.ok(writes[1].expectedMtime > writes[0].expectedMtime);
});

test('processFrontMatter rejects concurrent external edits and invalid callbacks without overwriting bytes', async t => {
  const initial = '---\ncount: 1\n---\nBody\n';
  const f = fixture({ 'Home.md': initial });
  const { plugin } = await enable(t, f, 'round3-frontmatter-cas');
  const { vault, fileManager } = plugin.app, file = vault.getFileByPath('Home.md');
  const external = '---\ncount: 40\n---\nExternal body\n';
  const actualWrite = f.bridge.write;
  f.bridge.write = async (...args) => { f.disk.get('Home.md').bytes = Buffer.from(external); f.bridge.write = actualWrite; return actualWrite(...args); };
  await assert.rejects(fileManager.processFrontMatter(file, fm => { fm.count++; }), error => error.code === 'VERSION_CONFLICT');
  assert.equal(await vault.read(file), external);
  const writeCount = f.calls.filter(call => call.method === 'write').length;
  await assert.rejects(fileManager.processFrontMatter(file, () => { throw new Error('callback failed'); }), /callback failed/);
  await assert.rejects(fileManager.processFrontMatter(file, async fm => { fm.count++; }), /synchronous/);
  assert.equal(f.calls.filter(call => call.method === 'write').length, writeCount);
  assert.equal(await vault.read(file), external);
  await fileManager.processFrontMatter(file, fm => { fm.count++; });
  assert.equal(parseMarkdown(await vault.read(file)).frontmatter.count, 41, 'a failed operation must not poison the per-file queue');
});

test('requestUrl forwards binary bodies and exposes response convenience promises without repeating requests', async t => {
  const f = fixture(), received = [];
  const text = '{"ok":true,"message":"中文"}';
  f.bridge.requestUrl = async params => { received.push(params); return { status: 200, headers: { 'content-type': 'application/json' }, text, bodyBase64: Buffer.from(text).toString('base64') }; };
  const { requestUrl, request } = await enable(t, f, 'round3-request');
  const body = Uint8Array.of(0, 255, 128).buffer;
  const pending = requestUrl({ url: 'https://example.invalid/echo', method: 'POST', headers: { 'x-test': 'round3' }, contentType: 'application/octet-stream', body });
  const [response, responseText, json, arrayBuffer] = await Promise.all([pending, pending.text, pending.json, pending.arrayBuffer]);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    url: 'https://example.invalid/echo', method: 'POST', headers: { 'x-test': 'round3' }, contentType: 'application/octet-stream', body: 'AP+A', bodyEncoding: 'base64',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers, { 'content-type': 'application/json' });
  assert.equal(responseText, text);
  assert.deepEqual(json, { ok: true, message: '中文' });
  assert.ok(arrayBuffer instanceof ArrayBuffer);
  assert.deepEqual(Buffer.from(arrayBuffer), Buffer.from(text));
  assert.equal(response.arrayBuffer, arrayBuffer);
  assert.equal(await request('https://example.invalid/plain'), text);
  assert.equal(received.length, 2);
});

test('requestUrl parses JSON lazily and permits HTTP errors only with throw=false', async t => {
  const f = fixture();
  let status = 200;
  const text = 'Plain response, not JSON';
  f.bridge.requestUrl = async () => ({ status, headers: {}, text, bodyBase64: Buffer.from(text).toString('base64') });
  const { requestUrl } = await enable(t, f, 'round3-request-errors');
  const pending = requestUrl('https://example.invalid/plain');
  const response = await pending;
  assert.equal(response.text, text, 'invalid JSON must not reject an otherwise valid text response');
  assert.throws(() => response.json, SyntaxError);
  await assert.rejects(pending.json, SyntaxError);
  status = 418;
  await assert.rejects(requestUrl('https://example.invalid/failure'), error => error.status === 418);
  const allowed = await requestUrl({ url: 'https://example.invalid/failure', throw: false });
  assert.equal(allowed.status, 418);
  assert.equal(allowed.text, text);
});

test('file extensions open FileView with original lifecycle and release CSS/extensions on disable', async t => {
  installDom(t); document.head = new FakeElement('head');
  const f = fixture({'Home.md':'Home','Sample.pptx':Buffer.from([80,75,3,4])});
  t.after(() => f.host.dispose()); t.after(() => {delete globalThis.__fileViewProbe;});
  await f.host.enable({id:'file-view-lab',name:'FileView'}, `const {Plugin,FileView}=require('obsidian'); const events=[];globalThis.__fileViewProbe={events};module.exports=class extends Plugin {onload(){this.registerView('lab-file',leaf=>new class extends FileView {getViewType(){return 'lab-file'}onOpen(){events.push(['open',this.file])}onLoadFile(file){events.push(['load',file.path,this.file===file])}onUnloadFile(file){events.push(['unload',file.path,this.file===file])}}(leaf));this.registerExtensions(['pptx'],'lab-file');this.registerEditorExtension([]);}};`, '.file-view-test {color:red}');
  const {plugin} = await enable(t,f,'file-view-driver');
  const leaf=plugin.app.workspace.getLeaf();
  await leaf.openFile(plugin.app.vault.getFileByPath('Sample.pptx'));
  assert.equal(leaf.getViewState().type,'lab-file');
  assert.equal(leaf.getViewState().state.file,'Sample.pptx');
  assert.deepEqual(globalThis.__fileViewProbe.events,[['open',null],['load','Sample.pptx',true]]);
  assert.equal(document.head.children.length,1);
  assert.equal(f.host.getUI().editorExtensions.length,1);
  await f.host.disable('file-view-lab');
  assert.deepEqual(globalThis.__fileViewProbe.events.at(-1),['unload','Sample.pptx',true]);
  assert.equal(document.head.children.length,0);
  assert.equal(f.host.getUI().editorExtensions.length,0);
  assert.equal(leaf.getViewState().state.file,'Sample.pptx');
});
