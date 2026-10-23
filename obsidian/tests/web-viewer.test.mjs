import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const { normalizeWebUrl, clipBounds, installWebViewer } = createRequire(import.meta.url)('../desktop/web-viewer.cjs');

class FakeView {
  constructor(options) {
    this.options = options;
    const wc = this.webContents = new EventEmitter();
    Object.assign(wc, {
      session: new EventEmitter(),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      isDestroyed: () => !!wc.closed,
      getURL: () => wc.url || '',
      getTitle: () => '',
      isLoading: () => false,
      loadURL: async (url) => { wc.url = url; },
      setWindowOpenHandler: (callback) => { wc.open = callback; },
      close: (options) => { wc.closeCalls = (wc.closeCalls || 0) + 1; wc.closeOptions = options; wc.closed = true; },
      stop: () => {},
    });
    Object.assign(wc.session, { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} });
  }
  setBounds(value) { this.bounds = value; }
  setVisible(value) { this.visible = value; }
}

function fixture() {
  const handlers = new Map(), events = [];
  const manager = installWebViewer({ register: (name, fn) => handlers.set(name, fn), send: (_ctx, event) => events.push(event), ViewClass: FakeView });
  const makeOwner = (id) => {
    const children = new Set(), removed = [];
    return Object.assign(new EventEmitter(), {
      id, webContents: new EventEmitter(), children, removed,
      isDestroyed: () => false,
      getContentSize: () => [800, 600],
      contentView: { addChildView: (view) => children.add(view), removeChildView: (view) => { children.delete(view); removed.push(view); } },
    });
  };
  const a = { window: makeOwner(1) }, b = { window: makeOwner(2) };
  const open = (ctx, id = 'web-one') => {
    handlers.get('webviewOpen')(ctx, { id, url: 'https://example.com', bounds: { x: 0, y: 0, width: 500, height: 400 } });
    return [...ctx.window.children].at(-1);
  };
  return { handlers, manager, events, a, b, open };
}

test('web viewer accepts HTTP(S) only and rejects credentials even for a trusted caller', () => {
  assert.equal(normalizeWebUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizeWebUrl('http://127.0.0.1:8766/p/notes/'), 'http://127.0.0.1:8766/p/notes/');
  for (const url of ['file:///C:/Notes/a.md', 'javascript:alert(1)', 'data:text/html,hi', 'vaultdesk-asset://secret/a.md', 'https://user:pass@example.com/', '//example.com']) assert.throws(() => normalizeWebUrl(url));
});

test('native web bounds are finite and clipped to their owner content area', () => {
  assert.deepEqual(clipBounds({ x: -10, y: 20, width: 1000, height: 500 }, [800, 600]), { x: 0, y: 20, width: 800, height: 500 });
  assert.throws(() => clipBounds({ x: 0, y: NaN, width: 5, height: 8 }, [800, 600]));
});

test('webview IDs cannot be used from another window and closing one owner leaves the other intact', () => {
  const { handlers, manager, a, b, open } = fixture();
  const first = open(a);
  assert.throws(() => handlers.get('webviewNavigate')(b, 'web-one', 'https://example.net'));
  open(b);
  manager.disposeOwner(a.window);
  assert.equal(a.window.children.size, 0);
  assert.equal(first.webContents.closeCalls, 1);
  assert.throws(() => handlers.get('webviewAction')(a, 'web-one', 'stop'));
  assert.equal(handlers.get('webviewNavigate')(b, 'web-one', 'https://example.org').url, 'https://example.org/');
  manager.disposeOwner(b.window);
});

test('main renderer reload removes and closes all owned views, allowing clean reopening without duplicate listeners', () => {
  const { handlers, manager, a, b, open } = fixture();
  const first = open(a), second = open(a, 'web-two'), unrelated = open(b);
  a.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'file:///app/index.html' });
  assert.equal(a.window.children.size, 0);
  assert.deepEqual(a.window.removed, [first, second]);
  for (const view of [first, second]) {
    assert.equal(view.webContents.closeCalls, 1);
    assert.deepEqual(view.webContents.closeOptions, { waitForBeforeUnload: false });
  }
  assert.equal(unrelated.webContents.isDestroyed(), false);
  assert.throws(() => handlers.get('webviewAction')(a, 'web-one', 'stop'));
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = open(a);
    assert.notEqual(next, first);
    assert.equal(a.window.listenerCount('closed'), 1);
    assert.equal(a.window.webContents.listenerCount('did-start-navigation'), 1);
    assert.equal(a.window.webContents.listenerCount('render-process-gone'), 1);
    assert.equal(a.window.webContents.listenerCount('destroyed'), 1);
    if (attempt % 2) manager.disposeOwner(a.window);
    else a.window.webContents.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
    assert.equal(next.webContents.closeCalls, 1);
    assert.equal(a.window.children.size, 0);
  }
  const final = open(a);
  a.window.emit('closed');
  assert.equal(final.webContents.closeCalls, 1);
  assert.equal(a.window.listenerCount('closed'), 0);
  assert.equal(a.window.webContents.listenerCount('did-start-navigation'), 0);
  assert.equal(a.window.webContents.listenerCount('render-process-gone'), 0);
  assert.equal(a.window.webContents.listenerCount('destroyed'), 0);
});

test('host renderer exit releases owned views and recovered renderer can open the same tab identity', () => {
  const { handlers, a, b, open } = fixture();
  const first = open(a), second = open(a, 'web-two'), unrelated = open(b);
  a.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(a.window.children.size, 0);
  assert.deepEqual(a.window.removed, [first, second]);
  assert.equal(first.webContents.closeCalls, 1);
  assert.equal(second.webContents.closeCalls, 1);
  assert.equal(unrelated.webContents.isDestroyed(), false);
  const recovered = open(a);
  assert.equal(handlers.get('webviewAction')(a, 'web-one', 'stop').id, 'web-one');
  a.window.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 0 });
  assert.equal(recovered.webContents.closeCalls, 1);
  assert.equal(a.window.listenerCount('closed'), 1);
});

test('subframe, same-document and external web page navigation do not dispose owner tabs', () => {
  const { handlers, events, a, open } = fixture();
  const view = open(a), second = open(a, 'web-two');
  a.window.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  a.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  a.window.webContents.emit('did-start-navigation', {}, 'https://frame.example', false, false);
  a.window.webContents.emit('did-start-navigation', {}, 'file:///app/index.html#heading', true, true);
  view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  view.webContents.emit('did-navigate', {}, 'https://example.org/');
  view.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(a.window.children.size, 2);
  assert.equal(a.window.removed.length, 0);
  assert.equal(view.webContents.isDestroyed(), false);
  assert.equal(second.webContents.isDestroyed(), false);
  assert.equal(handlers.get('webviewAction')(a, 'web-two', 'stop').id, 'web-two');
  assert.ok(events.some((event) => event.id === 'web-one' && event.error));
});

test('destroying host webContents detaches views and removes every owner lifecycle listener', () => {
  const { a, open } = fixture();
  const view = open(a);
  a.window.webContents.emit('destroyed');
  a.window.emit('closed');
  assert.equal(view.webContents.closeCalls, 1);
  assert.equal(a.window.children.size, 0);
  assert.equal(a.window.listenerCount('closed'), 0);
  assert.equal(a.window.webContents.listenerCount('did-start-navigation'), 0);
  assert.equal(a.window.webContents.listenerCount('render-process-gone'), 0);
  assert.equal(a.window.webContents.listenerCount('destroyed'), 0);
});
