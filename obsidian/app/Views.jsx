import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Network, Search, Plus, Minus, Maximize, X, Settings2, FileText, Link2, Type, Square, Trash2, Code2, Table2, ArrowDown, ArrowUp, GripVertical, ExternalLink, Check, AlertCircle, CornerDownRight } from 'lucide-react';
import { basename, graphData, layoutGraph, parseCanvas, canvasAnchor, canvasColor, makeId, parseBase, serializeBase, baseRecords, propertyValue, matchesBaseFilter, displayValue, frontmatterDocument, writeFrontmatter, sortBaseRecords, groupBaseRecords, summarizeBaseValues, updateBaseProperty, parseBaseExpression, baseValueType } from './views-model.mjs';
import { resolveLink } from '../core/vault.mjs';
import { renderMarkdown, hydrateMarkdown } from './markdown.js';
import 'katex/dist/katex.min.css';
import './views.css';

const IconButton = ({ label, children, ...props }) => <button type="button" className="vd-icon-button" title={label} aria-label={label} {...props}>{children}</button>;
const Empty = ({ children }) => <div className="vd-view-empty">{children}</div>;
const emptyMetadata = Object.freeze({});
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
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (config.views !== undefined && !Array.isArray(config.views)) return 'views 必须是视图数组';
  for (const view of config.views || []) {
    if (!object(view)) return '每个视图必须是 YAML 对象';
    if (view.name !== undefined && typeof view.name !== 'string') return '视图名称必须是文本';
    if (view.type !== undefined && typeof view.type !== 'string') return '视图类型必须是文本';
    if (view.order !== undefined && (!Array.isArray(view.order) || view.order.some(column => typeof column !== 'string' || !column.trim()))) return 'order 必须是属性名称数组';
    if (view.sort !== undefined && (!Array.isArray(view.sort) || view.sort.some(item => !object(item) || typeof item.property !== 'string' || item.direction && !['ASC', 'DESC'].includes(item.direction)))) return 'sort 必须包含属性名及 ASC / DESC 方向';
    if (view.groupBy !== undefined && (!object(view.groupBy) || typeof view.groupBy.property !== 'string' || view.groupBy.direction && !['ASC', 'DESC'].includes(view.groupBy.direction))) return 'groupBy 必须包含属性名及 ASC / DESC 方向';
    if (view.groupOrder !== undefined && !Array.isArray(view.groupOrder)) return 'groupOrder 必须是分组值数组';
    if (view.limit !== undefined && (!Number.isInteger(view.limit) || view.limit < 0)) return 'limit 必须是非负整数';
    if (view.summaries !== undefined && (!object(view.summaries) || Object.values(view.summaries).some(name => typeof name !== 'string'))) return '视图 summaries 必须将属性映射到汇总名称';
  }
  for (const key of ['formulas', 'summaries']) if (config[key] !== undefined && (!object(config[key]) || Object.values(config[key]).some(expression => typeof expression !== 'string'))) return key + ' 必须将名称映射到表达式文本';
  if (config.properties !== undefined && !object(config.properties)) return 'properties 必须是属性配置对象';
  if (config.properties && Object.values(config.properties).some(property => property?.displayName !== undefined && typeof property.displayName !== 'string')) return '属性显示名称必须是文本';
  return '';
}

function BaseImage({ value, resolveAsset, sourcePath, files }) {
  const [url, setUrl] = useState(''), [failure, setFailure] = useState('');
  useEffect(() => {
    let live = true; setUrl(''); setFailure('');
    const path = value.path, remote = safeAssetUrl(path);
    Promise.resolve().then(() => remote || (resolveAsset && resolveAsset(resolveLink(path, sourcePath, Object.keys(files)) || path))).then(result => { if (live) { const safe = safeAssetUrl(result); if (safe) setUrl(safe); else setFailure('图片地址不可用'); } }).catch(error => { if (live) setFailure(error.message); });
    return () => { live = false; };
  }, [value.path, resolveAsset, sourcePath, files]);
  return url ? <img className="vd-base-image" src={url} alt={value.display || value.path} onError={() => { setFailure('无法显示图片'); setUrl(''); }} /> : <span className="vd-muted" title={failure || value.path}>{failure || '加载图片…'}</span>;
}

