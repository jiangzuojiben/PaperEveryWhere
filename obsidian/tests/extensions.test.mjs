import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost, PluginCompatibilityError, TFile, TFolder } from '../app/extensions.js';

// Node cannot import blob: URLs. This loader runs the same CommonJS wrapper as
// a data module; renderer Blob/CSP integration is a separate acceptance check.
const moduleLoader = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(initial = { 'Home.md': '# Home\n[[Target]]\n#reading', 'Target.md': 'Original' }, { stale = false, externalEvents = true, emitOnOpen = false } = {}) {
  let mtime = 1, active = 'Home.md';
  const disk = new Map(Object.entries(initial).map(([path, content]) => [path, { path, content, mtime: mtime++ }]));
  const frozen = Object.fromEntries(Object.entries(initial));
  const listeners = new Set(), external = new Set(), commands = new Map(), notices = [], opened = [], calls = [];
  const bridge = {
    snapshot: async () => ({ vaultPath: 'test-vault', files: [...disk.values()].map(record => ({ ...record })) }),
    read: async path => { const record = disk.get(path); if (!record || record.isDirectory) throw new Error('File not found'); return { content: record.content, mtime: record.mtime }; },
    write: async (path, content, expected) => { const old = disk.get(path); if (!old) throw new Error('File not found'); if (expected !== old.mtime) throw new Error('File changed'); const record = { path, content, mtime: mtime++ }; disk.set(path, record); return { mtime: record.mtime }; },
    create: async (path, content) => { if (disk.has(path)) throw new Error('File exists'); const record = { path, content, mtime: mtime++ }; disk.set(path, record); return { mtime: record.mtime }; },
    mkdir: async path => { if (disk.has(path)) throw new Error('File exists'); disk.set(path, { path, isDirectory: true }); },
    rename: async (from, to, settings) => { calls.push({ name: 'rename', from, to, settings }); for (const [path, record] of [...disk]) if (path === from || path.startsWith(from + '/')) { disk.delete(path); const next = to + path.slice(from.length); disk.set(next, { ...record, path: next }); } },
    trash: async path => { for (const name of [...disk.keys()]) if (name === path || name.startsWith(path + '/')) disk.delete(name); },
    onChange: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const host = createExtensionHost({ bridge, moduleLoader,
    getFiles: () => stale ? frozen : [...disk.values()].map(record => ({ ...record })),
    getActivePath: () => active,
    openFile: async (path, state) => { active = path; opened.push({ path, state }); if (emitOnOpen) external.forEach(listener => listener({ scope: 'workspace', name: 'file-open', path })); },
    notice: message => notices.push(message),
    addCommand: command => commands.set(command.id, command), removeCommand: id => commands.delete(id),
    onEvent: externalEvents ? listener => { external.add(listener); return () => external.delete(listener); } : undefined,
  });
  return { host, bridge, disk, commands, notices, opened, calls, listeners, external,
    emit: event => external.forEach(listener => listener(event)), change: () => listeners.forEach(listener => listener({ type: 'change' })),
  };
}
const expose = 'const { Plugin } = require("obsidian"); module.exports = class extends Plugin { onload() { globalThis.__extensionTest = this; } };';

class FakeElement extends EventTarget {
  constructor(tagName = 'div') {
    super(); this.tagName = tagName.toUpperCase(); this.children = []; this.style = {}; this.attributes = new Map(); this.className = ''; this.textContent = ''; this.value = ''; this.checked = false;
    const classes = new Set(); this.classList = { add: (...items) => items.forEach(item => classes.add(item)), remove: (...items) => items.forEach(item => classes.delete(item)), toggle: (item, enabled) => { enabled ??= !classes.has(item); enabled ? classes.add(item) : classes.delete(item); return enabled; }, contains: item => classes.has(item) };
  }
  appendChild(child) { child.remove?.(); this.children.push(child); child.parentNode = this; return child; }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; children.forEach(child => this.appendChild(child)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'value') this.value = String(value); }
  removeAttribute(name) { this.attributes.delete(name); }
}
function installDom(t) {
  const original = globalThis.document;
  const document = new EventTarget(); document.createElement = tag => new FakeElement(tag); document.body = new FakeElement('body');
  globalThis.document = document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  return document;
}

