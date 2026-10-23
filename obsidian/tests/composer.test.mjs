import test from 'node:test';
import assert from 'node:assert/strict';
import { planExtract, planMerge } from '../core/composer.mjs';
import { getReferences, parseMarkdown } from '../core/vault.mjs';

function selection(text, fragment) {
  const from = text.indexOf(fragment);
  assert.notEqual(from, -1, 'test fixture contains the selected fragment');
  return { from, to: from + fragment.length, text: fragment };
}

function references(files, path) {
  return getReferences(files[path], path, files).sort((a, b) => a.start - b.start);
}

function destinations(files, path) {
  return references(files, path).map(({ path: target, subpath, display }) => ({ target, subpath, display }));
}

function verifyPlan(plan, before, operation, sourcePath, targetPath) {
  assert.equal(plan.operation, operation);
  assert.equal(plan.sourcePath, sourcePath);
  assert.equal(plan.targetPath, targetPath);
  assert.equal(plan.changes[0].path, targetPath, 'write target before editing incoming references');
  assert.equal(plan.changes[0].kind, operation === 'extract' ? 'create' : 'edit');
  assert.deepEqual(plan.writes, plan.changes.filter(change => change.kind !== 'delete'));
  assert.deepEqual(plan.deletes, operation === 'merge' ? [sourcePath] : []);
  if (operation === 'merge') assert.deepEqual(plan.changes.at(-1), { kind: 'delete', path: sourcePath, before: before[sourcePath], after: null });
  for (const change of plan.changes) {
    assert.equal(change.before, change.kind === 'create' ? null : before[change.path]);
    assert.equal(change.after, change.kind === 'delete' ? null : plan.files[change.path]);
  }
  const applied = { ...before };
  for (const change of plan.changes) {
    if (change.kind === 'delete') delete applied[change.path];
    else applied[change.path] = change.after;
  }
  assert.deepEqual(applied, plan.files, 'changes completely describe the planned files');
}

test('extract preserves all resolved destinations across directories and writes target first', () => {
  const fragment = '# Moved\n[local](./Related.md#Part "title")\n![[./assets/photo.png|200]]\n[[../Outside#Section|Outside label]]\n';
  const files = {
    'Notes/Source.md': `Before.\n\n${fragment}\nAfter.\n`,
    'Notes/Related.md': '# Part\n',
    'Notes/assets/photo.png': 'binary-placeholder',
    'Outside.md': '# Section\n',
    'Unchanged.md': 'Unchanged bytes.\n',
  };
  const snapshot = structuredClone(files);
  const expected = destinations({ ...files, 'Notes/Selection.md': fragment }, 'Notes/Selection.md');
  const plan = planExtract(files, 'Notes/Source.md', selection(files['Notes/Source.md'], fragment), 'Archive/Extracted.md');
  assert.deepEqual(destinations(plan.files, 'Archive/Extracted.md'), expected);
  assert.ok(plan.files['Notes/Source.md'].includes('Before.'));
  assert.ok(plan.files['Notes/Source.md'].includes('After.'));
  assert.ok(!plan.files['Notes/Source.md'].includes('# Moved'));
  assert.equal(plan.files['Unchanged.md'], files['Unchanged.md']);
  assert.deepEqual(files, snapshot, 'planning never mutates its input');
  verifyPlan(plan, files, 'extract', 'Notes/Source.md', 'Archive/Extracted.md');
});

test('moving unresolved relative Markdown links preserves their intended original location', () => {
  const fragment = '![missing image](./assets/missing.png)\n';
  const files = { 'Notes/Source.md': fragment, 'Archive/Target.md': '# Target\n' };
  assert.equal(references(files, 'Notes/Source.md')[0].path, null);
  const extracted = planExtract(files, 'Notes/Source.md', selection(fragment, fragment), 'New/Extracted.md');
  const merged = planMerge(files, 'Notes/Source.md', 'Archive/Target.md');
  for (const [plan, target] of [[extracted, 'New/Extracted.md'], [merged, 'Archive/Target.md']]) {
    assert.equal(references(plan.files, target)[0].path, null, 'missing assets remain unresolved');
    const withOriginalAsset = { ...plan.files, 'Notes/assets/missing.png': 'later restored' };
    assert.equal(references(withOriginalAsset, target)[0].path, 'Notes/assets/missing.png', 'later restored assets still resolve at the original location');
  }
});

