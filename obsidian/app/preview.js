export const starter={
  '开始.md':'---\ntags: [指南, 知识管理]\nstatus: 进行中\n---\n# 从一个想法开始\n\n欢迎来到你的知识库。这里的每一篇笔记都是普通的 **Markdown 文件**。\n\n> [!tip] 让想法相遇\n> 输入 `[[` 链接另一篇笔记。打开 [[知识网络]]，看看连接如何生长。\n\n## 今天的工作\n\n- [ ] 写下一个值得保留的想法\n- [ ] 用双链连接两篇笔记\n- [x] 创建属于自己的知识库\n\n## 一切都在你的掌握中\n\n| 能力 | 从这里开始 |\n| --- | --- |\n| 双向链接 | [[知识网络]] |\n| 每日记录 | 左侧日历按钮 |\n| 无限画布 | [[灵感画布.canvas]] |\n| 自部署服务 | 设置 → 同步与发布 |\n\n### 一点灵感\n\n知识的价值，也藏在知识之间的连接里。 #灵感\n\n---\n\n这是一个独立实现的开发版本。桌面端可直接打开本地文件夹，浏览器预览使用独立的演示库。\n',
  '知识网络.md':'---\naliases: [双链]\ntags: [方法]\n---\n# 知识网络\n\n从 [[开始]] 出发，用链接建立上下文。\n\n## 链接与回链\n\n`[[笔记名称]]` 会连接到另一篇笔记。右侧的反向链接会列出引用当前笔记的来源。\n\n> [!note] 保持开放\n> 尚未创建的链接也有价值。点击 [[下一个想法]] 就能把它写下来。\n\n## 数学也可以很清楚\n\n$$E = mc^2$$\n\n## 代码\n\n```javascript\nconst idea = { connected: true };\n```\n',
  '项目/阅读清单.md':'---\ntags: [阅读]\nstatus: 待整理\nrating: 5\n---\n# 阅读清单\n\n- [ ] 整理本周摘录\n- [ ] 将关键概念连接到 [[知识网络]]\n\n## 摘录\n\n好的笔记不仅记录答案，也记录问题。\n',
  '模板/每日笔记.md':'# {{date}}\n\n## 今日计划\n\n- [ ] \n\n## 记录\n\n',
  '灵感画布.canvas':JSON.stringify({nodes:[{id:'a',type:'text',x:0,y:0,width:300,height:180,text:'# 一个想法\n\n把想法放在画布上。',color:'5'},{id:'b',type:'file',file:'知识网络.md',x:430,y:80,width:300,height:220}],edges:[{id:'e',fromNode:'a',fromSide:'right',toNode:'b',toSide:'left',label:'建立连接'}]},null,2),
  '笔记目录.base':'views:\n  - type: table\n    name: 全部笔记\n    order:\n      - file.name\n      - status\n      - tags\n'
};
export function createPreviewBridge(){
  let data;try{data=JSON.parse(localStorage.getItem('vaultdesk-preview-v1'));}catch{};
  data||={files:starter,workspace:{},versions:{}};
  const mt=new Map(Object.keys(data.files).map(p=>[p,Date.now()]));const listeners=new Set();
  const persist=()=>{localStorage.setItem('vaultdesk-preview-v1',JSON.stringify(data));listeners.forEach(f=>f({type:'change'}));};
  const snapshot=async()=>({vaultPath:'演示知识库',preview:true,files:Object.entries(data.files).map(([path,content])=>({path,content,size:content.length,mtime:mt.get(path)||1}))});
  const read=async p=>{if(!(p in data.files))throw Error('文件不存在');return{content:data.files[p],mtime:mt.get(p)||1};};
  const write=async(p,text,expected)=>{if(expected&&expected!==(mt.get(p)||1))throw Error('文件已在另一处修改，请先重新载入。');(data.versions[p]||=[]).unshift({id:String(Date.now()),content:data.files[p],mtime:Date.now()});data.files[p]=text;mt.set(p,Date.now());persist();return{mtime:mt.get(p)};};
  return{snapshot,read,write,openVault:async()=>{throw Error('请使用 Windows 桌面版打开本地文件夹。浏览器为独立演示库。');},create:async(p,text='')=>{if(p in data.files)throw Error('同名文件已存在');data.files[p]=text;mt.set(p,Date.now());persist();},mkdir:async()=>{},rename:async(a,b,settings)=>{const{planRename}=await import('../core/vault.mjs');data.files=planRename(data.files,a,b,settings).files;mt.clear();Object.keys(data.files).forEach(p=>mt.set(p,Date.now()));persist();},trash:async p=>{data.trash||={};data.trash[p]=data.files[p];delete data.files[p];persist();},importFiles:async()=>{throw Error('请在桌面版导入附件。');},assetUrl:async()=>'',saveWorkspace:async s=>{data.workspace=s;localStorage.setItem('vaultdesk-preview-v1',JSON.stringify(data));},loadWorkspace:async()=>data.workspace,getHistory:async p=>(data.versions[p]||[]).slice(0,50),restoreHistory:async(p,id)=>{const v=data.versions[p]?.find(v=>v.id===id);if(v)await write(p,v.content);},onChange:f=>{listeners.add(f);return()=>listeners.delete(f);},openExternal:async url=>window.open(url,'_blank','noopener,noreferrer')};
}
