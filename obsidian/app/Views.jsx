import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Network, Search, Plus, Minus, Maximize, X, Settings2, FileText, Link2, Type, Square, Trash2, Code2, Table2, ArrowDown, ArrowUp, GripVertical, ExternalLink, Check, AlertCircle, CornerDownRight } from 'lucide-react';
import { basename, graphData, layoutGraph, parseCanvas, canvasAnchor, canvasColor, makeId, parseBase, serializeBase, baseRecords, propertyValue, matchesBaseFilter, displayValue, frontmatterDocument, writeFrontmatter } from './views-model.mjs';
import { renderMarkdown, hydrateMarkdown } from './markdown.js';
import 'katex/dist/katex.min.css';
import './views.css';

const IconButton = ({ label, children, ...props }) => <button type="button" className="vd-icon-button" title={label} aria-label={label} {...props}>{children}</button>;
const Empty = ({ children }) => <div className="vd-view-empty">{children}</div>;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const safeUrl = value => { try { const url = new URL(value); return /^(https?:|mailto:)$/.test(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };
const safeAssetUrl = value => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (['http:', 'https:', 'blob:'].includes(url.protocol)) return url.href;
    if (url.protocol === 'vaultdesk-asset:' && url.hostname && !url.search && !url.hash) return url.href;
    if (/^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);base64,[a-z0-9+/=\s]+$/i.test(value)) return value;
  } catch { /* Only URLs returned by the host resolver may be embedded. */ }
  return null;
};
const graphFrame = (positions, size) => {
  const nodes = [...positions.values()]; if (!nodes.length) return { x: 0, y: 0, zoom: 1 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of nodes) { minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x); minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y); }
  const zoom = clamp(Math.min((size.width - 180) / (maxX - minX + 180), (size.height - 150) / (maxY - minY + 150)), .08, 1.5);
  return { x: -(minX + maxX) / 2 * zoom, y: -(minY + maxY) / 2 * zoom, zoom };
};