test('moving raw HTML file links is rejected instead of silently changing their destinations', () => {
  const fragment = '<img src="./assets/photo.png" alt="Photo">\n';
  const files = {
    'Notes/Source.md': fragment,
    'Notes/assets/photo.png': 'image',
    'Archive/Target.md': '# Target\n',
  };
  const snapshot = structuredClone(files);
  assert.throws(() => planExtract(files, 'Notes/Source.md', selection(fragment, fragment), 'New/Extracted.md'));
  assert.throws(() => planMerge(files, 'Notes/Source.md', 'Archive/Target.md'));
  assert.deepEqual(files, snapshot);
});

test('extract redirects incoming moved heading and block anchors while preserving ordinary note links', () => {
  const fragment = '# Moved\nMoved paragraph. ^moved-block\n';
  const files = {
    'Source.md': `# Remains\nStay here.\n\n${fragment}`,
    'Incoming.md': '[[Source]]\n[[Source#Moved|Heading]]\n![[Source#^moved-block]]\n[remain](Source.md#Remains)\n',
  };
  const plan = planExtract(files, 'Source.md', selection(files['Source.md'], fragment), 'Folder/Moved.md');
  assert.deepEqual(destinations(plan.files, 'Incoming.md'), [
    { target: 'Source.md', subpath: '', display: null },
    { target: 'Folder/Moved.md', subpath: '#Moved', display: 'Heading' },
    { target: 'Folder/Moved.md', subpath: '#^moved-block', display: null },
    { target: 'Source.md', subpath: '#Remains', display: 'remain' },
  ]);
});

test('extract distinguishes selected self anchors from anchors staying in the original note', () => {
  const fragment = '# Moved\n[[#Moved|self]]\n[[#Stays|original]]\n';
  const files = { 'Folder/Source.md': `# Stays\nOriginal.\n\n${fragment}` };
  const plan = planExtract(files, 'Folder/Source.md', selection(files['Folder/Source.md'], fragment), 'New/Target.md');
  assert.deepEqual(destinations(plan.files, 'New/Target.md'), [
    { target: 'New/Target.md', subpath: '#Moved', display: 'self' },
    { target: 'Folder/Source.md', subpath: '#Stays', display: 'original' },
  ]);
});

test('new extract filenames do not steal existing shortest-path Markdown or Canvas links', () => {
  const fragment = 'Extract this paragraph.\n';
  const files = {
    'A/Source.md': fragment,
    'B/Target.md': '# Original target\n',
    'A/Reader.md': '[[Target#Original target|original]]\n',
    'A/Board.canvas': JSON.stringify({ nodes: [{ id: 'text', type: 'text', text: '[[Target#Original target]]' }], edges: [] }),
  };
  assert.equal(references(files, 'A/Reader.md')[0].path, 'B/Target.md');
  const plan = planExtract(files, 'A/Source.md', selection(fragment, fragment), 'A/Target.md');
  assert.equal(references(plan.files, 'A/Reader.md')[0].path, 'B/Target.md');
  const canvas = JSON.parse(plan.files['A/Board.canvas']);
  assert.equal(getReferences(canvas.nodes[0].text, 'A/Board.canvas', plan.files)[0].path, 'B/Target.md');
});

test('extract uses UTF-16 editor offsets and preserves surrounding emoji and CRLF', () => {
  const fragment = 'Move 中文 😀 text.\r\n';
  const source = `😀 Before.\r\n\r\n${fragment}\r\n📝 After.\r\n`;
  const files = { 'Source.md': source };
  const range = selection(source, fragment);
  const plan = planExtract(files, 'Source.md', range, 'Target.md');
  assert.ok(plan.files['Target.md'].includes(fragment));
  assert.ok(plan.files['Source.md'].startsWith('😀 Before.\r\n'));
  assert.ok(plan.files['Source.md'].endsWith('📝 After.\r\n'));
  assert.deepEqual(range, selection(source, fragment), 'selection input stays unchanged');
});

