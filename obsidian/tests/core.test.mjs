import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, resolveLink, getReferences, planRename, searchFiles, normalizePath } from '../core/vault.mjs';

test('metadata parses YAML values, heading positions, tags, blocks and escaped links', () => {
  const text = '---\ntitle: 中文\ntags: [work, nested/tag]\ncount: 3\nactive: true\nrefs:\n  - "[[Folder/Note#Part|Label]]"\n---\n# First\nBody #project/alpha ^block-id\nSecond\n------\n\\[[escaped]]\n';
  const metadata = parseMarkdown(text);
  assert.deepEqual(metadata.frontmatter, { title: '中文', tags: ['work', 'nested/tag'], count: 3, active: true, refs: ['[[Folder/Note#Part|Label]]'] });
  assert.deepEqual(metadata.headings.map(({ heading, level, line }) => ({ heading, level, line })), [{ heading: 'First', level: 1, line: 9 }, { heading: 'Second', level: 2, line: 11 }]);
  assert.deepEqual(new Set(metadata.tags), new Set(['#work', '#nested/tag', '#project/alpha']));
  assert.equal(metadata.blocks[0].id, 'block-id');
  assert.equal(metadata.references.length, 1);
  assert.equal(metadata.references[0].kind, 'frontmatter');
  assert.equal(metadata.references[0].subpath, '#Part');
  assert.equal(text.slice(metadata.references[0].start, metadata.references[0].end), metadata.references[0].original);
});

test('code and HTML comments are masked without losing original byte positions; percent comments remain indexed', () => {
  const text = '[[Yes]]\n`[[Inline]]`\n``two ` [[Double]]``\n~~~md\n[[Fenced]]\n~~~\n\n    [[Indented]]\n<!-- [[HTML]] -->\n%% [[Comment]] %%\n![[Picture.png|200]]\n';
  assert.deepEqual(parseMarkdown(text).references.map(reference => [reference.kind, reference.link]), [['link', 'Yes'], ['link', 'Comment'], ['embed', 'Picture.png']]);
});

test('Markdown parser handles balanced destinations, titles, image embeds and decoded spaces', () => {
  const text = '[nested [label]](Folder/A_(B).md#Chapter "Title")\n![picture](<Folder/My%20Pic.png>)\n[external](https://example.com/path)\n';
  const references = getReferences(text, 'Source.md', ['Folder/A_(B).md', 'Folder/My Pic.png']);
  assert.equal(references.length, 2);
  assert.equal(references[0].path, 'Folder/A_(B).md');
  assert.equal(references[0].subpath, '#Chapter');
  assert.equal(references[1].kind, 'embed');
  assert.equal(references[1].path, 'Folder/My Pic.png');
});

test('explicit vault/relative paths are bounded and raw percent encoding is not decoded', () => {
  const paths = ['Note.md', 'Folder/Note.md', 'Folder/Space Note.md', 'Other/Note.md'];
  assert.equal(resolveLink('Note', 'Folder/Source.md', paths), 'Note.md');
  assert.equal(resolveLink('./Note', 'Folder/Source.md', paths), 'Folder/Note.md');
  assert.equal(resolveLink('../Other/Note', 'Folder/Source.md', paths), 'Other/Note.md');
  assert.equal(resolveLink('/folder/note.MD', 'Folder/Source.md', paths), 'Folder/Note.md');
  assert.equal(resolveLink('/Missing/Note', 'Folder/Source.md', paths), null);
  assert.equal(resolveLink('../../Note', 'Folder/Source.md', paths), null);
  assert.equal(resolveLink('Folder/Space%20Note', 'Source.md', paths), null);
  assert.equal(resolveLink('Note', 'Source.md', ['A/LongNote.md']), null, 'basename substrings are not filenames');
  assert.equal(normalizePath('Folder/../Other\\Note.md'), 'Other/Note.md');
});

test('same-name rename protects the identity of links to files which did not move', () => {
  const files = { 'A/Seed.md': '# Seed', 'B/Target.md': '# Original', 'A/Source.md': '[[Target#Heading|Original]]\n`[[Target]]`' };
  const result = planRename(files, 'A/Seed.md', 'A/Target.md');
  assert.equal(result.files['A/Source.md'], '[[B/Target#Heading|Original]]\n`[[Target]]`');
  assert.equal(getReferences(result.files['A/Source.md'], 'A/Source.md', result.files)[0].path, 'B/Target.md');
  assert.ok(Object.hasOwn(files, 'A/Seed.md'), 'planning does not mutate input');
  assert.ok(!Object.hasOwn(result.files, 'A/Seed.md'));
});