test('source executes only on explicit enable; commands and events are removed on disable', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  globalThis.__extensionLoads = 0; globalThis.__extensionEvents = 0; globalThis.__extensionCleanups = 0;
  const source = `const { Plugin, Notice } = require('obsidian');
    module.exports = class extends Plugin {
      onload() {
        globalThis.__extensionLoads++;
        this.addCommand({ id: 'greet', name: 'Greet', callback: () => new Notice(this.app.workspace.getActiveFile().basename) });
        this.registerEvent(this.app.workspace.on('file-open', () => globalThis.__extensionEvents++));
        this.register(() => globalThis.__extensionCleanups++);
      }
    };`;
  assert.equal(globalThis.__extensionLoads, 0);
  assert.deepEqual(f.host.list(), []);
  await f.host.enable({ id: 'example', name: 'Example' }, source);
  assert.equal(globalThis.__extensionLoads, 1);
  assert.equal(f.host.list()[0].state, 'enabled');
  await f.commands.get('example:greet').callback();
  assert.deepEqual(f.notices, ['Home']);
  f.emit({ type: 'file-open', path: 'Target.md' });
  assert.equal(globalThis.__extensionEvents, 1);
  await assert.rejects(f.host.enable({ id: 'example' }, source), /already enabled/);
  const savedCommand = f.commands.get('example:greet');
  await f.host.disable('example');
  await savedCommand.callback(); f.emit({ type: 'file-open', path: 'Home.md' });
  assert.equal(globalThis.__extensionEvents, 1);
  assert.equal(globalThis.__extensionCleanups, 1);
  assert.equal(f.commands.size, 0); assert.deepEqual(f.host.list(), []);
  assert.equal(await f.host.disable('example'), false);
});

test('file-open uses external UI events once and falls back only when no event source exists', async t => {
  for (const externalEvents of [true, false]) {
    const f = fixture(undefined, { externalEvents, emitOnOpen: true }); t.after(() => f.host.dispose());
    await f.host.enable({ id: `navigation-events-${externalEvents}` }, expose);
    const { vault, workspace } = globalThis.__extensionTest.app, opened = [];
    workspace.on('file-open', file => opened.push(file?.path ?? null));
    await workspace.getLeaf(false).openFile(vault.getFileByPath('Target.md'));
    await workspace.openLinkText('Home#Heading', 'Target.md');
    assert.deepEqual(opened, ['Target.md', 'Home.md']);
    assert.equal(f.opened[1].state.subpath, '#Heading');
  }
  const delayed = fixture(); t.after(() => delayed.host.dispose());
  await delayed.host.enable({ id: 'delayed-ui-event' }, expose);
  const { workspace } = globalThis.__extensionTest.app, opened = [];
  workspace.on('file-open', file => opened.push(file?.path ?? null));
  await workspace.openLinkText('Target', 'Home.md');
  assert.deepEqual(opened, []);
  delayed.emit({ scope: 'workspace', name: 'file-open', path: 'Target.md' });
  assert.deepEqual(opened, ['Target.md']);
});

test('Node imports and unsupported APIs fail explicitly without leaving a plugin or loader context', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  for (const name of ['fs', 'node:path', 'electron', './helper']) {
    await assert.rejects(f.host.enable({ id: 'unsupported' }, `require(${JSON.stringify(name)});`), error => error instanceof PluginCompatibilityError && error.message.includes('Supported modules:'));
    assert.deepEqual(f.host.list(), []);
  }
  await assert.rejects(f.host.enable({ id: 'unsupported' }, `const { FileSystemAdapter } = require('obsidian');`), /obsidian.FileSystemAdapter/);
  await assert.rejects(f.host.enable({ id: 'unsupported' }, `const {Plugin}=require('obsidian');module.exports=class extends Plugin{onload(){this.app.workspace.registerHoverLinkSource();}};`), /app.workspace.registerHoverLinkSource/);
  assert.equal(Object.keys(globalThis).filter(key => key.startsWith('__vaultdesk_plugin_')).length, 0);
});

test('constructor and onload failures roll back registered resources and commands', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  globalThis.__constructorCleaned = 0; globalThis.__failedEvents = 0;
  await assert.rejects(f.host.enable({ id: 'broken-constructor' }, `const { Plugin } = require('obsidian');module.exports=class extends Plugin { constructor(...args){super(...args);this.register(()=>globalThis.__constructorCleaned++);throw new Error('constructor boom');} };`), /constructor boom/);
  assert.equal(globalThis.__constructorCleaned, 1);
  await assert.rejects(f.host.enable({ id: 'broken-load' }, `const { Plugin } = require('obsidian');module.exports=class extends Plugin {onload(){this.addCommand({id:'orphan',callback:()=>{}});this.registerEvent(this.app.workspace.on('file-open',()=>globalThis.__failedEvents++));throw new Error('onload boom');}};`), /onload boom/);
  f.emit({ type: 'file-open', path: 'Home.md' });
  assert.equal(globalThis.__failedEvents, 0); assert.equal(f.commands.size, 0); assert.deepEqual(f.host.list(), []);
});

