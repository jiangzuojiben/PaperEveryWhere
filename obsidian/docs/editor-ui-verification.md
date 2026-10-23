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
