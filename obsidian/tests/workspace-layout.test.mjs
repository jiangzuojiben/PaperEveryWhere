import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkspaceLayout,
  normalizeTabState,
  splitWorkspacePane,
  dockWorkspaceTab,
  removeWorkspacePane,
  resizeLayoutSplit,
  updateWorkspaceTabState,
  getPaneTabState,
  remapPanes,
  moveTab,
} from '../core/workspace.mjs';

const leaf = id => ({ id, type: 'leaf' });
const pane = (id, tabs, extra = {}) => ({ id, tabs, active: tabs[0] ?? null, pinned: [], ...extra });
const split = (id, direction, children, sizes = children.map(() => 1 / children.length)) => ({
  id, type: 'split', direction, children, sizes,
});
const tabState = (extra = {}) => ({
  mode: 'source',
  cursor: { anchor: 17, head: 29 },
  selections: [{ anchor: 17, head: 29 }, { anchor: 43, head: 43 }],
  mainIndex: 1,
  scroll: { top: 420, left: 12 },
  readingScrollTop: 730,
  ...extra,
});
const twoPanes = () => normalizeWorkspaceLayout({
  panes: [pane('one', ['a.md', 'keep.md']), pane('two', ['b.md'])],
  layout: split('root', 'vertical', [leaf('one'), leaf('two')], [.35, .65]),
  activePaneId: 'one',
});

