import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginWorkspaceAdapter} from '../app/plugin-workspace.mjs';
import {normalizeWorkspaceLayout,dockWorkspaceTab,splitWorkspacePane} from '../core/workspace.mjs';
function fixture(){let value=normalizeWorkspaceLayout({panes:[{id:'one',tabs:['A.md'],active:'A.md'}]});return{get value(){return value;},adapter:createPluginWorkspaceAdapter({getWorkspace:()=>value,setWorkspace:next=>{value=normalizeWorkspaceLayout(next);},getEditor:(id,path)=>({id,path})})};}
test('plugin leaves keep identity when an empty tab opens an exact hash filename',async()=>{
 const f=fixture(),leaf=f.adapter.createLeaf('tab');await f.adapter.openFile(leaf.id,'C# Basics.md');
 assert.equal(f.adapter.getLeaves().find(v=>v.id===leaf.id).state.file,'C# Basics.md');assert.equal(f.adapter.getActiveLeafId(),leaf.id);
});
test('plugin split uses the observed divider direction and editor targets its own pane',async()=>{
 const f=fixture(),leaf=f.adapter.createLeaf('split','horizontal');await f.adapter.openFile(leaf.id,'B.md');
 assert.equal(f.value.layout.direction,'horizontal');assert.equal(f.value.panes.length,2);assert.equal(f.adapter.getEditor(leaf.id).path,'B.md');
 f.adapter.detachLeaf(leaf.id);assert.equal(f.value.panes.length,1);assert.equal(f.value.panes[0].active,'A.md');
});
test('public split/tabs/leaf layout roundtrip retains identities, selected tabs, pins and modes',async()=>{
 const f=fixture(),a=f.adapter.getLeaves()[0],b=f.adapter.createLeaf('split','horizontal');
 await f.adapter.setViewState(b.id,{type:'markdown',state:{file:'B.md',mode:'preview'}});
 f.value.panes[0].pinned=['A.md'];const saved=f.adapter.getLayout();
 assert.equal(saved.main.direction,'horizontal');assert.equal(saved.main.children[0].children[0].pinned,true);
 await f.adapter.changeLayout(saved);assert.equal(f.adapter.getActiveLeafId(),b.id);assert.equal(f.adapter.getLeaves()[0].id,a.id);
 assert.equal(f.value.panes[1].tabStates['B.md'].mode,'reading');assert.equal(f.value.panes[0].pinned[0],'A.md');
 assert.deepEqual(f.adapter.getLayout(),saved);
});
test('custom view state survives public layout and closed leaf identities fail explicitly',async()=>{
 const f=fixture(),leaf=f.adapter.createLeaf('tab');await f.adapter.setViewState(leaf.id,{type:'example-view',state:{count:7}});
 const saved=f.adapter.getLayout();await f.adapter.changeLayout(saved);
 assert.deepEqual(f.adapter.getLeaves().find(v=>v.id===leaf.id).state,{count:7});
 f.adapter.detachLeaf(leaf.id);assert.throws(()=>f.adapter.revealLeaf(leaf.id),/关闭/);
});
test('invalid, cyclic and duplicate-file layouts never partially replace the workspace',async()=>{
 const f=fixture(),before=structuredClone(f.value),node={id:'x',type:'split',children:[]};node.children.push(node);
 await assert.rejects(f.adapter.changeLayout({main:node}),/无效/);assert.deepEqual(f.value,before);
 const leaf={id:'a',type:'leaf',state:{type:'markdown',state:{file:'A.md'}}};
 await assert.rejects(f.adapter.changeLayout({main:{id:'t',type:'tabs',children:[leaf,{...leaf,id:'b'}]}}),/重复/);assert.deepEqual(f.value,before);
});
test('plugin state persistence and pin changes do not activate a background leaf',async()=>{
 const f=fixture(),a=f.adapter.getLeaves()[0],b=f.adapter.createLeaf('tab');
 await f.adapter.setViewState(b.id,{type:'fixture',state:{count:1}});f.adapter.revealLeaf(a.id);
 f.adapter.updateViewState(b.id,{type:'fixture',state:{count:2}});f.adapter.setPinned(b.id,true);
 assert.equal(f.adapter.getActiveLeafId(),a.id);assert.deepEqual(f.adapter.getLeaves().find(v=>v.id===b.id).state,{count:2});assert.equal(f.adapter.getLeaves().find(v=>v.id===b.id).pinned,true);
});
test('custom view payload named file survives layout roundtrip as a custom view',async()=>{
 const f=fixture(),leaf=f.adapter.createLeaf('tab');await f.adapter.setViewState(leaf.id,{type:'board',state:{file:'Board.md',count:7}});
 const saved=f.adapter.getLayout();await f.adapter.changeLayout(saved);
 const row=f.adapter.getLeaves().find(row=>row.id===leaf.id);
 assert.equal(row.type,'board');assert.equal(row.path,'@plugin-view:'+leaf.id);assert.deepEqual(row.state,{file:'Board.md',count:7});
});
test('docking custom tabs carries payload and leaf identity across pane boundaries',async()=>{
 const f=fixture(),leaf=f.adapter.createLeaf('split','vertical');await f.adapter.setViewState(leaf.id,{type:'board',state:{count:7}});
 const row=f.adapter.getLeaves().find(row=>row.id===leaf.id),source=row.paneId,target=f.value.panes.find(p=>p.id!==source).id;
 const moved=dockWorkspaceTab(f.value,{fromId:source,path:row.path,toId:target});
 // Use a second adapter with a live setter through the existing createLeaf API's workspace provider.
 Object.assign(f.value,moved);
 const after=f.adapter.getLeaves().find(value=>value.id===leaf.id);
 assert.equal(after.paneId,target);assert.equal(after.type,'board');assert.deepEqual(after.state,{count:7});
});
test('duplicate public leaf identities reject before replacing the workspace',async()=>{
 const f=fixture(),before=structuredClone(f.value),saved=f.adapter.getLayout();
 const tabs=saved.main.children[0];tabs.children.push({...tabs.children[0],state:{type:'markdown',state:{file:'B.md'}}});
 await assert.rejects(f.adapter.changeLayout(saved),/重复 leaf ID/);assert.deepEqual(f.value,before);
});
test('splitting custom views creates distinct mount identities with independent payloads',async()=>{
 const f=fixture(),leaf=f.adapter.createLeaf('tab');await f.adapter.setViewState(leaf.id,{type:'board',state:{file:'Board.md',count:7}});
 const before=f.adapter.getLeaves().find(row=>row.id===leaf.id);
 Object.assign(f.value,splitWorkspacePane(f.value,before.paneId,'vertical'));
 const rows=f.adapter.getLeaves().filter(row=>row.type==='board');
 assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);assert.notEqual(rows[0].path,rows[1].path);
 for(const row of rows){assert.equal(row.path,'@plugin-view:'+row.id);assert.deepEqual(row.state,{file:'Board.md',count:7});}
 const [one,two]=f.value.panes.map(p=>p.pluginViews[p.active]);two.state.count=8;assert.equal(one.state.count,7);
});
test('serialized custom tabs retain their encoded leaf identity after adapter restart',async()=>{
 const f=fixture(),leaf=f.adapter.createLeaf('tab');await f.adapter.setViewState(leaf.id,{type:'board',state:{count:7}});
 const stored=JSON.parse(JSON.stringify(f.value));
 const restored=createPluginWorkspaceAdapter({getWorkspace:()=>stored,setWorkspace:()=>{},getEditor:()=>null});
 const row=restored.getLeaves().find(row=>row.type==='board');assert.equal(row.id,leaf.id);assert.equal(row.path,'@plugin-view:'+leaf.id);
});
