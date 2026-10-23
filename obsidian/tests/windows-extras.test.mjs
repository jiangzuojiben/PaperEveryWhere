import test from 'node:test';
import assert from 'node:assert/strict';
import { addBookmark, bookmarkKind, bookmarkLabel, bookmarkTarget, convertMarkdownFormat, createMarkdownConversionPlan, flattenBookmarks, hasFileBookmark, moveBookmark, normalizeBookmarks, remapBookmarks, removeBookmark, splitSlides, toggleFileBookmark, updateBookmark, validateBookmark } from '../core/windows-extras.mjs';

const file = (id, path = `${id}.md`, extra = {}) => ({ id, type: 'file', path, title: '', ...extra });
const group = (id, items = []) => ({ id, type: 'group', title: id, items });

test('legacy path bookmarks migrate deterministically without mutating the original list', () => {
  const before = ['笔记/研究.md', { type: 'file', path: '附件/参考.pdf', subpath: '#page=2' }];
  const migrated = normalizeBookmarks(before);
  assert.deepEqual(before, ['笔记/研究.md', { type: 'file', path: '附件/参考.pdf', subpath: '#page=2' }]);
  assert.deepEqual(migrated, normalizeBookmarks(before));
  assert.equal(migrated[0].type, 'file');
  assert.equal(migrated[0].path, '笔记/研究.md');
  assert.equal(bookmarkTarget(migrated[1]), '附件/参考.pdf#page=2');
  assert.equal(bookmarkKind(migrated[1]), 'file');
});

test('heading and block bookmarks keep the observed file plus subpath storage shape', () => {
  const items = normalizeBookmarks([group('g', [file('h', 'Research.md', { subpath: '#Section One' }), file('b', 'Research.md', { subpath: '#^anchor-one' })])]);
  assert.deepEqual(items[0].items.map(item => [item.type, item.subpath, bookmarkKind(item)]), [['file', '#Section One', 'heading'], ['file', '#^anchor-one', 'block']]);
  const added = addBookmark(items, { id: 'h2', type: 'heading', path: 'Research.md', subpath: '#Second', title: '章节' }, 'g');
  assert.equal(added[0].items[2].type, 'file');
  assert.equal(bookmarkTarget(added[0].items[2]), 'Research.md#Second');
});

