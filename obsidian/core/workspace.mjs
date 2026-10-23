export function restorePanes(panes,paths) {
  const available=new Set(paths);
  return (Array.isArray(panes)?panes:[]).filter(p=>Array.isArray(p.tabs)).map(p=>{
    const tabs=[...new Set(p.tabs.filter(t=>typeof t==='string'&&(t.startsWith('@')||available.has(t))))];
    return {...p,tabs,pinned:(p.pinned||[]).filter(t=>tabs.includes(t)),active:tabs.includes(p.active)?p.active:tabs[0]||null};
  }).filter(p=>p.tabs.length);
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
    const result={...p,tabs,pinned,active:tabs.includes(active)?active:tabs[0]||null};
    if(p.tabStates){
      result.tabStates={};
      for(const key of p.tabs){
        if(!p.tabStates[key])continue;
        const mapped=remap(key);
        if(!result.tabStates[mapped]||key===p.active)result.tabStates[mapped]={...p.tabStates[key],...(p.tabStates[key].path?{path:remap(p.tabStates[key].path)}:{})};
      }
    }
    return result;
  });
}
export function moveTab(panes,from,path,to,index=Infinity) {
  if(!panes[from]?.tabs.includes(path)||!panes[to])return panes;
  const result=panes.map(p=>({...p,tabs:[...p.tabs],pinned:[...(p.pinned||[])]}));
  const source=result[from],target=result[to],pinned=source.pinned.includes(path);
  source.tabs=source.tabs.filter(t=>t!==path);source.pinned=source.pinned.filter(t=>t!==path);
  target.tabs=target.tabs.filter(t=>t!==path);target.tabs.splice(Math.max(0,Math.min(target.tabs.length,index)),0,path);
  if(pinned&&!target.pinned.includes(path))target.pinned.push(path);
  if(source.tabStates?.[path]||source.mode){
    const state=normalizeTabState(source.tabStates?.[path],source.mode);
    source.tabStates={...source.tabStates};delete source.tabStates[path];
    target.tabStates={...(target.tabStates||{}),[path]:state};
  }
  if(source.pluginViews?.[path]){
    const state=source.pluginViews[path];
    source.pluginViews={...source.pluginViews};delete source.pluginViews[path];
    target.pluginViews={...(target.pluginViews||{}),[path]:state};
  }
  if(from!==to&&source.active===path)source.active=source.tabs.at(-1)||null;
  target.active=path;return result;
}

