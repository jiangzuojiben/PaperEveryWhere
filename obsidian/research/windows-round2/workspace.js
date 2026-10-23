async function workspaceReference(config) {
  const fs = require('node:fs'), path = require('node:path'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  if (!a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; mutations forbidden');
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const methods = object => { const values = new Set(); for (let p = object, depth = 0; p && depth < 4; p = Object.getPrototypeOf(p), depth++) for (const key of Object.getOwnPropertyNames(p)) if (typeof Object.getOwnPropertyDescriptor(p, key)?.value === 'function') values.add(key); return [...values].sort(); };
  const leaves = () => a.workspace.getLeavesOfType('markdown').map(leaf => { const rect = leaf.containerEl.getBoundingClientRect(); return { id: leaf.id, path: leaf.view.file?.path, pinned: leaf.pinned, active: a.workspace.activeLeaf === leaf, viewState: leaf.getViewState(), geometry: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; });
  const state = () => ({ layout: clone(a.workspace.getLayout()), leaves: leaves(), activeFile: a.workspace.getActiveFile()?.path });
  const capture = name => ipcRenderer.invoke('round2:capture', name);
  const ui = () => [...document.querySelectorAll('.modal')].map(modal => ({ text: modal.innerText, controls: [...modal.querySelectorAll('input,button,select')].map(el => ({ tag: el.tagName, type: el.type, text: el.innerText, placeholder: el.placeholder, value: el.value })) }));
  const run = async (id, fn) => { try { results.push({ id, status: 'observed', ...(await fn()) }); } catch (error) { results.push({ id, status: 'probe-error', error: String(error.stack || error), windows: await ipcRenderer.invoke('round2:windows') }); } fs.writeFileSync(path.join(config.run, 'workspace-partial.json'), JSON.stringify(results, null, 2)); };
  let pinnedLeaf, otherLeaf;
  await pause(800);
  await run('workspace-discovery', async () => {
    pinnedLeaf = a.workspace.getLeaf(false); await pinnedLeaf.openFile(a.vault.getAbstractFileByPath('Start.md'));
    return { leafMethods: methods(pinnedLeaf), commands: Object.values(a.commands.commands).filter(command => /pin|split|popout|window|workspaces|slides/i.test(command.id)).map(({id,name}) => ({id,name})), state: state() };
  });
  await run('pinned-open-file', async () => {
    pinnedLeaf.setPinned(true); const before = state();
    await a.workspace.openLinkText('Sources/Note', 'Start.md', false); await pause(400);
    return { action: 'Start leaf.setPinned(true); workspace.openLinkText(Sources/Note, Start.md, false)', before, after: state(), screenshot: await capture('workspace-pinned-new-file') };
  });
  await run('unpinned-open-reuses-leaf', async () => {
    const before = state();
    await a.workspace.openLinkText('Sources/Other', 'Sources/Note.md', false); await pause(300); otherLeaf = a.workspace.activeLeaf;
    return { action: 'workspace.openLinkText(Sources/Other, Sources/Note.md, false)', before, after: state() };
  });
  await run('open-existing-pinned-file', async () => {
    const before = state(); await a.workspace.openLinkText('Start', 'Sources/Other.md', false); await pause(300);
    const after = state(); if (otherLeaf) a.workspace.setActiveLeaf(otherLeaf, { focus: true });
    return { action: 'workspace.openLinkText(Start, Sources/Other.md, false)', before, after };
  });
  await run('split-vertical', async () => {
    const before = state(); const leaf = a.workspace.getLeaf('split', 'vertical'); await leaf.openFile(a.vault.getAbstractFileByPath('Sources/Note.md')); await pause(400);
    return { action: 'workspace.getLeaf(split, vertical).openFile(Sources/Note.md)', before, after: state(), screenshot: await capture('workspace-split-vertical') };
  });
  await run('split-horizontal', async () => {
    const before = state(); const leaf = a.workspace.getLeaf('split', 'horizontal'); await leaf.openFile(a.vault.getAbstractFileByPath('Present.md')); await pause(400);
    return { action: 'workspace.getLeaf(split, horizontal).openFile(Present.md)', before, after: state(), screenshot: await capture('workspace-split-horizontal') };
  });
  await run('workspace-save-load', async () => {
    const plugin = a.internalPlugins.getPluginById('workspaces').instance;
    const active = a.workspace.activeLeaf; const view = active.getViewState(); await active.setViewState({ ...view, state: { ...view.state, mode: 'preview' } }); await pause(200);
    const beforeSave = state();
    await plugin.saveWorkspace('Reference layout'); await pause(600);
    const saved = clone(plugin.workspaces), savedActive = plugin.activeWorkspace;
    for (const leaf of a.workspace.getLeavesOfType('markdown')) if (leaf !== pinnedLeaf) leaf.detach();
    pinnedLeaf.setPinned(false); await pinnedLeaf.openFile(a.vault.getAbstractFileByPath('Convert.md')); await pause(300);
    const changed = state(); await plugin.loadWorkspace('Reference layout'); await pause(1200);
    const restored = state();
    const workspaceFile = path.join(config.vault, '.obsidian', 'workspaces.json');
    return { action: 'saveWorkspace(Reference layout); detach other Markdown leaves; unpin/open Convert; loadWorkspace(Reference layout)', methodArities: { saveWorkspace: plugin.saveWorkspace.length, loadWorkspace: plugin.loadWorkspace.length }, beforeSave, savedActive, saved, changed, restored, disk: fs.existsSync(workspaceFile) ? JSON.parse(fs.readFileSync(workspaceFile, 'utf8')) : null, screenshot: await capture('workspace-restored') };
  });
  await run('workspace-management-ui', async () => {
    const executed = a.commands.executeCommandById('workspaces:open-modal'); await pause(300);
    const modals = ui(), screenshot = await capture('workspace-manager');
    await ipcRenderer.invoke('round2:key', 'Escape');
    await pause(200); return { executed, modals, screenshot, afterEscape: ui() };
  });
  await run('slides-command-keyboard', async () => {
    const leaf = a.workspace.getLeaf('tab'); await leaf.openFile(a.vault.getAbstractFileByPath('Present.md')); a.workspace.setActiveLeaf(leaf, { focus: true }); await pause(200);
    const executed = a.commands.executeCommandById('slides:start'); await pause(800);
    const inspect = () => ({ modals: ui(), bodyText: document.body.innerText.slice(-7000), reveal: [...document.querySelectorAll('.reveal')].map(el => ({ classes: el.className, sections: [...el.querySelectorAll('section')].map(section => ({ text: section.innerText, classes: section.className, ariaHidden: section.getAttribute('aria-hidden') })), controls: [...el.querySelectorAll('button')].map(button => ({ classes: button.className, text: button.innerText, ariaLabel: button.getAttribute('aria-label'), disabled: button.disabled })) })) });
    const first = inspect(), firstScreenshot = await capture('slides-first');
    await ipcRenderer.invoke('round2:key', 'Right'); await pause(500);
    const second = inspect(), secondScreenshot = await capture('slides-arrow-right');
    const next = document.querySelector('.reveal .navigate-right');
    if (next) next.click(); await pause(500);
    const afterNextClick = inspect(), nextScreenshot = await capture('slides-next-click');
    await ipcRenderer.invoke('round2:key', 'Escape'); await pause(300);
    return { executed, action: 'slides:start; Electron webContents.sendInputEvent Right; existing .navigate-right button.click(); Electron Escape', first, second, nextFound: !!next, afterNextClick, afterEscape: inspect(), firstScreenshot, secondScreenshot, nextScreenshot };
  });
  await run('popout-window', async () => {
    const before = { ...state(), windows: await ipcRenderer.invoke('round2:windows') };
    const leaf = await Promise.race([a.workspace.openPopoutLeaf(), pause(10000).then(() => { throw Error('openPopoutLeaf did not resolve in 10 seconds; popout content and restore not verified'); })]);
    await leaf.openFile(a.vault.getAbstractFileByPath('Sources/Other.md')); await pause(900);
    const after = { ...state(), windows: await ipcRenderer.invoke('round2:windows') };
    let popoutScreenshot = null;
    const popoutWindow = leaf.containerEl.ownerDocument.defaultView;
    try { popoutScreenshot = await popoutWindow.require('electron').ipcRenderer.invoke('round2:capture', 'workspace-popout'); } catch (error) { popoutScreenshot = { error: String(error) }; }
    const plugin = a.internalPlugins.getPluginById('workspaces').instance; await plugin.saveWorkspace('Reference with popout'); await pause(500);
    const saved = clone(plugin.workspaces['Reference with popout']);
    popoutWindow.close(); await pause(700);
    const afterClose = { ...state(), windows: await ipcRenderer.invoke('round2:windows') };
    await Promise.race([plugin.loadWorkspace('Reference with popout'), pause(10000).then(() => { throw Error('loadWorkspace with popout did not resolve in 10 seconds'); })]); await pause(1200);
    const restored = { ...state(), windows: await ipcRenderer.invoke('round2:windows') };
    const restoredLeaf = a.workspace.getLeavesOfType('markdown').find(candidate => candidate.containerEl.ownerDocument !== document && candidate.getViewState()?.state?.file === 'Sources/Other.md');
    let restoredScreenshot = null;
    if (restoredLeaf) restoredScreenshot = await restoredLeaf.containerEl.ownerDocument.defaultView.require('electron').ipcRenderer.invoke('round2:capture', 'workspace-popout-restored');
    return { action: 'workspace.openPopoutLeaf(); openFile(Sources/Other.md); saveWorkspace(Reference with popout); popoutWindow.close(); loadWorkspace(Reference with popout)', before, after, saved, popoutScreenshot, afterClose, restored, restoredScreenshot };
  });
  ipcRenderer.send('round2:report', { schema: 'obsidian-windows-round2-workspace-v1', status: 'complete', error: null, completionMeaning: 'Probe sequence finished; individual probe-error cases are unverified limitations, not passed behavior.', environment: { coreVersion: '1.13.7', versions: process.versions, vaultIsSynthetic: true, coreSha256: config.coreSha256 }, results });
}
