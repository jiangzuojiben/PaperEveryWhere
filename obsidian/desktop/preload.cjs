const { contextBridge, ipcRenderer, webUtils } = require('electron');
const methods = ['openVault','snapshot','read','write','create','mkdir','rename','trash','importFiles','assetUrl','readBinary','writeBinary','modifyBinary','exportText','exportAttachment','writeClipboard','clipboardImage','saveWorkspace','loadWorkspace','getHistory','readHistory','restoreHistory','listTrash','restoreTrash','saveSettings','openExternal','cloudRequest','requestUrl','sync','configureSync','syncConfigure','pauseSync','syncPause','resumeSync','syncResume','syncStatus','syncReady','platform','newWindow','openVaultInNewWindow','listWindows','focusWindow','windowInfo','registerProtocol','webviewOpen','webviewNavigate','webviewBounds','webviewAction','webviewClose'];
const api = {};
const changeListeners = new Set();
const pendingOpenEvents = [];
ipcRenderer.on('vaultdesk:change', (_event, change) => {
  if (!changeListeners.size && change?.type === 'open') {
    pendingOpenEvents.push(change);
    if (pendingOpenEvents.length > 20) pendingOpenEvents.shift();
  }
  for (const callback of changeListeners) callback(change);
});
for (const method of methods) {
  api[method] = async (...args) => {
    const result = await ipcRenderer.invoke(`vaultdesk:${method}`, ...args);
    if (!result.ok) {
      // Electron's contextBridge drops custom properties from Error objects.
      // A plain rejection payload preserves conflict codes and recovery details.
      throw { name: 'VaultDeskError', ...result.error };
    }
    return result.data;
  };
}
api.importDroppedFiles = async (files, destination = '') => {
  const dropped = Array.from(files || []);
  if (!dropped.length || dropped.length > 1000) throw new Error('Drop between 1 and 1000 local files or folders');
  const sources = dropped.map((file) => {
    const source = webUtils.getPathForFile(file);
    if (!source) throw new Error('Only native files dropped from your computer can be imported');
    return source;
  });
  const result = await ipcRenderer.invoke('vaultdesk:importDroppedFiles', sources, destination);
  if (!result.ok) throw { name: 'VaultDeskError', ...result.error };
  return result.data;
};
api.onChange = (callback) => {
  if (typeof callback !== 'function') throw new TypeError('Change callback must be a function');
  changeListeners.add(callback);
  const pending = pendingOpenEvents.splice(0);
  queueMicrotask(() => { if (changeListeners.has(callback)) for (const change of pending) callback(change); });
  return () => changeListeners.delete(callback);
};
contextBridge.exposeInMainWorld('vaultdesk', Object.freeze(api));