function BaseValue({ value, record, onOpen, onNavigate, resolveAsset, files }) {
  const kind = baseValueType(value);
  const navigate = target => {
    const url = safeUrl(target);
    if (url) { if (window.vaultdesk?.openExternal) window.vaultdesk.openExternal(url).catch(() => {}); else window.open(url, '_blank', 'noopener,noreferrer'); return; }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return;
    if (onNavigate) onNavigate(target, record.path);
    else { const found = resolveLink(target, record.path, Object.keys(files)); if (found) onOpen?.(found); }
  };
  if (kind === 'link' || typeof value === 'string' && /^\[\[[\s\S]+\]\]$/.test(value)) {
    const raw = typeof value === 'string' ? value.slice(2, -2) : String(value.path).replace(/^\[\[|\]\]$/g, '');
    const [target, alias] = raw.split('|'), label = typeof value === 'string' ? alias || target : value.display || alias || target;
    return <button className="vd-base-file" onClick={() => navigate(target)} title={target}><Link2 size={13} />{label}</button>;
  }
  if (kind === 'image') return <BaseImage value={value} resolveAsset={resolveAsset} sourcePath={record.path} files={files} />;
  if (kind === 'html') return <div className="vd-base-html"><CanvasMarkdown text={value.path} path={record.path} files={files} resolveAsset={resolveAsset} onNavigate={navigate} onExternal={navigate} /></div>;
  if (kind === 'icon') {
    const Icon = ({ 'file-text': FileText, 'link': Link2, 'check': Check, 'x': X, 'plus': Plus, 'minus': Minus, 'search': Search, 'table': Table2, 'arrow-down': ArrowDown, 'arrow-up': ArrowUp, 'external-link': ExternalLink, 'square': Square, 'network': Network, 'alert-circle': AlertCircle, 'code': Code2 })[value.path];
    return Icon ? <Icon size={17} aria-label={value.path} /> : <span className="vd-muted" title="此图标尚未收录">{value.path}</span>;
  }
  if (Array.isArray(value)) return <span className="vd-base-tags">{value.map((item, index) => <span key={index}><BaseValue value={item} record={record} onOpen={onOpen} onNavigate={onNavigate} resolveAsset={resolveAsset} files={files} /></span>)}</span>;
  if (typeof value === 'boolean') return <input type="checkbox" checked={value} readOnly aria-label={String(value)} />;
  return <span title={displayValue(value)}>{displayValue(value) || <span className="vd-muted">—</span>}</span>;
}

