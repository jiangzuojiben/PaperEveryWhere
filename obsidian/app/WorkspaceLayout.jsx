import React, { useEffect, useMemo, useRef, useState } from 'react';
import { dockWorkspaceTab, normalizeWorkspaceLayout, removeWorkspacePane, resizeLayoutSplit, splitWorkspacePane } from '../core/workspace.mjs';
import './workspace-layout.css';

export const WORKSPACE_TAB_MIME = 'application/x-vaultdesk-tab';
const hasTab = event => Array.from(event.dataTransfer?.types || []).includes(WORKSPACE_TAB_MIME);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readTab(event, workspace) {
  try {
    const item = JSON.parse(event.dataTransfer.getData(WORKSPACE_TAB_MIME));
    const fromId = item.fromId || item.paneId || workspace.panes[item.from]?.id;
    return typeof item.path === 'string' && workspace.panes.some(pane => pane.id === fromId && pane.tabs.includes(item.path)) ? { fromId, path: item.path } : null;
  } catch { return null; }
}

function dropEdge(event) {
  if (event.target.closest?.('.tabbar,[data-workspace-tabstrip]')) return 'center';
  const rect = event.currentTarget.getBoundingClientRect();
  const tabbar = event.currentTarget.querySelector('.tabbar,[data-workspace-tabstrip]');
  const contentTop = Math.max(rect.top, tabbar?.getBoundingClientRect().bottom || rect.top);
  const contentHeight = Math.max(1, rect.bottom - contentTop);
  const x = event.clientX - rect.left, y = event.clientY - contentTop;
  const edges = [
    ['left', x / Math.min(70, rect.width * 0.24)],
    ['right', (rect.width - x) / Math.min(70, rect.width * 0.24)],
    ['top', y / Math.min(60, contentHeight * 0.24)],
    ['bottom', (rect.bottom - event.clientY) / Math.min(60, contentHeight * 0.24)],
  ].filter(([, distance]) => distance <= 1).sort((a, b) => a[1] - b[1]);
  return edges[0]?.[0] || 'center';
}

/** One pointer drag owns and restores its document-level listeners and cursor. */
function useResizeDrag() {
  const finishRef = useRef(null);
  useEffect(() => () => finishRef.current?.(), []);
  return (event, axis, onMove) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    finishRef.current?.();
    const document = event.currentTarget.ownerDocument, win = document.defaultView;
    const origin = axis === 'x' ? event.clientX : event.clientY, pointerId = event.pointerId;
    const previous = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    const move = current => { if (current.pointerId === pointerId) { current.preventDefault(); onMove((axis === 'x' ? current.clientX : current.clientY) - origin); } };
    const finish = current => {
      if (current?.pointerId !== undefined && current.pointerId !== pointerId) return;
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', finish);
      win.removeEventListener('pointercancel', finish);
      win.removeEventListener('blur', finish);
      document.body.style.cursor = previous.cursor;
      document.body.style.userSelect = previous.userSelect;
      finishRef.current = null;
    };
    finishRef.current = finish;
    win.addEventListener('pointermove', move, { passive: false });
    win.addEventListener('pointerup', finish);
    win.addEventListener('pointercancel', finish);
    win.addEventListener('blur', finish);
  };
}