test('extract rejects stale, empty, fractional and out-of-bounds editor selections', () => {
  const files = { 'Source.md': 'A paragraph.\n' };
  for (const range of [
    { from: 0, to: 1, text: 'stale' },
    { from: 0, to: 0, text: '' },
    { from: -1, to: 1, text: '' },
    { from: 0, to: 100, text: files['Source.md'] },
    { from: 1.5, to: 2, text: '' },
  ]) assert.throws(() => planExtract(files, 'Source.md', range, 'Target.md'));
});

test('extract rejects partial frontmatter, link, code and heading structures', () => {
  for (const [source, fragment] of [
    ['---\nstatus: active\n---\nBody.\n', 'status: active'],
    ['Before [[Target|Label]] after.\n', 'Target'],
    ['Before [label](Target.md) after.\n', 'label](Target'],
    ['Before `inline code` after.\n', 'line code'],
    ['Before.\n\n```js\nconst answer = 42;\n```\nAfter.\n', 'const answer = 42;'],
    ['# A heading\nBody.\n', 'heading'],
    ['A heading\n=========\nBody.\n', 'heading\n'],
  ]) {
    const files = { 'Source.md': source, 'Target.md': '' };
    assert.throws(() => planExtract(files, 'Source.md', selection(source, fragment), 'Extracted.md'), `reject partial structure: ${fragment}`);
  }
});

test('extract allows a complete fenced block without turning code examples into references', () => {
  const fragment = '```md\n[[Missing]]\n```\n';
  const files = { 'Source.md': `Before.\n\n${fragment}\nAfter.\n` };
  const plan = planExtract(files, 'Source.md', selection(files['Source.md'], fragment), 'Target.md');
  assert.ok(plan.files['Target.md'].includes(fragment));
  assert.deepEqual(references(plan.files, 'Target.md'), []);
});

test('extract refuses reference-style links whose definitions remain behind', () => {
  const fragment = 'Read [guide][manual].\n';
  const files = { 'Source.md': `${fragment}\n[manual]: ./Manual.md#Part "Manual"\n`, 'Manual.md': '# Part\n' };
  assert.throws(() => planExtract(files, 'Source.md', selection(files['Source.md'], fragment), 'New/Target.md'));
});

test('composer validates missing files, collisions, note types and paths before planning', () => {
  const files = { 'Source.md': 'Text.\n', 'Target.md': 'Target.\n', 'Image.png': 'image' };
  const range = selection(files['Source.md'], files['Source.md']);
  for (const target of ['../Outside.md', 'C:/Outside.md', '/Outside.md', 'Invalid\0.md', 'Source.md', 'Target.md', 'Image.png']) {
    assert.throws(() => planExtract(files, 'Source.md', range, target), `invalid extract destination ${target}`);
  }
  assert.throws(() => planExtract(files, 'Missing.md', range, 'New.md'));
  assert.throws(() => planMerge(files, 'Missing.md', 'Target.md'));
  assert.throws(() => planMerge(files, 'Source.md', 'Missing.md'));
  assert.throws(() => planMerge(files, 'Source.md', 'Source.md'));
  assert.throws(() => planMerge(files, 'Source.md', 'Image.png'));
});

test('merge preserves the target prefix, outgoing destinations and source self anchors', () => {
  const files = {
    'Notes/Source.md': '# Origin\n[[#Origin|self]]\n[related](./Related.md#Part)\n![[./assets/photo.png|200]]\n',
    'Notes/Related.md': '# Part\n',
    'Notes/assets/photo.png': 'image',
    'Archive/Target.md': '# Target\n\nKeep **all** original bytes.\n',
    'Unchanged.md': 'Unchanged.\n',
  };
  const snapshot = structuredClone(files);
  const plan = planMerge(files, 'Notes/Source.md', 'Archive/Target.md');
  assert.ok(plan.files['Archive/Target.md'].startsWith(files['Archive/Target.md']));
  assert.deepEqual(destinations(plan.files, 'Archive/Target.md'), [
    { target: 'Archive/Target.md', subpath: '#Origin', display: 'self' },
    { target: 'Notes/Related.md', subpath: '#Part', display: 'related' },
    { target: 'Notes/assets/photo.png', subpath: '', display: '200' },
  ]);
  assert.ok(!Object.hasOwn(plan.files, 'Notes/Source.md'));
  assert.deepEqual(files, snapshot);
  verifyPlan(plan, files, 'merge', 'Notes/Source.md', 'Archive/Target.md');
});

