# 插件兼容范围

`app/extensions.js` 提供显式启用的 CommonJS 插件宿主。目标是一个可验证的公开 API 子集，尚不能运行任意 Obsidian 社区插件，也不代表完整公开 API 或内部 API 兼容。插件必须导出继承 `require('obsidian').Plugin` 的类。

## 执行与信任边界

- 导入 `manifest.json` 和 `main.js` 仅保存源文件；集成界面必须在用户明确启用后才调用 `host.enable(manifest, source)`，不能在导入、页面初始化或库切换时自动执行源码。
- 已启用插件在应用渲染进程的 JavaScript 环境中执行。**这是受信任代码，不是隔离沙箱。** 插件能访问同一页面的 DOM、浏览器全局对象及该页面暴露的能力；有限 `require` 列表不能限制这些全局能力。
- `require` 接受 `obsidian`、浏览器纯路径 `path` 和与编辑器共享的 `@codemirror/state`、`@codemirror/view`、`@codemirror/language`。`fs`、`electron`、相对路径和其他包会报 `PluginCompatibilityError`。没有独立文件解析器；插件依赖必须预先打包进 `main.js`。
- 宿主使用 Blob ES module 包装 CommonJS，不调用 `eval` 或 `Function`。渲染器 CSP 必须允许 `script-src 'self' blob:`，不需要 `unsafe-eval`。生产加载器在导入结束后释放 Blob URL。
- 插件文件 API 只接受库内相对路径，拒绝越界、绝对路径、空字节及 `.obsidian`、`.vaultdesk`、`.git` 配置目录。此规则只约束宿主提供的文件 API，不是对插件全局 JavaScript 的安全隔离。
- 库身份变化时，宿主停用已启用插件。重新启用仍需用户明确操作。插件数据按启用时的库身份分区，卸载阶段保存的数据不会写入新库分区。

## 支持的导出

| 导出 | 支持范围与区别 |
| --- | --- |
| `Plugin`, `Component` | `onload` / `onunload`、子组件、`register`、`registerEvent`、`registerDomEvent`、`registerInterval`；卸载尝试全部登记清理函数 |
| `TFile`, `TFolder` | 路径、名称、父目录、文件扩展名与 `stat`、目录 `children` / `isRoot`；重命名保留对象身份 |
| `Modal` | `setTitle`、`open`、`close`、`onOpen` / `onClose`；`containerEl`、`modalEl`、`titleEl`、`contentEl`；关闭按钮与 Escape；停用时关闭 |
| `Notice` | 显示纯文本消息、`setMessage`、`hide`；独立通知堆栈和超时时长未实现 |
| `PluginSettingTab` | `containerEl`、`display` / `hide`；`addSettingTab` 注册 `<plugin-id>:settings` 命令，在 Modal 中打开设置 |
| `Setting` | 名称、描述、标题、CSS 类、禁用状态；文本、文本域、开关、下拉框、按钮、滑块；基础取值、赋值、事件及选项方法 |
| `View`, `ItemView`, `WorkspaceLeaf` | 真实标签与分屏中的自定义视图；`onOpen` / `setState` / `getState` / `onClose`、内容容器、操作按钮、临时状态；停用保留类型及状态占位 |
| `MarkdownView`, `Editor` | 当前 leaf 的 Markdown 文件、`getMode` / `getViewData` / `setViewData` 与下文列出的真实编辑器适配器；编辑器引用绑定 leaf 和文档路径 |
| `MarkdownRenderChild`, `MarkdownRenderer` | 阅读页面后处理器、代码块处理器与虚拟 Markdown 渲染；子组件随重新渲染、停用或容器清理卸载 |
| `requestUrl`, `request` | 桌面 HTTP/HTTPS 桥接；文本或二进制请求、响应状态/头、`text` / `json` / `arrayBuffer`；`request` 返回文本 |
| `getIcon`, `setIcon` | 内置 49 个常用 Lucide SVG 图标及少量别名，接受 `lucide-` 前缀；未知名称返回空图标；不是完整图标目录 |
| `normalizePath`, `Platform` | 路径规范化与当前渲染器平台标志；不提供移动端应用环境 |
| `apiVersion` | `0.0.0`，表示本项目的有限兼容宿主；不冒充参考应用版本，也不代表完整 API 版本覆盖 |

