const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, screen, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

app.setName('VaultDesk');
const testMode = process.env.VAULTDESK_TEST_MODE === '1';
const testSession = process.env.VAULTDESK_TEST_SESSION;
if (testSession && !/^[a-zA-Z0-9_-]{1,80}$/.test(testSession)) throw new Error('Invalid isolated test session name');
app.setPath('userData', testMode ? path.join(os.tmpdir(), `VaultDesk-Test-${testSession || process.pid}`) : path.join(app.getPath('appData'), 'VaultDesk'));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
protocol.registerSchemesAsPrivileged([{ scheme: 'vaultdesk-asset', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const appRoot = path.resolve(__dirname, '..');
const configFile = path.join(app.getPath('userData'), 'desktop.json');
const pendingUris = process.argv.filter((argument) => /^vaultdesk:/i.test(argument));
const records = new Map();
const controllers = new Map();
const flushRequests = new Map();
const pendingWorkspaceSaves = new Set();
let registry, local, cloud, attachments, applyVaultdeskUri, matchesCurrentVault, parseVaultdeskUri, webViewer;
let readyForUris = false, quitting = false, quitPersisted = false, focusedId = null, restoringSession = true;
let persistence = Promise.resolve(), uriQueue = Promise.resolve(), persistenceTimer;
const mimeTypes = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.avif':'image/avif', '.pdf':'application/pdf', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.mp4':'video/mp4', '.webm':'video/webm', '.txt':'text/plain', '.md':'text/plain' };

function currentContext() {
  if (!registry) return null;
  const focused = BrowserWindow.getFocusedWindow();
  return [...registry.contexts.values()].find((ctx) => ctx.window === focused) || registry.contexts.get(focusedId) || [...registry.contexts.values()][0] || null;
}

function send(context, event) {
  const active = registry?.contexts.get(context.id);
  if (!active || active.generation !== context.generation || active.window !== context.window || active.window?.isDestroyed()) return false;
  active.window.webContents.send('vaultdesk:change', { ...event, windowId: active.id, vaultPath: active.vaultPath });
  return true;
}

function register(name, operation, { allowSwitch = false } = {}) {
  ipcMain.handle(`vaultdesk:${name}`, async (event, ...args) => {
    try {
      const owner = registry.fromEvent(event);
      const context = registry.capture(owner.id);
      const data = await operation(context, ...args);
      if (!allowSwitch) context.assertCurrent();
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: { message: error.message, code: error.code, status: error.status, currentMtime: error.currentMtime, imported: error.imported } };
    }
  });
}

function recordWindow(context) {
  const window = context.window;
  records.set(context.id, { id: context.id, vaultPath: context.vaultPath, bounds: window && !window.isDestroyed() ? window.getNormalBounds() : records.get(context.id)?.bounds, maximized: window && !window.isDestroyed() ? window.isMaximized() : false });
}

function persistSession() {
  // A partial startup must not erase windows that have not yet been restored.
  if (restoringSession) return Promise.resolve();
  if (process.env.VAULTDESK_VAULT && !testMode) return Promise.resolve();
  const value = { version: 2, activeWindowId: focusedId, windows: [...records.values()] };
  persistence = persistence.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    const temporary = `${configFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, configFile); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  });
  return persistence;
}

function schedulePersistence(context) {
  recordWindow(context);
  clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(() => persistSession().catch(() => {}), 150);
}

function requestVaultFlush(store, { signal } = {}) {
  const owners = [...registry.contexts.values()].filter((context) => context.store === store && context.window && !context.window.isDestroyed());
  if (!owners.length) return Promise.reject(Object.assign(new Error('No open window can prepare this vault for sync'), { code: 'SYNC_BLOCKED' }));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const finish = (error) => {
      const request = flushRequests.get(requestId); if (!request) return;
      flushRequests.delete(requestId); clearTimeout(request.timer); signal?.removeEventListener('abort', abort);
      if (error) reject(Object.assign(new Error(error), { code: 'SYNC_BLOCKED' })); else resolve();
    };
    const abort = () => finish('Sync preparation was canceled');
    const waiting = new Map(owners.map((context) => [context.id, context.generation]));
    const timer = setTimeout(() => finish('A window did not finish saving before sync. Resolve unsaved changes and try again.'), 15000);
    flushRequests.set(requestId, { store, waiting, timer, finish });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    for (const owner of owners) send(owner, { type: 'sync-before', requestId });
  });
}

function invalidateWindowFlush(id) {
  for (const request of flushRequests.values()) if (request.waiting.has(id)) request.finish('A window changed or closed while preparing to sync. Try again.');
}

function controller(store) {
  if (!controllers.has(store)) {
    const instance = cloud.createSyncController(store, {
      beforeSync: (options) => requestVaultFlush(store, options),
      onProgress: (progress) => registry.sendToVault(store, { type: 'sync-progress', ...progress }),
      onStatus: (status) => registry.sendToVault(store, { type: 'sync-status', ...status }),
    });
    controllers.set(store, instance);
  }
  return controllers.get(store);
}

function installHandlers() {
  register('openVault', async (context) => {
    const result = await dialog.showOpenDialog(context.window, { title: 'Open local vault', properties: ['openDirectory', 'createDirectory'] });
    context.assertCurrent();
    if (result.canceled || !result.filePaths[0]) return context.store.snapshot();
    invalidateWindowFlush(context.id);
    webViewer?.disposeOwner(context.window);
    const next = await registry.switchVault(context.id, result.filePaths[0]);
    next.window.setTitle(`VaultDesk — ${path.basename(next.vaultPath)}`);
    recordWindow(next); await persistSession();
    return next.store.snapshot();
  }, { allowSwitch: true });
  for (const name of ['snapshot', 'read', 'write', 'create', 'mkdir', 'rename', 'trash', 'getHistory', 'readHistory', 'restoreHistory', 'listTrash', 'restoreTrash']) register(name, (context, ...args) => context.store[name](...args));
  register('saveWorkspace', async (context, value) => {
    const pending = context.store.saveState(`workspace-${context.id}`, value);
    pendingWorkspaceSaves.add(pending);
    try { return await pending; }
    finally { pendingWorkspaceSaves.delete(pending); }
  });
  register('loadWorkspace', async (context) => await context.store.loadState(`workspace-${context.id}`, null) ?? await context.store.loadWorkspace());
  register('saveSettings', (context, value) => context.store.saveState('settings', value));
  register('newWindow', async (context, options = {}) => {
    if (registry.contexts.size >= 20) throw new Error('Close a window before opening another');
    if (options.path && !(await fs.stat(await context.store.checkedPath(options.path))).isFile()) throw new Error('Expected a file to open in the new window');
    const workspace = options.cloneWorkspace === false ? {} : await context.store.loadState(`workspace-${context.id}`, null) ?? await context.store.loadWorkspace();
    context.assertCurrent();
    const next = await createWindow({ vaultPath: context.vaultPath, initialWorkspace: workspace, openPath: options.path });
    return { windowId: next.id, vaultPath: next.vaultPath };
  });
  register('openVaultInNewWindow', async (context) => {
    const result = await dialog.showOpenDialog(context.window, { title: 'Open vault in a new window', properties: ['openDirectory', 'createDirectory'] });
    context.assertCurrent();
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const next = await createWindow({ vaultPath: result.filePaths[0] });
    return { canceled: false, windowId: next.id, vaultPath: next.vaultPath };
  });
  register('listWindows', (context) => registry.list(context.id));
  register('focusWindow', (context, id) => {
    const next = registry.get(id);
    if (next.store !== context.store || !next.window || next.window.isDestroyed()) throw new Error('Window not found in the current vault');
    if (next.window.isMinimized()) next.window.restore();
    next.window.show(); next.window.focus(); return true;
  });
  register('windowInfo', (context) => ({ windowId: context.id, vaultPath: context.vaultPath, windows: registry.list(context.id).length }));
  register('writeClipboard', (_context, value) => { if (typeof value !== 'string') throw new Error('Expected clipboard text'); clipboard.writeText(value); return true; });
  register('clipboardImage', async (context, destination = '') => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    context.assertCurrent();
    return attachments.saveClipboardPng(context.store, image.toPNG(), destination);
  });
  register('writeBinary', (context, relative, base64) => {
    if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Expected base64-encoded attachment bytes');
    return context.store.createBytes(relative, Buffer.from(base64, 'base64'));
  });
  register('importFiles', async (context, destination = '') => {
    const result = await dialog.showOpenDialog(context.window, { title: 'Import attachments', properties: ['openFile', 'multiSelections'] });
    context.assertCurrent();
    return result.canceled ? [] : attachments.importExternalFiles(context.store, result.filePaths, destination);
  });
  // Only preload can turn native drag/drop File objects into these source paths.
  register('importDroppedFiles', (context, sources, destination = '') => attachments.importExternalFiles(context.store, sources, destination));
  register('exportText', async (context, content, filename = 'Note.md') => {
    if (typeof content !== 'string' || typeof filename !== 'string') throw new Error('Expected text and a filename');
    const result = await dialog.showSaveDialog(context.window, { title: 'Export Markdown', defaultPath: path.join(app.getPath('documents'), path.basename(filename)), filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }] });
    context.assertCurrent();
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, content, 'utf8'); return { canceled: false, path: result.filePath };
  });
  register('exportAttachment', async (context, relative) => {
    const source = await context.store.checkedPath(relative);
    if (!(await fs.stat(source)).isFile()) throw new Error('Expected an attachment file');
    const result = await dialog.showSaveDialog(context.window, { title: 'Export attachment', defaultPath: path.join(app.getPath('documents'), path.basename(relative)), filters: [{ name: 'All files', extensions: ['*'] }] });
    context.assertCurrent();
    if (result.canceled || !result.filePath) return { canceled: true };
    const { data } = await context.store.readBytes(relative); context.assertCurrent();
    await fs.writeFile(result.filePath, data); return { canceled: false, path: result.filePath };
  });
  register('assetUrl', async (context, relative) => {
    const target = await context.store.checkedPath(relative);
    if (!(await fs.stat(target)).isFile()) throw new Error('Expected an attachment');
    return `vaultdesk-asset://${context.assetToken}/${relative.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')}`;
  });
  register('openExternal', async (_context, value) => {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported external URL');
    await shell.openExternal(url.href); return true;
  });
  register('registerProtocol', async (context) => {
    const choice = await dialog.showMessageBox(context.window, { type: 'question', title: '注册 VaultDesk 链接', message: '将此应用注册为 vaultdesk:// 链接的处理程序？', detail: '此操作只注册 VaultDesk 自己的协议，不更改 obsidian://。', buttons: ['注册 VaultDesk', '取消'], defaultId: 1, cancelId: 1 });
    context.assertCurrent();
    if (choice.response !== 0) return { registered: false, canceled: true };
    const registered = app.isPackaged ? app.setAsDefaultProtocolClient('vaultdesk') : app.setAsDefaultProtocolClient('vaultdesk', process.execPath, [appRoot]);
    if (!registered) throw new Error('Windows did not register the VaultDesk URL handler');
    return { registered: true };
  });
  register('cloudRequest', (_context, config, endpoint, options) => cloud.cloudRequest(config, endpoint, options));
  register('sync', (context, config) => controller(context.store).syncNow(config));
  for (const method of ['configureSync', 'syncConfigure']) register(method, (context, config) => controller(context.store).configure(config));
  register('syncStatus', (context) => controller(context.store).getStatus());
  for (const method of ['pauseSync', 'syncPause']) register(method, (context) => controller(context.store).pause());
  for (const method of ['resumeSync', 'syncResume']) register(method, (context) => controller(context.store).resume());
  register('syncReady', (context, requestId, result) => {
    const request = flushRequests.get(requestId);
    if (!request || request.store !== context.store || request.waiting.get(context.id) !== context.generation) throw new Error('Sync preparation request is no longer active');
    if (!result?.ok) { request.finish(String(result?.error || 'Resolve unsaved edits before syncing').slice(0, 400)); return false; }
    request.waiting.delete(context.id); if (!request.waiting.size) request.finish(); return true;
  });
  register('platform', (context) => ({ platform: process.platform, version: app.getVersion(), vaultPath: context.vaultPath, windowId: context.id }));
  webViewer = require('./web-viewer.cjs').installWebViewer({ register, send });
}