test('merge rewrites ordinary, embedded, frontmatter and Canvas incoming source references', () => {
  const canvas = {
    nodes: [
      { id: 'file', type: 'file', file: 'Notes/Source.md', subpath: '#Origin', custom: { color: 'violet' } },
      { id: 'text', type: 'text', text: '[[Notes/Source#Origin|label]]\n`[[Notes/Source]]`' },
      { id: 'url', type: 'link', url: 'https://example.com/Notes/Source.md' },
    ],
    edges: [{ id: 'edge', fromNode: 'file', toNode: 'text' }],
  };
  const files = {
    'Notes/Source.md': '# Origin\nParagraph. ^block\n',
    'Archive/Target.md': '# Target\n',
    'Incoming.md': '---\nref: "[[Notes/Source#Origin]]"\n---\n[[Notes/Source|label]]\n![[Notes/Source#^block]]\n[markdown](Notes/Source.md#Origin "title")\n',
    'Board.canvas': JSON.stringify(canvas),
  };
  const plan = planMerge(files, 'Notes/Source.md', 'Archive/Target.md');
  assert.equal(references(plan.files, 'Incoming.md').length, 4);
  assert.ok(references(plan.files, 'Incoming.md').every(ref => ref.path === 'Archive/Target.md'));
  const afterCanvas = JSON.parse(plan.files['Board.canvas']);
  assert.equal(afterCanvas.nodes[0].file, 'Archive/Target.md');
  assert.equal(afterCanvas.nodes[0].subpath, '#Origin');
  assert.deepEqual(afterCanvas.nodes[0].custom, canvas.nodes[0].custom);
  assert.equal(getReferences(afterCanvas.nodes[1].text, 'Board.canvas', plan.files)[0].path, 'Archive/Target.md');
  assert.ok(afterCanvas.nodes[1].text.includes('`[[Notes/Source]]`'));
  assert.deepEqual(afterCanvas.nodes[2], canvas.nodes[2]);
  assert.deepEqual(afterCanvas.edges, canvas.edges);
  verifyPlan(plan, files, 'merge', 'Notes/Source.md', 'Archive/Target.md');
});

test('merge carries source-only frontmatter to the top without losing target content', () => {
  const files = {
    'Source.md': '---\nstatus: active\ntags: [work, project]\n---\n# Source\nBody.\n',
    'Target.md': '# Target\nTarget body.\n',
  };
  const plan = planMerge(files, 'Source.md', 'Target.md');
  assert.deepEqual(parseMarkdown(plan.files['Target.md']).frontmatter, { status: 'active', tags: ['work', 'project'] });
  assert.ok(plan.files['Target.md'].includes(files['Target.md']));
  assert.ok(plan.files['Target.md'].includes('# Source\nBody.\n'));
});

test('merge separates frontmatter ending at EOF from the target body', () => {
  const files = {
    'Source.md': '---\nstatus: active\ncount: 3\n---',
    'Target.md': '# Target\nOriginal target content.\n',
  };
  const plan = planMerge(files, 'Source.md', 'Target.md');
  const metadata = parseMarkdown(plan.files['Target.md']);
  assert.deepEqual(metadata.frontmatter, { status: 'active', count: 3 });
  assert.equal(metadata.frontmatterErrors.length, 0);
  assert.ok(plan.files['Target.md'].includes(files['Target.md']));
  assert.deepEqual(metadata.headings.map(item => item.heading), ['Target']);
});

test('merge combines disjoint YAML properties and preserves links moved with source frontmatter', () => {
  const files = {
    'Notes/Source.md': '---\nstatus: active\nref: "[[./Related#Part|related]]"\n---\n# Source\n',
    'Notes/Related.md': '# Part\n',
    'Archive/Target.md': '---\ntitle: Target\ncount: 7\n---\n# Target\n',
  };
  const plan = planMerge(files, 'Notes/Source.md', 'Archive/Target.md');
  const metadata = parseMarkdown(plan.files['Archive/Target.md']);
  assert.equal(metadata.frontmatter.title, 'Target');
  assert.equal(metadata.frontmatter.count, 7);
  assert.equal(metadata.frontmatter.status, 'active');
  assert.equal(metadata.frontmatterErrors.length, 0);
  assert.deepEqual(destinations(plan.files, 'Archive/Target.md'), [{ target: 'Notes/Related.md', subpath: '#Part', display: 'related' }]);
});

