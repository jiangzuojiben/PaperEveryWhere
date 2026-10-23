# Windows 第二轮原版行为采样

本报告记录 **Obsidian 1.13.7 原版**的实际行为，用于独立实现的需求对照。它不是 VaultDesk 的通过报告，也没有把参考程序与独立程序作自动相等比较。

## 环境、证据与边界

日期为 2026-10-23，Windows、Electron 39.8.3、香港时区。每次运行使用新的合成库和 profile，核心 ASAR SHA-256 固定为 `a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d`。所有采纳运行的实验程序与 REA 均退出 0；退出后重新计算核心哈希，未发生修改。

REA 6.7.0 驱动 loopback 控制页；自写实验壳加载未改动的原版核心，在原渲染器调用实际命令/API、操作原 DOM 控件，并读取原版文件与布局结果。控制页展示报告 SHA-256，REA 捕获该页面的 DOM、accessibility 与 URL。因此 REA 绑定的是**控制页报告及其哈希**，不是直接操作 Electron 页面；原窗口 PNG 由 Electron `capturePage` 另取，汇总时再次校验哈希。

未加载真实库、原服务账号或凭据，没有执行登录、同步或发布操作。实验壳禁止外部 URL 打开和系统协议注册，拦截远端 Electron HTTP(S)/WS(S) 与 Node `http/https.request/get`；这是实验保护，不是操作系统网络沙箱。截图前短暂 `showInactive` 促使 Chromium 绘制当前画面，截图后隐藏，不抢占输入焦点。首次探索的隐藏窗口陈旧帧不作为视觉证据。

可审查产物为 [结构化记录](../research/windows-round2-reference.json)、[实验脚本](../research/windows-round2/)与其中截图。原始完整 REA 返回值、profile、合成库和日志保留在忽略版本管理的 `research/raw/windows-round2-*`。结构化记录包括原报告/REA 文件/探针的 SHA-256、生命周期、全部采纳观察和截图路径。

| 运行 | REA Evidence ID | 采纳范围 |
| --- | --- | --- |
| `features02` | `ev_b2f6a3492ab18df28c85761dcbeb732ae8321364f6aa208a0389e54c572d1d0b` | 书签、导入器、网页插件可用性、幻灯片初始状态；10 条记录 |
| `daily02` | `ev_a4ed9333e3f4d5efc9ee2704b165f876c8b7aa1e1fbe10ed55e805da25f976e9` | 日记/唯一笔记 10 个行为场景及 1 条能力记录 |
| `workspace03` | `ev_cbe84df763cb843ab5e4c1792d1d58f4fe600095691b7117dcf7c2dd8dde7f72` | 固定标签、分屏、命名布局、窗口恢复、幻灯片；10 条记录 |
| `frontmatter02` | `ev_888afa10f50ab43a05f865476cb3e8aedd25ec9a191a04dedec7c34f14aa31e4` | 36 个 Frontmatter 输入：15 项转换、21 项保持；正文与另外 7 个文件保留 |

`complete` 表示探针结束，`observed` 表示得到了观察；例如网页插件未启用、注入右箭头未翻页也属于观察，不能计为目标功能通过。

## 书签

打开 `Sources/Note.md`，把光标放到 `## Section One` 后执行 `bookmarks:bookmark-current-heading`。原版弹出包含路径、标题、书签组的保存对话框。路径框显示 `Sources/Note#Section One`，标题留空时显示默认占位。保存文件数据如下：

```json
{"type":"file","ctime":1792743811103,"path":"Sources/Note.md","subpath":"#Section One"}
```

在 `Block target text. ^anchor-one` 中执行 `bookmarks:bookmark-current-section`，生成同样的 `type: "file"`，`subpath` 为 `#^anchor-one`，正文原有块 ID 保留。普通文件书签省略 `subpath`。

同时打开 Note 和 Other 后执行 `bookmarks:bookmark-all-tabs`，保存为 `Research tabs`。原版创建 `type: "group"`，包含 `title`、`ctime` 和两项 `items`，每项仍是文件书签。`.obsidian/bookmarks.json` 包含顶层 `items` 数组，文件/标题/块/组的数据均写回。

通过原 `fileManager.renameFile` 把 Note 改为 Renamed，顶层及组内文件书签的 `path` 都更新为 `Sources/Renamed.md`，`subpath` 保持。随后原 `openBookmark` 打开标题书签，活动文件正确，编辑器光标位于标题行 `{line:2,ch:0}`。

截图：[章节对话框](../research/windows-round2/screenshots/features02/bookmark-heading-dialog.png)、[文件/章节/块/组列表](../research/windows-round2/screenshots/features02/bookmark-groups.png)、[改名后标题定位](../research/windows-round2/screenshots/features02/bookmark-reopen-heading.png)。未采样新增块 ID、嵌套组拖放排序、删除后书签、搜索/URL 书签及重启恢复。

