import { PluginEditor } from './plugin-editor.mjs';

const clone = value => value == null ? value : structuredClone(value);

/** Bridges public leaf operations to real application tabs and split panes. */
export function createPluginViews({ Component, createElement, decorate, strictApi, unsupported, workspaceAdapter, getActivePath, openFile, getEditor, fileAt, filePathOf, currentRecords, report, changed, emit, hasExternalEvents }) {
  const extensions = new Map();
  const factories = new Map(), mounted = new Map(), containers = new Map(), versions = new Map(), restoring = new Set();
  const adapter = workspaceAdapter;
  const need = name => {
    if (typeof adapter?.[name] !== 'function') return unsupported(`app.workspace.${name}`, 'The application has not connected this workspace operation.');
    return adapter[name].bind(adapter);
  };
  const all = () => {
    const result = adapter?.getLeaves?.();
    if (result?.then) throw new TypeError('getLeaves must return a synchronous workspace snapshot');
    return Array.isArray(result) ? result : [{ id: 'active', type: getActivePath()?.toLowerCase().endsWith('.md') ? 'markdown' : getActivePath() ? 'file' : 'empty', state: { file: getActivePath() } }];
  };
  const descriptor = id => all().find(leaf => leaf.id === id) || null;
  const activeId = () => adapter ? adapter.getActiveLeafId?.() || null : getActivePath() ? 'active' : null;
  const container = id => { if (!containers.has(id)) { const element = createElement('div'); element.className = 'plugin-view-container'; element.dataset && (element.dataset.leafId = id); containers.set(id, element); } return containers.get(id); };
  const increment = id => { const value = (versions.get(id) || 0) + 1; versions.set(id, value); return value; };
  const isCurrent = (id, version) => versions.get(id) === version;

  class View extends Component {
    constructor(leaf) { super(); this.leaf = leaf; this.app = leaf.app; this.containerEl = leaf.containerEl; this.containerEl.empty(); this.scope = this.app.scope; this.registerDomEvent(this.containerEl, 'keydown', event => this.scope?.handle?.(event)); this.navigation = true; this.icon = 'file'; this._state = {}; this._ephemeral = {}; }
    getViewType() { return 'plugin-view'; }
    getDisplayText() { return this.getViewType(); }
    getIcon() { return this.icon; }
    getState() { return clone(this._state); }
    async setState(state) { this._state = clone(state || {}); }
    getEphemeralState() { return clone(this._ephemeral); }
    setEphemeralState(state) { this._ephemeral = clone(state || {}); }
    async onOpen() {}
    async onClose() {}
  }
  class ItemView extends View {
    constructor(leaf) { super(leaf); this.headerEl = this.containerEl.createDiv('view-header'); this.contentEl = this.containerEl.createDiv('view-content'); }
    addAction(icon, title, callback) {
      this.leaf._assertActive();
      const element = this.headerEl.createEl('button', { text: title, attr: { type: 'button', title, 'aria-label': title } });
      element.setAttribute('data-icon', icon);
      this.registerDomEvent(element, 'click', event => { try { this.leaf._assertActive(); Promise.resolve(callback(event)).catch(report); } catch (error) { report(error); } });
      return element;
    }
  }

  async function closeEntry(id, entry = mounted.get(id)) {
    if (!entry) return;
    if (entry.closing) return entry.closing;
    if (mounted.get(id) === entry) { mounted.delete(id); changed(); }
    entry.closed = true;
    entry.ready?.resolve();
    entry.closing = (async () => {
      const failures = [];
      try { await entry.view?.onClose?.(); } catch (error) { failures.push(error); }
      try { await entry.view?.unload?.(); } catch (error) { failures.push(error); }
      entry.view?.containerEl?.replaceChildren();
      if (failures.length) throw new AggregateError(failures, `View ${entry.type} failed to close`);
    })();
    return entry.closing;
  }
  function queueState(id, entry, state, force = false) {
    const target = clone(state || {}), key = JSON.stringify(target);
    if (!force && entry.stateKey === key) return entry.stateQueue;
    entry.stateKey = key;
    // A custom setState can await arbitrary plugin work. Serialize updates for
    // the same instance so a slower old layout cannot overwrite a newer one.
    const previous = entry.stateQueue || entry.ready.promise;
    const pending = previous.catch(() => {}).then(async () => {
      if (entry.closed || mounted.get(id) !== entry || entry.owner.cancelled) return;
      await entry.view.setState(target, {});
      if (entry.closed || mounted.get(id) !== entry || entry.owner.cancelled) return;
      changed();
    });
    pending.catch(() => {}); entry.stateQueue = pending;
    return pending;
  }
  async function settleState(entry) {
    let pending;
    do { pending = entry.stateQueue; await pending; } while (pending !== entry.stateQueue);
  }
  async function saveViewStates({ waitForPending = true, owner } = {}) {
    if (typeof adapter?.updateViewState !== 'function') return;
    const failures = [];
    for (const [id, entry] of mounted) {
      if (owner && entry.owner !== owner) continue;
      try {
        if (waitForPending) await settleState(entry);
        if (entry.closed || mounted.get(id) !== entry) continue;
        if (descriptor(id)?.type !== entry.type) continue;
        const state = clone(entry.view.getState());
        entry.stateKey = JSON.stringify(state || {});
        await adapter.updateViewState(id, { type: entry.type, state });
      } catch (error) { if (waitForPending) failures.push(error); else report(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Custom view state could not be captured');
  }

  async function syncWorkspace({ forceState = false } = {}) {
    const snapshot = new Map(all().map(leaf => [leaf.id, leaf]));
    const pending = [];
    for (const [id, entry] of mounted) {
      const state = snapshot.get(id);
      if (!state || state.type !== entry.type) { increment(id); pending.push(closeEntry(id, entry)); }
      else pending.push(queueState(id, entry, state.state, forceState));
    }
    const settled = await Promise.allSettled(pending);
    for (const result of settled) if (result.status === 'rejected') report(result.reason);
    const opening = [];
    for (const state of all()) {
      const path = state.state?.file, extension = path?.split('.').pop()?.toLowerCase();
      const route = extensions.get(extension);
      if (route && state.type !== route.type && !factories.has(state.type) && !restoring.has(state.id)) {
        restoring.add(state.id);
        opening.push(route.wrapLeaf(state.id).setViewState({type: route.type, state: {file: path}}).catch(report).finally(() => restoring.delete(state.id)));
      }
    }
    for (const state of all()) {
      const registration = factories.get(state.type);
      if (!registration || registration.record.cancelled || mounted.has(state.id) || restoring.has(state.id)) continue;
      restoring.add(state.id);
      opening.push(registration.wrapLeaf(state.id).setViewState(state).catch(report).finally(() => restoring.delete(state.id)));
    }
    await Promise.all(opening);
  }

  function forPlugin({ record, ensureActive, track, events, getApp, metadataCache }) {
    const leaves = new Map(), markdownViews = new Map();
    class FileView extends ItemView {
      constructor(leaf) { super(leaf); this.file = null; this.allowNoFile = false; }
      getState() { return {...super.getState(), ...(this.file ? {file: this.file.path} : {})}; }
      async setState(state = {}, result) {
        const next = state.file ? fileAt(state.file) : null;
        if (state.file && !next) throw new Error('File does not exist: ' + state.file);
        if (next?.path !== this.file?.path) {
          if (this.file) await this.onUnloadFile(this.file);
          this.file = next;
          if (next) await this.onLoadFile(next);
        }
        await super.setState(state, result);
      }
      async onLoadFile(file) {}
      async onUnloadFile(file) {}
      async onClose() { if (this.file) await this.onUnloadFile(this.file); this.file = null; }
    }
    class MarkdownView extends ItemView {
      constructor(leaf) { super(leaf); this._editors = new Map(); }
      get file() { ensureActive(); const path = descriptor(this.leaf.id)?.state?.file; return path ? fileAt(path) : null; }
      get editor() {
        ensureActive(); const path = this.file?.path;
        if (!path) return unsupported('MarkdownView.editor', 'No Markdown document is open in this leaf.');
        if (!getEditor?.(this.leaf.id)) return unsupported('MarkdownView.editor', 'No mounted editor adapter is available for this leaf.');
        if (!this._editors.has(path)) this._editors.set(path, new PluginEditor({ path, ensureActive, unsupported, getAdapter: () => getEditor?.(this.leaf.id) }));
        return this._editors.get(path);
      }
      getViewType() { return 'markdown'; }
      getDisplayText() { return this.file?.basename || ''; }
      getMode() { ensureActive(); const status = getEditor?.(this.leaf.id)?.getStatus?.(); return status?.mode === 'reading' ? 'preview' : 'source'; }
      getViewData() { ensureActive(); const path = this.file?.path, editor = getEditor?.(this.leaf.id); return editor?.path === path && typeof editor.getValue === 'function' ? editor.getValue() : currentRecords().get(path)?.content || ''; }
      setViewData(value, clear = false) { this.editor.setValue(value); if (clear) this.editor.setCursor({ line: 0, ch: 0 }); }
      getState() { ensureActive(); return clone(descriptor(this.leaf.id)?.state || {}); }
    }
    class WorkspaceLeaf {
      constructor(id) { Object.defineProperty(this, 'id', { value: id, enumerable: true }); }
      get app() { return getApp(); }
      _assertActive() { ensureActive(); }
      get containerEl() { ensureActive(); return container(this.id); }
      get view() {
        ensureActive(); const entry = mounted.get(this.id);
        if (entry) return entry.view;
        const state = descriptor(this.id);
        if (state?.type === 'markdown') { if (!markdownViews.has(this.id)) markdownViews.set(this.id, new MarkdownView(this)); return markdownViews.get(this.id); }
        return strictApi('View', { getViewType: () => state?.type || 'empty', getDisplayText: () => state?.title || state?.type || 'Empty', getState: () => clone(state?.state || {}), containerEl: container(this.id) });
      }
      getViewState() {
        ensureActive(); const state = descriptor(this.id), entry = mounted.get(this.id);
        return state ? { type: state.type, state: clone(entry?.view?.getState?.() ?? state.state ?? {}), ...(state.pinned == null ? {} : { pinned: !!state.pinned }) } : { type: 'empty', state: {} };
      }
      async openFile(file, state) {
        ensureActive(); const path = filePathOf(file);
        const route = extensions.get(path.split('.').pop().toLowerCase());
        if (route) return this.setViewState({type: route.type, state: {...state, file: path}});
        const version = increment(this.id);
        await closeEntry(this.id); ensureActive();
        if (!isCurrent(this.id, version)) throw new Error('A newer view operation replaced this open request');
        if (adapter) await need('openFile')(this.id, path, state);
        else await openFile(path, state);
        ensureActive();
        if (!hasExternalEvents) emit('file-open', file);
      }
      async setViewState(state) {
        ensureActive();
        if (!state || typeof state.type !== 'string') throw new TypeError('View state requires a type');
        if (state.type === 'markdown') {
          const file = state.state?.file ? fileAt(state.state.file) : null;
          if (!file) throw new Error('The requested Markdown file does not exist');
          if (!adapter) { await this.openFile(file, { ...state.state, active: state.active }); return; }
          const version = increment(this.id); await closeEntry(this.id); ensureActive();
          if (!isCurrent(this.id, version)) throw new Error('A newer view operation replaced this state request');
          await need('setViewState')(this.id, clone(state)); ensureActive();
          if (!hasExternalEvents) emit('file-open', file); return;
        }
        const registered = factories.get(state.type);
        if (!registered && state.type !== 'empty') return unsupported(`WorkspaceLeaf.setViewState(${state.type})`, 'No enabled plugin has registered this view type.');
        need('setViewState');
        const version = increment(this.id);
        await closeEntry(this.id); ensureActive();
        if (!isCurrent(this.id, version)) throw new Error('A newer view operation replaced this state request');
        if (state.type === 'empty') { await need('setViewState')(this.id, clone(state)); return; }
        registered.ensureActive();
        // Each view owns a fresh container: a delayed onOpen/onClose from an old
        // view must never write into, or clear, its replacement's DOM.
        containers.delete(this.id);
        const ownerLeaf = registered.wrapLeaf(this.id);
        let resolveReady;
        const ready = { promise: new Promise(resolve => { resolveReady = resolve; }), resolve: () => resolveReady() };
        const entry = { leafId: this.id, type: state.type, owner: registered.record, view: null, closed: false, closing: null, ready, stateQueue: ready.promise, stateKey: undefined };
        try {
          entry.view = registered.creator(ownerLeaf);
          if (!(entry.view instanceof View)) throw new TypeError('registerView must return an ItemView or View instance');
          if (entry.view.getViewType() !== state.type) throw new Error('Registered view type differs from getViewType()');
          mounted.set(this.id, entry); changed();
          queueState(this.id, entry, state.state);
          await need('setViewState')(this.id, clone(state));
          registered.ensureActive();
          if (!isCurrent(this.id, version) || entry.closed) throw new Error('The view was replaced while opening');
          await entry.view.load();
          await entry.view.onOpen();
          registered.ensureActive();
          if (!isCurrent(this.id, version) || entry.closed) throw new Error('The view was closed while opening');
          ready.resolve();
          await settleState(entry);
          registered.ensureActive();
          if (!isCurrent(this.id, version) || entry.closed) throw new Error('The view was closed while receiving state');
          changed();
          if (state.active) await need('revealLeaf')(this.id);
        } catch (error) { try { await closeEntry(this.id, entry); } catch (closeError) { report(closeError); } throw error; }
      }
      async detach() { ensureActive(); need('detachLeaf'); increment(this.id); await closeEntry(this.id); ensureActive(); await need('detachLeaf')(this.id); containers.delete(this.id); leaves.delete(this.id); markdownViews.delete(this.id); changed(); }
      setEphemeralState(state) { ensureActive(); const entry = mounted.get(this.id); if (entry) return entry.view.setEphemeralState(state); return unsupported('WorkspaceLeaf.setEphemeralState', 'Only custom views expose ephemeral state through this adapter.'); }
      getEphemeralState() { ensureActive(); return mounted.get(this.id)?.view?.getEphemeralState?.() || {}; }
      setPinned(value) { ensureActive(); if (typeof adapter?.setPinned !== 'function') return unsupported('WorkspaceLeaf.setPinned'); return adapter.setPinned(this.id, !!value); }
      get isPinned() { ensureActive(); return !!descriptor(this.id)?.pinned; }
    }
    function wrapLeaf(value) { const id = typeof value === 'string' ? value : value?.id; if (!id) return null; if (!leaves.has(id)) leaves.set(id, strictApi('WorkspaceLeaf', new WorkspaceLeaf(id))); return leaves.get(id); }
    function editorContext(leafId, path) {
      ensureActive(); const id = leafId || activeId(), state = descriptor(id);
      if (!id || state?.type !== 'markdown' || (path && state.state?.file !== path)) return null;
      const editor = getEditor?.(id);
      if (!editor || editor.path !== state.state?.file) return null;
      const view = wrapLeaf(id).view;
      return { editor: view.editor, view };
    }
    function activeEditorContext() {
      ensureActive(); const id = activeId(), state = descriptor(id);
      if (!id || state?.type !== 'markdown') return null;
      const editor = getEditor?.(id), status = editor?.getStatus?.();
      if (!editor || editor.path !== state.state?.file || status?.mode === 'reading' || status?.readOnly || status?.composing || status?.pending || status?.destroyed || status?.canEdit === false) return null;
      const view = wrapLeaf(id).view;
      return { editor: view.editor, view };
    }
    const workspace = strictApi('app.workspace', {
      ...events,
      get activeLeaf() { ensureActive(); return wrapLeaf(activeId()); },
      getActiveFile: () => { ensureActive(); const id = activeId(), path = descriptor(id)?.state?.file; return path ? fileAt(path) : null; },
      getActiveViewOfType: Type => { ensureActive(); const leaf = wrapLeaf(activeId()); if (!leaf) return null; const view = leaf.view; return view instanceof Type ? view : null; },
      getLeaf: (newLeaf = false, direction) => {
        ensureActive();
        if (!newLeaf) { const id = activeId(); if (id) return wrapLeaf(id); if (!adapter) return wrapLeaf('active'); }
        const mode = newLeaf === true || !newLeaf ? 'tab' : newLeaf;
        if (!['tab', 'split'].includes(mode)) return unsupported(`app.workspace.getLeaf(${mode})`);
        const result = need('createLeaf')(mode, direction);
        if (result?.then) throw new TypeError('createLeaf must return a leaf synchronously');
        if (!result?.id && typeof result !== 'string') throw new Error('createLeaf returned no leaf identity');
        return wrapLeaf(result);
      },
      getLeavesOfType: type => { ensureActive(); return all().filter(leaf => leaf.type === type).map(wrapLeaf); },
      getMostRecentLeaf: () => { ensureActive(); return wrapLeaf(activeId()); },
      iterateAllLeaves: callback => { ensureActive(); for (const leaf of all()) callback(wrapLeaf(leaf)); },
      revealLeaf: async leaf => { ensureActive(); if (!(leaf instanceof WorkspaceLeaf)) throw new TypeError('Expected a WorkspaceLeaf from this plugin context'); await need('revealLeaf')(leaf.id); },
      setActiveLeaf: (leaf, options) => { ensureActive(); if (!(leaf instanceof WorkspaceLeaf)) throw new TypeError('Expected a WorkspaceLeaf'); Promise.resolve(need('revealLeaf')(leaf.id, options)).catch(report); },
      detachLeavesOfType: type => { ensureActive(); return Promise.all(all().filter(leaf => leaf.type === type).map(leaf => wrapLeaf(leaf).detach())); },
      openLinkText: async (link, sourcePath = '', newLeaf = false, state) => {
        ensureActive(); const target = metadataCache.getFirstLinkpathDest(link, sourcePath);
        if (!target) throw new Error('Unresolved link: ' + link);
        const subpath = String(link).includes('#') ? '#' + String(link).split('#').slice(1).join('#') : '';
        await workspace.getLeaf(newLeaf).openFile(target, { ...state, subpath });
      },
      getLayout: () => {
        ensureActive(); const layout = clone(need('getLayout')());
        const visit = node => { if (!node || typeof node !== 'object') return; const entry = mounted.get(node.id); if (node.type === 'leaf' && entry) node.state = { ...node.state, type: entry.type, state: clone(entry.view.getState()) }; for (const child of node.children || []) visit(child); };
        for (const name of ['main', 'left', 'right', 'floating']) visit(layout[name]); return layout;
      },
      changeLayout: async layout => { ensureActive(); await need('changeLayout')(clone(layout)); ensureActive(); await syncWorkspace({ forceState: true }); },
      requestSaveLayout: () => { ensureActive(); if (!adapter?.requestSaveLayout) return unsupported('app.workspace.requestSaveLayout'); void saveViewStates().then(() => { ensureActive(); return adapter.requestSaveLayout(); }).catch(report); },
    });
    function registerView(type, creator) {
      ensureActive(); need('setViewState'); need('getLeaves');
      if (typeof type !== 'string' || !type.trim() || ['markdown', 'empty', 'file'].includes(type)) throw new TypeError('A unique custom view type is required');
      if (typeof creator !== 'function') throw new TypeError('View creator must be a function');
      if (factories.has(type)) throw new Error('View type already registered: ' + type);
      const registration = { type, creator, record, ensureActive, wrapLeaf };
      factories.set(type, registration);
      track(async () => {
        if (factories.get(type) === registration) factories.delete(type);
        await saveViewStates({ waitForPending: false, owner: record });
        const pending = [];
        for (const [id, entry] of mounted) if (entry.owner === record && entry.type === type) { increment(id); pending.push(closeEntry(id, entry)); }
        const results = await Promise.allSettled(pending);
        for (const result of results) if (result.status === 'rejected') report(result.reason);
        changed();
      });
      queueMicrotask(() => { if (!record.cancelled) void syncWorkspace().catch(report); });
    }
    function registerExtensions(values, type) {
      ensureActive();
      if (!factories.has(type) || factories.get(type).record !== record) throw new Error('Register the view before its extensions');
      if (!Array.isArray(values) || !values.length || values.some(e => typeof e !== 'string' || !/^[a-z0-9]+$/i.test(e))) throw new TypeError('Invalid file extensions');
      for (const value of values) if (['md','pdf','canvas','base'].includes(value.toLowerCase()) || extensions.has(value.toLowerCase())) throw new Error('Extension already registered: ' + value);
      for (const value of values) extensions.set(value.toLowerCase(), {type, record, wrapLeaf});
      track(() => {for (const [ext, route] of extensions) if (route.record === record) extensions.delete(ext);});
      queueMicrotask(() => {if (!record.cancelled) void syncWorkspace().catch(report);});
    }
    return { workspace, View, ItemView, FileView, MarkdownView, WorkspaceLeaf, Editor: PluginEditor, registerView, registerExtensions, activeEditorContext, editorContext, wrapLeaf };
  }

  function uiViews() { return [...mounted.values()].filter(entry => entry.view && !entry.closed).map(entry => ({ leafId: entry.leafId, type: entry.type, title: entry.view.getDisplayText(), icon: entry.view.getIcon(), element: entry.view.containerEl })); }
  async function dispose() { const result = await Promise.allSettled([...mounted].map(([id, entry]) => closeEntry(id, entry))); factories.clear(); containers.clear(); versions.clear(); for (const item of result) if (item.status === 'rejected') report(item.reason); }
  return { forPlugin, uiViews, syncWorkspace, dispose, captureViewStates: () => saveViewStates(), getViewElement: id => mounted.get(id)?.view?.containerEl || null };
}
