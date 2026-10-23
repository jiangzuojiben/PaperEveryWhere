import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinkIndex, getReferences, parseMarkdown, resolveLink} from '../core/vault.mjs';

test('prepared link index preserves resolution priorities, case and explicit relative paths', () => {
  const paths = ['Note.md', 'A/Note.md', 'B/Note.md', 'A/Source.md', 'A/Child/Deep.md', '资源/图片.PNG', 'Hello%20World.md'];
  const index = createLinkIndex(paths);
  const cases = [
    ['Note', 'A/Source.md', 'Note.md'],
    ['./Note', 'A/Source.md', 'A/Note.md'],
    ['../B/Note', 'A/Source.md', 'B/Note.md'],
    ['Deep', 'A/Source.md', 'A/Child/Deep.md'],
    ['资源/图片.png', 'A/Source.md', '资源/图片.PNG'],
    ['Hello%20World', 'A/Source.md', 'Hello%20World.md'],
    ['#Heading', 'A/Source.md', 'A/Source.md'],
    ['Missing', 'A/Source.md', null],
    ['https://example.test/Note', 'A/Source.md', null],
  ];
  for (const [target, source, expected] of cases) {
    assert.equal(resolveLink(target, source, index), expected, target);
    assert.equal(resolveLink(target, source, index), resolveLink(target, source, paths), target);
  }
});

test('index is an immutable path snapshot and rebuilding explicitly observes additions and removals', () => {
  const paths = ['Old.md', 'Folder/Keep.md'];
  const original = createLinkIndex(paths);
  paths.splice(0, 1, 'New.md'); paths.push('Added.md');
  assert.equal(resolveLink('Old', '', original), 'Old.md');
  assert.equal(resolveLink('New', '', original), null);
  assert.equal(resolveLink('Added', '', original), null);
  assert.equal(resolveLink('Keep', '', original), 'Folder/Keep.md');
  assert.ok(Object.isFrozen(original));
  assert.throws(() => { original.size = 999; }, TypeError);
  const rebuilt = createLinkIndex(paths);
  assert.equal(resolveLink('Old', '', rebuilt), null);
  assert.equal(resolveLink('New', '', rebuilt), 'New.md');
  assert.equal(resolveLink('Added', '', rebuilt), 'Added.md');
});

test('Map and object path collections produce detached index snapshots', () => {
  const collections = [new Map([['Folder/Original.md', 'text']]), {'Folder/Original.md': 'text'}];
  for (const collection of collections) {
    const prepared = createLinkIndex(collection);
    if (collection instanceof Map) { collection.delete('Folder/Original.md'); collection.set('Other.md', 'new'); }
    else { delete collection['Folder/Original.md']; collection['Other.md'] = 'new'; }
    assert.equal(resolveLink('Original', '', prepared), 'Folder/Original.md');
    assert.equal(resolveLink('Other', '', prepared), null);
  }
});

test('cached metadata plus prepared paths matches plain references without mutating the cache', () => {
  const text = '---\ntags: [test]\n---\n# Heading\n[[Note#Part|alias]] ![[资源/图片.PNG]] [local](./Other.md)\n`[[Ignored]]`\n';
  const paths = ['Folder/Source.md', 'Note.md', 'Folder/Other.md', '资源/图片.PNG'];
  const parsed = parseMarkdown(text), before = structuredClone(parsed), index = createLinkIndex(paths);
  const plain = getReferences(text, 'Folder/Source.md', paths);
  const prepared = getReferences(text, 'Folder/Source.md', index, parsed);
  assert.deepEqual(prepared, plain);
  assert.deepEqual(prepared.map(ref => ref.path).sort(), ['Note.md', '资源/图片.PNG', 'Folder/Other.md'].sort());
  assert.deepEqual(parsed, before);
  prepared[0].path = 'Changed-result-only.md';
  assert.deepEqual(parsed, before);
  assert.equal(getReferences(text, 'Folder/Source.md', index, parsed)[0].path, 'Note.md');
});
