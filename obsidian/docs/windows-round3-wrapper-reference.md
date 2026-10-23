# Windows R3：相同插件包装的原版运行

已在隔离的原版 **Obsidian 1.13.7 / Electron 39.8.3 / Windows** 中实际加载交付的 `public-api-probe` manifest/main，执行命令 01–05。**case 通过 10/10，断言通过 29/29；fail 0 / unsupported 0 / error 0**。这是原版侧结果，尚不能代替独立客户端的原生结果。

运行 `wrapper01`，时间 2026-10-23T10:41:17.930Z。REA：`ev_95c10e8ca14c9116bfb642802dedf8d420c3326fa5b256c16fdb0c89aa5a0bb2`。原观察报告 SHA-256：`beb041aecf2c8f61269cf4df2dbe58a355f359febb64ffa9f13fdca8f3b8558d`。完整结果及两个阶段的插件报告见 [JSON](../research/windows-round3-wrapper-reference.json)。

## 精确源码身份

- [manifest.json](../research/windows-round3/fixtures/public-api-probe/manifest.json)：`65e8d9c7c62b42d23cb2c1e302aa6fa7ce1e26727d9fc3b9c541c919117af1bd`
- [main.js](../research/windows-round3/fixtures/public-api-probe/main.js)：`7ef160da80a8005428d88eafdc20dbe0ee29dc7c7c065a91d448334c131f166d`

复制到原版合成库中的文件与上述交付文件逐字一致，运行后两边哈希仍一致。后续独立客户端导入必须核对这两个哈希，才能称为同脚本比较；修改包装后不能沿用本次结果。README 的说明不参与运行时源码身份。

## 执行路径与隔离

启动器只载入哈希固定的原始 ASAR，创建独立 profile/session 与合成库。探针先核对实际库路径，再把冻结 manifest/main 写入该库的插件目录，通过**原版插件管理器**开启并加载插件，通过**原版命令注册器**执行命令，不直接调用包装内部测试函数。读取原版 `data.json` 与插件 Modal 中的 JSON，并另观察实际 DOM、文件字节和卸载状态。

REA 操作本机控制页；捕获的 DOM/accessibility 包含原版报告哈希。它不是 REA 直接点击 Electron，也不是物理命令面板手势验收。原窗口仅短暂 showInactive 后截图，不取得前台焦点。没有载入真实用户库、账号或凭据；远程 Electron/Node 网络、系统协议注册和外部 URL 启动均被实验壳拦截，该拦截不是操作系统沙箱。原版与 REA 都退出 0，原核心 SHA-256 未变，host 异常 0。

## 结果

| Case | 结果 | 范围 |
| --- | --- | --- |
| editor:prepare-marked-note | pass | 专用 marker 笔记创建并打开源码模式 |
| editor:transaction-undo-redo | pass | 两处改前坐标变更、一次 undo 与 redo |
| view:split-state-and-detach | pass | 原生 tab/vertical split，自定义 view 的 open/state 顺序与单叶 detach |
| resources:ribbon-status-click-remove | pass | 控件挂载、程序 click 回调、手动 remove |
| render:native-reading-context | pass | 原生阅读视图 postprocessor 顺序、完整 section.text、代码块末尾换行 |
| render:programmatic-component-lifecycle | pass | MarkdownRenderer、section=null、Component.unload 清理孩子 |
| frontmatter:update | pass | mutable callback、count 更新与正文 marker 保留 |
| frontmatter:throw-does-not-write | pass | callback 抛错且原文件不变 |
| frontmatter:concurrent-counter | pass | 两个 callback 读到 0/1，最终 count=2 |
| binary:arraybuffer-roundtrip-modify-append | pass | 包含 0/128/255 的 ArrayBuffer 创建、读取、修改、追加 |

禁用由实验驱动器在插件外部执行。原版插件实例随后不存在；剩余自定义 leaf 保留原 ID、type 与 `value: two` state，显示失效插件占位。主 ribbon 数量从 1 到 0，status 从 1 到 0。这项外部观察与插件 `onunload` 自报日志分开，不把保存卸载日志等同全部资源清理。

已视觉检查：[自定义分屏](../research/windows-round3/screenshots/wrapper01/exact-wrapper-custom-split.png)、[实际 Markdown 处理结果](../research/windows-round3/screenshots/wrapper01/exact-wrapper-rendered-note.png)、[禁用后的占位](../research/windows-round3/screenshots/wrapper01/exact-wrapper-disabled-placeholder.png)。其余截图和哈希在 JSON 中，共 7 张。

## 比较边界与重现

这份包装的原版运行不取代较早 R3 的 12 份 Frontmatter 边界差分；本包装只含三个最小 Frontmatter 操作。不同主机的时间、叶节点 ID、UI 标题不能按原始 JSON 字节比较。后续对照应逐 case 检查语义、断言、适用的文件字节，以及外部禁用观察，不把 10/10 外推完整 Plugin API、社区插件、原生 IME 或任意布局。

```powershell
node research/windows-round3/run.mjs wrapper-next public-api-wrapper.js
node research/windows-round3/summarize-wrapper.mjs wrapper-next
```

运行标签必须全新；重现仍要求本机固定原核心、实验 Electron 和 REA 6.7.0 可用。本次未修改产品代码、原版核心或兼容矩阵。
