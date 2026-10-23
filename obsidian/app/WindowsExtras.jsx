import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, Code2, ExternalLink, FileText, Folder, FolderPlus, GripVertical, Hash, Heading, Link2, Maximize, Minimize, MoreHorizontal, Move, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { MARKDOWN_CONVERSION_OPTIONS, addBookmark, bookmarkKind, bookmarkLabel, bookmarkTarget, createMarkdownConversionPlan, flattenBookmarks, moveBookmark, normalizeBookmarks, removeBookmark, splitSlides, updateBookmark, validateBookmark } from '../core/windows-extras.mjs';
import { parseMarkdown } from '../core/vault.mjs';
import { hydrateMarkdown, renderMarkdown } from './markdown.js';
import './windows-extras.css';

const bookmarkKinds = { file: '文件', heading: '标题', block: '内容块', search: '搜索', url: '网页', group: '分组' };
const bookmarkIcons = { file: FileText, heading: Heading, block: Hash, search: Search, url: ExternalLink, group: Folder };
const getPaths = files => (Array.isArray(files) ? files.map(item => typeof item === 'string' ? item : item?.path) : Object.keys(files || {})).filter(Boolean);
const errorMessage = error => error?.message || String(error);

function SmallButton({ label, children, ...props }) {
  return <button type="button" className="wx-icon-button" title={label} aria-label={label} {...props}>{children}</button>;
}

function ExtrasError({ children }) {
  return children ? <p className="wx-error" role="alert">{children}</p> : null;
}

