import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultStore } from '../desktop/vault-store.mjs';
import { importExternalFiles, saveClipboardPng } from '../desktop/attachments.mjs';

const PREFIX = 'vaultdesk-attachments-';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
  const root = path.join(directory, 'Vault');
  const sources = path.join(directory, 'Sources');
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith(PREFIX));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await Promise.all([fs.mkdir(root), fs.mkdir(sources)]);
  const openStore = async () => {
    const store = await VaultStore.open(root, { watchFiles: false });
    stores.push(store);
    return store;
  };
  return { root, sources, store: await openStore(), openStore };
}

test('binary imports preserve source bytes and resolve duplicate names without overwriting', async (t) => {
  const { root, sources, store } = await fixture(t);
  const source = path.join(sources, 'sample.bin');
  const bytes = Buffer.from([0, 255, 10, 13, 128, 0, 254]);
  await fs.writeFile(source, bytes);
  const first = await importExternalFiles(store, [source], 'Attachments');
  const second = await importExternalFiles(store, [source], 'Attachments');
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].path, 'Attachments/sample.bin');
  assert.equal(second[0].path, 'Attachments/sample 1.bin');
  assert.equal(first[0].size, bytes.length);
  assert.equal(typeof first[0].mtime, 'number');
  assert.deepEqual((await store.readBytes(first[0].path)).data, bytes);
  assert.deepEqual((await store.readBytes(second[0].path)).data, bytes);
  assert.deepEqual(await fs.readFile(source), bytes);
  assert.deepEqual(await fs.readFile(path.join(root, 'Attachments', 'sample.bin')), bytes);
});