## 日记、模板与唯一笔记

通过实际 `daily-notes`、`daily-notes:goto-prev`、`daily-notes:goto-next`、`zk-prefixer` 命令执行。日期格式/模板/目录在原插件实例 options 中设置；没有验证设置页或重启后的 options 持久化。

| 输入/动作 | 原版结果 |
| --- | --- |
| `folder=Journal`、`format=YYYY-MM-DD` | 创建并打开 `Journal/2026-10-23.md` |
| 修改今日文件为 sentinel 后再次执行日记命令 | 打开同文件，sentinel 字节和 SHA-256 不变 |
| `format=YYYY/MM/[Day-]DD` | 自动创建 `Journal/2026/10/Day-23.md`；格式产生的子目录自动建立 |
| `folder=Journal/Missing/Deep` 不存在 | 拒绝创建并提示未找到文件夹；配置根目录与格式产生的子目录行为不同 |
| `{{title}}` | 使用完整格式值，如 `2026/10/Day-23`，不是 basename `Day-23` |
| `{{date}}`、`{{time}}` | 本次展开为 `2026-10-23`、`16:23` |
| `{{date:YYYY/MM/DD}}`、`{{time:HH:mm:ss}}` | 按指定格式展开；未知 `{{unknown}}` 原样保留 |
| 已存在 03-01、03-05、03-12 三份日记 | 从 03-05 上一篇到 03-01，再下一篇到 03-05、03-12；跳过缺日，不创建缺失日期 |
| 到最后一篇再下一篇 | 原文件不变，提示没有更新日记 |
| 唯一笔记格式 `YYYYMMDDHHmmss` | 按时间戳建文件并展开模板 |
| 当前 `16:24:04`，预占对应秒及邻近秒文件名 | 新建 `20261023162504.md`，此次碰撞把命名时间增加一分钟，原文件全部保留 |
| 上述碰撞后的模板 | title 为 `20261023162504`，自定义 time 仍为实际创建时间 `16:24:04` |
| 常量格式 `[collision]` 且同名文件已存在 | 连续两次拒绝创建并提示，不附加数字后缀 |
| 配置目录已存在，唯一笔记格式 `[Level/Note]` | 建立 `Level/Note.md`，title 为 `Level/Note` |

碰撞加一分钟是精确输入下的实测，不能推断所有日期格式、重试上限或跨日算法。截图：[完整模板展开](../research/windows-round2/screenshots/daily02/daily-expanded-template.png)、[已有日记导航](../research/windows-round2/screenshots/daily02/daily-navigation.png)、[常量格式碰撞](../research/windows-round2/screenshots/daily02/unique-collision.png)。模板截图中的旧“目录不存在”notice来自前一个独立场景，不表示当前模板文件生成失败。

## Markdown 格式转换器

原 `markdown-importer:open` 是**整个库的现有 Markdown 格式转换器**。界面有七个默认关闭的开关：Roam 标签、高亮、待办；Bear 高亮；zettelkasten UID 展开；UID 显示名美化；Frontmatter 迁移。界面明确说明会修改库中所有文件，并提示先备份；未出现文件导入选择器或逐文件预览。

选中 Roam/Bear 四项与 Frontmatter 后，合成输入实际写回：

| 输入 | 输出 |
| --- | --- |
| `#plain #[[multi word]] #parent/child` | `[[plain]] [[multi word]] [[parent/child]]` |
| `^^Roam^^ and ::Bear:: and ==Existing==` | `==Roam== and ==Bear== and ==Existing==` |
| `{{[[TODO]]}} task` | `[ ] task`，没有自动添加列表前缀 |
| `{{[[DONE]]}} finished` | `[x] finished` |
| 转义 `\#escaped`、行内代码中的 `#code` | 保留 |
| fenced code 中的 `#fenced ^^inside^^ ::inside::` | 同样转换为 `[[fenced]] ==inside== ==inside==` |
| 普通 Markdown 链接、已有标题 Wiki 链接 | 此输入中保留 |

当库内存在 `202001010101 Target title.md`：仅开启 UID 展开，把 `[[202001010101]]` 写为 `[[202001010101 Target title]]`；仅开启美化，写为 `[[202001010101 Target title|Target title]]`。已有 `|Alias`、已有 `#Heading`、未找到的 `[[999999999999]]` 在本次输入中保持原样。

Frontmatter 专项只启用第七项，43 个 Markdown 文件被处理，36 个独立 fixture 中 15 个发生转换，21 个保持。全部正文哨兵和另外 7 个文件保持。完整输入、输出及逐文件 SHA-256 见结构化记录 `frontmatter02`：

