async function fileViewReference(config) {
 const fs=require('node:fs'),path=require('node:path'),{ipcRenderer}=require('electron');
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 while(!window.app?.workspace?.layoutReady) await pause(100);
 const a=window.app;if(path.resolve(a.vault.adapter.getBasePath())!==path.resolve(config.vault))throw Error('Unexpected vault');
 while(!fs.existsSync(path.join(config.run,'start.signal')))await pause(100);
 const dir=path.join(config.vault,'.obsidian/plugins/file-view-lab');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({id:'file-view-lab',name:'FileView reference',version:'0.0.1',minAppVersion:'1.0.0',author:'Lab',description:'Isolated',isDesktopOnly:true}));
 fs.writeFileSync(path.join(dir,'main.js'),`const {Plugin,FileView}=require('obsidian');window.__fv=[]; class V extends FileView {getViewType(){return 'lab-file'}getDisplayText(){return this.file?.name||'Lab'}async onOpen(){window.__fv.push(['open',this.file?.path||null])}async onLoadFile(f){window.__fv.push(['load',f.path,this.file===f]);this.contentEl.setText('Loaded '+f.path)}async onUnloadFile(f){window.__fv.push(['unload',f.path,this.file===f])}}module.exports=class extends Plugin{onload(){this.registerView('lab-file',l=>new V(l));this.registerExtensions(['labfile'],'lab-file')}}`);
 a.plugins.setEnable(true);await a.plugins.loadManifests();await a.plugins.enablePlugin('file-view-lab');
 const f=await a.vault.create('Test.labfile','synthetic');const leaf=a.workspace.getLeaf(true);await leaf.openFile(f);await pause(200);
 const state=leaf.getViewState();await leaf.openFile(a.vault.getAbstractFileByPath('Start.md'));await pause(200);
 await a.plugins.disablePlugin('file-view-lab');
 ipcRenderer.send('round3:report',{schema:'file-view-reference-v1',status:'complete',results:[{id:'file-view-lifecycle',status:'observed',state,events:window.__fv}]});
}
