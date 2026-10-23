async(page)=>{
  const scope=await page.evaluate(async()=>({url:location.href,vaultPath:(await window.vaultdesk.snapshot()).vaultPath}));
  if(!/\/obsidian\/output\/desktop-ui-\d+\/vault$/.test(scope.vaultPath.replaceAll('\\','/')))throw Error('Dedicated synthetic vault required');
  const errors=[],warnings=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());if(message.type()==='warning')warnings.push(message.text());});
  await page.getByRole('dialog').getByRole('button',{name:'关闭插件窗口',exact:true}).click();
  await page.getByRole('button',{name:'Increment synthetic counter',exact:true}).click();
  await page.getByText('Synthetic counter: 3',{exact:true}).waitFor();
  await page.locator('.vd-layout-leaf.active').getByRole('button',{name:'向右分屏',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.synthetic-counter-value').length===2);
  const cloned=await page.locator('.synthetic-counter-value').allTextContents();
  if(cloned.some(text=>text!=='Synthetic counter: 3'))throw Error('Cloned view did not receive current live state');
  await page.locator('.vd-layout-leaf.active').getByRole('button',{name:'Increment synthetic counter',exact:true}).click();
  const independent=await page.locator('.synthetic-counter-value').allTextContents();
  if(JSON.stringify(independent)!==JSON.stringify(['Synthetic counter: 3','Synthetic counter: 4']))throw Error('Cloned views share state or identity');
  await page.getByRole('button',{name:'命令面板',exact:true}).click();
  await page.getByRole('button',{name:'管理工作区布局',exact:true}).click();
  await page.getByRole('textbox',{name:'工作区名称',exact:true}).fill('Plugin clone cold');
  await page.getByRole('button',{name:'保存布局',exact:true}).click();
  await page.getByText('已保存“Plugin clone cold”。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  async function rows(){return await page.evaluate(async()=>{const w=await window.vaultdesk.loadWorkspace();return w.panes.flatMap(p=>p.tabs.filter(path=>p.pluginViews?.[path]?.type==='synthetic-counter-view').map(path=>({pane:p.id,path,...p.pluginViews[path]})));});}
  const stored=await rows();
  if(stored.length!==2||stored[0].path===stored[1].path||JSON.stringify(stored.map(row=>row.state.count))!=='[3,4]')throw Error('Serialized clone states incorrect');
  await page.screenshot({path:'docs/images/windows3-plugin-clones.png'});
  await page.reload();
  await page.getByRole('button',{name:'设置',exact:true}).waitFor();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'本地插件',exact:true}).click();
  const card=page.locator('.plugin-card').filter({hasText:'Synthetic Layout and HTTP Probe'});
  await card.getByRole('button',{name:'启用可信插件',exact:true}).click();
  await card.getByRole('button',{name:'停用',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.synthetic-counter-value').length===2);
  const restored=await page.locator('.synthetic-counter-value').allTextContents(),after=await rows();
  if(JSON.stringify(restored)!==JSON.stringify(independent)||JSON.stringify(after)!==JSON.stringify(stored))throw Error('Cold adapter reactivation lost encoded identity or custom state');
  return await page.evaluate(value=>btoa(unescape(encodeURIComponent(JSON.stringify(value)))),{scope,cloned,independent,stored,restored,after,console:{errors,warnings},verifiedAt:new Date().toISOString(),limit:'Renderer reload and explicit plugin re-enable; process relaunch is covered separately for Markdown layouts.'});
}
