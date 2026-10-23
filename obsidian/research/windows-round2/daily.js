async function referenceDailyNotes(config) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  const guard = () => { if (!a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; mutations forbidden'); };
  guard();
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = [], events = [], eventRefs = [];
  let activeCase = null, fatal = null;
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  const daily = a.internalPlugins.getPluginById('daily-notes'), unique = a.internalPlugins.getPluginById('zk-prefixer');
  const originalDailyOptions = daily?.instance ? { ...daily.instance.options } : null;
  const originalUniqueOptions = unique?.instance ? { ...unique.instance.options } : null;
  const commands = Object.values(a.commands.commands).filter(c => c.id === 'daily-notes' || c.id === 'zk-prefixer' || c.id.startsWith('daily-notes:') || c.id.startsWith('zk-prefixer:')).map(c => ({ id: c.id, name: c.name, callbackArity: c.callback?.length, checkCallbackArity: c.checkCallback?.length }));
  const momentInfo = () => ({ iso: new Date().toISOString(), local: new Date().toString(), momentAvailable: typeof window.moment === 'function', formatted: typeof window.moment === 'function' ? { date: window.moment().format('YYYY-MM-DD'), dateSlash: window.moment().format('YYYY/MM/DD'), time: window.moment().format('HH:mm'), timeSeconds: window.moment().format('HH:mm:ss') } : null });
  const snapshot = async prefix => {
    guard(); const rows = {};
    for (const file of a.vault.getFiles().filter(f => !prefix || f.path.startsWith(prefix + '/')).sort((x, y) => x.path.localeCompare(y.path))) {
      const text = await a.vault.read(file); rows[file.path] = { text, sha256: hash(text) };
    }
    return { files: rows, activePath: a.workspace.getActiveFile()?.path ?? null, activeState: a.workspace.activeLeaf?.getViewState?.() ?? null };
  };
  const settle = async prefix => { let last = '', stable = 0; for (let i = 0; i < 40; i++) { const state = await snapshot(prefix), serialized = JSON.stringify(state); stable = serialized === last ? stable + 1 : 0; if (stable >= 4) return state; last = serialized; await pause(100); } return snapshot(prefix); };
  const runCase = async (id, work) => { activeCase = id; const begin = events.length; try { guard(); results.push({ id, status: 'observed', ...(await work()), events: events.slice(begin) }); } catch (error) { results.push({ id, status: 'error', error: String(error.stack || error), notices: [...document.querySelectorAll('.notice')].map(el => el.innerText), modals: [...document.querySelectorAll('.modal')].map(el => el.innerText), events: events.slice(begin) }); } };
  const execute = async id => { guard(); if (!commands.some(c => c.id === id)) throw Error('Command not registered: ' + id); const returned = a.commands.executeCommandById(id); await pause(600); return returned; };
  const put = async (filePath, text) => {
    guard(); const parts = filePath.split('/'); parts.pop(); let parent = '';
    for (const part of parts) { parent = parent ? parent + '/' + part : part; if (!a.vault.getAbstractFileByPath(parent)) await a.vault.createFolder(parent); }
    const file = a.vault.getAbstractFileByPath(filePath); return file ? a.vault.modify(file, text).then(() => file) : a.vault.create(filePath, text);
  };
  const configure = (plugin, values) => { guard(); if (!plugin?.enabled || !plugin.instance?.options) throw Error('Required original plugin unavailable'); Object.assign(plugin.instance.options, values); return { ...plugin.instance.options }; };
  const open = async filePath => { guard(); const file = a.vault.getAbstractFileByPath(filePath); if (!file) throw Error('Fixture missing: ' + filePath); await a.workspace.getLeaf(false).openFile(file); await pause(250); };
  for (const type of ['create', 'modify', 'rename', 'delete']) eventRefs.push([a.vault, a.vault.on(type, (file, oldPath) => events.push({ caseId: activeCase, type, path: file?.path, oldPath, at: performance.now() }))]);
  for (const type of ['file-open', 'active-leaf-change']) eventRefs.push([a.workspace, a.workspace.on(type, value => events.push({ caseId: activeCase, type, path: type === 'file-open' ? value?.path : value?.view?.file?.path, at: performance.now() }))]);
  try {
    await pause(500);
    results.push({ id: 'runtime-capabilities', status: 'observed', commands, dailyEnabled: daily?.enabled, uniqueEnabled: unique?.enabled, dailyOptions: originalDailyOptions, uniqueOptions: originalUniqueOptions, methodArities: { daily: Object.fromEntries(['getDailyNote', 'onOpenDailyNote', 'gotoPreviousExisting', 'gotoNextExisting', 'iterateDailyNotes'].filter(k => typeof daily?.instance?.[k] === 'function').map(k => [k, daily.instance[k].length])), unique: Object.fromEntries(['createUniqueNote', 'getUniquePath', 'onCreateNote'].filter(k => typeof unique?.instance?.[k] === 'function').map(k => [k, unique.instance[k].length])) }, clock: momentInfo() });
    await runCase('daily-default-template-expansion', async () => {
      const options = configure(daily, { folder: 'Journal', template: 'Templates/Daily.md', format: 'YYYY-MM-DD' });
      const before = await snapshot('Journal'), clockBefore = momentInfo(), commandReturn = await execute('daily-notes'), after = await settle('Journal');
      return { options, before, after, clockBefore, clockAfter: momentInfo(), commandReturn, screenshot: await ipcRenderer.invoke('round2:capture', 'daily-default') };
    });
    await runCase('daily-existing-note-not-overwritten', async () => {
      const filePath = a.workspace.getActiveFile()?.path; if (!filePath?.startsWith('Journal/')) throw Error('Prior daily note was not opened');
      await put(filePath, '# Existing daily sentinel\nDo not overwrite this text.\n');
      const before = await snapshot('Journal'), commandReturn = await execute('daily-notes'), after = await settle('Journal');
      return { filePath, before, after, commandReturn, exactTextPreserved: before.files[filePath]?.text === after.files[filePath]?.text };
    });
    await runCase('daily-date-format-creates-nested-folders', async () => {
      const options = configure(daily, { folder: 'Journal', template: 'Templates/Daily.md', format: 'YYYY/MM/[Day-]DD' });
      const before = await snapshot('Journal'), clockBefore = momentInfo(), commandReturn = await execute('daily-notes'), after = await settle('Journal');
      return { options, before, after, commandReturn, clockBefore, clockAfter: momentInfo() };
    });
    await runCase('daily-missing-configured-nested-folder', async () => {
      const options = configure(daily, { folder: 'Journal/Missing/Deep', template: 'Templates/Daily.md', format: 'YYYY-MM-DD' });
      const before = await snapshot('Journal/Missing'), commandReturn = await execute('daily-notes'), after = await settle('Journal/Missing');
      return { options, before, after, commandReturn, notices: [...document.querySelectorAll('.notice')].map(el => el.innerText) };
    });
    await runCase('daily-title-date-time-expansion', async () => {
      const template = 'Title={{title}}\nDate={{date}}\nTime={{time}}\nDateFormat={{date:YYYY/MM/DD}}\nTimeFormat={{time:HH:mm:ss}}\nUnknown={{unknown}}\n';
      await put('Templates/Expansion.md', template);
      await put('Journal/Expansion/Seed.md', '# Existing configured folder\n');
      const options = configure(daily, { folder: 'Journal/Expansion', template: 'Templates/Expansion.md', format: '[Daily-]YYYY-MM-DD' });
      const clockBefore = momentInfo(), commandReturn = await execute('daily-notes'), after = await settle('Journal/Expansion');
      return { options, template, after, commandReturn, clockBefore, clockAfter: momentInfo(), notices: [...document.querySelectorAll('.notice')].map(el => el.innerText), screenshot: await ipcRenderer.invoke('round2:capture', 'daily-expanded-template') };
    });
    await runCase('daily-previous-next-existing', async () => {
      const options = configure(daily, { folder: 'DailyNav', template: '', format: 'YYYY-MM-DD' });
      for (const filePath of ['DailyNav/2024-03-01.md', 'DailyNav/2024-03-05.md', 'DailyNav/2024-03-12.md', 'DailyNav/README.md']) await put(filePath, '# Navigation fixture ' + filePath + '\n');
      await open('DailyNav/2024-03-05.md'); const steps = [];
      for (const command of ['daily-notes:goto-prev', 'daily-notes:goto-next', 'daily-notes:goto-next', 'daily-notes:goto-next']) { const beforePath = a.workspace.getActiveFile()?.path, commandReturn = await execute(command), after = await settle('DailyNav'); steps.push({ command, beforePath, commandReturn, afterPath: after.activePath, files: Object.keys(after.files), notices: [...document.querySelectorAll('.notice')].map(el => el.innerText) }); }
      return { options, steps, after: await snapshot('DailyNav'), screenshot: await ipcRenderer.invoke('round2:capture', 'daily-navigation') };
    });
    await runCase('unique-default-template-expansion', async () => {
      const options = configure(unique, { folder: 'Unique', template: 'Templates/Unique.md', format: 'YYYYMMDDHHmmss' });
      const before = await snapshot('Unique'), clockBefore = momentInfo(), commandReturn = await execute('zk-prefixer'), after = await settle('Unique');
      return { options, before, after, commandReturn, clockBefore, clockAfter: momentInfo() };
    });
    await runCase('unique-constant-format-collision', async () => {
      await put('Unique/collision.md', '# Existing unique sentinel\n');
      const options = configure(unique, { folder: 'Unique', template: 'Templates/Expansion.md', format: '[collision]' });
      const before = await snapshot('Unique'), attempts = [];
      for (let attempt = 0; attempt < 2; attempt++) { const commandReturn = await execute('zk-prefixer'); attempts.push({ commandReturn, after: await settle('Unique'), notices: [...document.querySelectorAll('.notice')].map(el => el.innerText) }); }
      const after = await snapshot('Unique');
      return { options, before, attempts, after, originalPreserved: after.files['Unique/collision.md']?.text === before.files['Unique/collision.md']?.text, screenshot: await ipcRenderer.invoke('round2:capture', 'unique-collision') };
    });
    await runCase('unique-second-resolution-collision-path', async () => {
      if (typeof window.moment !== 'function') throw Error('Moment unavailable');
      const clockBefore = momentInfo(), anchor = window.moment();
      for (let offset = -2; offset <= 5; offset++) await put('UniqueCollision/' + anchor.clone().add(offset, 'seconds').format('YYYYMMDDHHmmss') + '.md', '# Existing collision sentinel ' + offset + '\n');
      const options = configure(unique, { folder: 'UniqueCollision', template: 'Templates/Expansion.md', format: 'YYYYMMDDHHmmss' });
      const before = await snapshot('UniqueCollision'), commandReturn = await execute('zk-prefixer'), after = await settle('UniqueCollision');
      return { options, before, after, commandReturn, clockBefore, clockAfter: momentInfo(), newPaths: Object.keys(after.files).filter(p => !before.files[p]), originalsPreserved: Object.keys(before.files).every(p => before.files[p].text === after.files[p]?.text), notices: [...document.querySelectorAll('.notice')].map(el => el.innerText) };
    });
    await runCase('unique-nested-format-path', async () => {
      await put('Unique/Nested/Seed.md', '# Existing configured folder\n');
      const options = configure(unique, { folder: 'Unique/Nested', template: 'Templates/Unique.md', format: '[Level/Note]' });
      const before = await snapshot('Unique/Nested'), commandReturn = await execute('zk-prefixer'), after = await settle('Unique/Nested');
      return { options, before, after, commandReturn, notices: [...document.querySelectorAll('.notice')].map(el => el.innerText) };
    });
  } catch (error) { fatal = String(error.stack || error); }
  finally {
    if (daily?.instance && originalDailyOptions) daily.instance.options = originalDailyOptions;
    if (unique?.instance && originalUniqueOptions) unique.instance.options = originalUniqueOptions;
    for (const [emitter, ref] of eventRefs) emitter.offref(ref);
  }
  ipcRenderer.send('round2:report', { schema: 'obsidian-windows-round2-daily-v1', status: fatal ? 'failed' : 'complete', error: fatal, caseErrors: results.filter(r => r.status === 'error').length, environment: { coreVersion: '1.13.7', versions: process.versions, vaultIsSynthetic: true, coreSha256: config.coreSha256 }, scope: 'Original daily-notes and zk-prefixer commands in synthetic vault; in-memory plugin options varied; no full UI or restart parity claim.', results });
}
