import { parseMarkdown, getReferences, resolveLink, normalizePath as normalizeCorePath } from '../core/vault.mjs';
import { decodeBinary, encodeBinary, toArrayBuffer, transformFrontmatter } from './plugin-files.mjs';
import { createPluginViews } from './plugin-views.mjs';
import { createPluginMarkdown } from './plugin-markdown.mjs';
import { getPluginIcon, setPluginIcon } from './plugin-icons.mjs';

export class PluginCompatibilityError extends Error {
  constructor(api, detail = 'This API is outside the supported plugin subset.') {
    super(`${api}: ${detail}`);
    this.name = 'PluginCompatibilityError';
    this.code = 'PLUGIN_API_UNSUPPORTED';
    this.api = api;
  }
}
const unsupported = (api, detail) => { throw new PluginCompatibilityError(api, detail); };
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const dirname = value => value.slice(0, Math.max(0, value.lastIndexOf('/')));
const basename = value => value.slice(value.lastIndexOf('/') + 1);
function assertText(value, name) { if (typeof value !== 'string') throw new TypeError(`${name} must be a string`); return value; }
function safePath(value, allowRoot = false) {
  assertText(value, 'Vault path');
  if (/^(?:[a-z]:|[\\/]{2})/i.test(value) || value.includes('\0')) throw new Error('Expected a vault-relative path');
  const result = normalizeCorePath(value);
  if (result == null || (!result && !allowRoot)) throw new Error('Path must remain inside the vault');
  if (result.split('/').some(part => ['.obsidian', '.vaultdesk', '.git'].includes(part.toLowerCase()))) throw new Error('Plugin file APIs cannot access application configuration directories');
  return result;
}
function strictApi(name, object) {
  return new Proxy(object, { get(target, key, receiver) {
    if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return Reflect.get(target, key, receiver);
    if (!(key in target)) unsupported(`${name}.${key}`);
    return Reflect.get(target, key, receiver);
  } });
}
function once(callback) { let live = true; return () => { if (!live) return; live = false; return callback(); }; }

function decorate(element) {
  if (!element || element.__vaultdeskDecorated) return element;
  Object.defineProperty(element, '__vaultdeskDecorated', { value: true });
  element.empty = () => { element.replaceChildren(); return element; };
  element.detach = () => element.remove();
  element.setText = text => { element.textContent = String(text ?? ''); return element; };
  element.addClass = (...names) => { element.classList.add(...names); return element; };
  element.removeClass = (...names) => { element.classList.remove(...names); return element; };
  element.toggleClass = (name, enabled) => { element.classList.toggle(name, enabled); return element; };
  element.hasClass = name => element.classList.contains(name);
  element.setAttr = (name, value) => { value == null ? element.removeAttribute(name) : element.setAttribute(name, String(value)); return element; };
  element.setAttrs = values => { for (const [name, value] of Object.entries(values)) element.setAttr(name, value); return element; };
  element.find = selector => decorate(element.querySelector(selector));
  element.findAll = selector => [...element.querySelectorAll(selector)].map(decorate);
  element.createEl = (tag, options = {}, callback) => {
    const child = createElement(tag);
    if (typeof options === 'string') options = { cls: options };
    if (options.cls) child.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
    if (options.text != null) child.textContent = String(options.text);
    for (const key of ['title', 'href', 'type', 'value']) if (options[key] != null) child.setAttribute(key, String(options[key]));
    for (const [key, value] of Object.entries(options.attr || {})) child.setAttribute(key, String(value));
    element.appendChild(child); callback?.(child); return child;
  };
  element.createDiv = (options, callback) => element.createEl('div', options, callback);
  element.createSpan = (options, callback) => element.createEl('span', options, callback);
  return element;
}
function createElement(tag) {
  if (!globalThis.document?.createElement) unsupported('DOM', 'This plugin requires a document-backed renderer.');
  return decorate(document.createElement(tag));
}

export class TFile {
  constructor(filePath = '') { this.path = filePath; this.name = basename(filePath); this.basename = this.name.replace(/\.[^.]*$/, ''); this.extension = this.name.includes('.') ? this.name.slice(this.name.lastIndexOf('.') + 1) : ''; this.parent = null; this.stat = { ctime: 0, mtime: 0, size: 0 }; }
}
export class TFolder {
  constructor(folderPath = '') { this.path = folderPath; this.name = basename(folderPath); this.parent = null; this.children = []; }
  isRoot() { return !this.path; }
}

class Emitter {
  constructor(report) { this.listeners = new Map(); this.report = report; }
  on(name, callback, context) {
    if (typeof callback !== 'function') throw new TypeError('Event callback must be a function');
    const entry = { name, callback, context, emitter: this };
    const set = this.listeners.get(name) || new Set(); set.add(entry); this.listeners.set(name, set);
    entry.off = once(() => { set.delete(entry); if (!set.size) this.listeners.delete(name); });
    return entry;
  }
  off(name, callback) { for (const ref of this.listeners.get(name) || []) if (ref.callback === callback) ref.off(); }
  offref(ref) { ref?.off?.(); }
  emit(name, ...args) { for (const ref of [...(this.listeners.get(name) || [])]) { try { Promise.resolve(ref.callback.apply(ref.context, args)).catch(this.report); } catch (error) { this.report(error); } } }
  clear() { for (const set of this.listeners.values()) for (const ref of set) ref.off(); }
}

export class Component {
  constructor() { this._cleanups = []; this._children = new Set(); this._loaded = false; this._closed = false; }
  register(callback) { if (typeof callback !== 'function') throw new TypeError('Cleanup must be a function'); const cleanup = once(callback); if (this._closed) cleanup(); else this._cleanups.push(cleanup); return cleanup; }
  registerEvent(ref) { this.register(typeof ref === 'function' ? ref : () => ref?.off?.()); return ref; }
  registerDomEvent(element, name, callback, options) { element.addEventListener(name, callback, options); this.register(() => element.removeEventListener(name, callback, options)); }
  registerInterval(id) { this.register(() => clearInterval(id)); return id; }
  addChild(child) { this._children.add(child); if (this._loaded) Promise.resolve(child.load()).catch(error => console.error(error)); return child; }
  removeChild(child) { this._children.delete(child); return child.unload(); }
  async load() { if (this._closed) throw new Error('Component has been unloaded'); if (this._loaded) return; this._loaded = true; await this.onload?.(); if (this._closed) throw new Error('Component was unloaded while loading'); for (const child of this._children) await child.load(); }
  async unload() {
    if (this._closed) return; this._closed = true;
    const errors = [], pending = [];
    const attempt = callback => { try { pending.push(Promise.resolve(callback()).catch(error => { errors.push(error); })); } catch (error) { errors.push(error); } };
    attempt(() => this.onunload?.());
    for (const child of [...this._children].reverse()) attempt(() => child.unload());
    for (const cleanup of this._cleanups.reverse()) attempt(cleanup);
    this._children.clear(); this._cleanups.length = 0; this._loaded = false;
    await Promise.all(pending);
    if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed; all registered cleanup callbacks were attempted');
  }
}