test('disable blocks callbacks and removes resources before a slow onunload settles', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const gate = deferred(); globalThis.__unloadGate = gate.promise; globalThis.__duringUnload = 0; globalThis.__intervalId = null;
  await f.host.enable({ id: 'slow-unload' }, `const { Plugin }=require('obsidian');module.exports=class extends Plugin{
    onload(){this.addCommand({id:'count',callback:()=>globalThis.__duringUnload++});this.app.workspace.on('file-open',()=>globalThis.__duringUnload++);globalThis.__intervalId=setInterval(()=>globalThis.__duringUnload++,10000);this.registerInterval(globalThis.__intervalId);}
    async onunload(){await this.saveData({closed:true});await globalThis.__unloadGate;}
  };`);
  const command = f.commands.get('slow-unload:count');
  const disabling = f.host.disable('slow-unload');
  assert.equal(f.host.list()[0].state, 'disabling'); assert.equal(f.commands.size, 0);
  await command.callback(); f.emit({ type: 'file-open', path: 'Home.md' });
  assert.equal(globalThis.__duringUnload, 0);
  assert.equal(globalThis.__intervalId._destroyed, true);
  gate.resolve(); await disabling;
  assert.deepEqual(f.host.list(), []);
});

test('disable during asynchronous onload cancels enable and cleans before the load completes', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const entered = deferred(), gate = deferred(); globalThis.__loadEntered = entered.resolve; globalThis.__loadGate = gate.promise; globalThis.__pendingCleanup = 0;
  const enabling = f.host.enable({ id: 'pending' }, `const {Plugin}=require('obsidian');module.exports=class extends Plugin{async onload(){this.register(()=>globalThis.__pendingCleanup++);this.addCommand({id:'pending',callback:()=>{}});globalThis.__loadEntered();await globalThis.__loadGate;}};`);
  const rejected = assert.rejects(enabling, /unloaded|cancelled/);
  await entered.promise;
  const disabling = f.host.disable('pending');
  await tick();
  assert.equal(f.commands.size, 0); assert.equal(globalThis.__pendingCleanup, 1);
  gate.resolve(); await rejected; await disabling;
  assert.deepEqual(f.host.list(), []);
});

test('unload failures do not skip other cleanup and dispose unregisters host subscriptions', async t => {
  const f = fixture(); t.after(() => f.host.dispose()); globalThis.__cleanupAfterError = 0;
  await f.host.enable({ id: 'cleanup-errors' }, `const {Plugin}=require('obsidian');module.exports=class extends Plugin{onload(){this.register(()=>globalThis.__cleanupAfterError++);this.register(()=>{throw new Error('resource boom')});this.addCommand({id:'cmd',callback:()=>{}});}onunload(){throw new Error('unload boom');}};`);
  await assert.rejects(f.host.disable('cleanup-errors'), /cleanup failed/);
  assert.equal(globalThis.__cleanupAfterError, 1); assert.equal(f.commands.size, 0); assert.deepEqual(f.host.list(), []);
  const first = f.host.dispose(), second = f.host.dispose(); assert.equal(first, second); await first;
  assert.equal(f.listeners.size, 0); assert.equal(f.external.size, 0);
  await assert.rejects(f.host.enable({ id: 'later' }, expose), /disposed/);
});

test('vault CRUD, file identities, core metadata and openLinkText work through the bridge', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  await f.host.enable({ id: 'files' }, expose);
  const { app } = globalThis.__extensionTest;
  const home = app.vault.getAbstractFileByPath('Home.md'); assert.ok(home instanceof TFile);
  assert.equal(app.vault.getMarkdownFiles().length, 2);
  assert.equal(app.metadataCache.getFirstLinkpathDest('Target', 'Home.md').path, 'Target.md');
  assert.equal(app.metadataCache.getFileCache(home).headings[0].position.start.line, 0);
  assert.deepEqual(app.metadataCache.getFileCache(home).tags, [{ tag: '#reading' }]);
  assert.equal(app.metadataCache.resolvedLinks['Home.md']['Target.md'], 1);
  await app.workspace.openLinkText('Target#Heading', 'Home.md');
  assert.equal(f.opened[0].path, 'Target.md'); assert.equal(f.opened[0].state.subpath, '#Heading');
  const folder = await app.vault.createFolder('Notes'); assert.ok(folder instanceof TFolder);
  const file = await app.vault.create('Notes/New.md', '# New');
  await app.vault.append(file, '\nText');
  assert.equal(await app.vault.read(file), '# New\nText');
  assert.equal(app.vault.getAbstractFileByPath('Notes').children[0], file);
  await app.vault.rename(file, 'Notes/Renamed.md');
  assert.equal(f.calls.at(-1).settings.via, 'storage'); assert.equal(file.path, 'Notes/Renamed.md');
  assert.equal(app.vault.getAbstractFileByPath('Notes/New.md'), null);
  assert.equal(app.vault.getAbstractFileByPath('Notes/Renamed.md'), file);
  await app.vault.trash(file, false); assert.equal(app.vault.getAbstractFileByPath('Notes/Renamed.md'), null);
  assert.throws(() => app.vault.delete(home), /Permanent deletion/);
  await assert.rejects(app.vault.create('../outside.md', 'bad'), /inside the vault/);
  await assert.rejects(app.vault.create('.obsidian/config.json', '{}'), /configuration/);
});

