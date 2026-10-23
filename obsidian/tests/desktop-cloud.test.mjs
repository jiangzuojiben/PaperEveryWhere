import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { VaultStore } from '../desktop/vault-store.mjs';
import { cloudRequest, syncVault } from '../desktop/sync.mjs';
import { listenForFetch } from './helpers/http-listener.mjs';

test('desktop sync interoperates with the real self-hosted service', { skip: process.env.VAULTDESK_CLOUD_INTEGRATION !== '1', timeout: 30000 }, async (t) => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const python = process.env.VAULTDESK_CLOUD_PYTHON || path.join(project, '..', '.venv', 'Scripts', 'python.exe');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-real-cloud-'));
  const portProbe = net.createServer();
  await listenForFetch(portProbe);
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const child = spawn(python, ['-m','uvicorn','cloud.app:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers'], { cwd: project, env: { ...process.env, VAULTDESK_DB: path.join(directory, 'service.sqlite3') }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    if (child.exitCode === null && !child.killed) {
      const stopped = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await stopped;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('vaultdesk-real-cloud-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const config = { baseUrl: `http://127.0.0.1:${port}` };
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(log);
    try { await cloudRequest(config, '/health'); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, `Cloud service did not start: ${log}`);
  const auth = await cloudRequest(config, '/auth/register', { method:'POST', body:{email:'integration@example.test',password:'isolated-test-password-123'} });
  config.token = auth.token;
  config.vaultId = (await cloudRequest(config, '/vaults', { method:'POST', body:{name:'Isolated desktop test'} })).id;
  for (const name of ['device-a','device-b']) {
    await fs.mkdir(path.join(directory, name));
    stores.push(await VaultStore.open(path.join(directory, name), { watchFiles: false }));
  }
  const [a,b] = stores;
  await a.create('文档/测试.md', '# Real service\n\nBody');
  const binary = Buffer.from([0,255,127,64,0]);
  await a.createBytes('附件/image.bin', binary);
  assert.equal((await syncVault(a, config)).uploaded, 2);
  assert.equal((await syncVault(b, config)).downloaded, 2);
  assert.equal((await b.read('文档/测试.md')).content, '# Real service\n\nBody');
  assert.deepEqual((await b.readBytes('附件/image.bin')).data, binary);
  await a.write('文档/测试.md', 'new content a'); await b.write('文档/测试.md', 'new content b');
  await syncVault(a, config);
  const conflict = await syncVault(b, config);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal((await b.read(conflict.conflicts[0])).content, 'new content b');
  await syncVault(a, config);
  assert.equal((await a.read(conflict.conflicts[0])).content, 'new content b');
  await b.trash('附件/image.bin'); await syncVault(b, config); await syncVault(a, config);
  await assert.rejects(a.readBytes('附件/image.bin'), { code:'ENOENT' });
  const history = await cloudRequest(config, `/vaults/${config.vaultId}/history?path=${encodeURIComponent('文档/测试.md')}`);
  assert.ok(history.history.length >= 2);
});
