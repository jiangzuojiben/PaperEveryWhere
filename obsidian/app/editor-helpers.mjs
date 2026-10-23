import {syntaxTree} from '@codemirror/language';

const wordPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;

export function selectionInfo(state) {
  const {from, to} = state.selection.main;
  const parts = state.selection.ranges.filter(range => !range.empty).map(range => state.sliceDoc(range.from, range.to));
  const text = parts.join('\n');
  return {from, to, text, characters: parts.reduce((count, part) => count + Array.from(part).length, 0), words: (text.match(wordPattern) || []).length, ranges: state.selection.ranges.length};
}

// A pane may still show the previous document while its IME composition settles.
// Only a selection belonging to this exact document can replace its text.
export function validateSelectedSpan(selection, path, text) {
  if (!selection || selection.path !== path || typeof text !== 'string') return false;
  const {from, to} = selection;
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to <= text.length && typeof selection.text === 'string' && selection.text === text.slice(from, to);
}

// The Markdown tree owns standard syntax. Regexes are only used for our small
// extensions, and never inside code, escaped characters, or link destinations.
export function inlinePreviewRanges(state) {
  const hidden = [], marks = [], links = [], blocked = [], candidates = [];
  const tree = syntaxTree(state);
  tree.iterate({enter(node) {
    const {from, to, name} = node;
    if (/^(FencedCode|CodeBlock|HTMLBlock|HTMLTag|CommentBlock|ProcessingInstructionBlock|Escape|Image)$/.test(name)) { blocked.push({from, to}); return false; }
    if (name === 'InlineCode') {
      const first = node.node.firstChild, last = node.node.lastChild;
      blocked.push({from, to});
      if (first?.name === 'CodeMark' && last?.name === 'CodeMark' && first !== last) candidates.push({from, to, start: first.to, end: last.from, className: 'cm-live-code'});
      return false;
    }
    const className = {StrongEmphasis: 'cm-live-bold', Emphasis: 'cm-live-italic', Strikethrough: 'cm-live-strike'}[name];
    if (className) {
      const first = node.node.firstChild, last = node.node.lastChild;
      if (first && last) candidates.push({from, to, start: first.to, end: last.from, className});
    }
    if (name === 'Link') {
      const children = [];
      for (let child = node.node.firstChild; child; child = child.nextSibling) children.push(child);
      const url = children.find(child => child.name === 'URL');
      const brackets = children.filter(child => child.name === 'LinkMark' && /[[\]]/.test(state.sliceDoc(child.from, child.to)));
      if (url && brackets.length >= 2) {
        blocked.push({from: url.from, to});
        links.push({from, to, start: brackets[0].to, end: brackets[1].from, target: state.sliceDoc(url.from, url.to).replace(/^<|>$/g, ''), syntax: 'markdown'});
      }
    }
  }});
  const overlaps = (from, to, ranges = blocked) => ranges.some(range => from < range.to && to > range.from);
  const escaped = pos => { let count = 0; while (pos > 0 && state.sliceDoc(--pos, pos + 1) === '\\') count++; return count % 2 === 1; };
  const custom = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    for (const match of line.text.matchAll(/!?\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]|%%([^\n]*?)%%|==([^=\n]+)==/g)) {
      const from = line.from + match.index, to = from + match[0].length;
      if (escaped(from) || overlaps(from, to)) continue;
      if (match[0].startsWith('![[')) { custom.push({from, to}); continue; }
      if (match[1] != null) {
        const start = from + (match[2] != null ? match[0].indexOf('|') + 1 : 2), end = to - 2;
        links.push({from, to, start, end, target: match[1], syntax: 'wiki'});
      } else if (match[3] != null) hidden.push({from, to});
      else { hidden.push({from, to: from + 2}, {from: to - 2, to}); marks.push({from: from + 2, to: to - 2, className: 'cm-live-highlight'}); }
      custom.push({from, to});
    }
    for (const match of line.text.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]+)/gu)) {
      const from = line.from + match.index + match[1].length, to = line.from + match.index + match[0].length;
      if (!overlaps(from, to) && !overlaps(from, to, custom)) marks.push({from, to, className: 'cm-live-tag'});
    }
  }
  for (const item of candidates) {
    if (overlaps(item.from, item.to, custom)) continue;
    const scope = {scopeFrom: item.from, scopeTo: item.to};
    hidden.push({from: item.from, to: item.start, ...scope}, {from: item.end, to: item.to, ...scope});
    marks.push({from: item.start, to: item.end, className: item.className, ...scope});
  }
  for (const link of links) {
    const scope = {scopeFrom: link.from, scopeTo: link.to};
    hidden.push({from: link.from, to: link.start, ...scope}, {from: link.end, to: link.to, ...scope});
    marks.push({from: link.start, to: link.end, className: 'cm-live-link', target: link.target, syntax: link.syntax, ...scope});
  }
  return {hidden, marks};
}
