async function pluginEditorReference(config) {
  const fs = require('node:fs'), path = require('node:path'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  if (!a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault; mutations forbidden');
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = [], id = 'round3-editor-lab';
  const clone = value => JSON.parse(JSON.stringify(value));
  const run = async (id, fn) => { try { results.push({ id, status: 'observed', ...(await fn()) }); } catch (e) { results.push({ id, status: 'probe-error', error: String(e.stack || e) }); } fs.writeFileSync(path.join(config.run, 'editor-partial.json'), JSON.stringify(results, null, 2)); };
  const dir = path.join(config.vault, '.obsidian', 'plugins', id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: 'Round 3 Editor Lab', version: '0.0.1', minAppVersion: '1.0.0', author: 'Independent laboratory', isDesktopOnly: true }));
  fs.writeFileSync(path.join(dir, 'main.js'), `const api=require('obsidian'); module.exports=class extends api.Plugin {
    onload(){
      this.api=api;this.calls=[];this.events=[];this.lifecycle=['onload'];this.allow=true;
      this.registerEvent(this.app.workspace.on('editor-change',(editor,info)=>this.events.push({name:'editor-change',path:info.file?.path,editorMatches:editor===info.editor,value:editor.getValue()})));
      const editorCommand={id:'editor',name:'Editor callback',editorCallback:(editor,info)=>{this.calls.push({kind:'editor',path:info.file?.path,isMarkdownView:info instanceof api.MarkdownView,editorMatches:editor===info.editor,selection:editor.getSelection(),mode:info.getMode?.()});editor.replaceSelection('COMMAND');}};
      const result=this.addCommand(editorCommand);this.registration={inputIdAfter:editorCommand.id,inputNameAfter:editorCommand.name,returnIsInput:result===editorCommand,returnId:result?.id};
      this.addCommand({id:'editor-check',name:'Editor check callback',editorCheckCallback:(checking,editor,info)=>{const allowed=editor.somethingSelected();this.calls.push({kind:'editor-check',checking,allowed,path:info.file?.path,isMarkdownView:info instanceof api.MarkdownView,editorMatches:editor===info.editor,selection:editor.getSelection(),mode:info.getMode?.()});if(allowed&&!checking)editor.replaceSelection('CHECKED');return allowed;}});
      this.addCommand({id:'check',name:'Global check callback',callback:()=>this.calls.push({kind:'simple-should-be-overridden'}),checkCallback:checking=>{this.calls.push({kind:'global-check',checking,allowed:this.allow});return this.allow;}});
    }
    onunload(){this.lifecycle.push('onunload');}
  };`);
  await a.plugins.setEnable(true); await a.plugins.loadManifests(); await a.plugins.enablePlugin(id);
  const plugin = a.plugins.plugins[id]; if (!plugin?.api) throw Error('Fixture plugin did not load');
  const api = plugin.api;
  const file = await a.vault.create('Editor Lab.md', '# Editor Lab\n\nOriginal synthetic content.\n');
  const leaf = a.workspace.getLeaf(false); await leaf.openFile(file, { active: true, state: { mode: 'source', source: true } });
  a.workspace.setActiveLeaf(leaf, { focus: true }); await pause(250);
  let editor = leaf.view.editor;
  const state = () => ({ value: editor.getValue(), selection: editor.getSelection(), selections: clone(editor.listSelections()), cursors: Object.fromEntries(['head','anchor','from','to'].map(side => [side, editor.getCursor(side)])), somethingSelected: editor.somethingSelected(), mode: leaf.view.getMode(), viewState: leaf.getViewState() });
  const call = fn => { try { return { returned: fn() }; } catch (e) { return { threw: { name: e.name, message: e.message } }; } };
  await run('editor-position-unicode-crlf', async () => {
    const input = 'A😀B\r\n中文 e\u0301\r\nlast'; editor.setValue(input); await pause(70);
    return { input, state: state(), getDocSame: editor.getDoc()===editor, instanceOfEditor: editor instanceof api.Editor, activeMarkdownViewSame: a.workspace.getActiveViewOfType(api.MarkdownView)===leaf.view, lineCount: editor.lineCount(), lastLine: editor.lastLine(), lines: [0,1,2].map(n=>editor.getLine(n)), offsets: [0,1,2,3,4,5,6,10,11,100,-1].map(offset=>({offset,...call(()=>editor.offsetToPos(offset))})), positions: [{line:0,ch:0},{line:0,ch:1},{line:0,ch:3},{line:1,ch:0},{line:1,ch:100},{line:100,ch:2},{line:-1,ch:0}].map(pos=>({pos,...call(()=>editor.posToOffset(pos))})), outOfRangeLines:[-1,3,100].map(line=>({line,...call(()=>editor.getLine(line))})) };
  });
  await run('editor-reversed-and-multiple-selections', async () => {
    editor.setValue('alpha beta\ngamma delta\n');
    editor.setSelection({line:0,ch:10},{line:0,ch:6}); const reversed=state();
    const input=[{anchor:{line:0,ch:0},head:{line:0,ch:5}},{anchor:{line:1,ch:11},head:{line:1,ch:6}}];
    editor.setSelections(input,1); const multiple=state();
    editor.replaceSelection('X'); await pause(50); return { input, main:1, reversed, multiple, afterReplaceSelection:state() };
  });
  await run('editor-range-and-line', async () => {
    editor.setValue('one\ntwo\nthree'); editor.setCursor(1,1);
    const before=state(), reversedRange=call(()=>editor.getRange({line:2,ch:2},{line:0,ch:1}));
    editor.replaceRange('X\nY',{line:0,ch:1},{line:1,ch:2}); const afterReplace=state();
    editor.setLine(1,'FINAL'); return { before, reversedRange, afterReplace, afterSetLine:state() };
  });
  await run('editor-main-selection-argument', async () => {
    editor.setValue('alpha beta\ngamma delta\n');
    const ranges=[{anchor:{line:0,ch:0},head:{line:0,ch:5}},{anchor:{line:1,ch:11},head:{line:1,ch:6}}];
    const samples=[];
    for(const main of [undefined,0,1]) { editor.setSelections(ranges,main);samples.push({main:main??'omitted',state:state()}); }
    return {ranges,samples,apiVersion:api.apiVersion};
  });
  await run('editor-transaction-and-history', async () => {
    editor.setValue('alpha beta\ngamma delta\n'); await pause(600);
    const before=state();
    const transaction={changes:[{from:{line:0,ch:0},to:{line:0,ch:5},text:'A'},{from:{line:1,ch:6},to:{line:1,ch:11},text:'D'}],selections:[{from:{line:0,ch:1}},{from:{line:1,ch:7},to:{line:1,ch:6}}]};
    const returned=editor.transaction(transaction,'round3-lab'); await pause(40); const after=state();
    editor.undo(); await pause(40); const afterUndo=state(); editor.redo(); await pause(40); const afterRedo=state();
    return {transaction,returnedType:typeof returned,before,after,afterUndo,afterRedo};
  });
  await run('editor-exec-and-wordAt', async () => {
    editor.setValue('alpha beta\n中文 hello-world\n'); editor.setCursor({line:0,ch:2});
    const words=[{line:0,ch:0},{line:0,ch:5},{line:0,ch:6},{line:1,ch:1},{line:1,ch:8}].map(pos=>({pos,range:editor.wordAt(pos)}));
    const commands=[];
    for(const name of ['goRight','goStart','goEnd','goWordLeft','indentMore','indentLess','newlineAndIndent']){const result=call(()=>editor.exec(name));commands.push({name,result,state:state()});}
    const unsupportedSelectAll=call(()=>editor.exec('selectAll'));
    const unknown=call(()=>editor.exec('round3-not-real')); return {words,commands,unsupportedSelectAll,unknown};
  });
  await run('editor-command-registration', async () => {
    return {registration:plugin.registration,commands:Object.values(a.commands.commands).filter(c=>c.id.startsWith(id+':')).map(c=>({id:c.id,name:c.name,hasCallback:typeof c.callback==='function',hasCheckCallback:typeof c.checkCallback==='function',hasEditorCallback:typeof c.editorCallback==='function',hasEditorCheckCallback:typeof c.editorCheckCallback==='function'}))};
  });
  await run('editor-commands-source', async () => {
    editor.setValue('alpha beta'); editor.setSelection({line:0,ch:0},{line:0,ch:5}); editor.focus(); plugin.calls.length=0;
    const command=a.commands.commands[id+':editor-check'];
    const checking=call(()=>command.checkCallback(true)); const beforeExecute=state();
    const executed=a.commands.executeCommandById(id+':editor-check'); const afterExecute=state();
    editor.setCursor(0,0); const noSelectionCheck=call(()=>command.checkCallback(true)); const noSelectionExecute=a.commands.executeCommandById(id+':editor-check');
    const editorExecuted=a.commands.executeCommandById(id+':editor');
    return {checking,beforeExecute,executed,afterExecute,noSelectionCheck,noSelectionExecute,editorExecuted,final:state(),calls:clone(plugin.calls)};
  });
  await run('global-command-check-precedence', async () => {
    plugin.calls.length=0;const command=a.commands.commands[id+':check'];plugin.allow=false;
    const falseCheck=call(()=>command.checkCallback(true)),falseExecute=a.commands.executeCommandById(id+':check');plugin.allow=true;
    const trueCheck=call(()=>command.checkCallback(true)),trueExecute=a.commands.executeCommandById(id+':check');
    return {falseCheck,falseExecute,trueCheck,trueExecute,calls:clone(plugin.calls)};
  });
  await run('editor-commands-reading-mode', async () => {
    await leaf.setViewState({type:'markdown',state:{file:file.path,mode:'preview'}});a.workspace.setActiveLeaf(leaf,{focus:true});await pause(250);editor=leaf.view.editor;plugin.calls.length=0;
    const before=state(),activeView=a.workspace.getActiveViewOfType(api.MarkdownView),command=a.commands.commands[id+':editor-check'];
    const checking=call(()=>command.checkCallback(true)),executed=a.commands.executeCommandById(id+':editor');await pause(50);
    return {before,activeViewSame:activeView===leaf.view,checking,executed,after:state(),calls:clone(plugin.calls)};
  });
  await run('editor-commands-no-markdown-view', async () => {
    const blank=a.workspace.getLeaf('tab');await blank.setViewState({type:'empty',active:true});a.workspace.setActiveLeaf(blank,{focus:true});await pause(200);plugin.calls.length=0;
    const command=a.commands.commands[id+':editor-check'];
    const checking=call(()=>command.checkCallback(true)),executed=a.commands.executeCommandById(id+':editor');
    return {activeViewType:blank.view.getViewType(),activeMarkdownViewIsNull:a.workspace.getActiveViewOfType(api.MarkdownView)===null,checking,executed,calls:clone(plugin.calls)};
  });
  await run('plugin-disable-editor-resources', async () => {
    a.workspace.setActiveLeaf(leaf,{focus:true});await leaf.setViewState({type:'markdown',state:{file:file.path,mode:'source',source:true}});editor=leaf.view.editor;editor.setValue('Final saved synthetic content.\n');await leaf.view.save();
    const eventsBefore=clone(plugin.events),lifecycleBefore=clone(plugin.lifecycle);await a.plugins.disablePlugin(id);await pause(50);
    const eventCountAfterDisable=plugin.events.length;editor.replaceRange('AFTER_DISABLE ',{line:0,ch:0});await pause(80);await leaf.view.save();
    return {lifecycleBefore,lifecycleAfter:plugin.lifecycle,eventsBefore,eventCountAfterDisable,eventCountAfterEdit:plugin.events.length,commandsStillRegistered:Object.keys(a.commands.commands).filter(key=>key.startsWith(id+':')),executeRemoved:a.commands.executeCommandById(id+':editor'),disk:fs.readFileSync(path.join(config.vault,file.path),'utf8'),screenshot:await ipcRenderer.invoke('round3:capture','plugin-editor-final')};
  });
  ipcRenderer.send('round3:report',{schema:'obsidian-windows-round3-plugin-editor-v1',status:'complete',completionMeaning:'Sequence finished; individual probe-error cases are unverified.',environment:{coreVersion:'1.13.7',versions:process.versions,vaultIsSynthetic:true,coreSha256:config.coreSha256},results});
}
