async(page)=>{
  const scope=await page.evaluate(async()=>({url:location.href,userAgent:navigator.userAgent,vaultPath:(await window.vaultdesk.snapshot()).vaultPath}));
  if(!/\/output\/desktop-ui-\d+\/vault$/.test(scope.vaultPath.replaceAll('\\','/'))||!scope.url.includes('/VaultDesk-0.3.2-Windows-x64/')||!scope.userAgent.includes('VaultDesk/0.3.2'))throw Error('Dedicated packaged 0.3.2 test vault required');
  const errors=[],warnings=[],checks=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());if(message.type()==='warning')warnings.push(message.text());});
  await page.evaluate(async()=>{
    await window.vaultdesk.create('Redo-A.md','Undo baseline');
    await window.vaultdesk.create('Redo-B.md','B untouched');
    window.__redoPatchKeys=[];
    window.addEventListener('keydown',e=>{if(e.target.closest?.('.vault-editor'))window.__redoPatchKeys.push({key:e.key,code:e.code,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,isTrusted:e.isTrusted,path:e.target.closest('.vault-editor').dataset.editorPath});},true);
  });
  const editor=()=>page.getByRole('textbox',{name:'笔记编辑器',exact:true});
  async function check(name,expected,path='Redo-A.md'){
    let snapshot;const deadline=Date.now()+10000;
    do{snapshot=await page.evaluate(async()=>{
      const shell=document.querySelector('.vault-editor');
      return {path:shell.dataset.editorPath,mode:shell.dataset.editorMode,lines:[...shell.querySelectorAll('.cm-content>.cm-line')].map(e=>e.textContent),renderedText:shell.textContent,a:(await window.vaultdesk.read('Redo-A.md')).content,b:(await window.vaultdesk.read('Redo-B.md')).content};
    });
      if(snapshot.path===path&&snapshot[path==='Redo-A.md'?'a':'b']===expected)break;
      await page.waitForTimeout(50);
    }while(Date.now()<deadline);
    if(snapshot.path!==path||snapshot[path==='Redo-A.md'?'a':'b']!==expected)throw Error(`Disk mismatch: ${name}: ${JSON.stringify({snapshot,expected,path})}`);
    if(snapshot.mode!=='reading'&&snapshot.lines.join('\n')!==expected)throw Error(`Editor mismatch: ${name}`);
    if(snapshot.mode==='reading'&&!snapshot.renderedText.includes(expected))throw Error(`Reading mismatch: ${name}`);
    if(snapshot.b!=='B untouched')throw Error(`Other document changed: ${name}`);
    checks.push({name,...snapshot,passed:true});
  }
  await page.getByRole('treeitem',{name:'Redo-A 操作 Redo-A.md',exact:true}).click();
  await page.getByRole('button',{name:'源码模式',exact:true}).click();
  await editor().click();await editor().press('Control+End');await page.keyboard.type(' SOURCE');
  await check('source typed','Undo baseline SOURCE');
  await editor().press('Control+z');await check('source undo','Undo baseline');
  await editor().press('Control+Shift+Z');await check('source Ctrl+Shift+Z redo','Undo baseline SOURCE');
  await editor().press('Control+z');await check('source undo for Ctrl+Y','Undo baseline');
  await editor().press('Control+y');await check('source Ctrl+Y redo','Undo baseline SOURCE');
  await page.getByRole('button',{name:'实时预览',exact:true}).click();await check('live keeps source content','Undo baseline SOURCE');
  await editor().click();await editor().press('Control+End');await page.keyboard.type(' LIVE');await check('live typed','Undo baseline SOURCE LIVE');
  await editor().press('Control+z');await check('live undo','Undo baseline SOURCE');
  await editor().press('Control+Shift+Z');await check('live Ctrl+Shift+Z redo','Undo baseline SOURCE LIVE');
  await editor().press('Control+z');await check('live undo for Ctrl+Y','Undo baseline SOURCE');
  await editor().press('Control+y');await check('live Ctrl+Y redo','Undo baseline SOURCE LIVE');
  await page.getByRole('button',{name:'阅读模式',exact:true}).click();await check('reading content','Undo baseline SOURCE LIVE');
  await page.getByRole('button',{name:'源码模式',exact:true}).click();await check('source after reading','Undo baseline SOURCE LIVE');
  await page.getByRole('treeitem',{name:'Redo-B 操作 Redo-B.md',exact:true}).click();await check('B unchanged','B untouched','Redo-B.md');
  await editor().press('Control+z');await check('B cannot undo A','B untouched','Redo-B.md');
  await page.getByRole('treeitem',{name:'Redo-A 操作 Redo-A.md',exact:true}).click();await check('A retains redone content','Undo baseline SOURCE LIVE');
  const keys=await page.evaluate(()=>window.__redoPatchKeys);
  if(keys.filter(k=>k.ctrl&&k.shift&&k.key==='Z'&&k.isTrusted).length!==2)throw Error('Expected uppercase Ctrl+Shift+Z keyboard route');
  if(errors.length||warnings.length)throw Error(`Console findings ${JSON.stringify({errors,warnings})}`);
  await page.screenshot({path:'docs/images/windows-ime-patch-032.png'});
  return await page.evaluate(value=>btoa(unescape(encodeURIComponent(JSON.stringify(value)))),{scope,checks,keys,console:{errors,warnings},verifiedAt:new Date().toISOString(),method:'Packaged renderer UI keyboard route via Playwright/CDP; no direct undo/redo API',physicalIme:false,automatedText:'ASCII SOURCE/LIVE only',limit:'Physical Chinese IME evidence belongs to preserved version 0.3.1, not this keyboard test.'});
}
