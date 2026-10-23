import React,{useEffect,useMemo,useRef,useState} from 'react';
import{ChevronRight,ChevronDown,Folder,FileText,LayoutDashboard,Table2,MoreHorizontal}from'lucide-react';
function rowsFor(files,collapsed,sort){
  const root=new Map();
  for(const file of files){let level=root;const parts=file.path.split('/');parts.forEach((name,i)=>{if(!level.has(name))level.set(name,{name,path:parts.slice(0,i+1).join('/'),folder:i<parts.length-1||!!file.isDirectory,mtime:0,children:new Map()});const node=level.get(name);node.folder||=i<parts.length-1||!!file.isDirectory;node.mtime=Math.max(node.mtime,file.mtime||0);level=node.children;});}
  const rows=[];function visit(level,depth=0){for(const node of [...level.values()].sort((a,b)=>Number(b.folder)-Number(a.folder)||(sort==='modified'?b.mtime-a.mtime:0)||(sort==='name-desc'?b.name.localeCompare(a.name,'zh'):a.name.localeCompare(b.name,'zh')))){rows.push({...node,depth});if(node.folder&&!collapsed.has(node.path))visit(node.children,depth+1);}}visit(root);return rows;
}
export default function FileTree({files,active,collapsed,sort,onOpen,onToggle,onMenu,onMove}){
  const rows=useMemo(()=>rowsFor(files,collapsed,sort),[files,collapsed,sort]);
  const host=useRef(null),[scroll,setScroll]=useState(0),[height,setHeight]=useState(600);
  useEffect(()=>{const observer=new ResizeObserver(([entry])=>setHeight(entry.contentRect.height));if(host.current)observer.observe(host.current);return()=>observer.disconnect();},[]);
  const start=Math.max(0,Math.min(rows.length-Math.ceil(height/32)-10,Math.floor(scroll/32)-8)),end=Math.min(rows.length,start+Math.ceil(height/32)+18);
  return <div ref={host} className="sidebar-scroll virtual-files" role="tree" aria-label="知识库文件" onScroll={event=>setScroll(event.currentTarget.scrollTop)}>
    <div style={{height:start*32}}/>{rows.slice(start,end).map(node=><div key={node.path} role="treeitem" aria-level={node.depth+1} aria-expanded={node.folder?!collapsed.has(node.path):undefined} aria-selected={node.path===active} className={'tree-row'+(node.path===active?' selected':'')} style={{paddingLeft:10+node.depth*16,height:32,minHeight:32,marginTop:0,marginBottom:0}} draggable onDragStart={event=>event.dataTransfer.setData('application/x-vaultdesk-file',node.path)} onDragOver={event=>{if(node.folder&&event.dataTransfer.types.includes('application/x-vaultdesk-file'))event.preventDefault();}} onDrop={event=>{const source=event.dataTransfer.getData('application/x-vaultdesk-file');if(!source||!node.folder)return;event.preventDefault();event.stopPropagation();const target=node.path+'/'+source.split('/').pop();if(source!==target)onMove(source,target);}} onClick={()=>node.folder?onToggle(node.path):onOpen(node.path)} onContextMenu={event=>{event.preventDefault();onMenu(node.path,node.folder);}}>
      <span className="tree-icon">{node.folder?collapsed.has(node.path)?<ChevronRight size={14}/>:<ChevronDown size={14}/>:node.path.endsWith('.canvas')?<LayoutDashboard size={15}/>:node.path.endsWith('.base')?<Table2 size={15}/>:<FileText size={15}/>}</span><span>{node.name.replace(/\.md$/,'')}</span><button className="row-more" aria-label={'操作 '+node.name} onClick={event=>{event.stopPropagation();onMenu(node.path,node.folder);}}><MoreHorizontal size={14}/></button>
    </div>)}<div style={{height:Math.max(0,rows.length-end)*32}}/>
  </div>;
}
