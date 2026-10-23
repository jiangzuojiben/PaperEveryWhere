/* Self-contained synthetic fixture. Only the documented obsidian module is required. */
const api = require('obsidian');
const BASE = 'Reference API Lab';
const MARKER = '<!-- reference-public-api-probe:v1:synthetic-only -->';
const ROOT_MARKER = BASE + '/Fixture Marker.md';
const VIEW_TYPE = 'reference-public-api-probe-view';
const LANGUAGE = 'reference-api-lab';
const EDITOR_PATH = BASE + '/Editor.md';
const RENDER_PATH = BASE + '/Render.md';
const VIRTUAL_PATH = BASE + '/Virtual.md';
const BASELINE = MARKER + '\nalpha beta\ngamma delta\n';
const TRANSACTED = MARKER + '\nA beta\ngamma D\n';
const BINARY_MARKER = Array.from('REFERENCE-PUBLIC-API-PROBE:v1\n', c => c.charCodeAt(0));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const errorInfo = error => ({ name: error?.name || 'Error', message: String(error?.message || error), code: error?.code || null });
const check = (name, pass, actual, expected) => ({ name, pass: pass === true, actual, expected });
const method = (object, name) => {
  if (!object || typeof object[name] !== 'function') throw Object.assign(new Error(name + ' is unavailable'), { name: 'UnsupportedApiError' });
  return object[name].bind(object);
};
const constructor = name => {
  if (typeof api[name] !== 'function') throw Object.assign(new Error(name + ' is unavailable'), { name: 'UnsupportedApiError' });
  return api[name];
};
const unsupported = error => /unsupported|not.?implemented/i.test(String(error?.name) + ' ' + String(error?.code) + ' ' + String(error?.message));

