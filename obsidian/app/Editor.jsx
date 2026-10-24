import {pluginEditorContext, editorInfoField, editorLivePreviewField} from './plugin-editor-context.mjs';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction} from '@codemirror/state';
import {Decoration, EditorView, WidgetType, drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars, keymap, rectangularSelection} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo} from '@codemirror/commands';
import {HighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, syntaxTree} from '@codemirror/language';
import {tags} from '@lezer/highlight';
import {markdown, markdownKeymap, markdownLanguage} from '@codemirror/lang-markdown';
import {autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap} from '@codemirror/autocomplete';
import {highlightSelectionMatches, openSearchPanel, search, searchKeymap} from '@codemirror/search';
import {headingSlug, hydrateMarkdown, navigateTarget, renderMarkdown} from './markdown.js';
import {inlinePreviewRanges, runMarkdownProcessing, selectionInfo} from './editor-helpers.mjs';
import {createEditorApi} from './editor-api.mjs';
import {createScrollRestorer} from './editor-scroll.mjs';
import 'katex/dist/katex.min.css';
import './editor.css';

const externalUpdate = Annotation.define();
const refreshPreview = StateEffect.define();
const markdownHighlight = HighlightStyle.define([
  {tag: tags.heading, fontWeight: '650', color: 'var(--text-normal, #dcddde)'},
  {tag: tags.strong, fontWeight: '700'}, {tag: tags.emphasis, fontStyle: 'italic'},
  {tag: tags.strikethrough, textDecoration: 'line-through'},
  {tag: tags.link, color: 'var(--text-accent, #b39aef)'},
  {tag: tags.url, color: 'var(--text-muted, #929294)'},
  {tag: tags.monospace, fontFamily: 'var(--font-monospace, Consolas, monospace)'},
  {tag: [tags.processingInstruction, tags.meta, tags.comment], color: 'var(--text-muted, #929294)'},
  {tag: tags.invalid, color: '#db8282'}, {tag: tags.keyword, color: '#c49be5'},
  {tag: tags.string, color: '#a7c58e'}, {tag: tags.number, color: '#d5b17a'},
]);
const frontmatterExtension = {
  defineNodes: [{name: 'Frontmatter', block: true, style: tags.meta}],
  parseBlock: [{name: 'Frontmatter', before: 'HorizontalRule', parse(cx, line) {
    if (cx.lineStart !== 0 || line.text.trim() !== '---') return false;
    let end = line.text.length;
    while (cx.nextLine()) { end = cx.lineStart + line.text.length; if (/^(---|\.\.\.)\s*$/.test(line.text)) { cx.nextLine(); break; } }
    cx.addElement(cx.elt('Frontmatter', 0, end));
    return true;
  }}],
};
const editorTheme = EditorView.theme({
  '&': {height: '100%', backgroundColor: 'transparent', color: 'var(--text-normal, #dcddde)', fontSize: 'var(--editor-font-size, 16px)'},
  '.cm-scroller': {fontFamily: 'var(--editor-font, Inter, "Segoe UI", "Microsoft YaHei", sans-serif)', lineHeight: '1.7', overflow: 'auto'},
  '.cm-content': {padding: '28px 0 42vh', minHeight: '100%', caretColor: 'var(--text-normal, #dcddde)'},
  '.cm-line': {padding: '0 8px'},
  '.cm-cursor, .cm-dropCursor': {borderLeftColor: 'var(--text-normal, #dcddde)'},
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {backgroundColor: 'rgba(139, 109, 223, .28)'},
  '.cm-activeLine': {backgroundColor: 'rgba(255,255,255,.025)'},
  '.cm-gutters': {backgroundColor: 'transparent', border: 'none'},
  '.cm-panels': {backgroundColor: 'var(--background-secondary, #202020)', color: 'var(--text-normal, #dcddde)'},
  '.cm-searchMatch': {backgroundColor: '#8f703f70', outline: '1px solid #caa46a80'},
  '.cm-searchMatch.cm-searchMatch-selected': {backgroundColor: '#caa46a90'},
  '.cm-tooltip': {border: '1px solid var(--background-modifier-border, #3a3a3a)', backgroundColor: 'var(--background-secondary, #252525)'},
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {backgroundColor: 'var(--interactive-accent, #8b6cef)', color: '#fff'},
}, {dark: true});

function toggleTask(view, lineIndex) {
  const status = view.api?.getStatus();
  if (view.state.readOnly || status?.pending || status?.composing || status?.readOnly) return;
  if (lineIndex < 0 || lineIndex >= view.state.doc.lines) return;
  const line = view.state.doc.line(lineIndex + 1);
  const match = line.text.match(/^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]/);
  if (!match) return;
  const from = line.from + match[1].length + 1;
  view.dispatch({changes: {from, to: from + 1, insert: match[2] === ' ' ? 'x' : ' '}, userEvent: 'input'});
}

