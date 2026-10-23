# Windows 第三轮原版参考：插件 API、布局与组合事件

2026-10-23。参考为 **Obsidian 核心 1.13.7 / Electron 39.8.3 / Windows**，本轮只采样原版，不是独立客户端的验收。已采纳 6 次运行、44 条观察记录，包含 12 份 `processFrontMatter` 输入与 20 张原窗口 PNG。记录数不是功能通过数，也不是完整公开 API 覆盖率。

完整输入、输出、事件、布局、文件内容及哈希见 [结构化汇总](../research/windows-round3-reference.json)。[布局合同摘录](../research/windows-round3/layout-notes.json)另保留实际可见行和侧栏几何检查。

## 来源与隔离

核心 ASAR SHA-256：`a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d`。每次运行创建全新合成库、profile、session；进入 renderer 后先检查 `vault.adapter.getBasePath()` 等于该库。没有加载用户笔记、原云账号或凭据，没有修改原版核心。插件样本均为本轮自行编写。

REA 6.7.0 操作 loopback 控制页，控制页启动隔离探针并显示原版报告 SHA-256，REA 捕获该页的 DOM/accessibility/URL。因此 REA 绑定的是**原版观察报告**，不是直接控制原版 Electron 窗口，也不是与独立实现进行自动相等比较。原窗口截图由实验壳 `showInactive()` 后 `capturePage()` 取得，再恢复隐藏；未请求前台焦点。全部 20 张 PNG 的哈希已核对，代表性的原生渲染、失效插件视图、嵌套布局与源码滚动截图经过视觉检查。

实验壳阻止远程 Electron HTTP(S)/WS(S)、Node `http/https.request/get`、外部 URL 启动和系统协议注册；`requestUrl` 只访问本轮独立的本机 HTTP fixture。该拦截不是操作系统沙箱。六次采纳运行均正常退出，原版与 REA 退出码均为 0，结束时原核心哈希不变；最后检查没有仍运行的本轮原版/REA 进程。

| 运行 | 内容 | 观察记录 | REA Evidence ID |
| --- | --- | ---: | --- |
| `discover02` | 原版插件加载及运行时 API 发现 | 2 | `ev_e45835c2652f4ef54399ecc234dc3b9a13cab6a1c95d3db93acac877ce454ea1` |
| `editor02` | Editor、MarkdownView、命令与事件 | 12 | `ev_3b1f8958b48993e13ac8fc7f5e545b63b870888f877a7c6200c1826b2023b9fc` |
| `data02` | 元数据、Frontmatter、二进制、请求 | 8 | `ev_67753f60ec5be8252115093b5bc4465f766580061be17b416474f5f1c906d49e` |
| `render05` | Markdown 处理器、子组件、自定义视图、资源卸载 | 10 | `ev_4378980102d147d1c1b05b573d78a9827e19c7f61e32bbb47e611f553c425e5c` |
| `layout03` | 递归布局、固定标签、侧栏、临时编辑状态 | 10 | `ev_49c3ff1eb8e3199813d06408d901fa9e6fac0ec560c7bb4cb290dbd215578c40` |
| `composition01` | 非原生组合事件探针 | 2 | `ev_23e2e8802f06c00640e9d65e6d8e002d35743081eb66986a119c2f397da93bbe` |

`complete/observed` 表示探针产出了结果；输入被拒、未执行、未恢复等结果也可能是有效观察。探索轮的缺陷和替代关系逐项写入汇总的 `excludedExploration`，不混入上述数量。

## 插件加载、编辑器与命令

新 profile 默认处于受限模式。实验在合成库写入 manifest/main 后，调用原版管理器 `setEnable(true)`、`loadManifests()`、`enablePlugin(id)`，真实插件执行 `require('obsidian')` 并进入 `onload`；禁用后进入 `onunload`，实例从管理器移除。renderer 的普通 Node `require('obsidian')` 本身不能解析该模块。实际插件导出的 `apiVersion` 为 `1.13.7`；现有公开声明文件版本为 1.14.4，仅用于选择探针，不能据其内容代替版本行为。

