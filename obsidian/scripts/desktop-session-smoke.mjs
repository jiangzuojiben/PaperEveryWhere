import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `session-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const output = path.join(root, 'output', runId);
const executable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const report = { runId, output, checks: [], launches: [] };
const children = new Set();
const sockets = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let running;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(operation, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; }
    catch (error) { if (error.fatal) throw error; last = error; }
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
  const events = new Map();
  const waiting = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    } else if (message.method) {
      const waiter = waiting.get(message.method)?.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message.params); }
      else {
        const queue = events.get(message.method) || [];
        queue.push(message.params); events.set(message.method, queue);
      }
    }
  });
  socket.addEventListener('close', () => {
    sockets.delete(socket);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP connection closed')); }
    for (const queue of waiting.values()) for (const waiter of queue) { clearTimeout(waiter.timer); waiter.reject(new Error('CDP connection closed')); }
    pending.clear(); waiting.clear();
  });
  return {
    socket,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    event(method) {
      const queued = events.get(method);
      if (queued?.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => {
        const queue = waiting.get(method) || [];
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = queue.indexOf(waiter); if (index >= 0) queue.splice(index, 1);
          reject(new Error(`CDP event ${method} timed out`));
        }, 20000);
        queue.push(waiter); waiting.set(method, queue);
      });
    },
    async eval(expression) {
      const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    },
  };
}

function fixturePath(...parts) {
  const destination = path.resolve(output, ...parts);
  const relative = path.relative(output, destination);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Synthetic fixture must remain inside this run output');
  return destination;
}

async function moveFixture(source, destination) {
  for (const candidate of [source, destination]) {
    const relative = path.relative(output, path.resolve(candidate));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Synthetic move must stay inside this run output');
  }
  await fs.rename(source, destination);
}

async function seedSession(name, windows) {
  const session = `${runId}-${name}`;
  const userData = path.join(os.tmpdir(), `VaultDesk-Test-${session}`);
  assert.equal(path.dirname(path.resolve(userData)), path.resolve(os.tmpdir()));
  assert.equal(path.basename(userData), `VaultDesk-Test-${session}`);
  await fs.mkdir(userData, { recursive: true });
  const configFile = path.join(userData, 'desktop.json');
  await fs.writeFile(configFile, JSON.stringify({ version: 2, activeWindowId: windows[0].id, windows }, null, 2), { flag: 'wx' });
  return { session, userData, configFile };
}

function startupReady(run) {
  for (const line of run.logs.split(/\r?\n/)) {
    try { const event = JSON.parse(line); if (event.event === 'vaultdesk-ready') return event; } catch { /* Native diagnostics are not JSON. */ }
  }
  return null;
}

async function launch(fixture, label, explicitVault) {
  const rendererPort = await freePort();
  let inspectorPort = await freePort();
  while (inspectorPort === rendererPort) inspectorPort = await freePort();
  const env = { ...process.env, VAULTDESK_TEST_MODE: '1', VAULTDESK_TEST_SESSION: fixture.session, VAULTDESK_TEST_RESTORE: '1', VAULTDESK_VAULT: explicitVault };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VAULTDESK_DEV_URL;
  const child = spawn(executable, [root, `--remote-debugging-port=${rendererPort}`, '--remote-debugging-address=127.0.0.1', `--inspect-brk=127.0.0.1:${inspectorPort}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, fixture, label, rendererPort, inspectorPort, logs: '', connections: new Map(), launchError: null };
  running = run;
  children.add(child); child.once('exit', () => children.delete(child)); child.once('error', (error) => { run.launchError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { run.logs += chunk.toString(); });
  const ensureAlive = () => {
    if (run.launchError || child.exitCode !== null || child.signalCode !== null) throw Object.assign(new Error(run.launchError?.message || `Electron exited early: ${run.logs}`), { fatal: true });
  };
  const targets = await until(async () => {
    ensureAlive();
    const list = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json();
    return list[0]?.webSocketDebuggerUrl && list;
  }, `${label}: main inspector`);
  run.main = await connect(targets[0].webSocketDebuggerUrl);
  const paused = run.main.event('Debugger.paused');
  await run.main.call('Debugger.enable');
  await run.main.call('Runtime.runIfWaitingForDebugger');
  const frame = (await paused).callFrames[0];
  const injected = await run.main.call('Debugger.evaluateOnCallFrame', {
    callFrameId: frame.callFrameId,
    returnByValue: true,
    expression: `(() => {
      if (process.pid !== ${child.pid} || process.env.VAULTDESK_TEST_SESSION !== ${JSON.stringify(fixture.session)} || process.env.VAULTDESK_TEST_MODE !== '1') throw new Error('Refusing to instrument a nonmatching process');
      const load = process.getBuiltinModule('node:module').createRequire(${JSON.stringify(path.join(root, 'desktop', 'main.cjs'))});
      const electron = load('electron');
      const filesystem = load('node:fs/promises');
      const paths = load('node:path');
      const config = ${JSON.stringify(fixture.configFile)};
      const state = globalThis.__vaultdeskSessionSmoke = { dialogs: [], errors: [], readyWindowIds: [], writes: [] };
      electron.dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        state.dialogs.push({ type: options.type, title: options.title, message: options.message });
        return { response: 0, checkboxChecked: false };
      };
      electron.dialog.showErrorBox = (title, message) => { state.errors.push({ title, message }); console.error('SYNTHETIC_STARTUP_ERROR', title, message); };
      const originalLog = console.log;
      console.log = (...args) => {
        try { const entry = JSON.parse(args[0]); if (entry.event === 'vaultdesk-window-ready') state.readyWindowIds.push(entry.windowId); } catch {}
        originalLog.apply(console, args);
      };
      const originalRename = filesystem.rename;
      filesystem.rename = async (source, destination) => {
        if (paths.resolve(String(destination)) !== paths.resolve(config)) return originalRename(source, destination);
        const next = JSON.parse(await filesystem.readFile(source, 'utf8'));
        const readyWindowIds = [...state.readyWindowIds];
        const result = await originalRename(source, destination);
        state.writes.push({ readyWindowIds, windows: next.windows });
        return result;
      };
      return { pid: process.pid, session: process.env.VAULTDESK_TEST_SESSION, electron: process.versions.electron };
    })()`,
  });
  if (injected.exceptionDetails) throw new Error(injected.exceptionDetails.exception?.description || injected.exceptionDetails.text);
  assert.equal(injected.result.value.pid, child.pid);
  assert.equal(injected.result.value.electron, '42.11.9');
  run.identity = injected.result.value;
  await run.main.call('Debugger.resume');
  await run.main.call('Debugger.disable');
  run.ready = await until(() => { ensureAlive(); return startupReady(run); }, `${label}: application startup`);
  await refreshWindows(run);
  run.instrumentation = await run.main.eval('globalThis.__vaultdeskSessionSmoke');
  assert.deepEqual(run.instrumentation.errors, []);
  report.launches.push({ label, ...run.identity, userData: fixture.userData, windows: run.ready.windows, instrumentation: run.instrumentation });
  return run;
}