test('concurrent writes and creates preserve newer cached values while the UI snapshot is stale', async t => {
  const f = fixture({ 'a.md': 'A', 'b.md': 'B' }, { stale: true }); t.after(() => f.host.dispose());
  await f.host.enable({ id: 'parallel' }, expose); const { vault } = globalThis.__extensionTest.app;
  const a = vault.getAbstractFileByPath('a.md'), b = vault.getAbstractFileByPath('b.md');
  await Promise.all([vault.modify(a, 'A1'), vault.modify(b, 'B1')]);
  assert.equal(await vault.cachedRead(a), 'A1'); assert.equal(await vault.cachedRead(b), 'B1');
  await Promise.all([vault.process(a, text => text + '2'), vault.create('new.md', 'N'), vault.createFolder('folder')]);
  assert.equal(await vault.cachedRead(a), 'A12'); assert.equal(await vault.cachedRead(b), 'B1');
  assert.equal(await vault.cachedRead(vault.getAbstractFileByPath('new.md')), 'N');
  assert.ok(vault.getAbstractFileByPath('folder') instanceof TFolder);
  await Promise.all([vault.process(a, text => text + '3'), vault.process(a, text => text + '4')]);
  assert.equal(await vault.read(a), 'A1234');
});

test('rename retries an in-flight snapshot after another mutation commits', async t => {
  const f = fixture({ 'a.md': 'A', 'b.md': 'B' }, { stale: true }); t.after(() => f.host.dispose());
  await f.host.enable({ id: 'rename-race' }, expose); const { vault } = globalThis.__extensionTest.app;
  const a = vault.getFileByPath('a.md'), b = vault.getFileByPath('b.md');
  const renameEntered = deferred(), renameGate = deferred(), snapshotEntered = deferred(), snapshotGate = deferred();
  const originalRename = f.bridge.rename, originalSnapshot = f.bridge.snapshot;
  f.bridge.rename = async (...args) => { await originalRename(...args); renameEntered.resolve(); await renameGate.promise; };
  let snapshots = 0;
  f.bridge.snapshot = async () => {
    const snapshot = await originalSnapshot();
    if (++snapshots === 1) { snapshotEntered.resolve(); await snapshotGate.promise; }
    return snapshot;
  };
  const renaming = vault.rename(a, 'renamed.md');
  await renameEntered.promise;
  await vault.modify(b, 'B1'); renameGate.resolve();
  await snapshotEntered.promise;
  await vault.modify(b, 'B2'); snapshotGate.resolve();
  await renaming;
  assert.equal(snapshots, 2);
  assert.equal(await vault.cachedRead(b), 'B2'); assert.equal(await vault.read(b), 'B2');
  assert.equal(vault.getFileByPath('a.md'), null);
  assert.equal(vault.getFileByPath('renamed.md'), a);
});

test('external bridge changes emit vault events and disabled listeners stay quiet', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  await f.host.enable({ id: 'events' }, expose); const { vault, metadataCache } = globalThis.__extensionTest.app;
  const modified = [], cached = [];
  const handler = file => modified.push(file.path);
  vault.on('modify', handler); metadataCache.on('changed', (file, text) => cached.push([file.path, text]));
  await f.bridge.write('Target.md', 'Outside', f.disk.get('Target.md').mtime); f.change(); await tick();
  assert.deepEqual(modified, ['Target.md']); assert.deepEqual(cached, [['Target.md', 'Outside']]);
  vault.off('modify', handler);
  await f.bridge.write('Target.md', 'Again', f.disk.get('Target.md').mtime); f.change(); await tick();
  assert.equal(modified.length, 1);
  await f.host.disable('events');
  await f.bridge.write('Target.md', 'After disable', f.disk.get('Target.md').mtime); f.change(); await tick();
  assert.equal(cached.length, 2);
});

