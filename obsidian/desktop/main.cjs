const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

app.setName('VaultDesk');
const testMode = process.env.VAULTDESK_TEST_MODE === '1';
app.setPath('userData', testMode ? path.join(os.tmpdir(), `VaultDesk-Test-${process.pid}`) : path.join(app.getPath('appData'), 'VaultDesk'));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
protocol.registerSchemesAsPrivileged([{ scheme: 'vaultdesk-asset', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let window;
let store;
let VaultStore;
let cloudRequest;
let syncVault;
let applyVaultdeskUri;
let readyForUris = false;
let uriQueue = Promise.resolve();
const pendingUris = process.argv.filter((argument) => /^vaultdesk:/i.test(argument));
let assetToken = crypto.randomBytes(16).toString('hex');
const appRoot = path.resolve(__dirname, '..');
const configFile = path.join(app.getPath('userData'), 'desktop.json');
const mimeTypes = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.avif':'image/avif', '.pdf':'application/pdf', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.mp4':'video/mp4', '.webm':'video/webm', '.txt':'text/plain', '.md':'text/plain' };

function receiveUri(value) {
  if (!readyForUris) { pendingUris.push(value); return; }
  uriQueue = uriQueue.then(async () => {
    try {
      if (!window || window.isDestroyed()) await createWindow();
      const event = await applyVaultdeskUri(store, value);
      window.webContents.send('vaultdesk:change', event);
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    } catch (error) {
      await dialog.showMessageBox(window, { type: 'error', title: 'VaultDesk link', message: error.message, buttons: ['OK'] });
    }
  });
}

app.on('open-url', (event, url) => { event.preventDefault(); receiveUri(url); });
app.on('second-instance', (_event, argv) => {
  for (const argument of argv) if (/^vaultdesk:/i.test(argument)) receiveUri(argument);
  if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); }
});

async function attachStore(nextStore) {
  store?.close();
  store = nextStore;
  assetToken = crypto.randomBytes(16).toString('hex');
  store.on('change', (change) => { if (window && !window.isDestroyed()) window.webContents.send('vaultdesk:change', change); });
  store.on('warning', (warning) => { if (window && !window.isDestroyed()) window.webContents.send('vaultdesk:change', { warning }); });
}

function assertRenderer(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}

function register(name, operation) {
  ipcMain.handle(`vaultdesk:${name}`, async (event, ...args) => {
    try {
      assertRenderer(event);
      return { ok: true, data: await operation(...args) };
    } catch (error) { return { ok: false, error: { message: error.message, code: error.code, status: error.status, currentMtime: error.currentMtime } }; }
  });
}

async function persistLastVault() {
  if (process.env.VAULTDESK_VAULT) return;
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify({ vaultPath: store.root }), { mode: 0o600 });
}

