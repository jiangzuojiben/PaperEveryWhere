import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeVaultPath } from './vault-store.mjs';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const active = new WeakSet();
const controllers = new WeakMap();
const isMissing = (error) => error.code === 'ENOENT';

const pausedError = () => Object.assign(new Error('Sync is paused. Completed files remain saved; resume to continue.'), { code: 'SYNC_PAUSED' });
const checkpoint = signal => { if (signal?.aborted) throw pausedError(); };
const safeCallback = (callback, value) => { try { callback?.(value); } catch { /* UI observers cannot interrupt file persistence. */ } };
const boundedDelay = (value, fallback, minimum, maximum) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.max(minimum, Math.min(maximum, Number(value))) : fallback;

async function awaitBeforeSync(callback, signal) {
  if (!callback) return;
  checkpoint(signal);
  let abort;
  const cancellation = new Promise((_, reject) => {
    abort = () => reject(pausedError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => callback({ signal })), cancellation]);
    checkpoint(signal);
    if (result === false) throw new Error('An editor could not save its pending changes.');
  } catch (error) {
    checkpoint(signal);
    if (error.code === 'SYNC_PAUSED') throw error;
    const blocked = new Error(`Sync is waiting for editors to save: ${error.message || 'save acknowledgement was not received'}`);
    blocked.code = 'SYNC_BLOCKED';
    throw blocked;
  } finally { signal.removeEventListener('abort', abort); }
}

/** Local content selection. Exclusion never requests remote deletion. */
export function normalizeSyncOptions(config = {}) {
  if (config.syncSettings) throw new Error('Settings sync is not enabled. Workspace credentials, plugins and machine-specific paths remain local.');
  const folders = config.excludeFolders ?? [];
  if (!Array.isArray(folders) || folders.some(value => typeof value !== 'string')) throw new Error('excludeFolders must be an array of vault-relative folder paths');
  const excludeFolders = [...new Set(folders.map(value => normalizeVaultPath(value.replace(/\/+$/, '')).toLowerCase()))].sort();
  const requested = config.attachmentTypes ?? 'all';
  let attachmentTypes;
  if (requested === 'all' || requested === 'none') attachmentTypes = requested;
  else if (Array.isArray(requested) && requested.every(value => typeof value === 'string' && /^\.?[a-z0-9][a-z0-9_-]*$/i.test(value))) attachmentTypes = [...new Set(requested.map(value => value.replace(/^\./, '').toLowerCase()))].sort();
  else throw new Error('attachmentTypes must be all, none, or an array of file extensions');
  return { excludeFolders, attachmentTypes };
}

export function isSyncPathIncluded(filePath, options = {}) {
  const normalized = normalizeVaultPath(filePath).toLowerCase();
  const rules = normalizeSyncOptions(options);
  if (rules.excludeFolders.some(folder => normalized === folder || normalized.startsWith(folder + '/'))) return false;
  const extension = path.posix.extname(normalized).slice(1);
  if (['md', 'canvas', 'base'].includes(extension)) return true;
  return rules.attachmentTypes === 'all' || (Array.isArray(rules.attachmentTypes) && rules.attachmentTypes.includes(extension));
}

