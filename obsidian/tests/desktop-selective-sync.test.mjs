import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { VaultStore } from '../desktop/vault-store.mjs';
import { cloudRequest, createSyncController, isSyncPathIncluded, normalizeSyncOptions, syncVault } from '../desktop/sync.mjs';
import { listenForFetch } from './helpers/http-listener.mjs';

async function waitFor(condition, message, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await delay(15); }
  assert.fail(message);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-selective-sync-'));
  const stores = [];
  const controllers = [];
  for (const name of ['a', 'b']) {
    await fs.mkdir(path.join(root, name));
    stores.push(await VaultStore.open(path.join(root, name), { watchFiles: false }));
  }
  const events = [];
  const files = new Map();
  const control = { dropPut: false, dropDelete: false, failChanges: 0, changesStatus: 503, unauthorized: false, requests: [], changesRequests: 0 };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    control.requests.push({ method: request.method, path: url.pathname, time: Date.now() });
    if (control.unauthorized) { response.writeHead(401); response.end(JSON.stringify({ detail: 'Session expired' })); return; }
    if (url.pathname.endsWith('/changes')) {
      control.changesRequests++;
      if (control.failChanges > 0) {
        control.failChanges--;
        response.writeHead(control.changesStatus);
        response.end(JSON.stringify({ detail: 'Synthetic temporary service outage' }));
        return;
      }
      const cursor = Number(url.searchParams.get('cursor'));
      const page = events.filter(event => event.revision > cursor).slice(0, 2);
      const next = page.at(-1)?.revision || events.length;
      response.end(JSON.stringify({ changes: page, cursor: next, has_more: next < events.length }));
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const existing = files.get(input.path);
    if (input.base_revision !== (existing?.revision || 0)) {
      response.writeHead(409);
      response.end(JSON.stringify({ detail: { code: 'revision_conflict', current_revision: existing?.revision || 0 } }));
      return;
    }
    const event = { ...input, deleted: request.method === 'DELETE', revision: events.length + 1 };
    events.push(event); files.set(input.path, event);
    if (request.method === 'PUT' && control.dropPut || request.method === 'DELETE' && control.dropDelete) {
      control.dropPut = false; control.dropDelete = false;
      request.socket.destroy();
      return;
    }
    response.end(JSON.stringify(event));
  });
  await listenForFetch(server);
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, vaultId: 'synthetic-vault', token: 'synthetic-secret-token' };
  t.after(async () => {
    for (const controller of controllers) { const running = controller.current; controller.close(); await running?.catch(() => {}); }
    stores.forEach(store => store.close());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vaultdesk-selective-sync-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { a: stores[0], b: stores[1], events, files, config, control, controllers };
}

test('selection rules use bounded folder prefixes and attachment extension allowlists', () => {
  const config = { excludeFolders: ['Private/', 'private'], attachmentTypes: ['.PDF', 'png', 'pdf'] };
  assert.deepEqual(normalizeSyncOptions(config), { excludeFolders: ['private'], attachmentTypes: ['pdf', 'png'] });
  assert.equal(isSyncPathIncluded('PRIVATE/Note.md', config), false);
  assert.equal(isSyncPathIncluded('Privateer/Note.md', config), true);
  assert.equal(isSyncPathIncluded('Pictures/image.png', config), true);
  assert.equal(isSyncPathIncluded('Attachments/file.PDF', config), true);
  assert.equal(isSyncPathIncluded('Attachments/audio.mp3', config), false);
  assert.equal(isSyncPathIncluded('Notes/Board.canvas', { attachmentTypes: 'none' }), true);
  assert.equal(isSyncPathIncluded('Notes/Table.base', { attachmentTypes: 'none' }), true);
  assert.throws(() => normalizeSyncOptions({ excludeFolders: ['../outside'] }), /unsafe|relative/i);
  assert.throws(() => normalizeSyncOptions({ attachmentTypes: '*.pdf' }), /attachmentTypes/);
  assert.throws(() => normalizeSyncOptions({ syncSettings: true }), /credentials|settings/i);
});

test('Fetch-blocked service ports produce an actionable configuration error', async () => {
  await assert.rejects(cloudRequest({ baseUrl: 'http://127.0.0.1:6000' }, '/health'), error => error.code === 'SYNC_UNSAFE_PORT' && /8766/.test(error.message));
});

test('first selective sync omits uploads and downloads then includes previously skipped remote content', async t => {
  const { a, b, config, files } = await fixture(t);
  await a.create('Public/Note.md', 'public');
  await a.create('Private/Note.md', 'private');
  await a.createBytes('Attachments/paper.pdf', Buffer.from([0, 255, 2]));
  await a.createBytes('Attachments/recording.mp3', Buffer.from([1, 4, 7]));
  const selected = { ...config, excludeFolders: ['Private'], attachmentTypes: ['pdf'] };
  const upload = await syncVault(a, selected);
  assert.equal(upload.uploaded, 2);
  assert.equal(upload.skipped, 2);
  assert.equal(files.has('Private/Note.md'), false);
  assert.equal(files.has('Attachments/recording.mp3'), false);
  await syncVault(b, { ...config, attachmentTypes: 'none' });
  assert.equal((await b.read('Public/Note.md')).content, 'public');
  await assert.rejects(b.readBytes('Attachments/paper.pdf'), { code: 'ENOENT' });
  await syncVault(b, config);
  assert.deepEqual((await b.readBytes('Attachments/paper.pdf')).data, Buffer.from([0, 255, 2]));
  await syncVault(a, config);
  assert.equal(files.has('Private/Note.md'), true);
  assert.equal(files.has('Attachments/recording.mp3'), true);
});

test('excluding then deleting local cache never creates a tombstone when re-enabled unchanged', async t => {
  const { a, config, events, files } = await fixture(t);
  await a.create('Private/Keep.md', 'remote must survive');
  await syncVault(a, config);
  const excluded = { ...config, excludeFolders: ['Private'] };
  await syncVault(a, excluded);
  await a.trash('Private/Keep.md');
  await syncVault(a, excluded);
  assert.equal(events.length, 1);
  assert.equal(files.get('Private/Keep.md').deleted, false);
  const restored = await syncVault(a, config);
  assert.equal(restored.downloaded, 1);
  assert.equal(restored.deleted, 0);
  assert.equal((await a.read('Private/Keep.md')).content, 'remote must survive');
  assert.equal(events.length, 1);
});

test('remote edits while a folder is excluded are restored after a rule change and offline failure', async t => {
  const { a, b, config, control, events } = await fixture(t);
  await a.create('Private/Keep.md', 'initial');
  await syncVault(a, config); await syncVault(b, config);
  control.failChanges = 1;
  await assert.rejects(syncVault(a, { ...config, excludeFolders: ['Private'] }));
  await a.trash('Private/Keep.md');
  await b.write('Private/Keep.md', 'newer from another device');
  await syncVault(b, config);
  const restored = await syncVault(a, config);
  assert.equal(restored.conflicts.length, 0);
  assert.equal((await a.read('Private/Keep.md')).content, 'newer from another device');
  assert.equal(events.filter(event => event.deleted).length, 0);
});

test('attachment selection changes preserve remote files even when excluded local copies are removed', async t => {
  const { a, config, events } = await fixture(t);
  const bytes = Buffer.from([10, 0, 255, 3]);
  await a.createBytes('paper.pdf', bytes);
  await syncVault(a, config);
  await syncVault(a, { ...config, attachmentTypes: 'none' });
  await a.trash('paper.pdf');
  await syncVault(a, { ...config, attachmentTypes: 'none' });
  await syncVault(a, { ...config, attachmentTypes: ['pdf'] });
  assert.deepEqual((await a.readBytes('paper.pdf')).data, bytes);
  assert.equal(events.length, 1);
});

test('a committed upload with lost acknowledgement is reconciled without extra versions or conflicts', async t => {
  const { a, config, events, control } = await fixture(t);
  await a.create('Note.md', 'accepted remotely before network drops');
  control.dropPut = true;
  await assert.rejects(syncVault(a, config));
  assert.equal(events.length, 1);
  const retry = await syncVault(a, config);
  assert.equal(retry.uploaded, 0);
  assert.equal(retry.conflicts.length, 0);
  assert.equal(events.length, 1);
  assert.equal((await a.read('Note.md')).content, 'accepted remotely before network drops');
});

test('a committed deletion with lost acknowledgement is idempotent on retry', async t => {
  const { a, b, config, events, control } = await fixture(t);
  await a.create('Note.md', 'delete me');
  await syncVault(a, config); await syncVault(b, config);
  await a.trash('Note.md');
  control.dropDelete = true;
  await assert.rejects(syncVault(a, config));
  assert.equal(events.length, 2);
  await syncVault(a, config); await syncVault(b, config);
  assert.equal(events.length, 2);
  await assert.rejects(a.read('Note.md'), { code: 'ENOENT' });
  await assert.rejects(b.read('Note.md'), { code: 'ENOENT' });
});

test('progress can pause between file operations and resume without losing completed downloads', async t => {
  const { a, b, config } = await fixture(t);
  await a.create('A.md', 'first'); await a.create('B.md', 'second');
  await syncVault(a, config);
  const signal = new AbortController();
  const progress = [];
  await assert.rejects(syncVault(b, config, { signal: signal.signal, onProgress: event => {
    progress.push(event);
    if (event.phase === 'applying' && event.completed === 1) signal.abort();
  } }), error => error.code === 'SYNC_PAUSED');
  assert.equal((await b.read('A.md')).content, 'first');
  await assert.rejects(b.read('B.md'), { code: 'ENOENT' });
  const retry = await syncVault(b, config, { onProgress: event => progress.push(event) });
  assert.equal(retry.downloaded, 1);
  assert.equal(retry.conflicts.length, 0);
  assert.equal((await b.read('B.md')).content, 'second');
  assert.equal(progress.at(-1).phase, 'idle');
  assert.ok(progress.some(event => event.phase === 'paused'));
  assert.ok(!JSON.stringify(progress).includes(config.token));
});

test('one controller per store shares automatic sync, pause and resume across windows', async t => {
  const { a, config, files, controllers } = await fixture(t);
  const first = createSyncController(a, { debounceMs: 10 });
  const second = createSyncController(a);
  controllers.push(first);
  assert.equal(first, second);
  assert.equal(a.listenerCount('change'), 1);
  first.configure({ ...config, autoSync: true, intervalMs: 60000 });
  await waitFor(() => first.getStatus().lastSuccess, 'initial auto sync should finish');
  first.pause();
  await a.create('Paused.md', 'wait until resume');
  await delay(220);
  assert.equal(files.has('Paused.md'), false);
  await assert.rejects(first.syncNow(), error => error.code === 'SYNC_PAUSED');
  second.resume();
  await waitFor(() => files.has('Paused.md'), 'resume should upload pending content');
  await waitFor(() => !first.getStatus().running, 'resumed sync should settle');
  first.pause();
  assert.equal(first.getStatus().paused, true);
});

test('auto sync retries transient service failures and does not retry expired sessions in a loop', async t => {
  const { a, config, control, files, controllers } = await fixture(t);
  await a.create('Retry.md', 'only one committed revision');
  control.failChanges = 2;
  const statuses = [];
  const controller = createSyncController(a, { retryBaseMs: 30, retryMaxMs: 200, debounceMs: 10, onStatus: status => statuses.push(status) });
  controllers.push(controller);
  controller.configure({ ...config, autoSync: true, intervalMs: 60000 });
  await waitFor(() => files.has('Retry.md') && controller.getStatus().lastSuccess, 'temporary failures should retry automatically');
  assert.ok(statuses.some(status => status.phase === 'offline' && status.retryAttempt === 1));
  assert.ok(statuses.some(status => status.phase === 'offline' && status.retryAttempt === 2));
  controller.pause();
  control.unauthorized = true;
  controller.resume();
  await waitFor(() => controller.getStatus().phase === 'error' && !controller.getStatus().running, 'expired session should require user action');
  const requests = control.requests.length;
  await delay(250);
  assert.equal(control.requests.length, requests);
  assert.equal(controller.getStatus().nextRunAt, null);
});

test('the editor save handshake completes before any sync network or local reconciliation', async t => {
  const { a, config, files, control, controllers } = await fixture(t);
  await a.create('Draft.md', 'old on disk');
  let acknowledge;
  const saved = new Promise(resolve => { acknowledge = resolve; });
  const controller = createSyncController(a, { beforeSync: async () => { await saved; } });
  controllers.push(controller);
  controller.configure(config);
  const running = controller.syncNow();
  await waitFor(() => controller.getStatus().phase === 'preparing', 'controller should wait for the editor');
  assert.equal(control.requests.length, 0);
  await a.write('Draft.md', 'latest dirty editor buffer was flushed');
  acknowledge();
  await running;
  assert.equal(Buffer.from(files.get('Draft.md').content, 'base64').toString('utf8'), 'latest dirty editor buffer was flushed');
});

test('a failed or paused editor handshake does not touch the remote vault', async t => {
  const { a, config, control, controllers } = await fixture(t);
  const controller = createSyncController(a, { beforeSync: async () => { throw new Error('unsaved buffer conflicts with disk'); } });
  controllers.push(controller);
  controller.configure(config);
  await assert.rejects(controller.syncNow(), error => error.code === 'SYNC_BLOCKED');
  assert.equal(control.requests.length, 0);
  createSyncController(a, { beforeSync: () => new Promise(() => {}) });
  const running = controller.syncNow();
  await waitFor(() => controller.getStatus().phase === 'preparing', 'save handshake should start');
  controller.pause();
  await assert.rejects(running, error => error.code === 'SYNC_PAUSED');
  assert.equal(control.requests.length, 0);
  assert.equal(controller.getStatus().running, false);
});
