import {normalizeWorkspaceLayout,splitWorkspacePane,removeWorkspacePane,updateWorkspaceTabState} from '../core/workspace.mjs';

// A plugin leaf is a tab. The adapter retains identity when that tab changes file.
export function createPluginWorkspaceAdapter({getWorkspace,setWorkspace,getEditor,onOpen=()=>{},onSave=()=>{}}) {
  const byKey=new Map(),byId=new Map();
  const key=(paneId,path)=>`${paneId}\0${path}`;
  const workspace=()=>normalizeWorkspaceLayout(getWorkspace());
  const typeFor=path=>path?.endsWith('.md')?'markdown':path?.endsWith('.pdf')?'pdf':path?.endsWith('.canvas')?'canvas':path?.endsWith('.base')?'bases':path?.startsWith('@empty:')?'empty':'file';
  function leaves(){
    const current=workspace(),live=new Set(),rows=[];
    const liveKeys=new Set(current.panes.flatMap(pane=>pane.tabs.map(path=>key(pane.id,path))));
    for(const pane of current.panes)for(const path of pane.tabs){
      const k=key(pane.id,path);let row=byKey.get(k);
      if(!row){
        row=[...byId.values()].find(value=>value.path===path&&!liveKeys.has(key(value.paneId,value.path)));
        if(row){byKey.delete(key(row.paneId,row.path));byKey.set(k,row);}
      }
      if(!row){
        const savedId=path.startsWith('@plugin-view:')?path.slice(13):null;
        row={id:savedId&&/^[\w-]{1,96}$/.test(savedId)&&!byId.has(savedId)?savedId:'leaf-'+crypto.randomUUID(),paneId:pane.id,path};
        byKey.set(k,row);byId.set(row.id,row);
      }
      const stored=pane.pluginViews?.[path];
      row.paneId=pane.id;row.path=path;row.type=stored?.type||typeFor(path);
      const mode=pane.tabStates?.[path]?.mode||current.mode||'live';
      row.state=stored?.state||(row.type==='markdown'?{file:path,mode:mode==='reading'?'preview':'source',source:mode==='source'}:!path.startsWith('@')?{file:path}:{});
      row.pinned=(pane.pinned||[]).includes(path);live.add(row.id);
      rows.push({...row,state:{...row.state}});
    }
    for(const [id,row]of byId)if(!live.has(id)){byId.delete(id);if(byKey.get(key(row.paneId,row.path))===row)byKey.delete(key(row.paneId,row.path));}
    return rows;
  }
  function find(id){leaves();const row=byId.get(id);if(!row)throw Error('插件视图已关闭');return row;}
  async function waitForMarkdown(row,path){
    if(!path.endsWith('.md'))return;
    for(let attempt=0;attempt<100;attempt++){
      if(getEditor(row.paneId,path))return;
      if(!byId.has(row.id))throw Error('插件视图已关闭');
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    throw Object.assign(Error('编辑器仍在切换文档或提交输入法，请稍后重试'),{code:'EDITOR_PENDING'});
  }
  function update(id,path,view,editorState){
    const row=find(id),current=workspace(),old=row.path;
    const panes=current.panes.map(p=>p.id!==row.paneId?p:{...p,
      tabs:p.tabs.map(t=>t===old?path:t).filter((t,i,a)=>a.indexOf(t)===i),active:path,
      pinned:(p.pinned||[]).map(t=>t===old?path:t),
      tabStates:{...p.tabStates,...(editorState?{[path]:{...p.tabStates?.[old],...editorState}}:{})},
      pluginViews:{...p.pluginViews,...(view?{[path]:view}:{})},
    });
    byKey.delete(key(row.paneId,old));row.path=path;byKey.set(key(row.paneId,path),row);
    setWorkspace({...current,panes,activePaneId:row.paneId,paneIndex:panes.findIndex(p=>p.id===row.paneId)});
    return {...row};
  }
  function exportLayout(){
    const current=workspace(),all=leaves();
    const convert=node=>{
      if(node.type==='split')return{id:node.id,type:'split',direction:node.direction,children:node.children.map((child,index)=>({...convert(child),dimension:node.sizes[index]*100}))};
      const pane=current.panes.find(p=>p.id===node.id);
      return{id:pane.id,type:'tabs',children:pane.tabs.map(path=>{
        const row=all.find(r=>r.paneId===pane.id&&r.path===path),mode=pane.tabStates?.[path]?.mode||current.mode||'live';
        const state=row.type==='markdown'?{file:path,mode:mode==='reading'?'preview':'source',source:mode==='source'}:{...row.state};
        return{id:row.id,type:'leaf',state:{type:row.type,state},...(row.pinned?{pinned:true}:{})};
      }),currentTab:Math.max(0,pane.tabs.indexOf(pane.active))};
    };
    const side=name=>({id:name+'-split',type:'split',direction:'horizontal',children:[],width:current.sidebars[name].width,...(current.sidebars[name].collapsed?{collapsed:true}:{})});
    const converted=convert(current.layout),main=converted.type==='split'?{...converted,id:'root'}:{id:'root',type:'split',direction:'vertical',children:[{...converted,dimension:100}]};
    return{main,left:side('left'),right:side('right'),active:all.find(row=>row.paneId===current.activePaneId&&current.panes.find(p=>p.id===row.paneId)?.active===row.path)?.id||null};
  }
  function importLayout(value){
    if(!value||typeof value!=='object'||!value.main)throw Error('插件布局需要 main split/tabs 树');
    if(value.floating?.children?.length)throw Error('插件布局暂不支持导入浮动窗口');
    const current=workspace(),panes=[],visited=new WeakSet(),identities=[],leafIds=new Set();let count=0,activePaneId;
    const visit=(node,depth=0)=>{
      if(!node||typeof node!=='object'||visited.has(node)||depth>24||++count>256)throw Error('插件布局树无效或过大');
      visited.add(node);
      if(node.type==='split'){
        if(!Array.isArray(node.children)||!node.children.length)throw Error('插件 split 不能为空');
        return{type:'split',id:node.id,direction:node.direction,children:node.children.map(child=>visit(child,depth+1)),sizes:node.children.map(child=>child.dimension||1)};
      }
      if(node.type!=='tabs'&&node.type!=='leaf')throw Error('插件布局节点类型不支持');
      const children=node.type==='leaf'?[node]:node.children||[],paneId=typeof node.id==='string'?node.id:'pane-'+crypto.randomUUID();
      const pane={id:paneId,tabs:[],pinned:[],tabStates:{},pluginViews:{}};
      for(const child of children){
        if(child.type!=='leaf'||!child.state||typeof child.state.type!=='string')throw Error('插件标签状态无效');
        const id=typeof child.id==='string'&&/^[\w-]{1,96}$/.test(child.id)?child.id:'leaf-'+crypto.randomUUID();
        if(leafIds.has(id))throw Error('插件布局包含重复 leaf ID');leafIds.add(id);
        const view=child.state,type=view.type,data=view.state||{};
        const fileView=['markdown','pdf','canvas','bases','file'].includes(type);
        const path=fileView&&typeof data.file==='string'?data.file:type==='empty'?'@empty:'+id:type==='graph'?'@graph':'@plugin-view:'+id;
        if(pane.tabs.includes(path))throw Error('同一分屏内重复文件布局尚未支持');
        pane.tabs.push(path);if(child.pinned||view.pinned)pane.pinned.push(path);
        const previous=current.panes.find(p=>p.tabs.includes(path))?.tabStates?.[path];
        if(type==='markdown')pane.tabStates[path]={...previous,mode:data.mode==='preview'?'reading':data.source===true?'source':'live'};
        else if(path.startsWith('@plugin-view:'))pane.pluginViews[path]={type,state:data};
        identities.push({id,paneId,path});if(id===value.active)activePaneId=paneId;
      }
      pane.active=pane.tabs[Math.max(0,Math.min(pane.tabs.length-1,node.currentTab||0))]||null;
      panes.push(pane);return{type:'leaf',id:paneId};
    };
    const layout=visit(value.main),sidebars={...current.sidebars};
    for(const name of ['left','right'])if(value[name])sidebars[name]={width:value[name].width??current.sidebars[name].width,collapsed:!!value[name].collapsed};
    const normalized=normalizeWorkspaceLayout({...current,panes,layout,sidebars,activePaneId});
    if(normalized.panes.length!==panes.length||normalized.panes.some((pane,index)=>pane.id!==panes[index].id))throw Error('插件布局分屏数量或 ID 无效');
    byKey.clear();byId.clear();for(const row of identities){byKey.set(key(row.paneId,row.path),row);byId.set(row.id,row);}
    setWorkspace(normalized);
  }
  return {
    getLeaves:leaves,
    getActiveLeafId(){const current=workspace();return leaves().find(row=>row.paneId===current.activePaneId&&current.panes.find(p=>p.id===row.paneId)?.active===row.path)?.id||null;},
    createLeaf(mode=false,direction='vertical'){
      const current=workspace(),active=current.panes.find(p=>p.id===current.activePaneId)||current.panes[0];
      if(!mode&&active.active)return leaves().find(row=>row.paneId===active.id&&row.path===active.active);
      let next=current,paneId=active.id;
      if(mode==='split'){next=splitWorkspacePane(current,active.id,direction,{clone:false});paneId=next.activePaneId;}
      else if(![false,true,'tab'].includes(mode))throw Error('该插件窗口模式尚未支持');
      const path='@empty:'+crypto.randomUUID();
      next={...next,panes:next.panes.map(p=>p.id===paneId?{...p,tabs:[...p.tabs,path],active:path}:p),activePaneId:paneId};
      setWorkspace(next);return leaves().find(row=>row.paneId===paneId&&row.path===path);
    },
    async openFile(id,path,state={}){
      const editorState={};if(state.eState?.cursor)editorState.pluginCursor=state.eState.cursor;
      const row=update(id,path,null,editorState);onOpen(path,{...state,paneId:row.paneId});await waitForMarkdown(row,path);
    },
    async setViewState(id,view){
      if(!view||typeof view.type!=='string')throw Error('Invalid plugin view state');
      if(view.type==='markdown'){
        if(typeof view.state?.file!=='string')throw Error('Markdown view requires a file');
        const mode=view.state.mode==='preview'?'reading':view.state.source===true?'source':'live';
        const row=update(id,view.state.file,null,{mode});onOpen(view.state.file,{...view.state,paneId:row.paneId});await waitForMarkdown(row,view.state.file);
      }else update(id,'@plugin-view:'+id,{type:view.type,state:view.state||{}});
    },
    revealLeaf(id){const row=find(id),current=workspace();setWorkspace({...current,activePaneId:row.paneId,paneIndex:current.panes.findIndex(p=>p.id===row.paneId),panes:current.panes.map(p=>p.id===row.paneId?{...p,active:row.path}:p)});},
    setPinned(id,pinned){const row=find(id),current=workspace();setWorkspace({...current,panes:current.panes.map(p=>p.id===row.paneId?{...p,pinned:pinned?[...new Set([...p.pinned,row.path])]:p.pinned.filter(path=>path!==row.path)}:p)});},
    updateViewState(id,view){
      const row=find(id),current=workspace();
      if(!view||typeof view.type!=='string')throw Error('Invalid plugin view state');
      const panes=current.panes.map(p=>{
        if(p.id!==row.paneId)return p;
        if(view.type==='markdown')return{...p,tabStates:{...p.tabStates,[row.path]:{...p.tabStates?.[row.path],mode:view.state?.mode==='preview'?'reading':view.state?.source===true?'source':'live'}}};
        return{...p,pluginViews:{...p.pluginViews,[row.path]:{type:view.type,state:structuredClone(view.state||{})}}};
      });setWorkspace({...current,panes});
    },
    requestSaveLayout(){return Promise.resolve(onSave(workspace()));},
    detachLeaf(id){const row=find(id),current=workspace();let next={...current,panes:current.panes.map(p=>p.id===row.paneId?{...p,tabs:p.tabs.filter(t=>t!==row.path),pinned:p.pinned.filter(t=>t!==row.path),active:p.active===row.path?p.tabs.filter(t=>t!==row.path).at(-1)||null:p.active}:p)};if(!next.panes.find(p=>p.id===row.paneId)?.tabs.length)next=removeWorkspacePane(next,row.paneId);setWorkspace(next);leaves();},
    getEditor(id){const row=id?find(id):byId.get(this.getActiveLeafId());return row?getEditor(row.paneId,row.path):null;},
    getLayout:exportLayout,
    async changeLayout(value){importLayout(value);},
    updateTabState(id,state){const row=find(id);setWorkspace(updateWorkspaceTabState(workspace(),row.paneId,row.path,state));},
  };
}