function wrapSelection(view, marker) {
  if (view.state.readOnly || (view.api && !view.api.getStatus().canEdit)) return false;
  const changes = view.state.changeByRange(range => {
    const {from, to} = range, selected = view.state.sliceDoc(from, to), backwards = range.anchor > range.head;
    const unwrap = from >= marker.length && view.state.sliceDoc(from - marker.length, from) === marker && view.state.sliceDoc(to, to + marker.length) === marker;
    const start = from + (unwrap ? -marker.length : marker.length), end = start + selected.length;
    return {changes: unwrap ? [{from: from - marker.length, to: from}, {from: to, to: to + marker.length}] : {from, to, insert: marker + selected + marker}, range: EditorSelection.range(backwards ? end : start, backwards ? start : end)};
  });
  view.dispatch(changes, {userEvent: 'input'});
  return true;
}

function handleRenderedClick(event, {onNavigate, view, path, readOnly}) {
  const anchor = event.target.closest?.('a');
  if (anchor) {
    const internal = anchor.dataset.noteTarget;
    const href = anchor.getAttribute('href') || '';
    if (internal) { event.preventDefault(); onNavigate?.(internal); return; }
    if (href.startsWith('#')) {
      event.preventDefault();
      let id = href.slice(1); try { id = decodeURIComponent(id); } catch { /* Keep malformed anchors literal. */ }
      const element = [...event.currentTarget.querySelectorAll('[id]')].find(node => node.id === id);
      element?.scrollIntoView({block: 'start', behavior: 'smooth'});
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) {
      event.preventDefault();
      if (window.vaultdesk?.openExternal) window.vaultdesk.openExternal(href);
      else window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    // Do not allow raw Markdown HTML to navigate the desktop renderer.
    event.preventDefault();
  }
  const title = event.target.closest?.('.callout-title');
  const callout = title?.closest('[data-folded]');
  if (callout) callout.dataset.folded = callout.dataset.folded === 'true' ? 'false' : 'true';
  const checkbox = event.target.closest?.('input.task-checkbox');
  if (checkbox && checkbox.dataset.path === path && view) { if (readOnly || view.state.readOnly) { event.preventDefault(); return; } toggleTask(view, Number(checkbox.dataset.line)); }
}

class TaskWidget extends WidgetType {
  constructor(checked, line, readOnly) { super(); this.checked = checked; this.line = line; this.readOnly = readOnly; }
  eq(other) { return other.checked === this.checked && other.line === this.line && other.readOnly === this.readOnly; }
  toDOM(view) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = this.checked; checkbox.disabled = this.readOnly; checkbox.className = 'task-checkbox cm-task-checkbox'; checkbox.setAttribute('aria-label', '切换任务状态');
    checkbox.addEventListener('mousedown', event => event.preventDefault());
    checkbox.addEventListener('click', event => { event.stopPropagation(); toggleTask(view, this.line); });
    return checkbox;
  }
  ignoreEvent() { return true; }
}

class MarkdownWidget extends WidgetType {
  constructor(text, from, context) {
    super(); this.text = text; this.from = from; this.context = context;
    this.renderPath = context.current.path; this.renderFiles = context.current.files; this.readOnly = context.current.readOnly; this.assetResolver = context.current.resolveAsset; this.processor = context.current.processMarkdown;
  }
  eq(other) { return this.text === other.text && this.from === other.from && this.context === other.context && this.renderPath === other.renderPath && this.renderFiles === other.renderFiles && this.readOnly === other.readOnly && this.assetResolver === other.assetResolver && this.processor === other.processor; }
  toDOM(view) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-live-widget markdown-rendered';
    const context = this.context.current;
    wrapper.innerHTML = renderMarkdown(this.text, {path: context.path, files: context.files, lineOffset: view.state.doc.lineAt(this.from).number - 1});
    const edit = document.createElement('button'); edit.className = 'cm-widget-edit'; edit.type = 'button'; edit.textContent = '‹/›'; edit.title = '编辑源码'; edit.setAttribute('aria-label', '编辑此区块源码');
    edit.disabled = context.readOnly;
    const activate = event => {
      if (this.context.current.readOnly || view.state.readOnly || (view.api && !view.api.getStatus().canEdit)) return;
      event.preventDefault(); event.stopPropagation();
      const blockEnd = Math.min(this.from + this.text.length, view.state.doc.length);
      const source = event.target.closest?.('[data-source-line]');
      const lineNumber = source?.dataset.path === this.context.current.path ? Number(source.dataset.sourceLine) : 0;
      let anchor = this.from;
      if (lineNumber > 0 && lineNumber <= view.state.doc.lines) {
        const line = view.state.doc.line(lineNumber);
        anchor = Math.max(this.from, Math.min(line.from, blockEnd));
        const cell = event.target.closest?.('td, th');
        if (cell?.textContent.trim()) {
          const offset = line.text.indexOf(cell.textContent.trim());
          if (offset >= 0) anchor = Math.max(this.from, Math.min(line.from + offset, blockEnd));
        }
      }
      view.dispatch({selection: EditorSelection.cursor(anchor), scrollIntoView: true}); view.focus();
    };
    edit.addEventListener('click', activate); wrapper.append(edit);
    wrapper.addEventListener('click', event => {
      if (event.target.closest?.('a, button, input, audio, video, .callout-title[role="button"], .note-embed-content')) handleRenderedClick(event, {...this.context.current, view});
      else if (!window.getSelection()?.toString()) activate(event);
    });
    wrapper.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('callout-title')) { event.preventDefault(); event.target.click(); } });
    wrapper.disposeMarkdown = runMarkdownProcessing(wrapper, {hydrate: () => hydrateMarkdown(wrapper, {resolveAsset: context.resolveAsset}), processMarkdown: context.processMarkdown, context: {path: context.path, text: this.text, lineOffset: view.state.doc.lineAt(this.from).number - 1}, onReady: () => view.requestMeasure()});
    return wrapper;
  }
  ignoreEvent() { return true; }
  destroy(dom) { dom.disposeMarkdown?.(); }
}