function SplitHandle({ node, boundary, current, commit, minPaneSize }) {
  const startDrag = useResizeDrag(), vertical = node.direction === 'vertical';
  const resize = (base, delta, minRatio = 0.05) => commit({ ...current.current, layout: resizeLayoutSplit(base, node.id, boundary, delta, { minRatio }) });
  const availableLength = element => {
    const rect = element.parentElement.getBoundingClientRect();
    return Math.max(1, (vertical ? rect.width : rect.height) - (node.children.length - 1) * 6);
  };
  return <div
    className={`vd-layout-separator ${vertical ? 'vertical' : 'horizontal'}`}
    role="separator" tabIndex={0}
    aria-label={vertical ? '调整左右分栏比例' : '调整上下分栏比例'}
    aria-orientation={vertical ? 'vertical' : 'horizontal'}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(node.sizes[boundary] * 100)}
    data-split-id={node.id} data-split-boundary={boundary}
    onPointerDown={event => {
      const length = availableLength(event.currentTarget);
      const base = current.current.layout;
      startDrag(event, vertical ? 'x' : 'y', delta => resize(base, delta / length, minPaneSize / length));
    }}
    onDoubleClick={() => resize(current.current.layout, (node.sizes[boundary + 1] - node.sizes[boundary]) / 2)}
    onKeyDown={event => {
      const negative = vertical ? 'ArrowLeft' : 'ArrowUp', positive = vertical ? 'ArrowRight' : 'ArrowDown';
      if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 0.1 : 0.02;
      resize(current.current.layout, event.key === negative ? -step : event.key === positive ? step : event.key === 'Home' ? -1 : 1, minPaneSize / availableLength(event.currentTarget));
    }}
  />;
}

/**
 * Controlled recursive layout. renderPane retains the application's existing tab,
 * toolbar and editor markup. getTabProps supplies its native tab drag handlers.
 */
