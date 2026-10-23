# 插件兼容范围

`app/extensions.js` 提供显式启用的 CommonJS 插件宿主。目标是一个可验证的公开 API 子集，尚不能运行任意 Obsidian 社区插件，也不代表完整公开 API 或内部 API 兼容。插件必须导出继承 `require('obsidian').Plugin` 的类。

## 执行与信任边界

- 导入 `manifest.json` 和 `main.js` 仅保存源文件；集成界面必须在用户明确启用后才调用 `host.enable(manifest, source)`，不能在导入、页面初始化或库切换时自动执行源码。
- 已启用插件在应用渲染进程的 JavaScript 环境中执行。**这是受信任代码，不是隔离沙箱。** 插件能访问同一页面的 DOM、浏览器全局对象及该页面暴露的能力；有限 `require` 列表不能限制这些全局能力。
- `require` 只接受 `obsidian`。`fs`、`electron`、相对路径和其他包会报 `PluginCompatibilityError`。没有独立文件解析器；插件依赖必须预先打包进 `main.js`。
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
| `ItemView` | 可继承的基类及容器；没有停靠视图注册或布局接入 |
| `MarkdownView` | 活动 Markdown 文件、`getViewData`、显示名称；`editor` 明确报不支持 |
| `normalizePath`, `Platform` | 路径规范化与当前渲染器平台标志；不提供移动端应用环境 |

宿主创建的元素提供 `empty`、`setText`、`addClass`、`removeClass`、`toggleClass`、`setAttr`、`createEl`、`createDiv` 和 `createSpan`。不会修改全局 DOM 原型；插件自行创建的原生元素不能假定具有这些方法。

## 支持的应用 API

| 对象 | 支持的方法 / 属性 |
| --- | --- |
| `app.vault` 查询 | `getName`、`getRoot`、`getFiles`、`getMarkdownFiles`、`getAllLoadedFiles`、`getAbstractFileByPath`、`getFileByPath`、`getFolderByPath` |
| `app.vault` 内容 | `read`、`cachedRead`、`create`、`createFolder`、`modify`、`process`、`append`、`rename`、`trash(file, false)` |
| `app.vault.adapter` | `exists`、`read` |
| `app.vault` 事件 | `on`、`off`、`offref`；创建、修改、重命名、删除通知 |
| `app.fileManager` | `renameFile`，通过托管重命名路径更新引用 |
| `app.workspace` | `activeLeaf`、`getActiveFile`、`getActiveViewOfType`、`getLeaf(false)`、`openLinkText`、`onLayoutReady`、`on` / `off` / `offref` |
| 活动 leaf | `view`、`containerEl`、`openFile`、`getViewState`；容器不挂载为新的应用面板 |
| `app.metadataCache` | `getFileCache`、`getCache`、`getFirstLinkpathDest`、`fileToLinktext`、`resolvedLinks`、`unresolvedLinks`、`on` / `off` / `offref` |
| `app.commands` | `executeCommandById`，限本宿主登记的插件命令 |
| `Plugin` | `addCommand`、`addSettingTab`、`loadData`、`saveData`，以及继承自 `Component` 的生命周期方法 |

`process` 按文件路径串行执行同步转换函数，并向桥接层传递读取时的 mtime 以检测冲突；不接受异步转换函数。`modify`、`create` 等操作成功后会更新宿主的临时缓存，直到应用快照追上操作。`vault.rename` 只移动存储文件，`fileManager.renameFile` 请求托管改链。删除仅支持应用回收站；永久删除与系统回收站均不支持。

元数据基于当前独立实现的 `core/vault.mjs` 生成，包括 frontmatter、标题、链接、嵌入、frontmatter 链接、标签、块及已解析/未解析链接计数。标签项尚无精确源位置；其他位置继承核心解析器的语义。缓存形状只覆盖表中功能，不承诺与完整参考应用完全一致。

`addCommand` 支持 `callback` 或 `checkCallback`，命令 ID 自动加 `<plugin-id>:` 前缀。插件停用后旧回调立即失效。编辑器命令回调不受支持。`loadData` / `saveData` 使用按库、插件分区的浏览器 `localStorage`；没有 `localStorage` 时使用宿主内存，不读写 `.obsidian/plugins/<id>/data.json`。

## 明确不支持

以下调用会给出兼容性错误：Node/Electron 模块、未知 `obsidian` 导出、未知 `app` / vault / workspace / metadata API、`MarkdownView.editor`、编辑器命令、`registerEditorExtension`、`registerView`、Markdown 后处理器和代码块处理器、Ribbon / 状态栏入口、插件创建新 pane、永久删除和系统回收站。

未列出的类实例方法也不属于兼容范围，可能表现为普通 JavaScript 方法不存在错误。并未实现主题/CSS 插件安装、二进制文件 API、HTTP 工具、Obsidian 私有对象、CodeMirror、插件间依赖解析或社区插件目录。

## 宿主集成合同

```js
import { createExtensionHost } from './extensions.js';

const host = createExtensionHost({
  bridge,                            // 应用库桥接对象
  getFiles: () => currentFiles,       // 同步快照
  getActivePath: () => activePath,    // 库内路径或 null
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

桥接层按使用功能提供 `snapshot`、`onChange`、`read`、`write`、`create`、`mkdir`、`rename`、`trash`。`snapshot` 返回 `{vaultPath, files}`，`onChange(callback)` 返回取消订阅函数。`read(path)` 返回文本或 `{content, mtime}`；`write(path, content, expectedMtime)` / `create` 可返回 `{mtime}`。`rename(old, next, options)` 收到 `via: 'storage' | 'managed'` 与 `alwaysUpdateLinks`。缺失桥接方法在调用时明确报错。

`onEvent(listener)` 是可选的应用事件入口，返回取消订阅函数。监听器接收 `{name: 'file-open', path}`，也支持 `{scope: 'workspace' | 'vault' | 'metadata', name, args}`。配置 `onEvent` 时，`file-open` 统一由主界面在活动文件变化时发送，宿主不会重复发送；未配置该入口时，宿主在自己打开文件后提供一次后备通知。`openFile` 收到的 `state.subpath` 可带 `#标题` / `#^块`，主界面负责定位。

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

运行 `node --test tests/extensions.test.mjs`。当前 15 个用例覆盖显式启用、CommonJS 导出、命令/事件卸载、导航事件去重与无外部事件时的后备通知、构造/加载失败回滚、异步停用与取消、全部清理尝试、并发文件变更及改名快照竞态、桥接事件、元数据、导航、Modal/设置、数据分区及库切换。测试通过注入的 data-module 加载器与最小 DOM 实现运行。

这些单元测试不证明生产 Blob 加载器、Electron CSP 或真实界面交互可用；发布前仍需在浏览器/桌面应用中执行上方示例，确认导入不执行、启用后命令可运行、文件修改可见、停用后命令消失与 Modal 关闭，并保留验收证据。实际社区插件需逐个核对 API 与运行行为，不能从本示例推断兼容。