async function serveAsset(context, request) {
  try {
    const bound = registry.capture(context.id);
    const url = new URL(request.url);
    if (url.hostname !== bound.assetToken || url.search || url.hash) return new Response('Not found', { status: 404 });
    const relative = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    const target = await bound.store.checkedPath(relative);
    const stat = await fs.stat(target);
    if (!stat.isFile()) return new Response('Not found', { status: 404 });
    const headers = { 'Content-Type': mimeTypes[path.extname(relative).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' };
    let start = 0, end = stat.size - 1, status = 200;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : end; }
      else start = Math.max(0, stat.size - Number(match[2]));
      if (start > end || start < 0 || end >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`; status = 206;
    }
    const handle = await fs.open(target, 'r');
    try {
      const bytes = Buffer.alloc(Math.max(0, end - start + 1));
      let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset); if (!bytesRead) break; offset += bytesRead; }
      bound.assertCurrent(); headers['Content-Length'] = String(offset);
      return new Response(bytes.subarray(0, offset), { status, headers });
    } finally { await handle.close(); }
  } catch { return new Response('Attachment unavailable', { status: 404 }); }
}

async function setupSession(context, devUrl) {
  const window = context.window;
  const session = window.webContents.session;
  if (await session.protocol.isProtocolHandled('vaultdesk-asset')) session.protocol.unhandle('vaultdesk-asset');
  session.protocol.handle('vaultdesk-asset', (request) => serveAsset(context, request));
  session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== window.webContents || permission !== 'media' || !details.mediaTypes?.length || details.mediaTypes.some((type) => type !== 'audio')) return callback(false);
    const result = await dialog.showMessageBox(window, { type: 'question', title: 'Record audio', message: 'Allow VaultDesk to use your microphone for this recording?', buttons: ['Allow microphone', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true });
    callback(result.response === 0 && !window.isDestroyed());
  });
  session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window.webContents && permission === 'media' && details.mediaType === 'audio');
  session.on('will-download', (event) => event.preventDefault());
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('vaultdesk-asset:')) return callback({ responseHeaders: details.responseHeaders });
    const connect = devUrl ? ` 'self' vaultdesk-asset: ${new URL(devUrl).origin} ws://${new URL(devUrl).host}` : " 'self' vaultdesk-asset:";
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [`default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vaultdesk-asset:; media-src 'self' blob: vaultdesk-asset:; font-src 'self' data: blob:; connect-src${connect}; worker-src 'self' blob:; frame-src vaultdesk-asset:; object-src 'none'; base-uri 'none'; form-action 'none'`] } });
  });
}