export function WorkspaceLayout({ workspace: workspaceInput, layout, panes, activePaneId, paneIndex, splitDirection, onChange, onActivate, renderPane, minPaneSize = 100, className = '' }) {
  const workspace = useMemo(() => normalizeWorkspaceLayout({
    ...workspaceInput,
    layout: layout ?? workspaceInput?.layout,
    panes: panes ?? workspaceInput?.panes,
    activePaneId: activePaneId ?? workspaceInput?.activePaneId,
    paneIndex: paneIndex ?? workspaceInput?.paneIndex ?? 0,
    splitDirection: splitDirection ?? workspaceInput?.splitDirection ?? 'horizontal',
  }), [workspaceInput, layout, panes, activePaneId, paneIndex, splitDirection]);
  const current = useRef(workspace), handlers = useRef({ onChange, onActivate });
  current.current = workspace; handlers.current = { onChange, onActivate };
  const [drop, setDrop] = useState(null);
  const commit = next => handlers.current.onChange?.(next);
  const activate = paneId => {
    const index = current.current.panes.findIndex(pane => pane.id === paneId);
    handlers.current.onActivate?.(paneId, index);
  };
  const move = (event, paneId, index = Infinity, edge = 'center') => {
    if (!hasTab(event)) return;
    event.preventDefault(); event.stopPropagation();
    const item = readTab(event, current.current); setDrop(null);
    if (!item) return;
    const next = dockWorkspaceTab(current.current, { ...item, toId: paneId, index, edge });
    commit(next); handlers.current.onActivate?.(next.activePaneId, next.paneIndex);
  };
  const controls = (pane, index) => ({
    paneId: pane.id,
    split(direction = 'vertical', options) { const next = splitWorkspacePane(current.current, pane.id, direction, options); commit(next); handlers.current.onActivate?.(next.activePaneId, next.paneIndex); },
    closePane() { const next = removeWorkspacePane(current.current, pane.id); commit(next); handlers.current.onActivate?.(next.activePaneId, next.paneIndex); },
    getTabStripProps() {
      return {
        'data-workspace-tabstrip': pane.id,
        onDragOver(event) { if (hasTab(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDrop({ id: pane.id, edge: 'center' }); } },
        onDrop(event) { move(event, pane.id); },
      };
    },
    getTabProps(path) {
      return {
        draggable: true,
        'data-workspace-tab': path,
        onDragStart(event) {
          event.stopPropagation(); event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(WORKSPACE_TAB_MIME, JSON.stringify({ path, fromId: pane.id, from: index }));
        },
        onDragEnd() { setDrop(null); },
        onDragOver(event) { if (hasTab(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDrop({ id: pane.id, edge: 'center' }); } },
        onDrop(event) {
          if (!hasTab(event)) return;
          const item = readTab(event, current.current);
          if (!item) return;
          if (item.fromId === pane.id && item.path === path) { event.preventDefault(); event.stopPropagation(); setDrop(null); return; }
          const rect = event.currentTarget.getBoundingClientRect();
          const filtered = current.current.panes.find(value => value.id === pane.id).tabs.filter(value => value !== item.path);
          const position = filtered.indexOf(path) + (event.clientX > rect.left + rect.width / 2 ? 1 : 0);
          move(event, pane.id, Math.max(0, position));
        },
      };
    },
  });
  const render = node => {
    if (node.type === 'split') return <div key={node.id} className={`vd-layout-split ${node.direction}`} data-layout-split={node.id} data-direction={node.direction}>
      {node.children.map((child, index) => <React.Fragment key={child.id}>
        <div className="vd-layout-cell" style={{ flexGrow: node.sizes[index], flexBasis: 0 }} data-layout-weight={node.sizes[index]}>{render(child)}</div>
        {index < node.children.length - 1 && <SplitHandle node={node} boundary={index} current={current} commit={commit} minPaneSize={minPaneSize} />}
      </React.Fragment>)}
    </div>;
    const index = workspace.panes.findIndex(pane => pane.id === node.id), pane = workspace.panes[index];
    if (!pane) return null;
    return <div key={node.id} className={`vd-layout-leaf${workspace.activePaneId === pane.id ? ' active' : ''}`} data-pane-id={pane.id}
      onFocusCapture={() => activate(pane.id)} onPointerDownCapture={() => activate(pane.id)}
      onDragOver={event => { if (hasTab(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDrop({ id: pane.id, edge: dropEdge(event) }); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDrop(value => value?.id === pane.id ? null : value); }}
      onDrop={event => move(event, pane.id, Infinity, drop?.id === pane.id ? drop.edge : dropEdge(event))}>
      {renderPane?.(pane, index, controls(pane, index))}
      {drop?.id === pane.id && <div className={`vd-layout-drop ${drop.edge}`} aria-hidden="true" />}
    </div>;
  };
  return <main className={`vd-workspace-layout ${className}`} data-workspace-layout="2" onDragEnd={() => setDrop(null)}>{render(workspace.layout)}</main>;
}

/** A controlled sidebar keeps its saved width while its contents stay mounted. */
export function WorkspaceSidebar({ side, width = 250, collapsed = false, onResize, onCollapsedChange, minWidth = 140, maxWidth = 640, children, className = '' }) {
  const startDrag = useResizeDrag(), left = side === 'left';
  const boundedWidth = clamp(Number.isFinite(width) ? width : 250, minWidth, maxWidth);
  const resize = next => onResize?.(clamp(next, minWidth, Math.max(minWidth, Math.min(maxWidth, window.innerWidth * 0.45))));
  return <div className={`vd-sidebar-frame ${left ? 'left' : 'right'}${collapsed ? ' collapsed' : ''} ${className}`} style={{ width: collapsed ? 0 : boundedWidth }} data-workspace-sidebar={side} data-collapsed={collapsed ? 'true' : 'false'}>
    <div className="vd-sidebar-content" hidden={collapsed}>{children}</div>
    {!collapsed && <div className="vd-sidebar-separator" role="separator" tabIndex={0} aria-label={`调整${left ? '左' : '右'}侧栏宽度`} aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={Math.round(boundedWidth)}
      onPointerDown={event => {
        const actualWidth = event.currentTarget.parentElement.getBoundingClientRect().width;
        startDrag(event, 'x', delta => resize(actualWidth + (left ? delta : -delta)));
      }}
      onDoubleClick={() => onCollapsedChange?.(true)}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); onCollapsedChange?.(true); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Home') resize(minWidth); else if (event.key === 'End') resize(maxWidth);
        else resize(event.currentTarget.parentElement.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 1 : -1) * (left ? 1 : -1) * (event.shiftKey ? 30 : 10));
      }} />}
  </div>;
}

export default WorkspaceLayout;
