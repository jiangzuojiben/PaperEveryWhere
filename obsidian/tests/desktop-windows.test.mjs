import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { WindowRegistry } from '../desktop/window-registry.mjs';

const TEMP_PREFIX = 'vaultdesk-windows-';
const heldAcquisitions = new WeakMap();

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const root = path.join(directory, 'Shared vault');
  const otherRoot = path.join(directory, 'Other vault');
  await Promise.all([fs.mkdir(root), fs.mkdir(otherRoot)]);
  const registries = new Set();
  const newRegistry = () => {
    const registry = new WindowRegistry({ watchFiles: false });
    registries.add(registry);
    return registry;
  };
  t.after(async () => {
    for (const registry of registries) {
      for (const slot of heldAcquisitions.get(registry) || []) slot.proceed.resolve();
    }
    for (const registry of registries) await registry.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, otherRoot, registry: newRegistry(), newRegistry };
}

function recorder() {
  const messages = [];
  return { messages, send: (...args) => messages.push(args.at(-1)) };
}

function mockWindow(id) {
  return { webContents: { id, mainFrame: {} } };
}

function mainFrameEvent(window) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
}

function deferred() {
  let resolve;
  const promise = new Promise((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function holdAcquisitions(t, registry, count = 1) {
  const acquire = registry.acquire.bind(registry);
  const slots = Array.from({ length: count }, () => ({ ready: deferred(), proceed: deferred() }));
  heldAcquisitions.set(registry, [...heldAcquisitions.get(registry) || [], ...slots]);
  let call = 0;
  t.mock.method(registry, 'acquire', async (vaultPath) => {
    const slot = slots[call++];
    const lease = await acquire(vaultPath);
    if (slot) {
      slot.ready.resolve(lease);
      await slot.proceed.promise;
    }
    return lease;
  });
  t.after(() => { for (const slot of slots) slot.proceed.resolve(); });
  return slots;
}

test('concurrent first opens share one store and keep distinct window capabilities', async (t) => {
  const { root, registry } = await fixture(t);
  const [one, two, three] = await Promise.all([
    registry.add({ id: 'one', vaultPath: root, send() {} }),
    registry.add({ id: 'two', vaultPath: `${root}${path.sep}.`, send() {} }),
    registry.add({ id: 'three', vaultPath: root, send() {} }),
  ]);
  assert.equal(one.store, two.store);
  assert.equal(two.store, three.store);
  assert.equal(registry.get('one'), one);
  assert.equal(registry.get('two'), two);
  assert.equal(one.vaultPath, await fs.realpath(root));
  assert.ok(one.assetToken);
  assert.ok(two.assetToken);
  assert.notEqual(one.assetToken, two.assetToken);
  assert.notEqual(one.assetToken, three.assetToken);
  assert.ok((await fs.stat(path.join(root, '.vaultdesk'))).isDirectory());
});

test('different vault roots have independent stores and content', async (t) => {
  const { root, otherRoot, registry } = await fixture(t);
  const one = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const two = await registry.add({ id: 'two', vaultPath: otherRoot, send() {} });
  assert.notEqual(one.store, two.store);
  await one.store.create('Note.md', 'first vault');
  await two.store.create('Note.md', 'second vault');
  assert.equal((await one.store.read('Note.md')).content, 'first vault');
  assert.equal((await two.store.read('Note.md')).content, 'second vault');
});

test('change notifications reach only windows currently using the changed vault', async (t) => {
  const { root, otherRoot, registry } = await fixture(t);
  const first = recorder();
  const second = recorder();
  const third = recorder();
  const one = await registry.add({ id: 'one', vaultPath: root, send: first.send });
  await registry.add({ id: 'two', vaultPath: root, send: second.send });
  const three = await registry.add({ id: 'three', vaultPath: otherRoot, send: third.send });
  const sharedStore = one.store;
  first.messages.length = second.messages.length = third.messages.length = 0;
  const sharedChange = { path: 'Shared.md', timestamp: 1 };
  sharedStore.emit('change', sharedChange);
  assert.deepEqual(first.messages, [{ ...sharedChange, windowId: 'one', vaultPath: one.vaultPath }]);
  assert.deepEqual(second.messages, [{ ...sharedChange, windowId: 'two', vaultPath: one.vaultPath }]);
  assert.deepEqual(third.messages, []);

  await registry.switchVault('one', otherRoot);
  first.messages.length = second.messages.length = third.messages.length = 0;
  const oldChange = { path: 'Old.md', timestamp: 2 };
  const newChange = { path: 'New.md', timestamp: 3 };
  sharedStore.emit('change', oldChange);
  three.store.emit('change', newChange);
  assert.deepEqual(first.messages, [{ ...newChange, windowId: 'one', vaultPath: three.vaultPath }]);
  assert.deepEqual(second.messages, [{ ...oldChange, windowId: 'two', vaultPath: sharedStore.root }]);
  assert.deepEqual(third.messages, [{ ...newChange, windowId: 'three', vaultPath: three.vaultPath }]);

  await registry.remove('one');
  first.messages.length = 0;
  three.store.emit('change', { path: 'After closing.md', timestamp: 4 });
  assert.deepEqual(first.messages, []);
});

test('IPC authorization requires the exact registered sender and its main frame', async (t) => {
  const { root, registry } = await fixture(t);
  const one = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const two = await registry.add({ id: 'two', vaultPath: root, send() {} });
  const firstWindow = mockWindow(101);
  const secondWindow = mockWindow(202);
  registry.bindWindow('one', firstWindow);
  registry.bindWindow('two', secondWindow);
  assert.equal(registry.fromEvent(mainFrameEvent(firstWindow)), one);
  assert.equal(registry.fromEvent(mainFrameEvent(secondWindow)), two);
  assert.throws(() => registry.fromEvent({ sender: firstWindow.webContents, senderFrame: {} }));
  assert.throws(() => registry.fromEvent({ sender: firstWindow.webContents, senderFrame: null }));
  assert.throws(() => registry.fromEvent({ sender: firstWindow.webContents, senderFrame: secondWindow.webContents.mainFrame }));
  assert.throws(() => registry.fromEvent(mainFrameEvent(mockWindow(303))));
  const impersonated = { ...firstWindow.webContents };
  assert.throws(() => registry.fromEvent({ sender: impersonated, senderFrame: firstWindow.webContents.mainFrame }));
  await registry.remove('one');
  assert.throws(() => registry.fromEvent(mainFrameEvent(firstWindow)));
  assert.equal(registry.fromEvent(mainFrameEvent(secondWindow)), two);
});

test('switching vault invalidates captured operations and rotates attachment capabilities', async (t) => {
  const { root, otherRoot, registry } = await fixture(t);
  const original = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const oldToken = original.assetToken;
  const oldGeneration = original.generation;
  const captured = registry.capture('one');
  assert.equal(captured.store, original.store);
  assert.doesNotThrow(() => captured.assertCurrent());
  await registry.switchVault('one', otherRoot);
  const current = registry.get('one');
  assert.notEqual(current.store, captured.store);
  assert.notEqual(current.assetToken, oldToken);
  assert.notEqual(current.generation, oldGeneration);
  assert.equal(current.vaultPath, await fs.realpath(otherRoot));
  assert.throws(() => captured.assertCurrent(), { code: 'VAULT_CHANGED' });
  const nextCapture = registry.capture('one');
  assert.equal(nextCapture.store, current.store);
  assert.doesNotThrow(() => nextCapture.assertCurrent());
  await registry.remove('one');
  assert.throws(() => nextCapture.assertCurrent(), { code: 'VAULT_CHANGED' });
});

test('workspace state is isolated by window and vault and survives registry recreation', async (t) => {
  const { root, otherRoot, registry, newRegistry } = await fixture(t);
  await registry.add({ id: 'one', vaultPath: root, send() {} });
  await registry.add({ id: 'two', vaultPath: root, send() {} });
  const firstWorkspace = { activePath: 'One.md', tabs: ['One.md'], layout: 'split' };
  const secondWorkspace = { activePath: 'Two.md', tabs: ['Two.md'] };
  const otherWorkspace = { activePath: 'Other.md', tabs: ['Other.md'] };
  await Promise.all([
    registry.saveWorkspace('one', firstWorkspace),
    registry.saveWorkspace('two', secondWorkspace),
  ]);
  assert.deepEqual(await registry.loadWorkspace('one'), firstWorkspace);
  assert.deepEqual(await registry.loadWorkspace('two'), secondWorkspace);
  await registry.switchVault('one', otherRoot);
  assert.deepEqual(await registry.loadWorkspace('one'), {});
  await registry.saveWorkspace('one', otherWorkspace);
  await registry.switchVault('one', root);
  assert.deepEqual(await registry.loadWorkspace('one'), firstWorkspace);
  assert.deepEqual(await registry.loadWorkspace('two'), secondWorkspace);
  await registry.close();

  const reopened = newRegistry();
  await reopened.add({ id: 'one', vaultPath: root, send() {} });
  await reopened.add({ id: 'two', vaultPath: root, send() {} });
  assert.deepEqual(await reopened.loadWorkspace('one'), firstWorkspace);
  assert.deepEqual(await reopened.loadWorkspace('two'), secondWorkspace);
  await reopened.switchVault('one', otherRoot);
  assert.deepEqual(await reopened.loadWorkspace('one'), otherWorkspace);
});

test('removing one window keeps its shared store alive until the final owner leaves', async (t) => {
  const { root, registry } = await fixture(t);
  const one = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const two = await registry.add({ id: 'two', vaultPath: root, send() {} });
  const close = t.mock.method(one.store, 'close');
  await registry.remove('one');
  assert.equal(close.mock.callCount(), 0);
  await two.store.create('Still open.md', 'the second window still works');
  assert.equal((await two.store.read('Still open.md')).content, 'the second window still works');
  await registry.remove('two');
  assert.equal(close.mock.callCount(), 1);
  await registry.close();
  assert.equal(close.mock.callCount(), 1);
});

test('switching into a shared vault transfers references without closing another window store', async (t) => {
  const { root, otherRoot, registry } = await fixture(t);
  const one = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const two = await registry.add({ id: 'two', vaultPath: root, send() {} });
  const three = await registry.add({ id: 'three', vaultPath: otherRoot, send() {} });
  const closeFirst = t.mock.method(one.store, 'close');
  const closeOther = t.mock.method(three.store, 'close');
  await registry.switchVault('one', otherRoot);
  assert.equal(registry.get('one').store, three.store);
  assert.equal(closeFirst.mock.callCount(), 0);
  assert.equal(closeOther.mock.callCount(), 0);
  await registry.remove('two');
  assert.equal(closeFirst.mock.callCount(), 1);
  await registry.remove('three');
  assert.equal(closeOther.mock.callCount(), 0);
  await registry.close();
  assert.equal(closeFirst.mock.callCount(), 1);
  assert.equal(closeOther.mock.callCount(), 1);
});

test('simultaneous saves from shared windows accept exactly one matching old mtime', async (t) => {
  const { root, registry } = await fixture(t);
  const one = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const two = await registry.add({ id: 'two', vaultPath: root, send() {} });
  await one.store.create('Race.md', 'original');
  const previous = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(path.join(root, 'Race.md'), previous, previous);
  const original = await one.store.read('Race.md');
  const results = await Promise.allSettled([
    one.store.write('Race.md', 'first window', original.mtime),
    two.store.write('Race.md', 'second window', original.mtime),
  ]);
  const succeeded = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(succeeded.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'MTIME_CONFLICT');
  const winner = results[0].status === 'fulfilled' ? 'first window' : 'second window';
  assert.equal((await one.store.read('Race.md')).content, winner);
});

test('invalid expected mtimes cannot disable concurrency checks', async (t) => {
  const { root, registry } = await fixture(t);
  const { store } = await registry.add({ id: 'one', vaultPath: root, send() {} });
  await store.create('Protected.md', 'preserve these bytes');
  for (const expectedMtime of [NaN, Infinity, -Infinity, 'not-a-number']) {
    await assert.rejects(async () => store.write('Protected.md', 'must never be written', expectedMtime));
    assert.equal((await store.read('Protected.md')).content, 'preserve these bytes');
  }
});

test('content versions detect an external change that preserves both size and mtime', async (t) => {
  const { root, registry } = await fixture(t);
  const { store } = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const notePath = path.join(root, 'Versioned.md');
  await store.create('Versioned.md', 'original');
  const previous = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(notePath, previous, previous);
  const original = await store.read('Versioned.md');
  assert.notEqual(original.version, undefined);
  assert.notEqual(original.version, null);
  await fs.writeFile(notePath, 'changed!');
  await fs.utimes(notePath, previous, previous);
  const changed = await store.read('Versioned.md');
  assert.equal(changed.mtime, original.mtime);
  assert.equal(Buffer.byteLength(changed.content), Buffer.byteLength(original.content));
  assert.notDeepEqual(changed.version, original.version);
  await assert.rejects(
    async () => store.write('Versioned.md', 'stale editor', original.mtime, original.version),
    (error) => ['MTIME_CONFLICT', 'VERSION_CONFLICT'].includes(error.code),
  );
  assert.equal((await store.read('Versioned.md')).content, 'changed!');
  await store.write('Versioned.md', 'saved current version', changed.mtime, changed.version);
  assert.equal((await store.read('Versioned.md')).content, 'saved current version');
});

test('removing an unfinished add rejects it and releases the newly opened store once', async (t) => {
  const { root, registry } = await fixture(t);
  const [slot] = holdAcquisitions(t, registry);
  const adding = registry.add({ id: 'one', vaultPath: root, send() {} });
  const rejected = assert.rejects(adding, { code: 'VAULT_CHANGED' });
  const lease = await slot.ready.promise;
  const close = t.mock.method(lease.store, 'close');
  await registry.remove('one');
  assert.throws(() => registry.get('one'));
  slot.proceed.resolve();
  await rejected;
  assert.equal(close.mock.callCount(), 1);
  assert.equal(registry.leases.size, 0);
  await registry.close();
  assert.equal(close.mock.callCount(), 1);
});

test('a canceled add cannot delete a replacement window using the same identity', async (t) => {
  const { root, registry } = await fixture(t);
  const [slot] = holdAcquisitions(t, registry);
  const adding = registry.add({ id: 'one', vaultPath: root, send() {} });
  const rejected = assert.rejects(adding, { code: 'VAULT_CHANGED' });
  const lease = await slot.ready.promise;
  const close = t.mock.method(lease.store, 'close');
  await registry.remove('one');
  const replacement = await registry.add({ id: 'one', vaultPath: root, send() {} });
  slot.proceed.resolve();
  await rejected;
  assert.equal(registry.get('one'), replacement);
  assert.equal(close.mock.callCount(), 0);
  await registry.remove('one');
  assert.equal(close.mock.callCount(), 1);
});

test('canceling one pending opener does not close a store another opener is about to adopt', async (t) => {
  const { root, registry } = await fixture(t);
  const [first, second] = holdAcquisitions(t, registry, 2);
  const canceled = registry.add({ id: 'one', vaultPath: root, send() {} });
  const rejected = assert.rejects(canceled, { code: 'VAULT_CHANGED' });
  const surviving = registry.add({ id: 'two', vaultPath: root, send() {} });
  surviving.catch(() => {});
  const [lease, sharedLease] = await Promise.all([first.ready.promise, second.ready.promise]);
  assert.equal(lease, sharedLease);
  const close = t.mock.method(lease.store, 'close');
  await registry.remove('one');
  first.proceed.resolve();
  await rejected;
  assert.equal(close.mock.callCount(), 0);
  second.proceed.resolve();
  const survivor = await surviving;
  assert.equal(survivor.store, lease.store);
  assert.equal(survivor.store.closed, false);
  await survivor.store.create('Alive.md', 'still observed');
  await registry.remove('two');
  assert.equal(close.mock.callCount(), 1);
});

test('canceling every pending opener closes their shared store exactly once', async (t) => {
  const { root, registry } = await fixture(t);
  const [first, second] = holdAcquisitions(t, registry, 2);
  const one = registry.add({ id: 'one', vaultPath: root, send() {} });
  const two = registry.add({ id: 'two', vaultPath: root, send() {} });
  const rejected = Promise.all([assert.rejects(one, { code: 'VAULT_CHANGED' }), assert.rejects(two, { code: 'VAULT_CHANGED' })]);
  const [lease, sharedLease] = await Promise.all([first.ready.promise, second.ready.promise]);
  assert.equal(lease, sharedLease);
  const close = t.mock.method(lease.store, 'close');
  await registry.remove('one');
  await registry.remove('two');
  first.proceed.resolve();
  second.proceed.resolve();
  await rejected;
  assert.equal(close.mock.callCount(), 1);
  assert.equal(registry.leases.size, 0);
});

test('overlapping switches run in order and release only abandoned vault references', async (t) => {
  const { root, otherRoot, registry } = await fixture(t);
  const thirdRoot = path.join(path.dirname(root), 'Third vault');
  await fs.mkdir(thirdRoot);
  const context = await registry.add({ id: 'one', vaultPath: root, send() {} });
  await registry.add({ id: 'anchor', vaultPath: root, send() {} });
  const oldStore = context.store;
  const closeOld = t.mock.method(oldStore, 'close');
  const [first, second] = holdAcquisitions(t, registry, 2);
  const changedRoots = [];
  registry.on('context-changed', (changed) => changedRoots.push(changed.vaultPath));
  const toSecond = registry.switchVault('one', otherRoot);
  const secondLease = await first.ready.promise;
  const closeSecond = t.mock.method(secondLease.store, 'close');
  const toThird = registry.switchVault('one', thirdRoot);
  first.proceed.resolve();
  await toSecond;
  const thirdLease = await second.ready.promise;
  const closeThird = t.mock.method(thirdLease.store, 'close');
  assert.equal(registry.get('one').store, secondLease.store);
  second.proceed.resolve();
  await toThird;
  assert.equal(registry.get('one').store, thirdLease.store);
  assert.deepEqual(changedRoots, [await fs.realpath(otherRoot), await fs.realpath(thirdRoot)]);
  assert.equal(closeOld.mock.callCount(), 0);
  assert.equal(closeSecond.mock.callCount(), 1);
  assert.equal(closeThird.mock.callCount(), 0);
  await registry.remove('anchor');
  assert.equal(closeOld.mock.callCount(), 1);
  await registry.close();
  assert.equal(closeSecond.mock.callCount(), 1);
  assert.equal(closeThird.mock.callCount(), 1);
});

test('removal during a switch closes the original and pending destination once', async (t) => {
  const { root, otherRoot, registry } = await fixture(t);
  const context = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const closeOld = t.mock.method(context.store, 'close');
  const [slot] = holdAcquisitions(t, registry);
  const switching = registry.switchVault('one', otherRoot);
  const rejected = assert.rejects(switching, { code: 'VAULT_CHANGED' });
  const destination = await slot.ready.promise;
  const closeNew = t.mock.method(destination.store, 'close');
  await registry.remove('one');
  assert.equal(closeOld.mock.callCount(), 1);
  slot.proceed.resolve();
  await rejected;
  assert.equal(closeNew.mock.callCount(), 1);
  assert.equal(registry.contexts.size, 0);
  assert.equal(registry.leases.size, 0);
});

test('a failed switch does not poison a later queued switch', async (t) => {
  const { root, otherRoot, registry } = await fixture(t);
  const context = await registry.add({ id: 'one', vaultPath: root, send() {} });
  const closeOld = t.mock.method(context.store, 'close');
  const results = await Promise.allSettled([
    registry.switchVault('one', path.join(otherRoot, 'Missing vault')),
    registry.switchVault('one', otherRoot),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(registry.get('one').vaultPath, await fs.realpath(otherRoot));
  assert.equal(closeOld.mock.callCount(), 1);
  assert.equal(registry.leases.size, 1);
});

test('closing a registry drains unfinished acquisitions and rejects new window additions', async (t) => {
  const { root, registry } = await fixture(t);
  const [slot] = holdAcquisitions(t, registry);
  const adding = registry.add({ id: 'one', vaultPath: root, send() {} });
  const rejected = assert.rejects(adding, { code: 'VAULT_CHANGED' });
  const lease = await slot.ready.promise;
  const close = t.mock.method(lease.store, 'close');
  let finished = false;
  const closing = registry.close().then(() => { finished = true; });
  await setImmediate();
  assert.equal(finished, false);
  await assert.rejects(registry.add({ id: 'late', vaultPath: root, send() {} }));
  slot.proceed.resolve();
  await Promise.all([rejected, closing]);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(registry.contexts.size, 0);
  assert.equal(registry.leases.size, 0);
  assert.equal(registry.opening.size, 0);
});