test('Modal, settings controls and MarkdownView use the supported DOM subset and clean up', async t => {
  const document = installDom(t), f = fixture(); t.after(() => f.host.dispose());
  await f.host.enable({ id: 'interface', name: 'Interface' }, `const {Plugin,Modal,Setting,PluginSettingTab,MarkdownView}=require('obsidian');
    module.exports=class extends Plugin {onload(){
      globalThis.__extensionTest=this;globalThis.__markdownView=this.app.workspace.getActiveViewOfType(MarkdownView);
      class Tab extends PluginSettingTab {display(){this.containerEl.empty();new Setting(this.containerEl).setName('Greeting').addText(input=>{globalThis.__settingInput=input.inputEl;input.setValue('Hi').onChange(value=>globalThis.__settingValue=value);});}}
      this.addSettingTab(new Tab(this.app,this));
      this.addCommand({id:'modal',callback:()=>{const modal=new Modal(this.app);modal.setTitle('Details');modal.onOpen=()=>modal.contentEl.createEl('p',{text:'Hello'});modal.open();}});
    }};`);
  assert.equal(globalThis.__markdownView.file.path, 'Home.md');
  assert.match(globalThis.__markdownView.getViewData(), /^# Home/);
  assert.throws(() => globalThis.__markdownView.editor, error => error.code === 'PLUGIN_API_UNSUPPORTED' && error.api === 'MarkdownView.editor');
  await f.commands.get('interface:settings').callback(); assert.equal(document.body.children.length, 1);
  globalThis.__settingInput.value = 'Changed'; globalThis.__settingInput.dispatchEvent(new Event('input'));
  assert.equal(globalThis.__settingValue, 'Changed');
  await f.commands.get('interface:modal').callback(); assert.equal(document.body.children.length, 2);
  await f.host.disable('interface'); assert.equal(document.body.children.length, 0); assert.equal(f.commands.size, 0);
});

test('layout callbacks are cancelled on disable and exports.default CommonJS plugins are accepted', async t => {
  const f = fixture(); t.after(() => f.host.dispose()); globalThis.__layoutReady = 0;
  await f.host.enable({ id: 'default-export' }, `const {Plugin}=require('obsidian');exports.default=class extends Plugin{onload(){this.app.workspace.onLayoutReady(()=>globalThis.__layoutReady++);}};`);
  await tick(); assert.equal(globalThis.__layoutReady, 1);
  await f.host.disable('default-export'); assert.deepEqual(f.host.list(), []);
});

test('failed cleanup during pending onload is observed immediately and still reported by disable', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const entered = deferred(), gate = deferred(); globalThis.__loadEntered = entered.resolve; globalThis.__loadGate = gate.promise;
  const enabling = f.host.enable({ id: 'pending-cleanup-error' }, `const {Plugin}=require('obsidian');module.exports=class extends Plugin{async onload(){this.register(()=>{throw new Error('cleanup boom')});globalThis.__loadEntered();await globalThis.__loadGate;}};`);
  const rejected = assert.rejects(enabling, /unloaded|cancelled/);
  await entered.promise;
  const disabled = assert.rejects(f.host.disable('pending-cleanup-error'), /cleanup failed/);
  await new Promise(resolve => setTimeout(resolve, 20));
  gate.resolve(); await rejected; await disabled;
  assert.deepEqual(f.host.list(), []);
});

test('vault changes revoke enabled plugins and unload data stays in the original vault namespace', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const previousStorage = globalThis.localStorage, data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  t.after(() => { if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage; });
  await f.host.enable({ id: 'vault-owned' }, `const {Plugin}=require('obsidian');module.exports=class extends Plugin{onload(){globalThis.__extensionTest=this;}async onunload(){await this.saveData({closed:true});}};`);
  const plugin = globalThis.__extensionTest;
  f.bridge.snapshot = async () => ({ vaultPath: 'different-vault', files: [{ path: 'Other.md', content: 'Other' }] });
  f.change(); await tick(); await tick();
  assert.deepEqual(f.host.list(), []);
  assert.deepEqual(JSON.parse(data.get('vaultdesk:plugin-data:test-vault:vault-owned')), { closed: true });
  assert.equal(data.has('vaultdesk:plugin-data:different-vault:vault-owned'), false);
  await assert.rejects(plugin.app.vault.create('Wrong.md', 'No'), /disabled/);
});
