import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `layout-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const output = path.join(root, 'output', runId), vault = path.join(output, 'vault');
const userData = path.join(os.tmpdir(), `VaultDesk-Test-${runId}`), windowId = 'layout-smoke';
const workspaceFile = path.join(vault, '.vaultdesk', `workspace-${windowId}.json`);
const report = { runId, output, userData, checks: [] }, sockets = new Set(), children = new Set();
const editorOnly=process.argv.includes('--editor-only');report.editorOnly=editorOnly;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let running;

async function until(operation, description, timeout = 25000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const result = await operation(); if (result) return result; } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`${description} timed out${last ? `: ${last.message}` : ''}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map(), events=[]; let serial = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once:true }); socket.addEventListener('error', reject, { once:true }); });
  sockets.add(socket);
  socket.addEventListener('message', ({data}) => { const message = JSON.parse(data), callback = pending.get(message.id); if (message.method&&events.length<100)events.push(message); if (callback) { pending.delete(message.id); clearTimeout(callback.timer); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); } });
  socket.addEventListener('close', () => { sockets.delete(socket); for (const callback of pending.values()) { clearTimeout(callback.timer); callback.reject(new Error('CDP closed')); } pending.clear(); });
  return { socket,events,
    call(method, params = {}) { return new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20000); pending.set(id, {resolve,reject,timer}); socket.send(JSON.stringify({id,method,params})); }); },
    async eval(expression) { const result = await this.call('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true}); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; },
  };
}
async function launch({paneCount=3,editorCount=3}={}) {
  const rendererPort = await freePort(), inspectorPort = await freePort();
  const env = {...process.env,VAULTDESK_TEST_MODE:'1',VAULTDESK_TEST_SESSION:runId,VAULTDESK_TEST_RESTORE:'1',VAULTDESK_VAULT:vault};
  delete env.ELECTRON_RUN_AS_NODE; delete env.VAULTDESK_DEV_URL;
  if(process.env.VAULTDESK_LAYOUT_DEV_URL)env.VAULTDESK_DEV_URL=process.env.VAULTDESK_LAYOUT_DEV_URL;
  const packaged=process.env.VAULTDESK_LAYOUT_EXECUTABLE;
  const executable = packaged ? path.resolve(packaged) : path.join(root,'node_modules','electron','dist',process.platform === 'win32' ? 'electron.exe' : 'electron');
  report.executable=path.basename(executable);report.packaged=!!packaged;
  const child = spawn(executable,[...(packaged?[]:[root]),`--remote-debugging-port=${rendererPort}`,'--remote-debugging-address=127.0.0.1',`--inspect=127.0.0.1:${inspectorPort}`],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  children.add(child); child.once('exit',()=>children.delete(child));
  const run = {child,logs:''}; running=run;
  for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk=>run.logs+=chunk.toString());
  await until(()=>run.logs.includes('"event":"vaultdesk-ready"'),'Electron ready');
  const targets = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json();
  run.main=await connect(targets[0].webSocketDebuggerUrl);
  await run.main.eval(`(()=>{const ipc=process.mainModule.require('electron').ipcMain,key='vaultdesk:saveWorkspace',original=ipc._invokeHandlers.get(key);globalThis.__layoutWrites={pending:0,total:0,items:[]};ipc._invokeHandlers.set(key,async(...args)=>{const value=args[1],entry={start:Date.now(),keys:Object.keys(value?.workspaces||{}),mode:value?.mode,panes:value?.panes?.map(p=>({id:p.id,active:p.active,state:p.tabStates?.[p.active]}))},log=globalThis.__layoutWrites;log.pending++;log.total++;log.items.push(entry);if(log.items.length>20)log.items.shift();try{const result=await original(...args);entry.ok=result?.ok;entry.error=result?.error;return result}catch(error){entry.error=error.message;throw error}finally{entry.end=Date.now();log.pending--}});return true})()`);
  report.runtime=await run.main.eval("process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w=>w.hide()); process.versions");
  report.appVersion=await run.main.eval("process.mainModule.require('electron').app.getVersion()");
  const renderer = await until(async()=>{ const list=await(await fetch(`http://127.0.0.1:${rendererPort}/json/list`)).json(); return list.find(item=>item.type==='page'&&(/index\.html/.test(item.url)||env.VAULTDESK_DEV_URL&&item.url.startsWith(env.VAULTDESK_DEV_URL))); },'Renderer');
  run.ui=await connect(renderer.webSocketDebuggerUrl);
  await run.ui.call('Log.enable');await run.ui.call('Runtime.enable');
  await run.ui.call('Emulation.setFocusEmulationEnabled',{enabled:true});
  report.renderer=await run.ui.eval('({url:location.href,scripts:[...document.scripts].map(s=>s.src).filter(Boolean)})');
  await until(()=>run.ui.eval(`document.querySelectorAll('[data-pane-id]').length===${paneCount} && [...document.querySelectorAll('.vault-editor')].filter(el=>el.getBoundingClientRect().height>0).length===${editorCount}`),'Restored pane and visible editor count');
  return run;
}
async function quit(run) {
  if(run.main){try{report.persistenceRuns||=[];report.persistenceRuns.push(await run.main.eval('globalThis.__layoutWrites'));}catch{}}
  await run.main?.eval("process.mainModule.require('electron').app.quit(); true").catch(()=>{});
  run.main?.socket.close(); run.ui?.socket.close();
  await until(()=>run.child.exitCode!==null,'Graceful quit',15000);
  await fs.appendFile(path.join(output,'electron.log'),run.logs);
  if(running===run)running=null;
}
function checked(name,detail) { report.checks.push({name,passed:true,detail}); console.log(`PASS ${name}`); }
const paneSelector = id => `[data-pane-id="${id}"]`;
async function click(ui,selector) {
  await until(()=>ui.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return !!el&&!el.disabled})()`),`Enabled ${selector}`);
  assert.equal(await ui.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return false;el.click();return true})()`),true,selector);
}
async function focusEditor(ui,paneId) {
  const selector=`${paneSelector(paneId)} .cm-content`;
  await until(()=>ui.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('contenteditable')==='true'`),'Editable source content');
  assert.equal(await ui.eval(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return document.activeElement===el&&document.hasFocus()})()`),true,'Editor focus');
  await pause(100);
}
async function pointerResize(ui,selector,dx,dy=0) {
  const point=await ui.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await ui.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await ui.call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await ui.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx,y:point.y+dy,buttons:1});
  await ui.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1});
  await pause(150);
}
const geometryExpression = `(()=>{const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{panes:[...document.querySelectorAll('[data-pane-id]')].map(el=>({id:el.dataset.paneId,...rect(el)})),splits:[...document.querySelectorAll('[data-layout-split]')].map(el=>({id:el.dataset.layoutSplit,direction:el.dataset.direction,...rect(el)})),sidebars:[...document.querySelectorAll('[data-workspace-sidebar]')].map(el=>({side:el.dataset.workspaceSidebar,collapsed:el.dataset.collapsed,...rect(el)})),editors:[...document.querySelectorAll('.vault-editor')].map(el=>({pane:el.closest('[data-pane-id]').dataset.paneId,path:el.dataset.editorPath,mode:el.dataset.editorMode,scroll:el.querySelector('.cm-scroller')?.scrollTop,readingScroll:el.querySelector('.markdown-reading')?.scrollTop}))}})()`;
async function screenshot(ui,name) { const image=await ui.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,name+'.png'),Buffer.from(image.data,'base64')); }
async function saved(ui) { return ui.eval('vaultdesk.loadWorkspace()'); }
async function layoutDialog(ui) {
  await click(ui,'[aria-label="命令面板"]');
  await until(()=>ui.eval("!![...document.querySelectorAll('.palette-results button')].find(el=>el.textContent.includes('管理工作区布局'))"),'Workspace command');
  await ui.eval("[...document.querySelectorAll('.palette-results button')].find(el=>el.textContent.includes('管理工作区布局')).click();true");
  await until(()=>ui.eval("!!document.querySelector('[aria-label=工作区名称]')"),'Workspace dialog');
}
async function restoreNamed(ui,name) {
  await until(()=>ui.eval(`(()=>{const row=[...document.querySelectorAll('.vd-util-workspace-row')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)});return !!row&&!row.querySelector('button.vd-util-secondary').disabled})()`),'Named restore button ready');
  const expression=`(()=>{const row=[...document.querySelectorAll('.vd-util-workspace-row')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)});if(!row)return false;row.querySelector('button.vd-util-secondary').click();return true})()`;
  assert.equal(await ui.eval(expression),true,`Named layout ${name}`);
}
function state(mode,cursor,scroll) { return{mode,cursor:{anchor:cursor,head:cursor},selections:[{anchor:cursor,head:cursor}],mainIndex:0,scroll:{top:scroll,left:0},readingScrollTop:scroll}; }
const leaf=id=>({type:'leaf',id});