function windowBounds(saved) {
  if (!saved || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(saved[key]))) return { width: 1440, height: 940 };
  const area = screen.getDisplayMatching(saved).workArea;
  const width = Math.min(area.width, Math.max(900, Math.round(saved.width)));
  const height = Math.min(area.height, Math.max(600, Math.round(saved.height)));
  return { width, height, x: Math.max(area.x, Math.min(Math.round(saved.x), area.x + area.width - width)), y: Math.max(area.y, Math.min(Math.round(saved.y), area.y + area.height - height)) };
}

async function createWindow({ id, vaultPath, bounds, maximized = false, initialWorkspace, openPath } = {}) {
  if (registry.contexts.size >= 20) throw new Error('Too many open windows');
  const devUrl = process.env.VAULTDESK_DEV_URL;
  if (devUrl) { const url = new URL(devUrl); if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('VAULTDESK_DEV_URL must be a loopback development server'); }
  const context = await registry.add({ id, vaultPath });
  try {
    if (initialWorkspace !== undefined) await registry.saveWorkspace(context.id, initialWorkspace);
    const window = new BrowserWindow({ ...windowBounds(bounds), minWidth: 900, minHeight: 600, backgroundColor: '#1e1e24', title: `VaultDesk — ${path.basename(vaultPath)}`, autoHideMenuBar: true, webPreferences: { partition: `persist:vaultdesk-window-${context.id}`, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: true, webviewTag: false, backgroundThrottling: false } });
    registry.bindWindow(context.id, window); context.send = (event) => send(context, event);
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('will-prevent-unload', (event) => {
      const choice = dialog.showMessageBoxSync(window, { type: 'warning', title: '尚有未保存的更改', message: '文件可能仍在保存，或存在尚未解决的编辑冲突。', detail: '保留窗口后可以完成保存或解决冲突。直接关闭会丢弃尚未写入磁盘的编辑内容。', buttons: ['保留窗口', '放弃未保存内容并关闭'], defaultId: 0, cancelId: 0, noLink: true });
      if (choice === 1) event.preventDefault();
      else { quitting = false; quitPersisted = false; }
    });
    window.on('focus', () => { focusedId = context.id; schedulePersistence(context); });
    for (const name of ['resize', 'move', 'maximize', 'unmaximize']) window.on(name, () => schedulePersistence(context));
    window.on('close', () => recordWindow(context));
    window.on('closed', () => {
      invalidateWindowFlush(context.id);
      if (!quitting && registry.contexts.size > 1) records.delete(context.id);
      registry.remove(context.id).then(() => persistSession()).catch(() => {});
    });
    await setupSession(context, devUrl);
    if (devUrl) await window.loadURL(devUrl); else await window.loadFile(path.join(appRoot, 'dist', 'index.html'));
    if (maximized) window.maximize();
    recordWindow(context); await persistSession();
    if (openPath) send(context, { type: 'open', path: openPath });
    if (testMode) console.log(JSON.stringify({ event: 'vaultdesk-window-ready', windowId: context.id, vaultPath: context.vaultPath, userData: app.getPath('userData') }));
    return context;
  } catch (error) {
    if (context.window && !context.window.isDestroyed()) context.window.destroy();
    await registry.remove(context.id); records.delete(context.id); throw error;
  }
}

