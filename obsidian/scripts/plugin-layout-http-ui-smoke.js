async(page)=>{
  const scope=await page.evaluate(async()=>({url:location.href,vaultPath:(await window.vaultdesk.snapshot()).vaultPath}));
  if(!/\/obsidian\/output\/desktop-ui-\d+\/vault$/.test(scope.vaultPath.replaceAll('\\','/')))throw Error('Dedicated synthetic vault required');
  const errors=[],warnings=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());if(message.type()==='warning')warnings.push(message.text());});
  const fixture='research/windows-round3/fixtures/layout-http-probe/';
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'本地插件',exact:true}).click();
  await page.getByLabel('manifest.json',{exact:true}).setInputFiles(fixture+'manifest.json');
  await page.getByLabel('main.js',{exact:true}).setInputFiles(fixture+'main.js');
  await page.getByRole('button',{name:'导入插件',exact:true}).click();
  await page.locator('.plugin-card').filter({hasText:'Synthetic Layout and HTTP Probe'}).getByRole('button',{name:'启用可信插件',exact:true}).click();
  await page.getByRole('button',{name:'停用',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  async function command(name,prefix='Synthetic Layout and HTTP Probe: '){
    await page.getByRole('button',{name:'命令面板',exact:true}).click();
    await page.getByRole('button',{name:prefix+name,exact:true}).click();
  }
  await command('Open synthetic counter');
  await page.getByText('Synthetic counter: 1',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Increment synthetic counter',exact:true}).click();
  await page.getByText('Synthetic counter: 2',{exact:true}).waitFor();
  await command('管理工作区布局','');
  await page.getByRole('textbox',{name:'工作区名称',exact:true}).fill('Plugin counter');
  await page.getByRole('button',{name:'保存布局',exact:true}).click();
  await page.getByText('已保存“Plugin counter”。',{exact:true}).waitFor();
  const saved=await page.evaluate(async()=>{
    const w=await window.vaultdesk.loadWorkspace(),named=w.workspaces?.['Plugin counter'];
    return named?.panes.flatMap(p=>Object.values(p.pluginViews||{})).find(v=>v.type==='synthetic-counter-view');
  });
  if(saved?.state?.count!==2||saved.state.file!=='Synthetic payload.md')throw Error('Named save did not capture live custom getState');
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await page.getByRole('button',{name:'Increment synthetic counter',exact:true}).click();
  await page.getByText('Synthetic counter: 3',{exact:true}).waitFor();
  await command('管理工作区布局','');
  await page.locator('.vd-util-workspace-row').filter({hasText:'Plugin counter'}).getByRole('button',{name:'恢复',exact:true}).click();
  await page.getByText('已恢复“Plugin counter”。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await page.getByText('Synthetic counter: 2',{exact:true}).waitFor();
  await command('Roundtrip synthetic layout');
  await page.getByText('Synthetic counter: 2',{exact:true}).waitFor();
  const afterRoundtrip=await page.evaluate(async()=>{
    const w=await window.vaultdesk.loadWorkspace();
    return w.panes.flatMap(p=>Object.values(p.pluginViews||{})).find(v=>v.type==='synthetic-counter-view');
  });
  if(afterRoundtrip?.state?.file!=='Synthetic payload.md')throw Error('Public layout roundtrip lost custom file payload');
  await command('Run loopback HTTP checks');
  const input=page.getByRole('textbox',{name:'Loopback HTTP probe JSON',exact:true});
  await input.waitFor();const http=JSON.parse(await input.inputValue());
  if(http.error||http.checks.length!==4||http.checks.some(check=>!check.pass))throw Error(JSON.stringify(http));
  await page.screenshot({path:'output/windows3-plugin-layout-http.png'});
  return await page.evaluate(value=>btoa(unescape(encodeURIComponent(JSON.stringify(value)))),{scope,saved,afterRoundtrip,namedRestoreValue:2,http,console:{errors,warnings},verifiedAt:new Date().toISOString()});
}
