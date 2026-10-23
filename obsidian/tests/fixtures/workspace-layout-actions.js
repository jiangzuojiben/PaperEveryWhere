async page => {
  const checks = [];
  const assert = (condition, message, details = {}) => {
    if (!condition) throw new Error(`${message}: ${JSON.stringify(details)}`);
    checks.push({ check: message, ...details });
  };
  const state = async () => JSON.parse(await page.locator('#workspace-state').textContent());
  const box = selector => page.locator(selector).boundingBox();
  const settle = () => page.waitForTimeout(100);
  const reset = async () => { await page.getByRole('button', { name: 'Reset fixture', exact: true }).click(); await settle(); };
  const dragHandle = async (locator, dx, dy = 0) => {
    const rect = await locator.boundingBox();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up(); await settle();
  };
  const dragTab = async (source, target, edge) => {
    const start = await source.boundingBox(), finish = await target.boundingBox();
    const x = edge === 'left' ? finish.x + 8 : edge === 'right' ? finish.x + finish.width - 8 : finish.x + finish.width / 2;
    const y = edge === 'top' ? finish.y + 50 : edge === 'bottom' ? finish.y + finish.height - 8 : finish.y + finish.height / 2;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2 + 12, { steps: 5 });
    await page.mouse.move(x, y, { steps: 18 }); await page.mouse.move(x + 1, y + 1); await settle();
    await page.mouse.up(); await settle();
  };
  const geometry = async () => page.locator('[data-pane-id]').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { id: node.dataset.paneId, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  const equalGeometry = (actual, expected) => actual.length === expected.length && actual.every((item, index) => item.id === expected[index].id && ['x', 'y', 'width', 'height'].every(key => Math.abs(item[key] - expected[index][key]) < 1));
  await page.setViewportSize({ width: 1440, height: 1000 }); await reset();
  const initial = await box('[data-pane-id="alpha"]');
  const separator = page.getByRole('separator', { name: '调整左右分栏比例', exact: true });
  await dragHandle(separator, 100);
  const resized = await box('[data-pane-id="alpha"]');
  assert(Math.abs(resized.width - initial.width - 100) < 2, 'mouse resizes actual pane width', { before: initial.width, after: resized.width });
  await separator.focus(); await page.keyboard.press('ArrowLeft'); await settle();
  const keyboard = await box('[data-pane-id="alpha"]');
  assert(keyboard.width < resized.width - 10, 'keyboard separator changes actual geometry', { before: resized.width, after: keyboard.width });
  await separator.dblclick(); await settle();
  assert(Math.abs((await box('[data-pane-id="alpha"]')).width - initial.width) < 1, 'double click restores equal split');

  await dragHandle(page.getByRole('separator', { name: '调整左侧栏宽度', exact: true }), 42);
  await dragHandle(page.getByRole('separator', { name: '调整右侧栏宽度', exact: true }), -28);
  let current = await state();
  assert(Math.abs(current.sidebars.left.width - 222) < 1 && Math.abs(current.sidebars.right.width - 208) < 1, 'both sidebar dividers resize in correct direction', { sidebars: current.sidebars });
  await page.getByRole('textbox', { name: 'Left sidebar mounted state' }).fill('still mounted');
  await page.getByRole('separator', { name: '调整左侧栏宽度', exact: true }).focus(); await page.keyboard.press('Enter'); await settle();
  assert((await box('[data-workspace-sidebar="left"]')).width === 0, 'keyboard collapses sidebar');
  await page.getByRole('button', { name: 'Toggle left sidebar', exact: true }).click(); await settle();
  assert(await page.getByRole('textbox', { name: 'Left sidebar mounted state' }).inputValue() === 'still mounted', 'collapsed sidebar content stays mounted');
  assert(Math.abs((await box('[data-workspace-sidebar="left"]')).width - 222) < 1, 'expanding sidebar restores saved width');

  const editor = page.getByRole('textbox', { name: 'Editor Alpha.md', exact: true });
  await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.down('Shift');
  for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift'); await editor.hover(); await page.mouse.wheel(0, 540); await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Pin Alpha.md', exact: true }).focus(); await page.keyboard.press('Space'); await settle();
  const editorBefore = await editor.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, top: element.scrollTop }));
  assert(editorBefore.start === 0 && editorBefore.end === 7 && editorBefore.top > 100, 'real editor selection and scroll captured', editorBefore);
  await page.getByRole('combobox', { name: 'Mode alpha', exact: true }).selectOption('live');
  await page.getByLabel('Reading Beta.md', { exact: true }).hover(); await page.mouse.wheel(0, 380); await page.waitForTimeout(250);
  current = await state();
  const alphaSaved = current.panes.find(pane => pane.id === 'alpha').tabStates['Alpha.md'];
  assert(alphaSaved.mode === 'live' && alphaSaved.cursor.head === 7 && alphaSaved.scroll.top > 100, 'mode change retains cursor and scroll', { state: alphaSaved });
  assert(current.panes.find(pane => pane.id === 'alpha').pinned.includes('Alpha.md'), 'keyboard pins active tab');

  await dragTab(page.getByRole('button', { name: 'Tab Alpha.md', exact: true }), page.locator('[data-pane-id="beta"]'), 'bottom');
  current = await state();
  const moved = current.panes.find(pane => pane.id !== 'alpha' && pane.id !== 'beta');
  assert(current.panes.length === 3 && moved?.active === 'Alpha.md', 'native tab drag creates bottom split', { count: current.panes.length, movedId: moved?.id });
  const betaBox = await box('[data-pane-id="beta"]'), movedBox = await box(`[data-pane-id="${moved.id}"]`);
  assert(Math.abs(betaBox.x - movedBox.x) < 1 && movedBox.y >= betaBox.y + betaBox.height, 'bottom split has actual stacked geometry', { beta: betaBox, moved: movedBox });
  assert(moved.pinned.includes('Alpha.md') && JSON.stringify(moved.tabStates['Alpha.md']) === JSON.stringify(alphaSaved), 'native edge drag preserves pin and full tab state');
  const editorMoved = await page.getByRole('textbox', { name: 'Editor Alpha.md', exact: true }).evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, top: element.scrollTop }));
  assert(editorMoved.start === 0 && editorMoved.end === 7 && Math.abs(editorMoved.top - alphaSaved.scroll.top) < 2, 'moved editor restores DOM cursor and scroll', editorMoved);

  await dragTab(page.getByRole('button', { name: 'Tab C# Basics.md', exact: true }), page.locator('[data-pane-id="beta"]'), 'center');
  current = await state();
  assert(current.panes.length === 2 && !current.panes.some(pane => pane.id === 'alpha'), 'center drag of last tab removes empty source pane');
  assert(current.panes.find(pane => pane.id === 'beta').tabs.includes('C# Basics.md'), 'center drag adds exact hash filename to target');
  const afterCenter = await geometry();
  assert(afterCenter.every(item => Math.abs(item.width - afterCenter[0].width) < 1), 'collapsed source redistributes actual pane width');
  await page.getByRole('button', { name: 'Split right beta', exact: true }).click(); await settle();
  current = await state();
  assert(current.panes.length === 3 && current.layout.type === 'split' && current.layout.children.some(child => child.type === 'split'), 'split control creates nested mixed layout');

  await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click(); await settle();
  await page.getByRole('textbox', { name: 'Layout name', exact: true }).fill('Browser saved layout');
  await page.getByRole('button', { name: 'Save layout', exact: true }).click(); await settle();
  const saved = await state(), savedGeometry = await geometry();
  await page.reload(); await page.getByRole('button', { name: 'Save layout', exact: true }).waitFor(); await settle();
  const reloaded = await state();
  assert(JSON.stringify(reloaded) === JSON.stringify(saved), 'full workspace survives browser reload');
  assert(equalGeometry(await geometry(), savedGeometry), 'reloaded layout restores DOM geometry');
  const reloadedEditor = await page.getByRole('textbox', { name: 'Editor Alpha.md', exact: true }).evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, top: element.scrollTop }));
  assert(reloadedEditor.start === 0 && reloadedEditor.end === 7 && Math.abs(reloadedEditor.top - alphaSaved.scroll.top) < 2, 'reload restores real editor cursor and scroll', reloadedEditor);
  assert(await page.getByRole('button', { name: 'Tab Alpha.md', exact: true }).getAttribute('data-pinned') === 'true', 'reload renders the pinned tab');
  assert(await page.locator(`[data-pane-id="${moved.id}"] > .pane`).getAttribute('data-mode') === 'live', 'reload renders the saved editor mode');
  await page.getByRole('button', { name: 'Reset fixture', exact: true }).click(); await settle();
  assert((await state()).panes.length === 2, 'fixture changed before named restoration');
  await page.getByRole('textbox', { name: 'Layout name', exact: true }).fill('Browser saved layout');
  await page.getByRole('button', { name: 'Restore layout', exact: true }).click(); await settle();
  assert(JSON.stringify(await state()) === JSON.stringify(saved), 'named layout restores complete workspace after changes');
  assert(equalGeometry(await geometry(), savedGeometry), 'named layout restores actual nested pane geometry');
  await page.getByRole('button', { name: 'Tab Beta.md', exact: true }).click(); await settle();
  const readingTop = await page.getByLabel('Reading Beta.md', { exact: true }).evaluate(element => element.scrollTop);
  assert(Math.abs(readingTop - 380) < 2, 'restored reading view recovers actual scroll position', { top: readingTop });
  await page.screenshot({ path: 'output/playwright/workspace-layout.png', fullPage: true });
  return { status: 'passed', checks, final: await state(), geometry: await geometry() };
}