/** Controlled bookmark editor. Persist the complete tree received by onChange. */
export function BookmarksPanel({ items = [], onChange, onOpen, files = {}, activePath = '', activeHeading = '', activeBlock = '', searchQuery = '' }) {
  const normalized = useMemo(() => {
    try { return { items: normalizeBookmarks(items), error: '' }; }
    catch (error) { return { items: [], error: errorMessage(error) }; }
  }, [items]);
  const tree = normalized.items;
  const flat = useMemo(() => flattenBookmarks(tree), [tree]);
  const rowsById = useMemo(() => new Map(flat.map(row => [row.item.id, row])), [flat]);
  const paths = useMemo(() => getPaths(files).sort((a, b) => a.localeCompare(b, 'zh-CN')), [files]);
  const [query, setQuery] = useState(''), [menu, setMenu] = useState(null), [form, setForm] = useState(null), [draft, setDraft] = useState(null);
  const [parentId, setParentId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dragged, setDragged] = useState(null), [drop, setDrop] = useState(null);
  const callbacks = useRef({ onChange, onOpen }); callbacks.current = { onChange, onOpen };
  const id = useId().replace(/:/g, '');
  const editable = !!onChange && !busy && !normalized.error;
  const persist = async next => {
    if (!callbacks.current.onChange || busy) return false;
    setBusy(true); setError(''); setNotice('');
    try { await callbacks.current.onChange(next); setNotice('书签已更新。'); return true; }
    catch (reason) { setError(errorMessage(reason)); return false; }
    finally { setBusy(false); }
  };
  const change = async operation => {
    try { return await persist(operation()); }
    catch (reason) { setError(errorMessage(reason)); return false; }
  };
  const beginAdd = (type = 'file', parent = '') => {
    setForm({ mode: 'add' }); setParentId(parent); setMenu(null); setError(''); setNotice('');
    setDraft({ type, title: '', path: activePath, subpath: type === 'heading' && activeHeading ? `#${activeHeading.replace(/^#/, '')}` : type === 'block' && activeBlock ? `#^${activeBlock.replace(/^#?\^?/, '')}` : '', query: searchQuery, url: '' });
  };
  const beginEdit = item => { setForm({ mode: 'edit', id: item.id }); setDraft({ ...item, type: bookmarkKind(item) }); setMenu(null); setError(''); setNotice(''); };
  const beginMove = item => { setForm({ mode: 'move', id: item.id }); setDraft(item); setParentId(rowsById.get(item.id)?.parentId || ''); setMenu(null); setError(''); setNotice(''); };
  const closeForm = () => { if (!busy) { setForm(null); setDraft(null); setError(''); } };
  const groups = flat.filter(row => row.item.type === 'group');
  const forbiddenParents = new Set(form?.mode === 'move' && draft?.type === 'group' ? [draft.id, ...flattenBookmarks(draft.items || []).filter(row => row.item.type === 'group').map(row => row.item.id)] : []);
  const save = async event => {
    event?.preventDefault();
    if (!draft || !editable) return;
    let succeeded;
    if (form.mode === 'move') succeeded = await change(() => moveBookmark(tree, form.id, parentId || null));
    else {
      const cleaned = { ...draft, title: draft.title.trim() };
      if (['file', 'heading', 'block'].includes(cleaned.type)) cleaned.path = (cleaned.path || '').trim();
      if (cleaned.type === 'url') cleaned.url = cleaned.url.trim();
      if (cleaned.type === 'search') cleaned.query = cleaned.query.trim();
      succeeded = await change(() => form.mode === 'edit' ? updateBookmark(tree, form.id, cleaned) : addBookmark(tree, cleaned, parentId || null));
    }
    if (succeeded) { setForm(null); setDraft(null); }
  };
  const remove = async item => {
    setMenu(null);
    if (item.type === 'group' && item.items.length) { setForm({ mode: 'delete', id: item.id }); setDraft(item); setError(''); }
    else await change(() => removeBookmark(tree, item.id));
  };
  const reorder = (item, direction) => {
    const row = rowsById.get(item.id);
    setMenu(null); change(() => moveBookmark(tree, item.id, row.parentId, row.index + direction));
  };
  const open = async item => {
    setMenu(null); setError('');
    if (item.type === 'group') { await change(() => updateBookmark(tree, item.id, { collapsed: !item.collapsed })); return; }
    try { await callbacks.current.onOpen?.(item); }
    catch (reason) { setError(errorMessage(reason)); }
  };
  const matchesQuery = item => !query.trim() || `${bookmarkLabel(item)} ${bookmarkTarget(item)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || item.type === 'group' && item.items.some(matchesQuery);
  const dragOver = (event, item) => {
    if (!dragged || !editable) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect(), fraction = (event.clientY - bounds.top) / bounds.height;
    setDrop({ id: item.id, position: item.type === 'group' && fraction > .25 && fraction < .75 ? 'inside' : fraction > .5 ? 'after' : 'before' });
  };
  const acceptDrop = async (event, item) => {
    event.preventDefault(); event.stopPropagation();
    const source = rowsById.get(dragged), target = rowsById.get(item.id), position = drop?.id === item.id ? drop.position : 'after';
    setDragged(null); setDrop(null);
    if (!source || !target || source.item.id === item.id || !editable) return;
    if (position === 'inside') await change(() => moveBookmark(tree, source.item.id, item.id));
    else {
      const index = target.index + (position === 'after' ? 1 : 0) - (source.parentId === target.parentId && source.index < target.index ? 1 : 0);
      await change(() => moveBookmark(tree, source.item.id, target.parentId, index));
    }
  };
  const renderList = (list, depth = 0) => <ul className="wx-bookmark-list">{list.filter(matchesQuery).map(item => {
    const kind = bookmarkKind(item), Icon = bookmarkIcons[kind] || Bookmark, row = rowsById.get(item.id), parent = row.parentId ? rowsById.get(row.parentId)?.item : null;
    const expanded = item.type === 'group' && (!item.collapsed || !!query.trim());
    const invalid = validateBookmark(item), dropClass = drop?.id === item.id ? ` drop-${drop.position}` : '';
    return <li key={item.id} className={`wx-bookmark-item${dragged === item.id ? ' dragging' : ''}`}>
      <div className={`wx-bookmark-row${dropClass}`} style={{ '--bookmark-depth': depth }} draggable={editable && !query.trim()} onDragStart={event => { setDragged(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); }} onDragEnd={() => { setDragged(null); setDrop(null); }} onDragOver={event => dragOver(event, item)} onDrop={event => acceptDrop(event, item)} onContextMenu={event => { event.preventDefault(); setMenu(menu === item.id ? null : item.id); }}>
        <button type="button" className="wx-bookmark-open" title={item.type === 'group' ? bookmarkLabel(item) : `${bookmarkKinds[kind] || kind} · ${bookmarkTarget(item)}`} aria-label={`${item.type === 'group' ? expanded ? '折叠分组' : '展开分组' : '打开书签'} ${bookmarkLabel(item)}`} aria-expanded={item.type === 'group' ? expanded : undefined} disabled={busy || (item.type !== 'group' && (!!invalid || !onOpen))} onClick={() => open(item)}>
          {item.type === 'group' ? expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/> : <span className="wx-bookmark-indent"/>}<Icon size={15}/><span>{bookmarkLabel(item)}</span>{item.type === 'group' && <small>{item.items.length}</small>}
        </button>
        <SmallButton label={`操作书签 ${bookmarkLabel(item)}`} aria-expanded={menu === item.id} disabled={busy} onClick={() => setMenu(menu === item.id ? null : item.id)}><MoreHorizontal size={15}/></SmallButton>
      </div>
      {menu === item.id && <div className="wx-bookmark-menu" role="group" aria-label={`${bookmarkLabel(item)} 的操作`}>
        {invalid && <ExtrasError>{invalid}</ExtrasError>}
        <button type="button" disabled={!editable} onClick={() => beginEdit(item)}><Pencil size={13}/>编辑与重命名</button>
        {item.type === 'group' && <button type="button" disabled={!editable} onClick={() => beginAdd('file', item.id)}><Plus size={13}/>在分组中添加</button>}
        <div className="wx-bookmark-order"><button type="button" disabled={!editable || row.index === 0} onClick={() => reorder(item, -1)}><ArrowUp size={13}/>上移</button><button type="button" disabled={!editable || row.index >= (parent?.items || tree).length - 1} onClick={() => reorder(item, 1)}><ArrowDown size={13}/>下移</button></div>
        <button type="button" disabled={!editable} onClick={() => beginMove(item)}><Move size={13}/>移动到分组…</button>
        <button type="button" className="wx-danger" disabled={!editable} onClick={() => remove(item)}><Trash2 size={13}/>移除{item.type === 'group' ? '分组' : '书签'}</button>
      </div>}
      {expanded && renderList(item.items, depth + 1)}
    </li>;
  })}</ul>;
  const metadata = useMemo(() => typeof files?.[draft?.path] === 'string' ? parseMarkdown(files[draft.path]) : null, [files, draft?.path]);
  const fragmentValue = draft?.type === 'block' ? (draft.subpath || '').replace(/^#?\^?/, '') : (draft?.subpath || '').replace(/^#/, '');
  return <section className="wx-bookmarks" aria-label="书签面板" onKeyDown={event => { if (event.key === 'Escape' && (form || menu)) { event.preventDefault(); event.stopPropagation(); if (form) closeForm(); else setMenu(null); } }}>
    <div className="wx-panel-heading"><span>书签 <small>{flat.filter(row => row.item.type !== 'group').length}</small></span><div><SmallButton label="添加书签" disabled={!editable} onClick={() => beginAdd()}><Plus size={16}/></SmallButton><SmallButton label="新建书签分组" disabled={!editable} onClick={() => beginAdd('group')}><FolderPlus size={16}/></SmallButton></div></div>
    {!form && <div className="wx-bookmark-search"><Search size={14}/><input aria-label="筛选书签" placeholder="筛选书签…" value={query} onChange={event => setQuery(event.target.value)}/>{query && <SmallButton label="清除书签筛选" onClick={() => setQuery('')}><X size={13}/></SmallButton>}</div>}
    {form && draft && <form className="wx-bookmark-form" onSubmit={save}>
      <div className="wx-form-heading"><strong>{form.mode === 'delete' ? '移除分组' : form.mode === 'move' ? '移动书签' : form.mode === 'edit' ? '编辑书签' : '添加书签'}</strong><SmallButton label="取消书签编辑" disabled={busy} onClick={closeForm}><X size={14}/></SmallButton></div>
      {form.mode === 'delete' ? <><p>移除“{bookmarkLabel(draft)}”及其中的 {flattenBookmarks(draft.items).length} 条书签？文件内容不受影响。</p><button className="wx-danger" type="button" disabled={!editable} onClick={async () => { if (await change(() => removeBookmark(tree, draft.id))) closeForm(); }}><Trash2 size={13}/>移除分组及书签</button></> : <>
        {form.mode === 'move' ? <p>将“{bookmarkLabel(draft)}”移动到所选分组的末尾。</p> : <>
          <label>类型<select aria-label="书签类型" value={draft.type} disabled={form.mode === 'edit' || busy} onChange={event => { const type = event.target.value; setDraft({ ...draft, type, subpath: type === 'heading' && activeHeading ? `#${activeHeading.replace(/^#/, '')}` : type === 'block' && activeBlock ? `#^${activeBlock.replace(/^#?\^?/, '')}` : '' }); }}>{Object.entries(bookmarkKinds).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>{draft.type === 'group' ? '分组名称' : '显示名称（可留空）'}<input autoFocus aria-label="书签显示名称" value={draft.title} disabled={busy} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
          {['file', 'heading', 'block'].includes(draft.type) && <label>文件路径<input aria-label="书签文件路径" list={`${id}-files`} value={draft.path || ''} disabled={busy} onChange={event => setDraft({ ...draft, path: event.target.value })} placeholder="笔记/研究.md"/><datalist id={`${id}-files`}>{paths.map(path => <option key={path} value={path}/>)}</datalist></label>}
          {['heading', 'block'].includes(draft.type) && <label>{draft.type === 'heading' ? '标题名称' : '块标识'}<input aria-label={draft.type === 'heading' ? '书签标题名称' : '书签块标识'} list={`${id}-fragments`} value={fragmentValue} disabled={busy} onChange={event => setDraft({ ...draft, subpath: `${draft.type === 'block' ? '#^' : '#'}${event.target.value.replace(/^#?\^?/, '')}` })} placeholder={draft.type === 'heading' ? '研究方法' : 'block-id'}/><datalist id={`${id}-fragments`}>{(draft.type === 'heading' ? metadata?.headings || [] : metadata?.blocks || []).map((item, index) => <option key={index} value={item.text || item.heading || item.id || item}/> )}</datalist></label>}
          {draft.type === 'search' && <label>搜索内容<input aria-label="书签搜索内容" value={draft.query || ''} disabled={busy} onChange={event => setDraft({ ...draft, query: event.target.value })} placeholder="tag:#研究"/></label>}
          {draft.type === 'url' && <label>网页地址<input aria-label="书签网页地址" value={draft.url || ''} disabled={busy} onChange={event => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com"/></label>}
        </>}
        {form.mode !== 'edit' && <label>所在分组<select aria-label="书签所在分组" value={parentId} disabled={busy} onChange={event => setParentId(event.target.value)}><option value="">顶层</option>{groups.filter(row => !forbiddenParents.has(row.item.id)).map(row => <option value={row.item.id} key={row.item.id}>{'　'.repeat(row.depth)}{bookmarkLabel(row.item)}</option>)}</select></label>}
        <div className="wx-form-actions"><button type="button" disabled={busy} onClick={closeForm}>取消</button><button type="submit" className="wx-primary" disabled={!editable}><Check size={13}/>{busy ? '保存中…' : form.mode === 'move' ? '移动' : '保存'}</button></div>
      </>}
    </form>}
    <ExtrasError>{normalized.error || error}</ExtrasError>{notice && <p className="wx-notice" role="status">{notice}</p>}
    <div className="wx-bookmark-tree" aria-busy={busy}>{renderList(tree)}</div>
    {!tree.length && !form && !normalized.error && <div className="wx-empty"><Bookmark size={28}/><p>把常用文件、标题、内容块、搜索或网页添加到书签。</p><button type="button" disabled={!editable} onClick={() => beginAdd()}><Plus size={14}/>添加书签</button></div>}
    {!!tree.length && !tree.some(matchesQuery) && <p className="wx-empty">没有匹配的书签。</p>}
    {!!tree.length && !form && <p className="wx-bookmark-hint"><GripVertical size={12}/>拖动调整顺序，或在操作菜单中移动。</p>}
  </section>;
}

