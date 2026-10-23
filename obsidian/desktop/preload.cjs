const { contextBridge, ipcRenderer } = require('electron');
const methods = ['openVault','snapshot','read','write','create','mkdir','rename','trash','importFiles','assetUrl','writeBinary','exportText','exportAttachment','writeClipboard','saveWorkspace','loadWorkspace','getHistory','restoreHistory','listTrash','restoreTrash','saveSettings','openExternal','cloudRequest','sync','platform'];
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
      const error = new Error(result.error.message);
      Object.assign(error, result.error);
      throw error;
    }
    return result.data;
  };
}
api.onChange = (callback) => {
  if (typeof callback !== 'function') throw new TypeError('Change callback must be a function');
  changeListeners.add(callback);
  const pending = pendingOpenEvents.splice(0);
  queueMicrotask(() => { if (changeListeners.has(callback)) for (const change of pending) callback(change); });
  return () => changeListeners.delete(callback);
};
contextBridge.exposeInMainWorld('vaultdesk', Object.freeze(api));
