import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { planRename } from '../core/vault.mjs';
import { isTextPath } from '../core/file-types.mjs';

const PRIVATE_DIRS = new Set(['.vaultdesk', '.obsidian', '.git']);
export const isTextFile = isTextPath;
const missing = (error) => error.code === 'ENOENT';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const id = () => `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
export function normalizeVaultPath(input, allowRoot = false) {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Invalid vault path');
  const value = input.replaceAll('\\', '/');
  if (allowRoot && value === '') return '';
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value)) throw new Error('Vault paths must be relative');
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error('Invalid or unsafe vault path');
    }
  }
  if (parts.some((part) => PRIVATE_DIRS.has(part.toLowerCase()))) throw new Error('Application metadata is protected');
  return parts.join('/');
}

export class VaultStore extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.queue = Promise.resolve();
    this.stateQueues = new Map();
    this.watcher = null;
    this.timer = null;
    this.poll = null;
    this.closed = false;
  }

  static async open(root, { watchFiles = true } = {}) {
    const absolute = path.resolve(root);
    const info = await fs.lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a real directory for the vault');
    const store = new VaultStore(await fs.realpath(absolute));
    await store.internalPath('');
    if (watchFiles) store.startWatching();
    return store;
  }

  async checkedPath(input, { allowMissing = false, allowRoot = false } = {}) {
    const relative = normalizeVaultPath(input, allowRoot);
    const target = path.resolve(this.root, ...relative.split('/'));
    const boundary = path.relative(this.root, target);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new Error('Path leaves vault');
    let current = this.root;
    const rootInfo = await fs.lstat(current);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Vault directory is no longer safe');
    for (const part of relative.split('/').filter(Boolean)) {
      current = path.join(current, part);
      let info;
      try { info = await fs.lstat(current); } catch (error) {
        if (allowMissing && missing(error)) return target;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('Symbolic links and junctions are not followed');
      if (current !== target && !info.isDirectory()) throw new Error('Parent is not a directory');
    }
    return target;
  }

  async internalPath(relative) {
    if (relative && (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.split('/').includes('..'))) throw new Error('Invalid internal path');
    const rootStat = await fs.lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Vault directory is no longer safe');
    let current = this.root;
    for (const part of ['.vaultdesk', ...relative.split('/').filter(Boolean)]) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Unsafe application metadata path');
      } catch (error) {
        if (!missing(error)) throw error;
        // Only the application root is created here; callers own file/directory creation.
        if (part === '.vaultdesk') await fs.mkdir(current).catch((failure) => { if (failure.code !== 'EEXIST') throw failure; });
      }
    }
    return current;
  }

  exclusive(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async snapshot() {
    // Share one I/O budget across every directory. Recursive traversal never
    // retains a slot while waiting for its children, so deep trees cannot deadlock.
    const waiting = [];
    let active = 0;
    const limited = (operation) => new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try { resolve(await operation()); }
        catch (error) { reject(error); }
        finally { active--; waiting.shift()?.(); }
      };
      if (active < 16) void run(); else waiting.push(run);
    });
    const report = (filePath, error) => { if (!missing(error)) this.emit('warning', { path: filePath, message: error.message }); };
    const visit = async (relative) => {
      const entries = await limited(async () => {
        const directory = await this.checkedPath(relative, { allowRoot: true });
        return fs.readdir(directory, { withFileTypes: true });
      });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const groups = await Promise.all(entries.map(async (entry) => {
        if (PRIVATE_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.vaultdesk-tmp-') || entry.isSymbolicLink()) return [];
        const filePath = relative ? `${relative}/${entry.name}` : entry.name;
        try {
          const file = await limited(async () => {
            const absolute = await this.checkedPath(filePath);
            const stat = await fs.stat(absolute);
            if (stat.isDirectory()) return { path: filePath, isDirectory: true };
            if (!stat.isFile()) return null;
            const file = { path: filePath, size: stat.size, mtime: stat.mtimeMs };
            if (isTextFile(filePath)) {
              const bytes = await this.readBytes(filePath);
              file.content = bytes.data.toString('utf8');
              file.mtime = bytes.mtime; file.version = bytes.version; file.size = bytes.data.length;
              file.text = file.content;
            }
            return file;
          });
          if (!file) return [];
          if (file.isDirectory) {
            // Preserve an otherwise visible directory even if its listing fails.
            try { return [file, ...await visit(filePath)]; }
            catch (error) { report(filePath, error); return [file]; }
          }
          return [file];
        } catch (error) {
          report(filePath, error); return [];
        }
      }));
      // Promise.all retains the sorted input order, including depth-first folders.
      return groups.flat();
    };
    const files = await visit('');
    let settings = {};
    // Obsidian preferences are an optional read-only source; plugin code is never loaded.
    const legacyDirectory = path.join(this.root, '.obsidian');
    try {
      const directory = await fs.lstat(legacyDirectory);
      const legacyFile = path.join(legacyDirectory, 'app.json');
      if (!directory.isSymbolicLink() && directory.isDirectory() && !(await fs.lstat(legacyFile)).isSymbolicLink()) settings = JSON.parse(await fs.readFile(legacyFile, 'utf8'));
    } catch { /* New vault or invalid optional preferences. */ }
    settings = { ...settings, ...await this.loadState('settings', {}) };
    return { vaultPath: this.root, files, settings };
  }

  async readBytes(relative) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = await this.checkedPath(relative);
      const handle = await fs.open(target, 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error('Expected a file');
        const data = await handle.readFile();
        const after = await handle.stat();
        if (before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.size === after.size && data.length === after.size) return { data, mtime: after.mtimeMs, version: hash(data) };
      } finally { await handle.close(); }
    }
    throw Object.assign(new Error('File kept changing while it was being read. Try again.'), { code: 'FILE_BUSY' });
  }

  async read(relative) {
    const { data, mtime, version } = await this.readBytes(relative);
    return { content: data.toString('utf8'), mtime, version };
  }

  async ensureParents(relative) {
    const normalized = normalizeVaultPath(relative);
    const parts = normalized.split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const target = await this.checkedPath(current, { allowMissing: true });
      await fs.mkdir(target).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      if (!(await fs.lstat(target)).isDirectory()) throw new Error('Parent is not a directory');
      await this.checkedPath(current);
    }
  }

  async assertMtime(relative, expectedMtime) {
    if (expectedMtime === undefined || expectedMtime === null) return;
    if (typeof expectedMtime !== 'number' || !Number.isFinite(expectedMtime)) throw new Error('Expected mtime must be a finite number');
    const target = await this.checkedPath(relative, { allowMissing: true });
    const stat = await fs.stat(target).catch((error) => { if (missing(error)) return null; throw error; });
    if (!stat || Math.abs(stat.mtimeMs - Number(expectedMtime)) > 0.001) {
      const error = new Error('This file changed on disk. Reload or save a separate copy before overwriting.');
      error.code = 'MTIME_CONFLICT';
      error.currentMtime = stat?.mtimeMs ?? null;
      throw error;
    }
  }

  async assertVersion(relative, expectedVersion) {
    if (expectedVersion === undefined || expectedVersion === null) return;
    if (typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion)) throw new Error('Expected version must be a file content fingerprint');
    const current = await this.readBytes(relative).catch((error) => { if (missing(error)) return null; throw error; });
    if (!current || current.version !== expectedVersion) throw Object.assign(new Error('This file changed on disk. Reload or save a separate copy before overwriting.'), { code: 'VERSION_CONFLICT', currentMtime: current?.mtime ?? null });
  }

  async writeAtomic(relative, data, expectedMtime, { createOnly = false, history = true, expectedVersion } = {}) {
    normalizeVaultPath(relative);
    await this.ensureParents(relative);
    const target = await this.checkedPath(relative, { allowMissing: true });
    const existing = await fs.lstat(target).catch((error) => { if (missing(error)) return null; throw error; });
    if (existing && (!existing.isFile() || createOnly)) throw new Error('A file or folder already exists at this path');
    await this.assertMtime(relative, expectedMtime);
    await this.assertVersion(relative, expectedVersion);
    if (existing && history) await this.recordHistory(relative);
    const temporary = path.join(path.dirname(target), `.vaultdesk-tmp-${id()}`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      // Distinct commits have distinct mtimes even on coarse clocks. Set the
      // temporary inode so the reported version belongs to the bytes we commit.
      const modified = Math.max(Date.now(), (existing?.mtimeMs || 0) + 1);
      await fs.utimes(temporary, new Date(), new Date(modified));
      const committedStat = await fs.stat(temporary);
      await this.checkedPath(relative, { allowMissing: true });
      await this.assertMtime(relative, expectedMtime);
      await this.assertVersion(relative, expectedVersion);
      if (createOnly) {
        // A hard link provides no-overwrite semantics even when another process creates the target.
        await fs.link(temporary, target);
        await fs.unlink(temporary);
      } else await fs.rename(temporary, target);
      this.notify(relative);
      return { path: relative, mtime: committedStat.mtimeMs, size: data.length, version: hash(data) };
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  write(relative, content, expectedMtime, expectedVersion) {
    if (typeof content !== 'string') throw new Error('Content must be a string');
    return this.writeBytes(relative, Buffer.from(content, 'utf8'), expectedMtime, expectedVersion);
  }
  writeBytes(relative, data, expectedMtime, expectedVersion) { return this.exclusive(() => this.writeAtomic(relative, Buffer.from(data), expectedMtime, { expectedVersion })); }
  create(relative, content = '') { return this.exclusive(() => this.writeAtomic(relative, Buffer.from(content, 'utf8'), undefined, { createOnly: true, history: false })); }
  createBytes(relative, data) { return this.exclusive(() => this.writeAtomic(relative, Buffer.from(data), undefined, { createOnly: true, history: false })); }
  mkdir(relative) {
    return this.exclusive(async () => {
      await this.ensureParents(relative);
      await fs.mkdir(await this.checkedPath(relative, { allowMissing: true }));
      this.notify(relative);
      return { path: relative };
    });
  }

  async recordHistory(relative) {
    const { data, mtime } = await this.readBytes(relative);
    const key = hash(relative);
    const directory = await this.internalPath(`history/${key}`);
    await fs.mkdir(directory, { recursive: true });
    const indexFile = await this.internalPath(`history/${key}/index.json`);
    let entries = [];
    try { entries = JSON.parse(await fs.readFile(indexFile, 'utf8')); } catch (error) { if (!missing(error)) throw error; }
    const checksum = hash(data);
    if (entries[0]?.hash === checksum) return;
    const entry = { id: id(), path: relative, mtime, timestamp: new Date().toISOString(), size: data.length, hash: checksum };
    await fs.writeFile(await this.internalPath(`history/${key}/${entry.id}.bin`), data, { flag: 'wx' });
    entries.unshift(entry);
    const removed = entries.splice(100);
    await this.writeInternal(`history/${key}/index.json`, entries);
    for (const obsolete of removed) await fs.unlink(await this.internalPath(`history/${key}/${obsolete.id}.bin`)).catch(() => {});
  }

  async getHistory(relative) {
    relative = normalizeVaultPath(relative);
    try { return JSON.parse(await fs.readFile(await this.internalPath(`history/${hash(relative)}/index.json`), 'utf8')); }
    catch (error) { if (missing(error)) return []; throw error; }
  }

  async historyRevision(relative, revision) {
    relative = normalizeVaultPath(relative);
    if (typeof revision !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(revision)) throw new Error('Invalid history revision');
    const entries = await this.getHistory(relative);
    const entry = entries.find((item) => item.id === revision);
    if (!entry) throw new Error('History revision not found');
    const data = await fs.readFile(await this.internalPath(`history/${hash(relative)}/${revision}.bin`));
    if (entry.hash && hash(data) !== entry.hash) throw Object.assign(new Error('The saved history revision is damaged'), { code: 'HISTORY_CORRUPT' });
    return { entry: { ...entry, path: relative, size: data.length }, data };
  }

  async readHistory(relative, revision) {
    const { entry, data } = await this.historyRevision(relative, revision);
    return isTextFile(entry.path) ? { ...entry, encoding: 'utf8', content: data.toString('utf8') } : { ...entry, encoding: 'base64' };
  }

  restoreHistory(relative, revision) {
    return this.exclusive(async () => {
      const { data } = await this.historyRevision(relative, revision);
      return this.writeAtomic(relative, data);
    });
  }

  trash(relative, expectedMtime, expectedVersion) {
    return this.exclusive(async () => {
      const target = await this.checkedPath(relative);
      const stat = await fs.stat(target);
      await this.assertMtime(relative, expectedMtime);
      await this.assertVersion(relative, expectedVersion);
      if (stat.isFile()) await this.recordHistory(relative);
      const trashId = id();
      const directory = await this.internalPath(`trash/${trashId}`);
      await fs.mkdir(directory, { recursive: true });
      await this.writeInternal(`trash/${trashId}/entry.json`, { id: trashId, path: relative, timestamp: new Date().toISOString(), isDirectory: stat.isDirectory() });
      await this.checkedPath(relative);
      await this.assertMtime(relative, expectedMtime);
      await this.assertVersion(relative, expectedVersion);
      await fs.rename(target, await this.internalPath(`trash/${trashId}/content`));
      this.notify(relative);
      return { path: relative, trashId };
    });
  }

  async listTrash() {
    const directory = await this.internalPath('trash');
    let entries = [];
    try { entries = await fs.readdir(directory); } catch (error) { if (missing(error)) return []; throw error; }
    const result = [];
    for (const name of entries) {
      try { result.push(JSON.parse(await fs.readFile(await this.internalPath(`trash/${name}/entry.json`), 'utf8'))); } catch { /* Ignore incomplete entries. */ }
    }
    return result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  restoreTrash(trashId, destination) {
    return this.exclusive(async () => {
      if (!/^[a-zA-Z0-9-]+$/.test(trashId)) throw new Error('Invalid trash id');
      const entryFile = await this.internalPath(`trash/${trashId}/entry.json`);
      const entry = JSON.parse(await fs.readFile(entryFile, 'utf8'));
      const relative = normalizeVaultPath(destination || entry.path);
      const target = await this.checkedPath(relative, { allowMissing: true });
      if (await fs.lstat(target).then(() => true, (error) => { if (missing(error)) return false; throw error; })) throw new Error('Restore destination already exists');
      await this.ensureParents(relative);
      await fs.rename(await this.internalPath(`trash/${trashId}/content`), target);
      await fs.unlink(entryFile);
      this.notify(relative);
      return { path: relative };
    });
  }

  rename(oldPath, newPath, settings = {}) {
    return this.exclusive(async () => {
      oldPath = normalizeVaultPath(oldPath); newPath = normalizeVaultPath(newPath);
      if (oldPath === newPath) return { path: newPath, changes: [] };
      if (newPath.startsWith(`${oldPath}/`)) throw new Error('Cannot move a folder into itself');
      const oldTarget = await this.checkedPath(oldPath);
      const newTarget = await this.checkedPath(newPath, { allowMissing: true });
      if (await fs.lstat(newTarget).then(() => true, (error) => { if (missing(error)) return false; throw error; })) throw new Error('Destination already exists');
      const snapshot = await this.snapshot();
      const files = Object.fromEntries(snapshot.files.filter((file) => !file.isDirectory).map((file) => [file.path, file.content ?? '']));
      const hasFiles = Object.keys(files).some((name) => name === oldPath || name.startsWith(`${oldPath}/`));
      const planned = hasFiles ? planRename(files, oldPath, newPath, settings) : { files, changes: [] };
      const edits = [];
      for (const file of snapshot.files.filter((item) => !item.isDirectory)) {
        const moved = file.path === oldPath || file.path.startsWith(`${oldPath}/`);
        const nextPath = moved ? newPath + file.path.slice(oldPath.length) : file.path;
        if (isTextFile(file.path) && planned.files[nextPath] !== undefined && planned.files[nextPath] !== files[file.path]) edits.push({ file, nextPath, content: planned.files[nextPath] });
      }
      for (const edit of edits) {
        await this.assertMtime(edit.file.path, edit.file.mtime);
        await this.recordHistory(edit.file.path);
      }
      await this.ensureParents(newPath);
      await this.checkedPath(oldPath);
      await this.checkedPath(newPath, { allowMissing: true });
      await fs.rename(oldTarget, newTarget);
      const warnings = [];
      for (const edit of edits) {
        try { await this.writeAtomic(edit.nextPath, Buffer.from(edit.content), edit.file.mtime); }
        catch (error) { warnings.push({ path: edit.nextPath, message: error.message }); }
      }
      if (settings.decision === 'always') await this.saveState('settings', { ...await this.loadState('settings', {}), alwaysUpdateLinks: true });
      this.notify(newPath);
      return { path: newPath, changes: planned.changes, settings: planned.settings, warnings };
    });
  }

  async writeInternal(relative, value) {
    const target = await this.internalPath(relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.internalPath(relative);
    const temporary = `${target}.${id()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async loadState(name, fallback = null) {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('Invalid state name');
    try { return JSON.parse(await fs.readFile(await this.internalPath(`${name}.json`), 'utf8')); }
    catch (error) { if (missing(error)) return fallback; throw error; }
  }
  async saveState(name, value) {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('Invalid state name');
    // Layout saves can arrive from a debounce and beforeunload back-to-back.
    // Order writes per state file without blocking independent windows or nesting
    // the file-mutation queue (rename itself can save settings while holding it).
    const previous = this.stateQueues.get(name) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.writeInternal(`${name}.json`, value));
    this.stateQueues.set(name, pending);
    const clear = () => { if (this.stateQueues.get(name) === pending) this.stateQueues.delete(name); };
    pending.then(clear, clear);
    await pending;
    return true;
  }
  saveWorkspace(value) { return this.saveState('workspace', value); }
  loadWorkspace() { return this.loadState('workspace', {}); }
  notify(relative = '') {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.closed) this.emit('change', { path: relative, timestamp: Date.now() }); }, 120);
    this.timer.unref?.();
  }
  startWatching() {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        const relative = String(filename || '').replaceAll('\\', '/');
        if (!relative.split('/').some((part) => PRIVATE_DIRS.has(part.toLowerCase()) || part.startsWith('.vaultdesk-tmp-'))) this.notify(relative);
      });
      this.watcher.on('error', (error) => this.emit('warning', { message: error.message }));
      this.watcher.unref();
    } catch {
      let last = '';
      this.poll = setInterval(async () => {
        try {
          const value = JSON.stringify((await this.snapshot()).files.map(({ path, mtime, size }) => [path, mtime, size]));
          if (last && value !== last) this.notify();
          last = value;
        } catch (error) { this.emit('warning', { message: error.message }); }
      }, 2000);
      this.poll.unref();
    }
  }
  close() { this.closed = true; this.watcher?.close(); clearTimeout(this.timer); clearInterval(this.poll); }
}

export async function createWelcomeVault(directory = path.join(os.homedir(), 'Documents', 'VaultDesk Welcome')) {
  await fs.mkdir(directory, { recursive: true });
  const store = await VaultStore.open(directory);
  const welcome = 'Welcome.md';
  try { await store.checkedPath(welcome); }
  catch (error) {
    if (!missing(error)) throw error;
    await store.create(welcome, '# Welcome to VaultDesk\n\nYour notes are local Markdown files. Choose **Open vault** to open a folder.\n\n- [[Getting started]]\n- #welcome\n\nSync and publishing use your own server, only when you explicitly connect.\n');
    await store.create('Getting started.md', '# Getting started\n\nUse the file explorer to create a note, or open the command palette.\n\nYour workspace, file history and recycling bin live in `.vaultdesk`.\n');
  }
  return store;
}
