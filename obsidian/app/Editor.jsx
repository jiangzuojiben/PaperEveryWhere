import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField} from '@codemirror/state';
import {Decoration, EditorView, WidgetType, drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars, keymap, rectangularSelection} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab, redo, selectAll, undo} from '@codemirror/commands';
import {HighlightStyle, indentOnInput, syntaxHighlighting} from '@codemirror/language';
import {tags} from '@lezer/highlight';
import {markdown, markdownKeymap} from '@codemirror/lang-markdown';
import {autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap} from '@codemirror/autocomplete';
import {highlightSelectionMatches, openSearchPanel, search, searchKeymap} from '@codemirror/search';
import {headingSlug, hydrateMarkdown, navigateTarget, renderMarkdown} from './markdown.js';
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
  if (view.state.readOnly) return;
  if (lineIndex < 0 || lineIndex >= view.state.doc.lines) return;
  const line = view.state.doc.line(lineIndex + 1);
  const match = line.text.match(/^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]/);
  if (!match) return;
  const from = line.from + match[1].length + 1;
  view.dispatch({changes: {from, to: from + 1, insert: match[2] === ' ' ? 'x' : ' '}, userEvent: 'input'});
}

function wrapSelection(view, marker) {
  if (view.state.readOnly) return false;
  const {from, to} = view.state.selection.main, selected = view.state.sliceDoc(from, to);
  if (from >= marker.length && view.state.sliceDoc(from - marker.length, from) === marker && view.state.sliceDoc(to, to + marker.length) === marker) {
    view.dispatch({changes: [{from: from - marker.length, to: from, insert: ''}, {from: to, to: to + marker.length, insert: ''}], selection: {anchor: from - marker.length, head: to - marker.length}, userEvent: 'input'});
  } else view.dispatch({changes: {from, to, insert: marker + selected + marker}, selection: {anchor: from + marker.length, head: to + marker.length}, userEvent: 'input'});
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
  constructor(text, from, context) { super(); this.text = text; this.from = from; this.context = context; }
  eq(other) { return this.text === other.text && this.from === other.from && this.context === other.context; }
  toDOM(view) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-live-widget markdown-rendered';
    const context = this.context.current;
    wrapper.innerHTML = renderMarkdown(this.text, {path: context.path, files: context.files, lineOffset: view.state.doc.lineAt(this.from).number - 1});
    const edit = document.createElement('button'); edit.className = 'cm-widget-edit'; edit.type = 'button'; edit.textContent = '‹/›'; edit.title = '编辑源码'; edit.setAttribute('aria-label', '编辑此区块源码');
    const activate = event => { event.preventDefault(); event.stopPropagation(); view.dispatch({selection: {anchor: Math.min(this.from + 1, view.state.doc.length)}, scrollIntoView: true}); view.focus(); };
    edit.addEventListener('click', activate); wrapper.append(edit);
    wrapper.addEventListener('dblclick', activate);
    wrapper.addEventListener('click', event => handleRenderedClick(event, {...this.context.current, view}));
    hydrateMarkdown(wrapper, {resolveAsset: context.resolveAsset}).then(() => view.requestMeasure());
    return wrapper;
  }
  ignoreEvent() { return true; }
}