/** Dialog body. Reading and applying always use the explicit file selection. */
export function MarkdownConverterDialog({ files = {}, initialPaths = [], initialPath = '', readFile, onApply, onClose }) {
  const paths = useMemo(() => getPaths(files).filter(path => /\.md$/i.test(path)).sort((a, b) => a.localeCompare(b, 'zh-CN')), [files]);
  const [selected, setSelected] = useState(() => new Set((initialPaths.length ? initialPaths : initialPath ? [initialPath] : []).filter(path => paths.includes(path))));
  const [options, setOptions] = useState(() => Object.fromEntries(MARKDOWN_CONVERSION_OPTIONS.map(option => [option.id, false])));
  const [query, setQuery] = useState(''), [plan, setPlan] = useState(null), [previewPath, setPreviewPath] = useState(''), [busy, setBusy] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [applied, setApplied] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    setSelected(value => {
      const retained = new Set([...value].filter(path => paths.includes(path)));
      return retained.size === value.size ? value : retained;
    });
  }, [paths]);
  const clearPlan = () => { generation.current++; setPlan(null); setPreviewPath(''); setApplied(false); setError(''); setNotice(''); };
  const changeSelection = values => { setSelected(new Set(values)); clearPlan(); };
  const filtered = paths.filter(path => path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selectedPaths = [...selected].filter(path => paths.includes(path));
  const enabled = MARKDOWN_CONVERSION_OPTIONS.some(option => options[option.id]);
  const preview = async () => {
    if (!enabled || !selectedPaths.length || busy) return;
    const current = ++generation.current;
    setBusy('preview'); setError(''); setNotice(''); setApplied(false); setPlan(null);
    try {
      // Non-selected entries are names only, used to resolve unique UID links.
      const contents = Object.fromEntries(paths.map(path => [path, null]));
      for (const path of selectedPaths) {
        const result = readFile ? await readFile(path) : files?.[path];
        const source = typeof result === 'string' ? result : typeof result?.text === 'string' ? result.text : null;
        if (source == null) throw new Error(`无法读取所选 Markdown 文件：${path}`);
        contents[path] = source;
        if (generation.current !== current) return;
      }
      const next = createMarkdownConversionPlan(contents, selectedPaths, options);
      if (generation.current !== current) return;
      setPlan(next); setPreviewPath(next.changes[0]?.path || next.rows[0]?.path || '');
      if (!next.changes.length) setNotice('所选文件不需要进行这些格式转换。');
    } catch (reason) { if (generation.current === current) setError(errorMessage(reason)); }
    finally { if (generation.current === current) setBusy(''); }
  };
  const apply = async () => {
    if (!plan?.changes.length || !onApply || busy || applied) return;
    const current = ++generation.current;
    setBusy('apply'); setError(''); setNotice('');
    try {
      await onApply(plan.changes.map(row => ({ path: row.path, before: row.before, after: row.after, changes: row.changes, warnings: row.warnings })));
      if (generation.current !== current) return;
      setApplied(true); setNotice(`已转换 ${plan.changes.length} 个所选文件。`);
    } catch (reason) { if (generation.current === current) setError(errorMessage(reason)); }
    finally { if (generation.current === current) setBusy(''); }
  };
  const current = plan?.rows.find(row => row.path === previewPath) || plan?.rows[0];
  return <section className="wx-converter" aria-label="Markdown 格式转换">
    <p className="wx-converter-intro">将已有笔记中的旧语法转换为当前格式。先选择文件和转换类型，再检查预览并应用。</p>
    <div className="wx-converter-settings">
      <div className="wx-converter-files"><div className="wx-converter-section-heading"><strong>转换范围</strong><span>已选 {selectedPaths.length} / {paths.length}</span></div><div className="wx-bookmark-search"><Search size={14}/><input aria-label="筛选待转换文件" value={query} disabled={!!busy} onChange={event => setQuery(event.target.value)} placeholder="搜索 Markdown 文件…"/></div>
        <div className="wx-converter-selection-actions"><button type="button" disabled={!!busy || !filtered.length} onClick={() => changeSelection([...selected, ...filtered])}>选择当前列表（{filtered.length}）</button><button type="button" disabled={!!busy || !selected.size} onClick={() => changeSelection([])}>清除选择</button></div>
        <div className="wx-converter-file-list" aria-label="选择要转换的 Markdown 文件">{filtered.map(path => <label key={path}><input type="checkbox" aria-label={`转换文件 ${path}`} checked={selected.has(path)} disabled={!!busy} onChange={event => changeSelection(event.target.checked ? [...selected, path] : [...selected].filter(value => value !== path))}/><span title={path}>{path}</span></label>)}{!filtered.length && <p className="wx-empty">{paths.length ? '没有匹配的 Markdown 文件。' : '当前知识库没有 Markdown 文件。'}</p>}</div>
      </div>
      <fieldset className="wx-converter-options" disabled={!!busy}><legend>转换类型</legend>{MARKDOWN_CONVERSION_OPTIONS.map(option => <label key={option.id}><input type="checkbox" aria-label={option.name} checked={options[option.id]} onChange={event => { setOptions({ ...options, [option.id]: event.target.checked }); clearPlan(); }}/><span><strong>{option.name}</strong><small>{option.description}</small></span></label>)}</fieldset>
    </div>
    <div className="wx-converter-preview-action"><p>未勾选的文件不会改写。围栏代码中的旧语法也会转换，内联代码保持原样。</p><button type="button" className="wx-primary" disabled={!!busy || !enabled || !selectedPaths.length} onClick={preview}><Code2 size={15}/>{busy === 'preview' ? '正在生成预览…' : '生成转换预览'}</button></div>
    <ExtrasError>{error}</ExtrasError>{notice && <p className="wx-notice" role="status">{notice}</p>}
    {plan && <div className="wx-converter-review"><div className="wx-converter-review-heading"><label>预览文件<select aria-label="选择转换预览文件" value={current?.path || ''} onChange={event => setPreviewPath(event.target.value)}>{plan.rows.map(row => <option key={row.path} value={row.path}>{row.changed ? '有更改' : '无更改'} · {row.path}</option>)}</select></label><span>{plan.changes.length} 个文件会更改</span></div>
      {current && <><div className="wx-converter-change-summary">{current.changes.length ? current.changes.map(change => <span key={change.type}>{change.label} × {change.count}</span>) : <span>此文件没有匹配的旧格式。</span>}</div>{current.warnings.length > 0 && <ul className="wx-converter-warnings">{current.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        <div className="wx-converter-diff"><label>转换前<textarea aria-label="转换前源码" readOnly value={current.before} spellCheck="false"/></label><label>转换后<textarea aria-label="转换后源码" readOnly value={current.after} spellCheck="false"/></label></div></>}
    </div>}
    <footer className="wx-converter-footer"><span>{applied ? '转换已完成。' : plan?.changes.length ? '请确认上方预览后应用。' : '所有转换选项默认关闭。'}</span><div>{onClose && <button type="button" disabled={!!busy} onClick={onClose}>{applied ? '完成' : '关闭'}</button>}<button type="button" className="wx-primary" disabled={!!busy || !plan?.changes.length || !onApply || applied} onClick={apply}><Check size={14}/>{busy === 'apply' ? '正在应用…' : applied ? '已应用' : `应用到 ${plan?.changes.length || 0} 个所选文件`}</button></div></footer>
  </section>;
}

/** Full-window presentation using the same sanitized renderer as notes. */
export function Slides({ text = '', path = '', files = {}, resolveAsset, onNavigate, navigate, onClose, initialIndex = 0 }) {
  const slides = useMemo(() => splitSlides(text), [text]);
  const [index, setIndex] = useState(Math.max(0, Math.min(slides.length - 1, initialIndex))), [fullscreen, setFullscreen] = useState(false), [error, setError] = useState('');
  const root = useRef(null), body = useRef(null), wasFullscreen = useRef(false), closing = useRef(false);
  const slideCount = useRef(slides.length); slideCount.current = slides.length;
  const callbacks = useRef({ onNavigate: onNavigate || navigate, onClose }); callbacks.current = { onNavigate: onNavigate || navigate, onClose };
  useEffect(() => { setIndex(value => Math.min(value, slides.length - 1)); }, [slides.length]);
  const rendered = useMemo(() => {
    try { return { html: renderMarkdown(slides[index] || '', { path, files }), error: '' }; }
    catch (reason) { return { html: '', error: errorMessage(reason) }; }
  }, [slides, index, path, files]);
  useEffect(() => { if (body.current) { body.current.scrollTop = 0; hydrateMarkdown(body.current, { resolveAsset }).catch(reason => setError(errorMessage(reason))); } }, [rendered.html, resolveAsset]);
  const close = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    try { if (document.fullscreenElement === root.current) await document.exitFullscreen(); }
    catch { /* Closing the presentation must remain possible. */ }
    finally { callbacks.current.onClose?.(); }
  }, []);
  const enterFullscreen = useCallback(async () => {
    setError('');
    try { if (!root.current?.requestFullscreen) throw new Error('当前环境不支持全屏，请使用最大化窗口。'); await root.current.requestFullscreen(); }
    catch (reason) { setError(`未能进入全屏：${errorMessage(reason)}`); }
  }, []);
  useEffect(() => {
    const host = root.current, previousFocus = document.activeElement;
    host?.focus();
    const onFullscreen = () => {
      const active = document.fullscreenElement === host;
      setFullscreen(active);
      if (wasFullscreen.current && !active && !closing.current) callbacks.current.onClose?.();
      wasFullscreen.current = active;
    };
    const key = event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); close(); return; }
      if (event.key === 'Tab') {
        const controls = [...(host?.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]') || [])];
        const first = controls[0], last = controls.at(-1);
        if (controls.length && (event.shiftKey ? document.activeElement === first || document.activeElement === host : document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        return;
      }
      if (/^(?:INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); setIndex(value => Math.max(0, Math.min(slideCount.current - 1, value + (event.shiftKey && (event.key === ' ' || event.key === 'Spacebar') ? -1 : 1)))); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); setIndex(value => Math.max(0, value - 1)); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); setIndex(event.key === 'Home' ? 0 : slideCount.current - 1); }
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('keydown', key, true);
      if (document.fullscreenElement === host) document.exitFullscreen().catch(() => {});
      if (previousFocus?.isConnected) previousFocus.focus?.();
    };
  }, [close]);
  const clickContent = async event => {
    const anchor = event.target.closest('a');
    if (anchor) {
      event.preventDefault(); event.stopPropagation();
      const target = anchor.dataset.noteTarget || anchor.getAttribute('href') || '';
      if (!target || (/^\s*[a-z][a-z\d+.-]*:/i.test(target) && !/^\s*(?:https?:|mailto:|obsidian:)/i.test(target))) return;
      if (target.startsWith('#') && !anchor.dataset.noteTarget) {
        let fragment = target.slice(1); try { fragment = decodeURIComponent(fragment); } catch {}
        const element = [...(body.current?.querySelectorAll('[id]') || [])].find(node => node.id === fragment);
        element?.scrollIntoView({ block: 'center' }); return;
      }
      try {
        if (callbacks.current.onNavigate) await callbacks.current.onNavigate(target);
        else if (/^(?:https?:|mailto:)/i.test(target) && window.vaultdesk?.openExternal) await window.vaultdesk.openExternal(target);
      } catch (reason) { setError(errorMessage(reason)); }
      return;
    }
    const fold = event.target.closest('.callout-title[role="button"]');
    if (fold) { const callout = fold.closest('.callout'); callout.dataset.folded = callout.dataset.folded === 'true' ? 'false' : 'true'; }
    if (event.target.matches('input.task-checkbox')) event.preventDefault();
  };
  return <section ref={root} className="wx-slides" role="dialog" aria-modal="true" aria-label="幻灯片演示" tabIndex={-1}>
    <header><div><FileText size={16}/><span>{path.split('/').pop()?.replace(/\.md$/i, '') || '幻灯片演示'}</span></div><span className="wx-slide-counter" aria-live="polite">{index + 1} / {slides.length}</span><div><SmallButton label={fullscreen ? '退出全屏并结束演示' : '进入全屏演示'} onClick={fullscreen ? close : enterFullscreen}>{fullscreen ? <Minimize size={17}/> : <Maximize size={17}/>}</SmallButton><SmallButton label="结束幻灯片演示" onClick={close}><X size={18}/></SmallButton></div></header>
    {error && <div className="wx-slide-error" role="alert">{error}<SmallButton label="关闭演示提示" onClick={() => setError('')}><X size={14}/></SmallButton></div>}
    <div className="wx-slide-stage"><button type="button" className="wx-slide-arrow previous" aria-label="上一张幻灯片" disabled={index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}><ChevronLeft size={27}/></button>
      <article ref={body} className="wx-slide-content markdown-rendered" aria-label={`第 ${index + 1} 张幻灯片`} onClick={clickContent}>{rendered.error ? <><ExtrasError>{rendered.error}</ExtrasError><pre>{slides[index]}</pre></> : <div dangerouslySetInnerHTML={{ __html: rendered.html }}/>}</article>
      <button type="button" className="wx-slide-arrow next" aria-label="下一张幻灯片" disabled={index >= slides.length - 1} onClick={() => setIndex(value => Math.min(slides.length - 1, value + 1))}><ChevronRight size={27}/></button>
    </div>
    <footer><span>← → / PageUp / PageDown / 空格翻页 · Esc 退出</span><div className="wx-slide-dots" aria-label="跳转幻灯片">{slides.length <= 24 ? slides.map((_, number) => <button type="button" key={number} aria-label={`跳转到第 ${number + 1} 张幻灯片`} aria-current={number === index ? 'step' : undefined} className={number === index ? 'active' : ''} onClick={() => setIndex(number)}/>) : <input aria-label="幻灯片页码" type="number" min={1} max={slides.length} value={index + 1} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 1) setIndex(Math.min(slides.length - 1, Math.floor(value) - 1)); }}/>}</div></footer>
    <div className="wx-slide-progress" style={{ width: `${(index + 1) / slides.length * 100}%` }}/>
  </section>;
}