宿主创建的元素提供 `empty`、`setText`、`addClass`、`removeClass`、`toggleClass`、`setAttr`、`createEl`、`createDiv` 和 `createSpan`。不会修改全局 DOM 原型；插件自行创建的原生元素不能假定具有这些方法。

## 支持的应用 API

| 对象 | 支持的方法 / 属性 |
| --- | --- |
| `app.vault` 查询 | `getName`、`getRoot`、`getFiles`、`getMarkdownFiles`、`getAllLoadedFiles`、`getAbstractFileByPath`、`getFileByPath`、`getFolderByPath` |
| `app.vault` 内容 | `read`、`cachedRead`、`create`、`createFolder`、`modify`、`process`、`append`、`readBinary` / `createBinary` / `modifyBinary` / `appendBinary`、`copy`、`rename`、`trash(file, false)` |
| `app.vault.adapter` | `exists`、`read` / `readBinary`、`write` / `writeBinary`、`append` / `appendBinary`、`mkdir` |
| `app.vault` 事件 | `on`、`off`、`offref`；创建、修改、重命名、删除通知 |
| `app.fileManager` | `renameFile` 托管更新引用；`processFrontMatter` 对 YAML 映射作串行同步变换 |
| `app.workspace` | `activeLeaf`、`getActiveFile`、`getActiveViewOfType`、`getLeaf(false/true/'tab'/'split')`、`getLeavesOfType`、`getMostRecentLeaf`、`iterateAllLeaves`、`revealLeaf` / `setActiveLeaf`、`detachLeavesOfType`、`getLayout` / `changeLayout` / `requestSaveLayout`、`openLinkText`、`onLayoutReady`、`on` / `off` / `offref` |
| leaf | 稳定 `id`、`view`、`containerEl`、`openFile`、`getViewState` / `setViewState`、`detach`、`setPinned` / `isPinned`；自定义视图临时状态；新建标签和分屏接入实际工作区 |
| `app.metadataCache` | `getFileCache`、`getCache`、`getFirstLinkpathDest`、`fileToLinktext`、`resolvedLinks`、`unresolvedLinks`、`on` / `off` / `offref` |
| `app.commands` | `executeCommandById`，限本宿主登记的插件命令 |
| `Plugin` | `addCommand`、`addSettingTab`、`registerView`、`registerMarkdownPostProcessor` / `registerMarkdownCodeBlockProcessor`、`addRibbonIcon` / `addStatusBarItem`、`loadData`、`saveData`，以及继承自 `Component` 的生命周期方法 |

`process`、`processFrontMatter` 与 `appendBinary` 共用按文件路径串行的队列；写入同时传递读取时的 mtime 和版本摘要，能发现时间戳未变的外部写入。不接受异步转换函数。`modify`、`create` 等操作成功后更新宿主的临时缓存，直到应用快照追上操作。二进制接口返回独立 `ArrayBuffer`，输入还接受精确 byteOffset/byteLength 的 typed array。写入选项中的自定义 ctime/mtime 明确拒绝。`vault.rename` 只移动存储文件，`fileManager.renameFile` 请求托管改链。删除仅支持应用回收站；永久删除与系统回收站均不支持。

`processFrontMatter` 回调接收独立映射，忽略同步返回值并返回 `Promise<void>`。异常、非映射 YAML、格式错误或异步回调均不写入。与参考程序的已采样行为有意不同：无变化保留原始字节，修改保留未改字段的注释、CRLF 和正文，识别 UTF-8 BOM，数组 frontmatter 提前拒绝。具体差分见 [第三轮差分记录](windows-round3-differential.md)。

