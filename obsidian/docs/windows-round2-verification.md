# Windows 第二轮验收（0.2.0）

日期：2026-10-23。分支：`feature/obsidian-selfhosted`。本轮继续以 Obsidian 核心 1.13.7 的独立 REA 观察为参考；产品运行时升级到开源 Electron 42.11.9。所有操作使用合成知识库和独立测试 profile，不加载用户笔记或原云账号。

本轮显著扩充了 Windows 客户端，但没有达到完整 Obsidian 行为或社区插件兼容。逐项范围以 [兼容矩阵](parity.md) 为准。

## 参考与差分

- [原版运行报告](windows-round2-reference.md)记录 4 次采纳的独立运行及 REA Evidence ID，覆盖书签、转换器、日记、唯一笔记、固定标签、分屏、命名工作区、浮窗恢复、幻灯片与 Frontmatter。
- [36 份 Frontmatter 差分](windows-round2-differential.md)：字节一致 36/36、语义一致 36/36、正文保留 36/36。该结论只对应报告中选定转换及源码哈希。
- 冻结核心语料仍为 strict-reference 218/218、portable-core 197/197，4 个负控拒绝。它只覆盖链接、元数据与改链子集。

## 已接入的能力

多窗口按库隔离、同库保存队列与同步前保存握手、独立窗口布局及重启恢复；固定标签、拖动标签、最多四个分屏及方向、命名布局；书签分组/标题/块/搜索/URL；日记与唯一笔记日期格式及模板；七类 Markdown 转换预览与显式应用；幻灯片全屏和键盘导航；原生文件导入、图片粘贴入口及历史内容预览。

Bases 表格加入安全公式解释、公式依赖、嵌套筛选、多列排序、分组、汇总及原文属性编辑。网页标签使用独立、受限的 `WebContentsView`；页面不获得应用 bridge、Node 或 Electron 接口。自有同步加入排除文件夹、附件类型选择、自动/暂停/继续、进度与重试，并在同步前等待同库各窗口提交编辑内容。

## 原生桌面证据

| 操作 | 实际结果及范围 |
| --- | --- |
| 多窗口脚本 | `output/windows-1792745793133-e2381e/report.json`：11/11；不同库隔离、同库并发 CAS、附件 token 隔离、真实 File 导入、所有同库编辑器保存后上传、独立布局及重启恢复 |
| 恢复边界脚本 | `output/session-1792745705712-e27fd6/report.json`：5/5；部分库缺失不提前覆盖 session、重新接回保留窗口身份与设置、全部缺失使用 Welcome 且二启不重复 |
| Bases 桌面写回 | 在实际 Electron/dist 中打开 `.base`，将 `table-product.md` 的 price 从 12 改为 20，公式 total 从 24 更新为 40；直接读取磁盘确认 YAML 修改、正文 `# Product body must survive` 保留。截图 `output/playwright/windows-bases-write.png` |
| 转换器桌面写回 | 只选择 `converter-check.md`、只启用规范属性格式，预览显示 3 处更改；应用后磁盘 tag/alias/cssclass 转成 tags/aliases/cssclasses，正文保留，库内历史生成。36 份差分仍是另一组纯函数证据 |
| 网页导航与保留 | 本机合成网页 `/first` 输入草稿，切回笔记再回网页后草稿及页面实例 UUID 不变；点链接进入 `/second`，应用工具栏后退回 `/first`，草稿保留；页面检查 bridge/require 均 undefined。弹窗隐藏、重载清理另见最终检查记录 |
| 自动同步设置 | [专项报告](windows-sync-ui-verification.md)：真实 UI 注册/选库/开启后自动上传；清空目标超过 60 秒不上传；重新选择自动提交积压修改；退出账号后 79 秒仍不上传。控制台零错误零警告 |

多窗口脚本使用宿主 bridge 与真实编辑器，不能等同所有窗口菜单手势已经验证。网页属于独立测试源；其无 CSP 警告来自合成网页，应用 renderer 的控制台单独检查。原版 WebViewer 在参考产品条件下未启用，因此没有成功参考交互可供宣称一致。

## 专项与性能

[编辑器报告](editor-ui-verification.md)新增嵌套语法、折叠、多光标、任务/表格编辑，以及组合输入切换文件时旧尾字符只写回旧文件的合成事件探针；尚未实际操作 Windows IME 候选窗口。[书签/转换/幻灯片](windows-extras-ui-verification.md)和 [Bases 组件报告](views-ui-verification.md)分别保留浏览器与组件验证的范围。

[性能基线](windows-performance.md)使用 100/1,000/10,000 篇合成 Markdown。10,000 篇首次快照约 2,468 ms、两次暖快照约 2,122/2,234 ms；预备路径索引约 21.6 ms，复用该索引解析全部 20,000 条引用约 77.7 ms。没有测量 UI FPS、输入延迟、内存峰值或完整原版性能对比。

## 自动检查与已知边界

启用真实云集成的 Node 全套 **227/227 通过、零跳过**，日志在 `output/windows-round2-tests.log`，[脱敏汇总与源码哈希](../research/windows-round2-verification.json)。云 API pytest：19 passed、23 subtests passed；有一条上游 TestClient 弃用警告。Vite 生产构建成功，仍有大 chunk 提示。Docker 未在本机运行，不能声称容器部署已验证。

最终实际 Electron/dist 又验证：主界面重载前后始终只有一个所属网页视图，设置按钮仍可操作；合成图片粘贴只生成一个 68 字节附件并插入嵌入链接，笔记原文保留；历史界面同时显示旧/新正文，点击恢复后磁盘读回旧文；固定标签重载后仍保留。应用 renderer 控制台零错误零警告。图片操作使用合成 ClipboardEvent，不能冒充操作系统剪贴板手势。已归档[表格写回截图](images/windows2-bases.png)及[历史预览截图](images/windows2-history.png)。

`npm run package:win` 已生成 `release/VaultDesk-0.2.0-Windows-x64`，使用 Electron 42.11.9，附 153 份依赖声明。实际启动该目录的 `VaultDesk.exe`，在隔离测试库中经编辑器保存内容并从磁盘读回一致；通过命令打开第二个同库原生窗口，窗口列表确为 2；PDF 阅读器显示 4 页文档，首屏 canvas 为 1154×1539，中文文本层存在。打包程序 renderer 控制台零错误零警告。未签名、无安装器及自动更新，旧 0.1.0 产物保留。

主要未完成项：完整 Plugin API/社区插件；完整 Live Preview 与真实 IME/长时编辑；任意嵌套布局和 DPI/崩溃恢复；图谱分组、Canvas/Bases 全格式、主题安装；生产同步规模、配置同步、端到端加密、共享权限及完整发布站点能力。移动端及 macOS/Linux 未验收。

## 测试清理

自动审批拒绝了旧性能试跑目录，以及自动同步 UI 的临时库/数据库与 profile 删除，返回原因只有 `blocked by policy`。这些目录保留合成数据，未尝试绕过；准确位置见 [性能报告](windows-performance.md#临时数据清理状态)与[同步 UI 报告](windows-sync-ui-verification.md)。该情况不代表服务仍在运行，相关测试进程已经退出。