function liveDecorations(state, context) {
  const ranges = [], hidden = [], inlineLines = new Set();
  const activeLines = new Set();
  for (const selection of state.selection.ranges) {
    const first = state.doc.lineAt(selection.from).number, last = state.doc.lineAt(selection.empty ? selection.to : Math.max(selection.from, selection.to - 1)).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }
  const replace = (from, to) => { if (from < to) hidden.push({from, to}); };
  const mark = (from, to, className, attributes) => { if (from < to) ranges.push(Decoration.mark({class: className, attributes}).range(from, to)); };
  const block = (from, to, text) => ranges.push(Decoration.replace({widget: new MarkdownWidget(text, from, context), block: true}).range(from, to));
  const isActive = (from, to) => { for (let n = from; n <= to; n++) if (activeLines.has(n)) return true; return false; };
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n), text = line.text;
    if (n === 1 && text.trim() === '---') {
      let end = n;
      while (++end < state.doc.lines && !/^(---|\.\.\.)\s*$/.test(state.doc.line(end).text)) {}
      end = Math.min(end, state.doc.lines);
      for (let row = n; row <= end; row++) ranges.push(Decoration.line({class: 'cm-frontmatter-line'}).range(state.doc.line(row).from));
      n = end; continue;
    }
    const fence = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      let end = n;
      const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++end <= state.doc.lines && !close.test(state.doc.line(end).text)) {}
      end = Math.min(end, state.doc.lines);
      if (fence[2].trim() === 'mermaid' && !isActive(n, end)) {
        block(line.from, state.doc.line(end).to, state.doc.sliceString(line.from, state.doc.line(end).to)); n = end; continue;
      }
      for (let row = n; row <= end; row++) ranges.push(Decoration.line({class: 'cm-fenced-line'}).range(state.doc.line(row).from));
      n = end; continue;
    }
    if (/^\s*\$\$/.test(text)) {
      let end = n;
      if (!/^\s*\$\$.+\$\$\s*$/.test(text)) while (++end < state.doc.lines && !/\$\$\s*$/.test(state.doc.line(end).text)) {}
      end = Math.min(end, state.doc.lines);
      if (!isActive(n, end)) block(line.from, state.doc.line(end).to, state.doc.sliceString(line.from, state.doc.line(end).to));
      else for (let row = n; row <= end; row++) ranges.push(Decoration.line({class: 'cm-math-source'}).range(state.doc.line(row).from));
      n = end; continue;
    }
    if (/^\s*>\s*\[![\w-]+\]/.test(text)) {
      let end = n;
      while (end < state.doc.lines && /^\s*>/.test(state.doc.line(end + 1).text)) end++;
      if (!isActive(n, end)) { block(line.from, state.doc.line(end).to, state.doc.sliceString(line.from, state.doc.line(end).to)); n = end; continue; }
    }
    if (/^\s*\|?.+\|.+\|?\s*$/.test(text) && n < state.doc.lines && /^\s*\|?\s*:?-{3,}/.test(state.doc.line(n + 1).text)) {
      let end = n + 1;
      while (end < state.doc.lines && state.doc.line(end + 1).text.includes('|') && state.doc.line(end + 1).text.trim()) end++;
      if (!isActive(n, end)) { block(line.from, state.doc.line(end).to, state.doc.sliceString(line.from, state.doc.line(end).to)); n = end; continue; }
    }
    const heading = text.match(/^(#{1,6})\s+/);
    if (heading) { ranges.push(Decoration.line({class: `cm-heading-line cm-heading-${heading[1].length}`}).range(line.from)); if (!activeLines.has(n)) replace(line.from, line.from + heading[0].length); }
    if (/^\s*>/.test(text)) ranges.push(Decoration.line({class: 'cm-quote-line'}).range(line.from));
    if (activeLines.has(n)) continue;
    if (/^\s*(?:!\[\[[^\n]+\]\]|!\[[^\]]*\]\([^\n]+\)|(?:[-*_]\s*){3,})\s*$/.test(text)) { block(line.from, line.to, text); continue; }
    const task = text.match(/^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]\s*/);
    if (task) {
      ranges.push(Decoration.line({class: task[2] === ' ' ? 'cm-task-line' : 'cm-task-line cm-task-completed'}).range(line.from));
      ranges.push(Decoration.replace({widget: new TaskWidget(task[2] !== ' ', n - 1, state.readOnly)}).range(line.from + task[1].length, line.from + task[0].length));
    }
    inlineLines.add(n);
  }
  const inline = inlinePreviewRanges(state);
  const eligible = item => {
    const from = item.scopeFrom ?? item.from, to = item.scopeTo ?? item.to;
    const first = state.doc.lineAt(from).number, last = state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let line = first; line <= last; line++) if (!inlineLines.has(line)) return false;
    return true;
  };
  for (const item of inline.hidden) if (eligible(item)) replace(item.from, item.to);
  for (const item of inline.marks) if (eligible(item)) mark(item.from, item.to, item.className, item.target ? {'data-note-target': navigateTarget(item.target, context.current.path, context.current.files, item.syntax)} : undefined);
  hidden.sort((a, b) => a.from - b.from || b.to - a.to);
  let end = -1;
  for (const item of hidden) if (item.from >= end) { ranges.push(Decoration.replace({}).range(item.from, item.to)); end = item.to; }
  return Decoration.set(ranges, true);
}