function walk(node, visit) {
  visit(node);
  if (node.type === 'split') node.children.forEach(child => walk(child, visit));
}
function leafIds(node) {
  const ids = [];
  walk(node, item => { if (item.type === 'leaf') ids.push(item.id); });
  return ids;
}
function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
function assertValidWorkspace(workspace) {
  assert.equal(workspace.layoutVersion, 2);
  assert.ok(workspace.panes.length >= 1 && workspace.panes.length <= 64);
  const ids = new Set();
  walk(workspace.layout, node => {
    assert.equal(typeof node.id, 'string');
    assert.ok(node.id.length > 0);
    assert.ok(!ids.has(node.id), `duplicate layout ID ${node.id}`);
    ids.add(node.id);
    if (node.type === 'split') {
      assert.ok(['horizontal', 'vertical'].includes(node.direction));
      assert.ok(node.children.length >= 2);
      assert.equal(node.sizes.length, node.children.length);
      assert.ok(node.sizes.every(value => Number.isFinite(value) && value > 0));
      assert.ok(Math.abs(node.sizes.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
    } else assert.equal(node.type, 'leaf');
  });
  assert.deepEqual(new Set(leafIds(workspace.layout)), new Set(workspace.panes.map(item => item.id)));
  assert.equal(new Set(workspace.panes.map(item => item.id)).size, workspace.panes.length);
  assert.equal(workspace.panes[workspace.paneIndex].id, workspace.activePaneId);
}

test('legacy horizontal layouts migrate to left/right trees without the old four-pane limit', () => {
  const input = {
    panes: Array.from({ length: 7 }, (_, index) => ({ tabs: [`${index}.md`], active: `${index}.md`, pinned: [] })),
    splitDirection: 'horizontal', paneIndex: 5, customSetting: 'preserved',
  };
  const before = structuredClone(input);
  const result = normalizeWorkspaceLayout(input);
  assertValidWorkspace(result);
  assert.equal(result.layout.direction, 'vertical');
  assert.equal(result.panes.length, 7);
  assert.equal(result.panes[result.paneIndex].active, '5.md');
  assert.equal(result.customSetting, 'preserved');
  assert.deepEqual(input, before);
  const restored = normalizeWorkspaceLayout(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(restored.panes, result.panes);
  assert.deepEqual(leafIds(restored.layout), leafIds(result.layout));
  assert.equal(restored.layout.id, result.layout.id);
  assert.equal(restored.activePaneId, result.activePaneId);
  assert.ok(restored.layout.sizes.every((size, index) => Math.abs(size - result.layout.sizes[index]) < 1e-9));
});

test('legacy vertical layouts migrate to top/bottom while missing files leave usable empty panes', () => {
  const result = normalizeWorkspaceLayout({
    panes: [pane('empty', ['gone.md'], { pinned: ['gone.md'] }), pane('kept', ['C# Basics.md', '@web:https://example.com'])],
    splitDirection: 'vertical', paneIndex: 0,
  }, ['C# Basics.md']);
  assertValidWorkspace(result);
  assert.equal(result.layout.direction, 'horizontal');
  assert.deepEqual(result.panes[0].tabs, []);
  assert.equal(result.panes[0].active, null);
  assert.deepEqual(result.panes[0].pinned, []);
  assert.deepEqual(result.panes[1].tabs, ['C# Basics.md', '@web:https://example.com']);
});

test('nested mixed splits retain stable IDs, active pane, ratios and sidebar dimensions', () => {
  const input = {
    name: 'Research', panes: [pane('one', ['a.md']), pane('two', ['b.md']), pane('three', ['c.md'])],
    layout: split('root', 'vertical', [leaf('one'), split('stack', 'horizontal', [leaf('two'), leaf('three')], [2, 3])], [1, 3]),
    activePaneId: 'three', paneIndex: 0,
    sidebars: { left: { width: 286, collapsed: false }, right: { width: 352, collapsed: true } },
  };
  const before = structuredClone(input);
  const result = normalizeWorkspaceLayout(input);
  assertValidWorkspace(result);
  assert.deepEqual(leafIds(result.layout), ['one', 'two', 'three']);
  assert.deepEqual(result.layout.sizes, [.25, .75]);
  assert.deepEqual(findNode(result.layout, 'stack').sizes, [.4, .6]);
  assert.equal(result.activePaneId, 'three');
  assert.deepEqual(result.sidebars, input.sidebars);
  assert.deepEqual(input, before);
});

test('normalization repairs duplicate IDs, unknown leaves and cyclic split data', () => {
  const cyclic = split('cycle', 'vertical', [], []);
  cyclic.children = [leaf('same'), cyclic, leaf('unknown'), leaf('same')];
  cyclic.sizes = [1, NaN, -2, 0];
  const result = normalizeWorkspaceLayout({
    panes: [pane('same', ['a.md']), pane('same', ['b.md']), pane('third', ['c.md'])],
    layout: cyclic, activePaneId: 'unknown', paneIndex: 99,
  });
  assertValidWorkspace(result);
  assert.equal(result.panes.length, 3);
  assert.deepEqual(result.panes.flatMap(item => item.tabs).sort(), ['a.md', 'b.md', 'c.md']);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('normalization limits oversized saved layouts to 64 panes and keeps a valid active leaf', () => {
  const result = normalizeWorkspaceLayout({
    panes: Array.from({ length: 80 }, (_, index) => pane(`pane-${index}`, [`${index}.md`])),
    paneIndex: 79,
  });
  assertValidWorkspace(result);
  assert.equal(result.panes.length, 64);
});

test('normalization recovers finite positive ratios even when saved weights overflow their sum', () => {
  const result = normalizeWorkspaceLayout({
    panes: [pane('one', ['a.md']), pane('two', ['b.md'])],
    layout: split('root', 'vertical', [leaf('one'), leaf('two')], [Number.MAX_VALUE, Number.MAX_VALUE]),
  });
  assertValidWorkspace(result);
  assert.deepEqual(result.layout.sizes, [.5, .5]);
});

test('resizing one split preserves nested geometry and clamps both adjacent panes', () => {
  const input = split('root', 'vertical', [leaf('one'), split('stack', 'horizontal', [leaf('two'), leaf('three')], [.4, .6])], [.3, .7]);
  const before = structuredClone(input);
  const result = resizeLayoutSplit(input, 'root', 0, .1, { minRatio: .1 });
  assert.ok(Math.abs(result.sizes[0] - .4) < 1e-9);
  assert.ok(Math.abs(result.sizes[1] - .6) < 1e-9);
  assert.deepEqual(findNode(result, 'stack'), findNode(input, 'stack'));
  const clamped = resizeLayoutSplit(result, 'stack', 0, 3, { minRatio: .1 });
  assert.ok(Math.abs(findNode(clamped, 'stack').sizes[0] - .9) < 1e-9);
  assert.ok(Math.abs(findNode(clamped, 'stack').sizes[1] - .1) < 1e-9);
  assert.deepEqual(clamped.sizes, result.sizes);
  assert.deepEqual(resizeLayoutSplit(input, 'absent', 0, .2), input);
  assert.deepEqual(input, before);
});

test('splitting an existing leaf can create nested opposite-direction layouts', () => {
  const input = twoPanes();
  const before = structuredClone(input);
  const result = splitWorkspacePane(input, 'two', 'horizontal', { path: 'new.md', side: 'before', clone: false });
  assertValidWorkspace(result);
  assert.equal(result.panes.length, 3);
  assert.equal(result.layout.direction, 'vertical');
  const targetBranch = result.layout.children.find(item => item.type === 'split');
  assert.equal(targetBranch.direction, 'horizontal');
  assert.equal(targetBranch.children[1].id, 'two');
  const added = result.panes.find(item => !input.panes.some(previous => previous.id === item.id));
  assert.deepEqual(added.tabs, ['new.md']);
  assert.equal(targetBranch.children[0].id, added.id);
  assert.equal(result.activePaneId, added.id);
  assert.deepEqual(input, before);
});

test('cloning a pane carries the selected note state and pin into an independent leaf', () => {
  const state = tabState();
  const input = normalizeWorkspaceLayout({ panes: [pane('one', ['a.md'], { pinned: ['a.md'], tabStates: { 'a.md': state } })] });
  const before = structuredClone(input);
  const result = splitWorkspacePane(input, 'one', 'vertical', { side: 'after', clone: true });
  assertValidWorkspace(result);
  const added = result.panes.find(item => item.id !== 'one');
  assert.deepEqual(added.tabs, ['a.md']);
  assert.deepEqual(added.pinned, ['a.md']);
  assert.deepEqual(getPaneTabState(added, 'a.md'), getPaneTabState(input.panes[0], 'a.md'));
  assert.deepEqual(input, before);
});

test('removing nested panes collapses unary splits and always leaves one empty pane', () => {
  let result = normalizeWorkspaceLayout({
    panes: [pane('one', ['a.md']), pane('two', ['b.md']), pane('three', ['c.md'])],
    layout: split('root', 'vertical', [leaf('one'), split('stack', 'horizontal', [leaf('two'), leaf('three')])], [.3, .7]),
    activePaneId: 'three',
  });
  result = removeWorkspacePane(result, 'three');
  assertValidWorkspace(result);
  assert.deepEqual(leafIds(result.layout), ['one', 'two']);
  assert.equal(findNode(result.layout, 'stack'), null);
  assert.deepEqual(result.layout.sizes, [.3, .7]);
  result = removeWorkspacePane(result, 'one');
  assertValidWorkspace(result);
  assert.deepEqual(result.layout, leaf('two'));
  result = removeWorkspacePane(result, 'two');
  assertValidWorkspace(result);
  assert.equal(result.panes.length, 1);
  assert.deepEqual(result.panes[0].tabs, []);
  assert.equal(result.panes[0].active, null);
});

test('center docking the last tab removes its source leaf and preserves pin and complete view state', () => {
  const path = 'C# Basics.md';
  const input = normalizeWorkspaceLayout({
    panes: [pane('one', [path], { pinned: [path], tabStates: { [path]: tabState() } }), pane('two', ['b.md'])],
    layout: split('root', 'vertical', [leaf('one'), leaf('two')]), activePaneId: 'one',
  });
  const before = structuredClone(input);
  const result = dockWorkspaceTab(input, { fromId: 'one', path, toId: 'two', index: 0, edge: 'center' });
  assertValidWorkspace(result);
  assert.deepEqual(result.layout, leaf('two'));
  assert.equal(result.panes.length, 1);
  assert.deepEqual(result.panes[0].tabs, [path, 'b.md']);
  assert.deepEqual(result.panes[0].pinned, [path]);
  assert.equal(result.panes[0].active, path);
  assert.deepEqual(getPaneTabState(result.panes[0], path), getPaneTabState(input.panes[0], path));
  assert.deepEqual(input, before);
});

test('edge docking splits its target and keeps remaining source tabs selected', () => {
  const input = updateWorkspaceTabState(twoPanes(), 'one', 'a.md', tabState({ mode: 'reading' }));
  const before = structuredClone(input);
  const result = dockWorkspaceTab(input, { fromId: 'one', path: 'a.md', toId: 'two', edge: 'bottom' });
  assertValidWorkspace(result);
  assert.equal(result.panes.length, 3);
  const source = result.panes.find(item => item.id === 'one');
  assert.deepEqual(source.tabs, ['keep.md']);
  assert.equal(source.active, 'keep.md');
  const added = result.panes.find(item => !['one', 'two'].includes(item.id));
  assert.deepEqual(added.tabs, ['a.md']);
  assert.deepEqual(getPaneTabState(added, 'a.md'), getPaneTabState(input.panes[0], 'a.md'));
  const targetBranch = result.layout.children.find(item => item.type === 'split');
  assert.equal(targetBranch.direction, 'horizontal');
  assert.deepEqual(targetBranch.children.map(item => item.id), ['two', added.id]);
  assert.equal(result.activePaneId, added.id);
  assert.deepEqual(input, before);
});

test('reordering tabs within a pane retains state and never removes its leaf', () => {
  const input = normalizeWorkspaceLayout({ panes: [pane('one', ['a.md', 'b.md', 'c.md'], { pinned: ['a.md'], tabStates: { 'a.md': tabState() } })] });
  const result = dockWorkspaceTab(input, { fromId: 'one', path: 'a.md', toId: 'one', index: 2, edge: 'center' });
  assertValidWorkspace(result);
  assert.deepEqual(result.panes[0].tabs, ['b.md', 'c.md', 'a.md']);
  assert.deepEqual(result.panes[0].pinned, ['a.md']);
  assert.deepEqual(getPaneTabState(result.panes[0], 'a.md'), getPaneTabState(input.panes[0], 'a.md'));
});

test('docking into an already open note retains the dragged view state without duplicate tabs', () => {
  const input = normalizeWorkspaceLayout({
    panes: [
      pane('one', ['a.md', 'keep.md'], { pinned: ['a.md'], tabStates: { 'a.md': tabState() } }),
      pane('two', ['a.md', 'b.md'], { tabStates: { 'a.md': tabState({ mode: 'reading', cursor: { anchor: 0, head: 0 } }) } }),
    ],
    layout: split('root', 'vertical', [leaf('one'), leaf('two')]),
  });
  const result = dockWorkspaceTab(input, { fromId: 'one', path: 'a.md', toId: 'two', index: 1 });
  assertValidWorkspace(result);
  const target = result.panes.find(item => item.id === 'two');
  assert.deepEqual(target.tabs, ['b.md', 'a.md']);
  assert.deepEqual(target.pinned, ['a.md']);
  assert.deepEqual(getPaneTabState(target, 'a.md'), getPaneTabState(input.panes[0], 'a.md'));
  assert.equal(result.panes.find(item => item.id === 'one').tabStates?.['a.md'], undefined);
});

test('docking a legacy tab retains its pane-level mode when no per-tab state was saved', () => {
  const input = normalizeWorkspaceLayout({
    panes: [pane('one', ['a.md'], { mode: 'source' }), pane('two', ['b.md'], { mode: 'reading' })],
    layout: split('root', 'vertical', [leaf('one'), leaf('two')]),
  });
  const result = dockWorkspaceTab(input, { fromId: 'one', path: 'a.md', toId: 'two' });
  assertValidWorkspace(result);
  const target = result.panes.find(item => item.id === 'two');
  assert.equal(getPaneTabState(target, 'a.md').mode, 'source');
  assert.equal(getPaneTabState(target, 'b.md').mode, 'reading');
});

test('scroll-only state updates retain cursor, selections and reading mode', () => {
  const original = updateWorkspaceTabState(twoPanes(), 'one', 'a.md', tabState({ mode: 'reading' }));
  const before = structuredClone(original);
  const result = updateWorkspaceTabState(original, 'one', 'a.md', { scroll: { top: 950, left: 0 } });
  assert.deepEqual(getPaneTabState(result.panes[0], 'a.md'), {
    ...getPaneTabState(original.panes[0], 'a.md'), scroll: { top: 950, left: 0 },
  });
  assert.deepEqual(original, before);
});

test('main selection index survives full state restoration and clamps to available selections', () => {
  const original = tabState();
  const before = structuredClone(original);
  assert.equal(normalizeTabState(original).mainIndex, 1);
  assert.equal(normalizeTabState({ ...original, mainIndex: 200 }).mainIndex, 1);
  assert.equal(normalizeTabState({ ...original, mainIndex: -8 }).mainIndex, 0);
  assert.equal(normalizeTabState({ ...original, selections: [original.selections[0]], mainIndex: 1 }).mainIndex, 0);
  assert.equal(normalizeTabState({ ...original, selections: [], mainIndex: 1 }).mainIndex, undefined);
  assert.equal(normalizeTabState({ ...original, mainIndex: 1.5 }).mainIndex, undefined);
  assert.deepEqual(original, before);
});

test('per-tab view state survives switching modes, named layout serialization and restoration', () => {
  let workspace = normalizeWorkspaceLayout({
    name: 'Research layout', panes: [pane('one', ['a.md', 'b.md'])],
    sidebars: { left: { width: 278, collapsed: true }, right: { width: 344, collapsed: false } },
  });
  workspace = updateWorkspaceTabState(workspace, 'one', 'a.md', tabState({ mode: 'reading' }));
  workspace = updateWorkspaceTabState(workspace, 'one', 'b.md', tabState({ mode: 'live', cursor: { anchor: 3, head: 5 }, scroll: { top: 18, left: 0 } }));
  const before = structuredClone(workspace);
  const restored = normalizeWorkspaceLayout(JSON.parse(JSON.stringify(workspace)), ['a.md', 'b.md']);
  assertValidWorkspace(restored);
  assert.equal(restored.name, 'Research layout');
  assert.deepEqual(restored.sidebars, workspace.sidebars);
  assert.deepEqual(getPaneTabState(restored.panes[0], 'a.md'), getPaneTabState(workspace.panes[0], 'a.md'));
  assert.deepEqual(getPaneTabState(restored.panes[0], 'b.md'), getPaneTabState(workspace.panes[0], 'b.md'));
  assert.equal(getPaneTabState(restored.panes[0], 'a.md').mode, 'reading');
  assert.equal(getPaneTabState(restored.panes[0], 'b.md').mode, 'live');
  assert.deepEqual(workspace, before);
});

test('renaming a literal hash path remaps its view state without touching another hash filename', () => {
  const input = [pane('one', ['C# Basics.md', 'C# Basics.md#draft.md', '@localgraph:C# Basics.md'], {
    pinned: ['C# Basics.md'],
    tabStates: {
      'C# Basics.md': tabState({ path: 'C# Basics.md' }),
      'C# Basics.md#draft.md': tabState({ mode: 'reading', path: 'C# Basics.md#draft.md' }),
      '@localgraph:C# Basics.md': { mode: 'reading', path: '@localgraph:C# Basics.md' },
    },
  })];
  const before = structuredClone(input);
  const result = remapPanes(input, 'C# Basics.md', 'C# Advanced.md');
  assert.deepEqual(result[0].tabs, ['C# Advanced.md', 'C# Basics.md#draft.md', '@localgraph:C# Advanced.md']);
  assert.deepEqual(result[0].pinned, ['C# Advanced.md']);
  assert.equal(result[0].tabStates['C# Basics.md'], undefined);
  assert.deepEqual(result[0].tabStates['C# Advanced.md'], { ...input[0].tabStates['C# Basics.md'], path: 'C# Advanced.md' });
  assert.deepEqual(result[0].tabStates['C# Basics.md#draft.md'], input[0].tabStates['C# Basics.md#draft.md']);
  assert.equal(result[0].tabStates['@localgraph:C# Advanced.md'].path, '@localgraph:C# Advanced.md');
  assert.deepEqual(input, before);
});

test('the legacy moveTab helper transfers complete per-note state and clears stale source state', () => {
  const input = [
    pane('one', ['a.md', 'keep.md'], { pinned: ['a.md'], tabStates: { 'a.md': tabState(), 'keep.md': tabState({ mode: 'reading' }) } }),
    pane('two', ['b.md'], { tabStates: { 'b.md': tabState({ mode: 'live' }) } }),
  ];
  const before = structuredClone(input);
  const result = moveTab(input, 0, 'a.md', 1, 0);
  assert.deepEqual(result[1].tabs, ['a.md', 'b.md']);
  assert.deepEqual(result[1].pinned, ['a.md']);
  assert.deepEqual(result[1].tabStates['a.md'], input[0].tabStates['a.md']);
  assert.deepEqual(result[1].tabStates['b.md'], input[1].tabStates['b.md']);
  assert.equal(result[0].tabStates['a.md'], undefined);
  assert.deepEqual(result[0].tabStates['keep.md'], input[0].tabStates['keep.md']);
  assert.deepEqual(input, before);
});
