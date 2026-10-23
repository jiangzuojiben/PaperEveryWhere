async function round3Discovery(config) {
  const fs = require('node:fs'), path = require('node:path'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  if (!a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; mutations forbidden');
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = [];
  const methods = object => { const values = {}; for (let p = object, depth = 0; p && depth < 5; p = Object.getPrototypeOf(p), depth++) for (const key of Object.getOwnPropertyNames(p)) { const value = Object.getOwnPropertyDescriptor(p, key)?.value; if (typeof value === 'function' && !(key in values)) values[key] = value.length; } return values; };
  const run = async (id, fn) => { try { results.push({ id, status: 'observed', ...(await fn()) }); } catch (e) { results.push({ id, status: 'probe-error', error: String(e.stack || e) }); } };
  await pause(500);
  await run('discovery', async () => {
    const leaf = a.workspace.getLeaf(false); await leaf.openFile(a.vault.getAbstractFileByPath('Start.md'));
    let apiRequire;
    try { apiRequire = { ok: true, keys: Object.keys(require('obsidian')) }; } catch (e) { apiRequire = { ok: false, error: String(e) }; }
    return { pluginManager: { keys: Object.keys(a.plugins), methods: methods(a.plugins) }, workspace: { methods: methods(a.workspace), layout: a.workspace.getLayout() }, leaf: { methods: methods(leaf), viewState: leaf.getViewState(), viewMethods: methods(leaf.view), editorMethods: methods(leaf.view.editor), editorState: { cursor: leaf.view.editor.getCursor(), selection: leaf.view.editor.getSelection(), scroll: leaf.view.editor.getScrollInfo() } }, fileManager: methods(a.fileManager), metadataCache: methods(a.metadataCache), vault: methods(a.vault), apiRequire };
  });
  await run('actual-plugin-loader', async () => {
    const id = 'round3-discovery-plugin';
    const dir = path.join(config.vault, '.obsidian', 'plugins', id); fs.mkdirSync(dir, { recursive: true });
    const manifest = { id, name: 'Round 3 isolated discovery', version: '0.0.1', minAppVersion: '1.0.0', author: 'Independent laboratory', isDesktopOnly: true };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'main.js'), `const api = require('obsidian'); module.exports = class extends api.Plugin { async onload(){this.round3API=api;this.round3Timeline=['onload'];} onunload(){this.round3Timeline.push('onunload');} };`);
    const attempts = [];
    const managerEnabledBefore = a.plugins.isEnabled();
    await a.plugins.setEnable(true); attempts.push('await app.plugins.setEnable(true) in synthetic profile');
    if (typeof a.plugins.loadManifests === 'function') { await a.plugins.loadManifests(); attempts.push('await app.plugins.loadManifests()'); }
    const registeredManifest = a.plugins.manifests?.[id] || null;
    await a.plugins.enablePlugin(id); attempts.push('await app.plugins.enablePlugin(id)'); await pause(150);
    const loadedPlugin = a.plugins.plugins?.[id];
    const api = loadedPlugin?.round3API;
    const apiClasses = {};
    for (const name of ['Plugin', 'MarkdownView', 'Editor', 'ItemView', 'MarkdownRenderChild', 'Component', 'MarkdownRenderer', 'WorkspaceLeaf']) if (api?.[name]) apiClasses[name] = { staticMethods: methods(api[name]), prototypeMethods: methods(api[name].prototype) };
    const beforeDisable = { apiKeys: Object.keys(api || {}), timeline: [...(loadedPlugin?.round3Timeline || [])], pluginKeys: Object.keys(loadedPlugin || {}), apiClasses };
    if (!loadedPlugin || !api?.Plugin) throw Error('Fixture plugin did not reach onload');
    await a.plugins.disablePlugin(id); await pause(100);
    return { attempts, managerEnabledBefore, managerEnabledAfter: a.plugins.isEnabled(), registeredManifest, beforeDisable, afterDisable: { timeline: loadedPlugin.round3Timeline, stillLoaded: !!a.plugins.plugins?.[id] }, screenshot: await ipcRenderer.invoke('round3:capture', 'plugin-discovery') };
  });
  ipcRenderer.send('round3:report', { schema: 'obsidian-windows-round3-discovery-v1', status: 'complete', completionMeaning: 'Sequence finished; any probe-error is an unverified boundary.', environment: { coreVersion: '1.13.7', versions: process.versions, vaultIsSynthetic: true, coreSha256: config.coreSha256 }, results });
}