function createLiveField(context) {
  return StateField.define({
    create: state => liveDecorations(state, context),
    update: (value, transaction) => transaction.docChanged || transaction.selection || syntaxTree(transaction.state) !== syntaxTree(transaction.startState) || transaction.effects.some(effect => effect.is(refreshPreview)) ? liveDecorations(transaction.state, context) : value,
    provide: field => EditorView.decorations.from(field),
  });
}

function completionSource(context) {
  return completion => {
    const slash = completion.matchBefore(/\/[^\n]*$/);
    if (slash && !completion.state.doc.sliceString(completion.state.doc.lineAt(slash.from).from, slash.from).trim()) {
      const query = slash.text.slice(1).toLowerCase();
      return {from: slash.from, filter: false, options: (context.current.commands || []).filter(command => command.name.toLowerCase().includes(query)).map(command => ({
        label: command.name, type: 'function', detail: '命令',
        apply(view, option, from, to) { if (view.state.readOnly) return; view.dispatch({changes: {from, to, insert: ''}, selection: {anchor: from}, userEvent: 'input'}); queueMicrotask(() => command.run()); },
      }))};
    }
    const wiki = completion.matchBefore(/\[\[[^\]\n]*/);
    if (wiki) {
      const prefix = wiki.text.slice(2);
      return {from: wiki.from + 2, options: Object.keys(context.current.files || {}).filter(path => /\.md$/i.test(path)).map(path => ({
        label: path.replace(/\.md$/i, ''), displayLabel: path.split('/').pop().replace(/\.md$/i, ''), detail: path.includes('/') ? path : undefined, type: 'text',
        apply(view, option, from, to) { if (view.state.readOnly) return; const suffix = view.state.doc.sliceString(to, to + 2) === ']]' ? '' : ']]'; view.dispatch({changes: {from, to, insert: option.label + suffix}, selection: {anchor: from + option.label.length + suffix.length}}); },
      })).filter(option => option.label.toLowerCase().includes(prefix.toLowerCase())), validFor: /^[^\]\n]*$/};
    }
    return null;
  };
}

function replaceFromOutside(view, value) {
  const previous = view.state.doc.toString();
  if (previous === value) return;
  let start = 0, oldEnd = previous.length, newEnd = value.length;
  while (start < oldEnd && start < newEnd && previous[start] === value[start]) start++;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
  view.dispatch({changes: {from: start, to: oldEnd, insert: value.slice(start, newEnd)}, annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false), isolateHistory.of('full')]});
}

