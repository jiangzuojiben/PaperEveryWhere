async function pluginDataReference(config) {
  const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{ipcRenderer}=require('electron');
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let i=0;i<350&&(!window.app?.workspace?.layoutReady||!window.app?.vault?.getFiles().length);i++)await pause(100);
  const a=window.app;
  if(!a?.vault||path.resolve(a.vault.adapter.getBasePath())!==path.resolve(config.vault))throw Error('Unexpected vault; mutations forbidden');
  while(!fs.existsSync(path.join(config.run,'start.signal')))await pause(100);
  const results=[],id='round3-data-lab',events=[];
  const clone=value=>JSON.parse(JSON.stringify(value));
  const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
  const errorValue=e=>({name:e.name,message:e.message,status:e.status??null});
  const settle=async fn=>{try{const returned=await fn();return{returnedType:typeof returned,returned};}catch(e){return{threw:errorValue(e)};}};
  const run=async(id,fn)=>{try{results.push({id,status:'observed',...(await fn())});}catch(e){results.push({id,status:'probe-error',error:String(e.stack||e)});}fs.writeFileSync(path.join(config.run,'data-partial.json'),JSON.stringify(results,null,2));};
  const waitFor=async(fn,label)=>{for(let i=0;i<100;i++){const value=fn();if(value)return value;await pause(50);}throw Error('Wait expired: '+label);};
  const dir=path.join(config.vault,'.obsidian','plugins',id);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({id,name:'Round 3 Data Lab',version:'0.0.1',minAppVersion:'1.0.0',author:'Independent laboratory',isDesktopOnly:true}));
  fs.writeFileSync(path.join(dir,'main.js'),`const api=require('obsidian');module.exports=class extends api.Plugin{onload(){this.api=api;}};`);
  await a.plugins.setEnable(true);await a.plugins.loadManifests();await a.plugins.enablePlugin(id);
  const plugin=a.plugins.plugins[id],api=plugin?.api;if(!api)throw Error('Fixture API unavailable');
  const eventRefs=[];
  eventRefs.push([a.metadataCache,a.metadataCache.on('changed',(file,data,cache)=>{if(file.path.startsWith('Data/'))events.push({kind:'metadata-changed',path:file.path,data,cache:clone(cache)});})]);
  eventRefs.push([a.metadataCache,a.metadataCache.on('resolve',file=>{if(file?.path?.startsWith('Data/'))events.push({kind:'metadata-resolve',path:file.path});})]);
  eventRefs.push([a.metadataCache,a.metadataCache.on('resolved',()=>events.push({kind:'metadata-resolved'}))]);
  for(const name of ['create','modify','rename','delete'])eventRefs.push([a.vault,a.vault.on(name,(file,oldPath)=>{if(file.path.startsWith('Data/'))events.push({kind:'vault-'+name,path:file.path,oldPath:typeof oldPath==='string'?oldPath:undefined,isFile:file instanceof api.TFile});})]);
  await a.vault.createFolder('Data');
  await run('metadata-file-cache-and-link-helpers',async()=>{
    const input='---\ntags: [lab, lab/nested]\naliases: [Alias One]\nrelated: "[[Sources/Note]]"\n---\n# Heading 中文😀\n\nParagraph #body/tag and [[Sources/Note#Section One|Shown]]. ^block-one\n\n![[Sources/Other]]\n\n```txt\n#ignored [[MissingInCode]]\n```\n\n[[Missing Target]]\n';
    const file=await a.vault.create('Data/Metadata.md',input);
    await waitFor(()=>a.metadataCache.getFileCache(file)?.blocks?.['block-one'],'metadata cache');await pause(100);
    const cache=a.metadataCache.getFileCache(file);
    return{input,file:{path:file.path,name:file.name,basename:file.basename,extension:file.extension,parent:file.parent.path,stat:clone(file.stat),isTFile:file instanceof api.TFile},cache:clone(cache),getCacheSame:a.metadataCache.getCache(file.path)===cache,getAllTags:api.getAllTags(cache),aliases:api.parseFrontMatterAliases(cache.frontmatter),frontmatterTags:api.parseFrontMatterTags(cache.frontmatter),resolvedLinks:clone(a.metadataCache.resolvedLinks[file.path]||{}),unresolvedLinks:clone(a.metadataCache.unresolvedLinks[file.path]||{}),resolvedSubpaths:['#Heading 中文😀','#heading 中文😀','#^block-one','#Missing'].map(subpath=>({subpath,result:api.resolveSubpath(cache,subpath)})),linktextSamples:['Sources/Note#Section One','Sources/Note#^anchor-one','#Heading','Plain'].map(link=>({link,parsed:api.parseLinktext(link),getLinkpath:api.getLinkpath(link)})),destination:a.metadataCache.getFirstLinkpathDest('Sources/Note','Data/Metadata.md')?.path,fileToLinktext:{default:a.metadataCache.fileToLinktext(a.vault.getAbstractFileByPath('Sources/Note.md'),'Data/Metadata.md'),omitExtension:a.metadataCache.fileToLinktext(a.vault.getAbstractFileByPath('Sources/Note.md'),'Data/Metadata.md',true)},events:clone(events)};
  });
  await run('metadata-modification-events',async()=>{
    const file=a.vault.getAbstractFileByPath('Data/Metadata.md');const before=clone(a.metadataCache.getFileCache(file));const mark=events.length;
    const next='# Replaced\n\n[[Sources/Other]]\n';await a.vault.modify(file,next);
    const immediately=clone(a.metadataCache.getFileCache(file));await waitFor(()=>a.metadataCache.getFileCache(file)?.headings?.[0]?.heading==='Replaced','updated metadata');await pause(100);
    return{next,before,immediately,after:clone(a.metadataCache.getFileCache(file)),events:clone(events.slice(mark)),resolvedLinks:clone(a.metadataCache.resolvedLinks[file.path]||{}),unresolvedLinks:clone(a.metadataCache.unresolvedLinks[file.path]||{})};
  });
  await run('process-frontmatter-fixtures',async()=>{
    const inputs=[
      {name:'existing-comments',input:'---\n# keep comment\ncount: 1 # count note\nuntouched: yes\nnested:\n  x: 1\n---\n\n# Body KEEP\n',operation:'update'},
      {name:'crlf-bom',input:'\uFEFF---\r\ncount: 1\r\nuntouched: yes\r\n---\r\nBody KEEP\r\n',operation:'update'},
      {name:'crlf',input:'---\r\ncount: 1\r\nuntouched: yes\r\n---\r\nBody KEEP\r\n',operation:'update'},
      {name:'no-frontmatter',input:'# Body KEEP\n\nNo YAML.\n',operation:'update'},
      {name:'empty-frontmatter',input:'---\n---\nBody KEEP\n',operation:'update'},
      {name:'null-frontmatter',input:'---\nnull\n---\nBody KEEP\n',operation:'update'},
      {name:'array-frontmatter',input:'---\n- alpha\n- beta\n---\nBody KEEP\n',operation:'update'},
      {name:'invalid-yaml',input:'---\nitems: [oops\n---\nBody KEEP\n',operation:'update'},
      {name:'callback-throws',input:'---\ncount: 1\n---\nBody KEEP\n',operation:'throw'},
      {name:'noop-comments',input:'---\n# Keep this\ncount: 1 # inline\n---\nBody KEEP\n',operation:'noop'},
      {name:'remove-all',input:'---\ncount: 1\n---\nBody KEEP\n',operation:'delete'},
      {name:'callback-return-ignored',input:'---\ncount: 1\n---\nBody KEEP\n',operation:'return'},
    ];
    const fixtures=[];
    for(const item of inputs){
      const file=await a.vault.create('Data/FM-'+item.name+'.md',item.input);let callbackInput=null,callbackType=null,callbackCalls=0;
      const outcome=await settle(()=>a.fileManager.processFrontMatter(file,fm=>{callbackCalls++;callbackInput=clone(fm);callbackType={type:typeof fm,array:Array.isArray(fm),prototype:Object.getPrototypeOf(fm)?.constructor?.name};if(item.operation==='throw'){fm.count=99;throw Error('LAB CALLBACK FAILURE');}if(item.operation==='noop')return;if(item.operation==='delete'){for(const key of Object.keys(fm))delete fm[key];return;}if(item.operation==='return')return{ignored:true};fm.count=2;fm.added=['a','b'];delete fm.untouched;}));
      const after=await a.vault.read(file),disk=fs.readFileSync(path.join(config.vault,file.path),'utf8');
      fixtures.push({...item,callbackCalls,callbackInput,callbackType,outcome,after,diskEqualsRead:disk===after,changed:after!==item.input,inputSha256:hash(item.input),afterSha256:hash(after)});
    }
    return{fixtures};
  });
  await run('frontmatter-and-vault-process-serialization',async()=>{
    const file=await a.vault.create('Data/Counter.md','---\ncount: 0\n---\nBody KEEP\n');const seen=[];
    const results=await Promise.allSettled([a.fileManager.processFrontMatter(file,fm=>{seen.push(fm.count);fm.count++;}),a.fileManager.processFrontMatter(file,fm=>{seen.push(fm.count);fm.count++;})]);
    const afterFrontmatter=await a.vault.read(file);const processInputs=[];
    const processResults=await Promise.allSettled([a.vault.process(file,text=>{processInputs.push(text);return text+'A\n';}),a.vault.process(file,text=>{processInputs.push(text);return text+'B\n';})]);
    return{seen,results:results.map(x=>({status:x.status,value:x.value,error:x.reason?errorValue(x.reason):undefined})),afterFrontmatter,processInputs,processResults:processResults.map(x=>({status:x.status,value:x.value,error:x.reason?errorValue(x.reason):undefined})),afterProcess:await a.vault.read(file)};
  });
  await run('vault-binary-roundtrip-and-copy',async()=>{
    const input=[0,1,127,128,255,13,10],buffer=new Uint8Array(input).buffer;
    const file=await a.vault.createBinary('Data/bytes.bin',buffer,{ctime:1600000000000,mtime:1600000001000});
    const read=await a.vault.readBinary(file),firstStat=clone(file.stat),resourcePath=a.vault.getResourcePath(file);
    await a.vault.modifyBinary(file,new Uint8Array([5,0,255]).buffer);const modified=[...new Uint8Array(await a.vault.readBinary(file))];
    await a.vault.appendBinary(file,new Uint8Array([17,18]).buffer);const appended=[...new Uint8Array(await a.vault.readBinary(file))];
    const copy=await a.vault.copy(file,'Data/copied.bin');const copied=[...new Uint8Array(await a.vault.readBinary(copy))];
    await a.vault.adapter.writeBinary('Data/adapter.bin',new Uint8Array([32,0,128]).buffer);const adapterRead=await a.vault.adapter.readBinary('Data/adapter.bin');
    return{input,readIsArrayBuffer:read instanceof ArrayBuffer,read:[...new Uint8Array(read)],firstStat,resourcePath,modified,appended,copied,copy:{path:copy.path,isTFile:copy instanceof api.TFile,stat:clone(copy.stat)},adapterReadIsArrayBuffer:adapterRead instanceof ArrayBuffer,adapterRead:[...new Uint8Array(adapterRead)],disk:[...fs.readFileSync(path.join(config.vault,file.path))]};
  });
  await run('request-url-json-and-shortcuts',async()=>{
    const request=api.requestUrl(config.localUrl+'/api/json');
    const [response,text,json,bytes]=await Promise.all([request,request.text,request.json,request.arrayBuffer]);
    return{promiseIsPromise:request instanceof Promise,httpStatus:response.status,headers:response.headers,text:response.text,json:response.json,arrayBufferIsArrayBuffer:response.arrayBuffer instanceof ArrayBuffer,bytes:[...new Uint8Array(response.arrayBuffer)],shortcuts:{text,json,bytes:[...new Uint8Array(bytes)]}};
  });
  await run('request-url-binary-post-and-redirect',async()=>{
    const body=[0,255,128,13,10];const echo=await api.requestUrl({url:config.localUrl+'/api/echo',method:'POST',contentType:'application/octet-stream',headers:{'X-Round3':'Synthetic'},body:new Uint8Array(body).buffer});
    const binary=await api.requestUrl(config.localUrl+'/api/binary');
    const redirect=await api.requestUrl(config.localUrl+'/api/redirect');
    const legacy=await api.request({url:config.localUrl+'/api/text'});
    return{body,echo:{status:echo.status,json:echo.json},binary:{status:binary.status,headers:binary.headers,bytes:[...new Uint8Array(binary.arrayBuffer)]},redirect:{status:redirect.status,json:redirect.json},legacy:{returnedType:typeof legacy,value:legacy}};
  });
  await run('request-url-error-and-non-json',async()=>{
    const defaultError=await settle(()=>api.requestUrl(config.localUrl+'/api/error'));
    const allowed=await api.requestUrl({url:config.localUrl+'/api/error',throw:false});
    const textResponse=await api.requestUrl(config.localUrl+'/api/text');
    let jsonOutcome;try{jsonOutcome={value:textResponse.json};}catch(e){jsonOutcome={threw:errorValue(e)};}
    return{defaultError,throwFalse:{status:allowed.status,json:allowed.json,text:allowed.text},textResponse:{status:textResponse.status,text:textResponse.text,jsonOutcome}};
  });
  for(const[emitter,ref]of eventRefs)emitter.offref(ref);await a.plugins.disablePlugin(id);
  ipcRenderer.send('round3:report',{schema:'obsidian-windows-round3-plugin-data-v1',status:'complete',completionMeaning:'Sequence finished; individual probe-error cases are unverified.',environment:{coreVersion:'1.13.7',versions:process.versions,vaultIsSynthetic:true,networkScope:'Dedicated local synthetic HTTP endpoints only',coreSha256:config.coreSha256},results});
}