const MAX_PANES=64, MAX_DEPTH=24, MAX_NODES=256;
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(value);
const modes=new Set(['source','live','reading']);
const finite=(value,fallback=0)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
const bounded=(value,min,max,fallback=min)=>Math.max(min,Math.min(max,finite(value,fallback)));
const directionOf=value=>value==='horizontal'?'horizontal':'vertical';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
let sequence=0;
function freshId(prefix,used=new Set()){
  let value;
  do{value=`${prefix}-${globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${(++sequence).toString(36)}`}`;}while(used.has(value));
  return value;
}
function normalizedSizes(input,count){
  if(!count)return[];
  const values=Array.from({length:count},(_,index)=>{const value=finite(input?.[index],1);return value>0?value:1;});
  const total=values.reduce((sum,value)=>sum+value,0);
  if(Number.isFinite(total)){const ratios=values.map(value=>value/total);if(ratios.every(value=>value>0))return ratios;}
  const maximum=Math.max(...values),scaled=values.map(value=>Math.max(1e-9,value/maximum));
  const sum=scaled.reduce((total,value)=>total+value,0);
  return scaled.map(value=>value/sum);
}

/** Serializable editor state belongs to an exact tab path, including literal '#'. */
export function normalizeTabState(value,fallbackMode='live'){
  const source=object(value),state={};
  state.mode=modes.has(source.mode)?source.mode:modes.has(fallbackMode)?fallbackMode:'live';
  if(typeof source.path==='string')state.path=source.path;
  const cursor=object(source.cursor);
  if(Number.isFinite(cursor.anchor))state.cursor={anchor:Math.round(bounded(cursor.anchor,0,1e9)),head:Math.round(bounded(cursor.head,0,1e9,cursor.anchor))};
  if(Array.isArray(source.selections))state.selections=source.selections.slice(0,100).filter(item=>Number.isFinite(item?.anchor)).map(item=>({anchor:Math.round(bounded(item.anchor,0,1e9)),head:Math.round(bounded(item.head,0,1e9,item.anchor))}));
  if(state.selections?.length&&Number.isInteger(source.mainIndex))state.mainIndex=bounded(source.mainIndex,0,state.selections.length-1);
  const scroll=object(source.scroll);
  if(Number.isFinite(scroll.top)||Number.isFinite(scroll.left))state.scroll={top:bounded(scroll.top,0,1e9,0),left:bounded(scroll.left,0,1e9,0)};
  if(Number.isFinite(source.readingScrollTop))state.readingScrollTop=bounded(source.readingScrollTop,0,1e9);
  return state;
}

export function getPaneTabState(pane,path=pane?.active,fallbackMode='live'){
  return normalizeTabState(pane?.tabStates?.[path],pane?.mode||fallbackMode);
}

function normalizeSidebars(input){
  const source=object(input.sidebars);
  const side=(name,defaultWidth)=>{
    const value=object(source[name]);
    return{width:bounded(value.width,140,640,name==='left'?finite(input.leftWidth,defaultWidth):finite(input.rightWidth,defaultWidth)),collapsed:typeof value.collapsed==='boolean'?value.collapsed:input[name]===false};
  };
  return{left:side('left',250),right:side('right',257)};
}

/** Normalize our split tree while retaining each pane exactly once. */
export function normalizeLayoutTree(input,panes,{direction='vertical'}={}){
  const paneIds=new Set(panes.map(pane=>pane.id)),usedLeaves=new Set(),usedIds=new Set(paneIds),visited=new WeakSet();
  let nodes=0,serial=0;
  const splitId=value=>{if(validId(value)&&!usedIds.has(value)){usedIds.add(value);return value;}let id;do{id=`split-${++serial}`;}while(usedIds.has(id));usedIds.add(id);return id;};
  const walk=(source,depth)=>{
    if(!source||typeof source!=='object'||Array.isArray(source)||depth>MAX_DEPTH||++nodes>MAX_NODES||visited.has(source))return null;
    visited.add(source);
    if(source.type==='leaf'){
      if(!paneIds.has(source.id)||usedLeaves.has(source.id))return null;
      usedLeaves.add(source.id);return{type:'leaf',id:source.id};
    }
    if(source.type!=='split'||!Array.isArray(source.children))return null;
    const children=[],weights=[];
    for(const [index,child]of source.children.slice(0,MAX_PANES).entries()){
      const node=walk(child,depth+1);if(node){children.push(node);weights.push(source.sizes?.[index]??child.dimension??1);}
    }
    if(!children.length)return null;
    if(children.length===1)return children[0];
    return{type:'split',id:splitId(source.id),direction:directionOf(source.direction),children,sizes:normalizedSizes(weights,children.length)};
  };
  let tree=walk(input,0);
  const remaining=panes.filter(pane=>!usedLeaves.has(pane.id)).map(pane=>({type:'leaf',id:pane.id}));
  if(!tree){
    if(remaining.length===1)return remaining[0];
    return{type:'split',id:splitId(),direction:directionOf(direction),children:remaining,sizes:normalizedSizes(null,remaining.length)};
  }
  if(remaining.length){
    if(tree.type==='split'&&tree.direction===directionOf(direction)){
      const previousCount=tree.children.length;
      tree={...tree,children:[...tree.children,...remaining],sizes:normalizedSizes([...tree.sizes.map(value=>value*previousCount),...remaining.map(()=>1)],previousCount+remaining.length)};
    }else tree={type:'split',id:splitId(),direction:directionOf(direction),children:[tree,...remaining],sizes:normalizedSizes(null,remaining.length+1)};
  }
  return tree;
}

/** Upgrade the former flat pane list without interpreting path punctuation. */
export function normalizeWorkspaceLayout(value={},paths){
  const input=object(value),available=Array.isArray(paths)?new Set(paths):null,used=new Set();
  const source=Array.isArray(input.panes)?input.panes.slice(0,MAX_PANES):[];
  let panes=source.filter(pane=>pane&&typeof pane==='object').map((pane,index)=>{
    let id=validId(pane.id)&&!used.has(pane.id)?pane.id:`pane-${index+1}`;
    while(used.has(id))id=`${id}-next`;used.add(id);
    const tabs=[...new Set((Array.isArray(pane.tabs)?pane.tabs:[]).filter(tab=>typeof tab==='string'&&tab.length<=8192&&(!available||tab.startsWith('@')||available.has(tab))))];
    const pinned=[...new Set((Array.isArray(pane.pinned)?pane.pinned:[]).filter(tab=>tabs.includes(tab)))];
    const tabStates={};
    for(const tab of tabs)tabStates[tab]=normalizeTabState(pane.tabStates?.[tab],pane.mode||input.mode);
    return{...pane,id,tabs,pinned,active:tabs.includes(pane.active)?pane.active:tabs[0]||null,tabStates};
  });
  if(!panes.length){const first=Array.isArray(paths)?paths.find(path=>path==='开始.md')||paths.find(path=>path.endsWith('.md'))||paths[0]:null;panes=[{id:'pane-1',tabs:first?[first]:[],pinned:[],active:first||null,tabStates:{}}];}
  // Legacy CSS used flex-direction names; version 2 follows divider direction:
  // vertical = side by side, horizontal = stacked, matching native layouts.
  const fallbackDirection=input.splitDirection==='vertical'?'horizontal':'vertical';
  const layout=normalizeLayoutTree(input.layout,panes,{direction:fallbackDirection});
  const activePaneId=panes.some(pane=>pane.id===input.activePaneId)?input.activePaneId:panes[Math.trunc(bounded(input.paneIndex,0,panes.length-1,0))].id;
  return{...input,layoutVersion:2,layout,panes,activePaneId,paneIndex:panes.findIndex(pane=>pane.id===activePaneId),sidebars:normalizeSidebars(input)};
}

export function layoutPaneIds(layout){
  if(!layout)return[];
  return layout.type==='leaf'?[layout.id]:(layout.children||[]).flatMap(layoutPaneIds);
}

function mapLayout(layout,operation){
  const changed=operation(layout);
  if(changed!==layout)return changed;
  if(layout.type!=='split')return layout;
  const children=layout.children.map(child=>mapLayout(child,operation));
  return children.some((child,index)=>child!==layout.children[index])?{...layout,children}:layout;
}

export function resizeLayoutSplit(layout,splitId,boundary,delta,{minRatio=0.05}={}){
  if(!Number.isFinite(delta))return layout;
  return mapLayout(layout,node=>{
    if(node.type!=='split'||node.id!==splitId||!Number.isInteger(boundary)||boundary<0||boundary>=node.children.length-1)return node;
    const sizes=normalizedSizes(node.sizes,node.children.length),total=sizes[boundary]+sizes[boundary+1];
    const minimum=Math.min(total/2,Math.max(0,finite(minRatio,0.05)));
    const first=bounded(sizes[boundary]+delta,minimum,total-minimum);
    sizes[boundary]=first;sizes[boundary+1]=total-first;
    return{...node,sizes};
  });
}

export function splitWorkspacePane(value,paneId,direction='vertical',options={}){
  const workspace=normalizeWorkspaceLayout(value),index=workspace.panes.findIndex(pane=>pane.id===paneId);
  if(index<0||workspace.panes.length>=MAX_PANES)return workspace;
  const original=workspace.panes[index],sourcePath=typeof options.path==='string'?options.path:options.clone===false?null:original.active;
  const custom=sourcePath?.startsWith('@plugin-view:')?original.pluginViews?.[sourcePath]:null;
  const path=custom?'@plugin-view:'+freshId('leaf'):sourcePath;
  const id=freshId('pane',new Set(workspace.panes.map(pane=>pane.id)));
  const state=sourcePath&&original.tabStates?.[sourcePath];
  const next={id,tabs:path?[path]:[],pinned:path&&original.pinned.includes(sourcePath)?[path]:[],active:path||null,tabStates:state?{[path]:normalizeTabState(state,original.mode)}:{},...(custom?{pluginViews:{[path]:structuredClone(custom)}}:{}),...(original.mode?{mode:original.mode}:{})};
  const before=options.side==='before';
  const tree=mapLayout(workspace.layout,node=>node.type==='leaf'&&node.id===paneId?{type:'split',id:freshId('split'),direction:directionOf(direction),children:before?[{type:'leaf',id},node]:[node,{type:'leaf',id}],sizes:[0.5,0.5]}:node);
  const panes=[...workspace.panes];panes.splice(index+(before?0:1),0,next);
  return{...workspace,layout:tree,panes,activePaneId:id,paneIndex:panes.findIndex(pane=>pane.id===id)};
}

export function removeWorkspacePane(value,paneId){
  const workspace=normalizeWorkspaceLayout(value);
  if(!workspace.panes.some(pane=>pane.id===paneId))return workspace;
  if(workspace.panes.length===1){const pane={...workspace.panes[0],tabs:[],active:null,pinned:[],tabStates:{}};return{...workspace,panes:[pane],layout:{type:'leaf',id:pane.id},activePaneId:pane.id,paneIndex:0};}
  const previousIndex=workspace.panes.findIndex(pane=>pane.id===paneId),panes=workspace.panes.filter(pane=>pane.id!==paneId);
  const activePaneId=workspace.activePaneId===paneId?panes[Math.min(previousIndex,panes.length-1)].id:workspace.activePaneId;
  return{...workspace,panes,layout:normalizeLayoutTree(workspace.layout,panes),activePaneId,paneIndex:panes.findIndex(pane=>pane.id===activePaneId)};
}

export function dockWorkspaceTab(value,{fromId,path,toId,index=Infinity,edge='center'}={}){
  let workspace=normalizeWorkspaceLayout(value);
  let from=workspace.panes.findIndex(pane=>pane.id===fromId),to=workspace.panes.findIndex(pane=>pane.id===toId);
  if(from<0||to<0||!workspace.panes[from].tabs.includes(path))return workspace;
  if(['left','right','top','bottom'].includes(edge)){
    if(fromId===toId&&workspace.panes[from].tabs.length===1)return workspace;
    const direction=edge==='left'||edge==='right'?'vertical':'horizontal';
    const split=splitWorkspacePane(workspace,toId,direction,{clone:false,side:edge==='left'||edge==='top'?'before':'after'});
    if(split.panes.length===workspace.panes.length)return workspace;
    workspace=split;toId=split.activePaneId;
    from=workspace.panes.findIndex(pane=>pane.id===fromId);to=workspace.panes.findIndex(pane=>pane.id===toId);
  }
  const panes=moveTab(workspace.panes,from,path,to,index);
  workspace={...workspace,panes,activePaneId:toId,paneIndex:to};
  if(fromId!==toId&&!panes[from].tabs.length)workspace=removeWorkspacePane(workspace,fromId);
  return{...workspace,activePaneId:toId,paneIndex:workspace.panes.findIndex(pane=>pane.id===toId)};
}

export function updateWorkspaceTabState(value,paneId,path,state){
  const workspace=normalizeWorkspaceLayout(value),index=workspace.panes.findIndex(pane=>pane.id===paneId);
  if(index<0||!workspace.panes[index].tabs.includes(path))return workspace;
  const pane=workspace.panes[index],next=normalizeTabState({...pane.tabStates[path],...object(state)},pane.mode||workspace.mode);
  const panes=workspace.panes.map((value,current)=>current===index?{...value,tabStates:{...value.tabStates,[path]:next}}:value);
  return{...workspace,panes};
}