| 接口/场景 | 本轮原版结果 |
| --- | --- |
| `MarkdownView.editor` | 是原版 `Editor` 实例；`getDoc()` 返回该编辑器自身，`getActiveViewOfType(MarkdownView)` 返回同一活动视图。 |
| `setValue`、位置 | CRLF 输入经编辑器变为 LF；`line/ch/offset` 使用 UTF-16 单位，emoji 占两个位置。偏移超出文档时 `offsetToPos` 限制到首尾；`posToOffset` 对有效行的过大 `ch` 没有同样限制，不能把非法位置样本当安全写入合同。 |
| 反向与多选区 | `getCursor('head'/'anchor')` 保留方向，`from/to` 为排序边界；`replaceSelection('X')` 替换所有选区。`getSelection()` 只返回主选区文字。 |
| `setSelections(ranges, main)` | 本例传省略、0、1，读回的主选区都为第一处 `alpha`；这与较新声明中的主选区参数描述不同。只记录版本样本，不宣称所有范围组合均如此。 |
| `transaction` | 两处 `changes` 使用改前坐标，`selections` 使用改后坐标；一次 undo 恢复原文，一次 redo 恢复两处变化。第二选区非空、主选区为 caret 时，本例 `somethingSelected()` 为 false。 |
| `exec` | `goRight/goStart/goEnd/goWordLeft/indentMore/indentLess/newlineAndIndent` 作用于实际编辑器；`selectAll` 不在公开 `EditorCommandName` 集合，本例与未知命令一样抛错。 |
| `Plugin.addCommand` | 原地修改传入对象的 `id` 为 `pluginId:id`、`name` 为 `Plugin Name: name`，返回同一对象。 |
| 编辑器命令 | `editorCallback` / `editorCheckCallback` 收到同一 Editor 与 MarkdownView。检查时传 true，执行器执行时仅传 false；阅读模式或 empty 视图不调用编辑器回调。 |
| 执行结果 | `executeCommandById` 在命令存在时返回 true，即使检查返回 false 或当前视图不适用；移除后才返回 false。不能以该布尔值证明正文已修改。 |
| 回调优先级 | 同时提供 `checkCallback` 与 `callback`，本例只调用前者。 |
| `editor-change` 与卸载 | 事件提供 `(editor, info)`，本例 `info` 是 MarkdownView 且 `info.editor === editor`；插件禁用后继续编辑不再调用已注册监听，命令也从注册表移除。 |

[编辑器最终窗口](../research/windows-round3/screenshots/editor02/plugin-editor-final.png)只辅助确认窗口状态，具体字符、选区、撤销和命令结果以 JSON 为准。这些输入由 API 施加，不是物理键盘或原生 IME 验收。

## Markdown 渲染、视图与生命周期

两个 postprocessor 以 `sortOrder` 50、100 注册，前者写入 DOM 标记后，后者能读到该标记。在实际笔记阅读视图中，`ctx.sourcePath` 为笔记路径，`ctx.getSectionInfo(el)` 返回完整笔记 `text`，以及当前 section 的零起始 `lineStart/lineEnd`。本例两个段落分别为 2..2、9..9，围栏段为 4..7；代码块 processor 的 `source` 为 `alpha\nbeta`，不含末尾换行。

程序调用 `MarkdownRenderer.render(app, text, el, sourcePath, component)` 时也执行处理器，但本例 `getSectionInfo` 为 null。`ctx.addChild(new MarkdownRenderChild(el))` 使子组件进入加载；其 `onload` 可发生在 DOM 尚未连接时。`component.unload()` 释放程序渲染的孩子，原笔记换文件释放原阅读内容的孩子。

`registerView` 的样本顺序为构造 → `onOpen` → `setState`，因此 `onOpen` 不能假设自定义 state 已就绪。两次 `getLeaf('tab').setViewState(...)` 建立两个实例，`getLeavesOfType` 返回两者；`leaf.detach()` 关闭并移除对应实例。插件禁用时剩余实例收到 `onClose`，但原版保留 leaf ID、view type 与自定义 state，并替换为失效插件占位视图，仍可通过 `getLeavesOfType` 找到。