| 输入 | 原版实际处理 |
| --- | --- |
| tags/cssclasses 字符串 | 按逗号与空格拆数组 |
| aliases 字符串 | 仅按逗号拆，词间空格保留 |
| YAML 外围引号 | 不能阻止字符串值被拆分 |
| 字符串值内引号 | 当作普通字符，不把带引号的片段组合为一项 |
| 已有数组，包括重复项 | 原文完全保留 |
| null、数字、布尔值 | 原文完全保留 |
| 只有 tag/alias/cssclass 单数字段 | 转为复数字段并转换数组 |
| 单数与复数数组或 null 并存 | 原文保持，不合并、不删除单数字段 |

例如 `tags: one, two`、`alias: Name`、`cssclass: foo bar` 写回为 tags `[one,two]`、aliases `[Name]`、cssclasses `[foo,bar]` 的 YAML 多行数组。专项[开关截图](../research/windows-round2/screenshots/frontmatter02/frontmatter-only-options.png)与[完成截图](../research/windows-round2/screenshots/frontmatter02/frontmatter-conversion-complete.png)。未验证中途停止、撤销、文件写入失败或所有旧格式。

## 工作区、标签与窗口

| 动作 | 原版观察 |
| --- | --- |
| 固定 Start 后 `openLinkText(Note, ..., false)` | 固定标签保留，在同组新建未固定标签 |
| 未固定 Note 中打开 Other | 复用同一个 leaf |
| 未固定 Other 中打开已经固定的 Start | 本次把未固定 leaf 改为 Start；没有自动跳到已有固定标签，允许两个 Start |
| `getLeaf('split','vertical')` | 左右分栏 |
| `getLeaf('split','horizontal')` | 上下分栏，可嵌套 |
| 保存布局，关闭其它 leaf、取消固定、打开 Convert，再加载 | 恢复主布局树、固定状态、阅读模式、活动 leaf；main JSON 与 active leaf ID 相等 |
| 打开 popout 后保存布局 | 配置新增 `floating → window → tabs → leaf`，包含文件、x/y/width/height、maximize、zoom |
| 关闭 popout window2 后加载保存布局 | 创建新 window3，恢复 Other 正文；floating JSON、窗口几何与状态一致 |

原 `.obsidian/workspaces.json` 顶层为 `{workspaces:{name:layout},active:name}`。布局含 `main/left/right/left-ribbon/active/mtime`，有浮窗时含 `floating`。直接 `saveWorkspace(name)` 本次未改变 activeWorkspace；`loadWorkspace(name)` 后 activeWorkspace 设置为该名字。

截图：[嵌套分屏](../research/windows-round2/screenshots/workspace03/workspace-split-horizontal.png)、[命名布局恢复](../research/windows-round2/screenshots/workspace03/workspace-restored.png)、[弹出窗口恢复](../research/windows-round2/screenshots/workspace03/workspace-popout-restored.png)。本次是同进程内关闭/重建窗口；整应用重启、不同显示器/DPI、后台编辑同步与崩溃恢复仍未采样。

## 幻灯片与网页视图

合成 `Present.md` 用独立行 `---` 分成三节；`slides:start` 展示三页，初始第一页。点击原 `.navigate-right` 按钮后第二页成为 `present`，Escape 退出幻灯片。实验壳 `sendInputEvent Right` 没有换页，因此仅采纳按钮切页与 Escape，不把物理键盘左右导航计为通过。未采样围栏内分隔符、垂直幻灯片、演讲者备注或多屏全屏。

`webviewer` 虽在合成库启用清单中，启动后实际 `enabled=false`，没有网页命令。未强行改变产品/平台条件，没有实际网页导航结果；只能记录该环境中的可用性，网页页签、前进后退及生命周期仍待参考采样。

## 重现与后续验收

在已安装对应原版文件、独立 Electron 39.8.3 和 REA 6.7.0 的本机，从项目根目录执行；每个 tag 必须是此前不存在的新名字：

```powershell
node research/windows-round2/run.mjs example-features bookmarks-importer.js
node research/windows-round2/run.mjs example-daily daily.js
node research/windows-round2/run.mjs example-workspace workspace.js
node research/windows-round2/run.mjs example-frontmatter frontmatter.js
node research/windows-round2/summarize.mjs example-features example-daily example-workspace example-frontmatter
```

实验脚本没有复制原应用实现代码。独立程序后续应使用同一输入和动作检查行为；模型测试、真实 Windows UI 操作、重启与失败路径分别留证。参考观察本身不改变[兼容矩阵](parity.md)中独立实现的通过状态。