export function GraphView({ files = {}, onOpen, activePath, local = false }) {
  const [isLocal, setLocal] = useState(local), [query, setQuery] = useState(''), [depth, setDepth] = useState(1);
  const [focusPath, setFocusPath] = useState(activePath && Object.hasOwn(files, activePath) ? activePath : Object.keys(files).find(path => /\.md$/i.test(path)) || '');
  const [attachments, setAttachments] = useState(false), [unresolved, setUnresolved] = useState(true), [orphans, setOrphans] = useState(true);
  const [controls, setControls] = useState(true), [hover, setHover] = useState(null), [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [positions, setPositions] = useState(new Map());
  const rootRef = useRef(null), drag = useRef(null);
  useEffect(() => setLocal(local), [local]);
  useEffect(() => { if (activePath && Object.hasOwn(files, activePath)) setFocusPath(activePath); else if (!Object.hasOwn(files, focusPath)) setFocusPath(Object.keys(files).find(path => /\.md$/i.test(path)) || ''); }, [activePath, files]);
  const graph = useMemo(() => graphData(files, { query, activePath: focusPath, local: isLocal, depth, attachments, unresolved, orphans }), [files, query, focusPath, isLocal, depth, attachments, unresolved, orphans]);
  useEffect(() => { const next = layoutGraph(graph.nodes, graph.edges); setPositions(next); setView(graphFrame(next, size)); }, [graph, size]);
  useEffect(() => { const el = rootRef.current; if (!el) return; const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(el); return () => observer.disconnect(); }, []);
  const fit = () => setView(graphFrame(positions, size));
  const wheel = event => {
    event.preventDefault(); const rect = rootRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left - size.width / 2, y = event.clientY - rect.top - size.height / 2;
    setView(old => { const zoom = clamp(old.zoom * Math.exp(-event.deltaY * .0015), .08, 5), ratio = zoom / old.zoom; return { x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio, zoom }; });
  };
  useEffect(() => { const el = rootRef.current; if (!el) return; el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel); });
  const begin = (event, node) => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { id: node?.id, x: event.clientX, y: event.clientY, originX: node?.x ?? view.x, originY: node?.y ?? view.y, moved: false };
  };
  const move = event => {
    if (!drag.current) return; const d = drag.current, dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.id) setPositions(old => { const next = new Map(old); next.set(d.id, { ...next.get(d.id), x: d.originX + dx / view.zoom, y: d.originY + dy / view.zoom }); return next; });
    else setView(old => ({ ...old, x: d.originX + dx, y: d.originY + dy }));
  };
  const end = () => { const d = drag.current; if (d?.id && !d.moved) { const node = positions.get(d.id); if (node && !node.missing) onOpen?.(node.path); } drag.current = null; };
  const connected = useMemo(() => { const ids = new Set(hover ? [hover] : []); if (hover) for (const edge of graph.edges) { if (edge.source === hover) ids.add(edge.target); if (edge.target === hover) ids.add(edge.source); } return ids; }, [hover, graph]);
  return <div ref={rootRef} className="vd-graph vd-view" onPointerMove={move} onPointerUp={end} onPointerCancel={() => { drag.current = null; }}>
    <svg className="vd-graph-svg" aria-label={isLocal ? '局部关系图' : '全局关系图'} onPointerDown={event => begin(event)}>
      <g transform={`translate(${size.width / 2 + view.x},${size.height / 2 + view.y}) scale(${view.zoom})`}>
        {graph.edges.map(edge => { const a = positions.get(edge.source), b = positions.get(edge.target); return a && b ? <line key={`${edge.source}:${edge.target}`} className={`vd-graph-edge ${hover && (edge.source === hover || edge.target === hover) ? 'highlight' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} opacity={hover && !connected.has(edge.source) ? .15 : 1} /> : null; })}
        {[...positions.values()].map(node => <g key={node.id} role="button" tabIndex={0} aria-label={`${node.label}${node.missing ? '，未创建' : ''}，${node.count} 个连接`} className={`vd-graph-node ${node.id === focusPath ? 'active' : ''} ${node.missing ? 'missing' : ''}`} opacity={hover && !connected.has(node.id) ? .2 : 1} transform={`translate(${node.x},${node.y})`} onPointerDown={event => begin(event, node)} onPointerEnter={() => setHover(node.id)} onPointerLeave={() => setHover(null)} onKeyDown={e => { if (e.key === 'Enter' && !node.missing) onOpen?.(node.path); }}>
          <title>{node.path}{node.missing ? '\n未创建的链接' : ''}</title><circle r={Math.min(15, 5 + Math.sqrt(node.count) * 1.7)} />
          <text y={24 + Math.min(node.count, 8)} textAnchor="middle" fontSize={11 / Math.sqrt(view.zoom)}>{node.label.length > 35 ? node.label.slice(0, 32) + '…' : node.label}</text>
        </g>)}
      </g>
    </svg>
    <div className="vd-graph-top"><span><Network size={15} />{isLocal ? '局部关系图' : '关系图谱'}</span><IconButton label="显示图谱设置" onClick={() => setControls(v => !v)}><Settings2 size={17} /></IconButton></div>
    {controls && <aside className="vd-graph-controls" onPointerDown={e => e.stopPropagation()}>
      <div className="vd-search-field"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索文件…" aria-label="筛选图谱文件" />{query && <IconButton label="清空搜索" onClick={() => setQuery('')}><X size={12} /></IconButton>}</div>
      <label><input type="checkbox" checked={isLocal} onChange={e => setLocal(e.target.checked)} />局部关系图</label>
      {isLocal && <select aria-label="局部图谱中心笔记" value={focusPath} onChange={e => setFocusPath(e.target.value)}>{Object.keys(files).filter(path => /\.(md|canvas|base)$/i.test(path)).map(path => <option key={path}>{path}</option>)}</select>}
      {isLocal && <label className="vd-range-label">深度 <input type="range" min="1" max="4" value={depth} onChange={e => setDepth(Number(e.target.value))} /><span>{depth}</span></label>}
      <label><input type="checkbox" checked={attachments} onChange={e => setAttachments(e.target.checked)} />附件</label>
      <label><input type="checkbox" checked={unresolved} onChange={e => setUnresolved(e.target.checked)} />未创建的链接</label>
      <label><input type="checkbox" checked={orphans} onChange={e => setOrphans(e.target.checked)} />孤立节点</label>
      <div className="vd-muted">{graph.nodes.length} 个节点 · {graph.edges.length} 条连接</div>
    </aside>}
    {!graph.nodes.length && <Empty>{isLocal && !focusPath ? '打开一个笔记，查看其局部关系图。' : query ? '没有匹配的文件。' : '还没有可以显示的笔记。'}</Empty>}
    <div className="vd-view-zoom"><IconButton label="缩小" onClick={() => setView(v => ({ ...v, zoom: clamp(v.zoom / 1.25, .08, 5) }))}><Minus size={16} /></IconButton><span>{Math.round(view.zoom * 100)}%</span><IconButton label="放大" onClick={() => setView(v => ({ ...v, zoom: clamp(v.zoom * 1.25, .08, 5) }))}><Plus size={16} /></IconButton><IconButton label="缩放至全部节点" onClick={fit}><Maximize size={16} /></IconButton></div>
    <div className="vd-graph-hint">拖动平移 · 滚轮缩放 · 点击笔记打开</div>
  </div>;
}

function canvasNoteFragment(text, subpath = '') {
  const fragment = String(subpath).replace(/^#/, '');
  if (!fragment) return { text, missing: false };
  let target; try { target = decodeURIComponent(fragment); } catch { target = fragment; }
  const lines = String(text).split(/\r?\n/);
  if (target.startsWith('^')) {
    const id = target.slice(1), index = lines.findIndex(line => line.match(/(?:^|\s)\^([\w-]+)\s*$/)?.[1] === id);
    if (index < 0) return { text: '', missing: true };
    let start = index;
    if (lines[index].trim() === `^${id}`) while (start > 0 && !lines[start - 1].trim()) start--;
    while (start > 0 && lines[start - 1].trim()) start--;
    return { text: lines.slice(start, index + 1).join('\n').replace(/(?:^|\s)\^[\w-]+\s*$/, ''), missing: false };
  }
  const normalize = value => String(value).replace(/[*_`]/g, '').trim().replace(/\s+/g, '-').toLocaleLowerCase();
  const start = lines.findIndex(line => /^#{1,6}\s/.test(line) && normalize(line.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '')) === normalize(target));
  if (start < 0) return { text: '', missing: true };
  const level = lines[start].match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length && !(new RegExp(`^#{1,${level}}\\s`)).test(lines[end])) end++;
  return { text: lines.slice(start, end).join('\n'), missing: false };
}

function CanvasMarkdown({ text, path, files, resolveAsset, onNavigate, onExternal }) {
  const ref = useRef(null);
  const rendered = useMemo(() => {
    try { return { html: renderMarkdown(text, { path, files, rootPath: '__canvas_reading__' }), error: '' }; }
    catch (error) { return { html: '', error: error.message }; }
  }, [text, path, files]);
  useEffect(() => {
    if (!ref.current || !rendered.html) return;
    hydrateMarkdown(ref.current, { resolveAsset: resolveAsset ? async target => {
      const url = safeAssetUrl(await resolveAsset(target));
      if (!url) throw new Error('不支持的附件地址。');
      return url;
    } : undefined }).catch(() => {});
  }, [rendered.html, resolveAsset]);
  const click = event => {
    const callout = event.target.closest('.callout-title[role="button"]');
    if (callout) { event.preventDefault(); event.stopPropagation(); const block = callout.closest('.callout'); if (block) block.dataset.folded = block.dataset.folded === 'true' ? 'false' : 'true'; return; }
    const anchor = event.target.closest('a'); if (!anchor) return;
    event.preventDefault(); event.stopPropagation();
    const target = anchor.dataset.noteTarget;
    if (target) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) { if (safeUrl(target)) onExternal?.(target); }
      else if (!target.startsWith('/') && !target.includes('\u0000')) onNavigate?.(target);
      return;
    }
    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#')) {
      let id; try { id = decodeURIComponent(href.slice(1)); } catch { return; }
      [...(ref.current?.querySelectorAll('[id]') || [])].find(element => element.id === id)?.scrollIntoView({ block: 'nearest' });
    } else if (safeUrl(href)) onExternal?.(href);
  };
  if (rendered.error) return <div className="vd-canvas-markdown-error"><span className="vd-muted">无法渲染此片段，显示源码。</span><pre>{text}</pre></div>;
  return <div ref={ref} className="vd-canvas-markdown markdown-rendered" onClick={click} onDoubleClick={event => { if (event.target.closest('a,button,input')) event.stopPropagation(); }} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

