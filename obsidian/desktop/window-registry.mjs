import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { VaultStore } from './vault-store.mjs';

const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(id);
const token = () => crypto.randomBytes(24).toString('hex');
const changedError = () => Object.assign(new Error('The window changed vaults while this operation was running. Please try again in the current vault.'), { code: 'VAULT_CHANGED' });

/** Owns vault leases and window identities without depending on Electron. */
export class WindowRegistry extends EventEmitter {
  constructor({ watchFiles = true } = {}) {
    super();
    this.watchFiles = watchFiles;
    this.contexts = new Map();
    this.leases = new Map();
    this.opening = new Map();
    this.pendingOperations = new Set();
    this.closed = false;
    this.closePromise = null;
  }

  async acquire(vaultPath) {
    if (this.closed) throw changedError();
    if (!path.isAbsolute(vaultPath)) throw new Error('An absolute vault directory is required');
    const stat = await fs.lstat(vaultPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a real directory for the vault');
    const root = await fs.realpath(vaultPath);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    let lease = this.leases.get(key);
    if (!lease && !this.opening.has(key)) {
      this.opening.set(key, (async () => {
        const store = await VaultStore.open(root, { watchFiles: this.watchFiles });
        const lease = { key, store, contexts: new Set(), reservations: 0, closed: false };
        store.on('change', (change) => this.sendToVault(store, change));
        store.on('warning', (warning) => this.sendToVault(store, { warning }));
        this.leases.set(key, lease);
        this.emit('store-opened', store);
        return lease;
      })().finally(() => this.opening.delete(key)));
    }
    lease ||= await this.opening.get(key);
    // A caller owns a reservation before it resumes. A canceled opener must not
    // close a shared store while another opener is still about to adopt it.
    lease.reservations++;
    return lease;
  }

  track(operation) {
    this.pendingOperations.add(operation);
    operation.then(() => this.pendingOperations.delete(operation), () => this.pendingOperations.delete(operation));
    return operation;
  }

  async add({ id = crypto.randomUUID(), vaultPath, window = null, send = () => {} } = {}) {
    if (this.closed) throw changedError();
    if (!validId(id) || this.contexts.has(id)) throw new Error('Invalid or duplicate window identity');
    const context = { id, window, send, store: null, vaultPath, assetToken: token(), generation: 0, lease: null };
    // Reserve the id before any await so concurrent additions cannot share identity.
    this.contexts.set(id, context);
    return this.track((async () => {
      let lease;
      try {
        lease = await this.acquire(vaultPath);
        if (this.closed || this.contexts.get(id) !== context) throw changedError();
        context.lease = lease; context.store = lease.store; context.vaultPath = lease.store.root;
        lease.contexts.add(id);
        return context;
      } catch (error) {
        // The canceled id may already belong to a replacement window.
        if (this.contexts.get(id) === context) this.contexts.delete(id);
        throw error;
      } finally {
        if (lease) { lease.reservations--; this.release(lease); }
      }
    })());
  }

  get(id) {
    const context = this.contexts.get(id);
    if (!context?.store) throw new Error('Window context is unavailable');
    return context;
  }

  bindWindow(id, window) { const context = this.get(id); context.window = window; return context; }

  fromEvent(event) {
    const context = [...this.contexts.values()].find((item) => item.window?.webContents === event.sender);
    if (!context?.store || event.senderFrame !== event.sender.mainFrame || context.window.isDestroyed?.()) throw new Error('Untrusted IPC sender');
    return context;
  }

  capture(id) {
    const context = this.get(id);
    const generation = context.generation;
    const store = context.store;
    return { ...context, assertCurrent: () => {
      if (this.contexts.get(id) !== context || context.generation !== generation || context.store !== store) throw changedError();
      return context;
    } };
  }

  release(lease) {
    if (lease.closed || lease.contexts.size || lease.reservations) return;
    lease.closed = true;
    if (this.leases.get(lease.key) === lease) this.leases.delete(lease.key);
    try { this.emit('store-closed', lease.store); }
    finally { lease.store.close(); }
  }

  switchVault(id, vaultPath) {
    if (this.closed) return Promise.reject(changedError());
    const context = this.get(id);
    const operation = async () => {
      if (this.closed || this.contexts.get(id) !== context) throw changedError();
      const previous = context.lease;
      let lease;
      try {
        lease = await this.acquire(vaultPath);
        if (this.closed || this.contexts.get(id) !== context) throw changedError();
        if (lease === previous) return context;
        previous.contexts.delete(id); lease.contexts.add(id);
        context.lease = lease; context.store = lease.store; context.vaultPath = lease.store.root;
        context.assetToken = token(); context.generation++;
        this.release(previous);
        this.emit('context-changed', context);
        return context;
      } finally {
        if (lease) { lease.reservations--; this.release(lease); }
      }
    };
    const result = (context.switchQueue || Promise.resolve()).then(operation, operation);
    context.switchQueue = result.catch(() => {});
    return this.track(result);
  }

  sendToVault(store, change) {
    for (const context of this.contexts.values()) {
      if (context.store === store) context.send({ ...change, windowId: context.id, vaultPath: context.vaultPath });
    }
  }

  saveWorkspace(id, value) { const context = this.get(id); return context.store.saveState(`workspace-${id}`, value); }
  async loadWorkspace(id) {
    const context = this.get(id);
    return await context.store.loadState(`workspace-${id}`, null) ?? await context.store.loadWorkspace();
  }

  list(id) {
    const own = this.get(id);
    return [...this.contexts.values()].filter((context) => context.store === own.store).map((context) => ({ windowId: context.id, vaultPath: context.vaultPath, current: context.id === id }));
  }

  async remove(id) {
    const context = this.contexts.get(id);
    if (!context) return;
    this.contexts.delete(id); context.generation++;
    context.lease?.contexts.delete(id);
    if (context.lease) await this.release(context.lease);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      for (const id of [...this.contexts.keys()]) await this.remove(id);
      await Promise.allSettled([...this.pendingOperations]);
      for (const lease of this.leases.values()) this.release(lease);
    })();
    return this.closePromise;
  }
}
