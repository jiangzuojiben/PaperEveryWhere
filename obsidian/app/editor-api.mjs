import {EditorSelection, Transaction} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {isolateHistory, redo, selectAll, undo} from '@codemirror/commands';

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const finite = number => typeof number === 'number' && Number.isFinite(number);

// The adapter exposes document positions, never the CodeMirror view. Plugin
// facades bind its path; delayed work can also provide path/value CAS options.
export function createEditorApi({view, getContext, getRequestedContext = getContext, isComposing = () => false, isDestroyed = () => false, getPreview = () => null, getSourceScroll = () => ({top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft}), getReadingScrollTop = () => getPreview()?.scrollTop || 0, setReadingScrollTop = top => { if (getPreview()) getPreview().scrollTop = top; }, restoreScroll = (scroll, done) => { if (scroll.top != null) view.scrollDOM.scrollTop = scroll.top; if (scroll.left != null) view.scrollDOM.scrollLeft = scroll.left; done?.(true); }, cancelScrollRestore = () => {}}) {
  const alive = () => { if (isDestroyed()) fail('EDITOR_DESTROYED', 'This editor has been closed.'); };
  const status = () => {
    const current = getContext(), requested = getRequestedContext();
    const composing = Boolean(isComposing());
    const pending = current.path !== requested.path || current.mode !== (requested.requestedMode ?? requested.mode);
    const readOnly = Boolean(current.readOnly || requested.readOnly || view.state.readOnly);
    const destroyed = Boolean(isDestroyed());
    return {path: current.path, requestedPath: requested.path, mode: current.mode, composing, pending, readOnly, destroyed, canEdit: !destroyed && !pending && !composing && !readOnly && current.mode !== 'reading'};
  };
  const check = (options = {}, editing = true) => {
    alive();
    const state = status();
    if (state.pending) fail('EDITOR_PENDING', 'The editor is switching documents or modes.');
    if (state.composing) fail('EDITOR_COMPOSING', 'Finish the current input composition before changing the editor.');
    if (editing && state.readOnly) fail('EDITOR_READ_ONLY', 'This editor is read-only.');
    if (editing && state.mode === 'reading') fail('EDITOR_READING', 'Switch to an editing mode before changing the editor.');
    if (options.expectedPath !== undefined && options.expectedPath !== state.path) fail('EDITOR_STALE_PATH', 'The target document has changed.');
    if (options.expectedValue !== undefined && options.expectedValue !== view.state.doc.toString()) fail('EDITOR_STALE_VALUE', 'The target document was edited after this operation started.');
  };
  const offset = (position, doc = view.state.doc) => {
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.ch) || position.line < 0 || position.ch < 0 || position.line >= doc.lines) fail('EDITOR_POSITION', 'Expected a valid zero-based {line, ch} position.');
    const line = doc.line(position.line + 1);
    if (position.ch > line.length) fail('EDITOR_POSITION', 'The character position is outside the line.');
    return line.from + position.ch;
  };
  const position = (value, doc = view.state.doc) => {
    if (!Number.isInteger(value) || value < 0 || value > doc.length) fail('EDITOR_POSITION', 'The document offset is out of bounds.');
    const line = doc.lineAt(value); return {line: line.number - 1, ch: value - line.from};
  };
  const selection = (ranges, doc = view.state.doc, main = 0) => {
    if (!Array.isArray(ranges) || !ranges.length || !Number.isInteger(main) || main < 0 || main >= ranges.length) fail('EDITOR_SELECTION', 'Expected at least one valid selection.');
    return EditorSelection.create(ranges.map(range => { const anchor = range.anchor ?? range.from; return EditorSelection.range(offset(anchor, doc), offset(range.head ?? range.to ?? anchor, doc)); }), main);
  };
  const change = (item, doc = view.state.doc) => {
    if (!item || typeof item.text !== 'string') fail('EDITOR_CHANGE', 'A change requires string text.');
    const from = offset(item.from, doc), to = offset(item.to ?? item.from, doc);
    if (from > to) fail('EDITOR_CHANGE', 'A change must end at or after its start.');
    return {from, to, insert: item.text};
  };
  const dispatch = spec => { cancelScrollRestore(); view.dispatch({...spec, annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')]}); return true; };
  const scrollDOM = () => getContext().mode === 'reading' ? getPreview() : view.scrollDOM;
  const api = {
    get path() { return getContext().path; },
    getStatus: status,
    getValue() { alive(); return view.state.doc.toString(); },
    setValue(text, options) { check(options); if (typeof text !== 'string') fail('EDITOR_CHANGE', 'Expected string text.'); return dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, selection: EditorSelection.cursor(0)}); },
    lineCount() { alive(); return view.state.doc.lines; },
    lastLine() { return api.lineCount() - 1; },
    getLine(line) { alive(); return view.state.doc.lineAt(offset({line, ch: 0})).text; },
    setLine(line, text, options) { check(options); return api.replaceRange(text, {line, ch: 0}, {line, ch: api.getLine(line).length}, options); },
    posToOffset(pos) { alive(); return offset(pos); },
    offsetToPos(value) { alive(); return position(value); },
    getRange(from, to) { alive(); const start = offset(from), end = offset(to); if (end < start) fail('EDITOR_POSITION', 'The range end precedes its start.'); return view.state.sliceDoc(start, end); },
    getSelection() { alive(); const {from, to} = view.state.selection.main; return view.state.sliceDoc(from, to); },
    getSelectionInfo() { alive(); const {from, to} = view.state.selection.main; return {path: api.path, text: view.state.sliceDoc(from, to), from, to}; },
    listSelections() { alive(); return view.state.selection.ranges.map(range => ({anchor: position(range.anchor), head: position(range.head)})); },
    getCursor(which = 'head') { alive(); if (!['head', 'anchor', 'from', 'to'].includes(which)) fail('EDITOR_SELECTION', 'Unknown cursor boundary.'); return position(view.state.selection.main[which]); },
    setCursor(pos, chOrOptions, options) { return api.setSelection(typeof pos === 'number' ? {line: pos, ch: chOrOptions ?? 0} : pos, undefined, typeof pos === 'number' ? options : chOrOptions); },
    setSelection(anchor, head = anchor, options) { return api.setSelections([{anchor, head}], options); },
    setSelections(ranges, options = {}) { check(options); const next = selection(ranges, view.state.doc, options.mainIndex ?? 0); cancelScrollRestore(); view.dispatch({selection: next}); return true; },
    replaceSelection(text, options) { check(options); if (typeof text !== 'string') fail('EDITOR_CHANGE', 'Expected string text.'); return dispatch(view.state.replaceSelection(text)); },
    insert(text, options) { const path = api.path, result = api.replaceSelection(String(text), options); if (api.path === path && status().canEdit) view.focus(); return result; },
    replaceRange(text, from, to = from, options) { check(options); return dispatch({changes: change({from, to, text})}); },
    transaction(spec, options = {}) {
      if (!spec || typeof spec !== 'object') fail('EDITOR_CHANGE', 'Expected an editor transaction.');
      check({...spec, ...options});
      if (spec.replaceSelection !== undefined) {
        if (spec.changes !== undefined) fail('EDITOR_CHANGE', 'Choose changes or replaceSelection in a transaction.');
        if (typeof spec.replaceSelection !== 'string') fail('EDITOR_CHANGE', 'Expected string replacement text.');
        const replacement = view.state.replaceSelection(spec.replaceSelection), nextDoc = replacement.changes.apply(view.state.doc);
        const ranges = spec.selections ?? (spec.selection ? [spec.selection] : undefined);
        const nextSelection = ranges === undefined ? replacement.selection : selection(ranges, nextDoc, spec.mainIndex ?? 0);
        return dispatch({...replacement, selection: nextSelection, scrollIntoView: Boolean(spec.scrollIntoView)});
      }
      const changes = (spec.changes === undefined ? [] : Array.isArray(spec.changes) ? spec.changes : [spec.changes]).map(item => change(item)).sort((a, b) => a.from - b.from || a.to - b.to);
      for (let i = 1; i < changes.length; i++) if (changes[i].from < changes[i - 1].to || (changes[i].from === changes[i - 1].from && changes[i].to === changes[i].from && changes[i - 1].to === changes[i - 1].from)) fail('EDITOR_CHANGE', 'Transaction changes overlap.');
      const changeSet = view.state.changes(changes), nextDoc = changeSet.apply(view.state.doc);
      const ranges = spec.selections ?? (spec.selection ? [spec.selection] : undefined);
      const nextSelection = ranges === undefined ? undefined : selection(ranges, nextDoc, spec.mainIndex ?? 0);
      return dispatch({changes: changeSet, ...(nextSelection ? {selection: nextSelection} : {}), scrollIntoView: Boolean(spec.scrollIntoView)});
    },
    focus() { check({}, false); cancelScrollRestore(); if (getContext().mode === 'reading') getPreview()?.focus(); else view.focus(); return true; },
    hasFocus() { alive(); const preview = getPreview(); return getContext().mode === 'reading' ? Boolean(preview && preview.contains(preview.ownerDocument.activeElement)) : view.hasFocus; },
    undo(options) { check(options); cancelScrollRestore(); return undo(view); },
    redo(options) { check(options); cancelScrollRestore(); return redo(view); },
    selectAll(options) { check(options); cancelScrollRestore(); return selectAll(view); },
    getScrollInfo() { alive(); const element = scrollDOM(); return {top: element?.scrollTop || 0, left: element?.scrollLeft || 0, clientHeight: element?.clientHeight || 0, clientWidth: element?.clientWidth || 0, height: element?.scrollHeight || 0, width: element?.scrollWidth || 0}; },
    scrollTo(x, y) { check({}, false); if ((x != null && !finite(x)) || (y != null && !finite(y))) fail('EDITOR_POSITION', 'Scroll coordinates must be finite numbers.'); cancelScrollRestore(); const element = scrollDOM(); if (element) { if (x != null) element.scrollLeft = x; if (y != null) { if (getContext().mode === 'reading') setReadingScrollTop(y); else element.scrollTop = y; } } return true; },
    scrollIntoView(range, center = false) { check({}, false); if (getContext().mode === 'reading') fail('EDITOR_READING', 'Source positions are unavailable in reading mode.'); const from = offset(range?.from), to = offset(range?.to ?? range?.from); if (to < from) fail('EDITOR_POSITION', 'The range end precedes its start.'); cancelScrollRestore(); view.dispatch({effects: EditorView.scrollIntoView(EditorSelection.range(from, to), {y: center ? 'center' : 'nearest'})}); return true; },
    getViewState() { alive(); const current = getContext(), main = view.state.selection.main; return {path: current.path, mode: current.mode, cursor: {anchor: main.anchor, head: main.head}, selections: view.state.selection.ranges.map(range => ({anchor: range.anchor, head: range.head})), mainIndex: view.state.selection.mainIndex, scroll: getSourceScroll(), readingScrollTop: getReadingScrollTop()}; },
    setViewState(saved, {onRestored} = {}) {
      if (!saved || saved.path !== api.path) fail('EDITOR_STALE_PATH', 'The saved view belongs to a different document.');
      check({expectedPath: saved.path}, false);
      const ranges = saved.selections ?? (saved.cursor ? [saved.cursor] : undefined);
      let nextSelection;
      if (ranges) {
        if (!Array.isArray(ranges) || !ranges.length) fail('EDITOR_SELECTION', 'Expected valid saved selections.');
        if (!Number.isInteger(saved.mainIndex ?? 0)) fail('EDITOR_SELECTION', 'Invalid saved primary selection.');
        // A persisted cursor may be beyond the end after an external edit.
        const clamp = value => { if (!Number.isInteger(value) || value < 0) fail('EDITOR_SELECTION', 'Invalid saved cursor.'); return Math.min(value, view.state.doc.length); };
        nextSelection = EditorSelection.create(ranges.map(range => EditorSelection.range(clamp(range.anchor), clamp(range.head ?? range.anchor))), Math.min(Math.max(saved.mainIndex ?? 0, 0), ranges.length - 1));
      }
      for (const value of [saved.scroll?.top, saved.scroll?.left, saved.readingScrollTop]) if (value != null && (!finite(value) || value < 0)) fail('EDITOR_POSITION', 'Invalid saved scroll position.');
      cancelScrollRestore();
      if (nextSelection) view.dispatch({selection: nextSelection});
      if (saved.readingScrollTop != null) setReadingScrollTop(saved.readingScrollTop);
      if (saved.scroll) restoreScroll(saved.scroll, onRestored); else onRestored?.(true);
      return true;
    },
  };
  return api;
}