function CanvasFileContent({ node, files, resolveAsset, onOpen, onNavigate, onExternal }) {
  const file = String(node.file || ''), type = file.split('.').pop().toLowerCase();
  const media = /^(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(type) ? 'image' : /^(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(type) ? 'audio' : /^(mp4|webm|mov|m4v|ogv)$/.test(type) ? 'video' : '';
  const [asset, setAsset] = useState({ file: '', url: '', error: '', loading: false }), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (!media || !resolveAsset) { setAsset({ file, url: '', error: media && !resolveAsset ? '此环境未提供附件预览。' : '', loading: false }); return () => { active = false; }; }
    // Parent callbacks may be recreated on every edit. Retain an unchanged media
    // URL while resolving again so editing another card does not restart playback.
    setAsset(old => old.file === file && old.url ? old : { file, url: '', error: '', loading: true });
    Promise.resolve().then(() => resolveAsset(file)).then(value => { const url = safeAssetUrl(value); if (!url) throw new Error('附件地址不可用或协议不受支持。'); if (active) setAsset(old => old.file === file && old.url === url ? old : { file, url, error: '', loading: false }); }).catch(error => { if (active) setAsset({ file, url: '', error: error.message || '无法加载附件。', loading: false }); });
    return () => { active = false; };
  }, [file, media, resolveAsset, retry]);
  if (type === 'md') {
    const present = Object.hasOwn(files, file) && typeof files[file] === 'string';
    const selected = present ? canvasNoteFragment(files[file], node.subpath) : { text: '', missing: false };
    return <div className="vd-canvas-file-content"><span className="vd-canvas-file-path" title={`${file}${node.subpath || ''}`}>{file}{node.subpath || ''}</span>{!present ? <div className="vd-canvas-preview-message">无法读取此笔记，文件可能已移动或删除。</div> : selected.missing ? <div className="vd-canvas-preview-message">找不到片段 {node.subpath}。<button onClick={() => onOpen?.(file)}>打开完整笔记</button></div> : selected.text.trim() ? <CanvasMarkdown text={selected.text} path={file} files={files} resolveAsset={resolveAsset} onNavigate={onNavigate} onExternal={onExternal} /> : <div className="vd-canvas-preview-message">此笔记还没有内容。</div>}</div>;
  }
  if (media) return <div className={`vd-canvas-media-content ${media}`}>
    {asset.loading ? <span className="vd-muted">正在加载附件…</span> : asset.error ? <div className="vd-canvas-preview-message"><AlertCircle size={22} /><span>{asset.error}</span>{resolveAsset && <button onClick={() => setRetry(value => value + 1)}>重试</button>}</div> : asset.url ? media === 'image' ? <img src={asset.url} alt={file} draggable="false" onError={() => setAsset({ file, url: '', loading: false, error: '无法显示此图片。' })} /> : media === 'audio' ? <><FileText size={28} /><audio src={asset.url} controls preload="metadata" aria-label={file} onError={() => setAsset({ file, url: '', loading: false, error: '无法播放此音频，格式可能不受支持。' })} /></> : <video src={asset.url} controls preload="metadata" aria-label={file} onDoubleClick={event => event.stopPropagation()} onError={() => setAsset({ file, url: '', loading: false, error: '无法播放此视频，格式可能不受支持。' })} /> : null}
    <span className="vd-canvas-media-name" title={file}>{file}</span>
  </div>;
  return <div className="vd-canvas-preview-message"><FileText size={28} /><span>{file || '未指定文件'}</span><button disabled={!file} onClick={() => onOpen?.(file)}><ExternalLink size={13} />{type === 'pdf' ? '打开 PDF 阅读器' : '打开文件'}</button></div>;
}

