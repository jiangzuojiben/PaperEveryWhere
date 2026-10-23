import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorSelection, EditorState} from '@codemirror/state';
import {markdown, markdownLanguage} from '@codemirror/lang-markdown';
import {inlinePreviewRanges, selectionInfo, validateSelectedSpan} from '../app/editor-helpers.mjs';

const stateFor = (doc, selection) => EditorState.create({doc, selection, extensions: [EditorState.allowMultipleSelections.of(true), markdown({base: markdownLanguage})]});
const hiddenText = (state, result) => {
  const removed = new Set();
  for (const range of result.hidden) for (let i = range.from; i < range.to; i++) removed.add(i);
  return state.doc.toString().split('').filter((_, i) => !removed.has(i)).join('');
};

test('nested emphasis, strike, code spans and balanced link URLs preserve their text', () => {
  const state = stateFor('**bold *nested* text** ~~gone~~ [label](https://example.test/a_(b) "title") ``a ` b``');
  const result = inlinePreviewRanges(state);
  assert.equal(hiddenText(state, result), 'bold nested text gone label a ` b');
  assert.equal(result.marks.find(mark => mark.target)?.target, 'https://example.test/a_(b)');
  assert.ok(result.marks.some(mark => mark.className === 'cm-live-bold'));
  assert.ok(result.marks.some(mark => mark.className === 'cm-live-italic'));
});

test('custom syntax never interprets escaped text, inline code or fenced code as links', () => {
  const state = stateFor('`[[code]] **raw** ==raw==` \\[[escaped]] \\*literal* [[Note|label]] ==yes==\n\n```md\n[[fenced]] ==raw==\n```');
  const result = inlinePreviewRanges(state);
  assert.deepEqual(result.marks.filter(mark => mark.target).map(mark => mark.target), ['Note']);
  assert.equal(result.marks.filter(mark => mark.className === 'cm-live-highlight').length, 1);
  assert.equal(hiddenText(state, result), '[[code]] **raw** ==raw== \\[[escaped]] \\*literal* label yes\n\n```md\n[[fenced]] ==raw==\n```');
});

test('comments hide as one range while literal unmatched syntax stays intact', () => {
  const state = stateFor('before %%**hidden** [[Note]]%% after **open and ==open');
  const result = inlinePreviewRanges(state);
  assert.equal(hiddenText(state, result), 'before  after **open and ==open');
});

test('multiline syntax carries its full scope so either active line can reveal both delimiters', () => {
  const state = stateFor('**first\nsecond**');
  const result = inlinePreviewRanges(state);
  assert.equal(result.hidden.length, 2);
  assert.ok(result.hidden.every(range => range.scopeFrom === 0 && range.scopeTo === state.doc.length));
  assert.ok(result.marks.every(range => range.scopeFrom === 0 && range.scopeTo === state.doc.length));
});

test('selection reports Unicode characters and all selected ranges without separator inflation', () => {
  const state = stateFor('你好🙂 hello world', EditorSelection.create([EditorSelection.range(0, 4), EditorSelection.range(5, 10)], 1));
  assert.deepEqual(selectionInfo(state), {from: 5, to: 10, text: '你好🙂\nhello', characters: 8, words: 3, ranges: 2});
  assert.deepEqual(selectionInfo(stateFor('empty', EditorSelection.cursor(2))), {from: 2, to: 2, text: '', characters: 0, words: 0, ranges: 1});
});

test('attachment replacement requires a current selection from the target document', () => {
  const selected = {path: 'B.md', from: 1, to: 4, text: 'BBB'};
  assert.equal(validateSelectedSpan(selected, 'B.md', 'BBBBBB'), true);
  // A composition can retain A's editor while the pane has already requested B.
  assert.equal(validateSelectedSpan({...selected, path: 'A.md'}, 'B.md', 'BBBBBB'), false);
  assert.equal(validateSelectedSpan({...selected, text: 'AAA'}, 'B.md', 'BBBBBB'), false);
  assert.equal(validateSelectedSpan({...selected, path: undefined}, 'B.md', 'BBBBBB'), false);
  for (const range of [{from: -1}, {to: 7}, {from: 5, to: 4}, {from: 1.5}, {to: NaN}]) {
    assert.equal(validateSelectedSpan({...selected, ...range}, 'B.md', 'BBBBBB'), false);
  }
  assert.equal(validateSelectedSpan({path: 'B.md', from: 2, to: 2, text: ''}, 'B.md', 'BBBBBB'), true);
  assert.equal(validateSelectedSpan(selected, 'B.md', undefined), false);
});