export async function cloudRequest(config, apiPath, options = {}) {
  if (!config || typeof config.baseUrl !== 'string') throw new Error('Enter your self-hosted service URL');
  const base = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid self-hosted service URL');
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/') || apiPath.startsWith('//') || /[\\\r\n]/.test(apiPath) || apiPath.split('/').includes('..')) throw new Error('Invalid service API path');
  const url = new URL(`${base.href.replace(/\/$/, '')}${apiPath}`);
  if (url.origin !== base.origin) throw new Error('Service request must stay on the configured origin');
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) throw new Error('Unsupported service request method');
  const headers = { Accept: 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  checkpoint(options.signal);
  const timeout = AbortSignal.timeout(45000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response;
  try { response = await fetch(url, { method, headers, body, redirect: 'error', signal }); }
  catch (error) {
    checkpoint(options.signal);
    if (error.cause?.message === 'bad port') {
      throw Object.assign(new Error('This service port is blocked by the HTTP client. Configure a different server port, such as 8766.'), { code: 'SYNC_UNSAFE_PORT' });
    }
    throw error;
  }
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : null; } catch { result = { message: text.slice(0, 400) }; }
  if (!response.ok) {
    const detail = result?.detail;
    const message = detail?.code === 'path_collision' ? `A conflicting file or folder already exists on the server${detail.path ? `: ${detail.path}` : ''}` : detail?.message || detail?.code;
    const error = new Error(typeof detail === 'string' ? detail : message || result?.message || `Service request failed (${response.status})`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return result;
}

async function readLocal(store, filePath) {
  try {
    const { data, mtime } = await store.readBytes(filePath);
    return { data, mtime, hash: digest(data) };
  } catch (error) { if (isMissing(error)) return null; throw error; }
}

async function conflictCopy(store, filePath, data, revision) {
  const extension = path.posix.extname(filePath);
  const parent = path.posix.dirname(filePath);
  let stem = path.posix.basename(filePath, extension);
  while (Buffer.byteLength(stem, 'utf8') > 150) stem = [...stem].slice(0, -1).join('');
  const suffix = `conflict r${revision}-${digest(data).slice(0, 16)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = `${stem} (${suffix}${attempt ? '-' + attempt : ''})${extension}`;
    const conflictPath = parent === '.' ? name : `${parent}/${name}`;
    const existing = await readLocal(store, conflictPath);
    if (existing?.hash === digest(data)) return conflictPath;
    if (existing) continue;
    try { await store.createBytes(conflictPath, data); return conflictPath; }
    catch (error) {
      const raced = await readLocal(store, conflictPath);
      if (raced?.hash === digest(data)) return conflictPath;
      if (!raced) throw error;
    }
  }
  throw new Error('Could not reserve a conflict-copy filename; local content was preserved.');
}

export async function syncVault(store, config, { onProgress, signal } = {}) {
  if (active.has(store)) throw new Error('This vault is already syncing');
  if (!config?.token || !config?.vaultId || !config?.baseUrl) throw new Error('Sign in and select a remote vault before syncing');
  if (config.paused) throw pausedError();
  checkpoint(signal);
  const rules = normalizeSyncOptions(config);
  const ruleFingerprint = digest(JSON.stringify(rules));
  const included = name => isSyncPathIncluded(name, rules);
  active.add(store);
  const prefix = `/vaults/${encodeURIComponent(config.vaultId)}`;
  const stateName = `sync-${digest(`${config.baseUrl.replace(/\/$/, '')}|${config.vaultId}`).slice(0, 24)}`;
  const stats = { uploaded: 0, downloaded: 0, deleted: 0, skipped: 0, conflicts: [], cursor: 0 };
  const skipped = new Set();
  const progress = (phase, extra = {}) => safeCallback(onProgress, { phase, uploaded: stats.uploaded, downloaded: stats.downloaded, deleted: stats.deleted, skipped: skipped.size, conflicts: stats.conflicts.length, cursor: stats.cursor, ...extra });
  const skip = name => { skipped.add(name); stats.skipped = skipped.size; };
  const request = (endpoint, options = {}) => cloudRequest(config, endpoint, { ...options, signal });
  try {
    progress('connecting');
    const state = await store.loadState(stateName, { version: 2, cursor: 0, entries: {} });
    if (!state.entries || typeof state.entries !== 'object') throw new Error('Invalid local sync state');
    state.entries = Object.assign(Object.create(null), state.entries);
    state.version = 2;
    if (state.ruleFingerprint !== ruleFingerprint) state.cursor = 0;
    state.ruleFingerprint = ruleFingerprint;
    for (const [filePath, entry] of Object.entries(state.entries)) {
      normalizeVaultPath(filePath);
      if (!included(filePath)) { entry.excluded = true; skip(filePath); }
    }
    // Persist an exclusion before networking: a failure or app restart must not
    // later interpret a removed local cache as a deliberate remote deletion.
    await store.saveState(stateName, state);
    for (let round = 0; round < 4; round++) {
      checkpoint(signal);
      const changes = new Map();
      let cursor = state.cursor || 0;
      const startCursor = cursor;
      let more = true;
      let pages = 0;
      while (more) {
        checkpoint(signal);
        if (++pages > 10000) throw new Error('Remote change log is too large for a single sync');
        progress('pulling', { page: pages, received: changes.size });
        checkpoint(signal);
        const page = await request(`${prefix}/changes?cursor=${cursor}`);
        if (!Array.isArray(page?.changes) || !Number.isSafeInteger(page.cursor) || page.cursor < cursor) throw new Error('Invalid remote change response');
        let previousRevision = cursor;
        for (const change of page.changes) {
          if (normalizeVaultPath(change.path) !== change.path) throw new Error('Remote paths must use canonical forward slashes');
          if (!Number.isSafeInteger(change.revision) || change.revision <= previousRevision || change.revision > page.cursor) throw new Error('Invalid remote revision order');
          if (typeof change.deleted !== 'boolean') throw new Error('Invalid remote deletion marker');
          previousRevision = change.revision;
          changes.set(change.path, change);
        }
        if (page.changes.length && previousRevision !== page.cursor || !page.changes.length && page.cursor !== cursor) throw new Error('Remote cursor does not match its event page');
        if (page.has_more && page.cursor === cursor) throw new Error('Remote change cursor did not advance');
        cursor = page.cursor;
        more = Boolean(page.has_more);
      }
      let applied = 0;
      for (const [filePath, remote] of changes) {
        checkpoint(signal);
        progress('applying', { path: filePath, completed: applied, total: changes.size });
        checkpoint(signal);
        const baseline = state.entries[filePath];
        if (!included(filePath)) {
          state.entries[filePath] = { ...(baseline || { revision: 0, hash: null, deleted: true }), excluded: true };
          skip(filePath); applied++; continue;
        }
        const rejoining = Boolean(baseline?.excluded);
        if (baseline && !rejoining && remote.revision <= baseline.revision) { applied++; continue; }
        const local = await readLocal(store, filePath);
        if (remote.deleted) {
          if (baseline?.deleted) {
            state.entries[filePath] = { ...baseline, revision: remote.revision, excluded: false };
            await store.saveState(stateName, state);
            applied++;
            continue;
          }
          if (local) {
            if (!baseline || baseline.deleted || local.hash !== baseline.hash) stats.conflicts.push(await conflictCopy(store, filePath, local.data, remote.revision));
            // Recheck to avoid removing an edit made while preparing a conflict copy.
            await store.assertMtime(filePath, local.mtime);
            await store.trash(filePath, local.mtime);
            stats.deleted++;
          }
          state.entries[filePath] = { revision: remote.revision, hash: null, deleted: true };
          await store.saveState(stateName, state);
          applied++;
          continue;
        }
        if (!['utf8', 'base64'].includes(remote.encoding || 'utf8') || typeof remote.content !== 'string') throw new Error('Invalid remote content');
        if (remote.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(remote.content)) throw new Error('Invalid remote base64 attachment');
        const bytes = Buffer.from(remote.content, remote.encoding === 'base64' ? 'base64' : 'utf8');
        const remoteHash = digest(bytes);
        if (baseline && !baseline.deleted && baseline.hash === remoteHash && (!rejoining || local)) {
          state.entries[filePath] = { ...baseline, revision: remote.revision, excluded: false };
          await store.saveState(stateName, state);
          applied++;
          continue;
        }
        // A local deletion and a remote edit conflict. Retain the remote bytes as a new note,
        // then propagate the local deletion on the original path during the upload phase.
        if (!local && baseline && !baseline.deleted && !rejoining && baseline.hash !== remoteHash) {
          stats.conflicts.push(await conflictCopy(store, filePath, bytes, remote.revision));
        } else if (!local && baseline && !baseline.deleted && !rejoining && baseline.hash === remoteHash) {
          // An acknowledged local deletion takes precedence over an unchanged remote file.
        } else if (local?.hash !== remoteHash) {
          if (local && (!baseline || baseline.deleted || local.hash !== baseline.hash)) stats.conflicts.push(await conflictCopy(store, filePath, local.data, remote.revision));
          if (local) await store.writeBytes(filePath, bytes, local.mtime);
          else await store.createBytes(filePath, bytes);
          stats.downloaded++;
        }
        state.entries[filePath] = { revision: remote.revision, hash: remoteHash, deleted: false };
        await store.saveState(stateName, state);
        applied++;
      }
      for (const [filePath, baseline] of Object.entries(state.entries)) {
        if (!baseline.excluded || !included(filePath) || changes.has(filePath)) continue;
        if (baseline.revision > 0 && startCursor === 0) throw new Error('Remote history is missing a previously synchronized file; reconnect to the correct vault before syncing.');
        baseline.excluded = false;
      }
      state.cursor = cursor;
      stats.cursor = cursor;
      await store.saveState(stateName, state);
      checkpoint(signal);
      const snapshot = await store.snapshot();
      const localPaths = new Set(snapshot.files.filter((file) => !file.isDirectory).map((file) => file.path));
      let retry = false;
      const candidates = [...new Set([...localPaths, ...Object.keys(state.entries)])];
      let processed = 0;
      for (const filePath of candidates) {
        checkpoint(signal);
        normalizeVaultPath(filePath);
        const baseline = state.entries[filePath];
        if (!included(filePath)) {
          state.entries[filePath] = { ...(baseline || { revision: 0, hash: null, deleted: true }), excluded: true };
          skip(filePath); processed++; continue;
        }
        progress('uploading', { path: filePath, completed: processed, total: candidates.length });
        checkpoint(signal);
        const local = await readLocal(store, filePath);
        try {
          if (local && (!baseline || baseline.deleted || local.hash !== baseline.hash)) {
            const result = await request(`${prefix}/files`, { method: 'PUT', body: { path: filePath, content: local.data.toString('base64'), encoding: 'base64', base_revision: baseline?.revision || 0 } });
            if (!Number.isSafeInteger(result?.revision) || result.revision <= (baseline?.revision || 0) || result.path !== filePath || result.deleted !== false) throw new Error('Invalid upload acknowledgement; synchronize again to reconcile');
            state.entries[filePath] = { revision: result.revision, hash: local.hash, deleted: false };
            stats.uploaded++;
            await store.saveState(stateName, state);
          } else if (!local && baseline && !baseline.deleted) {
            const result = await request(`${prefix}/files`, { method: 'DELETE', body: { path: filePath, base_revision: baseline.revision } });
            if (!Number.isSafeInteger(result?.revision) || result.revision <= baseline.revision || result.path !== filePath || result.deleted !== true) throw new Error('Invalid deletion acknowledgement; synchronize again to reconcile');
            state.entries[filePath] = { revision: result.revision, hash: null, deleted: true };
            stats.deleted++;
            await store.saveState(stateName, state);
          }
          processed++;
        } catch (error) {
          if (error.status === 409 && error.detail?.code === 'revision_conflict') { retry = true; break; }
          throw error;
        }
      }
      await store.saveState(stateName, state);
      stats.cursor = state.cursor;
      if (!retry) { progress('idle', { completed: candidates.length, total: candidates.length }); return stats; }
    }
    throw new Error('Remote files kept changing during sync. Local data is preserved; sync again to continue.');
  } catch (error) {
    if (signal?.aborted || error.code === 'SYNC_PAUSED') { progress('paused'); throw pausedError(); }
    progress('error', { message: error.message });
    throw error;
  } finally { active.delete(store); }
}

/** One auto-sync coordinator per shared VaultStore, safe for several windows. */
class SyncController extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.config = null;
    this.closed = false;
    this.timer = null;
    this.current = null;
    this.abortController = null;
    this.pendingChange = false;
    this.beforeSync = options.beforeSync;
    this.debounceMs = boundedDelay(options.debounceMs, 1000, 10, 60000);
    this.retryBaseMs = boundedDelay(options.retryBaseMs, 2000, 20, 60000);
    this.retryMaxMs = Math.max(this.retryBaseMs, boundedDelay(options.retryMaxMs, 60000, 20, 600000));
    this.state = { enabled: false, paused: false, running: false, phase: 'idle', lastSuccess: null, lastError: null, nextRunAt: null, retryAttempt: 0 };
    this.changeListener = () => {
      if (!this.state.enabled || this.state.paused || this.closed) return;
      if (this.state.phase === 'error') return;
      if (this.state.phase === 'offline' && this.timer) { this.pendingChange = true; return; }
      if (this.current) this.pendingChange = true;
      else this.schedule(this.debounceMs);
    };
    store.on('change', this.changeListener);
  }
  notify(type, value) {
    for (const listener of this.listeners(type)) safeCallback(listener, value);
  }
  getStatus() { return { ...this.state }; }
  update(values) { Object.assign(this.state, values); this.notify('status', this.getStatus()); }
  clearTimer() { clearTimeout(this.timer); this.timer = null; this.state.nextRunAt = null; }
  schedule(milliseconds) {
    if (this.closed || this.state.paused || !this.config?.token || !this.config?.vaultId) return;
    this.clearTimer();
    this.update({ nextRunAt: Date.now() + milliseconds });
    this.timer = setTimeout(() => { this.timer = null; void this.syncNow().catch(() => {}); }, milliseconds);
    this.timer.unref?.();
  }
  configure(config) {
    if (this.closed) throw new Error('Sync controller is closed');
    const rules = normalizeSyncOptions(config);
    const next = { ...config, ...rules, autoSync: Boolean(config.autoSync), intervalMs: boundedDelay(config.intervalMs, 60000, 1000, 86400000), paused: Boolean(config.paused) };
    const identity = value => value && JSON.stringify([value.baseUrl, value.token, value.vaultId, value.excludeFolders, value.attachmentTypes]);
    const changed = identity(this.config) !== identity(next);
    this.config = next;
    this.clearTimer();
    this.update({ enabled: next.autoSync, paused: next.paused, lastError: null, retryAttempt: 0, phase: next.paused ? 'paused' : this.current ? 'syncing' : 'idle' });
    if (this.current && (changed || next.paused)) { this.pendingChange = true; this.abortController?.abort(); }
    if (!this.current && next.autoSync && !next.paused) this.schedule(0);
    return this.getStatus();
  }
  pause() {
    if (this.config) this.config.paused = true;
    this.clearTimer();
    this.abortController?.abort();
    this.update({ paused: true, phase: 'paused' });
    return this.getStatus();
  }
  resume() {
    if (this.closed) throw new Error('Sync controller is closed');
    if (this.config) this.config.paused = false;
    this.update({ paused: false, phase: this.current ? 'syncing' : 'idle', lastError: null, retryAttempt: 0 });
    if (this.current) this.resumeRequested = true;
    else this.schedule(0);
    return this.getStatus();
  }
  syncNow(config) {
    const previousRun = this.current;
    if (config) this.configure(config);
    if (this.closed) return Promise.reject(new Error('Sync controller is closed'));
    if (this.state.paused) return Promise.reject(pausedError());
    if (this.current) {
      if (config && this.current === previousRun && this.abortController?.signal.aborted) {
        return this.current.catch(error => { if (error.code !== 'SYNC_PAUSED') throw error; }).then(() => this.syncNow());
      }
      return this.current;
    }
    if (!this.config?.token || !this.config?.vaultId) return Promise.reject(new Error('Sign in and select a remote vault before syncing'));
    this.clearTimer();
    this.pendingChange = false;
    const configSnapshot = { ...this.config };
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.update({ running: true, phase: 'syncing', lastError: null });
    let nextDelay = null;
    const task = Promise.resolve().then(async () => {
      if (this.beforeSync) this.update({ phase: 'preparing' });
      await awaitBeforeSync(this.beforeSync, signal);
      checkpoint(signal);
      return syncVault(this.store, configSnapshot, {
        signal,
        onProgress: event => { this.notify('progress', event); if (event.phase !== 'paused') this.update({ phase: event.phase }); },
      });
    }).then(result => {
      this.update({ phase: 'idle', lastSuccess: Date.now(), lastError: null, retryAttempt: 0 });
      nextDelay = this.config.intervalMs;
      return result;
    }).catch(error => {
      if (error.code === 'SYNC_PAUSED') this.update({ phase: this.state.paused ? 'paused' : 'idle' });
      else {
        const retryable = !error.status && (error.name === 'TypeError' || error.name === 'TimeoutError' || /fetch failed|network|offline|socket/i.test(error.message)) || error.status === 429 || error.status >= 500;
        const attempt = retryable ? this.state.retryAttempt + 1 : 0;
        nextDelay = retryable ? Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(attempt - 1, 10)) : null;
        this.update({ phase: retryable ? 'offline' : 'error', lastError: error.message, retryAttempt: attempt });
      }
      throw error;
    }).finally(() => {
      this.current = null;
      this.abortController = null;
      this.update({ running: false, phase: this.state.paused ? 'paused' : this.state.phase });
      if (this.closed || this.state.paused) return;
      if (this.resumeRequested) { this.resumeRequested = false; this.schedule(0); }
      else if (this.state.phase === 'offline' && this.config?.autoSync && nextDelay !== null) this.schedule(nextDelay);
      else if (this.state.phase === 'error') return;
      else if (this.pendingChange && this.config?.autoSync) this.schedule(this.debounceMs);
      else if (this.config?.autoSync && nextDelay !== null) this.schedule(nextDelay);
    });
    this.current = task;
    return task;
  }
  close() {
    this.closed = true;
    this.clearTimer();
    this.abortController?.abort();
    this.store.off('change', this.changeListener);
    this.removeAllListeners();
    controllers.delete(this.store);
  }
}

export function createSyncController(store, options = {}) {
  let controller = controllers.get(store);
  if (!controller || controller.closed) { controller = new SyncController(store, options); controllers.set(store, controller); }
  if (options.beforeSync !== undefined) controller.beforeSync = options.beforeSync;
  for (const [type, listener] of [['progress', options.onProgress], ['status', options.onStatus]]) {
    if (typeof listener === 'function' && !controller.listeners(type).includes(listener)) controller.on(type, listener);
  }
  return controller;
}