export function CanvasView({ value = '', onChange, onOpen, onNavigate, resolveAsset, path = '', files = {} }) {
  const parsed = useMemo(() => parseCanvas(value), [value]), [document, setDocument] = useState(parsed.data || { nodes: [], edges: [] });
  const [view, setView] = useState({ x: 100, y: 100, zoom: 1 }), [selection, setSelection] = useState(null), [connecting, setConnecting] = useState(null);
  const [picker, setPicker] = useState(false), [fileSearch, setFileSearch] = useState(''), [raw, setRaw] = useState(false), [rawText, setRawText] = useState(value), [rawError, setRawError] = useState('');
  const [actionError, setActionError] = useState('');
  const rootRef = useRef(null), drag = useRef(null), docRef = useRef(document), lastSent = useRef(null), initialFit = useRef(false), idPrefix = useId().replaceAll(':', '');
  const update = (next, save = true, repair = false) => { if (parsed.error && !repair) return; docRef.current = next; setDocument(next); if (save) { const json = JSON.stringify(next, null, 2); lastSent.current = json; onChange?.(json); } };
  useEffect(() => { if (value === lastSent.current) return; if (parsed.data) { docRef.current = parsed.data; setDocument(parsed.data); } }, [value, parsed]);
  const selectedNode = document.nodes.find(n => selection?.type === 'node' && n.id === selection.id), selectedEdge = document.edges.find(n => selection?.type === 'edge' && n.id === selection.id);
  const mutateNode = (id, changes, save = true) => update({ ...docRef.current, nodes: docRef.current.nodes.map(node => node.id === id ? { ...node, ...changes } : node) }, save);
  const mutateEdge = (id, changes) => update({ ...docRef.current, edges: docRef.current.edges.map(edge => edge.id === id ? { ...edge, ...changes } : edge) });
  const worldPoint = event => { const rect = rootRef.current.getBoundingClientRect(); return { x: (event.clientX - rect.left - view.x) / view.zoom, y: (event.clientY - rect.top - view.y) / view.zoom }; };
  const fit = () => {
    const nodes = docRef.current.nodes, rect = rootRef.current?.getBoundingClientRect(); if (!rect) return;
    if (!nodes.length) { setView({ x: 100, y: 100, zoom: 1 }); return; }
    const minX = Math.min(...nodes.map(n => n.x)), maxX = Math.max(...nodes.map(n => n.x + n.width)), minY = Math.min(...nodes.map(n => n.y)), maxY = Math.max(...nodes.map(n => n.y + n.height));
    const zoom = clamp(Math.min((rect.width - 160) / Math.max(1, maxX - minX), (rect.height - 160) / Math.max(1, maxY - minY)), .08, 1.2);
    setView({ x: rect.width / 2 - (minX + maxX) / 2 * zoom, y: rect.height / 2 - (minY + maxY) / 2 * zoom, zoom });
  };
  useEffect(() => { if (!initialFit.current && parsed.data?.nodes.length) { initialFit.current = true; fit(); } }, [parsed]);
  useEffect(() => { const el = rootRef.current; if (!el) return; const wheel = event => { if (event.target.closest('textarea, .vd-canvas-inspector, .vd-canvas-file-picker, .vd-canvas-raw')) return; event.preventDefault(); const rect = el.getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top; setView(old => { const zoom = clamp(old.zoom * Math.exp(-event.deltaY * .0015), .06, 4); return { x: px - (px - old.x) * zoom / old.zoom, y: py - (py - old.y) * zoom / old.zoom, zoom }; }); }; el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel); }, []);
  const addNode = (type, extra = {}) => {
    const rect = rootRef.current?.getBoundingClientRect(), width = type === 'group' ? 600 : 320, height = type === 'group' ? 400 : 210;
    const node = { id: makeId(), type, x: Math.round(((rect?.width || 800) / 2 - view.x) / view.zoom - width / 2), y: Math.round(((rect?.height || 600) / 2 - view.y) / view.zoom - height / 2), width, height, ...(type === 'text' ? { text: '' } : type === 'link' ? { url: 'https://' } : type === 'group' ? { label: '新建分组' } : {}), ...extra };
    update({ ...docRef.current, nodes: [...docRef.current.nodes, node] }); setSelection({ type: 'node', id: node.id }); setPicker(false);
  };
  const beginDrag = (event, node, resize = false) => {
    if (event.button !== 0 || parsed.error) return;
    event.stopPropagation(); rootRef.current.setPointerCapture?.(event.pointerId);
    setSelection(node ? { type: 'node', id: node.id } : null);
    const contained = node?.type === 'group' && !resize ? docRef.current.nodes.filter(n => n.id !== node.id && n.x >= node.x && n.y >= node.y && n.x + n.width <= node.x + node.width && n.y + n.height <= node.y + node.height).map(n => ({ id: n.id, x: n.x, y: n.y })) : [];
    drag.current = { kind: node ? (resize ? 'resize' : 'node') : 'pan', id: node?.id, startX: event.clientX, startY: event.clientY, origin: node ? { ...node } : { ...view }, contained, moved: false };
  };
  const pointerMove = event => {
    if (connecting) { setConnecting(c => c ? { ...c, target: worldPoint(event) } : null); return; }
    const d = drag.current; if (!d) return;
    const dx = event.clientX - d.startX, dy = event.clientY - d.startY; if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    if (d.kind === 'pan') setView(old => ({ ...old, x: d.origin.x + dx, y: d.origin.y + dy }));
    if (d.kind === 'node') {
      const moved = new Map([{ id: d.id, x: d.origin.x, y: d.origin.y }, ...d.contained].map(n => [n.id, n]));
      update({ ...docRef.current, nodes: docRef.current.nodes.map(node => moved.has(node.id) ? { ...node, x: Math.round(moved.get(node.id).x + dx / view.zoom), y: Math.round(moved.get(node.id).y + dy / view.zoom) } : node) }, false);
    }
    if (d.kind === 'resize') mutateNode(d.id, { width: Math.max(160, Math.round(d.origin.width + dx / view.zoom)), height: Math.max(80, Math.round(d.origin.height + dy / view.zoom)) }, false);
  };
  const pointerUp = () => { if (drag.current?.moved && drag.current.kind !== 'pan') update(docRef.current); drag.current = null; if (connecting) setConnecting(null); };
  const removeSelected = () => {
    if (!selection) return;
    if (selection.type === 'node') update({ ...docRef.current, nodes: docRef.current.nodes.filter(n => n.id !== selection.id), edges: docRef.current.edges.filter(e => e.fromNode !== selection.id && e.toNode !== selection.id) });
    else update({ ...docRef.current, edges: docRef.current.edges.filter(e => e.id !== selection.id) });
    setSelection(null);
  };
  const startConnection = (event, node, side) => { event.stopPropagation(); event.preventDefault(); setConnecting({ fromNode: node.id, fromSide: side, target: worldPoint(event) }); };
  const endConnection = (event, node, side) => { if (!connecting || connecting.fromNode === node.id) return; event.stopPropagation(); const edge = { id: makeId(), fromNode: connecting.fromNode, fromSide: connecting.fromSide, toNode: node.id, toSide: side, toEnd: 'arrow' }; update({ ...docRef.current, edges: [...docRef.current.edges, edge] }); setConnecting(null); setSelection({ type: 'edge', id: edge.id }); };
  const external = url => {
    const safe = safeUrl(url); if (!safe) { setActionError('仅支持不含登录信息的 http、https 或 mailto 地址。'); return; }
    setActionError('');
    try { if (window.vaultdesk?.openExternal) Promise.resolve(window.vaultdesk.openExternal(safe)).catch(error => setActionError(error.message || '无法打开链接。')); else window.open(safe, '_blank', 'noopener,noreferrer'); }
    catch (error) { setActionError(error.message || '无法打开链接。'); }
  };
  const edgePath = (from, to, fromSide = 'right', toSide = 'left') => { const a = canvasAnchor(from, fromSide), b = canvasAnchor(to, toSide), amount = Math.max(50, Math.min(180, Math.hypot(b.x - a.x, b.y - a.y) / 2)); const offset = side => side === 'left' ? [-amount, 0] : side === 'right' ? [amount, 0] : side === 'top' ? [0, -amount] : [0, amount]; const c = offset(fromSide), d = offset(toSide); return { d: `M${a.x},${a.y} C${a.x + c[0]},${a.y + c[1]} ${b.x + d[0]},${b.y + d[1]} ${b.x},${b.y}`, a, b }; };
  const applyRaw = () => { const result = parseCanvas(rawText); if (result.error) setRawError(result.error); else { update(result.data, true, true); setRaw(false); setRawError(''); setSelection(null); } };
  return <div ref={rootRef} className={`vd-canvas vd-view ${connecting ? 'connecting' : ''}`} tabIndex={0} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={e => { if (e.target.closest('input,textarea,select,[contenteditable="true"]')) return; if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); } if (e.key === 'Escape') { setSelection(null); setConnecting(null); setPicker(false); setRaw(false); } }} style={{ backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
    <div className="vd-canvas-pan" onPointerDown={e => beginDrag(e)} />
    {actionError && <div className="vd-canvas-action-error vd-error"><AlertCircle size={15} />{actionError}<IconButton label="关闭提示" onClick={() => setActionError('')}><X size={14} /></IconButton></div>}
    {parsed.error && <div className="vd-canvas-error vd-error"><AlertCircle size={18} />无法读取 Canvas：{parsed.error}<button onClick={() => { setRawText(value); setRaw(true); }}>编辑 JSON</button></div>}
    {!parsed.error && <div className="vd-canvas-world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` }}>
      <svg className="vd-canvas-edges"><defs><marker id={`${idPrefix}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="context-stroke" /></marker></defs>
        {document.edges.map(edge => { const from = document.nodes.find(n => n.id === edge.fromNode), to = document.nodes.find(n => n.id === edge.toNode); if (!from || !to) return null; const line = edgePath(from, to, edge.fromSide, edge.toSide); return <g key={edge.id} className={selectedEdge?.id === edge.id ? 'selected' : ''} style={{ color: canvasColor(edge.color) }}>
          <path className="vd-canvas-edge-hit" d={line.d} onPointerDown={e => { e.stopPropagation(); setSelection({ type: 'edge', id: edge.id }); }} />
          <path className="vd-canvas-edge" d={line.d} markerStart={edge.fromEnd === 'arrow' ? `url(#${idPrefix}-arrow)` : undefined} markerEnd={edge.toEnd !== 'none' ? `url(#${idPrefix}-arrow)` : undefined} />
          {edge.label && <text className="vd-canvas-edge-label" x={(line.a.x + line.b.x) / 2} y={(line.a.y + line.b.y) / 2 - 8} textAnchor="middle" onPointerDown={e => { e.stopPropagation(); setSelection({ type: 'edge', id: edge.id }); }}>{edge.label}</text>}
        </g>; })}
        {connecting && (() => { const from = document.nodes.find(n => n.id === connecting.fromNode); if (!from) return null; const a = canvasAnchor(from, connecting.fromSide); return <path className="vd-canvas-edge preview" d={`M${a.x},${a.y} L${connecting.target.x},${connecting.target.y}`} />; })()}
      </svg>
      {[...document.nodes].sort((a, b) => (a.type === 'group' ? 0 : 1) - (b.type === 'group' ? 0 : 1)).map(node => <article key={node.id} className={`vd-canvas-node ${node.type} ${selectedNode?.id === node.id ? 'selected' : ''}`} style={{ left: node.x, top: node.y, width: node.width, height: node.height, '--node-color': canvasColor(node.color) }} onPointerDown={e => { e.stopPropagation(); setSelection({ type: 'node', id: node.id }); }} onDoubleClick={event => { if (event.target.closest('a,button,input,audio,video')) return; if (node.type === 'file') onOpen?.(`${node.file}${node.subpath || ''}`); if (node.type === 'link') external(node.url); }}>
        <header onPointerDown={e => beginDrag(e, node)}><GripVertical size={13} /><span>{node.type === 'file' ? basename(node.file || '') : node.type === 'link' ? '网页' : node.type === 'group' ? node.label || '分组' : '文本'}</span>{node.type === 'file' && <IconButton label="打开文件" onPointerDown={e => e.stopPropagation()} onClick={() => onOpen?.(`${node.file}${node.subpath || ''}`)}><ExternalLink size={12} /></IconButton>}{node.type === 'link' && <IconButton label="在浏览器打开" disabled={!safeUrl(node.url)} onPointerDown={e => e.stopPropagation()} onClick={() => external(node.url)}><ExternalLink size={12} /></IconButton>}</header>
        {node.type === 'text' && <textarea aria-label="卡片文本" placeholder="开始书写…" value={node.text || ''} onPointerDown={e => e.stopPropagation()} onFocus={() => setSelection({ type: 'node', id: node.id })} onChange={e => mutateNode(node.id, { text: e.target.value })} spellCheck="false" />}
        {node.type === 'file' && <CanvasFileContent node={node} files={files} resolveAsset={resolveAsset} onOpen={onOpen} onNavigate={onNavigate || onOpen} onExternal={external} />}
        {node.type === 'link' && <div className="vd-canvas-link-content"><Link2 size={26} /><span>{node.url || '输入网页地址'}</span><button disabled={!safeUrl(node.url)} onClick={() => external(node.url)}><ExternalLink size={13} />在浏览器打开</button>{!safeUrl(node.url) && <small>请在属性中填写有效的 http、https 或 mailto 地址。</small>}</div>}
        {['top', 'right', 'bottom', 'left'].map(side => <button key={side} className={`vd-canvas-port ${side}`} title={`从${({ top: '上', right: '右', bottom: '下', left: '左' })[side]}方连线：拖到另一张卡片的连接点`} aria-label={`${side} 连接点`} onPointerDown={e => startConnection(e, node, side)} onPointerUp={e => endConnection(e, node, side)} />)}
        <div className="vd-canvas-resize" title="拖动调整卡片大小" onPointerDown={e => beginDrag(e, node, true)} />
      </article>)}
    </div>}
    <div className="vd-canvas-toolbar" onPointerDown={e => e.stopPropagation()}>
      <IconButton label="添加文本卡片" disabled={!!parsed.error} onClick={() => addNode('text')}><Type size={19} /></IconButton>
      <IconButton label="添加文件卡片" disabled={!!parsed.error} onClick={() => setPicker(v => !v)}><FileText size={19} /></IconButton>
      <IconButton label="添加网页卡片" disabled={!!parsed.error} onClick={() => addNode('link')}><Link2 size={19} /></IconButton>
      <IconButton label="添加分组" disabled={!!parsed.error} onClick={() => addNode('group')}><Square size={19} /></IconButton><span className="vd-toolbar-divider" />
      <IconButton label="编辑 JSON Canvas" onClick={() => { setRawText(parsed.error ? value : JSON.stringify(docRef.current, null, 2)); setRawError(''); setRaw(true); }}><Code2 size={19} /></IconButton>
    </div>
    {picker && <div className="vd-canvas-file-picker" onPointerDown={e => e.stopPropagation()}><div className="vd-search-field"><Search size={15} /><input autoFocus value={fileSearch} onChange={e => setFileSearch(e.target.value)} placeholder="选择仓库中的文件…" /></div><div className="vd-picker-list">{Object.keys(files).filter(path => path.toLowerCase().includes(fileSearch.toLowerCase())).slice(0, 100).map(path => <button key={path} onClick={() => addNode('file', { file: path })}><FileText size={14} />{path}</button>)}{!Object.keys(files).length && <p className="vd-muted">仓库中还没有文件。</p>}</div></div>}
    {!parsed.error && (selectedNode || selectedEdge) && <aside className="vd-canvas-inspector" onPointerDown={e => e.stopPropagation()}><header><strong>{selectedNode ? ({ text: '文本卡片', file: '文件卡片', link: '网页卡片', group: '分组' })[selectedNode.type] : '连线'}</strong><IconButton label="关闭属性" onClick={() => setSelection(null)}><X size={15} /></IconButton></header>
      {selectedNode?.type === 'group' && <label>名称<input value={selectedNode.label || ''} onChange={e => mutateNode(selectedNode.id, { label: e.target.value })} /></label>}
      {selectedNode?.type === 'link' && <label>网页地址<input value={selectedNode.url || ''} onChange={e => mutateNode(selectedNode.id, { url: e.target.value })} placeholder="https://example.com" />{!safeUrl(selectedNode.url) && <small>请输入 http、https 或 mailto 地址。</small>}</label>}
      {selectedNode?.type === 'file' && <><label>文件<select value={selectedNode.file || ''} onChange={e => mutateNode(selectedNode.id, { file: e.target.value })}>{!Object.hasOwn(files, selectedNode.file) && <option>{selectedNode.file}</option>}{Object.keys(files).map(path => <option key={path}>{path}</option>)}</select></label><label>小节或块链接<input value={selectedNode.subpath || ''} placeholder="#标题 或 #^块ID" onChange={e => mutateNode(selectedNode.id, { subpath: e.target.value })} /></label></>}
      {selectedEdge && <><label>连线标签<input value={selectedEdge.label || ''} onChange={e => mutateEdge(selectedEdge.id, { label: e.target.value })} /></label><label>起点箭头<select value={selectedEdge.fromEnd || 'none'} onChange={e => mutateEdge(selectedEdge.id, { fromEnd: e.target.value })}><option value="none">无</option><option value="arrow">箭头</option></select></label><label>终点箭头<select value={selectedEdge.toEnd || 'arrow'} onChange={e => mutateEdge(selectedEdge.id, { toEnd: e.target.value })}><option value="arrow">箭头</option><option value="none">无</option></select></label></>}
      <label>颜色<div className="vd-color-swatches">{['', '1', '2', '3', '4', '5', '6'].map(color => <button key={color} title={color || '默认颜色'} aria-label={color ? `颜色 ${color}` : '默认颜色'} className={(selectedNode || selectedEdge).color === color ? 'active' : ''} style={{ background: canvasColor(color) }} onClick={() => selectedNode ? mutateNode(selectedNode.id, { color }) : mutateEdge(selectedEdge.id, { color })} />)}</div></label>
      {selectedNode && <div className="vd-dimensions"><label>宽<input type="number" min="160" value={selectedNode.width} onChange={e => mutateNode(selectedNode.id, { width: Math.max(160, Number(e.target.value)) })} /></label><label>高<input type="number" min="80" value={selectedNode.height} onChange={e => mutateNode(selectedNode.id, { height: Math.max(80, Number(e.target.value)) })} /></label></div>}
      <button className="vd-danger-button" onClick={removeSelected}><Trash2 size={14} />删除{selectedNode ? '卡片' : '连线'}</button>
    </aside>}
    {!parsed.error && !document.nodes.length && <Empty><Square size={42} strokeWidth={1} /><h3>把想法放在画布上</h3><p>添加文本、文件或网页卡片。拖动卡片四周的连接点建立联系。</p><button className="vd-primary-button" onClick={() => addNode('text')}><Plus size={15} />添加第一张卡片</button></Empty>}
    <div className="vd-view-zoom"><IconButton label="缩小" onClick={() => setView(v => ({ ...v, zoom: clamp(v.zoom / 1.25, .06, 4) }))}><Minus size={16} /></IconButton><span>{Math.round(view.zoom * 100)}%</span><IconButton label="放大" onClick={() => setView(v => ({ ...v, zoom: clamp(v.zoom * 1.25, .06, 4) }))}><Plus size={16} /></IconButton><IconButton label="缩放至全部卡片" onClick={fit}><Maximize size={16} /></IconButton></div>
    <div className="vd-canvas-hint">{connecting ? '松开到另一张卡片的连接点' : `${document.nodes.length} 张卡片 · ${document.edges.length} 条连线`}</div>
    {raw && <div className="vd-canvas-raw" onPointerDown={e => e.stopPropagation()}><header><strong>JSON Canvas</strong><IconButton label="关闭 JSON 编辑" onClick={() => setRaw(false)}><X size={17} /></IconButton></header><textarea aria-label="JSON Canvas 源码" value={rawText} onChange={e => setRawText(e.target.value)} spellCheck="false" />{rawError && <div className="vd-error">{rawError}</div>}<button className="vd-primary-button" onClick={applyRaw}><Check size={16} />应用并保存</button></div>}
  </div>;
}

