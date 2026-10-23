import React, { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import './plugin-surfaces.css';

const empty = Object.freeze({ revision: 0, ribbon: [], statusBar: [], views: [] });
const noopSubscribe = () => () => {};
const getEmpty = () => empty;
function usePluginUI(host) { return useSyncExternalStore(host?.subscribeUI || noopSubscribe, host?.getUI || getEmpty, getEmpty); }
function PluginElement({ element, className }) {
  const container = useRef(null);
  useLayoutEffect(() => {
    if (!element || !container.current) return;
    const parent = container.current;
    parent.appendChild(element);
    return () => { if (element.parentNode === parent) element.remove(); };
  }, [element]);
  return <div ref={container} className={className}/>;
}
export function PluginRibbon({ host }) {
  const container = useRef(null);
  useLayoutEffect(() => host?.attachSurface?.('ribbon', container.current), [host]);
  return <div ref={container} className="plugin-ribbon-items" aria-label="插件工具"/>;
}
export function PluginStatusBar({ host }) {
  const container = useRef(null);
  useLayoutEffect(() => host?.attachSurface?.('statusBar', container.current), [host]);
  return <div ref={container} className="plugin-status-items" aria-label="插件状态"/>;
}
export function PluginViewMount({ host, leafId }) {
  const ui = usePluginUI(host), entry = ui.views.find(item => item.leafId === leafId);
  return entry ? <PluginElement element={entry.element} className="plugin-view-mount"/> : <div className="plugin-view-unavailable" role="status">此视图所属插件尚未启用，或视图已关闭。</div>;
}
export function PluginViewTitle({ host, leafId }) {
  const ui = usePluginUI(host);
  return ui.views.find(item => item.leafId === leafId)?.title || '插件视图';
}