元数据基于当前独立实现的 `core/vault.mjs` 生成，包括 frontmatter、标题、链接、嵌入、frontmatter 链接、标签、块及已解析/未解析链接计数。标签项尚无精确源位置；其他位置继承核心解析器的语义。缓存形状只覆盖表中功能，不承诺与完整参考应用完全一致。

`addCommand` 支持 `callback` / `checkCallback` 与 `editorCallback` / `editorCheckCallback`，返回并修改传入的同一个命令对象：ID 加 `<plugin-id>:`，名称加 `<Plugin Name>: `。执行直接调用 `checking=false`，不预先调用 `checking=true`；全局 `checkCallback` 优先。编辑器命令仅在真实可写的源码或实时预览编辑器中运行，阅读、输入法组合、切换中或只读时不可执行。已登记命令即使当前不能编辑，`executeCommandById` 仍返回 `true`。插件停用后旧回调立即失效。`editor-change` 传入该 leaf 缓存的 Editor 和 MarkdownView，`info.editor === editor`。

Editor 支持全文、单行、范围、选区、多选区、光标、位置/偏移换算、`transaction`、滚动、焦点及 undo/redo。位置为从零开始的 UTF-16 `{line,ch}`。事务变化使用变更前坐标，选区使用变更后坐标；同一次事务可一次撤销。保留的 Editor 引用不能在 leaf 改开其他文件后修改新文件。源码和实时预览使用同一公共适配器；0.4.0 支持与编辑器同实例的 CodeMirror state/view/language 模块及 registerEditorExtension；editorInfoField 当前提供 file.path，editorLivePreviewField 提供模式状态，未覆盖全部原版字段。

`loadData` / `saveData` 使用按库、插件分区的浏览器 `localStorage`；没有 `localStorage` 时使用宿主内存，不读写 `.obsidian/plugins/<id>/data.json`。

自定义 View 的初始化顺序为构造、组件加载、`onOpen`、`setState`。异步旧视图使用独立容器，不能清空替换后的视图。停用关闭视图并保留 leaf 的类型、ID 和可序列化状态；下次明确启用注册该类型后恢复。工作区布局为 main split/tabs/leaf 树；不支持浮动窗口或侧栏插件面板。

Markdown 后处理器按可修改的 `sortOrder` 执行。代码处理器收到不含最后一个换行的源文本；原始代码在停用时恢复。原生阅读页 `getSectionInfo` 返回整篇源文和从零开始的段落行范围；无法可靠定位的元素返回 `null`，虚拟 `MarkdownRenderer.render` 总返回 `null`。实时预览只对已有富文本渲染片段运行后处理，普通源码代码块尚不转换为插件控件。为保证停用时释放资源，本实现卸载所有该插件登记的渲染子组件；参考程序采样中普通后处理子组件可能留到阅读 DOM 更换才卸载，不能把两者视为完全相同。

Ribbon 和状态项同步插入已挂载的真实应用容器，返回可点击/可移除的 DOM 元素，停用删除元素及事件。HTTP 桥接仅接受 HTTP/HTTPS URL，最多 10 次重定向、30 秒、32 MiB 请求/响应；跨源重定向去除 Authorization/Cookie，不自动附带云同步令牌。HTTP 错误默认抛带 `status` 的异常，`throw:false` 可检查响应；JSON 按需解析。该 HTTP 能力仍属于受信任插件范围。

## 明确不支持

以下调用会给出兼容性错误：Node/Electron 模块、未知 `obsidian` 导出、未知 `app` / vault / workspace / metadata API、无真实编辑器时读取 `MarkdownView.editor`、无宿主 UI 容器时添加 Ribbon/状态栏、永久删除和系统回收站。

未列出的类实例方法也不属于兼容范围，可能表现为普通 JavaScript 方法不存在错误。未实现主题商店或整套主题安装、完整 SVG 图标目录、Obsidian 私有对象、未验的 CodeMirror 扩展及其他模块、插件间依赖解析、动态包导入、浮动窗口、移动端或社区插件目录。不能从有限 fixture 推断任意社区插件兼容。

## 宿主集成合同

