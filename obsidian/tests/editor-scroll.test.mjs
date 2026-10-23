import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {createScrollRestorer} from '../app/editor-scroll.mjs';

function fixture() {
  const h = {identity: 'A.md', queued: [], completed: [], failures: 0};
  const element = {scrollTop: 0, scrollLeft: 0, clientWidth: 400, clientHeight: 500, scrollWidth: 400, scrollHeight: 5000};
  h.view = {state: EditorState.create({doc: 'abc'}), dom: new EventTarget(), scrollDOM: element, requestMeasure: request => h.queued.push(request)};
  h.restorer = createScrollRestorer(h.view, {getIdentity: () => h.identity, onFailure: () => h.failures++});
  h.pass = async adjustment => {
    const request = h.queued.shift(); assert.ok(request, 'a measurement pass was scheduled');
    const read = request.read(h.view); request.write(read, h.view);
    adjustment?.(element); // CM anchor adjustment runs after measure.write.
    await Promise.resolve();
  };
  return h;
}

test('saved pixels survive CM anchor compensation across reflow measure passes', async () => {
  const h = fixture(); h.restorer.restore({top: 777.333, left: 0}, result => h.completed.push(result));
  await h.pass(element => { element.scrollTop += 430; element.scrollHeight += 600; });
  assert.equal(h.view.scrollDOM.scrollTop, 777.333);
  await h.pass(element => { element.scrollTop += 115; });
  assert.equal(h.view.scrollDOM.scrollTop, 777.333);
  for (let n = 0; h.queued.length && n < 6; n++) await h.pass();
  assert.deepEqual(h.completed, [true]); assert.equal(h.failures, 0); assert.equal(h.queued.length, 0);
});

test('user interaction cancels restoration and cannot pull scroll back afterward', async () => {
  const h = fixture(); h.restorer.restore({top: 900}, result => h.completed.push(result));
  h.view.dom.dispatchEvent(new Event('wheel')); h.view.scrollDOM.scrollTop = 1200;
  await h.pass(); assert.equal(h.view.scrollDOM.scrollTop, 1200); assert.deepEqual(h.completed, [false]); assert.equal(h.queued.length, 0);
});

test('old document, changed selection and closed task cannot resume a pending scroll', async () => {
  for (const change of [h => { h.identity = 'B.md'; }, h => { h.view.state = h.view.state.update({selection: {anchor: 2}}).state; }, h => { h.view.state = h.view.state.update({changes: {from: 0, insert: 'x'}}).state; }]) {
    const h = fixture(); h.restorer.restore({top: 500}, result => h.completed.push(result)); change(h); h.view.scrollDOM.scrollTop = 100;
    await h.pass(); assert.equal(h.view.scrollDOM.scrollTop, 100); assert.deepEqual(h.completed, [false]);
  }
});

test('hidden editors finish without scheduling measure loops', () => {
  const h = fixture(); h.view.scrollDOM.clientHeight = 0;
  h.restorer.restore({top: 500}, result => h.completed.push(result));
  assert.equal(h.view.scrollDOM.scrollTop, 500); assert.deepEqual(h.completed, [true]); assert.equal(h.queued.length, 0);
});
