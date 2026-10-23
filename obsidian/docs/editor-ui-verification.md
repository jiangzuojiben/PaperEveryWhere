# 编辑器 UI 验证记录

验证日期：2026-10-23，Asia/Hong_Kong。

本文记录独立编辑器实现的实际验证，不代表 Obsidian 全功能兼容验收。编辑器实现位于 `app/Editor.jsx`、`app/editor.css` 和 `app/markdown.js`。

## 环境与范围

- 使用 Playwright CLI 的独立 `editor-check` 浏览器会话，访问 Vite 开发服务 `http://localhost:5178/`。
- 使用浏览器自己的演示知识库，没有用这些输入步骤修改用户的磁盘知识库。
- 浏览器交互、浏览器内渲染探针、独立 React 组件探针分别列出，避免把函数测试当成完整桌面验证。
- 验证后关闭了 `editor-check` 会话；没有接管主验收浏览器或 Electron 窗口。

## 实际交互

| 项目 | 操作 | 观察结果 |
| --- | --- | --- |
| 三种模式 | 在「开始」中切换源码、实时预览、阅读模式 | 模式对应内容可见，阅读渲染保留最新文本 |
| 中文文本输入 | 源码模式点击编辑器，Ctrl+End 后输入「编辑验证中文输入」，再切换阅读 | 编辑 DOM 和阅读 DOM 都包含输入；这是直接输入 Unicode 文本，未覆盖 Windows 输入法候选／组合过程 |
| 模式切换与撤销 | 连续探针向当前 CM 文档追加 `MODE_PROBE`，点击阅读，再点击实时预览并调用 CM undo | 阅读包含标记；切换前后为同一 CM 实例；`undoDepth=1`，undo 返回成功，恢复后的文档逐字符等于测试前 |
| 查找替换 | 聚焦笔记编辑器后按 Ctrl+F | 出现 CM 的 Find 与 Replace 输入框 |
| 任务回写 | 阅读模式点击第一项「切换任务状态」，检查隐藏编辑器的真实文档，再点击恢复 | checkbox 状态变化，源文包含 `- [x] 写下一个值得保留的想法`；随后恢复 |
| 斜杠建议 | 源码模式在新行输入 `/` | 出现命令建议，包含新建笔记、切换阅读模式、打开图谱等传入命令 |
| 斜杠执行 | 新行输入 `/切换阅读`，等待建议后按 Enter | 实际切换为阅读模式，文档中不残留 `/切换阅读` 查询文本 |
| 链接预览 | 阅读模式悬停「知识网络」链接 | 出现约 350 px 宽的小浮层，包含文件名、正文摘要和「打开 ↗」按钮 |

开发服务在验收期间存在并行热更新。首次跨多次 CLI 调用的撤销检查未通过，当时读到的历史深度为零；不能把那次检查算作通过。上表的模式／撤销结论来自随后一次连续探针，明确检查了实例身份、历史深度和完整文档恢复。正式打包版本仍应复验真实键盘的长时间撤销流程。

截图与快照：

- [Live Preview 截图](../output/playwright/editor-live.png)
- [阅读模式截图](../output/playwright/editor-reading.png)
- `output/playwright/editor-source.yml`
- `output/playwright/editor-find.yml`
- `output/playwright/editor-live-updated.yml`

截图只证明当时可见区域，不作为截图外功能的证据。截图中的演示库可能保留测试输入，与初始样本字符数不同。

## 浏览器内的渲染与状态探针

### Markdown 渲染

在真实浏览器中导入 `app/markdown.js`，对包含以下内容的组合样本调用 `renderMarkdown` 并检查 DOM：

- YAML frontmatter、标题、带别名和标题片段的 wikilink。
- 笔记嵌入、循环嵌入、折叠 callout、任务列表。
- 表格、脚注、行内与块级公式、`==高亮==`、`%%注释%%`。
- 带尺寸的图片嵌入，以及 `script`、`iframe`、`onerror` 测试内容。

观察结果：链接目标为 `Folder/Other.md#Heading`；笔记嵌入与 callout 存在；任务保留原文行号；表格和脚注生成；两种公式均生成 KaTeX 节点；高亮生成 `mark`；注释文字未泄漏；图片保留供宿主解析的 `data-asset-path`；清理后不存在 `script`、`iframe` 或 `onerror` 属性。

该轮发现嵌入笔记共享外层脚注状态的问题，随后已隔离嵌入的 footnotes、references 和 DOM ID。复杂多层脚注嵌入尚未完成独立全面回归。

### 链接一致性

构造 `A/Source.md`、根目录 `Note.md`、`A/Note.md`、`Hello World.md`、`Hello%20World.md` 并在浏览器渲染链接。结果为：

