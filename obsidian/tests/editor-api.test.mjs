import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorSelection, EditorState, Transaction} from '@codemirror/state';
import {history, isolateHistory, undoDepth} from '@codemirror/commands';
import {createEditorApi} from '../app/editor-api.mjs';
import {runMarkdownProcessing} from '../app/editor-helpers.mjs';

function fixture(text = 'alpha\n你好🙂\nomega') {
  const h = {context: {path: 'A#one.md', mode: 'source', readOnly: false}, composing: false, destroyed: false, changes: 0};
  h.requested = {...h.context, requestedMode: 'source'};
  const view = h.view = {state: EditorState.create({doc: text, extensions: [history(), EditorState.allowMultipleSelections.of(true)]}), scrollDOM: {scrollTop: 4, scrollLeft: 2, scrollHeight: 1200, scrollWidth: 800, clientHeight: 300, clientWidth: 500}, focus: () => { view.hasFocus = true; }, hasFocus: false};
  view.dispatch = spec => { const transaction = spec instanceof Transaction ? spec : view.state.update(spec); view.state = transaction.state; if (transaction.docChanged) { h.changes++; h.onChange?.(); } };
  h.api = createEditorApi({view, getContext: () => h.context, getRequestedContext: () => h.requested, isComposing: () => h.composing, isDestroyed: () => h.destroyed, getPreview: () => h.preview});
  return h;
}
const errorCode = code => error => error.code === code;

test('editor adapter positions use UTF-16 and preserve backwards multi-selections', () => {
  const {api} = fixture();
  assert.equal(api.path, 'A#one.md');
  assert.equal(api.lineCount(), 3); assert.equal(api.lastLine(), 2); assert.equal(api.getLine(1), '你好🙂');
  assert.equal(api.posToOffset({line: 1, ch: 4}), 10); assert.deepEqual(api.offsetToPos(10), {line: 1, ch: 4});
  api.setSelections([{anchor: {line: 0, ch: 5}, head: {line: 0, ch: 0}}, {anchor: {line: 1, ch: 0}, head: {line: 1, ch: 4}}], {mainIndex: 0});
  assert.deepEqual(api.getCursor('anchor'), {line: 0, ch: 5}); assert.deepEqual(api.getCursor('from'), {line: 0, ch: 0});
  assert.equal(api.getSelection(), 'alpha'); assert.equal(api.listSelections().length, 2);
  assert.deepEqual(api.getSelectionInfo(), {path: 'A#one.md', from: 0, to: 5, text: 'alpha'});
  api.replaceSelection('x'); assert.equal(api.getValue(), 'x\nx\nomega');
  api.undo(); assert.equal(api.getValue(), 'alpha\n你好🙂\nomega');
  api.setCursor(1, 2); assert.deepEqual(api.getCursor(), {line: 1, ch: 2});
});

test('atomic transactions use original change positions and resulting selection positions', () => {
  const {api, view} = fixture('abc\ndef');
  api.transaction({changes: [{from: {line: 0, ch: 1}, to: {line: 0, ch: 2}, text: 'XYZ'}, {from: {line: 1, ch: 0}, to: {line: 1, ch: 3}, text: 'Q'}], selection: {from: {line: 0, ch: 4}, to: {line: 1, ch: 1}}}, {expectedPath: 'A#one.md', expectedValue: 'abc\ndef'});
  assert.equal(api.getValue(), 'aXYZc\nQ'); assert.equal(api.getSelection(), 'c\nQ'); assert.equal(undoDepth(view.state), 1);
  api.undo(); assert.equal(api.getValue(), 'abc\ndef'); api.redo(); assert.equal(api.getValue(), 'aXYZc\nQ');
  api.replaceRange('!', {line: 1, ch: 1}); assert.equal(undoDepth(view.state), 2);
  api.undo(); assert.equal(api.getValue(), 'aXYZc\nQ');
});

test('invalid transaction leaves text, selection and undo history untouched', () => {
  const {api, view} = fixture('abcdef'); const originalSelection = api.listSelections();
  for (const spec of [
    {changes: [{from: {line: 0, ch: 1}, to: {line: 0, ch: 4}, text: ''}, {from: {line: 0, ch: 3}, text: '!'}]},
    {changes: [{from: {line: 0, ch: 1}, text: '1'}, {from: {line: 0, ch: 1}, text: '2'}]},
    {changes: [{from: {line: 0, ch: 1}, text: '1'}], selection: {from: {line: 3, ch: 0}}},
    {changes: [{from: {line: 0, ch: 7}, text: ''}]},
    {changes: [{from: {line: 0, ch: 1}, text: '1'}], selections: []},
    {changes: [], replaceSelection: 'x'},
  ]) assert.throws(() => api.transaction(spec));
  assert.equal(api.getValue(), 'abcdef'); assert.deepEqual(api.listSelections(), originalSelection); assert.equal(undoDepth(view.state), 0);
});

test('CAS rejects stale documents and values before any mutation', () => {
  const h = fixture('abc'), {api} = h;
  assert.throws(() => api.transaction({changes: [{from: {line: 0, ch: 0}, text: 'x'}], expectedPath: 'B.md'}), errorCode('EDITOR_STALE_PATH'));
  assert.throws(() => api.setValue('x', {expectedValue: 'ab'}), errorCode('EDITOR_STALE_VALUE'));
  assert.equal(api.getValue(), 'abc'); assert.equal(h.changes, 0);
  api.setLine(0, 'def', {expectedValue: 'abc'}); assert.equal(api.getRange({line: 0, ch: 0}, {line: 0, ch: 3}), 'def');
});

