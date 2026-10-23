import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `windows-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const output = path.join(root, 'output', runId);
const userData = path.join(os.tmpdir(), `VaultDesk-Test-${runId}`);
const vaultA = path.join(output, 'vault-a'), vaultB = path.join(output, 'vault-b');
const sources = path.join(output, 'import-source');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { runId, output, userData, checks: [] };
const children = new Set(), sockets = new Set();
let running;
let syncServer;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(operation, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`${description} timed out${last ? `: ${last.message}` : ''}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  sockets.add(socket);
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); clearTimeout(callback.timer); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); }
  });
  socket.addEventListener('close', () => { sockets.delete(socket); for (const callback of pending.values()) { clearTimeout(callback.timer); callback.reject(new Error('CDP connection closed')); } pending.clear(); });
  return {
    socket,
    call(method, params = {}) {
      return new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    },
    async eval(expression) {
      const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    },
  };
}

async function launch() {
  const rendererPort = await freePort(), inspectorPort = await freePort();
  const env = { ...process.env, VAULTDESK_TEST_MODE: '1', VAULTDESK_TEST_SESSION: runId, VAULTDESK_TEST_RESTORE: '1', VAULTDESK_VAULT: vaultA };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VAULTDESK_DEV_URL;
  const executable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(executable, [root, `--remote-debugging-port=${rendererPort}`, '--remote-debugging-address=127.0.0.1', `--inspect=127.0.0.1:${inspectorPort}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.once('exit', () => children.delete(child));
  const run = { child, rendererPort, inspectorPort, logs: '', connections: new Map() };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { run.logs += chunk.toString(); });
  await until(() => { if (child.exitCode !== null) throw new Error(run.logs); return run.logs.includes('"event":"vaultdesk-ready"'); }, 'Electron startup');
  const targets = await until(async () => { const value = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json(); return value[0]?.webSocketDebuggerUrl && value; }, 'Main inspector');
  run.main = await connect(targets[0].webSocketDebuggerUrl);
  report.runtime = await run.main.eval('process.versions');
  running = run;
  await refreshWindows(run);
  return run;
}

async function refreshWindows(run) {
  const targets = await (await fetch(`http://127.0.0.1:${run.rendererPort}/json/list`)).json();
  for (const target of targets.filter((entry) => entry.type === 'page' && /index\.html/.test(entry.url))) {
    if ([...run.connections.values()].some((entry) => entry.targetId === target.id)) continue;
    const client = await connect(target.webSocketDebuggerUrl);
    const info = await until(() => client.eval('window.vaultdesk && window.vaultdesk.windowInfo()'), 'Preload bridge');
    run.connections.set(info.windowId, { ...client, targetId: target.id, info });
  }
  return run.connections;
}

async function quit(run) {
  // A loopback main-process inspector belongs only to this synthetic smoke run.
  await run.main.eval("process.mainModule.require('electron').app.quit(); true").catch(() => {});
  run.main.socket.close();
  for (const entry of run.connections.values()) entry.socket.close();
  await until(() => run.child.exitCode !== null, 'Electron graceful quit', 15000);
  await fs.appendFile(path.join(output, 'electron.log'), run.logs);
  if (running === run) running = null;
}

function checked(name, detail) { report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); }

try {
  for (const directory of [vaultA, vaultB, sources, userData]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(vaultA, 'Note.md'), '# A\n');
  await fs.writeFile(path.join(vaultB, 'Note.md'), '# B\n');
  await fs.writeFile(path.join(vaultA, 'asset.bin'), Buffer.from([0, 1, 2, 128, 255]));
  await fs.writeFile(path.join(sources, 'native.bin'), Buffer.from([255, 10, 0, 20, 128]));
  await fs.writeFile(path.join(userData, 'desktop.json'), JSON.stringify({ version: 2, activeWindowId: 'smoke-a', windows: [
    { id: 'smoke-a', vaultPath: vaultA, bounds: { x: 30, y: 40, width: 1000, height: 700 } },
    { id: 'smoke-b', vaultPath: vaultB, bounds: { x: 80, y: 90, width: 1100, height: 720 } },
  ] }));
  const first = await launch();
  const a = first.connections.get('smoke-a'), b = first.connections.get('smoke-b');
  assert.ok(a && b);
  assert.equal((await a.eval("vaultdesk.read('Note.md')")).content, '# A\n');
  assert.equal((await b.eval("vaultdesk.read('Note.md')")).content, '# B\n');
  assert.equal((await a.eval('vaultdesk.listWindows()')).length, 1);
  checked('separate vaults have isolated content and window lists');

  const clone = await a.eval("vaultdesk.newWindow({path:'Note.md'})");
  await until(async () => { await refreshWindows(first); return first.connections.has(clone.windowId); }, 'Cloned window');
  const c = first.connections.get(clone.windowId);
  assert.equal((await a.eval('vaultdesk.listWindows()')).length, 2);
  assert.equal((await c.eval("vaultdesk.read('Note.md')")).content, '# A\n');
  checked('same vault opens in a second native window');
  await pause(500);

  for (const connection of [a, b, c]) await connection.eval('window.__smokeEvents=[]; window.__smokeUnsubscribe=vaultdesk.onChange(e=>window.__smokeEvents.push(e)); true');
  const original = await a.eval("vaultdesk.read('Note.md')");
  const write = (connection, value) => connection.eval(`vaultdesk.write('Note.md',${JSON.stringify(value)},${original.mtime},${JSON.stringify(original.version)}).then(value=>({ok:true,value}),error=>({ok:false,code:error.code}))`);
  const races = await Promise.all([write(a, '# first writer\n'), write(c, '# second writer\n')]);
  assert.equal(races.filter((entry) => entry.ok).length, 1);
  assert.ok(['MTIME_CONFLICT', 'VERSION_CONFLICT'].includes(races.find((entry) => !entry.ok).code));
  await pause(200);
  assert.ok((await a.eval('window.__smokeEvents')).some((event) => event.path === 'Note.md'));
  assert.ok((await c.eval('window.__smokeEvents')).some((event) => event.path === 'Note.md'));
  assert.ok(!(await b.eval('window.__smokeEvents')).some((event) => event.path === 'Note.md'));
  checked('simultaneous saves reject one stale writer and notify only the shared vault');

  const ownUrl = await a.eval("vaultdesk.assetUrl('asset.bin')");
  const cloneUrl = await c.eval("vaultdesk.assetUrl('asset.bin')");
  assert.notEqual(ownUrl, cloneUrl);
  assert.equal(await a.eval(`fetch(${JSON.stringify(ownUrl)}).then(r=>r.status)`), 200);
  assert.equal(await c.eval(`fetch(${JSON.stringify(ownUrl)}).then(r=>r.status)`), 404);
  assert.equal(await b.eval(`fetch(${JSON.stringify(ownUrl)}).then(r=>r.status)`), 404);
  checked('attachment capability URLs are limited to their owning window');

  await a.eval("document.body.insertAdjacentHTML('beforeend','<input id=smoke-native-file type=file hidden>'); true");
  const document = await a.call('DOM.getDocument');
  const input = await a.call('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#smoke-native-file' });
  await a.call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path.join(sources, 'native.bin')] });
  const imported = await a.eval("vaultdesk.importDroppedFiles([...document.querySelector('#smoke-native-file').files],'Attachments')");
  assert.equal(imported.length, 1);
  assert.deepEqual(await fs.readFile(path.join(vaultA, imported[0].path)), await fs.readFile(path.join(sources, 'native.bin')));
  assert.equal(await a.eval("vaultdesk.importDroppedFiles([new File(['fake'],'fabricated.txt')]).then(()=>false,()=>true)"), true);
  checked('native File objects import binary bytes and fabricated File objects are rejected');

  const syncEvents = [], syncFiles = new Map();
  syncServer = http.createServer(async (request, response) => {
    try {
      response.setHeader('Content-Type', 'application/json');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.endsWith('/changes')) {
        const cursor = Number(url.searchParams.get('cursor'));
        response.end(JSON.stringify({ changes: syncEvents.filter((event) => event.revision > cursor), cursor: syncEvents.length, has_more: false })); return;
      }
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body), existing = syncFiles.get(input.path);
      if (input.base_revision !== (existing?.revision || 0)) { response.writeHead(409); response.end(JSON.stringify({ detail: { code: 'revision_conflict', current_revision: existing?.revision || 0 } })); return; }
      const event = { ...input, deleted: request.method === 'DELETE', revision: syncEvents.length + 1 };
      syncEvents.push(event); syncFiles.set(input.path, event); response.end(JSON.stringify(event));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ detail: error.message })); }
  });
  await new Promise((resolve) => syncServer.listen(0, '127.0.0.1', resolve));
  const syncConfig = { baseUrl: `http://127.0.0.1:${syncServer.address().port}`, token: 'synthetic-smoke-token', vaultId: 'smoke-vault', autoSync: false };
  await until(() => a.eval("!!document.querySelector('.cm-content')"), 'Editable note');
  await a.eval("document.querySelector('.cm-content').focus(); true");
  await a.call('Input.insertText', { text: 'prepared-before-sync\n' });
  const synced = await c.eval(`vaultdesk.sync(${JSON.stringify(syncConfig)})`);
  assert.ok(synced.uploaded >= 1);
  const uploadedNote = syncFiles.get('Note.md');
  assert.ok(uploadedNote);
  assert.match(Buffer.from(uploadedNote.content, uploadedNote.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'), /prepared-before-sync/);
  assert.ok((await a.eval('window.__smokeEvents')).some((event) => event.type === 'sync-before'));
  assert.ok((await c.eval('window.__smokeEvents')).some((event) => event.type === 'sync-before'));
  assert.ok(!(await b.eval('window.__smokeEvents')).some((event) => event.type === 'sync-before'));
  checked('sync in one window flushes a live editor draft in every shared-vault window before upload');

  const originalWorkspaces = await Promise.all([a.eval('vaultdesk.loadWorkspace()'), b.eval('vaultdesk.loadWorkspace()'), c.eval('vaultdesk.loadWorkspace()')]);
  for (const [index, connection] of [a, b, c].entries()) await connection.eval(`vaultdesk.saveWorkspace(${JSON.stringify({ ...originalWorkspaces[index], settings: { ...originalWorkspaces[index]?.settings, fontSize: 17 + index } })})`);
  for (const [index, connection] of [a, b, c].entries()) assert.equal((await connection.eval('vaultdesk.loadWorkspace()')).settings.fontSize, 17 + index);
  checked('each window saves an independent workspace');
  const backgrounds = await first.main.eval("process.mainModule.require('electron').BrowserWindow.getAllWindows().map(w=>({id:w.id,backgroundThrottling:w.webContents.getBackgroundThrottling()}))");
  assert.ok(backgrounds.length === 3 && backgrounds.every((item) => item.backgroundThrottling === false));
  checked('all native windows keep background processing enabled');
  await quit(first);
  const saved = JSON.parse(await fs.readFile(path.join(userData, 'desktop.json'), 'utf8'));
  assert.equal(saved.windows.length, 3);
  assert.deepEqual(new Set(saved.windows.map((entry) => entry.id)), new Set(['smoke-a', 'smoke-b', clone.windowId]));
  checked('graceful quit persists every open window');

  const second = await launch();
  assert.equal(second.connections.size, 3);
  for (const [index, id] of ['smoke-a', 'smoke-b', clone.windowId].entries()) {
    const directory = id === 'smoke-b' ? vaultB : vaultA;
    const workspace = JSON.parse(await fs.readFile(path.join(directory, '.vaultdesk', `workspace-${id}.json`), 'utf8'));
    assert.equal(workspace.settings.fontSize, 17 + index);
    await until(async () => await second.connections.get(id).eval("document.documentElement.style.getPropertyValue('--editor-font-size')") === `${17 + index}px`, 'Restored editor preferences');
  }
  checked('restart restores all native windows with stable identities and saved workspaces');
  await second.connections.get(clone.windowId).eval('window.close(); true').catch(() => {});
  await until(async () => JSON.parse(await fs.readFile(path.join(userData, 'desktop.json'), 'utf8')).windows.length === 2, 'Closed window removed from session');
  assert.match((await second.connections.get('smoke-a').eval("vaultdesk.read('Note.md')")).content, /prepared-before-sync/);
  checked('closing one shared-vault window preserves the remaining window and updates session');
  await quit(second);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack || error.message; process.exitCode = 1;
  console.error(report.error);
} finally {
  if (running) { try { await quit(running); } catch { running.child.kill(); } }
  for (const socket of sockets) socket.close();
  for (const child of children) child.kill();
  if (syncServer) { syncServer.closeAllConnections(); await new Promise((resolve) => syncServer.close(resolve)); }
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: path.join(output, 'report.json') }));
}