const cellType = value => Array.isArray(value) ? 'list' : typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : value && typeof value === 'object' ? 'json' : /^\d{4}-\d{2}-\d{2}T/.test(value || '') ? 'datetime' : /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? 'date' : 'text';
function BaseCell({ record, column, cell, editable, onSave, ...renderProps }) {
  const rawValue = record.props[column.replace(/^note\./, '')], [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [type, setType] = useState('text'), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const begin = () => { if (!editable) return; const next = cellType(rawValue); setType(next); setDraft(next === 'list' || next === 'json' ? JSON.stringify(rawValue) : displayValue(rawValue)); setError(''); setEditing(true); };
  const commit = async (forced, useForced = false) => {
    try {
      let next = forced;
      if (!useForced) {
        if (type === 'number') { next = draft.trim() === '' ? null : Number(draft); if (next !== null && !Number.isFinite(next)) throw new Error('请输入有效数字。'); }
        else if (type === 'checkbox') next = draft === 'true';
        else if (type === 'list' || type === 'json') { next = JSON.parse(draft || (type === 'list' ? '[]' : '{}')); if (type === 'list' && !Array.isArray(next)) throw new Error('列表需要 JSON 数组，例如 ["标签一","标签二"]。'); }
        else next = draft;
      }
      setSaving(true); await onSave(record, column, next); setEditing(false); setError('');
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  };
  if (editing) return <div className="vd-base-cell-editor" onKeyDown={event => { if (event.key === 'Escape') setEditing(false); if (event.key === 'Enter' && (type !== 'json' && type !== 'list' || event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); } }}>
    <select aria-label={'单元格类型 ' + column} value={type} onChange={event => { const next = event.target.value; setType(next); if (next === 'list') setDraft(JSON.stringify(Array.isArray(rawValue) ? rawValue : rawValue == null ? [] : [rawValue])); if (next === 'json') setDraft(JSON.stringify(rawValue ?? {})); if (next === 'checkbox') setDraft(rawValue === true ? 'true' : 'false'); }}>
      <option value="text">文本</option><option value="number">数字</option><option value="checkbox">复选框</option><option value="list">列表</option><option value="date">日期</option><option value="datetime">日期时间</option><option value="json">JSON</option>
    </select>
    {type === 'checkbox' ? <select aria-label={'单元格值 ' + column} value={draft} onChange={event => setDraft(event.target.value)}><option value="false">false</option><option value="true">true</option></select> : <input autoFocus type={type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : 'text'} aria-label={'单元格值 ' + column} value={draft} onChange={event => setDraft(event.target.value)} />}
    <IconButton label="保存单元格" disabled={saving} onClick={() => commit()}><Check size={14} /></IconButton><IconButton label="取消单元格编辑" disabled={saving} onClick={() => setEditing(false)}><X size={14} /></IconButton>{error && <small className="vd-error">{error}</small>}
  </div>;
  if (cell.error) return <span className="vd-base-cell-error" title={cell.error}>⚠ {cell.error}</span>;
  if (column === 'file.name' || column === 'file.path') return <button className="vd-base-file" onClick={() => renderProps.onOpen?.(record.path)} title={record.path}><FileText size={14} />{displayValue(cell.value)}</button>;
  if (editable && typeof rawValue === 'boolean') return <span className="vd-base-checkbox"><input type="checkbox" checked={rawValue} disabled={saving} aria-label={'编辑 ' + record.path + ' ' + column} onChange={event => commit(event.target.checked, true)} />{error && <small className="vd-error">{error}</small>}</span>;
  return <div className={'vd-base-cell-content' + (editable ? ' editable' : '')} onDoubleClick={begin}><BaseValue value={cell.value} record={record} {...renderProps} />{editable && <button className="vd-base-edit-cell" aria-label={'编辑 ' + record.path + ' ' + column} title="编辑属性" onClick={begin}>✎</button>}{error && <small className="vd-error">{error}</small>}</div>;
}

export function BasesView({ value = '', onChange, files = {}, onOpen, onEditFile, path = '', metadata = emptyMetadata, onNavigate, resolveAsset }) {
  const { config, error: parseError } = useMemo(() => parseBase(value), [value]), error = parseError || baseConfigurationError(config);
  const [selectedView, setSelectedView] = useState(0), [search, setSearch] = useState(''), [source, setSource] = useState(false), [sourceText, setSourceText] = useState(value), [sourceError, setSourceError] = useState('');
  const [panel, setPanel] = useState(''), [filterProperty, setFilterProperty] = useState('file.name'), [filterOperator, setFilterOperator] = useState('contains'), [filterValue, setFilterValue] = useState(''), [filterScope, setFilterScope] = useState('view'), [filterLogic, setFilterLogic] = useState('and');
  const [newColumn, setNewColumn] = useState(''), [formulaName, setFormulaName] = useState(''), [formulaText, setFormulaText] = useState(''), [actionError, setActionError] = useState(''), [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const validViews = Array.isArray(config.views) ? config.views.filter(view => view && typeof view === 'object' && !Array.isArray(view)) : [], views = validViews.length ? validViews : [{ type: 'table', name: '表格' }];
  const index = Math.min(selectedView, views.length - 1), current = views[index], sort = current.sort || [];
  const records = useMemo(() => baseRecords(files, metadata), [files, metadata]);
  const randomValues = useMemo(() => new Map(), [path, index]);
  const options = useMemo(() => ({ formulas: config.formulas || {}, summaries: config.summaries || {}, records, thisRecord: records.find(record => record.path === path), now: new Date(), randomValues }), [config.formulas, config.summaries, records, path, randomValues]);
  const properties = useMemo(() => [...new Set(['file.name', 'file.basename', 'file.folder', 'file.path', 'file.ext', 'file.size', 'file.tags', 'file.links', 'file.embeds', 'file.backlinks', ...(records.some(record => record.file.ctime) ? ['file.ctime'] : []), ...(records.some(record => record.file.mtime) ? ['file.mtime'] : []), ...records.flatMap(record => Object.keys(record.props)), ...Object.keys(config.formulas || {}).map(name => 'formula.' + name)])], [records, config.formulas]);
  const columns = Array.isArray(current.order) ? [...new Set(current.order.filter(column => typeof column === 'string' && column.trim()))] : ['file.name', ...properties.filter(p => !p.startsWith('file.') && !p.startsWith('formula.')).slice(0, 5), ...Object.keys(config.formulas || {}).map(name => 'formula.' + name), 'file.folder'];
  const label = column => config.properties?.[column]?.displayName || ({ 'file.name': '文件', 'file.basename': '名称', 'file.folder': '文件夹', 'file.ext': '类型', 'file.size': '大小', 'file.path': '路径', 'file.tags': '标签', 'file.links': '链接' })[column] || column.replace(/^note\./, '');
  const result = useMemo(() => {
    if (error) return { rows: [], groups: [], failure: '', cells: new Map(), totals: {} };
    let failure = '';
    let rows = records.filter(record => { try { return matchesBaseFilter(config.filters, record, options) && matchesBaseFilter(current.filters, record, options); } catch (issue) { failure = issue.message; return false; } });
    const cells = new Map();
    const getCell = (record, column) => {
      const key = record.path + '\u0000' + column;
      if (!cells.has(key)) { try { cells.set(key, { value: propertyValue(record, column, options) }); } catch (issue) { cells.set(key, { value: null, error: issue.message }); } }
      return cells.get(key);
    };
    const query = search.toLocaleLowerCase().trim();
    if (query) rows = rows.filter(record => record.path.toLocaleLowerCase().includes(query) || [...Object.keys(record.props), ...columns].some(column => displayValue(getCell(record, column).value).toLocaleLowerCase().includes(query)));
    try { if (sort.length) rows = sortBaseRecords(rows, sort, options); } catch (issue) { failure = issue.message; }
    if (Number.isInteger(current.limit) && current.limit > 0) rows = rows.slice(0, current.limit);
    let groups = [{ key: '', value: null, rows }];
    try { groups = groupBaseRecords(rows, current.groupBy, current.groupOrder, options); } catch (issue) { failure = issue.message; }
    rows = groups.flatMap(group => group.rows);
    for (const record of rows) for (const column of columns) getCell(record, column);
    const totals = {};
    for (const [column, name] of Object.entries(current.summaries || {})) { try { totals[column] = { value: summarizeBaseValues(name, rows.map(record => { const cell = getCell(record, column); if (cell.error) throw new Error(cell.error); return cell.value; }), options) }; } catch (issue) { totals[column] = { error: issue.message }; } }
    return { rows, groups, failure, cells, totals };
  }, [records, config, current, search, error, options]);
  const updateConfig = next => { if (!error) onChange?.(serializeBase(next)); };
  const updateView = transform => updateConfig({ ...config, views: views.map((view, at) => at === index ? transform({ ...view }) : view) });
  const setColumns = order => updateView(view => ({ ...view, order }));
  const sortBy = (property, multiple) => {
    const previous = sort.find(item => item.property === property), next = { ...previous, property, direction: previous?.direction === 'ASC' ? 'DESC' : 'ASC' };
    updateView(view => ({ ...view, sort: multiple ? previous ? sort.map(item => item.property === property ? next : item) : [...sort, next] : [next] }));
  };
  const addFilter = () => {
    if (error) return;
    try {
      const prefix = filterProperty.startsWith('file.') ? 'file' : filterProperty.startsWith('formula.') ? 'formula' : 'note', key = filterProperty.replace(/^(?:file|note|formula)\./, ''), property = prefix + '[' + JSON.stringify(key) + ']';
      const literal = /^-?\d+(\.\d+)?$/.test(filterValue) || /^(true|false|null)$/.test(filterValue) ? filterValue : JSON.stringify(filterValue);
      const expression = filterOperator === 'isEmpty' ? property + '.isEmpty()' : ['contains', 'startsWith', 'endsWith'].includes(filterOperator) ? property + '.' + filterOperator + '(' + JSON.stringify(filterValue) + ')' : property + ' ' + filterOperator + ' ' + literal;
      parseBaseExpression(expression);
      const old = filterScope === 'global' ? config.filters : current.filters, next = { [filterLogic]: [...(old ? [old] : []), expression] };
      if (filterScope === 'global') updateConfig({ ...config, filters: next }); else updateView(view => ({ ...view, filters: next }));
      setFilterValue(''); setActionError('');
    } catch (issue) { setActionError(issue.message); }
  };
  const clearFilter = () => { if (filterScope === 'global') { const next = { ...config }; delete next.filters; updateConfig(next); } else updateView(view => { delete view.filters; return view; }); };
  const saveFormula = () => {
    try {
      const name = formulaName.trim().replace(/^formula\./, ''); if (!name || ['constructor', '__proto__', 'prototype'].includes(name)) throw new Error('请输入有效公式名称。');
      parseBaseExpression(formulaText);
      updateConfig({ ...config, formulas: { ...config.formulas, [name]: formulaText }, views: views.map((view, at) => at === index ? { ...view, order: [...new Set([...columns, 'formula.' + name])] } : view) });
      setActionError('');
    } catch (issue) { setActionError(issue.message); }
  };
  const saveCell = async (record, column, next) => {
    if (!onEditFile || !/\.md$/i.test(record.path)) throw new Error('此文件属性不可编辑。');
    if (!Object.hasOwn(files, record.path)) throw new Error('文件已移除，请重新打开 Base。');
    await onEditFile(record.path, updateBaseProperty(files[record.path], column, next));
  };
  const openSource = () => { setSourceText(value); setSourceError(''); setSource(true); };
  const applySource = () => { const parsed = parseBase(sourceText), issue = parsed.error || baseConfigurationError(parsed.config); if (issue) setSourceError(issue); else { onChange?.(sourceText); setSource(false); setSourceError(''); } };
  const summaryNames = ['Count', 'Average', 'Sum', 'Min', 'Max', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique', ...Object.keys(config.summaries || {})];
  return <div className="vd-base vd-view">
    <div className="vd-base-toolbar"><div className="vd-base-tabs">{views.map((view, at) => <button key={at} className={at === index ? 'active' : ''} onClick={() => { setSelectedView(at); setCollapsedGroups(new Set()); }}><Table2 size={15} />{typeof view.name === 'string' ? view.name : '视图 ' + (at + 1)}</button>)}</div><div className="vd-base-actions">
      <button disabled={!!error} onClick={() => setPanel(panel === 'filter' ? '' : 'filter')}><Settings2 size={14} />筛选</button><button disabled={!!error} onClick={() => setPanel(panel === 'columns' ? '' : 'columns')}>属性</button><button disabled={!!error} onClick={() => setPanel(panel === 'formulas' ? '' : 'formulas')}>公式</button><IconButton label="编辑 Base 配置" onClick={openSource}><Code2 size={17} /></IconButton>
    </div></div>
    <div className="vd-base-search"><div className="vd-search-field"><Search size={15} /><input aria-label="搜索数据库记录" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索文件或属性…" />{search && <IconButton label="清空搜索" onClick={() => setSearch('')}><X size={13} /></IconButton>}</div><label className="vd-base-group-control">分组<select aria-label="分组属性" disabled={!!error} value={current.groupBy?.property || ''} onChange={event => updateView(view => { if (event.target.value) view.groupBy = { ...view.groupBy, property: event.target.value, direction: view.groupBy?.direction || 'ASC' }; else delete view.groupBy; delete view.groupOrder; return view; })}><option value="">无</option>{[...new Set([...properties, ...columns])].map(property => <option key={property} value={property}>{label(property)}</option>)}</select>{current.groupBy && <IconButton label="切换分组排序方向" onClick={() => updateView(view => ({ ...view, groupBy: { ...view.groupBy, direction: view.groupBy.direction === 'DESC' ? 'ASC' : 'DESC' } }))}>{current.groupBy.direction === 'DESC' ? <ArrowDown size={13} /> : <ArrowUp size={13} />}</IconButton>}</label><span className="vd-muted">{result.rows.length} 个文件</span></div>
    {panel === 'filter' && <div className="vd-base-filter"><select aria-label="筛选范围" value={filterScope} onChange={event => setFilterScope(event.target.value)}><option value="view">此视图</option><option value="global">所有视图</option></select><select aria-label="筛选逻辑" value={filterLogic} onChange={event => setFilterLogic(event.target.value)}><option value="and">全部满足</option><option value="or">任一满足</option><option value="not">均不满足</option></select><select aria-label="筛选属性" value={filterProperty} onChange={event => setFilterProperty(event.target.value)}>{[...new Set([...properties, ...columns])].map(property => <option key={property}>{property}</option>)}</select><select aria-label="筛选运算符" value={filterOperator} onChange={event => setFilterOperator(event.target.value)}><option value="contains">包含</option><option value="==">等于</option><option value="!=">不等于</option><option value=">">大于</option><option value=">=">大于等于</option><option value="<">小于</option><option value="<=">小于等于</option><option value="startsWith">开头为</option><option value="endsWith">结尾为</option><option value="isEmpty">为空</option></select>{filterOperator !== 'isEmpty' && <input aria-label="筛选值" placeholder="值" value={filterValue} onChange={event => setFilterValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addFilter(); }} />}<button className="vd-primary-button" onClick={addFilter}>添加筛选</button><button onClick={clearFilter}>清除此范围筛选</button><code className="vd-base-filter-code">{JSON.stringify(filterScope === 'global' ? config.filters : current.filters) || '无筛选条件'}</code></div>}
    {panel === 'columns' && <div className="vd-base-config-panel"><div className="vd-base-column-list">{[...new Set([...columns, ...properties])].map(column => <div key={column}><label><input type="checkbox" checked={columns.includes(column)} onChange={event => setColumns(event.target.checked ? [...columns, column] : columns.filter(item => item !== column))} />{column}</label>{columns.includes(column) && <><input aria-label={'显示名称 ' + column} placeholder={label(column)} defaultValue={config.properties?.[column]?.displayName || ''} key={value + column} onBlur={event => { if (event.target.value !== (config.properties?.[column]?.displayName || '')) updateConfig({ ...config, properties: { ...config.properties, [column]: { ...config.properties?.[column], displayName: event.target.value } } }); }} /><IconButton label={'前移列 ' + column} disabled={columns.indexOf(column) === 0} onClick={() => { const next = [...columns], at = next.indexOf(column); [next[at - 1], next[at]] = [next[at], next[at - 1]]; setColumns(next); }}><ArrowUp size={13} /></IconButton><IconButton label={'后移列 ' + column} disabled={columns.indexOf(column) === columns.length - 1} onClick={() => { const next = [...columns], at = next.indexOf(column); [next[at + 1], next[at]] = [next[at], next[at + 1]]; setColumns(next); }}><ArrowDown size={13} /></IconButton></>}</div>)}</div><div className="vd-base-new-column"><input aria-label="新增属性列" value={newColumn} onChange={event => setNewColumn(event.target.value)} placeholder="新增笔记属性名" /><button onClick={() => { const column = newColumn.trim(); if (column && !['__proto__', 'constructor', 'prototype'].includes(column)) { setColumns([...new Set([...columns, column])]); setNewColumn(''); } }}>添加列</button><button onClick={() => updateView(view => { delete view.sort; return view; })}>清除排序</button></div></div>}
    {panel === 'formulas' && <div className="vd-base-config-panel"><div className="vd-base-formula-list">{Object.entries(config.formulas || {}).map(([name, expression]) => <button key={name} onClick={() => { setFormulaName(name); setFormulaText(expression); }}>{name}</button>)}</div><div className="vd-base-formula-editor"><input aria-label="公式名称" value={formulaName} onChange={event => setFormulaName(event.target.value)} placeholder="公式名称" /><input aria-label="公式表达式" value={formulaText} onChange={event => setFormulaText(event.target.value)} placeholder={'例如 (price * quantity).toFixed(2)'} spellCheck="false" /><button className="vd-primary-button" onClick={saveFormula}>保存公式</button></div><small className="vd-muted">使用 formula.名称 引用其他公式。数字、日期、列表计算和条件函数均可用于筛选。</small></div>}
    {(error || result.failure || actionError) && <div className="vd-error"><AlertCircle size={15} />{error || result.failure || actionError}</div>}
    {typeof current.type === 'string' && current.type !== 'table' && <div className="vd-base-notice">“{current.type}” 布局尚未实现，当前使用表格展示同一组文件。</div>}
    {current.groupOrder && <div className="vd-base-notice">当前配置仅展示 groupOrder 指定的分组。<button onClick={() => updateView(view => { delete view.groupOrder; return view; })}>显示全部分组</button></div>}
    {!!sort.length && <div className="vd-base-sort-hint">排序：{sort.map(item => label(item.property) + (item.direction === 'DESC' ? ' ↓' : ' ↑')).join(' · ')}<span>Shift + 点击列标题可增加排序条件</span></div>}
    <div className="vd-base-table-wrap"><table className="vd-base-table"><thead><tr><th className="vd-row-number">#</th>{columns.map(column => <th key={column}><button disabled={!!error} onClick={event => sortBy(column, event.shiftKey)}><span>{label(column)}</span>{sort.some(item => item.property === column) && (sort.find(item => item.property === column).direction === 'DESC' ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}</button></th>)}</tr></thead><tbody>
      {result.groups.map(group => <React.Fragment key={group.key}>{current.groupBy && <tr className="vd-base-group-row"><td colSpan={columns.length + 1}><button onClick={() => setCollapsedGroups(old => { const next = new Set(old); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })} aria-expanded={!collapsedGroups.has(group.key)}><span>{collapsedGroups.has(group.key) ? '›' : '⌄'}</span>{displayValue(group.value) || '空'}<span className="vd-muted">{group.rows.length}</span></button></td></tr>}{!collapsedGroups.has(group.key) && group.rows.map(record => <tr key={record.path}><td className="vd-row-number">{result.rows.indexOf(record) + 1}</td>{columns.map(column => <td key={column}><BaseCell record={record} column={column} cell={result.cells.get(record.path + '\u0000' + column) || { value: null }} editable={!!onEditFile && /\.md$/i.test(record.path) && !record.error && !column.startsWith('file.') && !column.startsWith('formula.') && !error} onSave={saveCell} onOpen={onOpen} onNavigate={onNavigate} resolveAsset={resolveAsset} files={files} /></td>)}</tr>)}</React.Fragment>)}
    </tbody><tfoot><tr><td className="vd-row-number">∑</td>{columns.map(column => <td key={column}><select aria-label={'汇总 ' + column} disabled={!!error} value={current.summaries?.[column] || ''} onChange={event => updateView(view => { const summaries = { ...view.summaries }; if (event.target.value) summaries[column] = event.target.value; else delete summaries[column]; return { ...view, summaries }; })}><option value="">汇总</option>{summaryNames.map(name => <option key={name}>{name}</option>)}</select>{result.totals[column] && <strong className={result.totals[column].error ? 'vd-base-cell-error' : ''} title={result.totals[column].error}>{result.totals[column].error ? '⚠' : displayValue(result.totals[column].value)}</strong>}</td>)}</tr></tfoot></table>{!result.rows.length && !error && !result.failure && <Empty>没有符合条件的文件。</Empty>}</div>
    <footer className="vd-base-footer"><span>{onEditFile ? '双击笔记属性或点击编辑按钮保存到原文件。公式与文件属性为只读。' : '文件属性来自笔记 YAML。'} </span><button onClick={openSource}>配置视图 <CornerDownRight size={13} /></button></footer>
    {source && <div className="vd-base-source"><header><strong>Base YAML 配置</strong><IconButton label="关闭配置" onClick={() => setSource(false)}><X size={18} /></IconButton></header><textarea value={sourceText} onChange={event => setSourceText(event.target.value)} spellCheck="false" aria-label="Base YAML 配置" /><p className="vd-muted">表格支持公式、嵌套筛选、多列排序、分组与汇总。正则表达式和其他布局尚未实现；日期格式支持常用年月日与时间标记。</p>{sourceError && <div className="vd-error">{sourceError}</div>}<button className="vd-primary-button" onClick={applySource}><Check size={16} />应用并保存</button></div>}
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