function installHandlers() {
  register('openVault', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Open local vault', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return store.snapshot();
    await attachStore(await VaultStore.open(result.filePaths[0]));
    await persistLastVault();
    return store.snapshot();
  });
  for (const name of ['snapshot','read','write','create','mkdir','rename','trash','saveWorkspace','loadWorkspace','getHistory','restoreHistory','listTrash','restoreTrash']) register(name, (...args) => store[name](...args));
  register('saveSettings', (value) => store.saveState('settings', value));
  register('writeClipboard', (value) => {
    if (typeof value !== 'string') throw new Error('Expected clipboard text');
    clipboard.writeText(value);
    return true;
  });
  register('writeBinary', (relative, base64) => {
    if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Expected base64-encoded attachment bytes');
    return store.createBytes(relative, Buffer.from(base64, 'base64'));
  });
  register('exportText', async (content, filename = 'Note.md') => {
    if (typeof content !== 'string' || typeof filename !== 'string') throw new Error('Expected text and a filename');
    const result = await dialog.showSaveDialog(window, { title: 'Export Markdown', defaultPath: path.join(app.getPath('documents'), path.basename(filename)), filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, content, 'utf8');
    return { canceled: false, path: result.filePath };
  });
  register('exportAttachment', async (relative) => {
    const source = await store.checkedPath(relative);
    if (!(await fs.stat(source)).isFile()) throw new Error('Expected an attachment file');
    const result = await dialog.showSaveDialog(window, { title: 'Export attachment', defaultPath: path.join(app.getPath('documents'), path.basename(relative)), filters: [{ name: 'All files', extensions: ['*'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const { data } = await store.readBytes(relative);
    await fs.writeFile(result.filePath, data);
    return { canceled: false, path: result.filePath };
  });
  register('importFiles', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Import attachments', properties: ['openFile','multiSelections'] });
    if (result.canceled) return [];
    const imported = [];
    for (const source of result.filePaths) {
      const info = await fs.lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Select regular files for import');
      const extension = path.extname(source);
      const stem = path.basename(source, extension);
      let destination = path.basename(source);
      for (let suffix = 1; ; suffix++) {
        try { await store.checkedPath(destination); destination = `${stem} ${suffix}${extension}`; }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
      }
      const content = await fs.readFile(source);
      imported.push(await store.createBytes(destination, content));
    }
    return imported;
  });
  register('assetUrl', async (relative) => {
    const target = await store.checkedPath(relative);
    if (!(await fs.stat(target)).isFile()) throw new Error('Expected an attachment');
    return `vaultdesk-asset://${assetToken}/${relative.replaceAll('\\','/').split('/').map(encodeURIComponent).join('/')}`;
  });
  register('openExternal', async (value) => {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported external URL');
    await shell.openExternal(url.href);
    return true;
  });
  register('cloudRequest', (config, endpoint, options) => cloudRequest(config, endpoint, options));
  register('sync', (config) => syncVault(store, config));
  register('platform', () => ({ platform: process.platform, version: app.getVersion(), vaultPath: store.root }));
}

async function installAssets() {
  protocol.handle('vaultdesk-asset', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== assetToken || url.search || url.hash) return new Response('Not found', { status: 404 });
      const relative = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
      const target = await store.checkedPath(relative);
      const stat = await fs.stat(target);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const contentType = mimeTypes[path.extname(relative).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' };
      let start = 0; let end = stat.size - 1; let status = 200;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : end; }
        else if (match[2]) start = Math.max(0, stat.size - Number(match[2]));
        if (start > end || start < 0 || end >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        status = 206;
      }
      const handle = await fs.open(target, 'r');
      try {
        const bytes = Buffer.alloc(Math.max(0, end - start + 1));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        headers['Content-Length'] = String(offset);
        return new Response(bytes.subarray(0, offset), { status, headers });
      } finally { await handle.close(); }
    } catch { return new Response('Attachment unavailable', { status: 404 }); }
  });
}

async function createWindow() {
  const devUrl = process.env.VAULTDESK_DEV_URL;
  if (devUrl) {
    const parsed = new URL(devUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)) throw new Error('VAULTDESK_DEV_URL must be a loopback development server');
  }
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 600, backgroundColor: '#1e1e24', title: 'VaultDesk', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: true, webviewTag: false } });
  window.webContents.session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== window.webContents || permission !== 'media' || !details.mediaTypes?.length || details.mediaTypes.some((type) => type !== 'audio')) return callback(false);
    const result = await dialog.showMessageBox(window, { type: 'question', title: 'Record audio', message: 'Allow VaultDesk to use your microphone for this recording?', buttons: ['Allow microphone', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true });
    callback(result.response === 0);
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window.webContents && permission === 'media' && details.mediaType === 'audio');
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, { type: 'warning', title: '尚有未保存的更改', message: '文件可能仍在保存，或存在尚未解决的编辑冲突。', detail: '保留窗口后可以完成保存或解决冲突。直接关闭会丢弃尚未写入磁盘的编辑内容。', buttons: ['保留窗口', '放弃未保存内容并关闭'], defaultId: 0, cancelId: 0, noLink: true });
    // Electron uses preventDefault here to override the renderer's unload veto.
    if (choice === 1) event.preventDefault();
  });
  window.webContents.session.on('will-download', (event) => event.preventDefault());
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('vaultdesk-asset:')) return callback({ responseHeaders: details.responseHeaders });
    const connect = devUrl ? ` 'self' vaultdesk-asset: ${new URL(devUrl).origin} ws://${new URL(devUrl).host}` : " 'self' vaultdesk-asset:";
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [`default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vaultdesk-asset:; media-src 'self' blob: vaultdesk-asset:; font-src 'self' data: blob:; connect-src${connect}; worker-src 'self' blob:; frame-src vaultdesk-asset:; object-src 'none'; base-uri 'none'; form-action 'none'`] } });
  });
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(path.join(appRoot, 'dist', 'index.html'));
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  if (testMode && !process.env.VAULTDESK_VAULT) throw new Error('VAULTDESK_TEST_MODE requires an explicit isolated VAULTDESK_VAULT');
  const local = await import(pathToFileURL(path.join(__dirname, 'vault-store.mjs')).href);
  ({ VaultStore } = local);
  ({ cloudRequest, syncVault } = await import(pathToFileURL(path.join(__dirname, 'sync.mjs')).href));
  ({ applyVaultdeskUri } = await import(pathToFileURL(path.join(__dirname, 'uri.mjs')).href));
  let initial = process.env.VAULTDESK_VAULT;
  if (!initial) {
    try { initial = JSON.parse(await fs.readFile(configFile, 'utf8')).vaultPath; } catch { /* First launch. */ }
  }
  if (initial) await attachStore(await VaultStore.open(initial));
  else await attachStore(await local.createWelcomeVault(path.join(app.getPath('userData'), 'Welcome Vault')));
  installHandlers();
  await installAssets();
  await createWindow();
  readyForUris = true;
  for (const uri of pendingUris.splice(0)) receiveUri(uri);
  if (testMode) console.log(JSON.stringify({ event: 'vaultdesk-ready', vaultPath: store.root, userData: app.getPath('userData') }));
}).catch((error) => { dialog.showErrorBox('VaultDesk startup failed', error.message); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && store) createWindow(); });
app.on('will-quit', () => store?.close());
