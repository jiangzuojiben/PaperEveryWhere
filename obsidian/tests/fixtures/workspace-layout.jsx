import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceLayout, WorkspaceSidebar } from '../../app/WorkspaceLayout.jsx';
import { getPaneTabState, normalizeWorkspaceLayout, updateWorkspaceTabState } from '../../core/workspace.mjs';
import '../../app/style.css';

const SESSION_KEY = 'vaultdesk-layout-browser-fixture-session';
const NAMED_KEY = 'vaultdesk-layout-browser-fixture-named';
const initial = () => normalizeWorkspaceLayout({
  panes: [
    { id: 'alpha', tabs: ['Alpha.md', 'C# Basics.md'], active: 'Alpha.md', pinned: [], tabStates: { 'Alpha.md': { mode: 'source' }, 'C# Basics.md': { mode: 'source' } } },
    { id: 'beta', tabs: ['Beta.md'], active: 'Beta.md', pinned: [], tabStates: { 'Beta.md': { mode: 'reading' } } },
  ],
  layout: { id: 'initial-split', type: 'split', direction: 'vertical', children: [{ id: 'alpha', type: 'leaf' }, { id: 'beta', type: 'leaf' }], sizes: [.5, .5] },
  activePaneId: 'alpha',
  sidebars: { left: { width: 180, collapsed: false }, right: { width: 180, collapsed: false } },
});
function readStored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
const documentText = path => Array.from({ length: 180 }, (_, index) => `${String(index + 1).padStart(3, '0')} ${path} — line for cursor and scroll restoration.`).join('\n');

function NoteContent({ pane, update }) {
  const state = getPaneTabState(pane), editor = useRef(null), reader = useRef(null);
  useLayoutEffect(() => {
    if (editor.current) {
      const cursor = state.cursor || { anchor: 0, head: 0 };
      editor.current.setSelectionRange(cursor.anchor, cursor.head);
      editor.current.scrollTop = state.scroll?.top || 0;
      editor.current.scrollLeft = state.scroll?.left || 0;
    }
    if (reader.current) reader.current.scrollTop = state.readingScrollTop || 0;
  }, [pane.active, state.mode]);
  if (!pane.active) return <div className="empty-pane">Empty pane</div>;
  if (state.mode === 'reading') return <div ref={reader} className="fixture-reader" tabIndex={0} aria-label={`Reading ${pane.active}`} onScroll={event => update({ readingScrollTop: event.currentTarget.scrollTop })}>{documentText(pane.active).split('\n').map((line, index) => <p key={index}>{line}</p>)}</div>;
  return <textarea ref={editor} className="fixture-editor" aria-label={`Editor ${pane.active}`} defaultValue={documentText(pane.active)} spellCheck={false}
    onSelect={event => { const { selectionStart: anchor, selectionEnd: head } = event.currentTarget; update({ cursor: { anchor, head }, selections: [{ anchor, head }] }); }}
    onScroll={event => update({ scroll: { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft } })} />;
}