`addRibbonIcon` 和 `addStatusBarItem` 返回可手动 `.remove()` 的元素；插件禁用也会清理剩余元素及 `registerDomEvent/registerEvent`。本例卸载序列观察到 custom view close → 注册 cleanup → plugin `onunload` → codeblock 子组件卸载。普通 postprocessor 创建且已渲染的孩子当时仍存活，之后原 leaf 换文件才卸载。资源与渲染节点各自有生命周期，不能把每个 DOM 子组件都视为仅由 Plugin 实例持有；该观察也不是对任意异步 hook 顺序的保证。

可复核截图：[自定义代码块与状态栏](../research/windows-round3/screenshots/render05/plugin-render-native.png)、[自定义视图](../research/windows-round3/screenshots/render05/plugin-render-custom-view.png)、[卸载后的失效视图](../research/windows-round3/screenshots/render05/plugin-render-inactive-view.png)。

## 元数据、Frontmatter、二进制与网络请求

元数据样本包含 YAML、中文 emoji 标题、正文标签、普通链接、嵌入、代码围栏和块 ID。`getCache(path)` 与 `getFileCache(file)` 返回同一缓存对象；`frontmatter` 存值，位置另在 `frontmatterPosition`。`frontmatterLinks` 含 `key/link/original/displayText`，本例不带源码 position；`sections` 含 yaml/heading/paragraph/code，块索引的范围是整段。

`getAllTags` 在本例先列 Frontmatter 标签，再列正文标签，并补上 `#`。引用计数包含 Frontmatter：指向 Note 的正文链接与 YAML 链接合计 2，嵌入 Other 为 1；代码内链接和标签不计。`resolveSubpath` 返回 heading 或 block 对象、start/end，未找到返回 null。`await vault.modify` 刚返回时缓存仍是旧值，随后出现 `changed(file, data, cache)`、`resolve(file)`、`resolved()`；事件实际顺序已记录，不把一次顺序推为所有异步场景的保证。

12 份 `processFrontMatter` 观察确认：

- callback 同步原地改值，其返回对象被忽略，方法完成值为 undefined；两个并发调用依次读到 count 0、1，最终为 2。
- 缺少 Frontmatter、空 Frontmatter 或 null 时 callback 收到 `{}`；删除所有属性后去掉整块 YAML，正文仍在。
- 非法 YAML 在 callback 前拒绝；callback 抛错也拒绝，两个样本均保持原文件字节不变。
- 原版会重新序列化 YAML，连无改值 callback 也会丢掉注释；CRLF 样本保留围栏/正文的 CRLF，但新 YAML 内部使用 LF。
- BOM 前缀样本未被识别为现有 Frontmatter，原版在 BOM 和旧文前添加了新的 YAML 块。数组型 YAML 传入数组，给其附加命名属性未改变序列化结果。这些是明确边界，不应在未告知的情况下把原版异常行为等同数据保全目标。

`Vault.process` 的两个并发回调依次读取前一写入后的正文，并各自返回写入后的完整字符串。`createBinary/readBinary/modifyBinary/appendBinary/copy` 和 adapter 二进制读写保留 0、128、255 等字节；读取为 ArrayBuffer，创建时显式 ctime/mtime 在本例按值保留。

网络仅使用本轮 loopback HTTP fixture。`requestUrl` 返回 Promise，另外暴露 `.text/.json/.arrayBuffer` Promise 快捷字段；最终 response 也具有这些字段，响应头键为小写。二进制 POST、302 跟随、响应字节和中文 UTF-8 均有服务端收到值及客户端结果。418 默认拒绝，错误带 `status: 418`；`throw:false` 返回 418 响应。非 JSON 响应可正常读 text，访问 `.json` 抛 SyntaxError。旧 `request` 返回文本字符串。没有访问原云、公共服务、登录或生产认证流程。

## 递归布局与临时编辑状态

原版布局为递归 `split / tabs / leaf`，不是固定平面 panes 数组。本例 `vertical` 分屏显示为左右，`horizontal` 为上下；子节点 `dimension` 保存设置值，37/63 与 61/39 反映到实际列宽/行高。`tabs.currentTab` 从 0 开始。固定叶同时具有外层 `pinned:true` 和 `leaf.state.pinned:true`；未固定样本省略该键。