```js
import { createExtensionHost } from './extensions.js';

const host = createExtensionHost({
  bridge,                            // 应用库桥接对象
  getFiles: () => currentFiles,       // 同步快照
  getActivePath: () => activePath,    // 库内路径或 null
  getEditor: leafId => mountedEditorForLeaf(leafId),
  workspaceAdapter,                 // app/plugin-workspace.mjs 真实工作区适配器
  openFile: (path, state) => navigateToFile(path, state),
  notice: message => showNotice(message),
  addCommand: command => commandRegistry.set(command.id, command),
  removeCommand: id => commandRegistry.delete(id),
  onEvent: listener => subscribeToWorkspaceEvents(listener),
});

// 仅放在用户的“启用”操作中；此前导入不能调用 enable。
await host.enable(importedManifest, importedMainJs);
await host.disable(importedManifest.id);
await host.dispose();
```

`getFiles` 可以返回桥接快照的 `{files: [...]}`、文件记录数组、`Map<path, text | record>` 或 `path -> text | record` 对象；不能返回 Promise。记录至少需要 `path`，文本使用 `content` 或 `text`，目录使用 `isDirectory: true`，mtime 为可选数值。快照应包含文件夹及可见附件信息；文本未缓存时由 `read` 读取。

桥接层按使用功能提供 `snapshot`、`onChange`、`read`、`write`、`create`、`mkdir`、`rename`、`trash`、`readBinary`、`writeBinary`、`modifyBinary`、`requestUrl`。`snapshot` 返回 `{vaultPath, files}`，`onChange(callback)` 返回取消订阅函数。`read(path)` 返回文本或 `{content, mtime, version}`；`write(path, content, expectedMtime, expectedVersion)` 可返回 `{mtime,version}`。二进制桥接传 canonical base64，创建与修改分开，修改也传双版本凭据。`rename(old, next, options)` 收到 `via: 'storage' | 'managed'` 与 `alwaysUpdateLinks`。缺失桥接方法在调用时明确报错。

`onEvent(listener)` 是可选的应用事件入口，返回取消订阅函数。监听器接收 `{name: 'file-open', path}`，也支持 `{scope: 'workspace' | 'vault' | 'metadata', name, args}`。配置 `onEvent` 时，`file-open` 统一由主界面在活动文件变化时发送，宿主不会重复发送；未配置该入口时，宿主在自己打开文件后提供一次后备通知。`openFile` 收到的 `state.subpath` 可带 `#标题` / `#^块`，主界面负责定位。

编辑事件用 `{scope:'workspace',name:'editor-change',leafId,path}`，不跨插件传入底层 editor 对象。`getEditor(leafId)` 必须只返回对应路径且已挂载的适配器。`PluginRibbon` / `PluginStatusBar` 通过 `host.attachSurface(name,element)` 注册实际容器，`PluginViewMount` 渲染 leaf 内容，`PluginViewTitle` 显示视图名称。`getUI` / `subscribeUI` 提供稳定外部快照，其 `markdownRevision` 仅随处理器注册/注销改变；编辑器依赖此值更新 `processMarkdown` 包装函数。每次渲染返回的清理函数须在 DOM 更换/卸载时调用。

命名布局保存前 `await host.captureViewStates()`，把当前自定义 `getState` 同步到工作区模型；恢复布局后 `await host.syncWorkspace({forceState:true})`，即使保存状态与上次输入相同也重新应用它。普通布局事件不强制覆盖插件尚未保存的内部状态。公开 `workspace.changeLayout` 自带强制恢复；同一视图实例的异步 `setState` 串行执行。

`enable`、`disable`、`dispose` 返回 Promise；`list()` 返回 manifest 与当前 `loading` / `enabled` / `disabling` 状态。加载失败会回滚已登记的命令、事件、Modal 和组件清理。停用先撤销命令/事件能力，再等待插件异步卸载完成；正在运行的任意 JavaScript 不能强制终止，未结束的 `onload` / `onunload` 也可能使调用一直等待。全部登记清理都会被尝试，清理失败通过聚合错误或宿主通知报告。