try {
  await fs.mkdir(path.dirname(workspaceFile),{recursive:true}); await fs.mkdir(userData,{recursive:true});
  const contents=Object.fromEntries(['A#literal.md','B.md','C.md','D.md'].map(name=>[name,Array.from({length:320},(_,i)=>`${String(i+1).padStart(3,'0')} ${name} plain line with a repeatable cursor position and enough content.\n`).join('')]));
  for(const[name,content]of Object.entries(contents))await fs.writeFile(path.join(vault,name),content);
  const seed={layoutVersion:2,panes:[
    {id:'pane-a',tabs:['A#literal.md','D.md'],active:'A#literal.md',pinned:['A#literal.md'],tabStates:{'A#literal.md':state('source',2000,900),'D.md':state('source',888,250)}},
    {id:'pane-b',tabs:['B.md'],active:'B.md',pinned:[],tabStates:{'B.md':state('live',1700,500)}},
    {id:'pane-c',tabs:['C.md'],active:'C.md',pinned:[],tabStates:{'C.md':state('reading',100,650)}},
  ],layout:{type:'split',id:'root-mixed',direction:'vertical',sizes:[.37,.63],children:[leaf('pane-a'),{type:'split',id:'right-stack',direction:'horizontal',sizes:[.61,.39],children:[leaf('pane-b'),leaf('pane-c')]}]},activePaneId:'pane-a',paneIndex:0,sidebars:{left:{width:231,collapsed:true},right:{width:277,collapsed:false}},left:false,right:true,mode:'live',settings:{fontSize:16},workspaces:{}};
  seed.workspaces['Seed mixed']=structuredClone({...seed,workspaces:undefined});
  await fs.writeFile(workspaceFile,JSON.stringify(seed));
  await fs.writeFile(path.join(userData,'desktop.json'),JSON.stringify({version:2,activeWindowId:windowId,windows:[{id:windowId,vaultPath:vault,bounds:{x:30,y:40,width:1280,height:900}}]}));
  const first=await launch(),ui=first.ui;
  await until(async()=>{const g=await ui.eval(geometryExpression);return g.editors.find(e=>e.path==='C.md')?.readingScroll>500;},'Initial editor scroll restore');
  const initial=await ui.eval(geometryExpression);report.initial=initial;
  const a=initial.panes.find(p=>p.id==='pane-a'),b=initial.panes.find(p=>p.id==='pane-b'),c=initial.panes.find(p=>p.id==='pane-c');
  assert.ok(b.x>a.x+a.width&&c.x===b.x&&c.y>b.y+b.height);
  assert.ok(Math.abs(a.width/(a.width+b.width)-.37)<.005);
  assert.ok(Math.abs(b.height/(b.height+c.height)-.61)<.005);
  assert.equal(initial.sidebars.find(s=>s.side==='left').width,0);
  assert.ok(Math.abs(initial.sidebars.find(s=>s.side==='right').width-277)<1);
  assert.deepEqual(initial.editors.map(e=>e.mode),['source','live','reading']);
  assert.ok(Math.abs(initial.editors[0].scroll-900)<2);assert.ok(Math.abs(initial.editors[2].readingScroll-650)<2);
  assert.equal(await ui.eval(`!!document.querySelector('${paneSelector('pane-a')} [title="已固定"]')`),true);
  checked('native startup restores mixed split ratios, pinned tabs, per-tab modes, scroll and sidebar geometry',initial);
  await screenshot(ui,'native-initial');

  await click(ui,`${paneSelector('pane-c')} [aria-label="源码模式"]`);
  await until(()=>ui.eval(`document.querySelector('${paneSelector('pane-c')} .vault-editor')?.dataset.editorMode==='source' && Math.abs(document.querySelector('${paneSelector('pane-c')} .cm-scroller')?.scrollTop-650)<2`),'Hidden source scroll restored after reading mode');
  await click(ui,`${paneSelector('pane-c')} [aria-label="阅读模式"]`);
  await until(()=>ui.eval(`Math.abs(document.querySelector('${paneSelector('pane-c')} .markdown-reading')?.scrollTop-650)<2`),'Reading scroll survives mode round trip');
  checked('reading-to-source mode switch preserves independent hidden source and reading scroll positions');

  await focusEditor(ui,'pane-a');
  report.inputReady=await ui.eval(`({hasFocus:document.hasFocus(),focused:document.activeElement?.className,editable:document.querySelector('${paneSelector('pane-a')} .cm-content')?.getAttribute('contenteditable'),view:document.querySelector('${paneSelector('pane-a')} .vault-editor')?.dataset.editorPath})`);
  const marker='LAYOUT_CURSOR';await ui.call('Input.insertText',{text:marker});
  await until(async()=>{const note=await ui.eval("vaultdesk.read('A#literal.md')");return note.content.includes(marker);},'Cursor insertion saved');
  assert.equal((await ui.eval("vaultdesk.read('A#literal.md')")).content.indexOf(marker),2000);
  checked('restored source cursor inserts text at exact saved offset in a literal-hash filename');

  await ui.eval(`(()=>{const el=document.querySelector('${paneSelector('pane-a')} .cm-scroller');el.scrollTop=777;el.dispatchEvent(new Event('scroll'));return true})()`);
  await until(async()=>Math.abs((await saved(ui)).panes.find(p=>p.id==='pane-a').tabStates['A#literal.md'].scroll.top-777)<2,'Saved editor scroll');
  await click(ui,`${paneSelector('pane-a')} [data-workspace-tab="D.md"]`);
  await until(()=>ui.eval(`document.querySelector('${paneSelector('pane-a')} .vault-editor')?.dataset.editorPath==='D.md'`),'Second tab active');
  await click(ui,`${paneSelector('pane-a')} [data-workspace-tab="A#literal.md"]`);
  await until(()=>ui.eval(`Math.abs(document.querySelector('${paneSelector('pane-a')} .cm-scroller')?.scrollTop-777)<2`),'Tab scroll restored');
  checked('tab switch restores independent editor scroll and hidden-tab view state');

  const beforeResize=await saved(ui);
  await pointerResize(ui,'[data-split-id="root-mixed"]',65);
  await pointerResize(ui,'[data-split-id="right-stack"]',0,-35);
  await pointerResize(ui,'[data-workspace-sidebar="right"] .vd-sidebar-separator',-23);
  const afterResize=await until(async()=>{const w=await saved(ui);return w.layout.sizes[0]>beforeResize.layout.sizes[0]+.03&&w.sidebars.right.width>290&&w;},'Resize persisted');
  assert.ok(afterResize.layout.children[1].sizes[0]<beforeResize.layout.children[1].sizes[0]-.02);
  checked('native pointer dragging persists nested split ratios and sidebar width',{layout:afterResize.layout,sidebars:afterResize.sidebars});

  if(!editorOnly){
    await layoutDialog(ui);
    await ui.eval("document.querySelector('[aria-label=工作区名称]').focus();true");
    await ui.call('Input.insertText',{text:'Native saved'});
    await click(ui,'.vd-util-save-form button[type="submit"]');
    await until(async()=>!!(await saved(ui)).workspaces['Native saved'],'Named workspace saved');
    const named=(await saved(ui)).workspaces['Native saved'];
    assert.deepEqual(named.layout,afterResize.layout);assert.deepEqual(named.sidebars,afterResize.sidebars);
    checked('named layout saved through native UI includes nested tree, tabs and sidebars');
    await ui.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await ui.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  }
  await pause(300);
  const persisted=await saved(ui);report.persisted=persisted;
  await screenshot(ui,'native-before-restart');await quit(first);
  const disk=JSON.parse(await fs.readFile(workspaceFile,'utf8'));assert.deepEqual(disk.layout,persisted.layout);

  const second=await launch(),ui2=second.ui;
  await until(async()=>{const g=await ui2.eval(geometryExpression);return g.editors.find(e=>e.path==='C.md')?.readingScroll>500;},'Restart editor restore');
  report.restartEarlyGeometry=await ui2.eval(geometryExpression);
  await pause(1500);
  const restored=await saved(ui2),geometry=await ui2.eval(geometryExpression);report.restored={workspace:restored,geometry};
  assert.deepEqual(restored.layout,persisted.layout);assert.deepEqual(restored.sidebars,persisted.sidebars);
  assert.deepEqual(restored.panes.map(p=>({id:p.id,tabs:p.tabs,active:p.active,pinned:p.pinned})),persisted.panes.map(p=>({id:p.id,tabs:p.tabs,active:p.active,pinned:p.pinned})));
  assert.deepEqual(geometry.editors.map(e=>({path:e.path,mode:e.mode})),initial.editors.map(e=>({path:e.path,mode:e.mode})));
  assert.ok(Math.abs(geometry.editors[0].scroll-777)<2);assert.ok(Math.abs(geometry.editors[2].readingScroll-650)<2);
  assert.ok(Math.abs(geometry.editors[1].scroll-persisted.panes.find(p=>p.id==='pane-b').tabStates['B.md'].scroll.top)<2);
  if(!editorOnly)assert.ok(restored.workspaces['Native saved']);
  await focusEditor(ui2,'pane-a');
  await ui2.call('Input.insertText',{text:'RESTART_CURSOR'});
  await until(async()=>{const note=await ui2.eval("vaultdesk.read('A#literal.md')");return note.content.includes('RESTART_CURSOR');},'Restart cursor insertion');
  assert.equal((await ui2.eval("vaultdesk.read('A#literal.md')")).content.indexOf('RESTART_CURSOR'),2000+marker.length);
  checked(`graceful native restart restores layout, pinning, modes, cursor and scrolling${editorOnly?'':' with named layouts'}`,geometry);
  await screenshot(ui2,'native-after-restart');await quit(second);
  if(process.env.VAULTDESK_LAYOUT_EMPTY==='1'&&!editorOnly){
    const empty=JSON.parse(await fs.readFile(workspaceFile,'utf8'));
    empty.panes=empty.panes.map(p=>p.id==='pane-b'?{...p,tabs:[],active:null,pinned:[],tabStates:{}}:p);
    empty.activePaneId='pane-b';empty.paneIndex=1;
    empty.workspaces['Empty group']=structuredClone({...empty,workspaces:undefined});
    await fs.writeFile(workspaceFile,JSON.stringify(empty));
    const third=await launch({editorCount:2}),ui3=third.ui;
    assert.equal(await ui3.eval("!!document.querySelector('[data-pane-id=pane-b] .empty-pane')"),true);
    assert.equal((await saved(ui3)).activePaneId,'pane-b');
    await layoutDialog(ui3);await restoreNamed(ui3,'Native saved');
    await until(()=>ui3.eval("[...document.querySelectorAll('.vault-editor')].filter(el=>el.getBoundingClientRect().height>0).length===3"),'Named full layout restores');
    await until(()=>ui3.eval(`Math.abs(document.querySelector('${paneSelector('pane-a')} .cm-scroller')?.scrollTop-777)<2`),'Named layout restores same-path editor scroll');
    await ui3.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await ui3.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await focusEditor(ui3,'pane-a');
    await ui3.call('Input.insertText',{text:'NAMED_CURSOR'});
    await until(async()=>{const note=await ui3.eval("vaultdesk.read('A#literal.md')");return note.content.includes('NAMED_CURSOR');},'Named cursor insertion saved');
    assert.equal((await ui3.eval("vaultdesk.read('A#literal.md')")).content.indexOf('NAMED_CURSOR'),2000+marker.length);
    await layoutDialog(ui3);
    await restoreNamed(ui3,'Empty group');
    await until(()=>ui3.eval("[...document.querySelectorAll('.vault-editor')].filter(el=>el.getBoundingClientRect().height>0).length===2 && !!document.querySelector('[data-pane-id=pane-b] .empty-pane')"),'Named empty group restores');
    await pause(200);await quit(third);
    const fourth=await launch({editorCount:2}),ui4=fourth.ui;
    assert.equal(await ui4.eval("!!document.querySelector('[data-pane-id=pane-b] .empty-pane')"),true);
    const emptyRestored=await saved(ui4);assert.equal(emptyRestored.panes.length,3);assert.equal(emptyRestored.activePaneId,'pane-b');
    assert.deepEqual(emptyRestored.layout,empty.layout);
    await screenshot(ui4,'native-empty-group');await quit(fourth);
    const finalDisk=JSON.parse(await fs.readFile(workspaceFile,'utf8'));
    assert.deepEqual(finalDisk.layout,empty.layout);assert.equal(finalDisk.panes.length,3);assert.equal(finalDisk.panes.find(p=>p.id==='pane-b').tabs.length,0);
    assert.ok(finalDisk.workspaces['Native saved']&&finalDisk.workspaces['Empty group']);
    report.finalDisk={layout:finalDisk.layout,activePaneId:finalDisk.activePaneId,paneCount:finalDisk.panes.length,namedLayouts:Object.keys(finalDisk.workspaces)};
    checked('named layouts restore same-path cursor and scroll while empty tab groups survive native restart');
  }
  report.passed=true;
} catch(error) {
  report.passed=false;report.error=error.stack||error.message;process.exitCode=1;console.error(report.error);
  if(running?.ui){
    try { report.failureDOM=await running.ui.eval("({url:location.href,text:document.body.innerText.slice(0,12000),dialog:document.querySelector('[role=dialog]')?.outerHTML,active:document.activeElement?.outerHTML,panes:document.querySelectorAll('[data-pane-id]').length,editors:document.querySelectorAll('.vault-editor').length,html:document.body.innerHTML.slice(0,6000)})");report.failureWorkspace=await saved(running.ui);report.rendererEvents=running.ui.events;await screenshot(running.ui,'native-failure'); } catch {}
  }
}
finally {
  if(running){try{await quit(running);}catch{running.child.kill();}}
  for(const socket of sockets)socket.close();for(const child of children)child.kill();
  await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,report:path.join(output,'report.json')}));
}