test('migration retains custom metadata and makes duplicate ids distinct', () => {
  const items = normalizeBookmarks([file('same', 'A.md', { ctime: 123, custom: { color: 'red' } }), group('same', [file('same', 'B.md')])]);
  const ids = flattenBookmarks(items).map(row => row.item.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(items[0].ctime, 123);
  assert.deepEqual(items[0].custom, { color: 'red' });
});

test('bookmark validation rejects unsafe addresses and invalid targets', () => {
  assert.match(validateBookmark({ type: 'url', url: 'javascript:alert(1)' }), /仅支持/);
  assert.match(validateBookmark({ type: 'url', url: 'file:///C:/secret' }), /仅支持/);
  assert.match(validateBookmark({ type: 'file', path: '../outside.md' }), /相对/);
  assert.match(validateBookmark({ type: 'block', path: 'A.md', subpath: '#^' }), /块标识/);
  assert.match(validateBookmark({ type: 'search', query: ' ' }), /搜索/);
  assert.equal(validateBookmark({ type: 'url', url: 'https://example.com/a?q=1' }), '');
  assert.equal(validateBookmark({ type: 'heading', path: 'A.md', subpath: '#Section One' }), '');
});

test('rename changes only display name and preserves nested file targets', () => {
  const original = [group('g', [file('b', 'A.md', { subpath: '#^anchor', title: 'Before' })])];
  const renamed = updateBookmark(original, 'b', { title: 'After' });
  assert.equal(bookmarkLabel(renamed[0].items[0]), 'After');
  assert.equal(bookmarkTarget(renamed[0].items[0]), 'A.md#^anchor');
  assert.equal(original[0].items[0].title, 'Before');
  assert.equal(renamed[0].items[0].id, 'b');
});

test('editing a heading uses its UI kind without changing persisted file type', () => {
  const updated = updateBookmark([file('h', 'A.md', { subpath: '#One' })], 'h', { type: 'heading', title: 'Renamed', subpath: '#Two' });
  assert.equal(updated[0].type, 'file');
  assert.equal(updated[0].subpath, '#Two');
  assert.throws(() => updateBookmark(updated, 'h', { type: 'url', url: 'https://example.com' }), /不能更改类型/);
});

test('same-group order uses an insertion position after removing the source', () => {
  const original = [group('g', [file('a'), file('b'), file('c')])];
  assert.deepEqual(moveBookmark(original, 'a', 'g', 1)[0].items.map(item => item.id), ['b', 'a', 'c']);
  assert.deepEqual(moveBookmark(original, 'c', 'g', 0)[0].items.map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(original[0].items.map(item => item.id), ['a', 'b', 'c']);
});

test('cross-group moves preserve the complete bookmark and leave empty groups', () => {
  const original = [group('left', [file('a', 'A.md', { subpath: '#Header', title: 'Important' })]), group('right')];
  const moved = moveBookmark(original, 'a', 'right');
  assert.equal(moved[0].items.length, 0);
  assert.equal(moved[1].items[0].title, 'Important');
  assert.equal(bookmarkTarget(moved[1].items[0]), 'A.md#Header');
  assert.equal(original[0].items.length, 1);
});

test('moving a group into itself or descendants cannot create a cycle', () => {
  const original = [group('outer', [group('inner', [file('a')])])];
  assert.throws(() => moveBookmark(original, 'outer', 'outer'), /子分组/);
  assert.throws(() => moveBookmark(original, 'outer', 'inner'), /子分组/);
  assert.throws(() => moveBookmark(original, 'a', 'missing'), /找不到/);
  assert.equal(original[0].items[0].items[0].id, 'a');
});

test('removing a group removes only its subtree and rejects missing ids', () => {
  const original = [group('g', [file('a'), group('nested', [file('b')])]), file('c')];
  assert.deepEqual(flattenBookmarks(removeBookmark(original, 'g')).map(row => row.item.id), ['c']);
  assert.throws(() => removeBookmark(original, 'missing'), /不存在/);
  assert.equal(flattenBookmarks(original).length, 5);
});

test('managed renames recursively remap file paths and retain heading/block fragments', () => {
  const original = [group('g', [file('a', 'Old/A.md', { subpath: '#Title' }), file('b', 'Old/B.md', { subpath: '#^one' }), file('c', 'Oldish/C.md')]), { id: 's', type: 'search', query: 'path:Old', title: '' }];
  const moved = remapBookmarks(original, 'Old', 'New');
  assert.deepEqual(moved[0].items.map(bookmarkTarget), ['New/A.md#Title', 'New/B.md#^one', 'Oldish/C.md']);
  assert.equal(moved[1].query, 'path:Old');
  assert.equal(original[0].items[0].path, 'Old/A.md');
});

test('file toggle finds grouped entries but does not remove heading or block bookmarks', () => {
  const original = [group('g', [file('whole', 'A.md'), file('heading', 'A.md', { subpath: '#One' })])];
  assert.equal(hasFileBookmark(original, 'A.md'), true);
  const removed = toggleFileBookmark(original, 'A.md');
  assert.equal(hasFileBookmark(removed, 'A.md'), false);
  assert.equal(hasFileBookmark(removed, 'A.md#One'), false);
  assert.equal(removed[0].items[0].id, 'heading');
  const added = toggleFileBookmark(removed, 'A.md');
  assert.equal(hasFileBookmark(added, 'A.md'), true);
});

test('hash characters in Windows filenames stay in path and never become heading fragments', () => {
  for (const path of ['C#Basics.md', 'C# Basics.md', 'Notes/中文#标题.md']) {
    const migrated = normalizeBookmarks([path]);
    assert.equal(migrated[0].path, path);
    assert.equal(migrated[0].subpath, '');
    const added = toggleFileBookmark([], path);
    assert.equal(hasFileBookmark(added, path), true);
    assert.equal(added[0].path, path);
    assert.equal(added[0].subpath, '');
    assert.deepEqual(toggleFileBookmark(added, path), []);
  }
  const heading = normalizeBookmarks([file('h', 'C# Basics.md', { subpath: '#Section' })])[0];
  assert.equal(heading.path, 'C# Basics.md');
  assert.equal(heading.subpath, '#Section');
  assert.equal(bookmarkKind(heading), 'heading');
});

test('slides exclude frontmatter and retain separators inside fenced code', () => {
  const source = '---\ntitle: deck\n---\n# One\n```md\n---\n```\n---\n# Two\n~~~\n---\n~~~';
  assert.deepEqual(splitSlides(source), ['# One\n```md\n---\n```', '# Two\n~~~\n---\n~~~']);
});

test('slides support CRLF, preserve indented content, and keep at least one slide', () => {
  assert.deepEqual(splitSlides('# One\r\n---\r\n# Two'), ['# One', '# Two']);
  assert.deepEqual(splitSlides('    ---\nbody'), ['    ---\nbody']);
  assert.deepEqual(splitSlides(''), ['']);
});

test('format conversion is entirely opt-in', () => {
  const source = '#tag ^^highlight^^ ::highlight:: {{[[TODO]]}}';
  assert.deepEqual(convertMarkdownFormat(source), { text: source, changed: false, changes: [], warnings: [] });
});

test('observed Roam and Bear syntax converts while escaped tags and inline code stay intact', () => {
  const source = '#tag #[[two words]] ^^roam^^ ::bear:: \\#keep `#code ^^code^^ ::code::`';
  const result = convertMarkdownFormat(source, { roamTags: true, roamHighlight: true, bearHighlight: true });
  assert.equal(result.text, '[[tag]] [[two words]] ==roam== ==bear== \\#keep `#code ^^code^^ ::code::`');
  assert.deepEqual(result.changes.map(change => [change.type, change.count]), [['roamTags', 2], ['roamHighlight', 1], ['bearHighlight', 1]]);
});

test('observed fenced-code conversion is explicit and inline spans may cross a newline', () => {
  const source = '```text\n#tag ^^inside^^ ::inside::\n```\n`#inline\n^^keep^^`';
  const result = convertMarkdownFormat(source, { roamTags: true, roamHighlight: true, bearHighlight: true });
  assert.equal(result.text, '```text\n[[tag]] ==inside== ==inside==\n```\n`#inline\n^^keep^^`');
});

test('Roam TODO and DONE become checkbox tokens without inventing a list marker', () => {
  assert.equal(convertMarkdownFormat('{{[[TODO]]}} Task\n- {{[[DONE]]}} Done', { roamTodo: true }).text, '[ ] Task\n- [x] Done');
});

test('tags do not rewrite headings, URL fragments, or fragments of existing links', () => {
  const source = '# Heading\nhttps://example.com/#anchor\n[[A#Title]] [link](A.md#Header)\n#研究/主题';
  assert.equal(convertMarkdownFormat(source, { roamTags: true }).text, '# Heading\nhttps://example.com/#anchor\n[[A#Title]] [link](A.md#Header)\n[[研究/主题]]');
});

test('UID expansion matches known bare ids and leaves aliases, headings, and unknown ids unchanged', () => {
  const source = '[[202001010101]] [[202001010101|Alias]] [[202001010101#Heading]] [[199901010101]]';
  const result = convertMarkdownFormat(source, { zettelkastenLinks: true }, { paths: ['202001010101 Target title.md'] });
  assert.equal(result.text, '[[202001010101 Target title]] [[202001010101|Alias]] [[202001010101#Heading]] [[199901010101]]');
});

test('UID display names are beautified without replacing an existing alias or heading', () => {
  const source = '[[202001010101 Target title]] [[202001010101 Target title|Custom]] [[202001010101 Target title#Heading]]';
  assert.equal(convertMarkdownFormat(source, { zettelkastenAliases: true }).text, '[[202001010101 Target title|Target title]] [[202001010101 Target title|Custom]] [[202001010101 Target title#Heading]]');
});

test('ambiguous UID expansion leaves links unchanged with a review warning', () => {
  const result = convertMarkdownFormat('[[202001010101]]', { zettelkastenLinks: true }, { paths: ['A/202001010101 First.md', 'B/202001010101 Second.md'] });
  assert.equal(result.text, '[[202001010101]]');
  assert.match(result.warnings[0], /多个文件/);
});

test('frontmatter migration changes legacy names to array properties while retaining custom values', () => {
  const source = '---\nalias: Old Name\ncssclass: wide\ntags: [one, two]\ncustom: 7\n---\nBody';
  const result = convertMarkdownFormat(source, { frontmatter: true });
  assert.match(result.text, /aliases:\n  - Old Name/);
  assert.match(result.text, /cssclasses:\n  - wide/);
  assert.match(result.text, /tags: \[ one, two \]/);
  assert.match(result.text, /custom: 7/);
  assert.ok(result.text.endsWith('---\nBody'));
});

test('conflicting or invalid frontmatter properties are kept for review rather than overwritten', () => {
  const source = '---\nalias: Legacy\naliases: [Current]\n---\nBody';
  const result = convertMarkdownFormat(source, { frontmatter: true });
  assert.equal(result.text, source);
  assert.match(result.warnings[0], /同时存在/);
  const invalid = '---\ntags: [broken\n---\nBody';
  assert.equal(convertMarkdownFormat(invalid, { frontmatter: true }).text, invalid);
});

test('conversion planning contains only the explicitly selected markdown files', () => {
  const files = { 'selected.md': '#tag', 'untouched.md': '#secret', 'image.png': null };
  const before = structuredClone(files);
  const plan = createMarkdownConversionPlan(files, ['selected.md', 'selected.md'], { roamTags: true });
  assert.deepEqual(plan.selectedPaths, ['selected.md']);
  assert.deepEqual(plan.changes.map(row => [row.path, row.before, row.after]), [['selected.md', '#tag', '[[tag]]']]);
  assert.deepEqual(files, before);
  assert.throws(() => createMarkdownConversionPlan(files, ['image.png'], { roamTags: true }), /Markdown/);
  assert.throws(() => createMarkdownConversionPlan(files, [], { roamTags: true }), /明确选择/);
  assert.throws(() => createMarkdownConversionPlan(files, ['selected.md'], {}), /至少选择/);
});