function baseConfigurationError(config) {
  if (config.views !== undefined && !Array.isArray(config.views)) return 'views 必须是视图数组';
  for (const view of config.views || []) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) return '每个视图必须是 YAML 对象';
    if (view.name !== undefined && typeof view.name !== 'string') return '视图名称必须是文本';
    if (view.type !== undefined && typeof view.type !== 'string') return '视图类型必须是文本';
    if (view.order !== undefined && (!Array.isArray(view.order) || view.order.some(column => typeof column !== 'string' || !column.trim()))) return 'order 必须是属性名称数组';
    if (view.sort !== undefined && (!Array.isArray(view.sort) || view.sort.some(item => !item || typeof item.property !== 'string'))) return 'sort 必须包含有效的 property 属性名';
  }
  if (config.properties && (typeof config.properties !== 'object' || Array.isArray(config.properties))) return 'properties 必须是属性配置对象';
  if (config.properties && Object.values(config.properties).some(property => property?.displayName !== undefined && typeof property.displayName !== 'string')) return '属性显示名称必须是文本';
  return '';
}

export function BasesView({ value = '', onChange, files = {}, onOpen }) {
  const { config, error: parseError } = useMemo(() => parseBase(value), [value]);
  const error = parseError || baseConfigurationError(config);
  const [selectedView, setSelectedView] = useState(0), [search, setSearch] = useState(''), [sort, setSort] = useState(null), [source, setSource] = useState(false), [sourceText, setSourceText] = useState(value), [sourceError, setSourceError] = useState('');
  const [showFilter, setShowFilter] = useState(false), [filterProperty, setFilterProperty] = useState('file.name'), [filterOperator, setFilterOperator] = useState('contains'), [filterValue, setFilterValue] = useState('');
  const validViews = Array.isArray(config.views) ? config.views.filter(view => view && typeof view === 'object' && !Array.isArray(view)) : [];
  const views = validViews.length ? validViews : [{ type: 'table', name: '表格' }];
  const current = views[Math.min(selectedView, views.length - 1)] || views[0];
  const records = useMemo(() => baseRecords(files), [files]);
  const properties = useMemo(() => [...new Set(['file.name', 'file.folder', 'file.ext', ...records.flatMap(record => Object.keys(record.props))])], [records]);
  const columns = Array.isArray(current.order) && current.order.length ? [...new Set(current.order.filter(column => typeof column === 'string' && column.trim()))] : ['file.name', ...properties.filter(p => !p.startsWith('file.')).slice(0, 5), 'file.folder'];
  const result = useMemo(() => {
    if (error) return { rows: [], failure: '' };
    let failure = '';
    let rows = records.filter(record => {
      try { return matchesBaseFilter(config.filters, record) && matchesBaseFilter(current.filters, record); } catch (e) { failure = e.message; return false; }
    });
    const q = search.toLocaleLowerCase();
    if (q) rows = rows.filter(record => record.path.toLocaleLowerCase().includes(q) || Object.values(record.props).some(value => displayValue(value).toLocaleLowerCase().includes(q)));
    const settings = sort ? [sort] : Array.isArray(current.sort) ? current.sort : [];
    if (settings.length) rows.sort((a, b) => { for (const s of settings) { const av = propertyValue(a, s.property), bv = propertyValue(b, s.property); const comparison = typeof av === 'number' && typeof bv === 'number' ? av - bv : displayValue(av).localeCompare(displayValue(bv), undefined, { numeric: true }); if (comparison) return comparison * (s.direction === 'DESC' ? -1 : 1); } return a.path.localeCompare(b.path); });
    if (Number.isFinite(current.limit) && current.limit > 0) rows = rows.slice(0, current.limit);
    return { rows, failure };
  }, [records, config, current, search, sort, error]);
  const updateConfig = next => { if (!error) onChange?.(serializeBase(next)); };
  const sortBy = property => { if (error) return; const previous = sort || current.sort?.[0]; const next = { property, direction: previous?.property === property && previous.direction !== 'DESC' ? 'DESC' : 'ASC' }; setSort(next); updateConfig({ ...config, views: views.map((view, i) => i === Math.min(selectedView, views.length - 1) ? { ...view, sort: [next] } : view) }); };
  const addFilter = () => {
    if (error) return;
    let prop = filterProperty.startsWith('file.') ? filterProperty : /^\w+$/.test(filterProperty) ? filterProperty : `note[${JSON.stringify(filterProperty)}]`;
    const literal = /^-?\d+(\.\d+)?$/.test(filterValue) || /^(true|false|null)$/.test(filterValue) ? filterValue : JSON.stringify(filterValue);
    const expression = filterOperator === 'contains' ? `${prop}.contains(${JSON.stringify(filterValue)})` : `${prop} ${filterOperator} ${literal}`;
    const existing = config.filters ? [config.filters] : [];
    updateConfig({ ...config, filters: { and: [...existing, expression] } }); setFilterValue(''); setShowFilter(false);
  };
  const applySource = () => { const parsed = parseBase(sourceText); const issue = parsed.error || baseConfigurationError(parsed.config); if (issue) setSourceError(issue); else { onChange?.(sourceText); setSource(false); setSourceError(''); setSort(null); } };
  return <div className="vd-base vd-view">
    <div className="vd-base-toolbar"><div className="vd-base-tabs">{views.map((view, i) => <button key={i} className={i === Math.min(selectedView, views.length - 1) ? 'active' : ''} onClick={() => { setSelectedView(i); setSort(null); }}><Table2 size={15} />{typeof view.name === 'string' ? view.name : `视图 ${i + 1}`}</button>)}</div><div className="vd-base-actions"><button disabled={!!error} onClick={() => setShowFilter(v => !v)}><Settings2 size={14} />筛选</button><IconButton label="编辑 Base 配置" onClick={() => { setSourceText(value); setSource(true); }}><Code2 size={17} /></IconButton></div></div>
    <div className="vd-base-search"><div className="vd-search-field"><Search size={15} /><input aria-label="搜索数据库记录" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索文件或属性…" />{search && <IconButton label="清空搜索" onClick={() => setSearch('')}><X size={13} /></IconButton>}</div><span className="vd-muted">{result.rows.length} 个文件</span></div>
    {showFilter && <div className="vd-base-filter"><select aria-label="筛选属性" value={filterProperty} onChange={e => setFilterProperty(e.target.value)}>{properties.map(prop => <option key={prop}>{prop}</option>)}</select><select aria-label="筛选运算符" value={filterOperator} onChange={e => setFilterOperator(e.target.value)}><option value="contains">包含</option><option value="==">等于</option><option value="!=">不等于</option><option value=">">大于</option><option value="<">小于</option></select><input aria-label="筛选值" placeholder="值" value={filterValue} onChange={e => setFilterValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addFilter(); }} /><button className="vd-primary-button" disabled={!!error} onClick={addFilter}>添加筛选</button>{config.filters && <button onClick={() => { const next = { ...config }; delete next.filters; updateConfig(next); }}>清空全局筛选</button>}</div>}
    {(error || result.failure) && <div className="vd-error"><AlertCircle size={15} />{error || result.failure}。请编辑配置。</div>}
    {typeof current.type === 'string' && current.type !== 'table' && <div className="vd-base-notice">“{current.type}” 布局尚未实现，当前使用表格展示同一组文件。</div>}
    {(config.formulas || columns.some(column => column.startsWith('formula.'))) && <div className="vd-base-notice">公式列暂不计算；现有公式配置会完整保留。</div>}
    <div className="vd-base-table-wrap"><table className="vd-base-table"><thead><tr><th className="vd-row-number">#</th>{columns.map(column => <th key={column}><button disabled={!!error} onClick={() => sortBy(column)}><span>{(typeof config.properties?.[column]?.displayName === 'string' ? config.properties[column].displayName : '') || ({ 'file.name': '文件', 'file.folder': '文件夹', 'file.ext': '类型' })[column] || column.replace(/^note\./, '')}</span>{(sort || current.sort?.[0])?.property === column && ((sort || current.sort?.[0]).direction === 'DESC' ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}</button></th>)}</tr></thead><tbody>{result.rows.map((record, i) => <tr key={record.path}><td className="vd-row-number">{i + 1}</td>{columns.map(column => { const data = propertyValue(record, column); return <td key={column}>{column === 'file.name' || column === 'file.path' ? <button className="vd-base-file" onClick={() => onOpen?.(record.path)} title={record.path}><FileText size={14} />{displayValue(data)}</button> : Array.isArray(data) ? <span className="vd-base-tags">{data.map((item, j) => <span key={j}>{displayValue(item)}</span>)}</span> : typeof data === 'boolean' ? <input type="checkbox" checked={data} readOnly aria-label={`${column}: ${data}`} /> : <span title={displayValue(data)}>{displayValue(data) || <span className="vd-muted">—</span>}</span>}</td>; })}</tr>)}</tbody></table>{!result.rows.length && !error && !result.failure && <Empty>没有符合条件的文件。</Empty>}</div>
    <footer className="vd-base-footer"><span>文件属性来自笔记 YAML。打开文件可编辑属性。</span><button onClick={() => { setSourceText(value); setSource(true); }}>配置列与视图 <CornerDownRight size={13} /></button></footer>
    {source && <div className="vd-base-source"><header><strong>Base YAML 配置</strong><IconButton label="关闭配置" onClick={() => setSource(false)}><X size={18} /></IconButton></header><textarea value={sourceText} onChange={e => setSourceText(e.target.value)} spellCheck="false" aria-label="Base YAML 配置" /><p className="vd-muted">支持表格、文件属性、搜索、排序及常用逻辑筛选。公式、卡片布局与高级函数尚未实现。</p>{sourceError && <div className="vd-error">{sourceError}</div>}<button className="vd-primary-button" onClick={applySource}><Check size={16} />应用并保存</button></div>}
  </div>;
}