function normalizeRecords(input) {
  if (input?.then) throw new TypeError('getFiles must return a synchronous snapshot');
  if (input && !Array.isArray(input) && Array.isArray(input.files)) input = input.files;
  const list = input instanceof Map ? [...input].map(([filePath, value]) => typeof value === 'string' ? { path: filePath, content: value } : { ...value, path: filePath })
    : Array.isArray(input) ? input.map(value => typeof value === 'string' ? { path: value } : value)
      : Object.entries(input || {}).map(([filePath, value]) => typeof value === 'string' ? { path: filePath, content: value } : { ...value, path: filePath });
  const map = new Map();
  for (const value of list) {
    if (!value?.path) continue;
    let filePath; try { filePath = safePath(value.path); } catch { continue; }
    map.set(filePath, { ...value, path: filePath, content: typeof value.content === 'string' ? value.content : typeof value.text === 'string' ? value.text : undefined });
    for (let parent = dirname(filePath); parent; parent = dirname(parent)) if (!map.has(parent)) map.set(parent, { path: parent, isDirectory: true });
  }
  return map;
}
const fingerprint = record => record ? JSON.stringify([!!record.isDirectory, record.content ?? null, record.mtime ?? null, record.size ?? null]) : null;
const equivalent = (left, right) => left == null || right == null ? left === right : !!left.isDirectory === !!right.isDirectory && left.content === right.content && (left.isDirectory || typeof left.content === 'string' || (left.mtime === right.mtime && left.size === right.size));
async function importBlobModule(code) {
  if (!globalThis.Blob || typeof URL.createObjectURL !== 'function') unsupported('Plugin loader', 'Blob modules are unavailable in this renderer.');
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try { return await import(/* @vite-ignore */ url); }
  finally { URL.revokeObjectURL(url); }
}

