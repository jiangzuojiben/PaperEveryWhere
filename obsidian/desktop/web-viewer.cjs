const { WebContentsView } = require('electron');
const { randomUUID } = require('node:crypto');

function normalizeWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('请输入有效网页地址');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('内嵌网页仅支持无内嵌凭据的 HTTP/HTTPS 地址');
  return url.href;
}
function clipBounds(input, size) {
  if (!input || !['x','y','width','height'].every(key=>Number.isFinite(input[key]))) throw new Error('Invalid web view bounds');
  const x=Math.min(size[0],Math.max(0,Math.round(input.x))), y=Math.min(size[1],Math.max(0,Math.round(input.y)));
  return {x,y,width:Math.min(Math.max(0,Math.round(input.width)),Math.max(0,size[0]-x)),height:Math.min(Math.max(0,Math.round(input.height)),Math.max(0,size[1]-y))};
}
function installWebViewer({register,send,ViewClass=WebContentsView}) {
  const owners=new Map();
  const subscriptions=new WeakMap();
  function watchOwner(owner) {
    if(subscriptions.has(owner))return;
    const wc=owner.webContents;
    const onNavigation=(details,_url,legacyInPlace,legacyMainFrame)=>{
      const main=typeof details?.isMainFrame==='boolean'?details.isMainFrame:legacyMainFrame;
      const same=typeof details?.isSameDocument==='boolean'?details.isSameDocument:legacyInPlace;
      if(main===true&&same===false)disposeOwner(owner);
    };
    const onRendererGone=()=>disposeOwner(owner);
    const onClosed=()=>{
      disposeOwner(owner);
      wc.removeListener('did-start-navigation',onNavigation);
      wc.removeListener('render-process-gone',onRendererGone);
      wc.removeListener('destroyed',onClosed);
      owner.removeListener('closed',onClosed);
      subscriptions.delete(owner);
    };
    subscriptions.set(owner,{onNavigation,onRendererGone,onClosed});
    // Watch the host renderer only; child web pages own their navigation/crashes.
    wc.on('did-start-navigation',onNavigation);
    wc.on('render-process-gone',onRendererGone);
    wc.once('destroyed',onClosed);
    owner.once('closed',onClosed);
  }
  function group(ctx) {
    watchOwner(ctx.window);
    if (!owners.has(ctx.window.id)) {
      const records=new Map(); owners.set(ctx.window.id,records);
    }
    return owners.get(ctx.window.id);
  }
  function get(ctx,id) {
    const record=owners.get(ctx.window.id)?.get(id);
    if (!record || record.view.webContents.isDestroyed()) throw new Error('网页标签已关闭');
    return record;
  }
  function state(record) {
    const wc=record.view.webContents;
    return {id:record.id,url:wc.getURL()||record.url,title:wc.getTitle(),loading:wc.isLoading(),canGoBack:wc.navigationHistory.canGoBack(),canGoForward:wc.navigationHistory.canGoForward(),error:record.error||''};
  }
  function emit(ctx,record) {if(owners.get(ctx.window.id)?.get(record.id)===record&&!record.disposed&&!ctx.window.isDestroyed()&&!record.view.webContents.isDestroyed())send(ctx,{type:'webviewer',...state(record)});}
  function disposeView(owner,record) {
    if(record.disposed)return;
    record.disposed=true;
    try {if(!owner.isDestroyed())owner.contentView.removeChildView(record.view);}
    finally {if(!record.view.webContents.isDestroyed())record.view.webContents.close({waitForBeforeUnload:false});}
  }
  function close(ctx,id) {
    const records=owners.get(ctx.window.id),record=records?.get(id);
    if(!record)return false;
    records.delete(id);
    disposeView(ctx.window,record);
    return true;
  }
  function disposeOwner(owner) {
    const records=owners.get(owner.id);
    owners.delete(owner.id);
    if(records)for(const record of records.values()){
      try{disposeView(owner,record);}catch{/* Continue releasing every view during owner teardown. */}
    }
  }
  function load(ctx,record,url) {
    record.url=normalizeWebUrl(url);record.error='';
    record.view.webContents.loadURL(record.url).catch(error=>{if(error.code!=='ERR_ABORTED'&&!record.view.webContents.isDestroyed()){record.error=error.message;emit(ctx,record);}});
    return state(record);
  }
  register('webviewOpen',(ctx,options)=>{
    if(!options||!/^web-[\w-]{1,100}$/.test(options.id))throw new Error('Invalid web tab id');
    const url=normalizeWebUrl(options.url),records=group(ctx);
    if(records.size>=16&&!records.has(options.id))throw new Error('请先关闭部分网页标签');
    if(records.has(options.id))return state(get(ctx,options.id));
    const view=new ViewClass({webPreferences:{partition:`vaultdesk-web-${ctx.window.id}-${randomUUID()}`,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
    const record={id:options.id,url,view,error:''};records.set(record.id,record);
    const wc=view.webContents;
    wc.session.setPermissionRequestHandler((_wc,_permission,done)=>done(false));
    wc.session.setPermissionCheckHandler(()=>false);
    wc.session.on('will-download',event=>event.preventDefault());
    const guard=(event,target)=>{try{normalizeWebUrl(target);}catch{event.preventDefault();}};
    wc.on('will-navigate',guard);wc.on('will-redirect',guard);
    wc.setWindowOpenHandler(({url:target})=>{try{load(ctx,record,target);}catch(error){record.error=error.message;emit(ctx,record);}return{action:'deny'};});
    for(const event of ['did-navigate','did-navigate-in-page','page-title-updated','did-start-loading','did-stop-loading'])wc.on(event,()=>emit(ctx,record));
    wc.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){record.error=description;emit(ctx,record);}});
    wc.on('render-process-gone',()=>{record.error='网页进程已退出，请重新加载';emit(ctx,record);});
    ctx.window.contentView.addChildView(view);
    view.setBounds(clipBounds(options.bounds,ctx.window.getContentSize()));
    view.setVisible(options.visible!==false);
    return load(ctx,record,url);
  });
  register('webviewNavigate',(ctx,id,url)=>load(ctx,get(ctx,id),url));
  register('webviewBounds',(ctx,id,bounds,visible)=>{const record=get(ctx,id);record.view.setBounds(clipBounds(bounds,ctx.window.getContentSize()));record.view.setVisible(!!visible);return true;});
  register('webviewAction',(ctx,id,action)=>{const record=get(ctx,id),wc=record.view.webContents;if(action==='back'&&wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();else if(action==='forward'&&wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();else if(action==='reload'){record.error='';wc.reload();}else if(action==='stop')wc.stop();else if(!['back','forward'].includes(action))throw new Error('Unsupported web action');return state(record);});
  register('webviewClose',close);
  return {disposeOwner};
}
module.exports={installWebViewer,normalizeWebUrl,clipBounds};