module.exports = class PublicApiProbe extends api.Plugin {
  async onload() {
    this.saveQueue = Promise.resolve(); this.busy = false; this.unloading = false;
    this.children = []; this.viewInstances = []; this.capabilities = {}; this.sequence = 0;
    let previous = null, loadError = null, apiVersion = null, apiVersionError = null;
    try { previous = await this.loadData(); } catch (error) { loadError = errorInfo(error); }
    try { apiVersion = api.apiVersion || null; } catch (error) { apiVersionError = errorInfo(error); }
    this.report = previous?.schema === 'reference-public-api-probe-v1' && Array.isArray(previous.sessions)
      ? previous : { schema: 'reference-public-api-probe-v1', fixture: { id: this.manifest.id, version: this.manifest.version, basePath: BASE, marker: MARKER }, sessions: [] };
    this.session = {
      id: new Date().toISOString(), apiVersion, apiVersionError, cases: [], events: [],
      limitations: [
        'Installation, enable and disable are performed by the host UI; no private plugin manager or command registry is used.',
        'This wrapper was extracted from sampled reference probes. Until this exact wrapper is run on both hosts, its output is not a same-script differential.',
        'A disabled plugin cannot reliably observe its own later cleanup or ghost view. onunload records a best-effort save attempt, not proof of completed teardown.',
        'No files are deleted. Existing fixture text must contain the exact marker; existing binary data must start with the fixture byte marker.',
      ], persistence: { loadError, lastSaveError: null },
    };
    this.report.sessions.push(this.session);
    this.event('plugin:onload', { id: this.manifest.id });

    // Keep preparation and log access available even when optional registrations fail.
    this.registerCommand('prepare-editor', '01 Prepare dedicated editor note', () => this.launch('prepare-editor', () => this.prepareEditor(), false));
    this.registerCommand('show-observations', '06 Show saved observations', () => this.showLog());
    this.registerCommand('save-observations', '07 Save and show observations', () => this.launch('save-observations', async () => {}, true));
    this.optional('editor-command', () => this.addCommand({
      id: 'editor-transaction', name: '02 Editor transaction undo redo',
      editorCallback: (editor, info) => this.launch('editor-transaction', () => this.editorCases(editor, info), true),
    }));
    this.registerCommand('view-lifecycle', '03 View split lifecycle', () => this.launch('view-lifecycle', () => this.viewCases(), true));
    this.registerCommand('render-resources', '04 Render and resources', () => this.launch('render-resources', () => this.renderCases(), true));
    this.registerCommand('frontmatter-binary', '05 Frontmatter and binary', () => this.launch('frontmatter-binary', () => this.dataCases(), true));
    this.setupResources(); this.setupViews(); this.setupRendering();
    this.optional('plugin-cleanup-callback', () => this.register(() => this.event('plugin:registered-cleanup')));
    await this.persist('onload');
  }

  registerCommand(id, name, callback) {
    this.optional('command:' + id, () => this.addCommand({ id, name, callback }));
  }
  optional(name, action) {
    try { action(); this.capabilities[name] = { registered: true }; this.event('registration:observed', { name }); }
    catch (error) { this.capabilities[name] = { registered: false, error: errorInfo(error) }; this.session.cases.push({ id: 'registration:' + name, status: unsupported(error) ? 'unsupported' : 'error', error: errorInfo(error) }); }
  }
  needCapability(name) {
    if (!this.capabilities[name]?.registered) throw Object.assign(new Error(name + ' registration unavailable: ' + JSON.stringify(this.capabilities[name]?.error || null)), { name: 'UnsupportedApiError' });
  }
  event(kind, details = {}) {
    if (!this.session) return;
    this.session.events.push({ sequence: ++this.sequence, kind, ...copy(details) });
    if (!this.unloading) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => { this.persist('events').catch(() => {}); }, 180);
    }
  }
  async persist(reason) {
    if (!this.report) return;
    this.session.persistence.lastAttempt = { reason, time: new Date().toISOString() };
    const snapshot = copy(this.report);
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.saveData(snapshot));
    try { await this.saveQueue; this.session.persistence.lastSaveError = null; }
    catch (error) { this.session.persistence.lastSaveError = errorInfo(error); }
  }
  async runCase(id, action) {
    const result = { id, startedAt: new Date().toISOString() }; this.session.cases.push(result);
    try {
      const output = await action(); Object.assign(result, copy(output || {}));
      result.status = result.checks?.length ? (result.checks.every(item => item.pass === true) ? 'pass' : 'fail') : 'observed';
    } catch (error) { result.status = unsupported(error) ? 'unsupported' : 'error'; result.error = errorInfo(error); }
    result.finishedAt = new Date().toISOString(); await this.persist(id); return result;
  }
  async launch(group, action, show) {
    if (this.busy) { this.event('command:refused-busy', { group }); return; }
    this.busy = true;
    try { await action(); }
    catch (error) { this.session.cases.push({ id: group, status: unsupported(error) ? 'unsupported' : 'error', error: errorInfo(error) }); }
    finally { this.busy = false; await this.persist(group); if (show) this.showLog(); }
  }
  async waitFor(predicate, label) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(40); }
    throw new Error('Timed out waiting for ' + label);
  }
  async ensureRoot() {
    const vault = this.app.vault;
    const existing = method(vault, 'getAbstractFileByPath')(BASE);
    if (!existing) {
      await method(vault, 'createFolder')(BASE);
      await method(vault, 'create')(ROOT_MARKER, MARKER + '\nThis directory contains only deliberately created public API lab fixtures.\n');
      return;
    }
    const marker = vault.getAbstractFileByPath(ROOT_MARKER);
    if (!marker) throw new Error('Safety refusal: existing ' + BASE + ' has no fixture marker; no file was overwritten.');
    const text = await method(vault, 'read')(marker);
    if (!text.includes(MARKER)) throw new Error('Safety refusal: root fixture marker does not match.');
  }
  async ownedText(name, content) {
    if (!/^[A-Za-z0-9 .-]+\.md$/.test(name) || !content.includes(MARKER)) throw new Error('Invalid fixture filename or missing marker');
    await this.ensureRoot(); const path = BASE + '/' + name, vault = this.app.vault;
    let file = vault.getAbstractFileByPath(path);
    if (file) {
      const existing = await method(vault, 'read')(file);
      if (!existing.includes(MARKER)) throw new Error('Safety refusal: ' + path + ' is not a marked fixture.');
      await method(vault, 'modify')(file, content);
    } else file = await method(vault, 'create')(path, content);
    return file;
  }
  async assertOwnedFile(file) {
    if (!file?.path?.startsWith(BASE + '/')) throw new Error('Safety refusal: file is outside the fixture directory.');
    if (!(await method(this.app.vault, 'read')(file)).includes(MARKER)) throw new Error('Safety refusal: target file is not marked.');
  }
  assertEditor(editor, info) {
    if (info?.file?.path !== EDITOR_PATH || !method(editor, 'getValue')().includes(MARKER)) throw new Error('Safety refusal: run 01 first and leave the marked Editor.md active in source mode.');
  }
  editorSnapshot(editor) {
    return { value: editor.getValue(), selections: copy(method(editor, 'listSelections')()), cursor: copy(method(editor, 'getCursor')()) };
  }
  async prepareEditor() {
    await this.runCase('editor:prepare-marked-note', async () => {
      const file = await this.ownedText('Editor.md', BASELINE);
      const leaf = method(this.app.workspace, 'getLeaf')('tab');
      await method(leaf, 'setViewState')({ type: 'markdown', state: { file: file.path, mode: 'source', source: true }, active: true });
      await method(this.app.workspace, 'setActiveLeaf')(leaf, { focus: true });
      const disk = await this.app.vault.read(file);
      return { observations: { path: file.path, disk, viewState: leaf.getViewState(), next: 'Run 02 Editor transaction undo redo while this note remains active.' }, checks: [check('created fixture content', disk === BASELINE, disk, BASELINE)] };
    });
  }
  async editorCases(editor, info) {
    await this.runCase('editor:transaction-undo-redo', async () => {
      this.assertEditor(editor, info); await this.assertOwnedFile(info.file);
      for (const name of ['setValue', 'transaction', 'undo', 'redo', 'listSelections', 'getCursor']) method(editor, name);
      editor.setValue(BASELINE); await sleep(650); this.assertEditor(editor, info);
      const before = this.editorSnapshot(editor);
      const transaction = { changes: [{ from: { line: 1, ch: 0 }, to: { line: 1, ch: 5 }, text: 'A' }, { from: { line: 2, ch: 6 }, to: { line: 2, ch: 11 }, text: 'D' }], selections: [{ from: { line: 1, ch: 1 } }, { from: { line: 2, ch: 7 }, to: { line: 2, ch: 6 } }] };
      const returned = editor.transaction(transaction, 'public-api-probe'); await sleep(60); this.assertEditor(editor, info);
      const after = this.editorSnapshot(editor); editor.undo(); await sleep(60); this.assertEditor(editor, info);
      const afterUndo = this.editorSnapshot(editor); editor.redo(); await sleep(60); this.assertEditor(editor, info);
      const afterRedo = this.editorSnapshot(editor);
      return { observations: { callbackFile: info.file.path, transaction, returnedType: typeof returned, before, after, afterUndo, afterRedo }, checks: [check('transaction uses original change coordinates', after.value === TRANSACTED, after.value, TRANSACTED), check('one undo restores entire transaction', afterUndo.value === BASELINE, afterUndo.value, BASELINE), check('redo restores transaction', afterRedo.value === TRANSACTED, afterRedo.value, TRANSACTED)] };
    });
  }

  setupResources() {
    this.optional('ribbon', () => { this.ribbon = this.addRibbonIcon('flask-conical', 'Reference API Probe observations', () => { this.event('ribbon:primary-click'); this.showLog(); }); });
    this.optional('status', () => { this.status = this.addStatusBarItem(); this.status.textContent = 'Reference API Lab'; });
  }
  setupViews() {
    const plugin = this;
    this.optional('view', () => {
      const ItemView = constructor('ItemView');
      class ProbeView extends ItemView {
        constructor(leaf) { super(leaf); this.probeId = 'view-' + (plugin.viewInstances.length + 1); plugin.viewInstances.push(this); plugin.event('view:construct', { id: this.probeId, leafId: leaf.id }); }
        getViewType() { return VIEW_TYPE; }
        getDisplayText() { return 'Reference API Lab view'; }
        getState() { return this.probeState || {}; }
        async onOpen() { this.contentEl.textContent = 'Synthetic public API view. Leave the second split open, then disable the plugin through the host UI to inspect its placeholder.'; plugin.event('view:onOpen', { id: this.probeId, leafId: this.leaf.id, stateAtOpen: this.probeState || null }); }
        async setState(state, result) { plugin.event('view:setState:start', { id: this.probeId, state }); this.probeState = copy(state); await super.setState(state, result); plugin.event('view:setState:end', { id: this.probeId, state: this.probeState }); }
        async onClose() { plugin.event('view:onClose', { id: this.probeId, leafId: this.leaf.id }); }
      }
      this.registerView(VIEW_TYPE, leaf => new ProbeView(leaf));
    });
  }
  async viewCases() {
    await this.runCase('view:split-state-and-detach', async () => {
      this.needCapability('view'); const workspace = this.app.workspace, start = this.session.events.length;
      const first = method(workspace, 'getLeaf')('tab');
      await first.setViewState({ type: VIEW_TYPE, state: { marker: MARKER, value: 'one' }, active: true });
      const second = workspace.getLeaf('split', 'vertical');
      await second.setViewState({ type: VIEW_TYPE, state: { marker: MARKER, value: 'two' }, active: true });
      const snapshot = () => method(workspace, 'getLeavesOfType')(VIEW_TYPE).map(leaf => ({ id: leaf.id, state: leaf.getViewState() }));
      const bothOpen = snapshot(), openedEvents = copy(this.session.events.slice(start));
      await method(first, 'detach')(); await sleep(100);
      const afterDetach = snapshot(), eventRows = copy(this.session.events.slice(start));
      const constructors = openedEvents.filter(event => event.kind === 'view:construct');
      const ordered = constructors.length === 2 && constructors.every(event => {
        const own = openedEvents.filter(row => row.id === event.id).map(row => row.kind);
        const openIndex = own.indexOf('view:onOpen'), stateIndex = own.indexOf('view:setState:start');
        return openIndex >= 0 && stateIndex > openIndex && own.indexOf('view:setState:end') > stateIndex;
      });
      this.remainingView = second;
      return { observations: { firstId: first.id, secondId: second.id, bothOpen, afterDetach, events: eventRows, disableInstruction: 'Disable through host UI; observe the surviving view. Its post-disable ghost state requires external UI evidence.' }, checks: [check('both requested leaves exist', bothOpen.some(row => row.id === first.id) && bothOpen.some(row => row.id === second.id), bothOpen.map(row => row.id), [first.id, second.id]), check('onOpen precedes setState', ordered, openedEvents, 'construct -> onOpen -> setState'), check('detach removes only first requested leaf', !afterDetach.some(row => row.id === first.id) && afterDetach.some(row => row.id === second.id), afterDetach.map(row => row.id), [second.id]), check('first view received onClose', eventRows.some(row => row.kind === 'view:onClose' && row.leafId === first.id), eventRows.filter(row => row.kind === 'view:onClose'), first.id)] };
    });
  }

  setupRendering() {
    const plugin = this;
    this.optional('render-child', () => {
      const MarkdownRenderChild = constructor('MarkdownRenderChild');
      this.RenderChild = class extends MarkdownRenderChild {
        constructor(element, kind, sourcePath) { super(element); this.probeId = 'child-' + (plugin.children.length + 1); this.probeKind = kind; this.sourcePath = sourcePath; this.probeLoaded = false; plugin.children.push(this); plugin.event('child:construct', { id: this.probeId, childKind: kind, sourcePath }); }
        onload() { this.probeLoaded = true; plugin.event('child:onload', { id: this.probeId, childKind: this.probeKind, sourcePath: this.sourcePath, connected: this.containerEl.isConnected }); }
        onunload() { this.probeLoaded = false; plugin.event('child:onunload', { id: this.probeId, childKind: this.probeKind, sourcePath: this.sourcePath, connected: this.containerEl.isConnected }); }
      };
    });
    const isSource = ctx => [RENDER_PATH, VIRTUAL_PATH].includes(ctx.sourcePath);
    const section = (ctx, el) => method(ctx, 'getSectionInfo')(el);
    const safe = callback => (...args) => { try { return callback(...args); } catch (error) { this.event('render:callback-error', { error: errorInfo(error) }); } };
    this.optional('postprocessor-early', () => this.registerMarkdownPostProcessor(safe((el, ctx) => {
      if (!isSource(ctx) || !el.textContent.includes('LAB-POST')) return;
      this.event('post:early', { sourcePath: ctx.sourcePath, section: section(ctx, el), text: el.textContent });
      el.setAttribute('data-reference-api-order', 'early'); this.needCapability('render-child'); ctx.addChild(new this.RenderChild(el, 'post', ctx.sourcePath));
    }), 50));
    this.optional('postprocessor-late', () => this.registerMarkdownPostProcessor(safe((el, ctx) => {
      if (!isSource(ctx) || !el.textContent.includes('LAB-POST')) return;
      this.event('post:late', { sourcePath: ctx.sourcePath, section: section(ctx, el), earlyMarker: el.getAttribute('data-reference-api-order'), text: el.textContent });
    }), 100));
    this.optional('codeblock', () => this.registerMarkdownCodeBlockProcessor(LANGUAGE, safe((source, el, ctx) => {
      if (!isSource(ctx)) return;
      this.event('code:process', { source, sourcePath: ctx.sourcePath, section: section(ctx, el) });
      const output = el.ownerDocument.createElement('div'); output.className = 'reference-api-code-output'; output.textContent = 'Lab code: ' + source; el.appendChild(output);
      this.needCapability('render-child'); ctx.addChild(new this.RenderChild(el, 'code', ctx.sourcePath));
    })));
  }
  childSnapshot() { return this.children.map(child => ({ id: child.probeId, kind: child.probeKind, sourcePath: child.sourcePath, loaded: child.probeLoaded, connected: child.containerEl.isConnected })); }
  async renderCases() {
    await this.runCase('resources:ribbon-status-click-remove', async () => {
      this.needCapability('ribbon'); this.needCapability('status'); let clicked = 0;
      const ribbon = this.addRibbonIcon('flask-conical', 'Temporary Reference API Lab control', () => { clicked++; this.event('ribbon:temporary-click'); });
      const status = this.addStatusBarItem(); status.textContent = 'Temporary API Lab';
      await this.waitFor(() => ribbon.isConnected && status.isConnected, 'temporary ribbon and status mounting');
      const before = { ribbon: ribbon.isConnected, status: status.isConnected, primaryRibbon: this.ribbon.isConnected, primaryStatus: this.status.isConnected };
      ribbon.click(); ribbon.remove(); status.remove();
      return { observations: { before, clicked, after: { ribbon: ribbon.isConnected, status: status.isConnected }, primaryResourcesRemainUntilDisable: true }, checks: [check('controls mounted', before.ribbon && before.status, before, true), check('ribbon callback invoked', clicked === 1, clicked, 1), check('temporary controls removed', !ribbon.isConnected && !status.isConnected, { ribbon: ribbon.isConnected, status: status.isConnected }, false)] };
    });
    await this.runCase('render:native-reading-context', async () => {
      for (const name of ['postprocessor-early', 'postprocessor-late', 'codeblock', 'render-child']) this.needCapability(name);
      const source = MARKER + '\n\n# Render fixture\n\nLAB-POST first paragraph.\n\n```' + LANGUAGE + '\nalpha\nbeta\n```\n\nLAB-POST last paragraph.\n';
      const file = await this.ownedText('Render.md', source), start = this.session.events.length;
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'preview' }, active: true });
      await this.app.workspace.setActiveLeaf(leaf, { focus: true });
      await this.waitFor(() => this.session.events.slice(start).filter(event => event.kind === 'post:late' && event.sourcePath === RENDER_PATH).length >= 2, 'native paragraph postprocessors');
      const events = copy(this.session.events.slice(start)), code = events.filter(event => event.kind === 'code:process' && event.sourcePath === RENDER_PATH), late = events.filter(event => event.kind === 'post:late');
      this.nativeRenderLeaf = leaf;
      return { observations: { source, viewState: leaf.getViewState(), events, children: this.childSnapshot() }, checks: [check('code block source omits final newline', code.length > 0 && code.every(event => event.source === 'alpha\nbeta'), code.map(event => event.source), 'alpha\nbeta'), check('native section info carries whole source', code.length > 0 && code.every(event => event.section?.text === source), code.map(event => event.section), 'full source text plus section lineStart/lineEnd'), check('postprocessors run in sort order', late.length >= 2 && late.every(event => event.earlyMarker === 'early'), late, 'early marker visible to late processor')] };
    });
    await this.runCase('render:programmatic-component-lifecycle', async () => {
      const Component = constructor('Component'); constructor('MarkdownRenderer'); this.needCapability('render-child');
      const start = this.session.events.length, owner = new Component(), target = document.createElement('div'); target.style.display = 'none'; document.body.appendChild(target);
      const source = MARKER + '\n\nLAB-POST virtual paragraph.\n\n```' + LANGUAGE + '\nvirtual alpha\nvirtual beta\n```\n';
      let rendered, afterUnload;
      try {
        await method(owner, 'load')(); await method(api.MarkdownRenderer, 'render')(this.app, source, target, VIRTUAL_PATH, owner);
        const events = copy(this.session.events.slice(start)); rendered = { html: target.innerHTML, text: target.textContent, events, children: this.childSnapshot().filter(child => child.sourcePath === VIRTUAL_PATH) };
        await method(owner, 'unload')(); afterUnload = this.childSnapshot().filter(child => child.sourcePath === VIRTUAL_PATH);
      } finally { try { await method(owner, 'unload')(); } catch (_) {} target.remove(); }
      return { observations: { source, rendered, afterUnload, events: copy(this.session.events.slice(start)) }, checks: [check('custom code was rendered', rendered.text.includes('Lab code: virtual alpha\nvirtual beta'), rendered.text, 'custom code output'), check('programmatic section info is null', rendered.events.some(event => event.kind === 'code:process') && rendered.events.filter(event => ['code:process', 'post:early'].includes(event.kind)).every(event => event.section === null), rendered.events, 'section: null'), check('Component.unload unloads rendered children', afterUnload.length >= 2 && afterUnload.every(child => !child.loaded), afterUnload, 'all programmatic children unloaded')] };
    });
  }

  async dataCases() {
    await this.runCase('frontmatter:update', async () => {
      const input = '---\ncount: 1\nuntouched: yes\n---\n' + MARKER + '\nBody KEEP\n', file = await this.ownedText('Frontmatter Update.md', input); let callbackInput, calls = 0;
      await this.assertOwnedFile(file);
      await method(this.app.fileManager, 'processFrontMatter')(file, fm => { calls++; callbackInput = copy(fm); fm.count = 2; fm.added = ['a', 'b']; delete fm.untouched; });
      const after = await this.app.vault.read(file);
      return { observations: { input, callbackInput, calls, after }, checks: [check('callback executed exactly once', calls === 1, calls, 1), check('updated count persisted', /^count: 2\s*$/m.test(after), after, 'count: 2'), check('body and ownership marker survive', after.includes(MARKER + '\nBody KEEP\n'), after, MARKER + '\nBody KEEP\n')] };
    });
    await this.runCase('frontmatter:throw-does-not-write', async () => {
      const input = '---\ncount: 1\n---\n' + MARKER + '\nBody KEEP\n', file = await this.ownedText('Frontmatter Throw.md', input); let thrown = null, calls = 0;
      await this.assertOwnedFile(file); const process = method(this.app.fileManager, 'processFrontMatter');
      try { await process(file, fm => { calls++; fm.count = 99; throw new Error('PUBLIC API LAB EXPECTED THROW'); }); } catch (error) { if (unsupported(error)) throw error; thrown = errorInfo(error); }
      const after = await this.app.vault.read(file);
      return { observations: { input, calls, thrown, after }, checks: [check('expected callback exception propagated', calls === 1 && thrown?.message === 'PUBLIC API LAB EXPECTED THROW', { calls, thrown }, 'callback exception'), check('throw leaves file unchanged', after === input, after, input)] };
    });
    await this.runCase('frontmatter:concurrent-counter', async () => {
      const input = '---\ncount: 0\n---\n' + MARKER + '\nBody KEEP\n', file = await this.ownedText('Frontmatter Counter.md', input), seen = [];
      await this.assertOwnedFile(file); const process = method(this.app.fileManager, 'processFrontMatter');
      const settled = await Promise.allSettled([process(file, fm => { seen.push(fm.count); fm.count++; }), process(file, fm => { seen.push(fm.count); fm.count++; })]);
      const unsupportedResult = settled.find(item => item.status === 'rejected' && unsupported(item.reason));
      if (unsupportedResult) throw unsupportedResult.reason;
      const outcomes = settled.map(item => ({ status: item.status, error: item.reason ? errorInfo(item.reason) : null })), after = await this.app.vault.read(file);
      return { observations: { input, seen, outcomes, after }, checks: [check('both updates complete', settled.every(item => item.status === 'fulfilled'), outcomes, 'fulfilled'), check('each callback sees latest count', JSON.stringify(seen.slice().sort()) === '[0,1]', seen, [0, 1]), check('no lost increment', /^count: 2\s*$/m.test(after), after, 'count: 2')] };
    });
    await this.runCase('binary:arraybuffer-roundtrip-modify-append', async () => {
      await this.ensureRoot(); const vault = this.app.vault, path = BASE + '/Bytes.bin';
      const input = BINARY_MARKER.concat([0, 1, 127, 128, 255, 13, 10]); let file = vault.getAbstractFileByPath(path);
      const read = method(vault, 'readBinary');
      if (file) {
        const existing = Array.from(new Uint8Array(await read(file)));
        if (!BINARY_MARKER.every((byte, index) => existing[index] === byte)) throw new Error('Safety refusal: existing Bytes.bin has no fixture byte marker.');
        await method(vault, 'modifyBinary')(file, new Uint8Array(input).buffer);
      } else file = await method(vault, 'createBinary')(path, new Uint8Array(input).buffer);
      const firstBuffer = await read(file), first = Array.from(new Uint8Array(firstBuffer));
      const modifiedExpected = BINARY_MARKER.concat([5, 0, 255]); await method(vault, 'modifyBinary')(file, new Uint8Array(modifiedExpected).buffer);
      const modified = Array.from(new Uint8Array(await read(file)));
      await method(vault, 'appendBinary')(file, new Uint8Array([17, 18]).buffer);
      const appended = Array.from(new Uint8Array(await read(file))), appendedExpected = modifiedExpected.concat([17, 18]);
      return { observations: { path, input, readIsArrayBuffer: firstBuffer instanceof ArrayBuffer, first, modified, appended, byteMarker: BINARY_MARKER }, checks: [check('readBinary returns ArrayBuffer', firstBuffer instanceof ArrayBuffer, Object.prototype.toString.call(firstBuffer), '[object ArrayBuffer]'), check('initial bytes roundtrip', JSON.stringify(first) === JSON.stringify(input), first, input), check('modify preserves exact bytes', JSON.stringify(modified) === JSON.stringify(modifiedExpected), modified, modifiedExpected), check('append preserves exact bytes', JSON.stringify(appended) === JSON.stringify(appendedExpected), appended, appendedExpected)] };
    });
  }

  showLog() {
    try {
      const Modal = constructor('Modal'), plugin = this;
      new class extends Modal {
        onOpen() {
          this.titleEl.textContent = 'Reference Public API Probe observations'; const doc = this.contentEl.ownerDocument;
          const description = doc.createElement('p'); description.textContent = 'Results are saved with Plugin.saveData. Pass means recorded behavior checks succeeded; unsupported and error are not passes. No files are deleted.'; this.contentEl.appendChild(description);
          const actions = doc.createElement('div'), text = doc.createElement('textarea'); text.readOnly = true; text.rows = 22; text.style.width = '100%'; text.style.fontFamily = 'monospace'; text.setAttribute('aria-label', 'Public API probe JSON');
          const refresh = () => { text.value = JSON.stringify(plugin.report, null, 2); };
          const button = (label, callback) => { const el = doc.createElement('button'); el.textContent = label; el.type = 'button'; el.addEventListener('click', callback); actions.appendChild(el); };
          button('Refresh JSON', refresh); button('Save observations', async () => { await plugin.persist('modal-save'); refresh(); }); button('Select JSON', () => { text.focus(); text.select(); }); button('Close', () => this.close());
          this.contentEl.appendChild(actions); this.contentEl.appendChild(text); refresh();
        }
      }(this.app).open();
    } catch (error) { this.session.cases.push({ id: 'report:modal', status: unsupported(error) ? 'unsupported' : 'error', error: errorInfo(error) }); this.persist('modal-error').catch(() => {}); }
  }
  onunload() {
    this.unloading = true; clearTimeout(this.saveTimer);
    this.event('plugin:onunload', { note: 'Callback reached. The plugin cannot prove later host cleanup or observe its disabled ghost view.', childrenAtCallback: this.childSnapshot() });
    this.session.unload = { saveAttemptedAt: new Date().toISOString(), completionUnverified: true };
    // Hosts may revoke saveData during teardown or may not await this hook.
    this.persist('onunload-best-effort').catch(() => {});
  }
};
