async function layoutReference(config) {
  const fs = require('node:fs'), path = require('node:path'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  if (!a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; mutations forbidden');
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = [], events = [], refs = [];
  const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
  const attempt = fn => { try { return clone(fn()); } catch (error) { return { error: String(error.message || error) }; } };
  const methods = object => { const values = new Map(); for (let p = object, depth = 0; p && depth < 5; p = Object.getPrototypeOf(p), depth++) for (const key of Object.getOwnPropertyNames(p)) { const value = Object.getOwnPropertyDescriptor(p, key)?.value; if (typeof value === 'function') values.set(key, value.length); } return Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b))); };
  const scalars = object => Object.fromEntries(Object.entries(object || {}).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
  const rect = element => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const elementState = element => element ? { className: element.className, rect: rect(element), display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight } : null;
  const visibleSourceLines = leaf => {
    const scroller = leaf.view?.containerEl?.querySelector('.cm-scroller'); if (!scroller) return [];
    const viewport = scroller.getBoundingClientRect(); if (!viewport.width || !viewport.height) return [];
    return [...scroller.querySelectorAll('.cm-line')].map(element => ({ element, bounds: element.getBoundingClientRect() })).filter(({ bounds }) => bounds.bottom > viewport.top + 1 && bounds.top < viewport.bottom - 1).slice(0, 5).map(({ element, bounds }) => ({ text: element.textContent, topRelativeToViewport: bounds.top - viewport.top, bottomRelativeToViewport: bounds.bottom - viewport.top }));
  };
  const leafState = leaf => ({
    id: leaf.id, path: leaf.view?.file?.path || null, pinned: !!leaf.pinned, active: a.workspace.activeLeaf === leaf,
    visible: attempt(() => leaf.isVisible()), parentId: leaf.parent?.id, parentType: leaf.parent?.constructor?.name,
    geometry: rect(leaf.containerEl), tabHeader: elementState(leaf.tabHeaderEl),
    serialized: attempt(() => leaf.serialize()), viewState: attempt(() => leaf.getViewState()),
    state: attempt(() => leaf.view.getState()), ephemeral: attempt(() => leaf.getEphemeralState()),
    viewEphemeral: attempt(() => leaf.view.getEphemeralState()), mode: attempt(() => leaf.view.getMode()),
    cursor: attempt(() => leaf.view.editor.getCursor()), selections: attempt(() => leaf.view.editor.listSelections()),
    scroll: attempt(() => leaf.view.editor.getScrollInfo()),
    visibleSourceLines: visibleSourceLines(leaf),
    sourceScroller: elementState(leaf.view?.containerEl?.querySelector('.cm-scroller')),
    previewScroller: elementState(leaf.view?.containerEl?.querySelector('.markdown-preview-view')),
  });
  const sidebar = split => {
    const views = []; const visit = node => { if (node?.view) views.push({ id: node.id, type: attempt(() => node.view.getViewType()), geometry: rect(node.containerEl), visible: attempt(() => node.isVisible()), headerClasses: node.tabHeaderEl?.className }); for (const child of node?.children || []) visit(child); }; visit(split);
    return { id: split?.id, scalars: scalars(split), geometry: rect(split?.containerEl), classes: split?.containerEl?.className, serialized: attempt(() => split.serialize()), views };
  };
  const state = () => ({ layout: attempt(() => a.workspace.getLayout()), activeLeaf: a.workspace.activeLeaf?.id, activeFile: a.workspace.getActiveFile()?.path, leaves: a.workspace.getLeavesOfType('markdown').map(leafState), left: sidebar(a.workspace.leftSplit), right: sidebar(a.workspace.rightSplit) });
  const capture = name => ipcRenderer.invoke('round3:capture', name);
  const summarizeArg = value => value == null ? value : ['string', 'number', 'boolean'].includes(typeof value) ? value : { id: value.id, path: value.path || value.view?.file?.path, type: value.type || value.getViewType?.() };
  let phase = 'setup';
  for (const name of ['layout-change', 'active-leaf-change', 'file-open', 'resize']) refs.push(a.workspace.on(name, (...args) => { if (events.length < 400) events.push({ name, phase, time: new Date().toISOString(), args: args.map(summarizeArg) }); }));
  const run = async (id, fn) => { phase = id; const eventStart = events.length; try { results.push({ id, status: 'observed', ...(await fn()), events: clone(events.slice(eventStart)) }); } catch (error) { results.push({ id, status: 'probe-error', error: String(error.stack || error), state: state(), events: clone(events.slice(eventStart)) }); } fs.writeFileSync(path.join(config.run, 'layout-partial.json'), JSON.stringify(results, null, 2)); };
  const file = value => a.vault.getAbstractFileByPath(value);
  const activate = leaf => a.workspace.setActiveLeaf(leaf, { focus: false });
  let leftA, leftB, rightTop, rightBottom, savedLayout, savedEphemeral, beforeRestore;
  await pause(800);
  await run('layout-api-discovery', async () => {
    const leaf = a.workspace.getLeaf(false); await leaf.openFile(file('Start.md')); await pause(300);
    return { workspaceMethods: methods(a.workspace), leafMethods: methods(leaf), viewMethods: methods(leaf.view), editorMethods: methods(leaf.view.editor), tabsMethods: methods(leaf.parent), rootMethods: methods(a.workspace.rootSplit), leftMethods: methods(a.workspace.leftSplit), rightMethods: methods(a.workspace.rightSplit), workspaceScalars: scalars(a.workspace), tabsScalars: scalars(leaf.parent), before: state() };
  });
  await run('nested-splits-tabs-pins-and-editor-state', async () => {
    for (const name of ['Layout-A.md', 'Layout-B.md', 'Layout-C.md', 'Layout-D.md']) {
      const content = `# ${name}\n\n` + Array.from({ length: 220 }, (_, i) => `Line ${String(i).padStart(3, '0')} synthetic text`).join('\n') + '\n';
      if (file(name)) throw Error('Fresh synthetic fixture expected');
      await a.vault.create(name, content);
    }
    leftA = a.workspace.getLeaf(false); await leftA.openFile(file('Layout-A.md')); leftA.setPinned(true);
    const av = leftA.getViewState(); await leftA.setViewState({ ...av, state: { ...av.state, mode: 'source', source: true } });
    leftA.view.editor.setCursor({ line: 25, ch: 7 }); leftA.view.editor.scrollTo(0, 350);
    activate(leftA); leftB = a.workspace.getLeaf('tab'); await leftB.openFile(file('Layout-B.md'));
    const bv = leftB.getViewState(); await leftB.setViewState({ ...bv, state: { ...bv.state, mode: 'source', source: false } });
    rightTop = a.workspace.getLeaf('split', 'vertical'); await rightTop.openFile(file('Layout-C.md'));
    const cv = rightTop.getViewState(); await rightTop.setViewState({ ...cv, state: { ...cv.state, mode: 'preview' } });
    activate(rightTop); rightBottom = a.workspace.getLeaf('split', 'horizontal'); await rightBottom.openFile(file('Layout-D.md'));
    const dv = rightBottom.getViewState(); await rightBottom.setViewState({ ...dv, state: { ...dv.state, mode: 'source', source: true } });
    rightBottom.view.editor.setCursor({ line: 44, ch: 9 }); rightBottom.view.editor.scrollTo(0, 900);
    activate(leftB); await pause(400); leftB.view.editor.setCursor({ line: 123, ch: 8 }); leftB.view.editor.scrollTo(0, 2300); await pause(500);
    const screenshot = await capture('layout-nested-state');
    return { action: 'Original getLeaf(tab/split vertical/split horizontal), setPinned, setViewState and editor cursor/scroll APIs; no layout JSON injection', leafIds: { leftA: leftA.id, leftB: leftB.id, rightTop: rightTop.id, rightBottom: rightBottom.id }, after: state(), screenshot };
  });
  await run('split-dimension-serialization', async () => {
    const root = a.workspace.rootSplit, horizontal = rightTop.parent.parent;
    const before = state();
    const targets = [{ node: root.children[0], value: 37 }, { node: root.children[1], value: 63 }, { node: horizontal.children[0], value: 61 }, { node: horizontal.children[1], value: 39 }];
    const calls = [];
    for (const { node, value } of targets) {
      if (typeof node?.setDimension !== 'function') throw Error('setDimension is not available for a split child');
      calls.push({ id: node.id, argument: value, arity: node.setDimension.length }); node.setDimension(value);
    }
    a.workspace.onResize(); await pause(450); const screenshot = await capture('layout-dimensions');
    return { action: 'Call existing child.setDimension with 37/63 and 61/39, then original workspace.onResize', calls, before, after: state(), screenshot };
  });
  await run('sidebar-layout-width-collapse-and-tab-selection', async () => {
    const before = state(), requested = clone(a.workspace.getLayout());
    requested.left.width = 231; requested.left.collapsed = true; requested.right.width = 277; requested.right.collapsed = false;
    if (requested.left.children[0]?.type === 'tabs') requested.left.children[0].currentTab = 1;
    if (requested.right.children[0]?.type === 'tabs') requested.right.children[0].currentTab = 2;
    await a.workspace.changeLayout(requested); await pause(800); const screenshot = await capture('layout-sidebars');
    return { action: 'changeLayout of original getLayout object with only sidebar widths/collapse/currentTab changed', methodArity: a.workspace.changeLayout.length, requested, before, after: state(), screenshot };
  });
  await run('layout-persistent-versus-ephemeral-save', async () => {
    leftA = a.workspace.getLeafById(leftA.id); leftB = a.workspace.getLeafById(leftB.id); rightTop = a.workspace.getLeafById(rightTop.id); rightBottom = a.workspace.getLeafById(rightBottom.id);
    activate(leftB); await pause(250); leftB.view.editor.setCursor({ line: 123, ch: 8 }); leftB.view.editor.scrollTo(0, 2300); await pause(350);
    const screenshot = await capture('layout-saved-visible-state'); await pause(350);
    savedLayout = clone(a.workspace.getLayout()); savedEphemeral = clone(leftB.getEphemeralState()); beforeRestore = state();
    return { savedLayout, savedEphemeral, savedViewState: clone(leftB.getViewState()), savedViewStateInner: clone(leftB.view.getState()), before: beforeRestore, screenshot };
  });
  await run('change-layout-roundtrip-actual-state', async () => {
    if (!savedLayout) throw Error('No saved layout');
    const retained = a.workspace.getLeavesOfType('markdown')[0];
    for (const leaf of a.workspace.getLeavesOfType('markdown')) if (leaf !== retained) leaf.detach();
    retained.setPinned(false); await retained.openFile(file('Convert.md')); activate(retained); await pause(350); const changed = state();
    await a.workspace.changeLayout(clone(savedLayout)); await pause(1000); const screenshot = await capture('layout-roundtrip-restored');
    const restored = state(), expectedActive = beforeRestore.leaves.find(leaf => leaf.active), actualActive = restored.leaves.find(leaf => leaf.active);
    return { action: 'Detach all but one Markdown leaf; unpin/open different file; changeLayout(saved getLayout)', changed, before: beforeRestore, restored, checks: { activeIdMatches: restored.activeLeaf === beforeRestore.activeLeaf, activeFileMatches: restored.activeFile === beforeRestore.activeFile, pinnedByIdMatches: beforeRestore.leaves.every(leaf => restored.leaves.find(item => item.id === leaf.id)?.pinned === leaf.pinned), actualCursorMatches: JSON.stringify(actualActive?.cursor) === JSON.stringify(expectedActive?.cursor), actualScrollTopBefore: expectedActive?.scroll?.top, actualScrollTopAfter: actualActive?.scroll?.top, mainJsonMatches: JSON.stringify(restored.layout.main) === JSON.stringify(savedLayout.main) }, screenshot };
  });
  await run('ephemeral-roundtrip-actual-cursor-scroll', async () => {
    const leaf = a.workspace.getLeafById(savedLayout.active); if (!leaf) throw Error('Saved active leaf is unavailable');
    activate(leaf); await pause(200); leaf.view.editor.setCursor({ line: 2, ch: 1 }); leaf.view.editor.scrollTo(0, 0); await pause(300); const changed = leafState(leaf);
    const returned = leaf.setEphemeralState(clone(savedEphemeral)); if (returned?.then) await returned;
    await pause(600); const screenshot = await capture('layout-ephemeral-restored');
    return { action: 'Reset actual cursor/scroll then leaf.setEphemeralState(saved getEphemeralState)', supplied: savedEphemeral, before: beforeRestore.leaves.find(item => item.id === leaf.id), changed, restored: leafState(leaf), screenshot };
  });
  await run('source-mode-ephemeral-selection-and-scroll', async () => {
    const leaf = a.workspace.getLeafById(leftA.id); if (!leaf) throw Error('Original pinned source leaf is unavailable');
    activate(leaf); await pause(350);
    leaf.view.editor.setSelection({ line: 76, ch: 3 }, { line: 77, ch: 9 }); leaf.view.editor.scrollTo(0, 1800); await pause(500);
    const beforeScreenshot = await capture('layout-source-scroll-before'); await pause(400);
    const before = leafState(leaf), supplied = clone(leaf.getEphemeralState());
    leaf.view.editor.setCursor({ line: 2, ch: 1 }); leaf.view.editor.scrollTo(0, 0); await pause(350);
    const changed = leafState(leaf); const returned = leaf.setEphemeralState(clone(supplied)); if (returned?.then) await returned;
    await pause(650); const restoredScreenshot = await capture('layout-source-scroll-restored'); await pause(400);
    const restored = leafState(leaf);
    return { action: 'Pinned source=true leaf: setSelection plus scroll; reset; setEphemeralState; read actual selection, DOM scrollTop and visible line text after fresh capture', before, supplied, changed, restored, checks: { selectionsMatch: JSON.stringify(before.selections) === JSON.stringify(restored.selections), firstVisibleTextMatches: before.visibleSourceLines[0]?.text === restored.visibleSourceLines[0]?.text, firstVisibleTopBefore: before.visibleSourceLines[0]?.topRelativeToViewport, firstVisibleTopAfter: restored.visibleSourceLines[0]?.topRelativeToViewport, pixelScrollBefore: before.sourceScroller?.scrollTop, pixelScrollAfter: restored.sourceScroller?.scrollTop }, beforeScreenshot, restoredScreenshot };
  });
  await run('source-ephemeral-scroll-unit-calibration', async () => {
    const leaf = a.workspace.getLeafById(leftA.id); activate(leaf); await pause(250);
    const cases = [];
    for (const [index, scroll] of [0, 10.5, 80.25].entries()) {
      const returned = leaf.setEphemeralState({ scroll }); if (returned?.then) await returned;
      await pause(650); const screenshot = await capture('layout-scroll-unit-' + index); await pause(350);
      cases.push({ supplied: { scroll }, actual: leafState(leaf), screenshot });
    }
    return { action: 'Supply original leaf.setEphemeralState({scroll:0}), 10.5 and 80.25; independently read visible source line text and its viewport offset', fixtureLineMapping: 'Markdown line 0 is heading, line 1 blank, line 2 contains Line 000 synthetic text.', cases };
  });
  await run('sidebar-collapse-api-events', async () => {
    const before = state(), calls = [];
    for (const [name, split] of [['left', a.workspace.leftSplit], ['right', a.workspace.rightSplit]]) {
      for (const operation of ['expand', 'collapse', 'expand']) {
        if (typeof split?.[operation] !== 'function') { calls.push({ side: name, operation, available: false }); continue; }
        split[operation](); await pause(250); calls.push({ side: name, operation, available: true, after: sidebar(split) });
      }
    }
    return { before, calls, after: state(), screenshot: await capture('layout-sidebar-events') };
  });
  for (const ref of refs) a.workspace.offref(ref);
  ipcRenderer.send('round3:report', { schema: 'obsidian-windows-round3-layout-v1', status: 'complete', error: null, completionMeaning: 'Probe sequence ended; observations and probe-errors are not implementation parity claims.', environment: { coreVersion: '1.13.7', versions: process.versions, vaultIsSynthetic: true, verifiedBasePath: a.vault.adapter.getBasePath(), coreSha256: config.coreSha256 }, results, events });
}
