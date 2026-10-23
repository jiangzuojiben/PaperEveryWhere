export function restorePanes(panes,paths) {
  const available=new Set(paths);
  return (Array.isArray(panes)?panes:[]).filter(p=>Array.isArray(p.tabs)).map(p=>{
    const tabs=[...new Set(p.tabs.filter(t=>typeof t==='string'&&(t.startsWith('@')||available.has(t))))];
    return {...p,tabs,pinned:(p.pinned||[]).filter(t=>tabs.includes(t)),active:tabs.includes(p.active)?p.active:tabs[0]||null};
  }).filter(p=>p.tabs.length).slice(0,4);
}
export function remapPath(path,oldPath,newPath,{allowFragment=false}={}) {
  if(typeof path!=='string')return path;
  if(path.startsWith('@localgraph:'))return '@localgraph:'+remapPath(path.slice(12),oldPath,newPath,{allowFragment});
  // A Windows filename may contain '#'. Match the complete known path first.
  if(path===oldPath||path.startsWith(oldPath+'/'))return newPath+path.slice(oldPath.length);
  if(allowFragment&&path.startsWith(oldPath+'#'))return newPath+path.slice(oldPath.length);
  return path;
}
export function remapPanes(panes,oldPath,newPath) {
  // Pane identifiers are whole paths, not Markdown references with fragments.
  const remap=path=>remapPath(path,oldPath,newPath,{allowFragment:false});
  return panes.map(p=>{
    const tabs=[...new Set(p.tabs.map(remap))];
    const pinned=[...new Set((p.pinned||[]).map(remap))].filter(path=>tabs.includes(path));
    const active=remap(p.active);
    return {...p,tabs,pinned,active:tabs.includes(active)?active:tabs[0]||null};
  });
}
export function moveTab(panes,from,path,to,index=Infinity) {
  if(!panes[from]?.tabs.includes(path)||!panes[to])return panes;
  const result=panes.map(p=>({...p,tabs:[...p.tabs],pinned:[...(p.pinned||[])]}));
  const source=result[from],target=result[to],pinned=source.pinned.includes(path);
  source.tabs=source.tabs.filter(t=>t!==path);source.pinned=source.pinned.filter(t=>t!==path);
  target.tabs=target.tabs.filter(t=>t!==path);target.tabs.splice(Math.max(0,Math.min(target.tabs.length,index)),0,path);
  if(pinned&&!target.pinned.includes(path))target.pinned.push(path);
  if(from!==to&&source.active===path)source.active=source.tabs.at(-1)||null;
  target.active=path;return result;
}
