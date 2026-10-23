async (page) => {
  const scope=await page.evaluate(async()=>({url:location.href,vaultPath:(await window.vaultdesk.snapshot()).vaultPath}));
  if(!/\/obsidian\/output\/desktop-ui-\d+\/vault$/.test(scope.vaultPath.replaceAll('\\','/')))throw Error('This UI fixture only accepts a dedicated desktop-ui synthetic vault.');
  const errors=[],warnings=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());if(message.type()==='warning')warnings.push(message.text());});
  const fixture='research/windows-round3/fixtures/public-api-probe/';
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'本地插件',exact:true}).click();
  await page.getByLabel('manifest.json',{exact:true}).setInputFiles(fixture+'manifest.json');
  await page.getByLabel('main.js',{exact:true}).setInputFiles(fixture+'main.js');
  await page.getByRole('button',{name:'导入插件',exact:true}).click();
  await page.getByRole('button',{name:'启用可信插件',exact:true}).click();
  await page.getByRole('button',{name:'停用',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  async function command(name){
    await page.getByRole('button',{name:'命令面板',exact:true}).click();
    await page.getByRole('button',{name:'Reference Public API Probe: '+name,exact:true}).click();
  }
  await command('01 Prepare dedicated editor note');
  await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('alpha beta'));
  let report;
  for(const name of ['02 Editor transaction undo redo','03 View split lifecycle','04 Render and resources','05 Frontmatter and binary']){
    await command(name);
    const input=page.getByRole('textbox',{name:'Public API probe JSON',exact:true});
    await input.waitFor();report=JSON.parse(await input.inputValue());
    const failures=report.sessions.at(-1).cases.filter(row=>row.status!=='pass');
    if(failures.length)throw Error(JSON.stringify(failures));
    await page.getByRole('button',{name:'Close',exact:true}).click();
  }
  const session=report.sessions.at(-1);
  if(session.cases.length!==10||session.cases.flatMap(row=>row.checks||[]).length!==29)throw Error('Expected 10 cases and 29 behavior assertions');
  await page.getByText('Reference API Lab view',{exact:true}).click();
  const before=await page.evaluate(async()=>{
    const w=await window.vaultdesk.loadWorkspace();
    return{layout:w.layout,panes:w.panes.map(p=>({id:p.id,tabs:p.tabs,active:p.active,pluginViews:p.pluginViews})),ribbon:document.querySelector('.plugin-ribbon-items')?.children.length,status:document.querySelector('.plugin-status-items')?.textContent,mounted:document.querySelectorAll('.plugin-view-mount').length,viewText:document.querySelector('.plugin-view-mount')?.textContent};
  });
  await page.screenshot({path:'docs/images/windows3-plugins.png'});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'本地插件',exact:true}).click();
  await page.getByRole('button',{name:'停用',exact:true}).click();
  await page.getByRole('button',{name:'启用可信插件',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  const after=await page.evaluate(async()=>{
    const w=await window.vaultdesk.loadWorkspace();
    return{layout:w.layout,panes:w.panes.map(p=>({id:p.id,tabs:p.tabs,active:p.active,pluginViews:p.pluginViews})),ribbon:document.querySelector('.plugin-ribbon-items')?.children.length,status:document.querySelector('.plugin-status-items')?.textContent,placeholder:document.querySelector('.plugin-view-unavailable')?.textContent,mounted:document.querySelectorAll('.plugin-view-mount').length};
  });
  if(before.ribbon!==1||before.mounted!==1||after.ribbon!==0||after.status||after.mounted!==0||!after.placeholder)throw Error('Disable UI resource cleanup failed');
  if(JSON.stringify(before.panes)!==JSON.stringify(after.panes))throw Error('Disable changed retained leaf identities or saved state');
  await page.screenshot({path:'output/windows3-plugin-disabled.png'});
  return await page.evaluate(result=>btoa(unescape(encodeURIComponent(JSON.stringify(result)))),{scope,report,before,after,console:{errors,warnings},verifiedAt:new Date().toISOString()});
}
