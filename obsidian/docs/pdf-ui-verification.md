# PDF 桌面阅读器验收

验收时间：2026-10-23 14:10–14:17（Asia/Hong_Kong）。通过 Playwright CLI 连接实际 Electron 窗口的 CDP 9332，测试本地 `dist/index.html` 与真实 `vaultdesk-asset:` 附件协议，未使用浏览器替身或模拟 PDF API。

## 环境与样本

- 隔离测试库：`output/desktop-ui-1792735250323/vault`。
- `附件/参考.pdf`：4 页，包含中英文文字、双栏内容和 4 个文档大纲目标。
- `附件/扫描验收.pdf`：纯图像的 1 页 CCITT Group 4 PDF。源样本 `output/pdf/ccitt-reader-validation.pdf` 明确使用 `/CCITTFaxDecode`；已先使用 Poppler 渲染并人工检查标题、复选框及十行文字。
- PDF.js：本地打包的 `pdfjs-dist@6.4.299`，worker、CMap、标准字体和 WASM 资源随应用分发。
- 最后一次重新加载后的主包：`dist/assets/index-BXE6LGR_.js`，已包含 Escape 修复。

## 实测结果

| 检查 | 结果与证据 |
| --- | --- |
| 打开本地 PDF | 4 页文档正常加载；第一页中英文、双栏内容、页脚和可选择文本层均可见。实际 canvas 为 1154×1539，阅读器宽度为 872 CSS px。见 `output/playwright/pdf-reader-page1.png`。 |
| 中文全文搜索 | 输入“跨端阅读”，显示 `1 / 4`；当前页形成可见高亮，高亮矩形约 71.8×26 CSS px。见 `output/playwright/pdf-chinese-search.png`。 |
| 页码与缩放 | “下一页”从第 1 页推进到第 3 页；选择 150% 后 canvas 为 2400×1800（当时已旋转 90 度）。 |
| 旋转与重新渲染 | 90、180、270、0 度循环后页面及文本层恢复正确方向；未产生未处理的渲染取消异常。 |
| PDF 文档大纲 | 能读取 4 个 `Validation section` 项；点击 section 4 后页脚和页码确认跳到第 4 页。 |
| 页面引用 | 点击复制页面引用，Windows 剪贴板实际内容为 `[[附件/参考.pdf#page=4]]`。 |
| 文字选择与引用 | 通过真实鼠标拖选标题，显示“已选择 27 字”；点击复制引用，Windows 剪贴板实际内容为 `> PaperDesk Reader Validation`、空行、`[[附件/参考.pdf#page=4]]`。见 `output/playwright/pdf-selection-reference.png`。 |
| Markdown PDF 深链 | 从“附件测试”的阅读模式点击 `[PDF 页面](附件/参考.pdf#page=1)`，打开内置阅读器并落在第 1 页。 |
| 扫描图像解码 | CCITT 扫描 PDF 正常显示；在 50% 缩放下标题、十行文字、复选框和底部验证语全部可见。见 `output/playwright/pdf-ccitt-scan-complete.png`。 |
| 搜索 Escape | 在最新构建的搜索输入框中输入查询后按 Esc，搜索框消失、高亮数归零，焦点回到 `vd-pdf-reader`。 |
| 控制台与异步错误 | 页面 `error` / `unhandledrejection` 监听结果均为空；Playwright CLI console 最终报告 0 errors、0 warnings。 |
| 纯逻辑测试 | `node --test tests/pdf-model.test.mjs`：8/8 通过，覆盖页码解析、中文与空白归一化搜索、原文范围映射、跨文本段高亮、引用格式。 |

## 验收期间修复

1. 画布渲染启动后立即给 render promise 挂拒绝处理，避免等待文字提取期间取消任务产生未处理的 `RenderingCancelledException`。真实错误仍通过后续 `Promise.all` 上报。
2. 增加 `navigationKey`：外部重复请求同一页码时，页码 effect 也会重新执行；由 App 每次导航生成新 key。
3. 启用本地 WASM 解码并设置 `stopAtErrors: true`，保证 CCITT/JBIG2/JPEG2000 所需解码路径可用，解码失败时显示错误。保留 `isEvalSupported: false`；桌面 CSP 单独允许 `wasm-unsafe-eval`。
4. 将 Escape 处理移到输入控件提前返回之前，搜索输入框内可以关闭搜索并清除高亮。

## 覆盖边界

以上是 Windows Electron 实际窗口中的定向回归。没有据此宣称所有 PDF 格式均兼容。密码文档、损坏文档错误路径、JPEG2000 与 JBIG2 独立样本、PDF 外部链接未在这轮专项 UI 中分别实测。纯扫描样本没有文本层，不提供 OCR。

后续主线在同一构建的便携程序中，通过临时插件实际调用 `workspace.openLinkText`，验证同一阅读器中 page=2 → 内部翻到3 → 再次请求page=2成功；详见[便携程序实测](verification-2026-10-23.md)。
