# Windows 书签、格式转换与幻灯片验收

2026-10-23，在 Windows 本机以独立 Playwright CLI 浏览器会话 `winextras` 访问 `http://127.0.0.1:5178/`，使用隔离的浏览器演示库。以下是实际 UI 操作与持久化值观察，不代表 Windows 安装包或 macOS 验收。未操作原版 Obsidian 窗口，未运行 dist 构建。

## 书签

- 新建分组、文件、标题、搜索、网页、内容块书签；标题与内容块最终保存为 `type: file` 配合独立 `subpath`。
- 将文件书签通过菜单移动至分组、编辑显示名称；网页书签上移，重载后顺序保留。
- 使用真实 HTML 拖放将网页书签移入折叠分组；检查持久化树确认目标分组包含该项，再通过菜单删除该书签。
- 分组折叠后立即重载，折叠状态、子项和显示名称保留。验收使用 App 最新的立即保存与 `beforeunload` 提交实现；未验证强制结束进程或断电。
- 打开搜索书签后，搜索框为 `tag:#指南`，显示 1 个结果。
- 通过 UI 创建 `C# Basics.md` 并写入标题及 `^test-block`。文件书签与块书签均重新打开这个完整文件名；持久化结果分别为 `path: "C# Basics.md", subpath: ""` 与 `path: "C# Basics.md", subpath: "#^test-block"`。
- 块书签的文件解析已验证；精确光标位置、长文档滚动位置未在本次验收断言。网页书签的操作系统外部浏览器启动未在本次验收。

截图：[书签结构](../output/playwright/windows-bookmarks.png)、[搜索书签](../output/playwright/windows-bookmark-search.png)、[井号文件名](../output/playwright/windows-bookmark-hash-path.png)、[拖放删除后的书签](../output/playwright/windows-bookmarks-final.png)。

## Markdown 格式转换

- 从命令面板打开转换器，七个转换类型默认全部关闭，应用按钮禁用。
- 仅选择 `开始.md`，启用 Roam 标签转换，生成预览。前后源码分别包含 `#灵感` 与 `[[灵感]]`。
- 应用按钮明确显示“应用到 1 个所选文件”；应用后对比演示库所有文件，唯一变动路径是 `开始.md`，其他文件内容保持相同。
- 转换后写入内容包含 `[[灵感]]`，UI 显示完成。转换过程中捕获到的 `error` / `unhandledrejection` 为零。
- 原版 frontmatter 36 个冻结样例的独立对比见 [Windows R2 差分](windows-round2-differential.md)，以该报告记录的被测哈希为准。当前模型 SHA-256：`7d4615f2eee8702e1f58634affd2c04f0ea816c76e77dafc7ad3453ab1d260d0`。

截图：[转换预览](../output/playwright/windows-markdown-converter.png)。

## 幻灯片

- 从命令面板打开当前笔记，显示 `1 / 2`，首张内容排除 YAML frontmatter。
- 右方向键到 `2 / 2`；Home 回到 `1 / 2`；End 后 Shift+空格回到 `1 / 2`。
- 点击“进入全屏演示”，实际 `document.fullscreenElement.className` 为 `wx-slides`。
- Esc 后幻灯片组件关闭，`document.fullscreenElement` 为空。
- 视觉检查确认标题、列表、任务、表格与提示块沿用笔记渲染样式。采用现有净化 Markdown 渲染路径。
- 未在本次 UI 验收单独测试 25 张以上页码输入、媒体附件、外链启动或多显示器。

截图：[实际全屏](../output/playwright/windows-slides-fullscreen.png)。

## 自动检查与集成边界

- `node --test tests/windows-extras.test.mjs`：26/26 通过，覆盖迁移、旧字段保留、含井号路径、标题/块规范化、嵌套移动与循环防护、重命名映射、转换选择范围、原版转换规则、frontmatter 和幻灯片分隔。
- `esbuild.transform` JSX 语法检查通过；没有生成 dist。
- Playwright 控制台最终为 0 errors、0 warnings（仅 Vite/React 开发提示）。
- `BookmarksPanel` 为受控组件，`onChange` 接收完整树；持久化由 App 提供。`onOpen` 接收规范化的书签对象，文件名与 `subpath` 需分别传递。
- `MarkdownConverterDialog` 的 `onApply` 只收到已选择且确有变化的 `{ path, before, after, changes, warnings }`；宿主负责检查 `before` 是否仍为当前内容、创建版本并写入。
- `Slides` 支持 `text/path/files/resolveAsset/onNavigate/onClose`，使用当前 Markdown 渲染与附件解析能力。