function liveDecorations(state, context) {
  const ranges = [], hidden = [];
  const activeLines = new Set();
  for (const selection of state.selection.ranges) {
    const first = state.doc.lineAt(selection.from).number, last = state.doc.lineAt(selection.to).number;
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
    const wiki = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let match;
    while ((match = wiki.exec(text))) {
      if (match.index > 0 && text[match.index - 1] === '!') continue;
      const from = line.from + match.index, labelStart = from + (match[2] ? match[0].indexOf('|') + 1 : 2), end = from + match[0].length;
      replace(from, labelStart); replace(end - 2, end);
      mark(labelStart, end - 2, 'cm-live-link', {'data-note-target': navigateTarget(match[1], context.current.path, context.current.files)});
    }
    const links = /\[([^\]]+)\]\(([^)]+)\)/g;
    while ((match = links.exec(text))) {
      if (match.index > 0 && text[match.index - 1] === '!') continue;
      const from = line.from + match.index, end = from + match[0].length;
      replace(from, from + 1); replace(from + match[1].length + 1, end);
      mark(from + 1, from + match[1].length + 1, 'cm-live-link', {'data-note-target': navigateTarget(match[2], context.current.path, context.current.files, 'markdown')});
    }
    for (const [pattern, className, delimiter] of [[/\*\*([^*]+)\*\*/g, 'cm-live-bold', 2], [/__([^_]+)__/g, 'cm-live-bold', 2], [/(?<!\*)\*([^*\n]+)\*(?!\*)/g, 'cm-live-italic', 1], [/(?<!_)_([^_\n]+)_(?!_)/g, 'cm-live-italic', 1], [/~~([^~]+)~~/g, 'cm-live-strike', 2], [/==([^=]+)==/g, 'cm-live-highlight', 2], [/`([^`]+)`/g, 'cm-live-code', 1]]) {
      while ((match = pattern.exec(text))) {
        const from = line.from + match.index, end = from + match[0].length;
        replace(from, from + delimiter); replace(end - delimiter, end); mark(from + delimiter, end - delimiter, className);
      }
    }
    for (const tag of text.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]+)/gu)) mark(line.from + tag.index + tag[1].length, line.from + tag.index + tag[0].length, 'cm-live-tag');
  }
  hidden.sort((a, b) => a.from - b.from || b.to - a.to);
  let end = -1;
  for (const item of hidden) if (item.from >= end) { ranges.push(Decoration.replace({}).range(item.from, item.to)); end = item.to; }
  return Decoration.set(ranges, true);
}

function createLiveField(context) {
  return StateField.define({
    create: state => liveDecorations(state, context),
    update: (value, transaction) => transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(refreshPreview)) ? liveDecorations(transaction.state, context) : value,
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
        apply(view, option, from, to) { const suffix = view.state.doc.sliceString(to, to + 2) === ']]' ? '' : ']]'; view.dispatch({changes: {from, to, insert: option.label + suffix}, selection: {anchor: from + option.label.length + suffix.length}}); },
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
  view.dispatch({changes: {from: start, to: oldEnd, insert: value.slice(start, newEnd)}, annotations: [externalUpdate.of(true)]});
}

export default function Editor({path = '', value = '', onChange, mode = 'live', onNavigate, resolveAsset, files = {}, onReady, commands = [], readOnly = false}) {
  const mount = useRef(null), preview = useRef(null), viewRef = useRef(null), states = useRef(new Map()), scrollPositions = useRef(new Map());
  const context = useRef({}); context.current = {path, value, onChange, onNavigate, resolveAsset, files, mode, onReady, commands, readOnly};
  const [hover, setHover] = useState(null), hoverTimer = useRef(null), hoverTarget = useRef(null);
  const currentPath = useRef(path), modeSlot = useRef(new Compartment()), readOnlySlot = useRef(new Compartment()), liveField = useRef(null);
  const html = useMemo(() => mode === 'reading' ? renderMarkdown(value, {path, files, rootPath: readOnly ? '__read_only__' : path}) : '', [value, path, files, mode, readOnly]);

  useEffect(() => {
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
      editorTheme, EditorView.lineWrapping, highlightSpecialChars(), history(), drawSelection(), dropCursor(), rectangularSelection(),
      indentOnInput(), markdown({extensions: [frontmatterExtension]}), syntaxHighlighting(markdownHighlight), closeBrackets(), autocompletion({override: [completionSource(context)]}),
      search({top: true}), highlightSelectionMatches(),
      keymap.of([{key: 'Mod-b', run: view => wrapSelection(view, '**')}, {key: 'Mod-i', run: view => wrapSelection(view, '*')}, {key: 'Mod-Shift-h', run: view => wrapSelection(view, '==')}, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, ...markdownKeymap, indentWithTab]),
      modeSlot.current.of(context.current.mode === 'live' ? [liveField.current] : [highlightActiveLine()]),
      readOnlySlot.current.of([EditorState.readOnly.of(context.current.readOnly), EditorView.editable.of(!context.current.readOnly)]),
      EditorView.contentAttributes.of({'aria-label': '笔记编辑器', spellcheck: 'false', 'data-testid': 'markdown-editor'}),
      EditorView.domEventHandlers({click: sourceClick}),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalUpdate))) context.current.onChange?.(update.state.doc.toString());
      }),
    ];
    const makeState = text => EditorState.create({doc: text, extensions});
    const view = new EditorView({state: makeState(context.current.value), parent: mount.current});
    viewRef.current = view; viewRef.current.makeState = makeState;
    const api = {
      focus: () => view.focus(),
      insert: text => { if (view.state.readOnly) return; view.dispatch(view.state.replaceSelection(String(text)), {scrollIntoView: true, userEvent: 'input'}); view.focus(); },
      replaceSelection: text => { if (view.state.readOnly) return; view.dispatch(view.state.replaceSelection(String(text)), {scrollIntoView: true, userEvent: 'input'}); view.focus(); },
      getSelection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
      getSelectionInfo: () => { const {from, to} = view.state.selection.main; return {text: view.state.sliceDoc(from, to), from, to}; },
      undo: () => !view.state.readOnly && undo(view), redo: () => !view.state.readOnly && redo(view), selectAll: () => selectAll(view), find: () => openSearchPanel(view), replace: () => openSearchPanel(view),
      scrollToLine: number => {
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
    };
    viewRef.current.api = api;
    context.current.onReady?.(api);
    return () => { context.current.onReady?.(null); view.destroy(); viewRef.current = null; };
  }, []);

  useEffect(() => {
    const view = viewRef.current; if (!view) return;
    let timer;
    if (currentPath.current !== path) {
      states.current.set(currentPath.current, view.state);
      scrollPositions.current.set(currentPath.current, view.scrollDOM.scrollTop);
      if (states.current.size > 30) { const oldest = states.current.keys().next().value; states.current.delete(oldest); scrollPositions.current.delete(oldest); }
      const cached = states.current.get(path);
      view.setState(cached || view.makeState(value));
      currentPath.current = path;
      view.dispatch({effects: [modeSlot.current.reconfigure(mode === 'live' ? [liveField.current] : [highlightActiveLine()]), readOnlySlot.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)])]});
      view.scrollDOM.scrollTop = scrollPositions.current.get(path) || 0;
    }
    const apply = () => { if (view.composing) timer = setTimeout(apply, 80); else if (currentPath.current === context.current.path) replaceFromOutside(view, context.current.value); };
    apply();
    return () => clearTimeout(timer);
  }, [path, value]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) { view.dispatch({effects: modeSlot.current.reconfigure(mode === 'live' ? [liveField.current] : [highlightActiveLine()])}); view.requestMeasure(); }
  }, [mode]);

  useEffect(() => { viewRef.current?.dispatch({effects: [readOnlySlot.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]), refreshPreview.of(null)]}); }, [readOnly]);

  useEffect(() => { const view = viewRef.current; if (view && mode === 'live' && !view.composing) view.dispatch({effects: refreshPreview.of(null)}); }, [files, resolveAsset]);

  useEffect(() => {
    if (mode === 'reading' && preview.current) hydrateMarkdown(preview.current, {resolveAsset});
  }, [html, mode, resolveAsset]);

  useEffect(() => { if (viewRef.current?.api) onReady?.(viewRef.current.api); }, [onReady]);

  useEffect(() => { clearTimeout(hoverTimer.current); hoverTarget.current = null; setHover(null); }, [path, mode]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const hideHover = () => { clearTimeout(hoverTimer.current); hoverTarget.current = null; hoverTimer.current = setTimeout(() => setHover(null), 150); };
  const inspectLink = event => {
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

  return <div className={`vault-editor mode-${mode}`} data-editor-mode={mode} onMouseOver={inspectLink} onMouseMove={inspectLink} onMouseLeave={hideHover}>
    <div ref={mount} className="codemirror-mount" hidden={mode === 'reading'} />
    {mode === 'reading' && <article ref={preview} className="markdown-rendered markdown-reading" aria-label="笔记阅读视图" tabIndex={0}
      onClick={event => handleRenderedClick(event, {...context.current, view: viewRef.current})}
      onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('callout-title')) { event.preventDefault(); event.target.click(); } }}
      dangerouslySetInnerHTML={{__html: html}} />}
    {hover && <aside className="link-preview" style={{left: hover.left, top: hover.top}} onMouseEnter={() => clearTimeout(hoverTimer.current)} onMouseLeave={hideHover} aria-label={`预览 ${hover.notePath}`}>
      <header><span>{hover.notePath.replace(/\.md$/i, '')}</span><button type="button" onClick={() => { onNavigate?.(hover.target); hideHover(); }}>打开 ↗</button></header>
      <div className="link-preview-text">{hover.text || '空白笔记'}</div>
    </aside>}
  </div>;
}
