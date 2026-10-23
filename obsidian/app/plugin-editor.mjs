// An Editor facade belongs to one leaf and one document. A retained reference
// must never start editing a different note after the host reuses its editor.
export class PluginEditor {
  constructor({ getAdapter, path, ensureActive, unsupported }) {
    this._getAdapter = getAdapter; this._path = path; this._ensureActive = ensureActive; this._unsupported = unsupported;
  }
  _adapter() {
    this._ensureActive();
    const adapter = this._getAdapter();
    if (!adapter) throw Object.assign(new Error('The Markdown editor is not currently mounted'), { code: 'EDITOR_UNAVAILABLE' });
    if (adapter.path !== this._path) throw Object.assign(new Error('The editor now belongs to a different document'), { code: 'EDITOR_DOCUMENT_CHANGED' });
    return adapter;
  }
  _call(name, ...args) {
    const adapter = this._adapter();
    if (typeof adapter[name] !== 'function') return this._unsupported(`Editor.${name}`, 'The current editor adapter does not implement this operation.');
    return adapter[name](...args);
  }
  getValue() { return this._call('getValue'); }
  setValue(value) { return this._call('setValue', value); }
  getLine(line) { return this._call('getLine', line); }
  setLine(line, value) { return this._call('setLine', line, value); }
  lineCount() { return this._call('lineCount'); }
  lastLine() { return this._call('lastLine'); }
  getRange(from, to) { return this._call('getRange', from, to); }
  getSelection() { return this._call('getSelection'); }
  listSelections() { return this._call('listSelections'); }
  getCursor(which) { return this._call('getCursor', which); }
  setCursor(position, ch) { return this._call('setCursor', position, ch); }
  setSelection(anchor, head) { return this._call('setSelection', anchor, head); }
  setSelections(ranges, main) { return this._call('setSelections', ranges, typeof main === 'number' ? { mainIndex: main } : main); }
  replaceSelection(value) { return this._call('replaceSelection', value); }
  replaceRange(value, from, to) { return this._call('replaceRange', value, from, to); }
  posToOffset(position) { return this._call('posToOffset', position); }
  offsetToPos(offset) { return this._call('offsetToPos', offset); }
  transaction(transaction, origin) { this._call('transaction', transaction, typeof origin === 'object' ? origin : undefined); }
  getScrollInfo() { return this._call('getScrollInfo'); }
  scrollTo(left, top) { return this._call('scrollTo', left, top); }
  scrollIntoView(range, center) { return this._call('scrollIntoView', range, center); }
  focus() { return this._call('focus'); }
  hasFocus() { return this._call('hasFocus'); }
  undo() { return this._call('undo'); }
  redo() { return this._call('redo'); }
  getDoc() { this._adapter(); return this; }
}
