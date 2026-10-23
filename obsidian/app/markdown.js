import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import DOMPurify from 'dompurify';
import katex from 'katex';
import {normalizePath, resolveLink} from '../core/vault.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mediaPattern = /\.(png|jpe?g|gif|webp|svg|avif|bmp|mp3|wav|ogg|m4a|flac|mp4|webm|mov|pdf)$/i;
const withoutFrontmatter = text => String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, match => '\n'.repeat(match.split('\n').length - 1));
export const headingSlug = value => String(value).replace(/<[^>]*>/g, '').replace(/[*_`]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
const decodeMarkdownUrl = link => {
  const unescaped = String(link).replace(/\\([\\`*{}\[\]()#+.!_<>|~-])/g, '$1');
  try { return decodeURIComponent(unescaped); } catch { return unescaped; }
};
export function resolveDocumentPath(link, sourcePath = '', files = {}, syntax = 'wiki') {
  const target = (syntax === 'markdown' ? decodeMarkdownUrl(link) : String(link || '')).split('#')[0];
  if (!target) return sourcePath;
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const resolved = resolveLink(target, sourcePath, files);
  if (resolved) return resolved;
  const folder = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
  return normalizePath(/^\.\.?\//.test(target) ? folder + target : target);
}
export function navigateTarget(link, sourcePath = '', files = {}, syntax = 'wiki') {
  if (/^[a-z][a-z\d+.-]*:/i.test(String(link || '')) || String(link).startsWith('//')) return String(link);
  const raw = syntax === 'markdown' ? decodeMarkdownUrl(link) : String(link || '');
  const index = raw.indexOf('#');
  return `${resolveDocumentPath(raw, sourcePath, files) || raw}${index < 0 ? '' : raw.slice(index)}`;
}

function selectFragment(text, fragment) {
  if (!fragment) return text;
  const lines = text.split('\n');
  if (fragment.startsWith('^')) {
    const needle = fragment.slice(1);
    const index = lines.findIndex(line => line.match(/(?:^|\s)\^([\w-]+)\s*$/)?.[1] === needle);
    if (index < 0) return '';
    let start = index;
    if (lines[index].trim() === `^${needle}`) while (start > 0 && !lines[start - 1].trim()) start--;
    while (start > 0 && lines[start - 1].trim()) start--;
    return lines.slice(start, index + 1).join('\n').replace(/(?:^|\s)\^[\w-]+\s*$/, '');
  }
  const wanted = headingSlug(fragment);
  const start = lines.findIndex(line => headingSlug(line.replace(/^#{1,6}\s+/, '')) === wanted && /^#{1,6}\s/.test(line));
  if (start < 0) return '';
  const level = lines[start].match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length && !(new RegExp(`^#{1,${level}}\\s`)).test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

function assetMarkup(link, label, env, syntax = 'wiki') {
  if (syntax === 'markdown' && !/^https?:\/\//i.test(link)) link = decodeMarkdownUrl(link);
  const index = link.indexOf('#');
  const rawPath = index < 0 ? link : link.slice(0, index);
  const assetPath = resolveDocumentPath(rawPath, env.path, env.files) || rawPath;
  const external = /^https?:\/\//i.test(rawPath);
  const suffix = rawPath.split('.').pop().toLowerCase();
  const parts = String(label || '').split('|');
  const size = parts.at(-1)?.match(/^(\d{1,4})(?:x(\d{1,4}))?$/);
  const title = size ? parts.slice(0, -1).join('|') : label;
  const dimensions = size ? ` width="${Math.min(Number(size[1]), 2000)}"${size[2] ? ` height="${Math.min(Number(size[2]), 2000)}"` : ''}` : '';
  const location = external ? `src="${escape(rawPath)}"` : `data-asset-path="${escape(assetPath)}"`;
  if (/^(mp3|wav|ogg|m4a|flac)$/.test(suffix)) return `<audio controls preload="metadata" ${location} aria-label="${escape(title || rawPath)}"></audio>`;
  if (/^(mp4|webm|mov)$/.test(suffix)) return `<video controls preload="metadata" ${location}${dimensions} aria-label="${escape(title || rawPath)}"></video>`;
  if (suffix === 'pdf') {
    const fragment = index < 0 ? '' : link.slice(index);
    const page = fragment.match(/(?:^#|[&])page=(\d+)/)?.[1];
    return `<span class="pdf-embed"><a class="attachment-link" data-note-target="${escape(assetPath + fragment)}" href="#"><span>▧ ${escape(title || rawPath.split('/').pop())}</span><small>PDF${page ? ` · 第 ${Number(page)} 页` : ''} · 打开阅读器 ↗</small></a></span>`;
  }
  return `<img class="internal-embed" ${location} alt="${escape(title || rawPath.split('/').pop())}"${dimensions} loading="lazy" />`;
}

const md = new MarkdownIt({html: true, linkify: true, breaks: true, typographer: false}).use(footnote);
const footnoteOpen = md.renderer.rules.footnote_open;
md.renderer.rules.footnote_open = (tokens, idx, options, env, self) => footnoteOpen(tokens, idx, options, env, self).replace('<li ', `<li data-footnote-label="${escape(tokens[idx].meta.label || String(tokens[idx].meta.id + 1))}" data-path="${escape(env.path)}" `);

md.inline.ruler.before('emphasis', 'highlight', (state, silent) => {
  if (!state.src.startsWith('==', state.pos)) return false;
  const end = state.src.indexOf('==', state.pos + 2);
  if (end <= state.pos + 2 || state.src.slice(state.pos, end).includes('\n')) return false;
  if (!silent) { const token = state.push('html_inline', '', 0); token.content = `<mark>${escape(state.src.slice(state.pos + 2, end))}</mark>`; }
  state.pos = end + 2;
  return true;
});
md.inline.ruler.before('emphasis', 'vault_comment', (state, silent) => {
  if (!state.src.startsWith('%%', state.pos)) return false;
  const end = state.src.indexOf('%%', state.pos + 2);
  if (end < 0) return false;
  state.pos = end + 2;
  return true;
});

md.inline.ruler.before('link', 'wiki', (state, silent) => {
  const start = state.pos;
  const embed = state.src.startsWith('![[', start);
  if (!embed && !state.src.startsWith('[[', start)) return false;
  const end = state.src.indexOf(']]', start + (embed ? 3 : 2));
  if (end < 0 || state.src.slice(start, end).includes('\n')) return false;
  if (!silent) {
    const token = state.push(embed ? 'wiki_embed' : 'wiki_link', '', 0);
    const content = state.src.slice(start + (embed ? 3 : 2), end);
    const bar = content.indexOf('|');
    token.meta = {target: bar < 0 ? content : content.slice(0, bar), label: bar < 0 ? '' : content.slice(bar + 1)};
  }
  state.pos = end + 2;
  return true;
});
md.renderer.rules.wiki_link = (tokens, idx, options, env) => {
  const {target, label} = tokens[idx].meta;
  const destination = navigateTarget(target, env.path, env.files);
  const resolved = resolveDocumentPath(target, env.path, env.files);
  const missing = !Object.hasOwn(env.files || {}, resolved);
  return `<a class="internal-link${missing ? ' is-unresolved' : ''}" href="#" data-note-target="${escape(destination)}" title="${escape(target)}">${escape(label || target.split('/').pop())}</a>`;
};
md.renderer.rules.wiki_embed = (tokens, idx, options, env) => {
  const {target, label} = tokens[idx].meta;
  if (mediaPattern.test(target.split('#')[0]) || /^https?:\/\//i.test(target)) return assetMarkup(target, label, env);
  const resolved = resolveDocumentPath(target, env.path, env.files);
  const content = env.files?.[resolved];
  if (typeof content !== 'string') return `<span class="embed-missing">找不到嵌入笔记：${escape(target)}</span>`;
  if (env.stack.includes(resolved) || env.stack.length >= 5) return `<a class="embed-recursion" href="#" data-note-target="${escape(navigateTarget(target, env.path, env.files))}">↗ ${escape(label || target)} · 嵌入循环</a>`;
  const selected = selectFragment(content, target.split('#').slice(1).join('#'));
  const embedId = `embed-${++env.counter.embeds}`;
  const inner = md.render(withoutFrontmatter(selected), {...env, path: resolved, stack: [...env.stack, resolved], headingIds: new Map(), idPrefix: `${embedId}-`, docId: embedId, footnotes: undefined, references: undefined});
  return `<section class="note-embed"><a class="note-embed-title" href="#" data-note-target="${escape(navigateTarget(target, env.path, env.files))}">↗ ${escape(label || target.replace(/\.md$/, ''))}</a><div class="note-embed-content">${inner}</div></section>`;
};

md.inline.ruler.before('escape', 'inline_math', (state, silent) => {
  if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$' || /\s/.test(state.src[state.pos + 1] || ' ')) return false;
  let end = state.pos + 1;
  while ((end = state.src.indexOf('$', end)) >= 0 && state.src[end - 1] === '\\') end++;
  if (end < 0 || /\s/.test(state.src[end - 1]) || state.src.slice(state.pos, end).includes('\n')) return false;
  if (!silent) { const token = state.push('math_inline', '', 0); token.content = state.src.slice(state.pos + 1, end); }
  state.pos = end + 1;
  return true;
});
md.block.ruler.before('fence', 'display_math', (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const first = state.src.slice(start, state.eMarks[startLine]);
  if (!first.startsWith('$$')) return false;
  if (silent) return true;
  let content = first.slice(2), next = startLine + 1;
  if (content.endsWith('$$')) content = content.slice(0, -2);
  else {
    const chunks = [content];
    for (; next < endLine; next++) {
      const line = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
      if (line.trim().endsWith('$$')) { chunks.push(line.slice(0, line.lastIndexOf('$$'))); next++; break; }
      chunks.push(line);
    }
    content = chunks.join('\n');
  }
  const token = state.push('math_block', 'div', 0); token.content = content; token.map = [startLine, next];
  state.line = next;
  return true;
});
const math = (content, displayMode) => katex.renderToString(content, {displayMode, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml'});
md.renderer.rules.math_inline = (tokens, idx) => math(tokens[idx].content, false);
md.renderer.rules.math_block = (tokens, idx) => `<div class="math-block">${math(tokens[idx].content, true)}</div>\n`;
const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === 'mermaid') return `<div class="mermaid-block" data-mermaid="true">${escape(token.content)}</div>`;
  return `<div class="code-block"><span class="code-language">${escape(token.info.split(/\s/)[0])}</span>${fence(tokens, idx, options, env, self)}</div>`;
};

md.core.ruler.after('inline', 'vault_features', state => {
  const {tokens, env} = state;
  env.headingIds ||= new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.block && token.map && token.nesting === 1) { token.attrSet('data-source-line', String(token.map[0] + 1 + (env.lineOffset || 0))); token.attrSet('data-path', env.path); }
    if (token.type === 'heading_open') {
      const slug = headingSlug(tokens[i + 1].content);
      const count = env.headingIds.get(slug) || 0; env.headingIds.set(slug, count + 1);
      token.attrSet('id', `${env.idPrefix || ''}${count ? `${slug}-${count}` : slug}`);
      token.attrSet('data-heading', tokens[i + 1].content);
    }
    if (token.type === 'blockquote_open' && tokens[i + 2]?.type === 'inline') {
      const inline = tokens[i + 2];
      const marker = inline.content.match(/^\[!([\w-]+)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n|$)/);
      if (marker) {
        const type = marker[1].toLowerCase();
        token.attrSet('class', `callout callout-${type}`);
        token.attrSet('data-callout', type);
        if (marker[2]) token.attrSet('data-folded', marker[2] === '-' ? 'true' : 'false');
        const title = marker[3] || type.charAt(0).toUpperCase() + type.slice(1);
        const body = inline.content.slice(marker[0].length);
        const titleToken = new state.Token('html_inline', '', 0);
        titleToken.content = `<span class="callout-title"${marker[2] ? ' role="button" tabindex="0"' : ''}><span class="callout-icon">${/warn|caution/.test(type) ? '△' : /danger|error|bug/.test(type) ? '⊗' : /success|check/.test(type) ? '✓' : /question|faq/.test(type) ? '?' : /tip|hint/.test(type) ? '◇' : 'ⓘ'}</span>${escape(title)}${marker[2] ? '<span class="callout-fold">⌄</span>' : ''}</span>`;
        const remaining = []; if (body) md.inline.parse(body, state.md, env, remaining);
        if (body) { const br = new state.Token('html_inline', '', 0); br.content = '<span class="callout-first-body">'; remaining.unshift(br); const end = new state.Token('html_inline', '', 0); end.content = '</span>'; remaining.push(end); }
        inline.children = [titleToken, ...remaining];
      }
    }
    if (token.type === 'inline') {
      const prev = tokens[i - 1], before = tokens[i - 2];
      const match = token.content.match(/^\[([ xX])\][ \t]+/);
      if (match && prev?.type === 'paragraph_open' && before?.type === 'list_item_open') {
        before.attrJoin('class', `task-list-item${match[1] !== ' ' ? ' is-checked' : ''}`);
        const firstText = token.children.find(child => child.type === 'text');
        if (firstText) firstText.content = firstText.content.replace(/^\[([ xX])\][ \t]+/, '');
        const checkbox = new state.Token('html_inline', '', 0);
        checkbox.content = `<input class="task-checkbox" type="checkbox" data-line="${(prev.map?.[0] ?? before.map?.[0] ?? 0) + (env.lineOffset || 0)}" data-path="${escape(env.path)}"${match[1] !== ' ' ? ' checked' : ''}${env.path !== env.rootPath ? ' disabled' : ''} aria-label="切换任务状态" />`;
        token.children.unshift(checkbox);
      }
      const lastText = token.children?.at(-1);
      const blockId = lastText?.type === 'text' && lastText.content.match(/(?:^|\s)\^([\w-]+)\s*$/);
      if (blockId) { lastText.content = lastText.content.slice(0, blockId.index); const owner = prev?.hidden && before?.type === 'list_item_open' ? before : prev; owner?.attrSet('id', `${env.idPrefix || ''}^${blockId[1]}`); }
    }
  }
});

const linkOpen = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx], href = token.attrGet('href') || '';
  if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//') && !href.startsWith('#fn')) {
    token.attrSet('data-note-target', navigateTarget(href, env.path, env.files, 'markdown')); token.attrJoin('class', 'internal-link');
  } else { token.attrSet('rel', 'noopener noreferrer'); token.attrSet('target', '_blank'); }
  return linkOpen(tokens, idx, options, env, self);
};
md.renderer.rules.image = (tokens, idx, options, env) => {
  const token = tokens[idx];
  return assetMarkup(token.attrGet('src') || '', token.content || token.attrGet('alt'), env, 'markdown');
};

export function renderMarkdown(text, {path = '', files = {}, rootPath = path, lineOffset = 0} = {}) {
  // Front matter is edited through the source editor or the properties panel.
  const source = withoutFrontmatter(text);
  const html = md.render(source, {path, files, rootPath, lineOffset, stack: [path], headingIds: new Map(), counter: {embeds: 0}});
  return DOMPurify.sanitize(html, {USE_PROFILES: {html: true, svg: true, mathMl: true}, ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form'], FORBID_ATTR: ['srcdoc']});
}

let mermaidPromise;
let diagramNumber = 0;
export async function hydrateMarkdown(container, {resolveAsset} = {}) {
  const jobs = [];
  for (const element of container.querySelectorAll('[data-asset-path]')) {
    const path = element.dataset.assetPath;
    if (!resolveAsset) continue;
    jobs.push(Promise.resolve(resolveAsset(path)).then(url => { if (url && element.isConnected) { element.src = url; element.removeAttribute('data-asset-path'); } }).catch(() => { element.classList.add('asset-missing'); element.title = `无法加载：${path}`; }));
  }
  const diagrams = [...container.querySelectorAll('[data-mermaid]')];
  if (diagrams.length) {
    mermaidPromise ||= import('mermaid').then(module => { module.default.initialize({startOnLoad: false, securityLevel: 'strict', theme: 'dark', htmlLabels: false, flowchart: {htmlLabels: false}, suppressErrorRendering: true}); return module.default; });
    jobs.push(mermaidPromise.then(async mermaid => {
      for (const block of diagrams) {
        if (!block.isConnected) continue;
        const source = block.textContent;
        try { const result = await mermaid.render(`vault-diagram-${++diagramNumber}`, source); if (block.isConnected) { block.innerHTML = DOMPurify.sanitize(result.svg, {USE_PROFILES: {svg: true, svgFilters: true}, FORBID_TAGS: ['foreignObject']}); block.removeAttribute('data-mermaid'); } }
        catch { if (block.isConnected) { block.classList.add('mermaid-error'); block.textContent = `Mermaid 图表语法错误\n${source}`; } }
      }
    }));
  }
  await Promise.allSettled(jobs);
}