test('conflicting YAML is preserved as a clearly marked fenced block with a warning', () => {
  const sourceYaml = 'title: Source title\nstatus: draft\n';
  const files = {
    'Source.md': `---\n${sourceYaml}---\n# Source\nSource body.\n`,
    'Target.md': '---\ntitle: Target title\n---\n# Target\nTarget body.\n',
  };
  const plan = planMerge(files, 'Source.md', 'Target.md');
  assert.equal(parseMarkdown(plan.files['Target.md']).frontmatter.title, 'Target title');
  assert.match(plan.files['Target.md'], /```ya?ml\b/);
  assert.ok(plan.files['Target.md'].includes(sourceYaml));
  assert.ok(plan.files['Target.md'].includes('Source body.'));
  assert.ok(plan.files['Target.md'].includes('Target body.'));
  assert.ok(plan.warnings.length > 0);
});

test('merge refuses ambiguous incoming anchors caused by duplicate headings', () => {
  const files = { 'Source.md': '# Shared\nSource.\n', 'Target.md': '# Shared\nTarget.\n', 'Reader.md': '[[Source#Shared]]\n' };
  const snapshot = structuredClone(files);
  assert.throws(() => planMerge(files, 'Source.md', 'Target.md'));
  assert.deepEqual(files, snapshot);
});

test('merge rejects an unclosed target fence which would swallow the appended source', () => {
  const files = { 'Source.md': '# Source\nVisible source body.\n', 'Target.md': '# Target\n\n```md\nUnclosed code.\n' };
  const snapshot = structuredClone(files);
  assert.throws(() => planMerge(files, 'Source.md', 'Target.md'));
  assert.deepEqual(files, snapshot);
});

test('merge keeps disjoint reference definitions and their relative destination identities', () => {
  const files = {
    'Notes/Source.md': 'Read [source guide][source-id].\n\n[source-id]: ./Guide.md#Part "Source guide"\n',
    'Notes/Guide.md': '# Part\n',
    'Archive/Target.md': 'Read [target guide][target-id].\n\n[target-id]: https://example.com/guide\n',
  };
  const plan = planMerge(files, 'Notes/Source.md', 'Archive/Target.md');
  const target = plan.files['Archive/Target.md'];
  assert.ok(target.includes('[source guide][source-id]'));
  assert.ok(target.includes('[target guide][target-id]'));
  assert.match(target, /\[target-id\]: https:\/\/example\.com\/guide/);
  const definition = /^\[source-id\]:\s*(.+)$/m.exec(target);
  assert.ok(definition);
  const ref = getReferences(`[link](${definition[1]})`, 'Archive/Target.md', plan.files)[0];
  assert.equal(ref.path, 'Notes/Guide.md');
  assert.equal(ref.subpath, '#Part');
});

test('merge rejects colliding reference-definition names instead of silently retargeting links', () => {
  const files = {
    'Source.md': '[source][shared]\n\n[shared]: SourceGuide.md\n',
    'Target.md': '[target][SHARED]\n\n[SHARED]: TargetGuide.md\n',
    'SourceGuide.md': '',
    'TargetGuide.md': '',
  };
  assert.throws(() => planMerge(files, 'Source.md', 'Target.md'));
});

test('extract rejects an escape prefix which would turn the inserted wiki link into literal text', () => {
  const source = 'Prefix \\selected suffix.';
  const from = source.indexOf('selected');
  assert.throws(() => planExtract({ 'Source.md': source }, 'Source.md', { from, to: from + 8, text: 'selected' }, 'Extracted.md'), /escape/i);
});

test('extract rejects partial HTML attributes and autolinks rather than inserting markup inside them', () => {
  for (const source of ['<a href="https://example.com/selected">Link</a>', '<https://example.com/selected>']) {
    const from = source.indexOf('selected');
    assert.throws(() => planExtract({ 'Source.md': source }, 'Source.md', { from, to: from + 8, text: 'selected' }, 'Extracted.md'), /HTML|autolink/i);
  }
});