Markdown 持久视图状态是 `{file, mode, source}`：`mode:'source', source:true` 为源码；`source:false` 为 Live Preview；`mode:'preview'` 为阅读。`getLayout/getViewState/view.getState` 的本例结果不含 cursor 或 scroll。隐藏的已还原 leaf 可能延迟建立编辑器：序列化 state 已有文件，但激活前没有可用 `view.file/editor/getMode`。

保存 `getLayout()`，打乱布局后调用 `changeLayout(saved)`，实际恢复了嵌套 main、活动 leaf/file、固定和模式；重新建立的活动编辑器光标不等于原值，scrollTop 从约 2861 变成 0。这是**持久布局还原不包含临时编辑状态**的直接样本，不能以 JSON 相等证明光标/滚动恢复。

`getEphemeralState()` 另返回 `cursor:{from,to}` 与数值 `scroll`。该 scroll 不是像素：源码模式的一次往返保持实际选区、第一可见源码行和该行相对视口偏移不变，但 DOM scrollTop 从 1800 变为 1632。保存值 63.189236 与“源码行号 + 行内比例”在该例吻合；10.5 校准也接近此含义，80.25 校准和 Live Preview 往返存在可见行偏差。因此不能承诺任意长文档或 Live Preview 的精确滚动还原。

左右侧栏在布局中各有 `width/collapsed/currentTab`：本例左 231 px、第二页 search；右 277 px、第三页 outline。折叠后的实际宽度为 0，展开后回到设置宽度，活动 header 与实际视图均检查；展开样本省略 collapsed，折叠时为 true。订阅观察到 `active-leaf-change/file-open/layout-change/resize`，存在合并或延后，不能要求每个 setter 必须同步发出固定数量事件。

本轮布局恢复全部发生在同一原版进程中；没有证明进程重启、崩溃、DPI 或多显示器恢复。截图：[嵌套还原](../research/windows-round3/screenshots/layout03/layout-roundtrip-restored.png)、[源码滚动前](../research/windows-round3/screenshots/layout03/layout-source-scroll-before.png)、[源码滚动恢复](../research/windows-round3/screenshots/layout03/layout-source-scroll-restored.png)、[侧栏状态](../research/windows-round3/screenshots/layout03/layout-sidebars.png)。

## 组合事件不是原生 IME

`composition01` 使用 `new CompositionEvent` 与 `document.execCommand('insertText')`，所有 composition 事件 `isTrusted=false`，没有输入法候选窗口或系统预编辑提交。

文件切换样本中，第一次插入返回 true，但 CM 尚未接受“中”；程序切到 B 后，尾字“文”写入 B。另一个模式样本中，合成组合状态存在时仍可切阅读，已有“甲”保留。这些结果只说明该程序序列的行为，**不能推断真实 Windows IME 会丢字、串写或安全，也不能用作应复刻的 IME 合同**。原生输入结果须由单独的系统键盘/候选窗记录证明。

## 重现与剩余范围

在安装了对应原版、隔离 Electron 39.8.3 与 REA 6.7.0 的同一实验环境中，使用唯一 tag 运行；脚本拒绝复用已有输出目录：

```powershell
node research/windows-round3/run.mjs new-editor-run plugin-editor.js
node research/windows-round3/run.mjs new-data-run plugin-data.js
node research/windows-round3/run.mjs new-render-run plugin-render.js
node research/windows-round3/run.mjs new-layout-run layout.js
node research/windows-round3/run.mjs new-composition-run composition.js
```

本次汇总命令：

```powershell
node research/windows-round3/summarize.mjs discover02 editor02 data02 render05 layout03 composition01
```

原始 profile、库、REA 文件和日志仍在忽略目录 `research/raw/windows-round3-*`；可复用探针、20 张校验截图与结构化观察位于 `research/windows-round3/` 和汇总 JSON。没有完整社区插件、CodeMirror 扩展生态、所有 API/事件或跨平台对等结论。独立实现还需针对这些冻结输入和生命周期另做验收；本报告不修改兼容矩阵状态。
