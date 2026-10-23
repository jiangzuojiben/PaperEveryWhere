async function publicApiWrapperReference(config) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const clone = value => JSON.parse(JSON.stringify(value));
  const results = [];
  const errorInfo = error => ({ name: error?.name, message: String(error?.message || error), stack: String(error?.stack || '') });
  const waitFor = async (callback, label, limit = 300) => {
    for (let i = 0; i < limit; i++) { const value = await callback(); if (value) return value; await pause(50); }
    throw Error('Wait expired: ' + label);
  };
  try {
    await waitFor(() => window.app?.workspace?.layoutReady && window.app?.vault?.getFiles().length, 'original app ready');
    const app = window.app;
    if (path.resolve(app.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; all mutations forbidden');
    await waitFor(() => fs.existsSync(path.join(config.run, 'start.signal')), 'REA start signal');
    const sourceDirectory = path.resolve(config.run, '..', '..', 'windows-round3', 'fixtures', 'public-api-probe');
    const manifestBytes = fs.readFileSync(path.join(sourceDirectory, 'manifest.json'));
    const mainBytes = fs.readFileSync(path.join(sourceDirectory, 'main.js'));
    const manifest = JSON.parse(manifestBytes), pluginId = manifest.id;
    if (pluginId !== 'public-api-probe') throw Error('Unexpected frozen plugin identity');
    const installedDirectory = path.join(config.vault, '.obsidian', 'plugins', pluginId);
    fs.mkdirSync(installedDirectory, { recursive: true });
    fs.writeFileSync(path.join(installedDirectory, 'manifest.json'), manifestBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(installedDirectory, 'main.js'), mainBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(config.run, 'installed-manifest.json'), manifestBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(config.run, 'installed-main.js'), mainBytes, { flag: 'wx' });
    const identity = { manifestSha256: hash(manifestBytes), mainSha256: hash(mainBytes), manifest, sourceDirectory: path.relative(path.resolve(config.run, '..', '..', '..'), sourceDirectory).replaceAll('\\', '/') };
    const dataPath = path.join(installedDirectory, 'data.json');
    const readData = () => { try { return JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch { return null; } };
    const latestSession = () => readData()?.sessions?.at(-1);
    const closeReports = async () => {
      for (const button of [...document.querySelectorAll('button')].filter(element => element.textContent === 'Close')) button.click();
      await pause(80);
    };
    const capture = name => ipcRenderer.invoke('round3:capture', name);
    const observe = async (id, callback) => {
      try { results.push({ id, status: 'observed', ...(await callback()) }); }
      catch (error) { results.push({ id, status: 'observed', harnessError: errorInfo(error) }); }
      fs.writeFileSync(path.join(config.run, 'wrapper-partial.json'), JSON.stringify(results, null, 2));
    };
    await app.plugins.setEnable(true);
    await app.plugins.loadManifests();
    await app.plugins.enablePlugin(pluginId);
    await waitFor(() => app.plugins.plugins[pluginId] && latestSession()?.persistence?.lastAttempt, 'exact wrapper real plugin enable');
    results.push({ id: 'exact-wrapper-identity-and-enable', status: 'observed', identity, loaded: !!app.plugins.plugins[pluginId], installedManifestSha256: hash(fs.readFileSync(path.join(installedDirectory, 'manifest.json'))), installedMainSha256: hash(fs.readFileSync(path.join(installedDirectory, 'main.js'))), reportAfterEnable: readData() });

    const commands = [
      { id: 'prepare-editor', caseId: 'editor:prepare-marked-note', capture: 'exact-wrapper-editor-ready' },
      { id: 'editor-transaction', caseId: 'editor:transaction-undo-redo', capture: 'exact-wrapper-editor-report' },
      { id: 'view-lifecycle', caseId: 'view:split-state-and-detach', capture: 'exact-wrapper-custom-split' },
      { id: 'render-resources', caseId: 'render:programmatic-component-lifecycle', capture: 'exact-wrapper-rendered-note' },
      { id: 'frontmatter-binary', caseId: 'binary:arraybuffer-roundtrip-modify-append', capture: 'exact-wrapper-data-report' },
    ];
    for (const command of commands) {
      await observe('exact-wrapper-command-' + command.id, async () => {
        await closeReports();
        const beforeCount = latestSession()?.cases?.length || 0;
        const commandId = pluginId + ':' + command.id;
        const commandRegistered = !!app.commands.commands[commandId];
        const executionReturn = app.commands.executeCommandById(commandId);
        await waitFor(() => latestSession()?.cases?.slice(beforeCount).some(item => item.id === command.caseId && item.finishedAt), commandId + ' saved final case', 500);
        await pause(300);
        const dialog = document.querySelector('textarea[aria-label="Public API probe JSON"]');
        const dialogReport = dialog ? JSON.parse(dialog.value) : null;
        const report = readData(), cases = report.sessions.at(-1).cases.slice(beforeCount);
        if (['view-lifecycle', 'render-resources'].includes(command.id)) await closeReports();
        return { commandId, commandRegistered, executionReturn, cases, report, dialogReport, screenshot: await capture(command.capture), activeView: app.workspace.activeLeaf?.getViewState() };
      });
    }
    await observe('exact-wrapper-save-report', async () => {
      await closeReports();
      const executionReturn = app.commands.executeCommandById(pluginId + ':save-observations');
      await waitFor(() => document.querySelector('textarea[aria-label="Public API probe JSON"]'), 'final saved report modal');
      const dialogReport = JSON.parse(document.querySelector('textarea[aria-label="Public API probe JSON"]').value);
      const dataBytes = fs.readFileSync(dataPath);
      fs.writeFileSync(path.join(config.run, 'wrapper-report-before-disable.json'), dataBytes, { flag: 'wx' });
      return { executionReturn, dialogReport, savedReport: JSON.parse(dataBytes), savedReportSha256: hash(dataBytes), screenshot: await capture('exact-wrapper-final-report') };
    });
    await observe('exact-wrapper-disable-external-observation', async () => {
      await closeReports();
      const type = 'reference-public-api-probe-view';
      const before = app.workspace.getLeavesOfType(type).map(leaf => ({ id: leaf.id, state: leaf.getViewState() }));
      const resourceBefore = { ribbons: [...document.querySelectorAll('[aria-label]')].filter(element => element.getAttribute('aria-label')?.includes('Reference API Probe')).map(element => ({ tag: element.tagName, label: element.getAttribute('aria-label'), connected: element.isConnected })), statuses: [...document.querySelectorAll('.status-bar-item')].filter(element => element.textContent === 'Reference API Lab').length };
      await app.plugins.disablePlugin(pluginId);
      await pause(450);
      const remaining = app.workspace.getLeavesOfType(type), after = remaining.map(leaf => ({ id: leaf.id, state: leaf.getViewState(), text: leaf.view.containerEl.textContent }));
      if (remaining[0]) app.workspace.setActiveLeaf(remaining[0], { focus: true });
      const resourceAfter = { ribbons: [...document.querySelectorAll('[aria-label]')].filter(element => element.getAttribute('aria-label')?.includes('Reference API Probe')).map(element => ({ tag: element.tagName, label: element.getAttribute('aria-label'), connected: element.isConnected })), statuses: [...document.querySelectorAll('.status-bar-item')].filter(element => element.textContent === 'Reference API Lab').length };
      const bytes = fs.readFileSync(dataPath);
      fs.writeFileSync(path.join(config.run, 'wrapper-report-after-disable.json'), bytes, { flag: 'wx' });
      return { loadedAfter: !!app.plugins.plugins[pluginId], before, after, resourceBefore, resourceAfter, savedReport: JSON.parse(bytes), savedReportSha256: hash(bytes), screenshot: await capture('exact-wrapper-disabled-placeholder') };
    });
    const fixtureFiles = fs.readdirSync(path.join(config.vault, 'Reference API Lab')).map(name => {
      const bytes = fs.readFileSync(path.join(config.vault, 'Reference API Lab', name));
      return { path: 'Reference API Lab/' + name, sha256: hash(bytes), bytes: bytes.length, content: name.endsWith('.md') ? bytes.toString('utf8') : [...bytes] };
    });
    results.push({ id: 'exact-wrapper-final-identities-and-files', status: 'observed', identity, sourceManifestUnchanged: hash(fs.readFileSync(path.join(sourceDirectory, 'manifest.json'))) === identity.manifestSha256, sourceMainUnchanged: hash(fs.readFileSync(path.join(sourceDirectory, 'main.js'))) === identity.mainSha256, installedManifestUnchanged: hash(fs.readFileSync(path.join(installedDirectory, 'manifest.json'))) === identity.manifestSha256, installedMainUnchanged: hash(fs.readFileSync(path.join(installedDirectory, 'main.js'))) === identity.mainSha256, fixtureFiles });
    ipcRenderer.send('round3:report', { status: 'complete', kind: 'exact-public-api-wrapper', identity, results, method: 'REA-controlled isolated original renderer copied exact frozen manifest/main into the synthetic vault, used the real original plugin manager to enable/disable and original command registry to execute commands 01-05 and 07. No wrapper command/internal method was called directly. Reports were read from original plugin data.json and wrapper Modal JSON; screenshots and vault bytes provide external observations. This is not physical command-palette input or a direct REA Electron-surface capture.' });
  } catch (error) { ipcRenderer.send('round3:report', { status: 'failed', kind: 'exact-public-api-wrapper', error: errorInfo(error), results }); }
}
