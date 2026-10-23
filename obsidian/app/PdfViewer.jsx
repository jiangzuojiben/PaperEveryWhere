import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, FileText, Link2, List, LoaderCircle, Minus, Plus, RotateCw, Search, X } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, PasswordResponses, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { buildPdfText, findPdfMatches, matchSegments, parsePdfPage, pdfReference } from './pdf-model.mjs';
import './pdf.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Vite emits every required PDF library resource locally, with hashed filenames.
// No CDN or network font dependency is introduced by opening a local document.
const cMaps = import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, query: '?url', import: 'default' });
const standardFonts = import.meta.glob('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { eager: true, query: '?url', import: 'default' });
const decoderData = import.meta.glob('/node_modules/pdfjs-dist/wasm/*.{wasm,js}', { eager: true, query: '?url', import: 'default' });
const resourceMaps = Object.fromEntries(Object.entries({ cMapUrl: cMaps, standardFontDataUrl: standardFonts, wasmUrl: decoderData })
  .map(([kind, values]) => [kind, new Map(Object.entries(values).map(([file, url]) => [file.split('/').pop(), url]))]));

async function readBytes(url, signal) {
  const absolute = new URL(url, document.baseURI).href;
  if (absolute.startsWith('file:')) {
    // Electron's renderer permits local XHR while Fetch does not support file:.
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('GET', absolute);
      request.responseType = 'arraybuffer';
      const abort = () => { request.abort(); reject(new DOMException('Aborted', 'AbortError')); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      request.onload = () => {
        signal?.removeEventListener('abort', abort);
        if ((request.status === 0 || request.status >= 200 && request.status < 300) && request.response) resolve(new Uint8Array(request.response));
        else reject(new Error(`无法读取 PDF 资源 (${request.status})`));
      };
      request.onerror = () => { signal?.removeEventListener('abort', abort); reject(new Error('无法读取本地 PDF 资源')); };
      request.send();
    });
  }
  const response = await fetch(absolute, { signal });
  if (!response.ok) throw new Error(`无法读取 PDF (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

class BundledBinaryDataFactory {
  async fetch({ kind, filename }) {
    const url = resourceMaps[kind]?.get(filename);
    if (!url) throw new Error(`缺少本地 PDF 资源：${filename}`);
    return readBytes(url);
  }
}

const isCanceled = error => error?.name === 'RenderingCancelledException' || error?.name === 'AbortException' || error?.name === 'AbortError';
const basename = path => String(path || '').split(/[\\/]/).pop();

async function pageText(pdf, number, cache) {
  if (!cache.has(number)) cache.set(number, pdf.getPage(number).then(async page => {
    const content = await page.getTextContent({ includeMarkedContent: true });
    return { content, model: buildPdfText(content.items) };
  }));
  return cache.get(number);
}

function Tool({ title, children, active = false, ...props }) {
  return <button type="button" className={`vd-pdf-tool${active ? ' active' : ''}`} title={title} aria-label={title} {...props}>{children}</button>;
}

function OutlineItems({ items, onOpen, depth = 0 }) {
  return <ul>{items.map((item, index) => <li key={`${depth}-${index}`}>
    <button type="button" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => onOpen(item)} title={item.title}>{item.items?.length ? <ChevronDown size={13}/> : <span className="vd-pdf-outline-dot"/>}<span>{item.title || '未命名章节'}</span></button>
    {!!item.items?.length && <OutlineItems items={item.items} onOpen={onOpen} depth={depth + 1}/>}</li>)}</ul>;
}

function PdfPage({ pdf, number, zoom, rotation, width, textCache, matches, selectedMatch, onDestination, onSelection, onRendered }) {
  const host = useRef(null);
  const layerState = useRef(null);
  const [rendered, setRendered] = useState(0);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState('');
  const [size, setSize] = useState({ width: 600, height: 800 });
  const callbacks = useRef({ onDestination, onSelection, onRendered });
  callbacks.current = { onDestination, onSelection, onRendered };

  useEffect(() => {
    let canceled = false;
    let renderTask;
    let textLayer;
    const pageRoot = host.current;
    setRendering(true); setError(''); layerState.current = null;
    pageRoot.replaceChildren();
    (async () => {
      const page = await pdf.getPage(number);
      if (canceled) return;
      const angle = (page.rotate + rotation) % 360;
      const baseViewport = page.getViewport({ scale: 1, rotation: angle });
      const scale = zoom === 'fit' ? Math.max(0.1, (width - 48) / baseViewport.width) : zoom * 96 / 72;
      const viewport = page.getViewport({ scale, rotation: angle });
      setSize({ width: viewport.width, height: viewport.height });
      pageRoot.style.setProperty('--scale-factor', viewport.scale);
      pageRoot.style.setProperty('--user-unit', viewport.userUnit || 1);
      pageRoot.style.setProperty('--total-scale-factor', viewport.scale * (viewport.userUnit || 1));
      const canvas = document.createElement('canvas');
      canvas.className = 'vd-pdf-canvas';
      canvas.setAttribute('aria-label', `PDF 第 ${number} 页`);
      const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(20_000_000 / (viewport.width * viewport.height)));
      canvas.width = Math.max(1, Math.ceil(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.ceil(viewport.height * outputScale));
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      const textContainer = document.createElement('div'); textContainer.className = 'textLayer';
      const highlights = document.createElement('div'); highlights.className = 'vd-pdf-highlights'; highlights.setAttribute('aria-hidden', 'true');
      const links = document.createElement('div'); links.className = 'vd-pdf-links';
      pageRoot.append(canvas, textContainer, highlights, links);
      renderTask = page.render({ canvas, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
      const renderPromise = renderTask.promise;
      // Cleanup can cancel rendering while text extraction is still pending.
      // Attach a handler immediately; Promise.all below still reports real errors.
      renderPromise.catch(() => {});
      const data = await pageText(pdf, number, textCache);
      if (canceled) return;
      textLayer = new TextLayer({ textContentSource: data.content, container: textContainer, viewport });
      await Promise.all([renderPromise, textLayer.render()]);
      if (canceled) return;
      layerState.current = { textLayer, model: data.model, highlights, container: textContainer };
      setRendered(value => value + 1); setRendering(false);
      callbacks.current.onRendered?.(number);
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (canceled) return;
      for (const annotation of annotations) {
        if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect) || !annotation.url && !annotation.dest) continue;
        const rect = viewport.convertToViewportRectangle(annotation.rect);
        const anchor = document.createElement('button');
        anchor.type = 'button'; anchor.className = 'vd-pdf-annotation-link';
        anchor.title = annotation.url || '跳转到文内位置'; anchor.setAttribute('aria-label', anchor.title);
        Object.assign(anchor.style, { left: `${Math.min(rect[0], rect[2])}px`, top: `${Math.min(rect[1], rect[3])}px`, width: `${Math.abs(rect[2] - rect[0])}px`, height: `${Math.abs(rect[3] - rect[1])}px` });
        anchor.addEventListener('click', () => callbacks.current.onDestination?.(annotation));
        links.append(anchor);
      }
    })().catch(reason => { if (!canceled && !isCanceled(reason)) { setError(reason.message || String(reason)); setRendering(false); } });
    return () => { canceled = true; renderTask?.cancel(); textLayer?.cancel(); layerState.current = null; pageRoot.replaceChildren(); };
  }, [pdf, number, zoom, rotation, width, textCache]);

  useLayoutEffect(() => {
    const state = layerState.current;
    if (!state) return;
    state.highlights.replaceChildren();
    const pageBounds = state.container.getBoundingClientRect();
    let selected;
    for (const match of matches) {
      for (const segment of matchSegments(state.model.segments, match)) {
        const span = state.textLayer.textDivs[segment.index];
        if (!span?.firstChild || segment.start === segment.end) continue;
        const range = document.createRange();
        range.setStart(span.firstChild, segment.start); range.setEnd(span.firstChild, segment.end);
        for (const rectangle of range.getClientRects()) {
          const highlight = document.createElement('div');
          highlight.className = `vd-pdf-highlight${match.id === selectedMatch ? ' selected' : ''}`;
          Object.assign(highlight.style, { left: `${rectangle.left - pageBounds.left}px`, top: `${rectangle.top - pageBounds.top}px`, width: `${rectangle.width}px`, height: `${rectangle.height}px` });
          state.highlights.append(highlight);
          if (match.id === selectedMatch) selected ||= highlight;
        }
      }
    }
    selected?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [rendered, matches, selectedMatch]);

  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      const inside = selection?.rangeCount && host.current?.contains(selection.anchorNode) && host.current?.contains(selection.focusNode);
      callbacks.current.onSelection?.(inside ? selection.toString().trim() : '');
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  return <div className="vd-pdf-page-wrap" style={{ width: size.width, minHeight: size.height }}>
    <div ref={host} className="vd-pdf-page" style={{ width: size.width, height: size.height }} data-page-number={number}/>
    {rendering && <div className="vd-pdf-page-status"><LoaderCircle className="vd-pdf-spin" size={22}/><span>渲染第 {number} 页…</span></div>}
    {error && <div className="vd-pdf-page-status error">{error}</div>}
  </div>;
}

export default function PdfViewer({ path = '', url, initialPage, navigationKey, onNavigate, onCopyReference }) {
  const [pdf, setPdf] = useState(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [page, setPage] = useState(() => parsePdfPage(initialPage ?? url));
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState('fit');
  const [rotation, setRotation] = useState(0);
  const [outline, setOutline] = useState([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [selectedMatch, setSelectedMatch] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [selection, setSelection] = useState('');
  const [notice, setNotice] = useState('');
  const [passwordNeeded, setPasswordNeeded] = useState('');
  const [password, setPassword] = useState('');
  const [width, setWidth] = useState(900);
  const stage = useRef(null);
  const searchInput = useRef(null);
  const passwordCallback = useRef(null);
  const textCache = useRef(new Map());
  const callbacks = useRef({ onNavigate, onCopyReference });
  callbacks.current = { onNavigate, onCopyReference };
  const currentPage = useRef(page); currentPage.current = page;

  useEffect(() => {
    let current = true;
    let task;
    const abort = new AbortController();
    const cache = new Map(); textCache.current = cache;
    setPdf(null); setError(''); setOutline([]); setProgress(0); setMatches([]); setSelectedMatch(-1); setSelection(''); setPasswordNeeded(''); setPassword('');
    if (!url) { setError('PDF 地址不可用'); return; }
    (async () => {
      const bytes = await readBytes(String(url).split('#')[0], abort.signal);
      if (!current) return;
      task = getDocument({ data: bytes, useWorkerFetch: false, BinaryDataFactory: BundledBinaryDataFactory, cMapPacked: true, useWasm: true, isEvalSupported: false, stopAtErrors: true, enableXfa: false });
      task.onProgress = ({ loaded, total }) => { if (current && total) setProgress(Math.round(loaded / total * 100)); };
      task.onPassword = (updatePassword, reason) => {
        if (!current) return;
        passwordCallback.current = updatePassword;
        setPasswordNeeded(reason === PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重试。' : '此 PDF 需要密码。');
      };
      const document = await task.promise;
      if (!current) { await document.destroy(); return; }
      setPdf(document); setPasswordNeeded(''); setPage(parsePdfPage(initialPage ?? url, document.numPages));
      document.getOutline().then(items => { if (current) setOutline(items || []); }).catch(() => {});
    })().catch(reason => { if (current && !isCanceled(reason)) setError(reason.message || String(reason)); });
    return () => { current = false; abort.abort(); passwordCallback.current = null; cache.clear(); task?.destroy().catch(() => {}); };
  }, [url, path]);

  useEffect(() => { if (pdf && initialPage != null) setPage(parsePdfPage(initialPage, pdf.numPages)); }, [initialPage, navigationKey, pdf]);
  useEffect(() => { setPageInput(String(page)); setSelection(''); if (stage.current) stage.current.scrollTop = 0; }, [page]);
  useEffect(() => { if (!stage.current) return; const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width))); observer.observe(stage.current); return () => observer.disconnect(); }, [pdf, outlineOpen]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2800); return () => clearTimeout(timer); }, [notice]);

  useEffect(() => {
    let current = true;
    setMatches([]); setSelectedMatch(-1);
    if (!pdf || !query.trim()) { setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = [];
        const cache = textCache.current;
        for (let number = 1; number <= pdf.numPages; number++) {
          const { model } = await pageText(pdf, number, cache);
          if (!current) return;
          for (const match of findPdfMatches(model.text, query)) found.push({ ...match, page: number, id: found.length });
          if (number % 12 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (!current) return;
        setMatches(found); setSearching(false);
        if (found.length) { const closest = found.findIndex(match => match.page >= currentPage.current); const index = closest < 0 ? 0 : closest; setSelectedMatch(index); setPage(found[index].page); }
      } catch (reason) { if (current && !isCanceled(reason)) { setSearching(false); setNotice(`搜索失败：${reason.message}`); } }
    }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [query, pdf]);

  const goToPage = useCallback(value => { if (pdf) setPage(parsePdfPage(value, pdf.numPages)); }, [pdf]);
  const searchNext = useCallback(direction => {
    if (!matches.length) return;
    const next = (selectedMatch + direction + matches.length) % matches.length;
    setSelectedMatch(next); setPage(matches[next].page);
  }, [matches, selectedMatch]);

  const openDestination = useCallback(async item => {
    try {
      if (item.url) {
        if (!/^(?:https?:|mailto:)/i.test(item.url)) return;
        if (callbacks.current.onNavigate) await callbacks.current.onNavigate(item.url);
        else if (window.vaultdesk?.openExternal) await window.vaultdesk.openExternal(item.url);
        else window.open(item.url, '_blank', 'noopener,noreferrer');
        return;
      }
      const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      if (!Array.isArray(destination)) return;
      const reference = destination[0];
      const index = typeof reference === 'number' ? reference : await pdf.getPageIndex(reference);
      goToPage(index + 1);
    } catch (reason) { setNotice(`无法跳转：${reason.message}`); }
  }, [pdf, goToPage]);

  const copy = async kind => {
    try {
      const selected = selection;
      const value = kind === 'text' ? selected : pdfReference({ path, page, text: kind === 'selection' ? selected : '' });
      if (kind !== 'text' && callbacks.current.onCopyReference) await callbacks.current.onCopyReference({ path, page, text: kind === 'selection' ? selected : '' });
      else if (window.vaultdesk?.writeClipboard) await window.vaultdesk.writeClipboard(value);
      else await navigator.clipboard.writeText(value);
      setNotice(kind === 'text' ? '已复制选中文字' : '已复制 PDF 引用');
    } catch (reason) { setNotice(`复制失败：${reason.message}`); }
  };

  const pageMatches = useMemo(() => matches.filter(match => match.page === page), [matches, page]);
  const zoomBy = direction => setZoom(value => Math.max(0.25, Math.min(4, Math.round((typeof value === 'number' ? value : 1) * (direction > 0 ? 1.2 : 1 / 1.2) * 100) / 100)));
  const keyboard = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); setSearchOpen(true); searchInput.current?.focus(); return; }
    if (event.key === 'Escape' && searchOpen) { event.preventDefault(); event.stopPropagation(); setSearchOpen(false); setQuery(''); event.currentTarget.focus(); return; }
    if (/^(?:INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
    if (event.key === 'PageDown' || event.key === 'ArrowRight') { event.preventDefault(); goToPage(page + 1); }
    if (event.key === 'PageUp' || event.key === 'ArrowLeft') { event.preventDefault(); goToPage(page - 1); }
    if (event.key === 'Home') { event.preventDefault(); goToPage(1); }
    if (event.key === 'End') { event.preventDefault(); goToPage(pdf?.numPages); }
  };

  return <section className="vd-pdf-reader" aria-label={`PDF 阅读器 ${basename(path)}`} tabIndex={0} onKeyDown={keyboard}>
    <div className="vd-pdf-toolbar">
      <Tool title="PDF 大纲" active={outlineOpen} disabled={!pdf} onClick={() => setOutlineOpen(value => !value)}><List size={17}/></Tool>
      <span className="vd-pdf-divider"/>
      <Tool title="上一页" disabled={!pdf || page <= 1} onClick={() => goToPage(page - 1)}><ChevronLeft size={17}/></Tool>
      <form className="vd-pdf-page-control" onSubmit={event => { event.preventDefault(); goToPage(pageInput); }}><input aria-label="PDF 页码" inputMode="numeric" value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value)} onBlur={() => { goToPage(pageInput); setPageInput(String(parsePdfPage(pageInput, pdf?.numPages))); }}/><span>/ {pdf?.numPages || '—'}</span></form>
      <Tool title="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => goToPage(page + 1)}><ChevronRight size={17}/></Tool>
      <span className="vd-pdf-divider"/>
      <Tool title="缩小" disabled={!pdf} onClick={() => zoomBy(-1)}><Minus size={16}/></Tool>
      <select aria-label="PDF 缩放" value={zoom} disabled={!pdf} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}><option value="fit">适合宽度</option>{[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(zoom) || zoom === 'fit' ? null : <option value={zoom}>{Math.round(zoom * 100)}%</option>}{[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(value => <option value={value} key={value}>{Math.round(value * 100)}%</option>)}</select>
      <Tool title="放大" disabled={!pdf} onClick={() => zoomBy(1)}><Plus size={16}/></Tool>
      <Tool title="顺时针旋转" disabled={!pdf} onClick={() => setRotation(value => (value + 90) % 360)}><RotateCw size={15}/></Tool>
      <span className="vd-pdf-toolbar-space"/>
      <Tool title="在 PDF 中搜索" active={searchOpen} disabled={!pdf} onClick={() => setSearchOpen(value => !value)}><Search size={16}/></Tool>
      <Tool title="复制页面引用" disabled={!pdf} onMouseDown={event => event.preventDefault()} onClick={() => copy('page')}><Link2 size={16}/></Tool>
    </div>
    {searchOpen && <div className="vd-pdf-search"><Search size={15}/><input ref={searchInput} aria-label="搜索 PDF 文本" placeholder="在文档中搜索…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); searchNext(event.shiftKey ? -1 : 1); } }}/><span aria-live="polite">{searching ? '搜索中…' : query ? `${matches.length ? selectedMatch + 1 : 0} / ${matches.length}` : ''}</span><Tool title="上一个匹配" disabled={!matches.length} onClick={() => searchNext(-1)}><ChevronUp size={15}/></Tool><Tool title="下一个匹配" disabled={!matches.length} onClick={() => searchNext(1)}><ChevronDown size={15}/></Tool><Tool title="关闭 PDF 搜索" onClick={() => { setSearchOpen(false); setQuery(''); }}><X size={15}/></Tool></div>}
    <div className="vd-pdf-body">
      {outlineOpen && <aside className="vd-pdf-outline"><h3>文档大纲</h3>{outline.length ? <OutlineItems items={outline} onOpen={openDestination}/> : <p>此文档未提供大纲。</p>}</aside>}
      <div className="vd-pdf-stage" ref={stage}>
        {pdf ? <PdfPage pdf={pdf} number={page} zoom={zoom} rotation={rotation} width={width} textCache={textCache.current} matches={pageMatches} selectedMatch={selectedMatch} onDestination={openDestination} onSelection={setSelection}/> : <div className={`vd-pdf-loading${error ? ' error' : ''}`}>
          {error ? <><FileText size={36}/><b>无法打开 PDF</b><p>{error}</p></> : passwordNeeded ? <form onSubmit={event => { event.preventDefault(); passwordCallback.current?.(password); setPassword(''); }}><FileText size={32}/><p>{passwordNeeded}</p><input aria-label="PDF 密码" type="password" autoFocus value={password} onChange={event => setPassword(event.target.value)}/><button type="submit">解锁 PDF</button></form> : <><LoaderCircle size={28} className="vd-pdf-spin"/><span>正在打开 PDF{progress ? ` · ${progress}%` : '…'}</span></>}
        </div>}
      </div>
    </div>
    <footer className="vd-pdf-footer"><span title={path}>{basename(path)}</span><span>{pdf ? `第 ${page} 页 · 共 ${pdf.numPages} 页` : ''}</span></footer>
    {!!selection && <div className="vd-pdf-selection-actions" role="toolbar" aria-label="PDF 选中文字操作" onMouseDown={event => event.preventDefault()}><span>已选择 {selection.length} 字</span><button type="button" onClick={() => copy('text')}><Copy size={14}/>复制文字</button><button type="button" onClick={() => copy('selection')}><Link2 size={14}/>复制引用</button></div>}
    {notice && <div className="vd-pdf-notice" role="status">{notice}</div>}
  </section>;
}
