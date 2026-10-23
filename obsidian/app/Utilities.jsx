import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutDashboard, Save, Play, Trash2, Plus, Search, ArrowRight, FileText, Split, Merge, Check, AlertCircle, Keyboard, RotateCcw, X, Hash, Code2 } from 'lucide-react';
import './utilities.css';

const UtilIconButton = ({ label, children, ...props }) => <button type="button" className="vd-util-icon-button" title={label} aria-label={label} {...props}>{children}</button>;
const UtilError = ({ children }) => children ? <p className="vd-util-error" role="alert"><AlertCircle size={14} />{children}</p> : null;
const own = (object, property) => Object.prototype.hasOwnProperty.call(object || {}, property);
const fileName = path => String(path || '').split('/').pop().replace(/\.md$/i, '');

function layoutDescription(layout = {}) {
  const panes = Array.isArray(layout.panes) ? layout.panes : [];
  const paths = panes.flatMap(pane => typeof pane === 'string' ? [pane] : Array.isArray(pane?.tabs) ? pane.tabs : typeof pane?.path === 'string' ? [pane.path] : []);
  const count = paths.length || panes.length;
  const mode = { source: '源码', live: '实时预览', reading: '阅读' }[layout.mode] || '';
  return [`${panes.length || 1} 个面板`, count ? `${count} 个标签` : '', mode].filter(Boolean).join(' · ');
}