## 可导入示例

`manifest.json`：

```json
{
  "id": "vaultdesk-append-example",
  "name": "追加示例",
  "version": "1.0.0",
  "minAppVersion": "0.0.0",
  "isDesktopOnly": false
}
```

`main.js`：

```js
const { Plugin, Notice } = require('obsidian');

module.exports = class AppendExample extends Plugin {
  onload() {
    this.addCommand({
      id: 'append-line',
      name: '在活动笔记追加一行',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') {
          new Notice('请先打开一篇 Markdown 笔记');
          return;
        }
        await this.app.vault.process(file, text => text + '\n插件已运行。\n');
        new Notice('已追加');
      },
    });
  }
};
```

## 验证范围

运行 `node --test tests/extensions.test.mjs tests/extensions-files.test.mjs tests/extensions-render.test.mjs tests/extensions-round3.test.mjs`。当前 41 个用例覆盖显式启用、CommonJS、命令/事件卸载、异步取消、并发文件与改名快照竞态、库切换、编辑器命令与对象身份、二进制精确范围和同时间戳冲突、frontmatter 串行变换、HTTP 返回协议、真实 leaf 适配器、视图异步替换、命名/公开布局状态恢复与捕获、Markdown 顺序/行范围/资源卸载及 Ribbon/状态元素清理。测试通过注入的 data-module 加载器与最小 DOM 实现运行。工作区适配器另有 11/11、布局模型另有 20/20 用例通过；此外还有 editor-api 及桌面二进制/HTTP 测试。

这些单元测试不单独证明生产 Blob 加载器、Electron CSP 或真实界面交互。2026-10-23 已用冻结 `public-api-probe` 在最终 0.3.1 打包程序的独立 Electron 窗口完成界面导入、明确启用、命令执行与停用，10 个场景/29 项断言通过，控制台 0 错误/0 警告；相同 SHA-256 的 manifest/main 也在参考程序 1.13.7 通过相同 10/29 检查。具体方法、打包版本摘要、外部停用证据和有限范围见 [第三轮插件桌面验收](windows-round3-plugin-ui-verification.md)。实际社区插件仍需逐个核对 API 与运行行为，不能从合成插件推断任意插件兼容。

最终 0.3.1 打包程序还通过独立的命名布局与 loopback HTTP 桌面验收：视图内存计数 2 保存、增加到 3 后恢复为 2；含 `file` 自定义字段的公开布局往返保留类型和状态；HTTP promise/text/json/ArrayBuffer、文本别名及 404 两种处理共 4 项通过。另通过真实分屏克隆及渲染器重载验收：两个视图独立显示 3/4，重载并明确重新启用插件后，pane ID、自定义 leaf token、类型及 payload 保持，计数恢复为 3/4。插件恢复证据限于渲染器重载，没有覆盖插件视图的进程重启。该补充插件未在参考程序运行，独立记录于 [验收说明](windows-round3-plugin-ui-verification.md)。

公开声明参考：[官方 API 类型](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) 与 [Editor 文档](https://docs.obsidian.md/Plugins/Editor/Editor)。本轮早期 API 探针与局限见 [Windows 第三轮记录](windows-round3-reference.md)，同一冻结插件的双端结果见 [第三轮插件桌面验收](windows-round3-plugin-ui-verification.md)。两类证据分开记录；同脚本检查通过也不等于所有事件次数、界面细节或未测参数均相同。

## 0.4.0 PPT 插件追加

增加 FileView 文件生命周期、registerExtensions 路由、Scope 键位与可选 styles.css 导入/卸载。未修改 Office Viewer 0.2.5、PPT Viewer 1.8.2 的插件源码；有限实际验收见 [PPT 插件记录](windows-ppt-plugin-verification.md)。PPT Viewer 使用自带兼容预览；Node、PowerPoint/LibreOffice 转换、PDF 导出和系统外部打开仍不支持。两个插件会争用 pptx 扩展，请分别启用。
