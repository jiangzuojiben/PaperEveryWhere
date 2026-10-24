async(page)=>{
  const scope=await page.evaluate(async()=>({url:location.href,userAgent:navigator.userAgent,vaultPath:(await window.vaultdesk.snapshot()).vaultPath}));
  if(!scope.url.includes('/VaultDesk-0.4.0-Windows-x64/')||!/\/output\/desktop-ui-\d+\/vault$/.test(scope.vaultPath.replaceAll('\\','/')))throw Error('Dedicated 0.4.0 vault required');
  await page.evaluate(async()=>{const w=await window.vaultdesk.windowInfo();await window.vaultdesk.focusWindow(w.windowId);});
  const errors=[],warnings=[],results=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='warning'||m.type()==='error')warnings.push({type:m.type(),text:m.text()});});
  const settings=async()=>{await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'本地插件',exact:true}).click();};
  for(const [id,name] of [['office-viewer','Office Viewer'],['ppt-viewer','PPT Viewer']]){
    await settings();const base='output/playwright/ppt-plugin-check-20261024-161019/'+id+'/';
    await page.getByLabel('manifest.json',{exact:true}).setInputFiles(base+'manifest.json');
    await page.getByLabel('main.js',{exact:true}).setInputFiles(base+'main.js');
    await page.getByLabel('styles.css（可选）',{exact:true}).setInputFiles(base+'styles.css');
    await page.getByRole('button',{name:'导入插件',exact:true}).click();
    const card=page.locator('.plugin-card').filter({has:page.getByText(name,{exact:true})});
    await card.getByRole('button',{name:'启用可信插件',exact:true}).click();await card.getByRole('button',{name:'停用',exact:true}).waitFor();
    const cssMounted=await page.locator('style[data-plugin-id="'+id+'"]').count()===1;
    if(!cssMounted)throw Error('Plugin CSS missing');
    await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
    await page.getByRole('treeitem',{name:'Two.pptx 操作 Two.pptx',exact:true}).click();
    const counter=id==='office-viewer'?'1 / 2':'第 1 页，共 2 页';
    await page.getByText(counter,{exact:true}).first().waitFor();
    const first=await page.locator('.plugin-view-mount').innerText();if(!first.includes('Obsidian PPTX smoke test'))throw Error('First slide missing');
    await page.getByRole('button',{name:id==='office-viewer'?'下一页':'下一页 ▶',exact:true}).click();
    await page.getByText(id==='office-viewer'?'2 / 2':'第 2 页，共 2 页',{exact:true}).first().waitFor();
    const second=await page.locator('.plugin-view-mount').innerText();if(!second.includes('Second slide proof'))throw Error('Second slide missing');
    await page.screenshot({path:'docs/images/ppt-'+id+'-040.png'});
    await page.getByRole('button',{name:id==='office-viewer'?'上一页':'◀ 上一页',exact:true}).click();await page.getByText(counter,{exact:true}).first().waitFor();
    const layout=await page.evaluate(()=>window.vaultdesk.loadWorkspace());
    await settings();await page.locator('.plugin-card').filter({has:page.getByText(name,{exact:true})}).getByRole('button',{name:'停用',exact:true}).click();
    await page.locator('.plugin-card').filter({has:page.getByText(name,{exact:true})}).getByRole('button',{name:'启用可信插件',exact:true}).waitFor();
    const cssRemoved=await page.locator('style[data-plugin-id="'+id+'"]').count()===0;
    await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
    await page.getByText('此视图所属插件尚未启用，或视图已关闭。',{exact:true}).waitFor();
    if(!cssRemoved)throw Error('Plugin CSS survived disable');
    results.push({id,name,enabled:true,cssMounted,first,second,previousPage:true,cssRemoved,placeholderAfterDisable:true,layout,mode:id==='ppt-viewer'?'plugin Windows compatibility fallback':'plugin PPTX renderer'});
  }
  if(errors.length)throw Error('Page errors: '+errors.join('; '));
  return await page.evaluate(v=>btoa(unescape(encodeURIComponent(JSON.stringify(v)))),{scope,results,errors,warnings,verifiedAt:new Date().toISOString(),limit:'PPTX reading and navigation only. No native converter, PDF export, legacy PPT, complex fidelity or original real-plugin runtime claim.'});
}