export function WorkspacesPanel({ current = {}, workspaces = {}, onSave, onLoad, onDelete }) {
  const [name, setName] = useState(''), [query, setQuery] = useState(''), [pending, setPending] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const names = Object.keys(workspaces || {}).sort((a, b) => a.localeCompare(b));
  const cleanName = name.trim(), existing = own(workspaces, cleanName);
  const run = async (key, operation, success) => {
    if (pending || !operation) return;
    setPending(key); setError(''); setMessage('');
    try { await operation(); setMessage(success); } catch (e) { setError(e?.message || String(e)); }
    finally { setPending(''); }
  };
  const save = () => {
    if (!cleanName) return;
    if (cleanName.length > 80 || ['__proto__', 'constructor', 'prototype'].includes(cleanName)) { setError('请使用 1–80 个字符的其他布局名称。'); return; }
    run('save', () => onSave?.(cleanName), existing ? `已更新“${cleanName}”。` : `已保存“${cleanName}”。`);
  };
  return <section className="vd-util vd-util-workspaces">
    <div className="vd-util-section-title"><LayoutDashboard size={18} /><div><h3>工作区布局</h3><p>保存当前标签、分屏和侧栏，随时恢复工作现场。</p></div></div>
    <div className="vd-util-current-layout"><span>当前布局</span><strong>{layoutDescription(current)}</strong></div>
    <form className="vd-util-save-form" onSubmit={event => { event.preventDefault(); save(); }}><input aria-label="工作区名称" value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="例如：阅读与写作" /><button type="submit" className="vd-util-primary" disabled={!cleanName || !!pending || !onSave}><Save size={14} />{pending === 'save' ? '保存中…' : existing ? '更新布局' : '保存布局'}</button></form>
    {existing && <p className="vd-util-help">将用当前布局更新“{cleanName}”。</p>}
    {names.length > 5 && <div className="vd-util-search"><Search size={14} /><input aria-label="搜索工作区" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索已保存的布局…" /></div>}
    <div className="vd-util-workspace-list">{names.filter(item => item.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <div key={item} className="vd-util-workspace-row"><LayoutDashboard size={17} /><div className="vd-util-workspace-info"><strong>{item}</strong><span>{layoutDescription(workspaces[item])}</span></div><button className="vd-util-secondary" disabled={!!pending || !onLoad} onClick={() => run(`load:${item}`, () => onLoad?.(item), `已恢复“${item}”。`)}><Play size={13} />{pending === `load:${item}` ? '恢复中…' : '恢复'}</button><UtilIconButton label={`删除布局 ${item}`} disabled={!!pending || !onDelete} onClick={() => run(`delete:${item}`, () => onDelete?.(item), `已删除布局“${item}”。`)}><Trash2 size={15} /></UtilIconButton></div>)}</div>
    {!names.length && <div className="vd-util-empty"><LayoutDashboard size={28} /><span>还没有保存的布局。</span></div>}
    {!!names.length && !names.some(item => item.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="vd-util-empty">没有匹配的布局。</p>}
    <UtilError>{error}</UtilError>{message && <p className="vd-util-success" role="status"><Check size={13} />{message}</p>}
  </section>;
}

function normalizedExtractPath(raw) {
  const path = String(raw || '').trim().replaceAll('\\', '/');
  if (!path) return { path: '', error: '' };
  if (/^(?:[a-zA-Z]:|\/)/.test(path) || path.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) return { path: '', error: '请输入有效的仓库相对路径，例如“摘录/新笔记.md”。' };
  return { path: /\.md$/i.test(path) ? path : `${path}.md`, error: '' };
}

export function ComposerDialogBody({ files = {}, active = '', selection = '', onExtract, onMerge }) {
  const selectedText = typeof selection === 'string' ? selection : String(selection?.text || selection?.value || '');
  const activePath = typeof active === 'string' ? active : active?.path || '';
  const initialName = activePath ? activePath.replace(/\.md$/i, '') + ' 摘录.md' : '摘录.md';
  const [mode, setMode] = useState(selectedText ? 'extract' : 'merge'), [name, setName] = useState(initialName), [query, setQuery] = useState(''), [destination, setDestination] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { setName(initialName); setDestination(''); setError(''); setMessage(''); }, [activePath]);
  const candidates = useMemo(() => Object.keys(files).filter(path => /\.md$/i.test(path) && path !== activePath).sort((a, b) => a.localeCompare(b)), [files, activePath]);
  const normalized = normalizedExtractPath(name), duplicate = normalized.path && Object.keys(files).some(path => path.toLocaleLowerCase() === normalized.path.toLocaleLowerCase());
  const pathError = normalized.error || (duplicate ? '此笔记已存在，请选择其他名称。' : '');
  const activeIsNote = /\.md$/i.test(activePath);
  const canExtract = !!(activeIsNote && selectedText.trim() && normalized.path && !pathError && onExtract);
  const canMerge = !!(activeIsNote && destination && candidates.includes(destination) && onMerge);
  const submit = async () => {
    if (busy || (mode === 'extract' ? !canExtract : !canMerge)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (mode === 'extract') { await onExtract(normalized.path); setMessage(`已提取到“${normalized.path}”。`); }
      else { await onMerge(destination); setMessage(`已合并到“${destination}”。`); }
    } catch (e) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const matches = candidates.filter(path => path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="vd-util vd-util-composer">
    <div className="vd-util-tabs" role="tablist" aria-label="笔记重组方式"><button role="tab" aria-selected={mode === 'extract'} className={mode === 'extract' ? 'active' : ''} onClick={() => { setMode('extract'); setError(''); setMessage(''); }}><Split size={15} />提取选区</button><button role="tab" aria-selected={mode === 'merge'} className={mode === 'merge' ? 'active' : ''} onClick={() => { setMode('merge'); setError(''); setMessage(''); }}><Merge size={15} />合并笔记</button></div>
    {!activeIsNote && <p className="vd-util-notice">请先打开一篇 Markdown 笔记。</p>}
    {mode === 'extract' ? <div className="vd-util-composer-content" role="tabpanel" aria-label="提取选区"><p>将选中的内容移入新笔记，并把原文选区替换为新笔记的双向链接。</p><label className="vd-util-label">新笔记路径<input aria-label="提取后的笔记路径" value={name} onChange={e => setName(e.target.value)} placeholder="摘录/新笔记.md" onKeyDown={e => { if (e.key === 'Enter') submit(); }} /></label>{pathError && <UtilError>{pathError}</UtilError>}
      <div className="vd-util-selection-header"><span>当前选区</span><span>{selectedText.length} 字符</span></div>{selectedText.trim() ? <pre className="vd-util-selection-preview">{selectedText.length > 2400 ? selectedText.slice(0, 2400) + '\n…' : selectedText}</pre> : <p className="vd-util-notice">尚未选中内容。请回到编辑器选中一段文字后打开此面板。</p>}
      {normalized.path && !pathError && <p className="vd-util-help">原文将替换为 <code>[[{normalized.path.replace(/\.md$/i, '')}]]</code>。</p>}
    </div> : <div className="vd-util-composer-content" role="tabpanel" aria-label="合并笔记"><p>把“{fileName(activePath) || '当前笔记'}”的正文追加到目标笔记。合并成功后，原笔记将移入回收站。</p><div className="vd-util-search"><Search size={14} /><input aria-label="搜索合并目标" placeholder="选择另一篇 Markdown 笔记…" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="vd-util-destination-list" role="listbox" aria-label="合并目标">{matches.map(path => <button key={path} role="option" aria-selected={destination === path} className={destination === path ? 'selected' : ''} onClick={() => setDestination(path)}><FileText size={15} /><span>{path}</span>{destination === path && <Check size={15} />}</button>)}{!matches.length && <p className="vd-util-empty">{candidates.length ? '没有匹配的笔记。' : '仓库中没有其他 Markdown 笔记。'}</p>}</div>{destination && <div className="vd-util-merge-summary"><span>{fileName(activePath)}</span><ArrowRight size={15} /><strong>{destination}</strong></div>}</div>}
    <UtilError>{error}</UtilError>{message && <p className="vd-util-success" role="status"><Check size={13} />{message}</p>}
    <div className="vd-util-actions"><button className="vd-util-primary" disabled={busy || (mode === 'extract' ? !canExtract : !canMerge)} onClick={submit}>{busy ? '处理中…' : mode === 'extract' ? <><Split size={14} />提取为新笔记</> : <><Merge size={14} />合并并回收原笔记</>}</button></div>
  </section>;
}

export function parseFootnoteDefinitions(text = '') {
  const lines = String(text).split(/\r?\n/), definitions = [], seen = new Map();
  let fence = null, frontmatter = lines[0]?.replace(/^\uFEFF/, '').trim() === '---';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontmatter) { if (i && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false; continue; }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
    if (fence) continue;
    const match = line.match(/^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/);
    if (!match) continue;
    const body = [match[2]], start = i + 1;
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (/^( {4}|\t)/.test(next)) { body.push(next.replace(/^( {4}|\t)/, '')); i++; }
      else if (!next.trim() && /^( {4}|\t)/.test(lines[i + 2] || '')) { body.push(''); i++; }
      else break;
    }
    if (seen.has(match[1])) { const index = seen.get(match[1]); definitions[index] = { ...definitions[index], duplicates: definitions[index].duplicates + 1 }; }
    else { seen.set(match[1], definitions.length); definitions.push({ id: match[1], text: body.join('\n').trim(), line: start, duplicates: 0 }); }
  }
  return definitions;
}

export function FootnotesPanel({ text = '', onNavigate }) {
  const definitions = useMemo(() => parseFootnoteDefinitions(text), [text]), [query, setQuery] = useState('');
  const rows = definitions.filter(item => `${item.id}\n${item.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="vd-util vd-util-footnotes"><div className="vd-util-panel-title"><span>脚注</span><span>{definitions.length}</span></div>{definitions.length > 5 && <div className="vd-util-search"><Search size={13} /><input aria-label="搜索脚注" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索脚注…" /></div>}
    <div className="vd-util-footnote-list">{rows.map(item => <button key={item.id} className="vd-util-footnote" onClick={() => onNavigate?.(item.id)} title={`跳转到第 ${item.line} 行的脚注定义`}><div><span><Hash size={12} />{item.id}</span><small>第 {item.line} 行</small></div><p>{item.text || '空脚注定义'}</p>{item.duplicates > 0 && <small className="vd-util-warning">另有 {item.duplicates} 处同名定义</small>}</button>)}</div>
    {!definitions.length && <div className="vd-util-empty"><Hash size={25} /><span>此笔记还没有脚注。</span><small>使用 <code>[^标识]: 脚注内容</code> 定义脚注。</small></div>}{!!definitions.length && !rows.length && <p className="vd-util-empty">没有匹配的脚注。</p>}
  </section>;
}

export function canonicalHotkey(event) {
  const key = event.key;
  if (!key || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified'].includes(key)) return '';
  const normalizedKey = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : '', normalizedKey].filter(Boolean).join('+');
}

function Hotkey({ value, recording = false }) {
  if (!value) return <span className="vd-util-unbound">{recording ? '按下组合键…' : '未设置'}</span>;
  const parts = value.endsWith('++') ? [...value.slice(0, -1).split('+').filter(Boolean), '+'] : value.split('+');
  return <span className="vd-util-keycaps">{parts.map((part, index) => <kbd key={index}>{part}</kbd>)}</span>;
}

export function HotkeysPanel({ commands = [], hotkeys = {}, onChange }) {
  const [query, setQuery] = useState(''), [recording, setRecording] = useState(null), [notice, setNotice] = useState(''), [candidate, setCandidate] = useState(null), [error, setError] = useState('');
  const commandList = useMemo(() => commands.map(command => typeof command === 'string' ? { id: command, name: command, defaultHotkey: '' } : { ...command, name: command.name || command.title || command.label || command.id }), [commands]);
  const refs = useRef({ commandList, hotkeys, onChange }); refs.current = { commandList, hotkeys, onChange };
  const effective = command => own(hotkeys, command.id) ? hotkeys[command.id] : command.defaultHotkey || '';
  const apply = next => { try { onChange?.(next); setError(''); } catch (e) { setError(e?.message || String(e)); } };
  useEffect(() => {
    if (!recording) return;
    const listener = event => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { setRecording(null); setCandidate(null); setNotice(''); return; }
      const key = canonicalHotkey(event);
      if (!key) { setNotice([event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : ''].filter(Boolean).join(' + ') + ' + …'); return; }
      const { commandList: list, hotkeys: settings, onChange: callback } = refs.current;
      if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { try { callback?.({ ...settings, [recording]: '' }); setRecording(null); setCandidate(null); setNotice('已清除此命令的快捷键。'); } catch (e) { setError(e.message); } return; }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !/^F\d{1,2}$/.test(event.key)) { setNotice('请使用 Ctrl、Shift、Alt 组合键，或功能键 F1–F24。'); return; }
      const conflicts = list.filter(command => command.id !== recording && (own(settings, command.id) ? settings[command.id] : command.defaultHotkey || '') === key);
      if (conflicts.length) { setCandidate({ id: recording, key, conflicts }); setNotice(''); return; }
      try { callback?.({ ...settings, [recording]: key }); setRecording(null); setCandidate(null); setNotice(`已设置为 ${key}。`); setError(''); } catch (e) { setError(e.message); }
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, [recording]);
  const begin = id => { setRecording(id); setCandidate(null); setNotice('按下组合键；Esc 取消，Backspace 清除。'); setError(''); };
  const restore = id => { const next = { ...hotkeys }; delete next[id]; apply(next); if (recording === id) setRecording(null); setCandidate(null); setNotice('已恢复默认快捷键。'); };
  const replaceConflict = () => { if (!candidate) return; const next = { ...hotkeys, [candidate.id]: candidate.key }; for (const command of candidate.conflicts) next[command.id] = ''; apply(next); setRecording(null); setCandidate(null); setNotice(`已设置 ${candidate.key}，原冲突命令已取消绑定。`); };
  const rows = commandList.filter(command => `${command.name} ${command.id} ${effective(command)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const duplicateKeys = useMemo(() => { const counts = new Map(); for (const command of commandList) { const key = own(hotkeys, command.id) ? hotkeys[command.id] : command.defaultHotkey || ''; if (key) counts.set(key, (counts.get(key) || 0) + 1); } return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key)); }, [commandList, hotkeys]);
  return <section className="vd-util vd-util-hotkeys"><div className="vd-util-section-title"><Keyboard size={18} /><div><h3>快捷键</h3><p>点击键位后录制。自定义设置优先于默认键位。</p></div></div>
    <div className="vd-util-hotkey-toolbar"><div className="vd-util-search"><Search size={14} /><input aria-label="搜索命令快捷键" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索命令或键位…" /></div><button className="vd-util-secondary" disabled={!Object.keys(hotkeys).length || !!recording} onClick={() => { apply({}); setNotice('所有快捷键已恢复默认值。'); }}><RotateCcw size={13} />全部重置</button></div>
    {recording && <div className="vd-util-recording" role="status"><span className="vd-util-record-dot" /><span>正在录制：{commandList.find(command => command.id === recording)?.name || recording}</span><UtilIconButton label="取消快捷键录制" onClick={() => { setRecording(null); setCandidate(null); setNotice(''); }}><X size={14} /></UtilIconButton></div>}
    {candidate && <div className="vd-util-conflict" role="alert"><AlertCircle size={16} /><div><strong>{candidate.key} 已绑定到 {candidate.conflicts.map(command => `“${command.name}”`).join('、')}</strong><p>可继续录制其他组合，或替换并停用冲突命令的原绑定。</p><button className="vd-util-secondary" onClick={replaceConflict}>替换冲突绑定</button></div></div>}
    {notice && <p className="vd-util-help" role="status">{notice}</p>}<UtilError>{error}</UtilError>
    <div className="vd-util-hotkey-list">{rows.map(command => { const key = effective(command), modified = own(hotkeys, command.id), conflict = key && duplicateKeys.has(key); return <div key={command.id} className={`vd-util-hotkey-row ${recording === command.id ? 'recording' : ''}`}><div className="vd-util-hotkey-name"><strong>{command.name}</strong><small>{conflict ? '键位冲突' : modified ? key ? '自定义' : '已停用' : command.defaultHotkey ? '默认' : '未设置'}</small></div><button className={`vd-util-hotkey-binding ${conflict ? 'conflict' : ''}`} aria-label={`设置 ${command.name} 的快捷键`} onClick={() => begin(command.id)}><Hotkey value={recording === command.id ? '' : key} recording={recording === command.id} />{!key && recording !== command.id && <Plus size={13} />}</button><UtilIconButton label={`重置 ${command.name} 的快捷键`} disabled={!modified} onClick={() => restore(command.id)}><RotateCcw size={14} /></UtilIconButton><UtilIconButton label={`清除 ${command.name} 的快捷键`} disabled={!key} onClick={() => { apply({ ...hotkeys, [command.id]: '' }); if (recording === command.id) setRecording(null); setCandidate(null); }}><X size={14} /></UtilIconButton></div>; })}</div>
    {!rows.length && <p className="vd-util-empty">没有匹配的命令。</p>}
  </section>;
}

export function AppearanceExtras({ css = '', onChange }) {
  const [draft, setDraft] = useState(css), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(css); }, [css]);
  const save = async value => { if (busy) return; setBusy(true); setError(''); setMessage(''); try { await onChange?.(value); setDraft(value); setMessage(value ? '自定义 CSS 已应用。' : '已清除自定义 CSS。'); } catch (e) { setError(e?.message || String(e)); } finally { setBusy(false); } };
  return <section className="vd-util vd-util-appearance"><div className="vd-util-section-title"><Code2 size={18} /><div><h3>自定义 CSS</h3><p>调整当前应用的颜色、字体和布局，应用后立即生效。</p></div></div><textarea aria-label="自定义 CSS" value={draft} onChange={e => { setDraft(e.target.value); setMessage(''); }} spellCheck="false" placeholder={':root {\n  --accent: #a78bfa;\n}\n\n.markdown-rendered {\n  line-height: 1.8;\n}'} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(draft); } if (e.key === 'Tab') { e.preventDefault(); const start = e.currentTarget.selectionStart, end = e.currentTarget.selectionEnd; setDraft(draft.slice(0, start) + '  ' + draft.slice(end)); const input = e.currentTarget; requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 2; }); } }} />
    <div className="vd-util-css-status"><span>{draft !== css ? '有尚未应用的更改' : css ? '当前 CSS 已应用' : '未启用自定义 CSS'}</span><span>Ctrl + Enter 应用</span></div><UtilError>{error}</UtilError>{message && <p className="vd-util-success" role="status"><Check size={13} />{message}</p>}
    <div className="vd-util-actions"><button className="vd-util-secondary" disabled={busy || (!draft && !css)} onClick={() => save('')}><RotateCcw size={13} />重置</button><button className="vd-util-primary" disabled={busy || draft === css || !onChange} onClick={() => save(draft)}><Check size={14} />{busy ? '应用中…' : '应用 CSS'}</button></div>
  </section>;
}