function PropertyRow({ name, value, onRename, onSet, onDelete }) {
  const [keyDraft, setKeyDraft] = useState(name), [draft, setDraft] = useState(displayValue(value)), [error, setError] = useState('');
  const type = Array.isArray(value) ? 'list' : typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : value && typeof value === 'object' ? 'json' : /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? 'date' : 'text';
  useEffect(() => setKeyDraft(name), [name]);
  useEffect(() => setDraft(displayValue(value)), [value]);
  const commit = () => { try { const parsed = type === 'number' ? (draft.trim() === '' ? null : Number(draft)) : type === 'list' ? draft.split(',').map(v => v.trim()).filter(Boolean) : type === 'json' ? JSON.parse(draft) : draft; if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('请输入有效数字。'); onSet(parsed); setError(''); } catch (e) { setError(e.message); } };
  const changeType = next => { let parsed = value; if (next === 'text') parsed = displayValue(value); if (next === 'number') parsed = Number(value) || 0; if (next === 'checkbox') parsed = value === true || value === 'true'; if (next === 'list') parsed = Array.isArray(value) ? value : displayValue(value).split(',').map(v => v.trim()).filter(Boolean); if (next === 'date') parsed = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : new Date().toLocaleDateString('en-CA'); onSet(parsed); };
  return <div className="vd-property-row"><select className="vd-property-type" title="属性类型" aria-label={`${name} 属性类型`} value={type} onChange={e => changeType(e.target.value)}><option value="text">Aa 文本</option><option value="list">☷ 列表</option><option value="number"># 数字</option><option value="checkbox">☑ 复选框</option><option value="date">▦ 日期</option>{type === 'json' && <option value="json">{} 对象</option>}</select><input className="vd-property-key" aria-label="属性名" value={keyDraft} onChange={e => setKeyDraft(e.target.value)} onBlur={() => { const next = keyDraft.trim(); if (next && next !== name) onRename(next); else setKeyDraft(name); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    {type === 'checkbox' ? <label className="vd-property-checkbox"><input type="checkbox" checked={!!value} onChange={e => onSet(e.target.checked)} /><span>{value ? 'true' : 'false'}</span></label> : <input className="vd-property-value" type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} value={draft} title={error || (type === 'list' ? '使用逗号分隔列表项目' : '')} aria-label={`${name} 属性值`} placeholder={type === 'list' ? '项目 1, 项目 2' : '空'} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />}
    <IconButton label={`删除属性 ${name}`} onClick={onDelete}><X size={13} /></IconButton>{error && <small className="vd-error">{error}</small>}
  </div>;
}