test('folder moves preserve all incoming, outgoing, nested and self-heading targets', () => {
  const files = {
    'A/Note.md': '[[#Self]]\n[asset](assets/pic.svg)\n[[../Outside#Part]]',
    'A/assets/pic.svg': '<svg/>', 'Outside.md': '# Outside',
    'Source.md': '![[A/Note#^block]]\n[[A/assets/pic.svg]]',
  };
  const result = planRename(files, 'A', 'Nested/Moved');
  assert.equal(result.files['Nested/Moved/Note.md'], '[[#Self]]\n[asset](pic.svg)\n[[Outside#Part]]');
  assert.equal(result.files['Source.md'], '![[Note#^block]]\n[[pic.svg]]');
  assert.equal(getReferences(result.files['Nested/Moved/Note.md'], 'Nested/Moved/Note.md', result.files)[0].path, 'Nested/Moved/Note.md');
  assert.equal(result.changes.filter(change => change.kind === 'rename').length, 2);
});

test('rename choices distinguish moving storage from once/always preference updates', () => {
  const files = { 'Old.md': '# Old', 'Source.md': '[[Old]]' };
  assert.equal(planRename(files, 'Old.md', 'New.md', { via: 'storage' }).files['Source.md'], '[[Old]]');
  assert.equal(planRename(files, 'Old.md', 'New.md', { alwaysUpdateLinks: false, decision: 'decline' }).files['Source.md'], '[[Old]]');
  const once = planRename(files, 'Old.md', 'New.md', { alwaysUpdateLinks: false, decision: 'once' });
  assert.equal(once.files['Source.md'], '[[New]]');
  assert.equal(once.settings.alwaysUpdateLinks, false);
  assert.equal(planRename(files, 'Old.md', 'New.md', { alwaysUpdateLinks: false, decision: 'always' }).settings.alwaysUpdateLinks, true);
});

test('rename validates collisions and invalid paths before producing a plan', () => {
  const files = { 'A/Note.md': '# A', 'Other.md': '# Other' };
  assert.throws(() => planRename(files, 'A/Note.md', 'Other.md'), /already exists/);
  assert.throws(() => planRename(files, 'A', 'A/Inside'), /inside itself/);
  assert.throws(() => planRename(files, 'A/Note.md', '../Outside.md'), /valid vault/);
  assert.throws(() => planRename(files, 'Missing.md', 'New.md'), /does not exist/);
});

test('unresolved references retain source while newly named targets become discoverable', () => {
  const files = { 'Seed.md': '', 'Source.md': '[[Future]]\n[[Missing]]' };
  const result = planRename(files, 'Seed.md', 'Future.md');
  assert.equal(result.files['Source.md'], files['Source.md']);
  assert.deepEqual(getReferences(result.files['Source.md'], 'Source.md', result.files).map(reference => reference.path), ['Future.md', null]);
});

test('target preservation holds across deterministic variations of folder depth and duplicate names', () => {
  for (let depth = 1; depth <= 5; depth++) {
    const parent = Array.from({ length: depth }, (_, index) => `Level${index}`).join('/');
    const oldFolder = `${parent}/Folder`;
    const newFolder = `Moved/${parent}/Archive`;
    const files = {
      [`${oldFolder}/Note.md`]: '[[#Heading]]\n[[Shared]]\n[asset](assets/image.svg)',
      [`${oldFolder}/assets/image.svg`]: '<svg/>',
      'Elsewhere/Shared.md': '# Shared',
      'Remote/Shared.md': '# Other shared',
      [`${parent}/Source.md`]: `---\nref: "[[${oldFolder}/Note#Heading]]"\n---\n[[${oldFolder}/Note|Label]]\n![[${oldFolder}/assets/image.svg]]\n\`[[${oldFolder}/Note]]\``,
    };
    const result = planRename(files, oldFolder, newFolder);
    for (const [source, content] of Object.entries(files).filter(([path]) => path.endsWith('.md'))) {
      const sourceAfter = source.startsWith(`${oldFolder}/`) ? newFolder + source.slice(oldFolder.length) : source;
      const before = getReferences(content, source, files);
      const after = getReferences(result.files[sourceAfter], sourceAfter, result.files);
      assert.equal(after.length, before.length);
      before.forEach((reference, index) => {
        const expected = reference.path?.startsWith(`${oldFolder}/`) ? newFolder + reference.path.slice(oldFolder.length) : reference.path;
        assert.equal(after[index].path, expected, `depth ${depth}, source ${source}, reference ${reference.original}`);
        assert.equal(after[index].subpath, reference.subpath);
        assert.equal(after[index].display, reference.display);
      });
    }
  }
});