function receiveUri(value) {
  if (!readyForUris) { pendingUris.push(value); return; }
  uriQueue = uriQueue.then(async () => {
    let context = currentContext();
    try {
      const request = parseVaultdeskUri(value);
      if (request.vault) context = [...registry.contexts.values()].find((item) => matchesCurrentVault(request.vault, item.vaultPath)) || context;
      if (!context) {
        const record = [...records.values()][0];
        if (!record) throw new Error('Open a vault before using a VaultDesk link');
        context = await createWindow(record);
      }
      const bound = registry.capture(context.id);
      const event = await applyVaultdeskUri(bound.store, value); bound.assertCurrent(); send(bound, event);
      if (context.window.isMinimized()) context.window.restore(); context.window.show(); context.window.focus();
    } catch (error) { await dialog.showMessageBox(context?.window, { type: 'error', title: 'VaultDesk link', message: error.message, buttons: ['OK'] }); }
  });
}

app.on('open-url', (event, url) => { event.preventDefault(); receiveUri(url); });
app.on('second-instance', (_event, argv) => { for (const argument of argv) if (/^vaultdesk:/i.test(argument)) receiveUri(argument); const context = currentContext(); if (context?.window) { if (context.window.isMinimized()) context.window.restore(); context.window.focus(); } });

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  if (testMode && !process.env.VAULTDESK_VAULT) throw new Error('VAULTDESK_TEST_MODE requires an explicit isolated VAULTDESK_VAULT');
  const moduleUrl = (name) => pathToFileURL(path.join(__dirname, name)).href;
  local = await import(moduleUrl('vault-store.mjs'));
  cloud = await import(moduleUrl('sync.mjs'));
  attachments = await import(moduleUrl('attachments.mjs'));
  ({ applyVaultdeskUri, matchesCurrentVault, parseVaultdeskUri } = await import(moduleUrl('uri.mjs')));
  const { WindowRegistry } = await import(moduleUrl('window-registry.mjs'));
  registry = new WindowRegistry();
  registry.on('store-closed', (store) => { controllers.get(store)?.close(); controllers.delete(store); });
  installHandlers();
  let saved = {};
  const restore = !process.env.VAULTDESK_VAULT || testMode && process.env.VAULTDESK_TEST_RESTORE === '1';
  if (restore) { try { saved = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch { /* First launch. */ } }
  let initial = Array.isArray(saved.windows) ? saved.windows.slice(0, 20) : saved.vaultPath ? [{ vaultPath: saved.vaultPath }] : [];
  if (!initial.length && process.env.VAULTDESK_VAULT) initial = [{ vaultPath: process.env.VAULTDESK_VAULT }];
  if (!initial.length) { const welcome = await local.createWelcomeVault(path.join(app.getPath('userData'), 'Welcome Vault')); initial = [{ vaultPath: welcome.root }]; welcome.close(); }
  const failures = [];
  for (const record of initial) {
    try { await createWindow(record); }
    catch (error) {
      failures.push(`${record.vaultPath}: ${error.message}`);
      // Keep an unavailable vault's identity so reconnecting its drive can restore
      // the same workspace on a later launch. Never overwrite a live duplicate id.
      if (typeof record.id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(record.id) && typeof record.vaultPath === 'string' && path.isAbsolute(record.vaultPath) && !records.has(record.id)) {
        records.set(record.id, { id: record.id, vaultPath: record.vaultPath, bounds: record.bounds, maximized: !!record.maximized });
      }
    }
  }
  if (!registry.contexts.size) {
    const welcome = await local.createWelcomeVault(path.join(app.getPath('userData'), 'Welcome Vault'));
    const vaultPath = welcome.root; welcome.close();
    await createWindow({ vaultPath });
  }
  const active = registry.contexts.get(saved.activeWindowId); if (active?.window) active.window.focus();
  restoringSession = false; await persistSession();
  if (failures.length) await dialog.showMessageBox(currentContext().window, { type: 'warning', title: 'Some windows could not be restored', message: failures.join('\n') });
  readyForUris = true; for (const uri of pendingUris.splice(0)) receiveUri(uri);
  if (testMode) console.log(JSON.stringify({ event: 'vaultdesk-ready', windows: [...registry.contexts.values()].map((ctx) => ({ windowId: ctx.id, vaultPath: ctx.vaultPath })), userData: app.getPath('userData') }));
}).catch((error) => { dialog.showErrorBox('VaultDesk startup failed', error.message); quitPersisted = true; app.quit(); });

app.on('before-quit', (event) => {
  if (quitPersisted || !registry) return;
  event.preventDefault(); quitting = true;
  for (const context of registry.contexts.values()) recordWindow(context);
  Promise.allSettled([...pendingWorkspaceSaves]).then(() => persistSession()).finally(() => { quitPersisted = true; app.quit(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (registry && !registry.contexts.size) { const record = [...records.values()][0]; if (record) createWindow(record).catch((error) => dialog.showErrorBox('VaultDesk', error.message)); } });
app.on('will-quit', () => { clearTimeout(persistenceTimer); for (const instance of controllers.values()) instance.close(); registry?.close(); });