/** Explicitly enabled, trusted CommonJS plugins; this is not a security sandbox. */
export function createExtensionHost({ bridge, getFiles = () => [], getActivePath = () => null, getEditor, workspaceAdapter, openFile = () => {}, notice = () => {}, addCommand, removeCommand, onEvent, moduleLoader = importBlobModule, markdownRenderer } = {}) {
  if (!bridge) throw new TypeError('A vault bridge is required');
  const records = new Map(), commands = new Map(), objects = new Map(), overlays = new Map(), processQueues = new Map(), memoryData = new Map();
  const ribbon = new Map(), statusBar = new Map(), uiListeners = new Set(), surfaces = new Map();
  let uiRevision = 0, markdownRevision = 0, uiSnapshot = Object.freeze({ revision: 0, markdownRevision: 0, ribbon: [], statusBar: [], views: [] }), viewRuntime, markdownRuntime;
  const hasExternalEvents = typeof onEvent === 'function';
  let disposed = false, disposePromise, revision = 0, sourceRecords = normalizeRecords(getFiles()), latestRecords = sourceRecords, vaultIdentity = 'session', pulling = false, pullAgain = false;
  const report = error => { try { notice(`插件错误：${error?.message || error}`); } catch { /* A notice must not prevent cleanup. */ } };
  function publishUI() {
    let views = [];
    try { views = viewRuntime?.uiViews() || []; } catch (error) { report(error); }
    uiSnapshot = Object.freeze({ revision: ++uiRevision, markdownRevision, ribbon: [...ribbon.values()], statusBar: [...statusBar.values()], views });
    for (const listener of uiListeners) { try { listener(); } catch (error) { report(error); } }
  }
  function mountSurface(name, element) {
    const target = [...(surfaces.get(name) || [])].find(value => typeof value?.appendChild === 'function');
    target?.appendChild(element);
  }
  const vaultEvents = new Emitter(report), workspaceEvents = new Emitter(report), metadataEvents = new Emitter(report);
  const root = new TFolder(''); objects.set('', root);
  function currentRecords() {
    sourceRecords = normalizeRecords(getFiles());
    const merged = new Map(sourceRecords);
    for (const [filePath, overlay] of overlays) {
      const observed = sourceRecords.get(filePath);
      if (equivalent(observed, overlay.value) || fingerprint(observed) !== overlay.base) { overlays.delete(filePath); continue; }
      overlay.value ? merged.set(filePath, overlay.value) : merged.delete(filePath);
    }
    return merged;
  }
  function index(map = currentRecords()) {
    root.children = [];
    for (const folder of objects.values()) if (folder instanceof TFolder) folder.children = [];
    for (const [filePath, record] of map) {
      let item = objects.get(filePath);
      if (!item || (record.isDirectory ? !(item instanceof TFolder) : !(item instanceof TFile))) { item = record.isDirectory ? new TFolder(filePath) : new TFile(filePath); objects.set(filePath, item); }
      item.path = filePath; item.name = basename(filePath);
      if (item instanceof TFile) { item.basename = item.name.replace(/\.[^.]*$/, ''); item.extension = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.') + 1) : ''; item.stat = { ctime: record.ctime || record.mtime || 0, mtime: record.mtime || 0, size: record.size ?? new TextEncoder().encode(record.content || '').length }; }
    }
    for (const [filePath, item] of objects) if (filePath && map.has(filePath)) { item.parent = objects.get(dirname(filePath)) || root; item.parent.children.push(item); }
    latestRecords = map;
    return map;
  }
  function fileAt(filePath) { const normalized = safePath(filePath, true); const map = index(); return !normalized ? root : map.has(normalized) ? objects.get(normalized) : null; }
  function filePathOf(file, allowFolder = false) { if (!(file instanceof TFile) && !(allowFolder && file instanceof TFolder)) throw new TypeError('Expected a file object from this vault'); const p = safePath(file.path); if (objects.get(p) !== file) throw new Error('File does not belong to this vault'); return p; }
  function overlay(filePath, value) { overlays.set(filePath, { base: fingerprint(sourceRecords.get(filePath)), value }); }
  function applyChanges(before, after, rename) {
    // Commit only this operation's delta onto the latest state. An unrelated
    // concurrent write must never be replaced by a pre-await full snapshot.
    const previous = new Map(latestRecords), committed = new Map(currentRecords());
    for (const [filePath, record] of after) if (fingerprint(before.get(filePath)) !== fingerprint(record)) { overlay(filePath, record); committed.set(filePath, record); }
    for (const filePath of before.keys()) if (!after.has(filePath)) { overlay(filePath, undefined); committed.delete(filePath); }
    revision++;
    if (rename) for (const [oldPath, item] of [...objects]) if (oldPath === rename.from || oldPath.startsWith(rename.from + '/')) { objects.delete(oldPath); item.path = rename.to + oldPath.slice(rename.from.length); objects.set(item.path, item); }
    index(committed);
    if (rename) vaultEvents.emit('rename', objects.get(rename.to), rename.from);
    for (const [filePath, record] of committed) {
      if (record.isDirectory) { if (!previous.has(filePath) && !rename) vaultEvents.emit('create', objects.get(filePath)); continue; }
      const old = previous.get(filePath);
      if (!old && !rename) vaultEvents.emit('create', objects.get(filePath));
      else if (old && fingerprint(old) !== fingerprint(record)) vaultEvents.emit('modify', objects.get(filePath));
      if ((!old || old.content !== record.content) && typeof record.content === 'string') metadataEvents.emit('changed', objects.get(filePath), record.content, cacheFor(filePath));
    }
    for (const filePath of previous.keys()) if (!committed.has(filePath) && !rename) vaultEvents.emit('delete', objects.get(filePath));
    metadataEvents.emit('resolved');
  }
  async function pullSnapshot() {
    if (disposed || typeof bridge.snapshot !== 'function') return;
    if (pulling) { pullAgain = true; return; }
    pulling = true;
    try {
      do {
        pullAgain = false;
        const observedRevision = revision;
        const snapshot = await bridge.snapshot();
        if (disposed) return;
        if (revision !== observedRevision) { pullAgain = true; continue; }
        const nextIdentity = String(snapshot.vaultPath || vaultIdentity);
        if (vaultIdentity !== 'session' && nextIdentity !== vaultIdentity) {
          // An enable decision belongs to one vault. Revoke capabilities before
          // adopting another vault; never move plugin data to the new namespace.
          const stopping = [...records.keys()].map(disable);
          vaultIdentity = nextIdentity; overlays.clear(); objects.clear(); objects.set('', root);
          latestRecords = normalizeRecords(snapshot); index(latestRecords);
          void Promise.allSettled(stopping).then(results => { for (const result of results) if (result.status === 'rejected') report(result.reason); });
          continue;
        }
        vaultIdentity = nextIdentity;
        const before = new Map(latestRecords), after = normalizeRecords(snapshot);
        applyChanges(before, after);
      } while (pullAgain);
    } catch (error) { report(error); }
    finally { pulling = false; }
  }
  const bridgeUnsubscribe = typeof bridge.onChange === 'function' ? bridge.onChange(() => { void pullSnapshot(); }) : null;
  const externalUnsubscribe = hasExternalEvents ? onEvent(event => {
    if (!event || disposed) return;
    const name = event.name || event.type;
    const emitter = event.scope === 'vault' ? vaultEvents : event.scope === 'metadata' ? metadataEvents : workspaceEvents;
    if (emitter === workspaceEvents && name === 'editor-change') emitter.emit(name, { leafId: event.leafId, path: event.path });
    else emitter.emit(name, ...(event.args || (event.path ? [fileAt(event.path)] : [])));
    if (emitter === workspaceEvents && ['layout-change', 'active-leaf-change', 'file-open'].includes(name)) void viewRuntime?.syncWorkspace();
  }) : null;
  index();

  function position(text, offset) { const before = text.slice(0, offset); const line = before.split('\n').length - 1; return { line, col: offset - (before.lastIndexOf('\n') + 1), offset }; }
  function cacheFor(filePath) {
    const record = currentRecords().get(filePath);
    if (!record || typeof record.content !== 'string' || !/\.md$/i.test(filePath)) return null;
    const text = record.content, parsed = parseMarkdown(text);
    const range = (start, end) => ({ start: position(text, start), end: position(text, end) });
    const references = parsed.references.map(ref => ({ link: ref.link, original: ref.original, displayText: ref.display || undefined, position: range(ref.start, ref.end), _kind: ref.kind }));
    return { frontmatter: copy(parsed.frontmatter), headings: parsed.headings.map(h => ({ heading: h.heading, level: h.level, position: range(h.offset, text.indexOf('\n', h.offset) < 0 ? text.length : text.indexOf('\n', h.offset)) })),
      links: references.filter(ref => ref._kind === 'link').map(({ _kind, ...ref }) => ref), embeds: references.filter(ref => ref._kind === 'embed').map(({ _kind, ...ref }) => ref),
      frontmatterLinks: references.filter(ref => ref._kind === 'frontmatter').map(({ _kind, ...ref }) => ref),
      tags: parsed.tags.map(tag => ({ tag })), blocks: Object.fromEntries(parsed.blocks.map(block => [block.id, { id: block.id, position: range(block.offset, block.offset + block.id.length + 1) }])),
      frontmatterPosition: parsed.frontmatterRange ? range(parsed.frontmatterRange.start, parsed.frontmatterRange.end) : undefined };
  }
  function linkCounts(unresolved = false) {
    const map = currentRecords(), paths = [...map].filter(([, value]) => !value.isDirectory).map(([filePath]) => filePath), result = {};
    for (const [filePath, record] of map) if (/\.md$/i.test(filePath) && typeof record.content === 'string') {
      result[filePath] = {};
      for (const ref of getReferences(record.content, filePath, paths)) if (unresolved ? !ref.path : !!ref.path) { const key = unresolved ? ref.linkpath : ref.path; result[filePath][key] = (result[filePath][key] || 0) + 1; }
    }
    return result;
  }
  function needBridge(name) { if (typeof bridge[name] !== 'function') unsupported(`app.vault.${name}`, 'The current bridge does not implement this operation.'); return bridge[name].bind(bridge); }
  async function mutateRecord(filePath, content, createOnly = false, ensureActive = () => {}) {
    assertText(content, 'File content');
    const before = new Map(index());
    let result;
    if (createOnly) result = await needBridge('create')(filePath, content);
    else { const read = await needBridge('read')(filePath); ensureActive(); result = await needBridge('write')(filePath, content, read?.mtime, read?.version); }
    ensureActive();
    const after = new Map(before); after.set(filePath, { path: filePath, content, mtime: result?.mtime || Date.now(), size: new TextEncoder().encode(content).length });
    for (let parent = dirname(filePath); parent; parent = dirname(parent)) if (!after.has(parent)) after.set(parent, { path: parent, isDirectory: true });
    applyChanges(before, after); return objects.get(filePath);
  }
  async function binaryRead(filePath, ensureActive) {
    const result = await needBridge('readBinary')(filePath); ensureActive();
    const bytes = result instanceof ArrayBuffer || ArrayBuffer.isView(result) ? toArrayBuffer(result) : decodeBinary(result?.base64);
    return { bytes, mtime: result?.mtime, version: result?.version };
  }
  async function binaryWrite(filePath, data, createOnly, ensureActive, read) {
    const bytes = toArrayBuffer(data), encoded = encodeBinary(bytes);
    if (!createOnly && !read) read = await binaryRead(filePath, ensureActive);
    ensureActive(); const before = new Map(index());
    const result = createOnly ? await needBridge('writeBinary')(filePath, encoded) : await needBridge('modifyBinary')(filePath, encoded, read?.mtime, read?.version);
    ensureActive();
    const after = new Map(before); after.set(filePath, { path: filePath, mtime: result?.mtime || Date.now(), size: bytes.byteLength });
    for (let parent = dirname(filePath); parent; parent = dirname(parent)) if (!after.has(parent)) after.set(parent, { path: parent, isDirectory: true });
    applyChanges(before, after); return objects.get(filePath);
  }
  function assertWriteOptions(options) { if (options && Object.keys(options).length) unsupported('Vault write options', 'Custom ctime/mtime overrides are not implemented.'); }
  function queueProcess(path, callback) {
    const previous = processQueues.get(path) || Promise.resolve();
    const operation = previous.catch(() => {}).then(callback);
    processQueues.set(path, operation); operation.finally(() => { if (processQueues.get(path) === operation) processQueues.delete(path); }).catch(() => {});
    return operation;
  }
  async function renameFile(file, newPath, managed) {
    const oldPath = filePathOf(file, true), next = safePath(newPath), before = new Map(index());
    const result = await needBridge('rename')(oldPath, next, { via: managed ? 'managed' : 'storage', alwaysUpdateLinks: managed });
    let after;
    if (typeof bridge.snapshot === 'function') {
      // Reference rewrites need the full post-rename snapshot. If a different
      // operation commits while that snapshot is in flight, fetch again rather
      // than rolling its newer cache value back to the captured snapshot.
      let observedRevision;
      do { observedRevision = revision; after = normalizeRecords(await bridge.snapshot()); }
      while (observedRevision !== revision);
    }
    else after = new Map([...before].map(([p, value]) => { const target = p === oldPath || p.startsWith(oldPath + '/') ? next + p.slice(oldPath.length) : p; return [target, { ...value, path: target }]; }));
    applyChanges(before, after, { from: oldPath, to: next });
    if (result?.warnings?.length) throw new Error('Rename completed with reference update errors: ' + result.warnings.map(item => item.message || item.path).join('; '));
  }

  viewRuntime = createPluginViews({ Component, createElement, decorate, strictApi, unsupported, workspaceAdapter, getActivePath, openFile, getEditor,
    fileAt, filePathOf, currentRecords, report, changed: publishUI, emit: (...args) => workspaceEvents.emit(...args), hasExternalEvents });
  markdownRuntime = createPluginMarkdown({ Component, createElement, decorate, getSource: path => currentRecords().get(path)?.content, report, changed: () => { markdownRevision++; publishUI(); } });

  function createPluginApi(record) {
    const ensureActive = () => { if (disposed || record.state === 'disabled' || record.cancelled) throw new Error(`Plugin ${record.manifest.id} is disabled`); };
    const track = callback => { const cleanup = once(callback); record.cleanups.push(cleanup); return cleanup; };
    const subscribe = (emitter, name, callback, context) => { ensureActive(); const guarded = (...args) => { if (!record.cancelled && !disposed) return callback.apply(context, args); }; const ref = emitter.on(name, guarded); ref.originalCallback = callback; track(ref.off); return ref; };
    const events = emitter => ({ on: (name, callback, context) => subscribe(emitter, name, callback, context), off: (name, callback) => { for (const ref of emitter.listeners.get(name) || []) if (ref.originalCallback === callback) ref.off(); }, offref: ref => emitter.offref(ref) });
    const vault = strictApi('app.vault', {
      ...events(vaultEvents),
      getName: () => basename(vaultIdentity.replace(/\\/g, '/')),
      getRoot: () => { ensureActive(); index(); return root; },
      getFiles: () => { ensureActive(); return [...index()].filter(([, value]) => !value.isDirectory).map(([p]) => objects.get(p)); },
      getMarkdownFiles: () => vault.getFiles().filter(file => file.extension.toLowerCase() === 'md'),
      getAllLoadedFiles: () => { ensureActive(); return [...index().keys()].map(p => objects.get(p)); },
      getAbstractFileByPath: filePath => { ensureActive(); return fileAt(filePath); },
      getFileByPath: filePath => { const file = vault.getAbstractFileByPath(filePath); return file instanceof TFile ? file : null; },
      getFolderByPath: filePath => { const file = vault.getAbstractFileByPath(filePath); return file instanceof TFolder ? file : null; },
      read: async file => { ensureActive(); const result = await needBridge('read')(filePathOf(file)); ensureActive(); return typeof result === 'string' ? result : result.content; },
      cachedRead: async file => { ensureActive(); const p = filePathOf(file), value = currentRecords().get(p)?.content; return typeof value === 'string' ? value : vault.read(file); },
      create: async (filePath, data, options) => { ensureActive(); assertWriteOptions(options); return mutateRecord(safePath(filePath), data, true, ensureActive); },
      createFolder: async filePath => { ensureActive(); const p = safePath(filePath), before = new Map(index()); await needBridge('mkdir')(p); const after = new Map(before); after.set(p, { path: p, isDirectory: true }); for (let parent = dirname(p); parent; parent = dirname(parent)) if (!after.has(parent)) after.set(parent, { path: parent, isDirectory: true }); applyChanges(before, after); return objects.get(p); },
      modify: async (file, data, options) => { ensureActive(); assertWriteOptions(options); await mutateRecord(filePathOf(file), data, false, ensureActive); },
      process: (file, callback) => {
        ensureActive(); const p = filePathOf(file);
        if (typeof callback !== 'function') throw new TypeError('process requires a synchronous callback');
        return queueProcess(p, async () => { ensureActive(); const read = await needBridge('read')(p); ensureActive(); const original = typeof read === 'string' ? read : read.content; const value = callback(original); if (value?.then) Promise.resolve(value).catch(() => {}); assertText(value, 'process callback result'); const before = new Map(index()); const result = await needBridge('write')(p, value, read?.mtime, read?.version); ensureActive(); const after = new Map(before); after.set(p, { ...before.get(p), path: p, content: value, mtime: result?.mtime || Date.now() }); applyChanges(before, after); return value; });
      },
      append: async (file, data) => { assertText(data, 'Appended data'); await vault.process(file, previous => previous + data); },
      readBinary: async file => { ensureActive(); return (await binaryRead(filePathOf(file), ensureActive)).bytes; },
      createBinary: async (filePath, data, options) => { ensureActive(); assertWriteOptions(options); return binaryWrite(safePath(filePath), data, true, ensureActive); },
      modifyBinary: async (file, data, options) => { ensureActive(); assertWriteOptions(options); await binaryWrite(filePathOf(file), data, false, ensureActive); },
      appendBinary: (file, data, options) => {
        ensureActive(); assertWriteOptions(options); const p = filePathOf(file), suffix = new Uint8Array(toArrayBuffer(data));
        return queueProcess(p, async () => { ensureActive(); const read = await binaryRead(p, ensureActive), original = new Uint8Array(read.bytes), combined = new Uint8Array(original.length + suffix.length); combined.set(original); combined.set(suffix, original.length); await binaryWrite(p, combined, false, ensureActive, read); });
      },
      copy: async (file, next) => { ensureActive(); const source = await binaryRead(filePathOf(file), ensureActive); return binaryWrite(safePath(next), source.bytes, true, ensureActive); },
      rename: async (file, next) => { ensureActive(); await renameFile(file, next, false); },
      trash: async (file, system = false) => { ensureActive(); if (system) unsupported('app.vault.trash(system=true)', 'Only the application recycle bin is supported.'); const p = filePathOf(file, true), before = new Map(index()); await needBridge('trash')(p); const after = new Map([...before].filter(([name]) => name !== p && !name.startsWith(p + '/'))); applyChanges(before, after); },
      delete: () => unsupported('app.vault.delete', 'Permanent deletion is unavailable. Use app.vault.trash(file, false).'),
      adapter: strictApi('app.vault.adapter', {
        exists: async p => !!vault.getAbstractFileByPath(p),
        read: async p => { const file = vault.getFileByPath(p); if (!file) throw new Error('File not found: ' + p); return vault.read(file); },
        readBinary: async p => { const file = vault.getFileByPath(p); if (!file) throw new Error('File not found: ' + p); return vault.readBinary(file); },
        write: async (p, data, options) => { const file = vault.getFileByPath(p); return file ? vault.modify(file, data, options) : vault.create(p, data, options); },
        writeBinary: async (p, data, options) => { const file = vault.getFileByPath(p); return file ? vault.modifyBinary(file, data, options) : vault.createBinary(p, data, options); },
        append: async (p, data) => { const file = vault.getFileByPath(p); if (!file) throw new Error('File not found: ' + p); return vault.append(file, data); },
        appendBinary: async (p, data) => { const file = vault.getFileByPath(p); if (!file) throw new Error('File not found: ' + p); return vault.appendBinary(file, data); },
        mkdir: async p => vault.createFolder(p),
      }),
    });
    const metadataCache = strictApi('app.metadataCache', { ...events(metadataEvents),
      getFileCache: file => { ensureActive(); return cacheFor(filePathOf(file)); }, getCache: p => { ensureActive(); return cacheFor(safePath(p)); },
      getFirstLinkpathDest: (link, sourcePath) => { ensureActive(); const p = resolveLink(link, sourcePath || '', vault.getFiles().map(file => file.path)); return p ? fileAt(p) : null; },
      fileToLinktext: (file, _sourcePath, omitMdExtension = true) => { const p = filePathOf(file); return omitMdExtension ? p.replace(/\.md$/i, '') : p; },
      get resolvedLinks() { ensureActive(); return linkCounts(false); }, get unresolvedLinks() { ensureActive(); return linkCounts(true); },
    });
    let app;
    class Modal {
      constructor(value = app) {
        this.app = value; this.opened = false;
        this.containerEl = createElement('div'); this.containerEl.className = 'modal-scrim vaultdesk-plugin-modal';
        Object.assign(this.containerEl.style, { position: 'fixed', inset: '0', zIndex: '1000', background: '#0008', display: 'grid', placeItems: 'center' });
        this.modalEl = this.containerEl.createEl('section', { cls: 'dialog', attr: { role: 'dialog', 'aria-modal': 'true' } });
        Object.assign(this.modalEl.style, { minWidth: '280px', maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', padding: '20px', background: 'var(--background-primary, #25252a)', color: 'inherit' });
        this.titleEl = this.modalEl.createEl('h2'); this.contentEl = this.modalEl.createDiv('modal-content');
        this.closeButtonEl = this.modalEl.createEl('button', { text: '关闭', attr: { type: 'button', 'aria-label': '关闭插件窗口' } });
        this.closeButtonEl.addEventListener('click', () => this.close());
        this._escape = event => { if (event.key === 'Escape') { event.stopPropagation?.(); this.close(); } };
        track(() => this.close());
      }
      setTitle(value) { this.titleEl.setText(value); return this; }
      open() { ensureActive(); if (this.opened) return; this.opened = true; document.body.appendChild(this.containerEl); document.addEventListener('keydown', this._escape); try { this.onOpen?.(); } catch (error) { this.close(); throw error; } }
      close() { if (!this.opened) return; this.opened = false; document.removeEventListener('keydown', this._escape); this.containerEl.remove(); this.onClose?.(); }
      onOpen() {} onClose() {}
    }
    class Notice {
      constructor(message, _timeout) { this.message = message; notice(message?.textContent || String(message ?? '')); }
      setMessage(message) { this.message = message; notice(message?.textContent || String(message ?? '')); return this; }
      hide() { notice(''); }
    }
    class PluginSettingTab {
      constructor(value = app, plugin) { this.app = value; this.plugin = plugin; this.containerEl = createElement('div'); }
      display() {} hide() { this.containerEl.empty(); }
    }
    const workspaceListeners = events(workspaceEvents);
    let views;
    views = viewRuntime.forPlugin({ record, ensureActive, track, getApp: () => app, metadataCache, events: {
      ...workspaceListeners,
      on(name, callback, context) {
        if (name !== 'editor-change' && name !== 'active-leaf-change') return workspaceListeners.on(name, callback, context);
        const ref = subscribe(workspaceEvents, name, value => {
          if (name === 'active-leaf-change') return callback.call(context, views.workspace.activeLeaf);
          const editorContext = views.editorContext(value?.leafId, value?.path);
          if (editorContext) return callback.call(context, editorContext.editor, editorContext.view);
        });
        ref.originalCallback = callback; return ref;
      },
      onLayoutReady: callback => { ensureActive(); let live = true; const off = track(() => { live = false; }); queueMicrotask(() => { if (live && !record.cancelled && !disposed) try { Promise.resolve(callback()).catch(report); } catch (error) { report(error); } }); return { off }; },
    } });
    const { workspace, View, ItemView, MarkdownView, WorkspaceLeaf, Editor } = views;
    const markdown = markdownRuntime.forPlugin({ record, ensureActive, track });
    class MarkdownRenderer {
      static async render(value, source, element, sourcePath = '', component) {
        ensureActive();
        if (value !== app) throw new TypeError('MarkdownRenderer requires this plugin app');
        if (!element?.replaceChildren || !component?.register) throw new TypeError('MarkdownRenderer requires a DOM container and a Component');
        assertText(source, 'Markdown source');
        let closed = false, cleanup;
        const stop = once(async () => { closed = true; await cleanup?.(); });
        track(stop); component.register(stop);
        try {
          if (markdownRenderer) await markdownRenderer(source, element, sourcePath);
          else {
            const renderer = await import('./markdown.js');
            ensureActive(); if (closed) return;
            element.innerHTML = renderer.renderMarkdown(source, { path: sourcePath, files: Object.fromEntries(currentRecords()) });
            await renderer.hydrateMarkdown(element, { resolveAsset: bridge.assetUrl ? path => bridge.assetUrl(path) : undefined });
          }
          ensureActive(); if (closed) return;
          cleanup = await markdownRuntime.process(element, { path: sourcePath, text: source, virtual: true });
          if (closed || record.cancelled || disposed) await cleanup();
        } catch (error) { await stop(); throw error; }
      }
      static renderMarkdown(source, element, sourcePath, component) { return this.render(app, source, element, sourcePath, component); }
    }
    function requestUrl(input) {
      ensureActive();
      const options = typeof input === 'string' ? { url: input } : { ...input };
      if (typeof options.url !== 'string') throw new TypeError('requestUrl requires a URL');
      const params = { url: options.url, method: options.method, headers: options.headers, contentType: options.contentType };
      if (options.body != null) {
        if (typeof options.body === 'string') { params.body = options.body; params.bodyEncoding = 'utf8'; }
        else { params.body = encodeBinary(options.body); params.bodyEncoding = 'base64'; }
      }
      const response = Promise.resolve().then(() => { ensureActive(); return needBridge('requestUrl')(params); }).then(result => {
        ensureActive();
        if (options.throw !== false && result.status >= 400) { const error = new Error(`Request failed, status ${result.status}`); error.status = result.status; throw error; }
        const arrayBuffer = decodeBinary(result.bodyBase64);
        return { status: result.status, headers: result.headers, arrayBuffer, text: result.text, get json() { return JSON.parse(result.text); } };
      });
      for (const key of ['arrayBuffer', 'text', 'json']) Object.defineProperty(response, key, { get: () => response.then(result => result[key]) });
      return response;
    }
    app = strictApi('app', { vault, workspace, metadataCache,
      fileManager: strictApi('app.fileManager', {
        renameFile: async (file, next) => { ensureActive(); await renameFile(file, next, true); },
        processFrontMatter: async (file, callback, options) => { ensureActive(); assertWriteOptions(options); await vault.process(file, source => transformFrontmatter(source, callback)); },
      }),
      commands: strictApi('app.commands', { executeCommandById: id => { ensureActive(); const command = commands.get(id); if (!command) return false; command.callback(); return true; } }),
    });
    class Plugin extends Component {
      constructor(value = app, manifest = record.manifest) { super(); this.app = value; this.manifest = manifest; record.instances.add(this); }
      addCommand(command) {
        ensureActive();
        if (typeof addCommand !== 'function' || typeof removeCommand !== 'function') unsupported('Plugin.addCommand', 'Both addCommand and removeCommand host callbacks are required.');
        if (!command || typeof command.id !== 'string' || !command.id.trim()) throw new TypeError('Command id is required');
        if (![command.callback, command.checkCallback, command.editorCallback, command.editorCheckCallback].some(value => typeof value === 'function')) throw new TypeError('Command needs a callback');
        const id = `${record.manifest.id}:${command.id}`;
        if (commands.has(id)) throw new Error('Command already registered: ' + id);
        const { callback, checkCallback, editorCallback, editorCheckCallback } = command;
        const invoke = checking => {
          if (record.state !== 'enabled' || record.cancelled || disposed) return false;
          if (typeof checkCallback === 'function') return checkCallback(checking);
          if (typeof editorCheckCallback === 'function' || typeof editorCallback === 'function') {
            const context = views.activeEditorContext(); if (!context) return false;
            if (typeof editorCheckCallback === 'function') return editorCheckCallback(checking, context.editor, context.view);
            if (!checking) editorCallback(context.editor, context.view); return true;
          }
          if (!checking) return callback(); return true;
        };
        command.id = id; command.name = `${record.manifest.name}: ${command.name || id.slice(record.manifest.id.length + 1)}`;
        command.callback = () => { try { return Promise.resolve(invoke(false)).catch(report); } catch (error) { report(error); } };
        if (checkCallback || editorCallback || editorCheckCallback) command.checkCallback = checking => { try { return invoke(checking); } catch (error) { report(error); return false; } };
        commands.set(id, command);
        const cleanup = once(() => { commands.delete(id); removeCommand(id); }); track(cleanup); this.register(cleanup);
        try { addCommand(command); } catch (error) { cleanup(); throw error; }
        return command;
      }
      addSettingTab(tab) {
        ensureActive(); if (!(tab instanceof PluginSettingTab)) throw new TypeError('Expected PluginSettingTab');
        let modal;
        this.addCommand({ id: 'settings', name: `${record.manifest.name}：设置`, callback: () => { modal?.close(); modal = new Modal(app); modal.setTitle(record.manifest.name); modal.contentEl.appendChild(tab.containerEl); modal.onOpen = () => tab.display(); modal.onClose = () => tab.hide(); modal.open(); } });
        this.register(() => { modal?.close(); tab.containerEl.remove(); });
      }
      async loadData() { if (record.state === 'disabled') throw new Error('Plugin has been unloaded'); const key = `vaultdesk:plugin-data:${encodeURIComponent(record.vaultIdentity)}:${record.manifest.id}`; const raw = globalThis.localStorage?.getItem(key) ?? memoryData.get(key); return raw ? JSON.parse(raw) : null; }
      async saveData(value) { if (record.state === 'disabled') throw new Error('Plugin has been unloaded'); const key = `vaultdesk:plugin-data:${encodeURIComponent(record.vaultIdentity)}:${record.manifest.id}`; const raw = JSON.stringify(value); if (raw === undefined) throw new TypeError('Plugin data must be JSON serializable'); if (globalThis.localStorage) localStorage.setItem(key, raw); else memoryData.set(key, raw); }
      registerView(type, creator) { return views.registerView(type, creator); }
      registerMarkdownPostProcessor(callback, sortOrder) { return markdown.registerMarkdownPostProcessor(callback, sortOrder); }
      registerMarkdownCodeBlockProcessor(language, callback, sortOrder) { return markdown.registerMarkdownCodeBlockProcessor(language, callback, sortOrder); }
      registerEditorExtension() { return unsupported('Plugin.registerEditorExtension'); }
      addRibbonIcon(icon, title, callback) {
        ensureActive(); if (!surfaces.has('ribbon')) unsupported('Plugin.addRibbonIcon', 'The application has not mounted a plugin ribbon.');
        if (typeof callback !== 'function') throw new TypeError('Ribbon callback must be a function');
        const element = createElement('button'); element.className = 'plugin-ribbon-action'; element.type = 'button'; element.setAttribute('title', title); element.setAttribute('aria-label', title); element.setAttribute('data-icon', icon); setPluginIcon(element, icon); if (!element.children.length) element.setText(String(title || icon || '?').slice(0, 1));
        this.registerDomEvent(element, 'click', event => { if (record.state === 'enabled' && !record.cancelled && !disposed) try { Promise.resolve(callback(event)).catch(report); } catch (error) { report(error); } });
        const id = `${record.manifest.id}:ribbon:${++uiRevision}`; ribbon.set(id, { id, element }); mountSurface('ribbon', element); publishUI();
        const cleanup = track(() => { ribbon.delete(id); element.remove(); publishUI(); }); this.register(cleanup); return element;
      }
      addStatusBarItem() {
        ensureActive(); if (!surfaces.has('statusBar')) unsupported('Plugin.addStatusBarItem', 'The application has not mounted a plugin status bar.');
        const element = createElement('div'); element.className = 'status-bar-item plugin-status-bar-item';
        const id = `${record.manifest.id}:status:${++uiRevision}`; statusBar.set(id, { id, element }); mountSurface('statusBar', element); publishUI();
        const cleanup = track(() => { statusBar.delete(id); element.remove(); publishUI(); }); this.register(cleanup); return element;
      }
    }
    const userAgent = globalThis.navigator?.userAgent || '';
    const Platform = Object.freeze({ isDesktopApp: !!globalThis.window?.vaultdesk, isMobileApp: false, isDesktop: true, isMobile: false, isPhone: false, isTablet: false, isWin: /Windows/i.test(userAgent), isMacOS: /Macintosh/i.test(userAgent), isLinux: /Linux/i.test(userAgent), isAndroid: false, isIos: false, isSafari: /Safari/.test(userAgent) && !/Chrome|Chromium/.test(userAgent) });
    const api = strictApi('obsidian', { Plugin, PluginSettingTab, Setting, Modal, Notice, View, ItemView, WorkspaceLeaf, Editor, TFile, TFolder, Component, MarkdownView, MarkdownRenderChild: markdown.MarkdownRenderChild, MarkdownRenderer, Platform, apiVersion: '0.0.0', requestUrl, request: async input => (await requestUrl(input)).text,
      getIcon: id => { ensureActive(); return getPluginIcon(id); }, setIcon: (element, id) => { ensureActive(); setPluginIcon(element, id); },
      normalizePath: value => { const normalized = normalizeCorePath(assertText(value, 'Path')); if (normalized == null) throw new Error('Path escapes the vault'); return normalized; },
    });
    return { app, api, require: name => { if (name !== 'obsidian') unsupported(`require(${JSON.stringify(name)})`, 'Only require("obsidian") is supported. Node/Electron and additional packages are not available.'); return api; } };
  }

  async function cleanup(record) {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      record.state = 'disabling';
      const errors = [], pending = [];
      const attempt = callback => { try { pending.push(Promise.resolve(callback()).catch(error => { errors.push(error); })); } catch (error) { errors.push(error); } };
      for (const instance of record.instances) attempt(() => instance.unload());
      for (const dispose of record.cleanups.reverse()) attempt(dispose);
      await Promise.all(pending);
      record.cleanups.length = 0; record.state = 'disabled';
      if (record.loadSettled && records.get(record.manifest.id) === record) records.delete(record.manifest.id);
      if (errors.length) throw new AggregateError(errors, `Plugin ${record.manifest.id} cleanup failed`);
    })(); return record.cleanupPromise;
  }
  function enable(pluginDescriptor, source) {
    if (disposed) return Promise.reject(new Error('Extension host has been disposed'));
    const manifest = { ...pluginDescriptor };
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(manifest.id || '')) return Promise.reject(new TypeError('Plugin manifest needs a safe id'));
    manifest.name ||= manifest.id; manifest.version ||= '0.0.0';
    if (records.has(manifest.id)) return Promise.reject(new Error(`Plugin ${manifest.id} is already enabled or loading`));
    assertText(source, 'Plugin source');
    const record = { manifest: Object.freeze(manifest), state: 'loading', cleanups: [], plugin: null, instances: new Set(), cancelled: false, ready: null, loadSettled: false };
    records.set(manifest.id, record);
    record.ready = (async () => {
      let contextKey;
      try {
        if (typeof bridge.snapshot === 'function') { const snapshot = await bridge.snapshot(); vaultIdentity = String(snapshot.vaultPath || vaultIdentity); }
        record.vaultIdentity = vaultIdentity;
        if (record.cancelled || disposed) throw new Error(`Plugin ${manifest.id} enable was cancelled`);
        const context = createPluginApi(record);
        contextKey = `__vaultdesk_plugin_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') || Math.random().toString(36).slice(2)}`;
        Object.defineProperty(globalThis, contextKey, { value: context, configurable: true });
        const code = `const context = globalThis[${JSON.stringify(contextKey)}];\nconst module = { exports: {} };\n(function(require, module, exports) {\n${source}\n})(context.require, module, module.exports);\nexport default module.exports;\n`;
        let imported;
        try { imported = await moduleLoader(code); }
        catch (error) { if (error instanceof PluginCompatibilityError) throw error; throw new Error(`Plugin ${manifest.id} could not load: ${error.message}. Renderer CSP must allow script-src 'self' blob:; unsafe-eval is not required.`, { cause: error }); }
        const Exported = imported.default?.default || imported.default;
        if (typeof Exported !== 'function') throw new TypeError('Plugin main.js must export a class extending require("obsidian").Plugin');
        if (record.cancelled || disposed) throw new Error(`Plugin ${manifest.id} enable was cancelled`);
        record.plugin = new Exported(context.app, record.manifest);
        if (!(record.plugin instanceof context.api.Plugin)) throw new TypeError('Plugin must extend the supported Plugin class');
        if (record.cancelled || disposed) throw new Error(`Plugin ${manifest.id} enable was cancelled`);
        await record.plugin.load();
        if (record.cancelled || disposed) throw new Error(`Plugin ${manifest.id} enable was cancelled`);
        record.state = 'enabled';
        return { ...record.manifest, state: record.state };
      } catch (error) { try { await cleanup(record); } catch (cleanupError) { report(cleanupError); } throw error; }
      finally { record.loadSettled = true; if (record.state === 'disabled' && records.get(manifest.id) === record) records.delete(manifest.id); if (contextKey) delete globalThis[contextKey]; }
    })();
    return record.ready;
  }
  async function disable(id) {
    const record = records.get(id); if (!record) return false;
    record.cancelled = true;
    // Observe both promises immediately: failed cleanup during a pending onload
    // must not become an unhandled rejection while we wait for that onload.
    const results = await Promise.allSettled([record.ready, cleanup(record)]);
    if (results[1].status === 'rejected') throw results[1].reason;
    return true;
  }
  function dispose() {
    if (disposePromise) return disposePromise; disposed = true;
    disposePromise = (async () => {
      const results = await Promise.allSettled([...records.keys()].map(disable));
      if (typeof bridgeUnsubscribe === 'function') bridgeUnsubscribe(); if (typeof externalUnsubscribe === 'function') externalUnsubscribe();
      vaultEvents.clear(); workspaceEvents.clear(); metadataEvents.clear();
      await Promise.allSettled([viewRuntime.dispose(), markdownRuntime.dispose()]);
      ribbon.clear(); statusBar.clear(); surfaces.clear(); publishUI(); uiListeners.clear();
      for (const result of results) if (result.status === 'rejected') report(result.reason);
    })();
    return disposePromise;
  }
  return {
    enable, disable, list: () => [...records.values()].map(record => ({ ...record.manifest, state: record.state })), dispose,
    getUI: () => uiSnapshot,
    subscribeUI: listener => { uiListeners.add(listener); return () => uiListeners.delete(listener); },
    getViewElement: id => viewRuntime.getViewElement(id),
    syncWorkspace: options => viewRuntime.syncWorkspace(options),
    captureViewStates: () => viewRuntime.captureViewStates(),
    processMarkdown: (container, options) => disposed ? Promise.resolve(() => {}) : markdownRuntime.process(container, options),
    attachSurface: (name, element) => {
      if (!['ribbon', 'statusBar'].includes(name)) throw new TypeError('Unknown plugin surface');
      const set = surfaces.get(name) || new Set(), token = element || {}; set.add(token); surfaces.set(name, set);
      const items = name === 'ribbon' ? ribbon : statusBar;
      if (element) for (const item of items.values()) element.appendChild(item.element);
      return once(() => { set.delete(token); if (!set.size) surfaces.delete(name); if (element) for (const item of items.values()) if (item.element.parentNode === element) { item.element.remove(); mountSurface(name, item.element); } });
    },
  };
}

export class Setting {
  constructor(container) {
    this.settingEl = decorate(container).createDiv('setting-item'); this.infoEl = this.settingEl.createDiv('setting-item-info'); this.nameEl = this.infoEl.createDiv('setting-item-name'); this.descEl = this.infoEl.createDiv('setting-item-description'); this.controlEl = this.settingEl.createDiv('setting-item-control'); this.components = [];
  }
  setName(value) { this.nameEl.setText(value); return this; } setDesc(value) { this.descEl.setText(value?.textContent || value); return this; }
  setHeading() { this.settingEl.addClass('setting-item-heading'); return this; } setClass(value) { this.settingEl.addClass(value); return this; }
  setDisabled(value) { this.components.forEach(component => component.setDisabled(value)); return this; }
  then(callback) { callback(this); return this; }
  addText(callback) { return this._add('input', 'text', callback); } addTextArea(callback) { return this._add('textarea', null, callback); }
  addToggle(callback) { return this._add('input', 'checkbox', callback); } addDropdown(callback) { return this._add('select', null, callback); }
  addButton(callback) { return this._add('button', 'button', callback); } addSlider(callback) { return this._add('input', 'range', callback); }
  _add(tag, type, callback) {
    const input = this.controlEl.createEl(tag); if (type) input.type = type;
    const component = strictApi('Setting component', {
      inputEl: input, buttonEl: input, selectEl: input, toggleEl: input, sliderEl: input,
      setValue: value => { type === 'checkbox' ? input.checked = !!value : input.value = String(value ?? ''); return component; },
      getValue: () => type === 'checkbox' ? !!input.checked : type === 'range' ? Number(input.value) : input.value,
      setDisabled: value => { input.disabled = !!value; return component; }, setPlaceholder: value => { input.placeholder = String(value); return component; },
      setButtonText: value => { input.setText(value); return component; }, setTooltip: value => { input.title = String(value); return component; },
      setCta: () => { input.addClass('mod-cta'); return component; }, setWarning: () => { input.addClass('mod-warning'); return component; },
      setLimits: (min, max, step) => { input.min = String(min); input.max = String(max); input.step = String(step); return component; },
      addOption: (value, label) => { input.createEl('option', { text: label, attr: { value } }); return component; },
      addOptions: values => { for (const [value, label] of Object.entries(values)) component.addOption(value, label); return component; },
      onChange: listener => { input.addEventListener(tag === 'select' || type === 'checkbox' ? 'change' : 'input', () => listener(component.getValue())); return component; },
      onClick: listener => { input.addEventListener('click', listener); return component; },
    });
    this.components.push(component); callback(component); return this;
  }
}
