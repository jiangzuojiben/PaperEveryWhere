async function referenceFrontmatterMatrix(config) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  const guard = () => { if (!a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; mutations forbidden'); };
  guard();
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = [], fixtures = [];
  const sum = text => crypto.createHash('sha256').update(text).digest('hex');
  const ui = () => [...document.querySelectorAll('.modal')].map(el => ({ text: el.innerText, inputs: [...el.querySelectorAll('input')].map(input => ({ type: input.type, checked: input.checked, value: input.value })), buttons: [...el.querySelectorAll('button')].map(button => button.innerText) }));
  let fatal = null;
  const add = (name, yaml) => { const id = String(fixtures.length + 1).padStart(2, '0'); fixtures.push({ id, name, path: 'Frontmatter/' + id + '-' + name + '.md', yaml, input: '---\n' + yaml + '\n---\n# Fixture ' + id + '\n\nBody sentinel ' + id + '.\n' }); };
  for (const field of ['tags', 'aliases', 'cssclasses']) {
    add(field + '-comma-string', field + ': alpha, beta');
    add(field + '-space-string', field + ': alpha beta');
    add(field + '-yaml-quoted-delimiters', field + ': "alpha, beta gamma"');
    add(field + '-embedded-quotes', field + ': \'"alpha,beta", "gamma delta"\'');
    add(field + '-existing-array', field + ': [alpha, beta]');
    add(field + '-duplicate-array', field + ': [alpha, alpha, beta, alpha]');
    add(field + '-null', field + ': null');
    add(field + '-number', field + ': 42');
    add(field + '-boolean', field + ': true');
  }
  for (const [single, plural] of [['tag', 'tags'], ['alias', 'aliases'], ['cssclass', 'cssclasses']]) {
    add(single + '-only', single + ': old-one, old-two');
    add(single + '-plural-conflict', single + ': old-one, old-two\n' + plural + ': [new-one, new-two]');
    add(single + '-null-plural', single + ': old-one\n' + plural + ': null');
  }
  const readAll = async () => { guard(); const output = {}; for (const file of a.vault.getMarkdownFiles().sort((l, r) => l.path.localeCompare(r.path))) output[file.path] = await a.vault.read(file); return output; };
  try {
    guard(); await a.vault.createFolder('Frontmatter');
    for (const fixture of fixtures) { guard(); await a.vault.create(fixture.path, fixture.input); }
    await pause(500);
    const beforeAll = await readAll();
    const command = Object.values(a.commands.commands).find(item => item.id === 'markdown-importer:open');
    if (!command) throw Error('Original importer command unavailable');
    a.commands.executeCommandById(command.id); await pause(250);
    const modal = [...document.querySelectorAll('.modal')].at(-1);
    const boxes = [...(modal?.querySelectorAll('input[type="checkbox"]') || [])];
    if (boxes.length !== 7) throw Error('Unexpected importer checkbox count: ' + boxes.length);
    for (let i = 0; i < boxes.length; i++) if (boxes[i].checked !== (i === 6)) boxes[i].click();
    const options = ui();
    if (boxes.some((box, i) => box.checked !== (i === 6))) throw Error('Only frontmatter must be enabled');
    const optionScreenshot = await ipcRenderer.invoke('round2:capture', 'frontmatter-only-options');
    const start = [...modal.querySelectorAll('button')].find(button => /开始转换|Start conversion/i.test(button.innerText));
    if (!start) throw Error('Start conversion button unavailable');
    guard(); start.click();
    let complete;
    for (let i = 0; i < 200; i++) {
      complete = [...document.querySelectorAll('.modal button')].find(button => {
        const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
        return button.innerText.trim() === '完成' && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !button.disabled;
      });
      const processing = [...document.querySelectorAll('.modal')].some(el => /正在处理/.test(el.innerText));
      if (complete && !processing) break;
      complete = null;
      await pause(100);
    }
    if (!complete) throw Error('Importer did not display completion within deadline');
    const completion = ui(), screenshot = await ipcRenderer.invoke('round2:capture', 'frontmatter-conversion-complete');
    const afterAll = await readAll();
    results.push({ id: 'frontmatter-conversion-matrix', status: 'observed', command: { id: command.id, name: command.name }, options, optionScreenshot, completion, screenshot, fixtures: fixtures.map(fixture => ({ ...fixture, before: beforeAll[fixture.path], after: afterAll[fixture.path], changed: beforeAll[fixture.path] !== afterAll[fixture.path], beforeSha256: sum(beforeAll[fixture.path]), afterSha256: sum(afterAll[fixture.path]) })), beforeAll, afterAll });
    complete.click(); await pause(100);
    results.push({ id: 'completion-closed', status: 'observed', remainingModals: ui() });
  } catch (error) { fatal = String(error.stack || error); results.push({ id: 'probe-error', status: 'error', error: fatal, ui: ui(), fixtures }); }
  ipcRenderer.send('round2:report', { schema: 'obsidian-windows-round2-frontmatter-v1', status: fatal ? 'failed' : 'complete', error: fatal, environment: { coreVersion: '1.13.7', versions: process.versions, vaultIsSynthetic: true, coreSha256: config.coreSha256 }, scope: 'Original Markdown importer UI, only checkbox index 6 enabled; synthetic frontmatter matrix; exact input/output retained.', results });
}