export function PropertiesPanel({ text = '', onChange }) {
  const parsed = useMemo(() => frontmatterDocument(text), [text]);
  const [collapsed, setCollapsed] = useState(false), [adding, setAdding] = useState(false), [newKey, setNewKey] = useState(''), [error, setError] = useState('');
  const mutate = fn => { try { onChange?.(writeFrontmatter(text, fn)); setError(''); } catch (e) { setError(e.message); } };
  const add = () => { const key = newKey.trim(); if (!key) return; if (Object.hasOwn(parsed.data, key)) { setError('此属性已存在。'); return; } mutate(doc => doc.set(key, '')); setNewKey(''); setAdding(false); };
  return <section className={`vd-properties ${collapsed ? 'collapsed' : ''}`}><header><button className="vd-property-heading" onClick={() => setCollapsed(v => !v)} aria-expanded={!collapsed}><span className="vd-disclosure">{collapsed ? '›' : '⌄'}</span>属性<span>{Object.keys(parsed.data).length || ''}</span></button><IconButton label="添加属性" disabled={!!parsed.error} onClick={() => { setAdding(true); setCollapsed(false); }}><Plus size={15} /></IconButton></header>
    {!collapsed && <>{(parsed.error || error) && <div className="vd-error">{parsed.error || error}</div>}{!parsed.error && Object.entries(parsed.data).map(([name, value]) => <PropertyRow key={name} name={name} value={value} onRename={next => { if (Object.hasOwn(parsed.data, next)) { setError('此属性名已存在。'); return; } mutate(doc => { const pair = doc.contents?.items?.find(pair => String(pair.key?.value) === name); if (pair) pair.key.value = next; }); }} onSet={next => mutate(doc => doc.set(name, next))} onDelete={() => mutate(doc => doc.delete(name))} />)}
      {adding && <div className="vd-property-add"><input autoFocus aria-label="新属性名" value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="属性名" onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setAdding(false); }} /><button onClick={add}>添加</button><IconButton label="取消添加属性" onClick={() => setAdding(false)}><X size={13} /></IconButton></div>}
      {!adding && !parsed.error && <button className="vd-add-property" onClick={() => setAdding(true)}><Plus size={13} />添加属性</button>}
    </>}
  </section>;
}
