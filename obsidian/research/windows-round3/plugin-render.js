async function pluginRenderReference(config) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { ipcRenderer } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 350 && (!window.app?.workspace?.layoutReady || !window.app?.vault?.getFiles().length); i++) await pause(100);
  const a = window.app;
  if (!a?.workspace?.layoutReady || !a?.vault || path.resolve(a.vault.adapter.getBasePath()) !== path.resolve(config.vault)) throw Error('Unexpected vault or layout not ready; mutations forbidden');
  while (!fs.existsSync(path.join(config.run, 'start.signal'))) await pause(100);
  const results = [], clone = value => JSON.parse(JSON.stringify(value)), hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const capture = name => ipcRenderer.invoke('round3:capture', name);
  const methods = object => { const names = new Set(); for (let p = object, depth = 0; p && depth < 4; p = Object.getPrototypeOf(p), depth++) for (const key of Object.getOwnPropertyNames(p)) if (typeof Object.getOwnPropertyDescriptor(p, key)?.value === 'function') names.add(key); return [...names].sort(); };
  const run = async (id, fn) => { try { results.push({ id, status: 'observed', ...(await fn()) }); } catch (error) { results.push({ id, status: 'probe-error', error: String(error.stack || error) }); } fs.writeFileSync(path.join(config.run, 'render-partial.json'), JSON.stringify(results, null, 2)); };
  const waitFor = async (predicate, description) => { for (let i = 0; i < 80; i++) { if (predicate()) return; await pause(100); } throw Error('Timed out: ' + description); };
  function syntheticPlugin() {
    const { Plugin, MarkdownRenderChild, ItemView, MarkdownRenderer, Component } = require('obsidian');
    const lab = window.__round3Render = { events: [], sequence: 0, children: [], views: [], api: { MarkdownRenderer, Component } };
    const log = (kind, value = {}) => lab.events.push({ sequence: ++lab.sequence, kind, ...value });
    const section = (ctx, element) => { try { return ctx.getSectionInfo(element); } catch (error) { return { error: String(error) }; } };
    class RenderChild extends MarkdownRenderChild {
      constructor(element, kind, sourcePath) { super(element); this.labId = 'child-' + (lab.children.length + 1); this.labKind = kind; this.labSourcePath = sourcePath; lab.children.push(this); log('render-child:construct', { id: this.labId, childKind: kind, sourcePath }); }
      onload() { log('render-child:load', { id: this.labId, childKind: this.labKind, sourcePath: this.labSourcePath, connected: this.containerEl.isConnected }); }
      onunload() { log('render-child:unload', { id: this.labId, childKind: this.labKind, sourcePath: this.labSourcePath, connected: this.containerEl.isConnected }); }
    }
    class LabView extends ItemView {
      constructor(leaf) { super(leaf); this.labId = 'view-' + (lab.views.length + 1); lab.views.push(this); log('view:construct', { id: this.labId, leafId: leaf.id }); }
      getViewType() { return 'round3-lab-view'; }
      getDisplayText() { return 'Round3 lifecycle view'; }
      async onOpen() { this.contentEl.createDiv({ text: 'Synthetic view ' + this.labId, cls: 'round3-view-content' }); log('view:open', { id: this.labId, leafId: this.leaf.id, connected: this.containerEl.isConnected, stateAtOpen: this.labState ?? null }); }
      getState() { return this.labState || {}; }
      async setState(state, result) { log('view:set-state:start', { id: this.labId, state: JSON.parse(JSON.stringify(state)) }); this.labState = state; await super.setState(state, result); log('view:set-state:end', { id: this.labId, state: JSON.parse(JSON.stringify(this.labState)) }); }
      async onClose() { log('view:close', { id: this.labId, leafId: this.leaf.id, connected: this.containerEl.isConnected }); }
    }
    module.exports = class LabRenderPlugin extends Plugin {
      onload() {
        lab.plugin = this;
        log('plugin:load', { id: this.manifest.id, publicApi: { Plugin: typeof Plugin, MarkdownRenderChild: typeof MarkdownRenderChild, ItemView: typeof ItemView, MarkdownRenderer: typeof MarkdownRenderer, Component: typeof Component } });
        lab.ribbon = this.addRibbonIcon('flask-conical', 'Round3 render ribbon', () => log('ribbon:click'));
        lab.ribbon.dataset.round3Resource = 'ribbon-primary';
        lab.removableRibbon = this.addRibbonIcon('flask-conical', 'Round3 removable ribbon', () => log('ribbon:removable-click'));
        lab.removableRibbon.dataset.round3Resource = 'ribbon-removable';
        lab.status = this.addStatusBarItem(); lab.status.setText('Round3 render status'); lab.status.dataset.round3Resource = 'status-primary';
        lab.removableStatus = this.addStatusBarItem(); lab.removableStatus.setText('Round3 removable status'); lab.removableStatus.dataset.round3Resource = 'status-removable';
        this.registerDomEvent(window, 'round3-render-signal', () => log('dom-event:received'));
        this.registerEvent(this.app.workspace.on('file-open', file => log('workspace:file-open', { path: file?.path ?? null })));
        this.register(() => log('plugin:registered-cleanup'));
        this.registerView('round3-lab-view', leaf => new LabView(leaf));
        this.registerMarkdownPostProcessor((element, ctx) => {
          if (!element.textContent.includes('POST-MARK')) return;
          const value = { sourcePath: ctx.sourcePath, section: section(ctx, element), text: element.textContent, tag: element.tagName, hasAddChild: typeof ctx.addChild === 'function' };
          log('postprocessor:early', value);
          element.dataset.round3Post = 'early';
          ctx.addChild(new RenderChild(element, 'postprocessor', ctx.sourcePath));
        }, 50);
        this.registerMarkdownPostProcessor((element, ctx) => {
          if (!element.textContent.includes('POST-MARK')) return;
          log('postprocessor:late', { sourcePath: ctx.sourcePath, earlyMarker: element.dataset.round3Post ?? null, section: section(ctx, element), text: element.textContent });
        }, 100);
        this.registerMarkdownCodeBlockProcessor('round3lab', (source, element, ctx) => {
          log('codeblock:process', { source, sourcePath: ctx.sourcePath, section: section(ctx, element), tag: element.tagName, hasAddChild: typeof ctx.addChild === 'function' });
          element.createDiv({ cls: 'round3-code-output', text: 'Rendered custom code: ' + source.trim() });
          ctx.addChild(new RenderChild(element, 'codeblock', ctx.sourcePath));
        });
      }
      onunload() { log('plugin:unload'); }
    };
  }
  const pluginId = 'lab-render', pluginPath = path.join(config.vault, '.obsidian', 'plugins', pluginId);
  const pluginText = '(' + syntheticPlugin.toString() + ')();\n';
  const manifest = { id: pluginId, name: 'Synthetic render lifecycle laboratory', version: '0.0.1', minAppVersion: '1.0.0', description: 'Local synthetic reference research only.', author: 'Local laboratory', isDesktopOnly: true };
  const nativeMarkdown = '# Render Fixture\n\nPOST-MARK first paragraph.\n\n```round3lab\nalpha\nbeta\n```\n\nPOST-MARK last paragraph.\n';
  const virtualMarkdown = 'POST-MARK virtual paragraph.\n\n```round3lab\nvirtual alpha\nvirtual beta\n```\n';
  let lab, pluginLoaded = false, nativeLeaf, viewOne, viewTwo;
  const events = () => clone(lab?.events || []);
  const resources = () => ({ ribbon: !!lab?.ribbon?.isConnected, removableRibbon: !!lab?.removableRibbon?.isConnected, status: !!lab?.status?.isConnected, removableStatus: !!lab?.removableStatus?.isConnected, domResources: [...document.querySelectorAll('[data-round3-resource]')].map(el => ({ type: el.dataset.round3Resource, tag: el.tagName, text: el.textContent, ariaLabel: el.getAttribute('aria-label') })) });
  const leaves = () => a.workspace.getLeavesOfType('round3-lab-view').map(leaf => ({ id: leaf.id, type: leaf.view.getViewType(), state: leaf.getViewState(), connected: leaf.containerEl.isConnected, text: leaf.view.contentEl?.textContent ?? null }));
  const children = () => (lab?.children || []).map(child => ({ id: child.labId, kind: child.labKind, sourcePath: child.labSourcePath, loaded: child._loaded ?? null, connected: child.containerEl.isConnected }));
  await run('plugin-loader', async () => {
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(pluginPath, 'main.js'), pluginText);
    await a.vault.create('Sources/Render.md', nativeMarkdown);
    const manager = a.plugins;
    const managerMethods = methods(manager);
    if (typeof manager.loadManifests !== 'function' || typeof manager.enablePlugin !== 'function') throw Error('Plugin manager contract missing; methods=' + managerMethods.join(','));
    const communityEnabledBefore = manager.isEnabled();
    await manager.setEnable(true);
    await manager.loadManifests();
    await manager.enablePlugin(pluginId);
    lab = window.__round3Render;
    if (!lab?.plugin || !manager.plugins[pluginId]) throw Error('Synthetic plugin did not load through actual manager');
    pluginLoaded = true;
    return { action: 'write synthetic manifest/main.js; app.plugins.setEnable(true); app.plugins.loadManifests(); app.plugins.enablePlugin(lab-render)', communityEnabledBefore, communityEnabledAfter: manager.isEnabled(), managerMethods, manifestKnown: !!manager.manifests?.[pluginId], managerLoaded: !!manager.plugins[pluginId], manifest, artifactSha256: { plugin: hash(pluginText), nativeMarkdown: hash(nativeMarkdown), virtualMarkdown: hash(virtualMarkdown) }, events: events(), resources: resources() };
  });
  await run('ribbon-status-manual-remove', async () => {
    if (!pluginLoaded) throw Error('Plugin unavailable');
    const before = resources(), start = lab.events.length;
    lab.ribbon.click(); lab.removableRibbon.click(); window.dispatchEvent(new Event('round3-render-signal'));
    lab.removableRibbon.remove(); lab.removableStatus.remove();
    return { action: 'click both ribbon elements; dispatch registered DOM event; remove second ribbon/status elements', before, after: resources(), events: events().slice(start) };
  });
  await run('native-markdown-render-context', async () => {
    if (!pluginLoaded) throw Error('Plugin unavailable');
    const start = lab.events.length;
    nativeLeaf = a.workspace.getLeaf(false);
    await nativeLeaf.openFile(a.vault.getAbstractFileByPath('Sources/Render.md'));
    const viewState = nativeLeaf.getViewState();
    await nativeLeaf.setViewState({ ...viewState, state: { ...viewState.state, mode: 'preview' } });
    await waitFor(() => lab.events.slice(start).some(event => event.kind === 'codeblock:process' && event.sourcePath === 'Sources/Render.md'), 'native code block processor');
    const screenshot = await capture('plugin-render-native');
    await waitFor(() => lab.events.slice(start).filter(event => event.kind === 'postprocessor:late' && event.sourcePath === 'Sources/Render.md').length >= 2, 'both native postprocessor sections after paint');
    return { action: 'open Sources/Render.md; set native reading mode; capture to paint; await both paragraph postprocessors', source: nativeMarkdown, viewState: nativeLeaf.getViewState(), text: nativeLeaf.view.contentEl.textContent, html: nativeLeaf.view.contentEl.innerHTML, events: events().slice(start), children: children(), screenshot };
  });
  await run('render-child-file-navigation-unload', async () => {
    if (!nativeLeaf) throw Error('Native reading leaf unavailable');
    const before = children(), start = lab.events.length;
    await nativeLeaf.openFile(a.vault.getAbstractFileByPath('Sources/Other.md')); await pause(700);
    return { action: 'same native leaf opens Sources/Other.md', before, after: children(), events: events().slice(start) };
  });
  await run('programmatic-markdown-component-lifecycle', async () => {
    if (!pluginLoaded) throw Error('Plugin unavailable');
    const target = document.createElement('div'); target.dataset.round3Resource = 'programmatic-render'; document.body.appendChild(target);
    const component = new lab.api.Component(); component.load();
    const start = lab.events.length;
    await lab.api.MarkdownRenderer.render(a, virtualMarkdown, target, 'Sources/Virtual.md', component); await pause(400);
    const rendered = { html: target.innerHTML, text: target.textContent, events: events().slice(start), children: children() };
    const beforeUnload = lab.events.length; component.unload(); await pause(200);
    const unloaded = { events: events().slice(beforeUnload), children: children() }; target.remove();
    return { action: 'Component.load(); MarkdownRenderer.render(app, text, target, Sources/Virtual.md, component); Component.unload()', source: virtualMarkdown, rendered, unloaded };
  });
  await run('registered-view-open-detach', async () => {
    if (!pluginLoaded) throw Error('Plugin unavailable');
    const start = lab.events.length;
    viewOne = a.workspace.getLeaf('tab'); await viewOne.setViewState({ type: 'round3-lab-view', state: { value: 'one' }, active: true });
    viewTwo = a.workspace.getLeaf('tab'); await viewTwo.setViewState({ type: 'round3-lab-view', state: { value: 'two' }, active: true });
    await pause(300); const bothOpen = { leaves: leaves(), events: events().slice(start) };
    const detachStart = lab.events.length; viewOne.detach(); await pause(300);
    return { action: 'registerView; getLeaf(tab).setViewState twice; firstLeaf.detach()', bothOpen, afterDetach: { leaves: leaves(), events: events().slice(detachStart) }, screenshot: await capture('plugin-render-custom-view') };
  });
  await run('plugin-unload-resource-lifecycle', async () => {
    if (!pluginLoaded) throw Error('Plugin unavailable');
    const renderStart = lab.events.length;
    await nativeLeaf.openFile(a.vault.getAbstractFileByPath('Sources/Render.md')); a.workspace.setActiveLeaf(nativeLeaf, { focus: true });
    const beforeScreenshot = await capture('plugin-render-before-unload');
    await waitFor(() => lab.events.slice(renderStart).filter(event => event.kind === 'postprocessor:late' && event.sourcePath === 'Sources/Render.md').length >= 2, 'both postprocessor sections before plugin unload');
    const before = { resources: resources(), leaves: leaves(), children: children() }, start = lab.events.length;
    await a.plugins.disablePlugin(pluginId); await pause(700); pluginLoaded = false;
    const eventStart = lab.events.length; window.dispatchEvent(new Event('round3-render-signal'));
    const afterSignal = events().slice(eventStart);
    return { action: 'leave second custom view open; paint native reading view; app.plugins.disablePlugin(lab-render); dispatch registered DOM event', before, beforeScreenshot, after: { managerLoaded: !!a.plugins.plugins[pluginId], resources: resources(), leaves: leaves(), children: children(), detachedViewType: viewOne?.view?.getViewType?.(), remainingViewType: viewTwo?.view?.getViewType?.(), remainingViewState: viewTwo?.getViewState?.() }, events: events().slice(start), afterSignal, screenshot: await capture('plugin-render-unloaded') };
  });
  await run('markdown-processors-after-plugin-unload', async () => {
    if (!lab?.api) throw Error('Public API unavailable');
    const target = document.createElement('div'), component = new lab.api.Component(); document.body.appendChild(target); component.load();
    const start = lab.events.length;
    await lab.api.MarkdownRenderer.render(a, virtualMarkdown, target, 'Sources/AfterUnload.md', component); await pause(400);
    const rendered = { html: target.innerHTML, text: target.textContent, customCodeOutputCount: target.querySelectorAll('.round3-code-output').length, postMarkerCount: target.querySelectorAll('[data-round3-post]').length, pluginEvents: events().slice(start) };
    component.unload(); target.remove();
    return { action: 'MarkdownRenderer.render using retained public API after plugin disable', rendered };
  });
  await run('inactive-view-placeholder-after-plugin-unload', async () => {
    if (!viewTwo) throw Error('Second custom leaf unavailable');
    a.workspace.setActiveLeaf(viewTwo, { focus: true });
    const screenshot = await capture('plugin-render-inactive-view');
    return { action: 'activate the still-open custom leaf after disabling its plugin', leaves: leaves(), viewState: viewTwo.getViewState(), text: viewTwo.view.contentEl?.textContent ?? null, screenshot };
  });
  await run('remaining-render-children-cleanup-after-plugin-unload', async () => {
    if (!nativeLeaf || !lab) throw Error('Native leaf unavailable');
    const before = children(), start = lab.events.length;
    await nativeLeaf.openFile(a.vault.getAbstractFileByPath('Sources/Other.md'));
    await pause(500);
    return { action: 'after plugin disable, native leaf navigates to Sources/Other.md', before, after: children(), events: events().slice(start), registeredFileOpenEventsAfterUnload: events().slice(start).filter(event => event.kind === 'workspace:file-open') };
  });
  if (pluginLoaded) await run('cleanup-plugin', async () => { await a.plugins.disablePlugin(pluginId); pluginLoaded = false; return { managerLoaded: !!a.plugins.plugins[pluginId] }; });
  const errors = results.filter(result => result.status === 'probe-error');
  ipcRenderer.send('round3:report', clone({ schema: 'obsidian-windows-round3-plugin-render-v1', status: 'complete', error: null, completionMeaning: 'Probe sequence finished; individual probe-error cases are unverified limitations, not passed behavior.', environment: { coreVersion: '1.13.7', versions: process.versions, vaultIsSynthetic: true, coreSha256: config.coreSha256, pluginId, pluginSourceSha256: hash(pluginText) }, probeErrors: errors.map(result => result.id), events: events(), results }));
}
