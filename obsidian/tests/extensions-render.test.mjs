import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../app/extensions.js';

class Element extends EventTarget {
  constructor(tag = 'div') {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.dataset = {}; this.attributes = new Map(); this.className = ''; this.ownText = '';
    const values = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = { add: (...names) => { this.className = [...new Set([...values(), ...names])].join(' '); }, remove: (...names) => { this.className = [...values()].filter(name => !names.includes(name)).join(' '); }, contains: name => values().has(name), toggle: (name, force) => { const present = force ?? !values().has(name); present ? this.classList.add(name) : this.classList.remove(name); return present; }, [Symbol.iterator]: () => values()[Symbol.iterator]() };
  }
  get parentElement() { return this.parentNode || null; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
  appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.ownText = ''; children.forEach(child => this.appendChild(child)); }
  replaceChild(next, old) { const index = this.children.indexOf(old); assert.ok(index >= 0); next.remove(); this.children[index] = next; next.parentNode = this; old.parentNode = null; return old; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) { return selector === 'pre > code' ? this.tagName === 'CODE' && this.parentNode?.tagName === 'PRE' : selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName === selector.toUpperCase(); }
  querySelectorAll(selector) { const result = []; for (const child of this.children) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const previous = globalThis.document, document = new EventTarget();
  document.createElement = tag => new Element(tag); document.body = new Element('body'); globalThis.document = document;
  let serial = 0, active = 'original', source = '# Heading\n\n```counter\nabc\n```\n';
  const rows = new Map([['original', { id: 'original', type: 'markdown', state: { file: 'Home.md' } }]]), notices = [], commands = new Map();
  const adapter = {
    getLeaves: () => [...rows.values()].map(row => structuredClone(row)), getActiveLeafId: () => active,
    createLeaf: () => { const row = { id: `leaf-${++serial}`, type: 'empty', state: {} }; rows.set(row.id, row); active = row.id; return row; },
    setViewState: async (id, state) => { rows.set(id, { ...rows.get(id), ...structuredClone(state) }); if (state.active) active = id; },
    updateViewState: (id, state) => { rows.set(id, { ...rows.get(id), ...structuredClone(state) }); },
    openFile: async (id, path) => { rows.set(id, { id, type: 'markdown', state: { file: path } }); active = id; },
    revealLeaf: async id => { active = id; }, detachLeaf: async id => { rows.delete(id); if (active === id) active = 'original'; },
    getLayout: () => ({ main: { type: 'tabs', children: [...rows.values()].map(row => ({ id: row.id, type: 'leaf', state: { type: row.type, state: row.state } })) } }),
    changeLayout: async layout => { rows.clear(); for (const row of layout.main.children) rows.set(row.id, { id: row.id, ...row.state }); }, requestSaveLayout() {},
  };
  const render = (_source, element) => {
    const heading = new Element('h1'); heading.setAttribute('data-source-line', '1'); heading.textContent = 'Heading';
    const pre = new Element('pre'), code = new Element('code'); code.className = 'language-counter'; code.textContent = 'abc\n'; pre.appendChild(code); element.replaceChildren(heading, pre);
  };
  const host = createExtensionHost({ bridge: {}, getFiles: () => [{ path: 'Home.md', content: source }], getActivePath: () => 'Home.md', workspaceAdapter: adapter, notice: message => notices.push(message), addCommand: command => commands.set(command.id, command), removeCommand: id => commands.delete(id), moduleLoader: code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')), markdownRenderer: render });
  t.after(async () => { await host.dispose(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return { host, rows, adapter, render, notices, commands, container: () => { const result = new Element(); render(source, result); return result; } };
}
const viewPlugin = `const {Plugin,ItemView}=require('obsidian');
module.exports=class extends Plugin {onload(){globalThis.__viewsPlugin=this;this.registerView('counter-view',leaf=>new class extends ItemView{
 constructor(leaf){super(leaf);this.value=null;globalThis.__viewLog.push('constructor');}
 getViewType(){return 'counter-view';} getDisplayText(){return 'Counter panel';}
 async onOpen(){globalThis.__viewLog.push(['open',this.value]);this.contentEl.setText('opened');}
 async setState(state){this.value=state.count;globalThis.__viewLog.push(['state',state.count]);this.contentEl.setText('Count '+state.count);}
 getState(){return {count:this.value};} async onClose(){globalThis.__viewLog.push('close');}
}(leaf));}};`;

test('custom views mount in real leaf identities, serialize live state, close and restore on explicit re-enable', async t => {
  const f = fixture(t); globalThis.__viewLog = [];
  await f.host.enable({ id: 'views' }, viewPlugin);
  const workspace = globalThis.__viewsPlugin.app.workspace, leaf = workspace.getLeaf('split');
  await leaf.setViewState({ type: 'counter-view', state: { count: 7 }, active: true });
  assert.deepEqual(globalThis.__viewLog, ['constructor', ['open', null], ['state', 7]]);
  assert.equal(workspace.getLeavesOfType('counter-view')[0], leaf);
  assert.equal(f.host.getUI().views[0].element, leaf.view.containerEl);
  leaf.view.value = 9;
  assert.equal(workspace.getLayout().main.children.find(row => row.id === leaf.id).state.state.count, 9);
  workspace.requestSaveLayout(); await tick(); assert.equal(f.rows.get(leaf.id).state.count, 9);
  await f.host.disable('views');
  assert.equal(f.host.getViewElement(leaf.id), null); assert.equal(f.rows.get(leaf.id).type, 'counter-view'); assert.equal(globalThis.__viewLog.at(-1), 'close');
  await f.host.enable({ id: 'views' }, viewPlugin); await tick();
  assert.equal(f.host.getViewElement(leaf.id).textContent, 'Count 9');
  await globalThis.__viewsPlugin.app.workspace.getLeavesOfType('counter-view')[0].detach();
  assert.equal(f.rows.has(leaf.id), false); assert.deepEqual(f.notices, []);
});

test('a delayed old view cannot clear or write into its replacement container', async t => {
  const f = fixture(t); globalThis.__viewGate = deferred(); globalThis.__oldViewStarted = deferred();
  await f.host.enable({ id: 'delayed-views' }, `const {Plugin,ItemView}=require('obsidian');module.exports=class extends Plugin{onload(){globalThis.__delayPlugin=this;for(const type of ['slow-view','fast-view'])this.registerView(type,leaf=>new class extends ItemView{getViewType(){return type;}async onOpen(){if(type==='slow-view'){globalThis.__oldViewStarted.resolve();await globalThis.__viewGate.promise;}this.contentEl.setText(type);}}(leaf));}};`);
  const leaf = globalThis.__delayPlugin.app.workspace.getLeaf(true), pending = leaf.setViewState({ type: 'slow-view' });
  const observed = pending.catch(error => error);
  await globalThis.__oldViewStarted.promise;
  await leaf.setViewState({ type: 'fast-view' });
  globalThis.__viewGate.resolve(); assert.match((await observed).message, /closed while opening/);
  assert.equal(f.host.getViewElement(leaf.id).textContent, 'fast-view'); assert.deepEqual(f.notices, []);
});

test('public and named layout restoration reapply custom state to an existing leaf and capture current view state', async t => {
  const f = fixture(t); globalThis.__viewLog = [];
  await f.host.enable({ id: 'state-restore' }, viewPlugin);
  const workspace = globalThis.__viewsPlugin.app.workspace, leaf = workspace.getLeaf(true);
  await leaf.setViewState({ type: 'counter-view', state: { count: 7 } });
  const view = leaf.view;
  view.value = 12; await f.host.captureViewStates();
  assert.equal(f.rows.get(leaf.id).state.count, 12);
  const named = f.adapter.getLayout();
  view.value = 55;
  await f.host.syncWorkspace(); assert.equal(view.value, 55, 'ordinary layout notifications do not reset unsaved view state');
  await f.adapter.changeLayout(named); await f.host.syncWorkspace({ forceState: true });
  assert.equal(leaf.view, view); assert.equal(view.value, 12); assert.equal(view.contentEl.textContent, 'Count 12');
  const publicLayout = workspace.getLayout(); publicLayout.main.children.find(row => row.id === leaf.id).state.state.count = 99;
  await workspace.changeLayout(publicLayout);
  assert.equal(leaf.view, view); assert.equal(view.value, 99); assert.equal(leaf.getViewState().state.count, 99);
  view.value = 101; await workspace.changeLayout(publicLayout); assert.equal(view.value, 99, 'an explicit reload reapplies even the same saved state');
  await f.host.captureViewStates(); assert.equal(f.rows.get(leaf.id).state.count, 99);
  assert.equal(globalThis.__viewLog.filter(item => item === 'constructor').length, 1);
  assert.deepEqual(f.notices, []);
});

test('successive layouts serialize delayed custom setState calls so the newest state wins', async t => {
  const f = fixture(t); globalThis.__stateGate = deferred(); globalThis.__stateStarted = deferred(); globalThis.__stateLog = [];
  await f.host.enable({ id: 'state-order' }, `const {Plugin,ItemView}=require('obsidian');module.exports=class extends Plugin{onload(){globalThis.__statePlugin=this;this.registerView('delayed-state',leaf=>new class extends ItemView{getViewType(){return 'delayed-state'}getState(){return{count:this.count}}async setState(state){globalThis.__stateLog.push(['start',state.count]);if(state.count===2){globalThis.__stateStarted.resolve();await globalThis.__stateGate.promise;}this.count=state.count;this.contentEl.setText('Count '+state.count);globalThis.__stateLog.push(['end',state.count]);}}(leaf));}};`);
  const workspace = globalThis.__statePlugin.app.workspace, leaf = workspace.getLeaf(true);
  await leaf.setViewState({ type: 'delayed-state', state: { count: 1 } });
  const oldLayout = workspace.getLayout(); oldLayout.main.children.find(row => row.id === leaf.id).state.state.count = 2;
  const older = workspace.changeLayout(oldLayout); await globalThis.__stateStarted.promise;
  const newLayout = workspace.getLayout(); newLayout.main.children.find(row => row.id === leaf.id).state.state.count = 3;
  const latest = workspace.changeLayout(newLayout); await tick();
  let captured = false; const capture = f.host.captureViewStates().then(() => { captured = true; }); await tick();
  assert.equal(captured, false);
  assert.equal(leaf.view.getState().count, 1); assert.equal(globalThis.__stateLog.some(([kind, value]) => kind === 'start' && value === 3), false);
  globalThis.__stateGate.resolve(); await Promise.all([older, latest, capture]);
  assert.deepEqual(globalThis.__stateLog, [['start', 1], ['end', 1], ['start', 2], ['end', 2], ['start', 3], ['end', 3]]);
  assert.equal(leaf.view.getState().count, 3); assert.equal(leaf.view.contentEl.textContent, 'Count 3');
  await f.host.captureViewStates(); assert.equal(f.rows.get(leaf.id).state.count, 3); assert.deepEqual(f.notices, []);
});

test('capture reports a failing getState instead of saving stale data', async t => {
  const f = fixture(t); globalThis.__viewLog = [];
  await f.host.enable({ id: 'capture-failure' }, viewPlugin);
  const leaf = globalThis.__viewsPlugin.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: 'counter-view', state: { count: 7 } });
  leaf.view.getState = () => { throw new Error('cannot serialize'); };
  await assert.rejects(f.host.captureViewStates(), /Custom view state could not be captured/);
  assert.equal(f.rows.get(leaf.id).state.count, 7);
  // Cleanup still attempts view unload when a plugin's serializer is broken.
  await f.host.disable('capture-failure'); assert.equal(f.host.getViewElement(leaf.id), null);
});

test('Markdown processors preserve order, fence source and full-note section ranges; disable restores code and unloads children', async t => {
  const f = fixture(t); globalThis.__renderLog = []; globalThis.__renderChildren = 0;
  await f.host.enable({ id: 'renderers' }, `const {Plugin,MarkdownRenderChild}=require('obsidian');module.exports=class extends Plugin{onload(){this.registerMarkdownPostProcessor((el,ctx)=>{el.setAttribute('data-first','yes');globalThis.__renderLog.push(['first',ctx.getSectionInfo(el)]);},50);this.registerMarkdownPostProcessor((el)=>globalThis.__renderLog.push(['second',el.getAttribute('data-first')]),100);this.registerMarkdownCodeBlockProcessor('counter',(source,el,ctx)=>{globalThis.__renderLog.push(['code',source,ctx.getSectionInfo(el)]);el.setText('Counter output');ctx.addChild(new class extends MarkdownRenderChild{onload(){globalThis.__renderChildren++;}onunload(){globalThis.__renderChildren--;}}(el));});}};`);
  const container = f.container(), cleanup = await f.host.processMarkdown(container, { path: 'Home.md' });
  const code = globalThis.__renderLog.find(row => row[0] === 'code');
  assert.equal(code[1], 'abc'); assert.deepEqual(code[2], { text: '# Heading\n\n```counter\nabc\n```\n', lineStart: 2, lineEnd: 4 });
  assert.ok(globalThis.__renderLog.filter(row => row[0] === 'second').every(row => row[1] === 'yes'));
  assert.equal(globalThis.__renderChildren, 1); assert.equal(container.querySelectorAll('pre > code').length, 0);
  await f.host.disable('renderers'); assert.equal(globalThis.__renderChildren, 0); assert.equal(container.querySelectorAll('pre > code').length, 1);
  await cleanup(); assert.equal(globalThis.__renderChildren, 0); assert.deepEqual(f.notices, []);
});

test('MarkdownRenderer virtual sources return no fabricated section range and honor component teardown', async t => {
  const f = fixture(t); globalThis.__virtualSections = []; globalThis.__virtualClosed = 0;
  await f.host.enable({ id: 'virtual-render' }, `const {Plugin,Component,MarkdownRenderer,MarkdownRenderChild}=require('obsidian');module.exports=class extends Plugin{onload(){globalThis.__virtualPlugin=this;globalThis.__virtualRenderer=MarkdownRenderer;globalThis.__virtualComponent=new Component();this.registerMarkdownPostProcessor((el,ctx)=>{globalThis.__virtualSections.push(ctx.getSectionInfo(el));ctx.addChild(new class extends MarkdownRenderChild{onunload(){globalThis.__virtualClosed++;}}(el));});}};`);
  const container = new Element();
  await globalThis.__virtualRenderer.render(globalThis.__virtualPlugin.app, '# Heading', container, 'Home.md', globalThis.__virtualComponent);
  assert.deepEqual(globalThis.__virtualSections, [null, null]);
  await globalThis.__virtualComponent.unload(); assert.equal(globalThis.__virtualClosed, 2);
  await f.host.disable('virtual-render'); assert.equal(globalThis.__virtualClosed, 2); assert.deepEqual(f.notices, []);
});

test('ribbon and status DOM require mounted surfaces and are removed with their click handlers on disable', async t => {
  const f = fixture(t); globalThis.__ribbonClicked = 0;
  const source = `const {Plugin}=require('obsidian');module.exports=class extends Plugin{onload(){globalThis.__ribbonButton=this.addRibbonIcon('dice','Roll',()=>globalThis.__ribbonClicked++);this.addStatusBarItem().setText('Ready');}};`;
  await assert.rejects(f.host.enable({ id: 'surfaces' }, source), /has not mounted/);
  const offRibbon = f.host.attachSurface('ribbon'), offStatus = f.host.attachSurface('statusBar');
  await f.host.enable({ id: 'surfaces' }, source);
  const button = globalThis.__ribbonButton; button.dispatchEvent(new Event('click'));
  assert.equal(globalThis.__ribbonClicked, 1); assert.equal(f.host.getUI().statusBar[0].element.textContent, 'Ready');
  await f.host.disable('surfaces'); button.dispatchEvent(new Event('click'));
  assert.equal(globalThis.__ribbonClicked, 1); assert.equal(f.host.getUI().ribbon.length, 0); assert.equal(f.host.getUI().statusBar.length, 0);
  offRibbon(); offStatus();
});