| 源文本 | 目标 |
| --- | --- |
| `[[Note]]`，来源 `A/Source.md` | `Note.md`，与 core resolver 的根目录优先规则一致 |
| `[[Hello%20World]]` | 字面文件名 `Hello%20World.md` |
| `[hello](Hello%20World.md)` | `Hello World.md` |
| `[heading](Note.md#A%20B)` | `Note.md#A B` |

Wikilink 不做 URL 百分号解码，Markdown URL 做解码；实际查找统一调用 `core/vault.mjs` 的 resolver。

### Mermaid 与 HTML 清理

将 `graph LR; A[Start] --> B[Finish]` 对应代码块插入临时 DOM 并调用 `hydrateMarkdown`。生成 SVG，保留 `Start`／`Finish` 标签，结果不包含 `script` 或 `foreignObject`。Mermaid 使用 strict 配置；输出再次经过 DOMPurify。

这只是所用恶意标记和图表示例的验证，不是通用安全审计。

### 只读与受控更新

在浏览器临时 DOM 中挂载独立 Editor，按顺序修改 props 并调用公开 API：

1. 可编辑状态调用 `insert('中文')`，`onChange` 得到中文内容。
2. `getSelectionInfo()` 返回 `{text:'', from:2, to:2}`。
3. 切到 `readOnly=true` 的阅读模式，任务 checkbox 为 disabled。
4. 再调用 `insert('BLOCKED')`，内容没有变化。
5. 恢复可编辑并将 value 改为 `External update`，CM 显示外部新值。
6. 卸载临时组件并删除测试 DOM。

## 修正与只读审查

- YAML frontmatter 现在是独立语法节点，在实时预览中显示等宽原文，避免将末尾 `---` 误当 Setext 标题。
- 自定义 CM 高亮样式去掉了标题默认下划线；浏览器计算样式检查得到正文字重 400、标题 650、frontmatter 400。
- 富文本 widget 显式使用 `white-space: normal`，修复继承 CM `pre-wrap` 造成的额外空白。
- PDF 嵌入已改为附件卡片，保留 `#page=N`，交由独立 PDF 阅读器打开。没有把原生 iframe 当作 PDF 已成功显示的证据。
- 只读审查发现跨知识库保留 CM history 的风险。父组件已为 Editor 增加由 vaultPath 和 pane 索引构成的 key；再次阅读源代码确认 key 存在，同库文档缓存仍保留。
- 只读审查发现录音完成回调可能把旧库录音写入新库。父组件已在录音对象存在期间禁止切库，并保持该对象直到附件保存完成；回调绑定开始录音时的原笔记路径，原笔记失效时仅保存附件并提示。已阅读修订源码确认，未在此次审查中录制音频或切换真实知识库。
- 保存与 refresh 审查时可见：同路径写入通过 `saving` 循环等待；flush 持续处理 dirty；snapshot 使用 vault、编辑和请求版本拒绝过期结果。以上为代码审查观察，不等同于异步故障注入测试。

## 构建与剩余范围

执行 `node node_modules/vite/bin/vite.js build`，最后一次本编辑器工作阶段的构建成功，输出为 `built in 26.30s`。保留的日志为 `output/editor-build.log`。构建有大 chunk 提醒，不影响此次编译通过。

最后追加的 `scrollToFootnote(id)`、`scrollToLine(number)` 已通过该构建；其最后版本未另做浏览器交互回归。未引用的脚注不会出现在阅读 DOM 中，`scrollToFootnote` 对此返回 false，并将隐藏源码编辑器光标定位到定义，调用方可切到源码模式。

剩余验证范围：

- Windows 原生 IME 组合输入、长文档和超大知识库性能。
- 完整 Obsidian Live Preview 语法及复杂嵌套行内语法的一致性。
- 全语言代码块高亮、社区插件扩展语法与原版全部编辑快捷键。
- 所有音视频编码、真实磁盘附件与独立 PDF 阅读器的完整桌面流程。
- 长时间编辑、外部文件并发修改、切库和保存失败的端到端压力测试。
- 完整无障碍、所有主题与窄屏的视觉回归。

上述范围不能依据本记录声明已完整还原或全部通过。

## 追加：Windows 编辑交互矩阵

2026-10-23 同日追加验证，使用独立 `editor-matrix` Playwright CLI 浏览器。
后半程使用 `output/playwright/editor-probe.html` 单组件夹具，避免并行修改 App 导致整页重载干扰结果。夹具仅通过 Vite 开发服务器访问，没有读写磁盘知识库。

本轮代码增加了 `onSelectionChange({from,to,text,characters,words,ranges})` 和 `onPasteFiles(files,{path,from,to,text})`。
多选区统计中的 `from/to` 是主选区，`text` 用换行连接所有非空选区；`characters` 统计实际选中文字的 Unicode 码点，不把连接用的换行算入字符数。`getSelectionInfo()` 仍返回主选区，保持原调用契约。

