import MarkdownIt from 'markdown-it';
import { parseMarkdown } from '../core/vault.mjs';

const parser = new MarkdownIt({ html: true });
const bodyOnly = text => String(text || '').replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, match => '\n'.repeat(match.split('\n').length - 1));
const noFinalNewline = value => String(value).replace(/\r?\n$/, '');

/** A render owns its children. Re-render, detach, disable and disposal revoke them. */
export function createPluginMarkdown({ Component, createElement, decorate, getSource, report, changed }) {
  const processors = new Set(), sessions = new Set(), byContainer = new WeakMap();
  let sequence = 0, documentId = 0;
  class MarkdownRenderChild extends Component {
    constructor(containerEl) { super(); this.containerEl = decorate(containerEl); }
  }
  async function cleanupOwned(session, owner) {
    const pending = [];
    for (const child of [...session.children]) if (!owner || child.owner === owner) { session.children.delete(child); pending.push(Promise.resolve().then(() => child.component.unload())); }
    for (const restore of [...session.restores]) if (!owner || restore.owner === owner) { session.restores.delete(restore); try { restore.run(); } catch (error) { report(error); } }
    const settled = await Promise.allSettled(pending);
    for (const result of settled) if (result.status === 'rejected') report(result.reason);
  }
  async function close(session) {
    if (session.closed) return session.cleanup;
    session.closed = true; sessions.delete(session);
    if (byContainer.get(session.container) === session) byContainer.delete(session.container);
    session.cleanup = cleanupOwned(session);
    return session.cleanup;
  }
  function forPlugin({ record, ensureActive, track }) {
    function register(kind, language, callback, sortOrder = 0) {
      ensureActive();
      if (typeof callback !== 'function') throw new TypeError('A Markdown processor callback is required');
      if (kind === 'code' && (typeof language !== 'string' || !language || /\s/.test(language))) throw new TypeError('A code block language without whitespace is required');
      if (!Number.isFinite(sortOrder)) throw new TypeError('Markdown processor order must be finite');
      const processor = kind === 'post' ? callback : (element, context) => callback(element.textContent || '', element, context);
      processor.sortOrder = sortOrder;
      const entry = { kind, language, callback, processor, record, ensureActive, order: sequence++ };
      processors.add(entry); changed();
      track(async () => { processors.delete(entry); changed(); await Promise.all([...sessions].map(session => cleanupOwned(session, record))); });
      return processor;
    }
    return {
      MarkdownRenderChild,
      registerMarkdownPostProcessor: (callback, sortOrder) => register('post', null, callback, sortOrder),
      registerMarkdownCodeBlockProcessor: (language, callback, sortOrder) => register('code', language, callback, sortOrder),
    };
  }

  async function process(container, options = {}) {
    if (!container?.querySelectorAll) throw new TypeError('Markdown processing requires a DOM container');
    if (byContainer.has(container)) await close(byContainer.get(container));
    const path = options.path || options.sourcePath || '', fragment = String(options.text ?? getSource(path) ?? ''), lineOffset = options.lineOffset || 0;
    const source = String(getSource(path) ?? fragment);
    const session = { container, children: new Set(), restores: new Set(), closed: false, cleanup: null };
    byContainer.set(container, session); sessions.add(session);
    const docId = `plugin-render-${++documentId}`;
    const tokens = parser.parse(bodyOnly(fragment), {}), maps = tokens.filter(token => token.map && (token.nesting === 1 || token.type === 'fence' || token.type === 'code_block'));
    const fences = tokens.filter(token => token.type === 'fence').map(token => ({ language: token.info.trim().split(/\s/)[0], source: noFinalNewline(token.content), range: { lineStart: token.map[0] + lineOffset, lineEnd: token.map[1] - 1 + lineOffset }, used: false }));
    const codeInfo = new WeakMap(), ranges = new WeakMap();
    for (const code of container.querySelectorAll('pre > code')) {
      const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || '';
      const text = noFinalNewline(code.textContent || '');
      const match = fences.find(fence => !fence.used && fence.language === language && fence.source === text);
      if (match) { match.used = true; codeInfo.set(code, match); ranges.set(code.parentElement, match.range); if (code.parentElement.parentElement?.classList.contains('code-block')) ranges.set(code.parentElement.parentElement, match.range); }
    }
    const sections = [...container.children].filter(element => !element.classList.contains('cm-widget-edit'));
    if (!sections.length) sections.push(container);
    function rangeOf(element, section) {
      if (options.virtual) return null;
      let node = element;
      while (node && node !== container.parentElement) {
        if (ranges.has(node)) return ranges.get(node);
        const start = Number(node.getAttribute?.('data-source-line')) - 1;
        if (Number.isInteger(start) && start >= 0) {
          const token = maps.find(token => token.map[0] + lineOffset === start);
          return { lineStart: start, lineEnd: token ? token.map[1] - 1 + lineOffset : start };
        }
        if (node === container) break;
        node = node.parentElement;
      }
      if (section && ranges.has(section)) return ranges.get(section);
      return null;
    }
    const sorted = [...processors].sort((left, right) => (Number(left.processor.sortOrder) || 0) - (Number(right.processor.sortOrder) || 0) || left.order - right.order);
    try {
      for (const section of sections) {
        decorate(section);
        for (const entry of sorted) {
          if (session.closed) break;
          if (!processors.has(entry) || entry.record.cancelled) continue;
          const ownedSourcePath = section.getAttribute?.('data-path') || path, ownedSource = String(getSource(ownedSourcePath) ?? source);
          const childLoads = [];
          const context = {
            docId, sourcePath: ownedSourcePath, frontmatter: structuredClone(parseMarkdown(ownedSource).frontmatter || {}),
            addChild(child) {
              if (!(child instanceof Component)) throw new TypeError('Markdown render children must extend Component');
              const owned = { owner: entry.record, component: child };
              const loading = Promise.resolve().then(() => session.closed || entry.record.cancelled || !processors.has(entry) ? child.unload() : child.load());
              // Observe rejection immediately, including when the processor
              // throws before its children have finished loading.
              loading.catch(() => {}); childLoads.push(loading);
              if (!session.closed && !entry.record.cancelled && processors.has(entry)) session.children.add(owned);
            },
            getSectionInfo(element) { const range = rangeOf(element, section); return range ? { text: ownedSource, ...range } : null; },
          };
          try {
            entry.ensureActive();
            if (entry.kind === 'post') await entry.callback(section, context);
            else {
              const candidates = section.matches?.('pre > code') ? [section] : [...section.querySelectorAll('pre > code')];
              for (const code of candidates) {
                const info = codeInfo.get(code), language = info?.language || [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
                if (language !== entry.language) continue;
                const original = code.parentElement, parent = original?.parentNode;
                if (!parent) continue;
                const replacement = createElement('div'); replacement.className = 'plugin-codeblock'; replacement.setAttribute('data-plugin-language', language);
                if (info) ranges.set(replacement, info.range);
                parent.replaceChild(replacement, original);
                const restore = { owner: entry.record, run: () => { if (replacement.parentNode) replacement.parentNode.replaceChild(original, replacement); } };
                session.restores.add(restore);
                try { await entry.callback(info?.source ?? noFinalNewline(code.textContent || ''), replacement, context); }
                catch (error) { restore.run(); session.restores.delete(restore); throw error; }
              }
            }
            await Promise.all(childLoads);
          } catch (error) { report(error); }
          finally { const results = await Promise.allSettled(childLoads); for (const result of results) if (result.status === 'rejected') report(result.reason); }
          if (entry.record.cancelled || !processors.has(entry)) await cleanupOwned(session, entry.record);
        }
      }
    } catch (error) { await close(session); throw error; }
    return () => close(session);
  }
  async function dispose() { processors.clear(); await Promise.all([...sessions].map(close)); }
  return { forPlugin, process, dispose, get size() { return processors.size; } };
}
