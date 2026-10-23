import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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

test('snapshot bounds parallel reads and preserves depth-first order, content versions and per-file failures', async (t) => {
  const { root, store } = await fixture(t);
  const children = Array.from({ length: 32 }, (_, index) => `Folder/${String(index + 1).padStart(2, '0')}.md`);
  await fs.mkdir(path.join(root, 'Folder'));
  await Promise.all(['00-root.md', ...children, 'zz-root.md'].map((name) => fs.writeFile(path.join(root, name), `content:${name}`)));
  const originalRead = store.readBytes.bind(store);
  let concurrent = 0, maximum = 0;
  const warnings = [];
  store.on('warning', (warning) => warnings.push(warning));
  store.readBytes = async (name) => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    try {
      await new Promise((resolve) => setTimeout(resolve, name.endsWith('01.md') ? 30 : 5));
      if (name.endsWith('07.md')) throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' });
      if (name.endsWith('09.md')) throw Object.assign(new Error('file is unreadable'), { code: 'EACCES' });
      return await originalRead(name);
    } finally { concurrent--; }
  };
  const snapshot = await store.snapshot();
  assert.ok(maximum > 1 && maximum <= 16, `Unexpected active read count ${maximum}`);
  assert.deepEqual(snapshot.files.map((file) => file.path), ['00-root.md', 'Folder', ...children.filter((name) => !/\/(07|09)\.md$/.test(name)), 'zz-root.md']);
  assert.deepEqual(warnings.map((entry) => entry.path), ['Folder/09.md']);
  for (const file of snapshot.files.filter((entry) => !entry.isDirectory)) {
    assert.equal(file.content, `content:${file.path}`);
    assert.equal(file.version, crypto.createHash('sha256').update(file.content).digest('hex'));
    assert.equal(file.size, Buffer.byteLength(file.content));
    assert.equal(file.text, file.content);
  }
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

test('trash rejects same-timestamp edits before and after recording history', async (t) => {
  const { root, store } = await fixture(t);
  for (const duringHistory of [false, true]) {
    const relative = duringHistory ? 'ChangedDuringHistory.md' : 'ChangedBeforeTrash.md';
    const created = await store.create(relative, 'original source');
    const overwrite = async () => {
      const absolute = path.join(root, relative);
      await fs.writeFile(absolute, 'new external source');
      await fs.utimes(absolute, new Date(), new Date(created.mtime));
      assert.equal((await store.read(relative)).mtime, created.mtime);
    };
    const recordHistory = store.recordHistory.bind(store);
    if (duringHistory) {
      store.recordHistory = async (name) => { await recordHistory(name); await overwrite(); };
    } else await overwrite();
    try {
      await assert.rejects(store.trash(relative, created.mtime, created.version), { code: 'VERSION_CONFLICT' });
      assert.equal((await store.read(relative)).content, 'new external source');
    } finally { store.recordHistory = recordHistory; }
  }
});

test('workspace saves commit in request order without blocking another window state', async (t) => {
  const { store } = await fixture(t);
  const originalWrite = store.writeInternal.bind(store);
  let releaseFirst, signalStarted;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { signalStarted = resolve; });
  store.writeInternal = async (relative, value) => {
    if (relative === 'workspace-first.json' && value.sequence === 1) { signalStarted(); await blocked; }
    return originalWrite(relative, value);
  };
  const older = store.saveState('workspace-first', { sequence: 1 });
  await started;
  const latest = store.saveState('workspace-first', { sequence: 2 });
  await store.saveState('workspace-other', { sequence: 3 });
  assert.deepEqual(await store.loadState('workspace-other'), { sequence: 3 });
  releaseFirst();
  await Promise.all([older, latest]);
  assert.deepEqual(await store.loadState('workspace-first'), { sequence: 2 });
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

test('history previews return original text and binary metadata while rejecting unsafe revisions', async (t) => {
  const { root, store } = await fixture(t);
  await store.create('Notes/历史.md', '# 旧版\n保留内容');
  await store.write('Notes/历史.md', '# 当前版本');
  const [revision] = await store.getHistory('Notes/历史.md');
  const preview = await store.readHistory('Notes\\历史.md', revision.id);
  assert.equal(preview.content, '# 旧版\n保留内容');
  assert.equal(preview.encoding, 'utf8');
  assert.equal(preview.size, Buffer.byteLength(preview.content));
  assert.equal((await store.read('Notes/历史.md')).content, '# 当前版本');
  await store.createBytes('image.bin', Buffer.from([0, 255, 10]));
  await store.writeBytes('image.bin', Buffer.from([1, 2]));
  const [binary] = await store.getHistory('image.bin');
  assert.deepEqual(await store.readHistory('image.bin', binary.id), { ...binary, encoding: 'base64' });
  for (const invalid of ['../index', 'a/b', 'a\\b', '', null, {}]) await assert.rejects(store.readHistory('Notes/历史.md', invalid), /Invalid history revision/);
  await assert.rejects(store.readHistory('../outside.md', revision.id), /unsafe/);
  await assert.rejects(store.readHistory('image.bin', revision.id), /not found/);
  const historyFolder = path.join(root, '.vaultdesk', 'history');
  // Tampering with the indexed bytes must never silently overwrite the live file.
  for (const name of await fs.readdir(historyFolder)) {
    const file = path.join(historyFolder, name, `${revision.id}.bin`);
    if (await fs.stat(file).then(() => true, () => false)) await fs.writeFile(file, 'damaged');
  }
  await assert.rejects(store.readHistory('Notes/历史.md', revision.id), { code: 'HISTORY_CORRUPT' });
  await assert.rejects(store.restoreHistory('Notes/历史.md', revision.id), { code: 'HISTORY_CORRUPT' });
  assert.equal((await store.read('Notes/历史.md')).content, '# 当前版本');
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