| 项目 | 验证方式与结果 |
| --- | --- |
| 复杂行内语法 | Live Preview 使用 Markdown 语法树处理嵌套粗体／斜体、删除线、多个反引号的代码跨度和平衡括号链接 URL；代码中的 `[[literal]] **raw**` 保持字面显示。纯函数测试另外覆盖转义、注释和未闭合标记。 |
| 表格点击落点 | 实际点击 `beta` 单元格，源码光标为 149，与原文 `beta` 起点相同；原文不变。 |
| 多选区格式 | 程序建立正向／反向两个选区后实际按 Ctrl+B，两处同时加粗，反向选区方向保留；回调统计 9 字符、2 词、2 个选区。 |
| 键盘创建多选区 | 实际点击编辑器、Ctrl+Home、两次 Ctrl+D，得到 2 个 `same` 选区；键入 `word` 后原文为 `word word`，undo 后恢复 `same same`。 |
| 模式与撤销 | 多选区加粗后点击阅读、实时预览，同一 CM 实例继续使用；历史深度为 1，undo 后逐字符恢复夹具原文。 |
| 标题折叠 | 在源码模式实际点击标题折叠栏，折叠范围数为 1；切到实时预览仍为 1，源文始终不变。 |
| 任务列表续行 | 在 `- [ ] first` 末尾按 Enter，生成第二行 `- [ ] `；输入 second 后 Tab 得到两个空格缩进，Shift+Tab 恢复。 |
| 跨行选择边界 | 对 `**first\nsecond**` 将光标放在第二行时，两侧 `**` 都显示；选择第一行直到第二行起点后，原文仍不变。 |
| 文件事件 | 合成的 ClipboardEvent 和 DragEvent 携带一个 PNG File，各触发一次回调，包含文件名、类型、大小以及原路径／选区；事件被阻止默认处理，文档不变；只读状态不再调用导入回调。 |
| 组合事件边界 | 合成 compositionstart 后 `compositionStarted=true`、`composing=false`；这时请求阅读模式和外部 value，200 ms 后仍保持实时预览与旧文本。compositionend 后才切阅读并应用外部 value。 |
| 富文本区块刷新 | 将嵌入文件内容由 `old embedded` 更新为 `new embedded` 后，Live Preview 区块同步更新；只读时编辑按钮 disabled，恢复编辑后重新启用，嵌入源码不变。 |

文件事件验证仅覆盖编辑器到宿主的回调边界，没有验证 Windows 系统剪贴板或磁盘附件导入。组合事件验证没有打开系统输入法候选窗、没有提交真实 IME 文本，不能替代 Windows 原生 IME 验收。

本轮发现跨行强调的开闭标记按各自行号隐藏，会造成一侧标记仍被隐藏。修正后每个标记保留整个语法跨度作为显示条件。首次热更新后的临时组件仍使用旧的闭包，结果未通过；整页刷新加载最终代码后，两侧标记均显示，结果才记为通过。

证据：

- [结果数据](../output/playwright/editor-matrix-results.txt)
- [区块刷新结果](../output/playwright/editor-widget-refresh-results.txt)
- [Live Preview 截图](../output/playwright/editor-matrix-live.png)
- [单组件夹具](../output/playwright/editor-probe.html)
- `node --test tests/editor-helpers.test.mjs`：5 项全部通过。

本轮没有运行构建或写入 `dist`；最终整体构建由集成流程负责。原生 IME、超长文档性能、完整原版 Live Preview 一致性与真实文件导入仍需单独验证。

### 追加修复：组合输入期间切换笔记

只读复核发现原 path 分支在 compositionStarted 检查之前调用 `view.setState()`，而 props 已将 onChange 改为新笔记回调。现已把请求的文档上下文与当前接收输入的上下文分开：组合期间继续保留旧 path／回调；compositionend 之后保留 80 ms 稳定间隔，尾部输入或旧文档更新会延长间隔，再缓存旧状态并切换到最新请求的文档。模式切换也等待该文档切换完成。

独立 `editor-composition` 浏览器在同一组件内设置 A、B 两个分别绑定路径的回调，实际发送合成 compositionstart、输入「中」、请求 B，200 ms 后仍显示 A 且 `compositionStarted=true`。随后发送 compositionend 并输入尾字符「文」，观察到两次写回均指向 A：A 为 `A original中文`，B 仍为 `B original`。完成切换后输入 `!` 只修改 B；撤销 B、返回 A 后中文仍在，A 的 undoDepth 为 1，再撤销恢复 A 原文。另一个探针在组合期间先请求 B 再请求 C＋阅读模式，结束后进入 C 的阅读内容，没有落到过期请求 B。

结果：[editor-composition-path-results.txt](../output/playwright/editor-composition-path-results.txt)。这是 DOM 组合事件与浏览器 Unicode 插入探针，不是真实 Windows IME 候选／预编辑提交验收。未运行构建，独立浏览器已关闭。