test('setValue normalizes CRLF and remains an undoable local command', () => {
  const {api} = fixture('original');
  api.setValue('first\r\nsecond\r\n'); assert.equal(api.getValue(), 'first\nsecond\n'); assert.equal(api.lineCount(), 3);
  api.undo(); assert.equal(api.getValue(), 'original');
});

test('every public text mutation rejects readonly, composition, switching and reading', () => {
  const operations = [api => api.setValue('x'), api => api.setLine(0, 'x'), api => api.replaceSelection('x'), api => api.replaceRange('x', {line: 0, ch: 0}), api => api.transaction({replaceSelection: 'x'}), api => api.undo(), api => api.redo()];
  for (const [key, mutate, code] of [
    ['readOnly', h => { h.requested.readOnly = true; }, 'EDITOR_READ_ONLY'],
    ['composing', h => { h.composing = true; }, 'EDITOR_COMPOSING'],
    ['path', h => { h.requested.path = 'B.md'; }, 'EDITOR_PENDING'],
    ['mode', h => { h.requested.requestedMode = 'reading'; }, 'EDITOR_PENDING'],
    ['reading', h => { h.context.mode = h.requested.mode = h.requested.requestedMode = 'reading'; }, 'EDITOR_READING'],
  ]) {
    const h = fixture('abc'); mutate(h);
    for (const operation of operations) assert.throws(() => operation(h.api), errorCode(code), key);
    assert.equal(h.api.getValue(), 'abc'); assert.equal(h.changes, 0); assert.equal(h.api.getStatus().canEdit, false);
  }
});

test('replaceSelection transaction accepts range-or-caret and has one undo step', () => {
  const {api, view} = fixture('alpha');
  api.setSelection({line: 0, ch: 1}, {line: 0, ch: 4});
  api.transaction({replaceSelection: 'B', selection: {from: {line: 0, ch: 2}}});
  assert.equal(api.getValue(), 'aBa'); assert.deepEqual(api.getCursor(), {line: 0, ch: 2}); assert.equal(undoDepth(view.state), 1);
  api.undo(); assert.equal(api.getValue(), 'alpha');
});

test('view state roundtrip preserves literal paths, selection and scroll with atomic validation', () => {
  const {api, view} = fixture('abc\ndef');
  api.setSelection({line: 1, ch: 3}, {line: 0, ch: 1});
  const saved = api.getViewState(); api.setCursor({line: 0, ch: 0}); api.scrollTo(8, 30);
  api.setViewState(saved); assert.deepEqual(view.state.selection.main, EditorSelection.range(7, 1)); assert.equal(api.getScrollInfo().top, 4); assert.equal(api.getScrollInfo().left, 2);
  for (const mainIndex of [NaN, 0.5, Infinity]) assert.throws(() => api.setViewState({...saved, mainIndex}), errorCode('EDITOR_SELECTION'));
  assert.throws(() => api.setViewState({...saved, path: 'A.md'}), errorCode('EDITOR_STALE_PATH'));
  assert.throws(() => api.setViewState({...saved, cursor: {anchor: 0, head: 0}, scroll: {top: -1}}), errorCode('EDITOR_POSITION'));
  assert.deepEqual(api.getViewState(), saved);
  api.setValue('a'); api.setViewState(saved); assert.equal(view.state.selection.main.anchor, 1); assert.equal(view.state.selection.main.head, 1);
});

test('external document sync maps local history without joining the undo entry', () => {
  const {api, view} = fixture('a');
  api.replaceRange('b', {line: 0, ch: 1});
  view.dispatch({changes: {from: 2, insert: 'c'}, annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full')]});
  assert.equal(undoDepth(view.state), 1); api.undo(); assert.equal(api.getValue(), 'ac'); api.redo(); assert.equal(api.getValue(), 'abc');
});

test('post-mutation navigation does not turn successful insert into a thrown failure', () => {
  const h = fixture('abc'); h.onChange = () => { h.requested.path = 'B.md'; };
  assert.equal(h.api.insert('x'), true); assert.equal(h.api.getValue(), 'xabc'); assert.equal(h.view.hasFocus, false);
  h.destroyed = true; assert.throws(() => h.api.getValue(), errorCode('EDITOR_DESTROYED'));
});

test('reading focus and scrolling target the visible preview', () => {
  const h = fixture('abc'); h.context.mode = h.requested.mode = h.requested.requestedMode = 'reading';
  h.preview = {scrollTop: 10, scrollLeft: 0, ownerDocument: {activeElement: null}, focus() { this.ownerDocument.activeElement = this; }, contains(element) { return element === this; }};
  h.api.focus(); assert.equal(h.api.hasFocus(), true); assert.equal(h.view.hasFocus, false);
  h.api.scrollTo(null, 90); assert.equal(h.preview.scrollTop, 90); assert.equal(h.view.scrollDOM.scrollTop, 4);
});

test('async Markdown processors dispose once even when their widget has already gone', async () => {
  let finish, disposed = 0, ready = 0;
  const cleanup = runMarkdownProcessing({}, {hydrate: async () => {}, processMarkdown: () => new Promise(resolve => { finish = resolve; }), context: {path: 'A.md'}, onReady: () => ready++});
  await new Promise(resolve => setImmediate(resolve)); cleanup(); cleanup(); finish(() => disposed++);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, 1); assert.equal(ready, 0);
  let processed = 0;
  const early = runMarkdownProcessing({}, {hydrate: async () => {}, processMarkdown: () => { processed++; }}); early();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(processed, 0);
});
