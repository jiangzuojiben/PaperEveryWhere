import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { VaultStore } from '../desktop/vault-store.mjs';
import { cloudRequest, syncVault } from '../desktop/sync.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-sync-'));
  const stores = [];
  for (const name of ['device-a','device-b']) {
    await fs.mkdir(path.join(root, name));
    stores.push(await VaultStore.open(path.join(root, name), { watchFiles: false }));
  }
  const events = [];
  const files = new Map();
  const server = http.createServer(async (request, response) => {
    try {
      response.setHeader('Content-Type', 'application/json');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.endsWith('/changes')) {
        const cursor = Number(url.searchParams.get('cursor'));
        const page = events.filter((item) => item.revision > cursor).slice(0, 2);
        const nextCursor = page.at(-1)?.revision || events.length;
        response.end(JSON.stringify({ changes: page, cursor: nextCursor, has_more: nextCursor < events.length }));
        return;
      }
      let input = '';
      for await (const chunk of request) input += chunk;
      const data = JSON.parse(input);
      const current = files.get(data.path);
      if (data.base_revision !== (current?.revision || 0)) {
        response.statusCode = 409;
        response.end(JSON.stringify({ detail: { code:'revision_conflict', current_revision: current?.revision || 0 } }));
        return;
      }
      const event = { ...data, revision: events.length + 1, deleted: request.method === 'DELETE' };
      events.push(event); files.set(data.path, event);
      response.end(JSON.stringify(event));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ message: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const store of stores) store.close();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vaultdesk-sync-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { a: stores[0], b: stores[1], files, events, config: { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'local-test-token', vaultId: 'test-vault' } };
}

test('two devices sync text, binary, local edits and tombstones incrementally', async (t) => {
  const { a, b, config, events } = await fixture(t);
  const bytes = Buffer.from([0, 255, 42, 3, 200]);
  await a.create('Note.md', 'initial');
  await a.createBytes('image.bin', bytes);
  await a.create('Third.md', 'third');
  assert.equal((await syncVault(a, config)).uploaded, 3);
  assert.equal((await syncVault(b, config)).downloaded, 3);
  assert.equal((await b.read('Note.md')).content, 'initial');
  assert.deepEqual((await b.readBytes('image.bin')).data, bytes);
  await a.write('Note.md', 'normal edit after own previous upload');
  const edited = await syncVault(a, config);
  assert.equal(edited.conflicts.length, 0);
  assert.equal(edited.uploaded, 1);
  await syncVault(b, config);
  assert.equal((await b.read('Note.md')).content, 'normal edit after own previous upload');
  await b.trash('Third.md');
  await syncVault(b, config);
  await syncVault(a, config);
  await assert.rejects(a.read('Third.md'), { code: 'ENOENT' });
  const count = events.length;
  await syncVault(a, config); await syncVault(b, config);
  assert.equal(events.length, count);
  await a.create('Third.md', 'recreated after tombstone');
  await syncVault(a, config); await syncVault(b, config);
  assert.equal((await b.read('Third.md')).content, 'recreated after tombstone');
});

test('simultaneous offline edits preserve both contents as synchronized conflict copies', async (t) => {
  const { a, b, config } = await fixture(t);
  await a.create('Note.md', 'initial');
  await syncVault(a, config); await syncVault(b, config);
  await a.write('Note.md', 'edit from a'); await b.write('Note.md', 'edit from b');
  await syncVault(a, config);
  const result = await syncVault(b, config);
  assert.equal(result.conflicts.length, 1);
  assert.equal((await b.read('Note.md')).content, 'edit from a');
  assert.equal((await b.read(result.conflicts[0])).content, 'edit from b');
  await syncVault(a, config);
  assert.equal((await a.read(result.conflicts[0])).content, 'edit from b');
});

test('delete versus remote edit preserves the edited bytes and propagates the deletion', async (t) => {
  const { a, b, config } = await fixture(t);
  await a.create('Note.md', 'initial');
  await syncVault(a, config); await syncVault(b, config);
  await b.trash('Note.md');
  await a.write('Note.md', 'remote newer'); await syncVault(a, config);
  const result = await syncVault(b, config);
  assert.equal(result.conflicts.length, 1);
  await assert.rejects(b.read('Note.md'), { code:'ENOENT' });
  assert.equal((await b.read(result.conflicts[0])).content, 'remote newer');
  await syncVault(a, config);
  await assert.rejects(a.read('Note.md'), { code:'ENOENT' });
  assert.equal((await a.read(result.conflicts[0])).content, 'remote newer');
});

test('untrusted remote paths cannot write outside the vault or protected metadata', async (t) => {
  const { a, config, events } = await fixture(t);
  events.push({ path:'../escape.md', revision:1, deleted:false, content:'escape', encoding:'utf8' });
  await assert.rejects(syncVault(a, config), /unsafe|relative/);
  assert.equal((await a.snapshot()).files.length, 0);
  await assert.rejects(cloudRequest(config, '//another-origin/steal'), /Invalid service/);
  await assert.rejects(cloudRequest({ ...config, baseUrl:'file:///tmp' }, '/health'), /Invalid self-hosted/);
});
