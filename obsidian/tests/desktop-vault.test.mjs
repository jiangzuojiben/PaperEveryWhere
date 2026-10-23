import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultStore, normalizeVaultPath } from '../desktop/vault-store.mjs';

async function removeTemporary(directory, prefix) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  await fs.rm(resolved, { recursive: true, force: true });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-host-'));
  const store = await VaultStore.open(root, { watchFiles: false });
  t.after(async () => { store.close(); await removeTemporary(root, 'vaultdesk-host-'); });
  return { root, store };
}

test('local files retain binary bytes and reject stale editor saves', async (t) => {
  const { root, store } = await fixture(t);
  const created = await store.create('Notes/First.md', '# First\n');
  assert.equal((await store.read('Notes/First.md')).content, '# First\n');
  await fs.writeFile(path.join(root, 'Notes', 'First.md'), '# External\n');
  await fs.utimes(path.join(root, 'Notes', 'First.md'), new Date(), new Date(Date.now() + 10000));
  await assert.rejects(store.write('Notes/First.md', 'stale', created.mtime), { code: 'MTIME_CONFLICT' });
  assert.equal((await store.read('Notes/First.md')).content, '# External\n');
  const bytes = Buffer.from([0, 255, 10, 0, 200]);
  await store.createBytes('Attachments/file.bin', bytes);
  assert.deepEqual((await store.readBytes('Attachments/file.bin')).data, bytes);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.files.find((file) => file.path === 'Notes/First.md').content, '# External\n');
  assert.equal(snapshot.files.find((file) => file.path === 'Attachments/file.bin').content, undefined);
  assert.ok(snapshot.files.some((file) => file.path === 'Notes' && file.isDirectory));
});

test('history, recycle bin and workspace survive reopen', async (t) => {
  const { root, store } = await fixture(t);
  await store.create('Note.md', 'version one');
  await store.write('Note.md', 'version two');
  const history = await store.getHistory('Note.md');
  assert.equal(history.length, 1);
  await store.restoreHistory('Note.md', history[0].id);
  assert.equal((await store.read('Note.md')).content, 'version one');
  const removed = await store.trash('Note.md');
  await assert.rejects(store.read('Note.md'), { code: 'ENOENT' });
  assert.equal((await store.listTrash())[0].path, 'Note.md');
  await store.restoreTrash(removed.trashId);
  assert.equal((await store.read('Note.md')).content, 'version one');
  await store.saveWorkspace({ activePath: 'Note.md', tabs: ['Note.md'] });
  const second = await VaultStore.open(root, { watchFiles: false });
  t.after(() => second.close());
  assert.deepEqual(await second.loadWorkspace(), { activePath: 'Note.md', tabs: ['Note.md'] });
  assert.equal((await second.snapshot()).files.some((file) => file.path.startsWith('.vaultdesk')), false);
});

test('file and folder rename preserve incoming and outgoing references', async (t) => {
  const { store } = await fixture(t);
  await store.create('Folder/Target.md', '# Target');
  await store.create('Source.md', '[[Folder/Target]]');
  await store.rename('Folder', 'Moved');
  assert.equal((await store.read('Source.md')).content, '[[Target]]');
  assert.equal((await store.read('Moved/Target.md')).content, '# Target');
  await assert.rejects(store.read('Folder/Target.md'), { code: 'ENOENT' });
  await assert.rejects(store.rename('Moved', 'Moved/Nested'), /itself/);
  await store.create('Existing.md', 'keep');
  await assert.rejects(store.rename('Moved/Target.md', 'Existing.md'), /exists/);
  assert.equal((await store.read('Existing.md')).content, 'keep');
  await store.mkdir('Empty');
  await store.rename('Empty', 'RenamedEmpty');
  assert.ok((await store.snapshot()).files.some((file) => file.path === 'RenamedEmpty' && file.isDirectory));
});

test('traversal, private metadata, Windows special paths and symlink escapes are rejected', async (t) => {
  const { root, store } = await fixture(t);
  for (const value of ['../outside.md','/tmp/file','C:\\temp\\file','a/../b','.obsidian/app.json','.vaultdesk/workspace.json','a/.git/config','CON.md','a:b','trailing.','a//b']) {
    assert.throws(() => normalizeVaultPath(value));
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-outside-'));
  t.after(() => removeTemporary(outside, 'vaultdesk-outside-'));
  await fs.writeFile(path.join(outside, 'secret.md'), 'do not modify');
  await fs.symlink(outside, path.join(root, 'Escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.read('Escape/secret.md'), /Symbolic links/);
  await assert.rejects(store.write('Escape/secret.md', 'changed'), /Symbolic links/);
  assert.equal((await store.snapshot()).files.some((file) => file.path.startsWith('Escape')), false);
  assert.equal(await fs.readFile(path.join(outside, 'secret.md'), 'utf8'), 'do not modify');
});

test('legacy Obsidian settings are read without being changed', async (t) => {
  const { root, store } = await fixture(t);
  await fs.mkdir(path.join(root, '.obsidian'));
  const original = '{"alwaysUpdateLinks":false,"theme":"obsidian"}';
  await fs.writeFile(path.join(root, '.obsidian', 'app.json'), original);
  assert.equal((await store.snapshot()).settings.alwaysUpdateLinks, false);
  await store.saveState('settings', { theme: 'moonstone' });
  assert.equal((await store.snapshot()).settings.theme, 'moonstone');
  assert.equal(await fs.readFile(path.join(root, '.obsidian', 'app.json'), 'utf8'), original);
});

test('file watcher reports external writes', async (t) => {
  const { root, store } = await fixture(t);
  store.startWatching();
  const observed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('File watcher did not report a change')), 6000);
    store.once('change', (change) => { clearTimeout(timer); resolve(change); });
  });
  await fs.writeFile(path.join(root, 'External.md'), 'external');
  assert.ok(await observed);
});
