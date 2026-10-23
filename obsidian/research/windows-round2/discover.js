async function referenceDiscovery(config) {
  const fs = require('node:fs'), path = require('node:path'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  if (!a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; mutations forbidden');
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = []; let error = null;
  const methods = object => { const values = new Set(); for (let p = object, depth = 0; p && depth < 3; p = Object.getPrototypeOf(p), depth++) for (const key of Object.getOwnPropertyNames(p)) if (typeof Object.getOwnPropertyDescriptor(p, key)?.value === 'function') values.add(key); return [...values].sort(); };
  try {
    await pause(800);
    for (const id of config.plugins) {
      const plugin = a.internalPlugins.getPluginById(id);
      results.push({ id, enabled: plugin?.enabled, pluginKeys: plugin ? Object.keys(plugin) : [], instanceKeys: plugin?.instance ? Object.keys(plugin.instance) : [], methods: plugin?.instance ? methods(plugin.instance) : [], options: plugin?.instance?.options ?? null, commands: Object.values(a.commands.commands).filter(command => command.id.startsWith(id + ':')).map(({ id, name }) => ({ id, name })) });
    }
    results.push({ id: 'workspace-apis', methods: methods(a.workspace), layout: a.workspace.getLayout() });
    const leaf = a.workspace.getLeaf(false); await leaf.openFile(a.vault.getAbstractFileByPath('Start.md'));
    const importer = a.internalPlugins.getPluginById('markdown-importer')?.instance;
    const command = Object.values(a.commands.commands).find(command => command.id.startsWith('markdown-importer:'));
    if (command) { a.commands.executeCommandById(command.id); await pause(300); results.push({ id: 'importer-command-ui', command: command.id, modals: [...document.querySelectorAll('.modal')].map(el => ({ text: el.innerText, controls: [...el.querySelectorAll('input,select,button')].map(input => ({ tag: input.tagName, type: input.type, text: input.innerText, value: input.value, checked: input.checked })) })), screenshot: await ipcRenderer.invoke('round2:capture', 'importer-options') }); }
    results.push({ id: 'screen', screenshot: await ipcRenderer.invoke('round2:capture', 'discovery-window'), bodyText: document.body.innerText.slice(0, 14000) });
  } catch (reason) { error = String(reason.stack || reason); }
  ipcRenderer.send('round2:report', { schema: 'obsidian-windows-round2-discovery-v1', status: error ? 'failed' : 'complete', error, environment: { coreVersion: '1.13.7', versions: process.versions, vaultIsSynthetic: true, coreSha256: config.coreSha256 }, results });
}
