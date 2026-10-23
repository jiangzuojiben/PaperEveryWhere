async function syntheticCompositionReference(config) {
  const fs=require('node:fs'),path=require('node:path'),{ipcRenderer}=require('electron');
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let i=0;i<350&&(!window.app?.workspace?.layoutReady||!window.app?.vault?.getFiles().length);i++)await pause(100);
  const a=window.app;
  if(!a?.vault||path.resolve(a.vault.adapter.getBasePath())!==path.resolve(config.vault))throw Error('Unexpected vault; mutations forbidden');
  while(!fs.existsSync(path.join(config.run,'start.signal')))await pause(100);
  const results=[],events=[];
  const run=async(id,fn)=>{try{results.push({id,status:'observed',...(await fn())});}catch(e){results.push({id,status:'probe-error',error:String(e.stack||e)});}};
  const A=await a.vault.create('Composition A.md','A original\n'),B=await a.vault.create('Composition B.md','B original\n');
  const leaf=a.workspace.getLeaf(false);await leaf.openFile(A,{state:{mode:'source',source:true},active:true});a.workspace.setActiveLeaf(leaf,{focus:true});await pause(200);
  const eventRef=a.workspace.on('editor-change',(editor,info)=>events.push({kind:'editor-change',path:info.file?.path,value:editor.getValue()}));
  const inspect=()=>({activeFile:a.workspace.getActiveFile()?.path,viewFile:leaf.view.file?.path,mode:leaf.view.getMode(),value:leaf.view.editor.getValue(),cursor:leaf.view.editor.getCursor(),compositionDiagnostic:{composing:leaf.view.editor.cm?.composing,compositionStarted:leaf.view.editor.cm?.compositionStarted},events:[...events]});
  await run('synthetic-composition-file-switch',async()=>{
    const editor=leaf.view.editor;editor.setCursor(0,10);editor.focus();const content=leaf.containerEl.querySelector('.cm-content');if(!content)throw Error('Editor content not found');
    const start=new CompositionEvent('compositionstart',{bubbles:true,data:''});content.dispatchEvent(start);
    const insertFirst=document.execCommand('insertText',false,'中');await pause(100);const beforeSwitch=inspect();
    let switchSettled=false,switchError=null;const pending=leaf.openFile(B,{active:true}).then(()=>{switchSettled=true;},e=>{switchError=String(e);switchSettled=true;});
    await pause(200);const duringSwitch=inspect(),oldContentConnected=content.isConnected;
    const end=new CompositionEvent('compositionend',{bubbles:true,data:'中文'});content.dispatchEvent(end);
    const insertTail=document.execCommand('insertText',false,'文');await Promise.race([pending,pause(2000)]);await pause(150);await leaf.view.save();
    return{eventMethod:'DOM CompositionEvent + document.execCommand(insertText)',isTrusted:{start:start.isTrusted,end:end.isTrusted},insertFirst,insertTail,beforeSwitch,duringSwitch,oldContentConnected,switchSettled,switchError,after:inspect(),disk:{a:fs.readFileSync(path.join(config.vault,A.path),'utf8'),b:fs.readFileSync(path.join(config.vault,B.path),'utf8')},screenshot:await ipcRenderer.invoke('round3:capture','synthetic-composition-switch')};
  });
  await run('synthetic-composition-mode-switch',async()=>{
    await leaf.openFile(A,{active:true,state:{mode:'source',source:true}});await pause(100);const editor=leaf.view.editor;editor.setCursor(0,editor.getLine(0).length);editor.focus();const content=leaf.containerEl.querySelector('.cm-content');
    const start=new CompositionEvent('compositionstart',{bubbles:true,data:''});content.dispatchEvent(start);const insertFirst=document.execCommand('insertText',false,'甲');await pause(100);const beforeSwitch=inspect();
    await leaf.setViewState({type:'markdown',state:{file:A.path,mode:'preview'}});await pause(150);const duringSwitch=inspect();
    const end=new CompositionEvent('compositionend',{bubbles:true,data:'甲'});content.dispatchEvent(end);await pause(100);await leaf.view.save();
    return{eventMethod:'DOM CompositionEvent + document.execCommand(insertText)',isTrusted:{start:start.isTrusted,end:end.isTrusted},insertFirst,beforeSwitch,duringSwitch,after:inspect(),disk:fs.readFileSync(path.join(config.vault,A.path),'utf8')};
  });
  a.workspace.offref(eventRef);
  ipcRenderer.send('round3:report',{schema:'obsidian-windows-round3-synthetic-composition-v1',status:'complete',completionMeaning:'Programmatically dispatched DOM events only; these observations do not establish Windows IME behavior.',environment:{coreVersion:'1.13.7',versions:process.versions,vaultIsSynthetic:true,coreSha256:config.coreSha256},limitations:['No operating-system input method candidate or pre-edit window was used.','All composition events have isTrusted=false.','document.execCommand insertText does not reproduce the complete OS IME input sequence.','No physical keyboard, key-up timing or cross-window IME state was verified.'],results});
}