export default function Editor({path = '', value = '', onChange, mode: requestedMode = 'live', onNavigate, resolveAsset, processMarkdown, pluginExtensions, files = {}, onReady, onSelectionChange, onViewStateChange, initialViewState, viewStateRevision = 0, onPasteFiles, commands = [], readOnly = false}) {
  const [mode, setMode] = useState(requestedMode);
  const [shownPath, setShownPath] = useState(path);
  const mount = useRef(null), preview = useRef(null), viewRef = useRef(null), states = useRef(new Map()), scrollPositions = useRef(new Map()), readingScrollPositions = useRef(new Map());
  const currentPath = useRef(path), compositionTailUntil = useRef(0), destroyed = useRef(false), viewStateTimer = useRef(null), pendingRestore = useRef({path, state: initialViewState}), deferredSourceScroll = useRef(null), activeSourceRestore = useRef(null);
  const restoredRevision = useRef(viewStateRevision);
  const incoming = {path, value, onChange, onNavigate, resolveAsset, processMarkdown, files, mode, requestedMode, onReady, onSelectionChange, onViewStateChange, initialViewState, onPasteFiles, commands, readOnly};
  const requestedContext = useRef(incoming); requestedContext.current = incoming;
  const context = useRef(incoming);
  // Keep callbacks bound to the document still receiving composition events.
  // Updating props to B must never send the tail of A's composition to B.
  if (currentPath.current === path) context.current = incoming;
  const [hover, setHover] = useState(null), hoverTimer = useRef(null), hoverTarget = useRef(null);
  const pluginSlot = useRef(new Compartment()), pluginContextSlot = useRef(new Compartment());
  const modeSlot = useRef(new Compartment()), readOnlySlot = useRef(new Compartment()), liveField = useRef(null);
  const displayed = context.current;
  const html = useMemo(() => mode === 'reading' ? renderMarkdown(displayed.value, {path: displayed.path, files: displayed.files, rootPath: displayed.readOnly ? '__read_only__' : displayed.path}) : '', [displayed.value, displayed.path, displayed.files, mode, displayed.readOnly]);
  const compositionPending = () => viewRef.current?.compositionStarted || performance.now() < compositionTailUntil.current;
  const publishViewState = () => {
    clearTimeout(viewStateTimer.current); viewStateTimer.current = null;
    const api = viewRef.current?.api;
    if (!api || destroyed.current || pendingRestore.current?.path === currentPath.current || activeSourceRestore.current?.path === currentPath.current) return;
    context.current.onViewStateChange?.(api.getViewState(), context.current.path);
  };
  const queueViewState = () => { if (viewStateTimer.current === null) viewStateTimer.current = setTimeout(publishViewState, 80); };

  useEffect(() => {
    const view = viewRef.current;
    if (view && context.current.path === path) view.dispatch({effects: [pluginSlot.current.reconfigure(pluginExtensions || []), pluginContextSlot.current.reconfigure(pluginEditorContext.of({file: {path}, livePreview: context.current.mode === 'live'}))]});
  }, [pluginExtensions, path, shownPath, mode]);
  useEffect(() => {
    let timer;
    const apply = () => { if (compositionPending() || currentPath.current !== requestedContext.current.path) timer = setTimeout(apply, 80); else setMode(requestedMode); };
    apply();
    return () => clearTimeout(timer);
  }, [requestedMode, path]);

  useEffect(() => {
    destroyed.current = false;
    let disposed = false;
    liveField.current = createLiveField(context);
    const sourceClick = (event, view) => {
      const target = event.target.closest?.('[data-note-target]');
      if (target) { event.preventDefault(); context.current.onNavigate?.(target.dataset.noteTarget); return true; }
      if (!event.ctrlKey && !event.metaKey) return false;
      const pos = view.posAtCoords({x: event.clientX, y: event.clientY});
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos), offset = pos - line.from;
      for (const match of line.text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)]+)\)/g)) {
        if (match.index <= offset && match.index + match[0].length >= offset) { context.current.onNavigate?.(navigateTarget(match[1] || match[2], context.current.path, context.current.files, match[1] ? 'wiki' : 'markdown')); return true; }
      }
      return false;
    };
    const extensions = [
      pluginSlot.current.of(pluginExtensions || []), pluginContextSlot.current.of(pluginEditorContext.of({file: {path: context.current.path}, livePreview: context.current.mode === 'live'})), editorInfoField, editorLivePreviewField,
      editorTheme, EditorView.lineWrapping, EditorState.allowMultipleSelections.of(true), highlightSpecialChars(), history(), drawSelection(), dropCursor(), rectangularSelection(),
      indentOnInput(), markdown({base: markdownLanguage, extensions: [frontmatterExtension]}), syntaxHighlighting(markdownHighlight), foldGutter(), closeBrackets(), autocompletion({override: [completionSource(context)]}),
      search({top: true}), highlightSelectionMatches(),
      keymap.of([{key: 'Mod-Shift-z', run: redo, preventDefault: true}, {key: 'Mod-b', run: view => wrapSelection(view, '**')}, {key: 'Mod-i', run: view => wrapSelection(view, '*')}, {key: 'Mod-Shift-h', run: view => wrapSelection(view, '==')}, ...closeBracketsKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, ...foldKeymap, indentWithTab]),
      modeSlot.current.of(context.current.mode === 'live' ? [liveField.current] : [highlightActiveLine()]),
      readOnlySlot.current.of([EditorState.readOnly.of(context.current.readOnly), EditorView.editable.of(!context.current.readOnly)]),
      EditorView.contentAttributes.of({'aria-label': '笔记编辑器', spellcheck: 'false', 'data-testid': 'markdown-editor'}),
      EditorView.domEventHandlers({click: sourceClick}),
      // compositionend may precede the final input/DOM mutation. Keep the old
      // document bound through a quiet interval, extended by any pending edit.
      EditorView.domEventObservers({
        compositionend: () => { compositionTailUntil.current = performance.now() + 80; },
        input: event => { if (event.isComposing || /composition/i.test(event.inputType || '')) compositionTailUntil.current = performance.now() + 80; },
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalUpdate))) {
          if (currentPath.current !== requestedContext.current.path) compositionTailUntil.current = performance.now() + 80;
          context.current = {...context.current, value: update.state.doc.toString()};
          context.current.onChange?.(context.current.value);
        }
        if (update.docChanged || update.selectionSet) context.current.onSelectionChange?.(selectionInfo(update.state));
        if (update.docChanged || update.selectionSet) queueViewState();
      }),
    ];
    const makeState = text => EditorState.create({doc: text, extensions});
    const view = new EditorView({state: makeState(context.current.value), parent: mount.current});
    viewRef.current = view; viewRef.current.makeState = makeState;
    const scrollRestorer = createScrollRestorer(view, {getIdentity: () => disposed ? '' : `${context.current.path}\0${context.current.mode}`, onFailure: () => console.warn('Editor scroll restoration did not stabilize')});
    const getSourceScroll = () => {
      const path = context.current.path;
      if (context.current.mode !== 'reading' && view.scrollDOM.clientHeight && deferredSourceScroll.current?.path !== path && activeSourceRestore.current?.path !== path) scrollPositions.current.set(path, {top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft});
      return scrollPositions.current.get(path) || {top: 0, left: 0};
    };
    const restoreSourceScroll = (scroll, done) => {
      const path = context.current.path, target = {...getSourceScroll(), ...scroll};
      scrollPositions.current.set(path, target);
      if (context.current.mode === 'reading' || !view.scrollDOM.clientHeight) {
        scrollRestorer.cancel(); deferredSourceScroll.current = {path, scroll: target}; done?.(true); return;
      }
      deferredSourceScroll.current = null;
      const task = activeSourceRestore.current = {path};
      scrollRestorer.restore(target, restored => {
        if (activeSourceRestore.current === task) activeSourceRestore.current = null;
        done?.(restored); queueViewState();
      });
    };
    view.restoreSourceScroll = () => { const deferred = deferredSourceScroll.current; if (deferred?.path === context.current.path && context.current.mode !== 'reading') restoreSourceScroll(deferred.scroll); };
    const onSourceScroll = () => { getSourceScroll(); queueViewState(); };
    const readyForNavigation = () => { if (disposed || compositionPending() || currentPath.current !== requestedContext.current.path) return false; scrollRestorer.cancel(); return true; };
    const api = Object.assign(createEditorApi({view, getContext: () => context.current, getRequestedContext: () => requestedContext.current, isComposing: compositionPending, isDestroyed: () => disposed || destroyed.current, getPreview: () => preview.current,
      getSourceScroll,
      getReadingScrollTop: () => { if (context.current.mode === 'reading' && preview.current) readingScrollPositions.current.set(context.current.path, preview.current.scrollTop); return readingScrollPositions.current.get(context.current.path) || 0; },
      setReadingScrollTop: top => { readingScrollPositions.current.set(context.current.path, top); if (context.current.mode === 'reading' && preview.current) preview.current.scrollTop = top; },
      restoreScroll: restoreSourceScroll, cancelScrollRestore: scrollRestorer.cancel,
    }), {
      find: () => readyForNavigation() && context.current.mode !== 'reading' && openSearchPanel(view), replace: () => readyForNavigation() && context.current.mode !== 'reading' && openSearchPanel(view),
      scrollToLine: number => {
        if (!readyForNavigation()) return false;
        const lineNumber = Math.max(1, Math.min(Math.trunc(Number(number) || 1), view.state.doc.lines));
        if (context.current.mode === 'reading' && preview.current) {
          const blocks = [...preview.current.querySelectorAll('[data-source-line]')].filter(element => element.dataset.path === context.current.path);
          blocks.sort((a, b) => Math.abs(Number(a.dataset.sourceLine) - lineNumber) - Math.abs(Number(b.dataset.sourceLine) - lineNumber));
          if (blocks[0]) { blocks[0].scrollIntoView({block: 'start', behavior: 'smooth'}); return true; }
        }
        const line = view.state.doc.line(lineNumber);
        view.dispatch({selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, {y: 'start', yMargin: 24})});
        return context.current.mode !== 'reading';
      },
      scrollToFootnote: id => {
        if (!readyForNavigation()) return false;
        const label = String(id || '').replace(/^\[\^(.+)\]:?$/, '$1').replace(/^\^/, '');
        if (context.current.mode === 'reading' && preview.current) {
          const footnote = [...preview.current.querySelectorAll('[data-footnote-label]')].find(element => element.dataset.path === context.current.path && element.dataset.footnoteLabel === label);
          if (footnote) { footnote.scrollIntoView({block: 'start', behavior: 'smooth'}); return true; }
        }
        for (let n = 1; n <= view.state.doc.lines; n++) {
          const line = view.state.doc.line(n);
          if (line.text.match(/^ {0,3}\[\^([^\]]+)\]:/)?.[1] === label) {
            view.dispatch({selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, {y: 'start', yMargin: 24})});
            return context.current.mode !== 'reading';
          }
        }
        return false;
      },
      scrollToHeading: target => {
        if (!readyForNavigation()) return false;
        let fragment = String(target || '').replace(/^#/, ''); try { fragment = decodeURIComponent(fragment); } catch { /* Keep malformed anchors literal. */ }
        if (context.current.mode === 'reading' && preview.current) {
          const heading = [...preview.current.querySelectorAll('[id]')].find(element => element.id === fragment || element.id === headingSlug(fragment) || headingSlug(element.dataset.heading || '') === headingSlug(fragment));
          if (heading) { heading.scrollIntoView({block: 'start', behavior: 'smooth'}); return; }
        }
        for (let n = 1; n <= view.state.doc.lines; n++) {
          const line = view.state.doc.line(n);
          if ((fragment.startsWith('^') && line.text.trimEnd().endsWith(fragment)) || (/^#{1,6}\s/.test(line.text) && headingSlug(line.text.replace(/^#{1,6}\s+/, '')) === headingSlug(fragment))) {
            view.dispatch({selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, {y: 'start', yMargin: 24})}); return;
          }
        }
      },
    });
    viewRef.current.api = api;
    view.scrollDOM.addEventListener('scroll', onSourceScroll, {passive: true});
    context.current.onReady?.(api);
    context.current.onSelectionChange?.(selectionInfo(view.state));
    return () => { scrollRestorer.cancel(); publishViewState(); disposed = true; destroyed.current = true; view.scrollDOM.removeEventListener('scroll', onSourceScroll); context.current.onReady?.(null); view.destroy(); viewRef.current = null; };
  }, []);

  useEffect(() => {
    const view = viewRef.current; if (!view) return;
    let timer;
    const apply = () => {
      if (compositionPending()) { timer = setTimeout(apply, 80); return; }
      const next = requestedContext.current;
      if (currentPath.current !== next.path) {
        publishViewState();
        states.current.set(currentPath.current, view.state);
        scrollPositions.current.set(currentPath.current, view.api.getViewState().scroll);
        if (states.current.size > 30) { const oldest = states.current.keys().next().value; states.current.delete(oldest); scrollPositions.current.delete(oldest); readingScrollPositions.current.delete(oldest); }
        const cached = states.current.get(next.path);
        pendingRestore.current = {path: next.path, state: next.initialViewState || (cached ? {path: next.path, scroll: scrollPositions.current.get(next.path)} : undefined)};
        currentPath.current = next.path; context.current = next;
        view.setState(cached || view.makeState(next.value));
        view.dispatch({effects: [pluginContextSlot.current.reconfigure(pluginEditorContext.of({file: {path: next.path}, livePreview: next.mode === 'live'})), modeSlot.current.reconfigure(next.mode === 'live' ? [liveField.current] : [highlightActiveLine()]), readOnlySlot.current.reconfigure([EditorState.readOnly.of(next.readOnly), EditorView.editable.of(!next.readOnly)])]});
        view.scrollDOM.scrollTop = scrollPositions.current.get(next.path)?.top || 0;
        view.scrollDOM.scrollLeft = scrollPositions.current.get(next.path)?.left || 0;
        context.current.onSelectionChange?.(selectionInfo(view.state));
        setShownPath(next.path);
      }
      replaceFromOutside(view, next.value);
    };
    apply();
    return () => clearTimeout(timer);
  }, [path, value]);

  useEffect(() => {
    if (Object.is(restoredRevision.current, viewStateRevision)) return;
    restoredRevision.current = viewStateRevision;
    const next = requestedContext.current;
    // Named layouts can target this same pane and file. Only an explicit
    // revision restores that selection again; ordinary parent renders do not.
    pendingRestore.current = {path: next.path, state: next.initialViewState};
  }, [viewStateRevision]);

  useEffect(() => {
    let timer;
    const restore = () => {
      const pending = pendingRestore.current, api = viewRef.current?.api;
      if (!pending || !api || pending.path !== api.path) return;
      if (api.getStatus().pending || compositionPending()) { timer = setTimeout(restore, 80); return; }
      const complete = () => { if (pendingRestore.current === pending) { pendingRestore.current = null; queueViewState(); } };
      if (pending.state && (!pending.state.path || pending.state.path === pending.path)) {
        try { api.setViewState({...pending.state, path: pending.path}, {onRestored: complete}); } catch (error) { console.warn('Could not restore editor view state', error); complete(); }
      } else complete();
    };
    restore();
    return () => clearTimeout(timer);
  }, [shownPath, mode, viewStateRevision]);

  useEffect(() => { queueViewState(); }, [mode]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) { view.dispatch({effects: modeSlot.current.reconfigure(mode === 'live' ? [liveField.current] : [highlightActiveLine()])}); view.restoreSourceScroll?.(); view.requestMeasure(); }
  }, [mode, shownPath]);

  useEffect(() => {
    let timer;
    const apply = () => {
      if (currentPath.current !== path) return;
      // Preserve the tail of an input composition that began while editable.
      // The public API already observes requested readOnly and rejects writes.
      if (compositionPending()) { timer = setTimeout(apply, 80); return; }
      viewRef.current?.dispatch({effects: [readOnlySlot.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]), refreshPreview.of(null)]});
    };
    apply();
    return () => clearTimeout(timer);
  }, [readOnly, path]);

  useEffect(() => {
    let timer;
    const apply = () => {
      const view = viewRef.current;
      if (!view || currentPath.current !== path || mode !== 'live') return;
      if (compositionPending()) { timer = setTimeout(apply, 80); return; }
      view.dispatch({effects: refreshPreview.of(null)});
    };
    apply();
    return () => clearTimeout(timer);
  }, [files, resolveAsset, processMarkdown, path, mode]);

  useEffect(() => {
    if (mode === 'reading' && preview.current) {
      const element = preview.current, readingPath = displayed.path;
      element.scrollTop = readingScrollPositions.current.get(readingPath) || 0;
      const cleanup = runMarkdownProcessing(element, {hydrate: () => hydrateMarkdown(element, {resolveAsset: displayed.resolveAsset}), processMarkdown: displayed.processMarkdown, context: {path: displayed.path, text: displayed.value, lineOffset: 0}});
      return cleanup;
    }
  }, [html, mode, displayed.path, displayed.value, displayed.resolveAsset, displayed.processMarkdown]);

  useEffect(() => { if (viewRef.current?.api) onReady?.(viewRef.current.api); }, [onReady]);

  useEffect(() => { clearTimeout(hoverTimer.current); hoverTarget.current = null; setHover(null); }, [path, mode]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const hideHover = () => { clearTimeout(hoverTimer.current); hoverTarget.current = null; hoverTimer.current = setTimeout(() => setHover(null), 150); };
  const inspectLink = event => {
    const {path, files} = context.current;
    if (event.target.closest?.('.link-preview')) { clearTimeout(hoverTimer.current); return; }
    const anchor = event.target.closest?.('[data-note-target]');
    let target = anchor?.dataset.noteTarget;
    if (!target && (event.ctrlKey || event.metaKey) && mode !== 'reading') {
      const view = viewRef.current, position = view?.posAtCoords({x: event.clientX, y: event.clientY});
      if (position != null) {
        const line = view.state.doc.lineAt(position), offset = position - line.from;
        for (const match of line.text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)]+)\)/g)) if (match.index <= offset && offset <= match.index + match[0].length) target = navigateTarget(match[1] || match[2], path, files, match[1] ? 'wiki' : 'markdown');
      }
    }
    const notePath = target?.split('#')[0];
    if (!target || !notePath?.endsWith('.md') || typeof files[notePath] !== 'string') { if (hoverTarget.current) hideHover(); return; }
    if (hoverTarget.current === target) return;
    clearTimeout(hoverTimer.current); hoverTarget.current = target;
    const rect = anchor?.getBoundingClientRect() || {left: event.clientX, bottom: event.clientY};
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - 372)), top = Math.max(12, Math.min(rect.bottom + 9, window.innerHeight - 270));
    const text = files[notePath].replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, '').replace(/!\[\[[^\]]+\]\]/g, '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, link, label) => label || link).replace(/^#{1,6}\s+/gm, '').replace(/[*_`]/g, '').trim().slice(0, 650);
    hoverTimer.current = setTimeout(() => setHover({target, notePath, text, left, top}), 350);
  };

  const receiveFiles = (event, drop = false) => {
    const transfer = drop ? event.dataTransfer : event.clipboardData;
    const incoming = Array.from(transfer?.files || []);
    if (!incoming.length || !context.current.onPasteFiles) return;
    event.preventDefault(); event.stopPropagation();
    const view = viewRef.current;
    if (!view || context.current.readOnly || requestedContext.current.readOnly || view.state.readOnly || compositionPending() || currentPath.current !== requestedContext.current.path) return;
    if (drop && mode !== 'reading') {
      const position = view.posAtCoords({x: event.clientX, y: event.clientY});
      if (position != null) view.dispatch({selection: EditorSelection.cursor(position)});
    }
    context.current.onPasteFiles(incoming, {path: context.current.path, ...view.api.getSelectionInfo()});
  };

  return <div className={`vault-editor mode-${mode}`} data-editor-mode={mode} data-editor-path={shownPath} aria-busy={shownPath !== path} onMouseOver={inspectLink} onMouseMove={inspectLink} onMouseLeave={hideHover}
    onPasteCapture={receiveFiles} onDropCapture={event => receiveFiles(event, true)} onDragOver={event => { if (onPasteFiles && Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); }}>
    <div ref={mount} className="codemirror-mount" hidden={mode === 'reading'} />
    {mode === 'reading' && <article ref={preview} className="markdown-rendered markdown-reading" aria-label="笔记阅读视图" tabIndex={0} onScroll={event => { readingScrollPositions.current.set(displayed.path, event.currentTarget.scrollTop); queueViewState(); }}
      onClick={event => handleRenderedClick(event, {...context.current, view: viewRef.current})}
      onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('callout-title')) { event.preventDefault(); event.target.click(); } }}
      dangerouslySetInnerHTML={{__html: html}} />}
    {hover && <aside className="link-preview" style={{left: hover.left, top: hover.top}} onMouseEnter={() => clearTimeout(hoverTimer.current)} onMouseLeave={hideHover} aria-label={`预览 ${hover.notePath}`}>
      <header><span>{hover.notePath.replace(/\.md$/i, '')}</span><button type="button" onClick={() => { onNavigate?.(hover.target); hideHover(); }}>打开 ↗</button></header>
      <div className="link-preview-text">{hover.text || '空白笔记'}</div>
    </aside>}
  </div>;
}