function Fixture() {
  const [workspace, setWorkspace] = useState(() => normalizeWorkspaceLayout(readStored(SESSION_KEY, initial())));
  const [named, setNamed] = useState(() => readStored(NAMED_KEY, {}));
  const [name, setName] = useState('Research');
  const [epoch, setEpoch] = useState(0);
  const [status, setStatus] = useState('Ready');
  const current = useRef(workspace); current.current = workspace;
  useEffect(() => { localStorage.setItem(SESSION_KEY, JSON.stringify(workspace)); }, [workspace]);
  const activate = id => setWorkspace(previous => ({ ...previous, activePaneId: id, paneIndex: previous.panes.findIndex(pane => pane.id === id) }));
  const sideChange = (side, patch) => setWorkspace(previous => ({ ...previous, sidebars: { ...previous.sidebars, [side]: { ...previous.sidebars[side], ...patch } } }));
  const changePane = (id, patch) => setWorkspace(previous => ({ ...previous, panes: previous.panes.map(pane => pane.id === id ? { ...pane, ...patch(pane) } : pane) }));
  const restore = () => {
    const saved = readStored(NAMED_KEY, {})[name];
    if (!saved) return setStatus('Layout not found');
    setWorkspace(normalizeWorkspaceLayout(saved)); setEpoch(value => value + 1); setStatus(`Restored ${name}`);
  };
  return <div className="app fixture">
    <header className="fixture-controls">
      <input aria-label="Layout name" value={name} onChange={event => setName(event.target.value)} />
      <button onClick={() => { const next = { ...named, [name]: current.current }; setNamed(next); localStorage.setItem(NAMED_KEY, JSON.stringify(next)); setStatus(`Saved ${name}`); }}>Save layout</button>
      <button onClick={restore}>Restore layout</button>
      <button onClick={() => { setWorkspace(initial()); setEpoch(value => value + 1); setStatus('Reset'); }}>Reset fixture</button>
      <button onClick={() => sideChange('left', { collapsed: !workspace.sidebars.left.collapsed })}>Toggle left sidebar</button>
      <button onClick={() => sideChange('right', { collapsed: !workspace.sidebars.right.collapsed })}>Toggle right sidebar</button>
      <span role="status">{status}</span>
    </header>
    <div className="workspace">
      <WorkspaceSidebar side="left" {...workspace.sidebars.left} onResize={width => sideChange('left', { width })} onCollapsedChange={collapsed => sideChange('left', { collapsed })}><aside className="left-sidebar"><h2>Files</h2><p>Alpha.md</p><p>C# Basics.md</p><p>Beta.md</p><input aria-label="Left sidebar mounted state" defaultValue="retained" /></aside></WorkspaceSidebar>
      <WorkspaceLayout key={epoch} workspace={workspace} onChange={setWorkspace} onActivate={activate} renderPane={(pane, index, controls) => {
        const state = getPaneTabState(pane);
        const update = patch => setWorkspace(previous => updateWorkspaceTabState(previous, pane.id, pane.active, patch));
        return <section className="pane" data-active-path={pane.active || ''} data-mode={state.mode}>
          <div className="tabbar" {...controls.getTabStripProps()}>
            {pane.tabs.map(path => <button key={path} className={`tab ${pane.active === path ? 'selected' : ''}`} {...controls.getTabProps(path)} aria-label={`Tab ${path}`} data-pinned={pane.pinned.includes(path) ? 'true' : 'false'} onClick={() => changePane(pane.id, () => ({ active: path }))}>{pane.pinned.includes(path) ? '📌 ' : ''}{path}</button>)}
          </div>
          <div className="fixture-pane-controls">
            <button aria-label={`Split right ${pane.id}`} onClick={() => controls.split('vertical')}>Split right</button>
            <button aria-label={`Split below ${pane.id}`} onClick={() => controls.split('horizontal')}>Split below</button>
            <button aria-label={`Close pane ${pane.id}`} onClick={controls.closePane}>Close pane</button>
            <button aria-label={`Pin ${pane.active}`} aria-pressed={pane.pinned.includes(pane.active)} disabled={!pane.active} onClick={() => changePane(pane.id, previous => ({ pinned: previous.pinned.includes(pane.active) ? previous.pinned.filter(path => path !== pane.active) : [...previous.pinned, pane.active] }))}>Pin</button>
            <select aria-label={`Mode ${pane.id}`} value={state.mode} onChange={event => update({ mode: event.target.value })}><option value="source">Source</option><option value="live">Live</option><option value="reading">Reading</option></select>
          </div>
          <NoteContent key={pane.active} pane={pane} update={update} />
        </section>;
      }} />
      <WorkspaceSidebar side="right" {...workspace.sidebars.right} onResize={width => sideChange('right', { width })} onCollapsedChange={collapsed => sideChange('right', { collapsed })}><aside className="right-sidebar"><h2>Outline</h2><p>Visible outline content</p><input aria-label="Right sidebar mounted state" defaultValue="retained" /></aside></WorkspaceSidebar>
    </div>
    <output id="workspace-state" hidden>{JSON.stringify(workspace)}</output>
    <style>{`.fixture-controls{display:flex;align-items:center;gap:8px;padding:8px;height:52px;flex-shrink:0}.fixture-controls input{width:130px}.fixture-controls button{white-space:nowrap}.fixture-controls [role=status]{margin-left:auto;color:#a68af9}.fixture .left-sidebar,.fixture .right-sidebar{padding:12px}.fixture-pane-controls{display:flex;gap:4px;padding:6px;flex-wrap:wrap;flex-shrink:0}.fixture-pane-controls button{padding:4px 6px;font-size:11px}.fixture-pane-controls select{padding:4px}.fixture-editor,.fixture-reader{display:block;flex:1;width:100%;min-height:0;overflow:auto;resize:none;margin:0;border:0;border-radius:0;padding:14px;line-height:24px;white-space:pre;font-family:monospace;font-size:13px}.fixture-reader p{margin:0 0 8px}.fixture .tabbar{overflow-x:auto;flex-shrink:0}.fixture .tab{min-width:110px;padding:0 8px}.fixture .pane{overflow:hidden}`}</style>
  </div>;
}

const root = import.meta.hot?.data.root || createRoot(document.getElementById('root'));
root.render(<Fixture />);
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(data => { data.root = root; });
}
