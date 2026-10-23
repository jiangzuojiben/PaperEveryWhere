import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { WindowRegistry } from '../desktop/window-registry.mjs';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
const [hostSource, preloadSource] = await Promise.all([
  fs.readFile(path.join(desktop, 'host.cjs'), 'utf8'),
  fs.readFile(path.join(desktop, 'preload.cjs'), 'utf8'),
]);

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-binary-bridge-'));
  const root = path.join(directory, 'Vault');
  await fs.mkdir(root);
  const registry = new WindowRegistry({ watchFiles: false });
  t.after(async () => {
    await registry.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('vaultdesk-binary-bridge-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const owner = await registry.add({ id: 'binary-test', vaultPath: root });
  const window = { webContents: { id: 11, mainFrame: {} }, isDestroyed: () => false };
  registry.bindWindow(owner.id, window);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const handlers = new Map();
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setPath() {}, getPath: () => directory,
    requestSingleInstanceLock: () => true,
    // Loading production handlers must never launch native windows in this unit test.
    whenReady: () => new Promise(() => {}),
  });
  const electron = { app, BrowserWindow: {}, clipboard: {}, dialog: {}, screen: {}, shell: {},
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
  };
  vm.runInNewContext(`${hostSource}\nregistry = testRegistry; installHandlers();`, {
    require: (name) => name === 'electron' ? electron : name === './web-viewer.cjs' ? { installWebViewer: () => ({ disposeOwner() {} }) } : require(name),
    __dirname: desktop, Buffer, URL, console, setTimeout, clearTimeout,
    process: { env: {}, argv: [], pid: process.pid, platform: process.platform }, testRegistry: registry,
  }, { filename: path.join(desktop, 'host.cjs') });
  let bridge;
  const renderer = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'vaultdesk'); bridge = value; } },
    ipcRenderer: { on() {}, invoke: async (name, ...args) => structuredClone(await handlers.get(name)(event, ...args)) },
    webUtils: {},
  };
  vm.runInNewContext(preloadSource, { require: (name) => { assert.equal(name, 'electron'); return renderer; }, queueMicrotask }, { filename: path.join(desktop, 'preload.cjs') });
  return { directory, root, store: owner.store, bridge, handlers, event };
}

test('binary bridge round-trips bytes and preserves the previous revision when modifying', async (t) => {
  const { bridge, store } = await fixture(t);
  assert.equal(typeof bridge.readBinary, 'function');
  assert.equal(typeof bridge.modifyBinary, 'function');
  const original = Buffer.from([0, 255, 128, 1, 0]);
  const replacement = Buffer.from([255, 0, 13, 10, 254, 0]);
  await bridge.writeBinary('Assets/data.bin', original.toString('base64'));
  const before = await bridge.readBinary('Assets/data.bin');
  assert.deepEqual(Buffer.from(before.base64, 'base64'), original);
  assert.equal(typeof before.mtime, 'number');
  assert.match(before.version, /^[a-f0-9]{64}$/);
  const modified = await bridge.modifyBinary('Assets/data.bin', replacement.toString('base64'), before.mtime, before.version);
  const after = await bridge.readBinary('Assets/data.bin');
  assert.deepEqual(Buffer.from(after.base64, 'base64'), replacement);
  assert.equal(after.version, modified.version);
  assert.notEqual(after.version, before.version);
  assert.equal(modified.size, replacement.length);
  const history = await store.getHistory('Assets/data.bin');
  assert.equal(history.length, 1);
  assert.equal(history[0].hash, before.version);
  await store.restoreHistory('Assets/data.bin', history[0].id);
  assert.deepEqual(Buffer.from((await bridge.readBinary('Assets/data.bin')).base64, 'base64'), original);
  await bridge.writeBinary('Empty.bin', '');
  assert.equal((await bridge.readBinary('Empty.bin')).base64, '');
});

test('binary modification forwards both CAS tokens and preserves errors through preload', async (t) => {
  const { root, bridge, store } = await fixture(t);
  await bridge.writeBinary('Race.bin', Buffer.from([1, 2, 3]).toString('base64'));
  const absolute = path.join(root, 'Race.bin');
  const previous = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(absolute, previous, previous);
  const before = await bridge.readBinary('Race.bin');
  await fs.writeFile(absolute, Buffer.from([3, 2, 1]));
  await fs.utimes(absolute, previous, previous);
  await assert.rejects(bridge.modifyBinary('Race.bin', 'BAUG', before.mtime, before.version), (error) => error.name === 'VaultDeskError' && error.code === 'VERSION_CONFLICT' && error.currentMtime === before.mtime);
  const external = await bridge.readBinary('Race.bin');
  await fs.utimes(absolute, previous, new Date('2021-01-01T00:00:00.000Z'));
  await assert.rejects(bridge.modifyBinary('Race.bin', 'BAUG', external.mtime, external.version), (error) => error.code === 'MTIME_CONFLICT');
  assert.deepEqual((await store.readBytes('Race.bin')).data, Buffer.from([3, 2, 1]));
  assert.deepEqual(await store.getHistory('Race.bin'), []);
});

test('binary creation remains create-only and both write methods strictly validate base64', async (t) => {
  const { bridge, store } = await fixture(t);
  await bridge.writeBinary('Keep.bin', 'AA==');
  const before = await bridge.readBinary('Keep.bin');
  await assert.rejects(bridge.writeBinary('Keep.bin', '/w=='), (error) => /already exists/.test(error.message));
  for (const invalid of [null, 7, 'A', 'AA=', 'AA===', 'AA==\n', '!!!!', 'AB==', 'AAB=', 'data:application/octet-stream;base64,AA==']) {
    await assert.rejects(bridge.writeBinary('Invalid.bin', invalid), (error) => /base64/.test(error.message));
    await assert.rejects(bridge.modifyBinary('Keep.bin', invalid, before.mtime, before.version), (error) => /base64/.test(error.message));
  }
  assert.equal((await bridge.readBinary('Keep.bin')).base64, 'AA==');
  assert.deepEqual(await store.getHistory('Keep.bin'), []);
  await assert.rejects(store.readBytes('Invalid.bin'), { code: 'ENOENT' });
});

test('binary bridges retain vault path boundaries and main-frame authorization', async (t) => {
  const { directory, bridge, handlers, event } = await fixture(t);
  const outside = path.join(directory, 'Outside.bin');
  await fs.writeFile(outside, Buffer.from([12, 255]));
  for (const unsafe of ['../Outside.bin', '.vaultdesk/workspace-binary-test.json', outside]) {
    await assert.rejects(bridge.readBinary(unsafe));
    await assert.rejects(bridge.modifyBinary(unsafe, 'AA=='));
  }
  assert.deepEqual(await fs.readFile(outside), Buffer.from([12, 255]));
  for (const method of ['readBinary', 'modifyBinary']) {
    const result = await handlers.get(`vaultdesk:${method}`)({ ...event, senderFrame: {} }, 'Outside.bin', 'AA==');
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Untrusted IPC sender/);
  }
});
