/** Real HTTP integration smoke: desktop VaultStore + syncVault + FastAPI.
 * Uses only temporary synthetic data. Run from any cwd with Node 20+:
 *   node scripts/cloud-sync-smoke.mjs
 * Override Python with VAULTDESK_TEST_PYTHON when the project venv is elsewhere.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VaultStore } from '../desktop/vault-store.mjs';
import { cloudRequest, syncVault } from '../desktop/sync.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const outputPath = path.join(project, 'output', 'cloud-sync-smoke.json');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const started = Date.now();
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  transport: 'real loopback HTTP',
  components: ['cloud.app FastAPI/SQLite', 'desktop/vault-store.mjs', 'desktop/sync.mjs'],
  syntheticDataOnly: true,
  checks: [],
};
let temporaryRoot;
let service;
let port;
let serviceLogs = '';
let stores = [];
let stopping;

async function pythonExecutable() {
  if (process.env.VAULTDESK_TEST_PYTHON) return process.env.VAULTDESK_TEST_PYTHON;
  const suffix = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const directory of [path.resolve(project, '..', '.venv'), path.join(project, '.venv')]) {
    const candidate = path.join(directory, ...suffix);
    if (await fs.access(candidate).then(() => true, () => false)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function stopService() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (!service || service.exitCode !== null || service.signalCode !== null) return;
    service.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (service.exitCode === null && service.signalCode === null && Date.now() < deadline) await delay(50);
    if (service.exitCode === null && service.signalCode === null) {
      service.kill('SIGKILL');
      const forcedDeadline = Date.now() + 3000;
      while (service.exitCode === null && service.signalCode === null && Date.now() < forcedDeadline) await delay(50);
    }
    assert.ok(service.exitCode !== null || service.signalCode !== null, 'Owned service process must exit');
  })();
  return stopping;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  void stopService();
});

async function startService() {
  const python = await pythonExecutable();
  service = spawn(python, ['-m', 'uvicorn', 'cloud.app:app', '--host', '127.0.0.1', '--port', '0', '--no-proxy-headers', '--no-access-log'], {
    cwd: project,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', VAULTDESK_DB: path.join(temporaryRoot, 'cloud.sqlite3'), VAULTDESK_ALLOW_REGISTRATION: 'true' },
  });
  let spawnError;
  service.once('error', (error) => { spawnError = error; });
  const capture = (chunk) => {
    serviceLogs = (serviceLogs + chunk.toString('utf8')).slice(-16000);
    const match = serviceLogs.match(/Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
  };
  service.stdout.on('data', capture);
  service.stderr.on('data', capture);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not start Python: ${spawnError.code || 'spawn failed'}`);
    if (service.exitCode !== null) throw new Error(`Cloud service exited during startup (${service.exitCode}); install cloud/requirements.txt`);
    if (port) {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (response?.ok) {
        assert.equal((await response.json()).service, 'vaultdesk');
        return `http://127.0.0.1:${port}`;
      }
    }
    await delay(100);
  }
  throw new Error('Cloud service did not become healthy within 20 seconds');
}

async function check(name, operation) {
  const begin = Date.now();
  try {
    const details = await operation();
    report.checks.push({ name, status: 'passed', durationMs: Date.now() - begin, ...(details || {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', durationMs: Date.now() - begin });
    throw error;
  }
}

async function fileMissing(store, name) {
  await assert.rejects(() => store.readBytes(name), (error) => error.code === 'ENOENT');
}

async function portClosed() {
  if (!port) return true;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(true); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
  });
}

try {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-cloud-sync-smoke-'));
  const baseUrl = await startService();
  report.checks.push({ name: 'temporary service startup', status: 'passed' });
  const config = { baseUrl };
  await check('account and remote vault API contract', async () => {
    const email = `sync-smoke-${crypto.randomBytes(8).toString('hex')}@example.test`;
    const credentials = { email, password: `Synthetic-only-${crypto.randomBytes(24).toString('hex')}` };
    const registration = await cloudRequest(config, '/auth/register', { method: 'POST', body: credentials });
    assert.equal(typeof registration.token, 'string');
    const login = await cloudRequest(config, '/auth/login', { method: 'POST', body: credentials });
    assert.equal(login.user.id, registration.user.id);
    config.token = login.token;
    await cloudRequest({ ...config, token: registration.token }, '/auth/logout', { method: 'POST' });
    const vault = await cloudRequest(config, '/vaults', { method: 'POST', body: { name: 'Synthetic desktop sync smoke' } });
    config.vaultId = vault.id;
    assert.ok((await cloudRequest(config, '/vaults')).vaults.some((item) => item.id === vault.id));
    return { registeredAndLoggedIn: true, isolatedRemoteVault: true };
  });
  const deviceAPath = path.join(temporaryRoot, 'device-a');
  const deviceBPath = path.join(temporaryRoot, 'device-b');
  await fs.mkdir(deviceAPath);
  await fs.mkdir(deviceBPath);
  const deviceA = await VaultStore.open(deviceAPath, { watchFiles: false });
  const deviceB = await VaultStore.open(deviceBPath, { watchFiles: false });
  stores = [deviceA, deviceB];
  const notePath = 'Notes/共享 note.md';
  const initialText = '# 合成测试\r\n\r\nUTF-8、CRLF 和 [[Publish]]。\r\n';
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n% synthetic integration attachment\n'), Buffer.from([0, 255, 128, 13, 10, 0, 254]), Buffer.from('\n%%EOF\n')]);
  const binaryPath = 'Attachments/synthetic.pdf';
  let initialRevision;
  await check('device A uploads and device B downloads text and PDF bytes', async () => {
    await deviceA.create(notePath, initialText);
    await deviceA.createBytes(binaryPath, pdfBytes);
    await deviceA.create('Publish.md', '# Public sample\n\n[Shared note](Notes/共享%20note.md)\n\n<script>globalThis.injected=true</script>\n\n[Bad](javascript:alert(1))\n');
    await deviceA.create('Private.md', 'Synthetic private content: never selected for publication.');
    const upload = await syncVault(deviceA, config);
    const download = await syncVault(deviceB, config);
    assert.equal(upload.uploaded, 4);
    assert.equal(download.downloaded, 4);
    assert.equal((await deviceB.read(notePath)).content, initialText);
    assert.deepEqual((await deviceB.readBytes(binaryPath)).data, pdfBytes);
    const remote = await cloudRequest(config, `/vaults/${config.vaultId}/files?path=${encodeURIComponent(notePath)}`);
    initialRevision = remote.revision;
    const secondPass = await syncVault(deviceB, config);
    assert.equal(secondPass.uploaded + secondPass.downloaded + secondPass.deleted, 0);
    return { uploaded: upload.uploaded, downloaded: download.downloaded, textExact: true, binaryExact: true, pdfBytes: pdfBytes.length, pdfSha256: sha256(pdfBytes), secondPassIdempotent: true };
  });
  await check('offline edits on both devices preserve a conflict copy', async () => {
    await deviceA.write(notePath, '# Device A edit\nA changed the shared note while offline.\n');
    await deviceB.write(notePath, '# Device B edit\nB changed the shared note while offline.\n');
    const aSync = await syncVault(deviceA, config);
    const bSync = await syncVault(deviceB, config);
    assert.equal(aSync.uploaded, 1);
    assert.equal(bSync.conflicts.length, 1);
    assert.equal((await deviceB.read(notePath)).content, '# Device A edit\nA changed the shared note while offline.\n');
    const conflictPath = bSync.conflicts[0];
    assert.equal((await deviceB.read(conflictPath)).content, '# Device B edit\nB changed the shared note while offline.\n');
    await syncVault(deviceA, config);
    assert.equal((await deviceA.read(conflictPath)).content, '# Device B edit\nB changed the shared note while offline.\n');
    return { conflictCopies: bSync.conflicts.length, bothEditsPreservedOnBothDevices: true };
  });
  await check('real stale revision rejects with the desktop conflict error shape', async () => {
    await assert.rejects(() => cloudRequest(config, `/vaults/${config.vaultId}/files`, {
      method: 'PUT', body: { path: notePath, encoding: 'utf8', content: 'stale synthetic write', base_revision: initialRevision },
    }), (error) => error.status === 409 && error.detail?.code === 'revision_conflict' && Number.isInteger(error.detail.current_revision));
    return { httpStatus: 409, code: 'revision_conflict' };
  });
  await check('deletion tombstone propagates without uploading local metadata', async () => {
    await deviceA.trash(binaryPath);
    const deletion = await syncVault(deviceA, config);
    await syncVault(deviceB, config);
    await fileMissing(deviceA, binaryPath);
    await fileMissing(deviceB, binaryPath);
    const changes = await cloudRequest(config, `/vaults/${config.vaultId}/changes?cursor=0`);
    assert.ok(changes.changes.some((item) => item.path === binaryPath && item.deleted));
    assert.ok(changes.changes.every((item) => !item.path.startsWith('.vaultdesk/') && !item.path.startsWith('.obsidian/')));
    return { propagatedDeletes: deletion.deleted, metadataRemainedLocal: true };
  });
  await check('cloud history restores text and deleted PDF onto both devices', async () => {
    const prefix = `/vaults/${config.vaultId}`;
    const current = await cloudRequest(config, `${prefix}/files?path=${encodeURIComponent(notePath)}`);
    const noteHistory = await cloudRequest(config, `${prefix}/history?path=${encodeURIComponent(notePath)}`);
    assert.ok(noteHistory.history.some((item) => item.revision === initialRevision));
    await cloudRequest(config, `${prefix}/restore`, { method: 'POST', body: { path: notePath, revision: initialRevision, base_revision: current.revision } });
    const binaryHistory = await cloudRequest(config, `${prefix}/history?path=${encodeURIComponent(binaryPath)}`);
    const deleted = binaryHistory.history.find((item) => item.deleted);
    const original = binaryHistory.history.find((item) => !item.deleted);
    assert.ok(deleted && original);
    await cloudRequest(config, `${prefix}/restore`, { method: 'POST', body: { path: binaryPath, revision: original.revision, base_revision: deleted.revision } });
    await syncVault(deviceA, config);
    await syncVault(deviceB, config);
    for (const device of stores) {
      assert.equal((await device.read(notePath)).content, initialText);
      assert.deepEqual((await device.readBytes(binaryPath)).data, pdfBytes);
    }
    return { textHistoryVersions: noteHistory.history.length, deletedBinaryRestored: true, bothDevicesExact: true };
  });
  await check('selected Publish renders safe HTML and excludes private files', async () => {
    const site = await cloudRequest(config, '/sites', { method: 'POST', body: { vault_id: config.vaultId, slug: `smoke-${crypto.randomBytes(6).toString('hex')}`, title: 'Synthetic smoke site', paths: ['Publish.md', notePath, binaryPath] } });
    const publicUrl = `${baseUrl}/p/${site.slug}`;
    const page = await fetch(`${publicUrl}/Publish.md`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy')?.includes("default-src 'none'"));
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!/<script[\s>]/i.test(html));
    assert.ok(!/href=["']javascript:/i.test(html));
    assert.equal((await fetch(`${publicUrl}/Private.md`)).status, 404);
    const publishedPdf = await fetch(`${publicUrl}/${binaryPath}`);
    assert.equal(publishedPdf.status, 200);
    assert.ok(publishedPdf.headers.get('content-disposition')?.startsWith('attachment;'));
    assert.deepEqual(Buffer.from(await publishedPdf.arrayBuffer()), pdfBytes);
    await deviceA.write('Publish.md', '# This revision is not yet public\n');
    await syncVault(deviceA, config);
    assert.ok(!(await (await fetch(`${publicUrl}/Publish.md`)).text()).includes('This revision is not yet public'));
    await cloudRequest(config, `/sites/${site.id}`, { method: 'PATCH', body: { paths: ['Publish.md'] } });
    assert.ok((await (await fetch(`${publicUrl}/Publish.md`)).text()).includes('This revision is not yet public'));
    assert.equal((await fetch(`${publicUrl}/${binaryPath}`)).status, 404);
    await cloudRequest(config, `/sites/${site.id}`, { method: 'DELETE' });
    assert.equal((await fetch(`${publicUrl}/Publish.md`)).status, 404);
    assert.equal((await fetch(`${publicUrl}/`)).status, 404);
    return { htmlSafe: true, selectedFilesOnly: true, snapshotStableUntilExplicitUpdate: true, binaryDownloadExact: true, explicitUpdateWorks: true, revokedImmediately: true };
  });
  await check('real incremental changes paginate and stay monotonic', async () => {
    let cursor = 0;
    let pages = 0;
    let events = 0;
    for (;;) {
      const page = await cloudRequest(config, `/vaults/${config.vaultId}/changes?cursor=${cursor}&limit=2`);
      assert.ok(page.changes.every((item, index, list) => item.revision > (index ? list[index - 1].revision : cursor)));
      assert.ok(page.cursor >= cursor);
      cursor = page.cursor;
      events += page.changes.length;
      pages++;
      if (!page.has_more) break;
      assert.ok(pages < 100, 'Pagination must terminate');
    }
    const empty = await cloudRequest(config, `/vaults/${config.vaultId}/changes?cursor=${cursor}`);
    assert.equal(empty.changes.length, 0);
    assert.equal(empty.has_more, false);
    assert.ok(pages > 1);
    assert.equal(events, cursor, 'Full event replay must not omit or duplicate a revision');
    return { pages, events, cursor, noDuplicateOrMissingRevision: events === cursor };
  });
  await check('logout invalidates the session after completed sync', async () => {
    await cloudRequest(config, '/auth/logout', { method: 'POST' });
    await assert.rejects(() => cloudRequest(config, '/vaults'), (error) => error.status === 401);
    return { revokedSessionStatus: 401 };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { name: error.name, code: error.code || null, message: String(error.message).replaceAll(project, '[project]').replaceAll(temporaryRoot || '\0', '[temporary]').slice(0, 1500) };
  console.error(`FAIL ${report.failure.name}: ${report.failure.message}`);
  process.exitCode = 1;
} finally {
  stores.forEach((store) => store.close());
  try {
    await stopService();
    const closed = await portClosed();
    assert.ok(closed, 'Owned loopback service port must be closed after cleanup');
    if (temporaryRoot) {
      // Strict boundary check before recursive deletion: only this mkdtemp result.
      const tempParent = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(temporaryRoot);
      assert.equal(path.dirname(resolved), tempParent);
      assert.ok(path.basename(resolved).startsWith('vaultdesk-cloud-sync-smoke-'));
      await fs.rm(resolved, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 });
    }
    report.cleanup = { ownedServiceStopped: true, loopbackPortClosed: closed, temporaryDataRemoved: true };
  } catch (error) {
    report.cleanup = { status: 'failed', message: String(error.message).replaceAll(temporaryRoot || '\0', '[temporary]').slice(0, 500) };
    report.status = 'failed';
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  report.passedChecks = report.checks.filter((item) => item.status === 'passed').length;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`${report.status.toUpperCase()}: ${report.passedChecks}/${report.checks.length} checks; summary output/cloud-sync-smoke.json`);
}
