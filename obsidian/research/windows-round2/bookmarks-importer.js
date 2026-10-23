async function referenceFeatures(config) {
  const fs = require('node:fs'), path = require('node:path'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  if (!a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; mutations forbidden');
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = [], clone = value => JSON.parse(JSON.stringify(value));
  const ui = () => [...document.querySelectorAll('.modal')].map(el => ({ text: el.innerText, inputs: [...el.querySelectorAll('input,select')].map(input => ({ type: input.type, value: input.value, checked: input.checked, placeholder: input.placeholder })), buttons: [...el.querySelectorAll('button')].map(button => ({ text: button.innerText, class: button.className })) }));
  const closeModals = () => document.querySelectorAll('.modal button').forEach(button => { if (['完成', '取消'].includes(button.innerText)) button.click(); });
  const run = async (id, work) => { try { results.push({ id, status: 'observed', ...await work() }); } catch (error) { results.push({ id, status: 'error', error: String(error.stack || error), ui: ui() }); closeModals(); } };
  const capture = name => ipcRenderer.invoke('round2:capture', name);
  const note = a.vault.getAbstractFileByPath('Sources/Note.md');
  const b = a.internalPlugins.getPluginById('bookmarks').instance;
  const commitModal = async () => { const modal = document.querySelector('.modal'); const button = modal?.querySelector('button.mod-cta'); if (button) button.click(); await pause(400); };
  await pause(700);
  await run('bookmark-heading', async () => {
    await a.workspace.getLeaf(false).openFile(note); a.workspace.activeLeaf.view.editor.setCursor({ line: 2, ch: 3 });
    const executed = a.commands.executeCommandById('bookmarks:bookmark-current-heading'); await pause(200);
    const dialog = ui(), screenshot = await capture('bookmark-heading-dialog'); await commitModal();
    return { executed, dialog, screenshot, items: clone(b.items) };
  });
  await run('bookmark-block', async () => {
    a.workspace.activeLeaf.view.editor.setCursor({ line: 4, ch: 8 });
    const executed = a.commands.executeCommandById('bookmarks:bookmark-current-section'); await pause(200);
    const dialog = ui(); await commitModal();
    return { executed, dialog, items: clone(b.items), noteContent: await a.vault.read(note) };
  });
  await run('bookmark-file-and-tab-group', async () => {
    const executed = a.commands.executeCommandById('bookmarks:bookmark-current-view'); await pause(100); const fileDialog = ui(); await commitModal();
    await a.workspace.getLeaf('tab').openFile(a.vault.getAbstractFileByPath('Sources/Other.md'));
    a.commands.executeCommandById('bookmarks:bookmark-all-tabs'); await pause(200); const groupDialog = ui();
    const input = document.querySelector('.modal input[type="text"]'); if (input) { input.value = 'Research tabs'; input.dispatchEvent(new Event('input', { bubbles: true })); }
    await commitModal(); a.commands.executeCommandById('bookmarks:open'); await pause(200);
    return { executed, fileDialog, groupDialog, items: clone(b.items), sidebar: a.workspace.getLeavesOfType('bookmarks').map(leaf => leaf.view.containerEl.innerText), screenshot: await capture('bookmark-groups') };
  });
  await run('bookmark-rename-and-open-heading', async () => {
    await a.fileManager.renameFile(note, 'Sources/Renamed.md'); await pause(600);
    const itemsAfterRename = clone(b.items), item = b.items.find(item => item.subpath && item.subpath.includes('Section One'));
    if (!item) throw Error('Heading bookmark not found');
    await b.openBookmark(item); await pause(300);
    const active = a.workspace.activeLeaf;
    return { itemsAfterRename, activePath: a.workspace.getActiveFile()?.path, viewState: active.getViewState(), cursor: active.view.editor?.getCursor(), screenshot: await capture('bookmark-reopen-heading') };
  });
  await run('importer-roam-bear-frontmatter', async () => {
    const source = '---\ntags: one, two\nalias: Name\ncssclass: foo bar\n---\n# Converter fixture\n\n#plain #[[multi word]] #parent/child\n\\#escaped `#code`\n```text\n#fenced ^^inside^^ ::inside::\n```\n\n^^Roam^^ and ::Bear:: and ==Existing==\n{{[[TODO]]}} task\n{{[[DONE]]}} finished\n\n[Regular](Target.md) [[Sources/Renamed#Section One]]\n';
    const file = await a.vault.create('Conversion.md', source);
    a.commands.executeCommandById('markdown-importer:open'); await pause(150);
    const modal = [...document.querySelectorAll('.modal')].at(-1), boxes = [...modal.querySelectorAll('input[type="checkbox"]')];
    for (const index of [0, 1, 2, 3, 6]) boxes[index].click();
    const options = ui(); modal.querySelector('button.mod-cta,button').click(); await pause(900);
    const after = await a.vault.read(file), completion = ui(); closeModals();
    return { source, options, after, completion, screenshots: [await capture('importer-converted')] };
  });
  await run('importer-zettelkasten-plain', async () => {
    await a.vault.create('202001010101 Target title.md', '# Target title\n');
    const file = await a.vault.create('UID links.md', '[[202001010101]] [[202001010101|Alias]] [[202001010101#Heading]] [[999999999999]]\n');
    a.commands.executeCommandById('markdown-importer:open'); await pause(150);
    const modal = [...document.querySelectorAll('.modal')].at(-1), boxes = [...modal.querySelectorAll('input[type="checkbox"]')]; boxes[4].click();
    const options = ui(); modal.querySelector('button.mod-cta,button').click(); await pause(700);
    const after = await a.vault.read(file); closeModals(); return { options, after };
  });
  await run('importer-zettelkasten-pretty', async () => {
    const file = await a.vault.create('UID links pretty.md', '[[202001010101]] [[202001010101|Alias]] [[202001010101#Heading]] [[999999999999]]\n');
    a.commands.executeCommandById('markdown-importer:open'); await pause(150);
    const modal = [...document.querySelectorAll('.modal')].at(-1), boxes = [...modal.querySelectorAll('input[type="checkbox"]')]; boxes[5].click();
    const options = ui(); modal.querySelector('button.mod-cta,button').click(); await pause(700);
    const after = await a.vault.read(file); closeModals(); return { options, after };
  });
  await run('webviewer-product-availability', async () => {
    const plugin = a.internalPlugins.getPluginById('webviewer');
    const before = { enabled: plugin.enabled, commands: Object.keys(a.commands.commands).filter(id => /webviewer/i.test(id)) };
    const managerMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(a.internalPlugins));
    return { before, managerMethods, notices: [...document.querySelectorAll('.notice')].map(el => el.innerText), limitation: 'Listed in core-plugins configuration but unavailable at startup; no product gate override attempted.' };
  });
  await run('slides', async () => {
    await a.workspace.getLeaf(false).openFile(a.vault.getAbstractFileByPath('Present.md')); a.commands.executeCommandById('slides:start'); await pause(600);
    const before = { ui: ui(), reveals: [...document.querySelectorAll('.reveal')].map(el => ({ text: el.innerText, sections: [...el.querySelectorAll('section')].map(s => ({ text: s.innerText, class: s.className })) })) }, screenshot = await capture('slides-first');
    await ipcRenderer.invoke('round2:key', 'Right'); await pause(350);
    const after = [...document.querySelectorAll('.reveal section')].map(s => ({ text: s.innerText, class: s.className }));
    return { before, after, screenshot, nextScreenshot: await capture('slides-next') };
  });
  await pause(700);
  const savedBookmarksPath = path.join(config.vault, '.obsidian', 'bookmarks.json');
  results.push({ id: 'persisted-bookmarks', status: 'observed', data: fs.existsSync(savedBookmarksPath) ? JSON.parse(fs.readFileSync(savedBookmarksPath, 'utf8')) : null });
  ipcRenderer.send('round2:report', { schema: 'obsidian-windows-round2-reference-v1', status: 'complete', environment: { coreVersion: '1.13.7', versions: process.versions, vaultIsSynthetic: true, coreSha256: config.coreSha256 }, results });
}