test('search supports text combinations, paths, frontmatter, tags, regex and task status', () => {
  const files = {
    'Work/Plan.md': '---\nstatus: active\ntags: [work]\n---\nAlpha beta\n- [ ] Review draft\n',
    'Personal/Log.md': 'Alpha gamma\n- [x] Review notes\n',
    'Work/Done.md': 'Archived beta\n',
  };
  assert.deepEqual(searchFiles(files, 'Alpha -gamma').map(result => result.path), ['Work/Plan.md']);
  assert.deepEqual(searchFiles(files, 'path:Work (Alpha OR Archived)').map(result => result.path).sort(), ['Work/Done.md', 'Work/Plan.md']);
  assert.deepEqual(searchFiles(files, 'tag:work [status:active]').map(result => result.path), ['Work/Plan.md']);
  assert.deepEqual(searchFiles(files, 'task-done:Review').map(result => result.path), ['Personal/Log.md']);
  assert.deepEqual(searchFiles(files, 'content:/alpha\\s+beta/i').map(result => result.path), ['Work/Plan.md']);
});

test('Canvas file nodes and text links preserve target identities during folder moves', () => {
  const canvas = {
    nodes: [
      { id: 'note', type: 'file', file: 'Notes/Entry.md', subpath: '#Part', x: 1, y: 2, width: 200, height: 100, custom: { color: 'violet' } },
      { id: 'image', type: 'file', file: 'Notes/Images/photo.png', x: 2, y: 3 },
      { id: 'text', type: 'text', text: '[[Notes/Entry#Part|Entry]]\n![[Notes/Images/photo.png]]\n`[[Notes/Entry]]`\n[[Unresolved]]' },
      { id: 'site', type: 'link', url: 'https://example.com/Notes/Entry.md' },
    ],
    edges: [{ id: 'edge', fromNode: 'note', toNode: 'image', label: 'unchanged' }],
    metadata: { version: '1.0' },
  };
  const files = { 'Board.canvas': JSON.stringify(canvas), 'Notes/Entry.md': '# Part', 'Notes/Images/photo.png': '', 'Archive.base': 'filters:\n  file.path == "Notes/Entry.md"' };
  const result = planRename(files, 'Notes', 'Archive/Notes');
  const updated = JSON.parse(result.files['Board.canvas']);
  assert.equal(updated.nodes[0].file, 'Archive/Notes/Entry.md');
  assert.equal(updated.nodes[0].subpath, '#Part');
  assert.deepEqual(updated.nodes[0].custom, canvas.nodes[0].custom);
  assert.equal(updated.nodes[1].file, 'Archive/Notes/Images/photo.png');
  assert.equal(updated.nodes[2].text, '[[Entry#Part|Entry]]\n![[photo.png]]\n`[[Notes/Entry]]`\n[[Unresolved]]');
  assert.deepEqual(updated.nodes[3], canvas.nodes[3]);
  assert.deepEqual(updated.edges, canvas.edges);
  assert.deepEqual(updated.metadata, canvas.metadata);
  assert.equal(result.files['Archive.base'], files['Archive.base']);
});

test('moved Canvas text fixes relative links and collision drift; exact file node paths stay fixed', () => {
  const files = {
    'A/Seed.md': '', 'B/Target.md': '# Original',
    'A/Board.canvas': JSON.stringify({ nodes: [
      { id: 'text', type: 'text', text: '[[Target#Part]]\n[original](../B/Target.md)' },
      { id: 'file', type: 'file', file: 'B/Target.md' },
    ], edges: [] }),
  };
  const collision = planRename(files, 'A/Seed.md', 'A/Target.md');
  const board = JSON.parse(collision.files['A/Board.canvas']);
  assert.equal(board.nodes[0].text, '[[B/Target#Part]]\n[original](../B/Target.md)');
  assert.equal(board.nodes[1].file, 'B/Target.md');
  const moved = planRename(files, 'A/Board.canvas', 'Nested/Deeper/Board.canvas');
  assert.equal(JSON.parse(moved.files['Nested/Deeper/Board.canvas']).nodes[0].text, '[[Target#Part]]\n[original](Target.md)');
});

test('Canvas bytes remain unchanged when invalid, unaffected, or link maintenance is disabled', () => {
  const canvas = '{ "nodes": [{ "type": "file", "file": "A.md" }], "edges": [] }\n';
  const files = { 'A.md': '', 'Board.canvas': canvas, 'Invalid.canvas': '{unfinished', 'Unaffected.canvas': '{"nodes":[],"edges":[]}' };
  assert.equal(planRename(files, 'A.md', 'B.md', { via: 'storage' }).files['Board.canvas'], canvas);
  assert.equal(planRename(files, 'A.md', 'B.md', { alwaysUpdateLinks: false, decision: 'decline' }).files['Board.canvas'], canvas);
  const changed = planRename(files, 'A.md', 'B.md');
  assert.equal(changed.files['Invalid.canvas'], files['Invalid.canvas']);
  assert.equal(changed.files['Unaffected.canvas'], files['Unaffected.canvas']);
  assert.ok(changed.files['Board.canvas'].endsWith('\n'));
});
