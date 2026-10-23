import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const tag = process.argv[2];
if (!/^[a-z0-9-]+$/.test(tag || '')) throw Error('Provide one complete exact-wrapper run tag');
const root = path.resolve(import.meta.dirname, '..', '..');
const run = path.join(root, 'research', 'raw', 'windows-round3-' + tag);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const reportBytes = fs.readFileSync(path.join(run, 'observations.json'));
const observations = JSON.parse(reportBytes);
const reaBytes = fs.readFileSync(path.join(run, 'rea-browser.json')), rea = JSON.parse(reaBytes);
const lifecycle = JSON.parse(fs.readFileSync(path.join(run, 'lifecycle.json')));
const hostEvents = fs.readFileSync(path.join(run, 'host.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
if (observations.status !== 'complete' || lifecycle.exit?.code !== 0 || lifecycle.reaCode !== 0 || !lifecycle.sourceUnchanged || !rea.evidence_id) throw Error('Incomplete original-wrapper run');
if (observations.results.some(item => item.harnessError)) throw Error('Wrapper harness errors require review');
if (!JSON.stringify(rea).includes(hash(reportBytes))) throw Error('REA capture does not bind the original report');
const identity = observations.identity;
const fixtureDirectory = path.join(import.meta.dirname, 'fixtures', 'public-api-probe');
for (const [name, key] of [['manifest.json', 'manifestSha256'], ['main.js', 'mainSha256']]) {
  if (hash(fs.readFileSync(path.join(fixtureDirectory, name))) !== identity[key]) throw Error('Delivered fixture changed after original run: ' + name);
  if (hash(fs.readFileSync(path.join(run, 'installed-' + name))) !== identity[key]) throw Error('Installed source copy identity mismatch: ' + name);
}
const finalIdentity = observations.results.find(item => item.id === 'exact-wrapper-final-identities-and-files');
if (!['sourceManifestUnchanged', 'sourceMainUnchanged', 'installedManifestUnchanged', 'installedMainUnchanged'].every(key => finalIdentity[key])) throw Error('Wrapper identity changed during run');
const beforeBytes = fs.readFileSync(path.join(run, 'wrapper-report-before-disable.json'));
const afterBytes = fs.readFileSync(path.join(run, 'wrapper-report-after-disable.json'));
const before = JSON.parse(beforeBytes), after = JSON.parse(afterBytes);
const session = before.sessions.at(-1), cases = session.cases;
const screenshots = [];
const screenshotDirectory = path.join(import.meta.dirname, 'screenshots', tag);
fs.mkdirSync(screenshotDirectory, { recursive: true });
for (const item of observations.results) {
  const screenshot = item.screenshot;
  if (!screenshot) continue;
  const bytes = fs.readFileSync(path.join(run, screenshot.name));
  if (hash(bytes) !== screenshot.sha256) throw Error('Screenshot hash mismatch');
  const target = path.join(screenshotDirectory, screenshot.name);
  fs.writeFileSync(target, bytes);
  screenshots.push({ ...screenshot, artifact: path.relative(root, target).replaceAll('\\', '/') });
}
const hostErrors = hostEvents.filter(item => ['error', 'unhandled-rejection', 'inject-error', 'watchdog'].includes(item.kind));
const report = {
  schema: 'vaultdesk-windows-round3-exact-wrapper-reference-v1', date: new Date().toISOString(), referenceOnly: true,
  reference: { coreVersion: '1.13.7', coreSha256: 'a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d', electron: '39.8.3', os: 'Windows', reaVersion: '6.7.0' },
  method: observations.method,
  isolation: 'Fresh synthetic profile/session/vault; original core pinned before launch and rechecked after exit. No real vault/account/credentials. Remote Electron HTTP(S)/WS(S), Node http/https.request/get, external URL launches and OS protocol registration are guarded. This is not an operating-system sandbox.',
  tag, identity, evidenceId: rea.evidence_id, originalReportSha256: hash(reportBytes), reaFileSha256: hash(reaBytes),
  copiedProbeSha256: hash(fs.readFileSync(path.join(run, 'probe.js'))), copiedBootstrapSha256: hash(fs.readFileSync(path.join(run, 'bootstrap.cjs'))),
  lifecycle, hostErrors, blockedNetwork: hostEvents.filter(item => /blocked-(node|renderer)-network/.test(item.kind)),
  totals: { commandGroups: 5, recordedCases: cases.length, passed: cases.filter(item => item.status === 'pass').length, failed: cases.filter(item => item.status === 'fail').length, unsupported: cases.filter(item => item.status === 'unsupported').length, errors: cases.filter(item => item.status === 'error').length, assertions: cases.reduce((total, item) => total + (item.checks?.length || 0), 0), passedAssertions: cases.reduce((total, item) => total + (item.checks?.filter(check => check.pass).length || 0), 0), screenshots: screenshots.length },
  screenshots, originalCases: cases,
  commands: observations.results.filter(item => item.id.startsWith('exact-wrapper-command-')).map(item => ({ id: item.id, commandId: item.commandId, commandRegistered: item.commandRegistered, executionReturn: item.executionReturn, caseIds: item.cases.map(test => test.id), activeView: item.activeView })),
  wrapperReportBeforeDisable: before, wrapperReportBeforeDisableSha256: hash(beforeBytes), wrapperReportAfterDisable: after, wrapperReportAfterDisableSha256: hash(afterBytes),
  disableObservation: observations.results.find(item => item.id === 'exact-wrapper-disable-external-observation'),
  fixtureFiles: finalIdentity.fixtureFiles,
  limitations: [
    'This establishes the exact frozen wrapper on the original application only. Independent native execution must use the same manifest/main hashes before a same-script comparison can be stated.',
    'The original plugin manager enabled the actual plugin and the original command registry invoked commands. The harness did not invoke wrapper internals directly, but did not use physical command-palette keyboard/mouse gestures.',
    'REA controls a loopback controller whose captured DOM binds the original report hash. It does not directly operate the Electron surface. Screenshots come from a briefly visible non-activated original window.',
    'Case passes and assertions cover only the stated synthetic inputs. They do not establish arbitrary plugin compatibility or every public API.',
    'Dynamic timestamps, leaf IDs and view titles are not byte-comparable between hosts. Compare case semantics, recorded checks, file bytes where applicable, and externally observed cleanup.',
  ],
};
fs.writeFileSync(path.join(root, 'research', 'windows-round3-wrapper-reference.json'), JSON.stringify(report, null, 2) + '\n');
const external = report.disableObservation;
const descriptions = {
  'editor:prepare-marked-note': '专用 marker 笔记创建并打开源码模式',
  'editor:transaction-undo-redo': '两处改前坐标变更、一次 undo 与 redo',
  'view:split-state-and-detach': '原生 tab/vertical split，自定义 view 的 open/state 顺序与单叶 detach',
  'resources:ribbon-status-click-remove': '控件挂载、程序 click 回调、手动 remove',
  'render:native-reading-context': '原生阅读视图 postprocessor 顺序、完整 section.text、代码块末尾换行',
  'render:programmatic-component-lifecycle': 'MarkdownRenderer、section=null、Component.unload 清理孩子',
  'frontmatter:update': 'mutable callback、count 更新与正文 marker 保留',
  'frontmatter:throw-does-not-write': 'callback 抛错且原文件不变',
  'frontmatter:concurrent-counter': '两个 callback 读到 0/1，最终 count=2',
  'binary:arraybuffer-roundtrip-modify-append': '包含 0/128/255 的 ArrayBuffer 创建、读取、修改、追加',
};
const markdown = `# Windows R3：相同插件包装的原版运行

已在隔离的原版 **Obsidian 1.13.7 / Electron 39.8.3 / Windows** 中实际加载交付的 \`public-api-probe\` manifest/main，执行命令 01–05。**case 通过 ${report.totals.passed}/${report.totals.recordedCases}，断言通过 ${report.totals.passedAssertions}/${report.totals.assertions}；fail ${report.totals.failed} / unsupported ${report.totals.unsupported} / error ${report.totals.errors}**。这是原版侧结果，尚不能代替独立客户端的原生结果。

运行 \`${tag}\`，时间 ${report.date}。REA：\`${report.evidenceId}\`。原观察报告 SHA-256：\`${report.originalReportSha256}\`。完整结果及两个阶段的插件报告见 [JSON](../research/windows-round3-wrapper-reference.json)。

## 精确源码身份

- [manifest.json](../research/windows-round3/fixtures/public-api-probe/manifest.json)：\`${identity.manifestSha256}\`
- [main.js](../research/windows-round3/fixtures/public-api-probe/main.js)：\`${identity.mainSha256}\`

复制到原版合成库中的文件与上述交付文件逐字一致，运行后两边哈希仍一致。后续独立客户端导入必须核对这两个哈希，才能称为同脚本比较；修改包装后不能沿用本次结果。README 的说明不参与运行时源码身份。

## 执行路径与隔离

启动器只载入哈希固定的原始 ASAR，创建独立 profile/session 与合成库。探针先核对实际库路径，再把冻结 manifest/main 写入该库的插件目录，通过**原版插件管理器**开启并加载插件，通过**原版命令注册器**执行命令，不直接调用包装内部测试函数。读取原版 \`data.json\` 与插件 Modal 中的 JSON，并另观察实际 DOM、文件字节和卸载状态。

REA 操作本机控制页；捕获的 DOM/accessibility 包含原版报告哈希。它不是 REA 直接点击 Electron，也不是物理命令面板手势验收。原窗口仅短暂 showInactive 后截图，不取得前台焦点。没有载入真实用户库、账号或凭据；远程 Electron/Node 网络、系统协议注册和外部 URL 启动均被实验壳拦截，该拦截不是操作系统沙箱。原版与 REA 都退出 0，原核心 SHA-256 未变，host 异常 ${hostErrors.length}。

## 结果

| Case | 结果 | 范围 |
| --- | --- | --- |
${cases.map(item => `| ${item.id} | ${item.status} | ${descriptions[item.id] || '详见 JSON'} |`).join('\n')}

禁用由实验驱动器在插件外部执行。原版插件实例随后不存在；剩余自定义 leaf 保留原 ID、type 与 \`value: two\` state，显示失效插件占位。主 ribbon 数量从 ${external.resourceBefore.ribbons.length} 到 ${external.resourceAfter.ribbons.length}，status 从 ${external.resourceBefore.statuses} 到 ${external.resourceAfter.statuses}。这项外部观察与插件 \`onunload\` 自报日志分开，不把保存卸载日志等同全部资源清理。

已视觉检查：[自定义分屏](../research/windows-round3/screenshots/${tag}/exact-wrapper-custom-split.png)、[实际 Markdown 处理结果](../research/windows-round3/screenshots/${tag}/exact-wrapper-rendered-note.png)、[禁用后的占位](../research/windows-round3/screenshots/${tag}/exact-wrapper-disabled-placeholder.png)。其余截图和哈希在 JSON 中，共 7 张。

## 比较边界与重现

这份包装的原版运行不取代较早 R3 的 12 份 Frontmatter 边界差分；本包装只含三个最小 Frontmatter 操作。不同主机的时间、叶节点 ID、UI 标题不能按原始 JSON 字节比较。后续对照应逐 case 检查语义、断言、适用的文件字节，以及外部禁用观察，不把 10/10 外推完整 Plugin API、社区插件、原生 IME 或任意布局。

\`\`\`powershell
node research/windows-round3/run.mjs wrapper-next public-api-wrapper.js
node research/windows-round3/summarize-wrapper.mjs wrapper-next
\`\`\`

运行标签必须全新；重现仍要求本机固定原核心、实验 Electron 和 REA 6.7.0 可用。本次未修改产品代码、原版核心或兼容矩阵。
`;
fs.writeFileSync(path.join(root, 'docs', 'windows-round3-wrapper-reference.md'), markdown);
console.log(JSON.stringify({ evidenceId: report.evidenceId, identity, totals: report.totals, hostErrors: hostErrors.length, reportSha256: report.originalReportSha256 }));