test('recursive imports retain folders and skip private metadata at every level', async (t) => {
  const { sources, store } = await fixture(t);
  const bundle = path.join(sources, 'Bundle');
  await fs.mkdir(path.join(bundle, 'Nested', 'Empty'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Read me.md'), '# Keep this note');
  await fs.writeFile(path.join(bundle, 'Nested', 'image.bin'), Buffer.from([2, 0, 255]));
  for (const privateDirectory of ['.vaultdesk', '.ObSiDiAn', '.GIT']) {
    await fs.mkdir(path.join(bundle, privateDirectory));
    await fs.writeFile(path.join(bundle, privateDirectory, 'private.txt'), 'do not import');
  }
  await fs.mkdir(path.join(bundle, 'Nested', '.git'));
  await fs.writeFile(path.join(bundle, 'Nested', '.git', 'config'), 'do not import');
  const imported = await importExternalFiles(store, [bundle], 'Attachments');
  assert.deepEqual(imported.map((entry) => entry.path).sort(), ['Attachments/Bundle/Nested/image.bin', 'Attachments/Bundle/Read me.md'].sort());
  const snapshot = await store.snapshot();
  assert.ok(snapshot.files.some((entry) => entry.path === 'Attachments/Bundle/Nested/Empty' && entry.isDirectory));
  assert.equal(snapshot.files.some((entry) => /private|config/.test(entry.path)), false);
  assert.equal((await store.read('Attachments/Bundle/Read me.md')).content, '# Keep this note');
  assert.equal(await fs.readFile(path.join(bundle, '.vaultdesk', 'private.txt'), 'utf8'), 'do not import');
  assert.deepEqual(await importExternalFiles(store, [path.join(bundle, '.vaultdesk')]), []);
  const again = await importExternalFiles(store, [bundle], 'Attachments');
  assert.ok(again.every((entry) => entry.path.startsWith('Attachments/Bundle 1/')));
});

test('junctions and symbolic links are never followed during import', async (t) => {
  const { sources, store } = await fixture(t);
  const bundle = path.join(sources, 'Bundle');
  const outside = path.join(sources, 'Outside');
  await Promise.all([fs.mkdir(bundle), fs.mkdir(outside)]);
  await fs.writeFile(path.join(bundle, 'Allowed.md'), 'allowed');
  await fs.writeFile(path.join(outside, 'secret.bin'), 'do not follow');
  const link = path.join(bundle, 'Linked folder');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const imported = await importExternalFiles(store, [bundle]);
  assert.deepEqual(imported.map((entry) => entry.path), ['Bundle/Allowed.md']);
  await assert.rejects(importExternalFiles(store, [link]), /links|junctions/i);
  await assert.rejects(importExternalFiles(store, [path.join(link, 'secret.bin')]), /links|junctions/i);
  assert.equal(await fs.readFile(path.join(outside, 'secret.bin'), 'utf8'), 'do not follow');
  assert.equal((await store.snapshot()).files.some((entry) => entry.path.includes('secret')), false);
});

test('destination traversal, private paths, and nonabsolute sources fail before copying', async (t) => {
  const { root, sources, store } = await fixture(t);
  const source = path.join(sources, 'Safe.bin');
  await fs.writeFile(source, 'source bytes');
  for (const destination of ['../escape', 'a/../escape', '.vaultdesk', 'a/.obsidian', root]) {
    await assert.rejects(importExternalFiles(store, [source], destination), (error) => {
      assert.deepEqual(error.imported, []);
      return true;
    });
  }
  await assert.rejects(importExternalFiles(store, ['Safe.bin']), /absolute/i);
  await assert.rejects(importExternalFiles(store, [source + '\0']), /absolute/i);
  await assert.rejects(importExternalFiles(store, source), /list/i);
  assert.deepEqual((await store.snapshot()).files, []);
  assert.equal(await fs.readFile(source, 'utf8'), 'source bytes');
});

test('a destination junction cannot redirect imported files outside the vault', async (t) => {
  const { root, sources, store } = await fixture(t);
  const outside = path.join(sources, 'Outside');
  await fs.mkdir(outside);
  const source = path.join(sources, 'Safe.bin');
  await fs.writeFile(source, 'keep within vault');
  await fs.symlink(outside, path.join(root, 'Escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(importExternalFiles(store, [source], 'Escape'), /links|junctions/i);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('parallel imports through independent stores retry only real name collisions', async (t) => {
  const { sources, store, openStore } = await fixture(t);
  const second = await openStore();
  const source = path.join(sources, 'Parallel.bin');
  const bytes = Buffer.from([9, 0, 255, 12]);
  await fs.writeFile(source, bytes);
  const results = (await Promise.all(Array.from({ length: 8 }, (_value, index) => importExternalFiles(index % 2 ? store : second, [source], 'Images')))).flat();
  assert.equal(new Set(results.map((entry) => entry.path)).size, 8);
  assert.equal(results.length, 8);
  for (const result of results) assert.deepEqual((await store.readBytes(result.path)).data, bytes);
  assert.deepEqual(await fs.readFile(source), bytes);
});

test('parallel directory imports get separate complete folder copies', async (t) => {
  const { sources, store, openStore } = await fixture(t);
  const second = await openStore();
  const source = path.join(sources, 'Bundle');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'Note.md'), '# Contents');
  const [first, another] = await Promise.all([
    importExternalFiles(store, [source]),
    importExternalFiles(second, [source]),
  ]);
  assert.notEqual(first[0].path, another[0].path);
  assert.deepEqual(new Set([first[0].path, another[0].path]), new Set(['Bundle/Note.md', 'Bundle 1/Note.md']));
  assert.equal((await store.read(first[0].path)).content, '# Contents');
  assert.equal((await store.read(another[0].path)).content, '# Contents');
});

test('a later import failure reports completed copies and does not retry permission errors', async (t) => {
  const { sources, store } = await fixture(t);
  const first = path.join(sources, 'First.bin');
  const second = path.join(sources, 'Second.bin');
  await fs.writeFile(first, 'first source');
  await fs.writeFile(second, 'second source');
  const createBytes = store.createBytes.bind(store);
  let calls = 0;
  t.mock.method(store, 'createBytes', async (relative, bytes) => {
    calls++;
    if (relative === 'Second.bin') throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return createBytes(relative, bytes);
  });
  await assert.rejects(importExternalFiles(store, [first, second]), (error) => {
    assert.equal(error.code, 'EACCES');
    assert.equal(error.imported.length, 1);
    assert.equal(error.imported[0].path, 'First.bin');
    return true;
  });
  assert.equal(calls, 2);
  assert.equal((await store.read('First.bin')).content, 'first source');
  assert.equal(await fs.readFile(second, 'utf8'), 'second source');
  await assert.rejects(store.read('Second.bin'), { code: 'ENOENT' });
});

test('clipboard PNG bytes are saved with unique names in the requested vault folder', async (t) => {
  const { store } = await fixture(t);
  const [first, second] = await Promise.all([
    saveClipboardPng(store, PNG, 'Images'),
    saveClipboardPng(store, new Uint8Array(PNG), 'Images'),
  ]);
  assert.notEqual(first.path, second.path);
  for (const saved of [first, second]) {
    assert.match(saved.path, /^Images\/Pasted image \d+-[a-f0-9]+\.png$/);
    assert.equal(saved.size, PNG.length);
    assert.deepEqual((await store.readBytes(saved.path)).data, PNG);
  }
});

test('invalid clipboard images and unsafe clipboard destinations create no attachments', async (t) => {
  const { store } = await fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.from('not png'), PNG.subarray(0, 7), 'not bytes']) {
    await assert.rejects(saveClipboardPng(store, bytes), /PNG|bytes/i);
  }
  await assert.rejects(saveClipboardPng(store, PNG, '../outside'));
  assert.deepEqual((await store.snapshot()).files, []);
});

test('the file-count limit is checked before any copy starts', { timeout: 60000 }, async (t) => {
  const { sources, store } = await fixture(t);
  const source = path.join(sources, 'One.bin');
  await fs.writeFile(source, 'one');
  await assert.rejects(importExternalFiles(store, Array(10001).fill(source)), (error) => {
    assert.match(error.message, /10000 files/);
    assert.deepEqual(error.imported, []);
    return true;
  });
  assert.deepEqual((await store.snapshot()).files, []);
});