async function refreshWindows(run) {
  await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${run.rendererPort}/json/list`)).json();
    for (const target of targets.filter((entry) => entry.type === 'page' && /index\.html/.test(entry.url))) {
      if ([...run.connections.values()].some((entry) => entry.targetId === target.id)) continue;
      const client = await connect(target.webSocketDebuggerUrl);
      const info = await until(() => client.eval('window.vaultdesk && vaultdesk.windowInfo()'), 'Renderer preload bridge');
      run.connections.set(info.windowId, { ...client, targetId: target.id, info });
    }
    return run.connections.size === run.ready.windows.length;
  }, `${run.label}: native windows`);
}

async function quit(run) {
  if (run.main) await run.main.eval("setImmediate(() => process.mainModule.require('electron').app.quit()); true").catch(() => {});
  run.main?.socket.close();
  for (const connection of run.connections.values()) connection.socket.close();
  await until(() => run.child.exitCode !== null || run.child.signalCode !== null, `${run.label}: graceful quit`, 15000);
  await fs.writeFile(path.join(output, `${run.label}.log`), run.logs);
  if (running === run) running = null;
}

async function saved(fixture) { return JSON.parse(await fs.readFile(fixture.configFile, 'utf8')); }
function check(name, detail) { report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); }

try {
  await fs.mkdir(output, { recursive: true });
  const valid = fixturePath('partial', 'valid');
  const returning = fixturePath('partial', 'returning');
  const disconnected = fixturePath('partial', 'disconnected-copy');
  const last = fixturePath('partial', 'last');
  for (const directory of [valid, returning, last]) await fs.mkdir(directory, { recursive: true });
  for (const [directory, text] of [[valid, '# First vault'], [returning, '# Reconnected vault'], [last, '# Last vault']]) await fs.writeFile(path.join(directory, 'Note.md'), text);
  await fs.mkdir(path.join(returning, '.vaultdesk'));
  await fs.writeFile(path.join(returning, '.vaultdesk', 'workspace-returning.json'), JSON.stringify({ panes: [{ tabs: ['Note.md'], active: 'Note.md' }], settings: { fontSize: 29 } }));
  await moveFixture(returning, disconnected);
  const partialRecords = [{ id: 'valid', vaultPath: valid }, { id: 'returning', vaultPath: returning }, { id: 'last', vaultPath: last }];
  const partial = await seedSession('partial', partialRecords);
  const first = await launch(partial, 'partial-missing', valid);
  assert.deepEqual(new Set(first.connections.keys()), new Set(['valid', 'last']));
  assert.equal((await first.connections.get('valid').eval("vaultdesk.read('Note.md')")).content, '# First vault');
  assert.equal((await first.connections.get('last').eval("vaultdesk.read('Note.md')")).content, '# Last vault');
  assert.equal(first.instrumentation.dialogs.length, 1);
  assert.match(first.instrumentation.dialogs[0].message, /returning/);
  const firstWrites = first.instrumentation.writes;
  assert.ok(firstWrites.length > 0);
  for (const write of firstWrites) {
    assert.deepEqual(new Set(write.readyWindowIds), new Set(['valid', 'last']));
    assert.deepEqual(new Set(write.windows.map((record) => record.id)), new Set(['valid', 'returning', 'last']));
  }
  assert.deepEqual(new Set((await saved(partial)).windows.map((record) => record.id)), new Set(['valid', 'returning', 'last']));
  check('partial restore opens available vaults and retains the unavailable window identity');
  check('session persistence waits until all available restore windows are ready', { writes: firstWrites.length });
  await quit(first);

  await moveFixture(disconnected, returning);
  const restored = await launch(partial, 'partial-reconnected', valid);
  assert.deepEqual(new Set(restored.connections.keys()), new Set(['valid', 'returning', 'last']));
  assert.equal((await restored.connections.get('returning').eval("vaultdesk.read('Note.md')")).content, '# Reconnected vault');
  assert.equal((await restored.connections.get('returning').eval('vaultdesk.loadWorkspace()')).settings.fontSize, 29);
  assert.deepEqual(restored.instrumentation.dialogs, []);
  check('reconnecting a missing vault restores its original window and saved workspace');
  await quit(restored);

  const missingA = fixturePath('all-missing', 'unavailable-a');
  const missingB = fixturePath('all-missing', 'unavailable-b');
  const unavailable = [{ id: 'unavailable-a', vaultPath: missingA }, { id: 'unavailable-b', vaultPath: missingB }];
  const allMissing = await seedSession('all', unavailable);
  const fallback = await launch(allMissing, 'all-missing-fallback', valid);
  assert.equal(fallback.connections.size, 1);
  const welcome = [...fallback.connections.values()][0];
  assert.equal(welcome.info.vaultPath, path.join(allMissing.userData, 'Welcome Vault'));
  assert.match((await welcome.eval("vaultdesk.read('Welcome.md')")).content, /Welcome to VaultDesk/);
  assert.equal(fallback.instrumentation.dialogs.length, 1);
  assert.match(fallback.instrumentation.dialogs[0].message, /unavailable-a/);
  assert.match(fallback.instrumentation.dialogs[0].message, /unavailable-b/);
  const fallbackIds = new Set(['unavailable-a', 'unavailable-b', welcome.info.windowId]);
  assert.deepEqual(new Set((await saved(allMissing)).windows.map((record) => record.id)), fallbackIds);
  for (const source of [missingA, missingB]) await assert.rejects(fs.access(source), { code: 'ENOENT' });
  check('all missing vaults open a usable Welcome vault and preserve unavailable records');
  await quit(fallback);

  const repeated = await launch(allMissing, 'all-missing-restart', valid);
  assert.deepEqual(new Set(repeated.connections.keys()), new Set([welcome.info.windowId]));
  assert.deepEqual(new Set((await saved(allMissing)).windows.map((record) => record.id)), fallbackIds);
  check('a second launch reuses the Welcome window without duplicating or losing session records');
  await quit(repeated);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack || error.message; process.exitCode = 1;
  console.error(report.error);
} finally {
  if (running) {
    try {
      if (!running.ready) {
        running.child.kill();
        await fs.writeFile(path.join(output, `${running.label}.log`), running.logs);
      } else await quit(running);
    }
    catch {
      running.child.kill();
      await fs.writeFile(path.join(output, `${running.label}.log`), running.logs).catch(() => {});
    }
  }
  for (const socket of sockets) socket.close();
  // Kill only child handles spawned by this smoke run, never an existing Electron process.
  for (const child of children) child.kill();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: path.join(output, 'report.json') }));
}
