import crypto from 'node:crypto';
import path from 'node:path';
import { normalizeVaultPath } from './vault-store.mjs';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const active = new WeakSet();
const isMissing = (error) => error.code === 'ENOENT';

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
  const response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(45000) });
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

async function conflictCopy(store, filePath, data) {
  const extension = path.posix.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const conflictPath = `${stem} (conflict ${suffix}-${crypto.randomBytes(3).toString('hex')})${extension}`;
  await store.createBytes(conflictPath, data);
  return conflictPath;
}

export async function syncVault(store, config) {
  if (active.has(store)) throw new Error('This vault is already syncing');
  if (!config.token || !config.vaultId) throw new Error('Sign in and select a remote vault before syncing');
  active.add(store);
  const prefix = `/vaults/${encodeURIComponent(config.vaultId)}`;
  const stateName = `sync-${digest(`${config.baseUrl.replace(/\/$/, '')}|${config.vaultId}`).slice(0, 24)}`;
  const stats = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], cursor: 0 };
  try {
    const state = await store.loadState(stateName, { version: 1, cursor: 0, entries: {} });
    if (!state.entries || typeof state.entries !== 'object') throw new Error('Invalid local sync state');
    state.entries = Object.assign(Object.create(null), state.entries);
    for (let round = 0; round < 4; round++) {
      const changes = new Map();
      let cursor = state.cursor || 0;
      let more = true;
      let pages = 0;
      while (more) {
        if (++pages > 10000) throw new Error('Remote change log is too large for a single sync');
        const page = await cloudRequest(config, `${prefix}/changes?cursor=${cursor}`);
        if (!Array.isArray(page?.changes) || !Number.isSafeInteger(page.cursor) || page.cursor < cursor) throw new Error('Invalid remote change response');
        for (const change of page.changes) {
          normalizeVaultPath(change.path);
          if (!Number.isSafeInteger(change.revision) || change.revision < 1) throw new Error('Invalid remote revision');
          changes.set(change.path, change);
        }
        if (page.has_more && page.cursor === cursor) throw new Error('Remote change cursor did not advance');
        cursor = page.cursor;
        more = Boolean(page.has_more);
      }
      for (const [filePath, remote] of changes) {
        const baseline = state.entries[filePath];
        if (baseline && remote.revision <= baseline.revision) continue;
        const local = await readLocal(store, filePath);
        if (remote.deleted) {
          if (baseline?.deleted) {
            state.entries[filePath] = { ...baseline, revision: remote.revision };
            continue;
          }
          if (local) {
            if (!baseline || baseline.deleted || local.hash !== baseline.hash) stats.conflicts.push(await conflictCopy(store, filePath, local.data));
            // Recheck to avoid removing an edit made while preparing a conflict copy.
            await store.assertMtime(filePath, local.mtime);
            await store.trash(filePath, local.mtime);
            stats.deleted++;
          }
          state.entries[filePath] = { revision: remote.revision, hash: null, deleted: true };
          continue;
        }
        if (!['utf8', 'base64'].includes(remote.encoding || 'utf8') || typeof remote.content !== 'string') throw new Error('Invalid remote content');
        if (remote.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(remote.content)) throw new Error('Invalid remote base64 attachment');
        const bytes = Buffer.from(remote.content, remote.encoding === 'base64' ? 'base64' : 'utf8');
        const remoteHash = digest(bytes);
        if (baseline && !baseline.deleted && baseline.hash === remoteHash) {
          state.entries[filePath] = { ...baseline, revision: remote.revision };
          continue;
        }
        // A local deletion and a remote edit conflict. Retain the remote bytes as a new note,
        // then propagate the local deletion on the original path during the upload phase.
        if (!local && baseline && !baseline.deleted && baseline.hash !== remoteHash) {
          stats.conflicts.push(await conflictCopy(store, filePath, bytes));
        } else if (!local && baseline && !baseline.deleted && baseline.hash === remoteHash) {
          // An acknowledged local deletion takes precedence over an unchanged remote file.
        } else if (local?.hash !== remoteHash) {
          if (local && (!baseline || baseline.deleted || local.hash !== baseline.hash)) stats.conflicts.push(await conflictCopy(store, filePath, local.data));
          if (local) await store.writeBytes(filePath, bytes, local.mtime);
          else await store.createBytes(filePath, bytes);
          stats.downloaded++;
        }
        state.entries[filePath] = { revision: remote.revision, hash: remoteHash, deleted: false };
      }
      state.cursor = cursor;
      await store.saveState(stateName, state);
      const snapshot = await store.snapshot();
      const localPaths = new Set(snapshot.files.filter((file) => !file.isDirectory).map((file) => file.path));
      let retry = false;
      for (const filePath of new Set([...localPaths, ...Object.keys(state.entries)])) {
        normalizeVaultPath(filePath);
        const baseline = state.entries[filePath];
        const local = await readLocal(store, filePath);
        try {
          if (local && (!baseline || baseline.deleted || local.hash !== baseline.hash)) {
            const result = await cloudRequest(config, `${prefix}/files`, { method: 'PUT', body: { path: filePath, content: local.data.toString('base64'), encoding: 'base64', base_revision: baseline?.revision || 0 } });
            state.entries[filePath] = { revision: result.revision, hash: local.hash, deleted: false };
            stats.uploaded++;
            await store.saveState(stateName, state);
          } else if (!local && baseline && !baseline.deleted) {
            const result = await cloudRequest(config, `${prefix}/files`, { method: 'DELETE', body: { path: filePath, base_revision: baseline.revision } });
            state.entries[filePath] = { revision: result.revision, hash: null, deleted: true };
            stats.deleted++;
            await store.saveState(stateName, state);
          }
        } catch (error) {
          if (error.status === 409 && error.detail?.code === 'revision_conflict') { retry = true; break; }
          throw error;
        }
      }
      stats.cursor = state.cursor;
      if (!retry) return stats;
    }
    throw new Error('Remote files kept changing during sync. Local data is preserved; sync again to continue.');
  } finally { active.delete(store); }
}
