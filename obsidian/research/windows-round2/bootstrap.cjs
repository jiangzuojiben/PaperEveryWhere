// Independent laboratory shell; loads the pinned original core without modifying it.
const fs = require('node:fs');
const diskFs = require('original-fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const electron = require('electron');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'run-config.json'), 'utf8'));
const { app, ipcMain, shell, session } = electron;
const journal = (kind, value) => fs.appendFileSync(config.hostLog, JSON.stringify({ time: new Date().toISOString(), kind, value }) + '\n');
const sum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
journal('boot', { pid: process.pid, vault: config.vault });
if (sum(diskFs.readFileSync(config.coreAsar)) !== config.coreSha256) throw Error('Original core identity mismatch');
app.setName('obsidian-rea-round2');
app.setPath('userData', config.profile);
app.setPath('sessionData', path.join(config.profile, 'session'));
app.setAppPath(config.shellAsar);
const req = createRequire(path.join(config.shellAsar, 'main.js'));
electron.remote = req('@electron/remote/main');
electron.remote.initialize();
electron.protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);
const loopback = value => { try { const u = new URL(String(value)); return ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; } };
// No installed-app URL association, remote cloud, account, or updater access.
for (const method of ['setAsDefaultProtocolClient', 'removeAsDefaultProtocolClient']) app[method] = (...args) => { journal('blocked-os-registration', { method, args }); return false; };
shell.openExternal = async url => { journal('blocked-open-external', String(url)); throw Error('Laboratory external navigation blocked'); };
for (const protocol of ['http', 'https']) {
  const module = require('node:' + protocol), original = module.request;
  module.request = function (...args) {
    const value = args[0], target = typeof value === 'string' || value instanceof URL ? String(value) : `${value.protocol || protocol + ':'}//${value.hostname || value.host || 'localhost'}:${value.port || ''}${value.path || '/'}`;
    if (!loopback(target)) { journal('blocked-node-network', target); throw Error('Laboratory remote HTTP blocked'); }
    return original.apply(this, args);
  };
  module.get = function (...args) { const request = module.request(...args); request.end(); return request; };
}
app.on('session-created', created => created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
  const allowed = loopback(details.url);
  if (!allowed) journal('blocked-renderer-network', details.url);
  callback({ cancel: !allowed });
}));
process.on('uncaughtException', error => journal('error', String(error.stack || error)));
process.on('unhandledRejection', error => journal('unhandled-rejection', String(error?.stack || error)));
ipcMain.handle('round2:capture', async (event, name) => {
  if (!/^[a-z0-9-]+$/.test(name)) throw Error('Unsafe capture name');
  const win = electron.BrowserWindow.fromWebContents(event.sender);
  // A hidden Chromium compositor may return an old frame. Show without focus,
  // wait for a fresh paint, capture, and then restore this laboratory window.
  const wasVisible = win.isVisible();
  win.removeAllListeners('show');
  if (!wasVisible) win.showInactive();
  await new Promise(resolve => setTimeout(resolve, 350));
  const bytes = (await event.sender.capturePage()).toPNG();
  if (!wasVisible) win.hide();
  const file = path.join(config.run, name + '.png');
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  const result = { name: name + '.png', sha256: sum(bytes), bytes: bytes.length };
  journal('screenshot', result); return result;
});
ipcMain.handle('round2:key', async (event, keyCode) => {
  if (!['Escape', 'Right', 'Left', 'Home', 'End'].includes(keyCode)) throw Error('Unsupported laboratory key');
  event.sender.sendInputEvent({ type: 'keyDown', keyCode });
  event.sender.sendInputEvent({ type: 'keyUp', keyCode });
});
ipcMain.handle('round2:windows', () => electron.BrowserWindow.getAllWindows().map(win => ({ id: win.id, url: win.webContents.getURL(), bounds: win.getBounds() })));
ipcMain.on('round2:report', (event, result) => {
  const body = JSON.stringify(result, null, 2);
  fs.writeFileSync(config.report, body, { flag: 'wx' });
  journal('report', { sha256: sum(body), status: result.status, cases: result.results.length });
  event.sender.send('round2:report-written', sum(body));
});
let installed = false;
app.on('browser-window-created', (_, win) => {
  journal('window-created', win.id);
  win.webContents.setBackgroundThrottling(false);
  win.on('show', () => win.hide());
  win.webContents.on('console-message', (_, level, message) => journal('renderer-console', { level, message }));
  win.webContents.on('did-finish-load', () => {
    journal('loaded', { id: win.id, url: win.webContents.getURL() });
    if (installed || !win.webContents.getURL().includes('index.html')) return;
    installed = true;
    win.webContents.executeJavaScript(`(${fs.readFileSync(config.probe, 'utf8')})(${JSON.stringify(config)})`).catch(error => journal('inject-error', String(error.stack || error)));
  });
});
app.whenReady().then(() => journal('environment', { versions: process.versions, userData: app.getPath('userData'), appPath: app.getAppPath() }));
setInterval(() => { if (fs.existsSync(path.join(config.run, 'stop.signal'))) app.quit(); }, 150).unref();
setTimeout(() => { journal('watchdog', '240s reached'); app.quit(); }, 240000).unref();
require(path.join(config.coreAsar, 'main.js'))(config.coreAsar, new EventEmitter());
