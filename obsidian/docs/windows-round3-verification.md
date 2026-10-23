# Windows 第三轮实际验收

日期：2026-10-23。分支：`feature/obsidian-selfhosted`。交付版本：VaultDesk 0.3.1 开发预览。独立客户端运行时为 Electron 42.11.9；参考核心为 Obsidian 1.13.7、Electron 39.8.3。所有检查使用合成知识库、隔离 profile 和本机服务，不使用个人笔记或原版云账号。

**本轮补齐了插件、编辑器状态和递归布局的有限兼容范围，完整 Obsidian 兼容目标仍未达成。后续 E4 已取得 0.3.1 实体中文输入及提交后恢复证据；系统候选窗、组合中切页与取消候选仍待验。**

[脱敏汇总、产物身份与源码哈希](../research/windows-round3-verification.json)记录本轮冻结结果及证据来源。下文 E4 为后续补充，保留第三轮 0.3.1 产物、309/309 测试及原哈希，不修改该冻结汇总。

## 可复核结果

| 层面 | 实际结果 | 证据与边界 |
| --- | --- | --- |
| REA 原版行为 | 6 组采纳运行、44 份观察，含编辑、数据、渲染、布局及非原生组合事件 | [参考报告](windows-round3-reference.md)，不把合成 composition 当成 Windows 输入法 |
| 同脚本插件对照 | 原版与独立客户端均完成 10/10 场景、29/29 明确断言；manifest/main SHA 相同 | [原版方法与身份](windows-round3-wrapper-reference.md)、[原生导入及执行](windows-round3-plugin-ui-verification.md)。原版由 REA 控制真实插件/命令注册器；独立客户端通过导入界面、显式启用和命令面板执行。相同断言通过不表示全部输出逐字段一致 |
| 插件布局状态 | 命名保存捕获视图的实时数值 2；界面改为 3 后恢复回 2；公开布局往返保留自定义类型及含 `file` 的 payload | [原生追加记录](../research/windows-round3-plugin-layout-http-ui.json)；合成插件，不代表社区插件生态兼容 |
| 插件 HTTP | 实际桌面 CSP、preload/IPC 与本机 HTTP 服务：Promise 的 text/json/ArrayBuffer、request 文本、HTTP 错误两种处理，共 4/4 检查；控制台零错误零警告 | [追加记录](../research/windows-round3-plugin-layout-http-ui.json)。不含生产网络、代理、证书或全部平台 HTTP 行为 |
| 递归工作区 | 真实 0.3.1 便携程序 8 项通过：混合分屏、比例/侧栏、固定标签、各标签三模式、光标/滚动、命名布局、空窗格及正常重启 | [完整范围与复验方法](windows-round3-layout-verification.md)。源码像素/字符位置不等于原版的全部内部字段或跨 DPI 兼容 |
| 编辑器恢复 | 同文件显式恢复保留撤销历史；恢复等待 CM 测量；阅读模式保留隐藏源码滚动 | [编辑器记录](editor-ui-verification.md)。浏览器/CDP 组合输入证明事件安全子集，不能证明系统候选窗 |
| Frontmatter 差分 | 12 个冻结输入：接受/拒绝一致 11/12、字节一致 8/12；双方接受的 9 项语义一致 8/9；当前正文保留 12/12 | [逐项差异](windows-round3-differential.md)。保留注释、CRLF、BOM 和拒绝数组是明确记录的差异 |
| 全套 Node | 启用真实云集成：309/309 通过、零跳过 | `output/windows-round3-tests.log`，包括冻结链接语料与负控、实际 HTTP、编辑/视图生命周期及布局等；模型、模拟对象和原生 UI 的证据分别列示 |
| 自有云 API | pytest：19 passed、23 subtests passed；1 个上游 TestClient 弃用提示 | `output/windows-round3-cloud-tests.log`、[服务实现与部署](../cloud/README.md)。本轮不改变云后端，仍使用自己的账号、同步和发布服务 |

## 本轮修复

插件 Editor 门面绑定具体文档和窗格，支持公开位置、选区、事务、撤销及编辑命令；只读、切页和组合输入期间拒绝不合时宜的写入。自定义视图连接真实标签和分屏，按 onOpen → setState 顺序初始化，串行应用异步状态，停用后保留类型/状态占位并清除工具栏资源。Markdown 处理器连接阅读界面与程序化渲染，支持排序、section 信息及子组件卸载。文件 API 增加二进制和串行 Frontmatter 更新；HTTP 通过受限大小/超时的宿主能力执行。

布局从平面窗格列表迁移为递归 split/tabs 模型，跟随原版 `vertical` 左右、`horizontal` 上下的方向约定。保存布局等待写盘成功后才显示成功；同窗格同文件恢复有单独触发信号。跨窗格移动保留插件视图的 payload 和 leaf 身份。编辑器滚动在测量稳定后恢复，源码与阅读滚动各自保留。

## 仍待验收和未实现范围

早期自动化按键只产生普通 `insertText`，当时没有取得有效的系统输入法组合证据。后续用户已在同一 0.3.1 包内完成实体键盘中文输入，有限结果见下文 E4。系统候选窗没有实际截到，组合进行中切页、取消候选仍未验；4 个非 trusted `compositionend` 的来源也未确定。不能把 CDP `imeSetComposition`、DOM 合成事件或直接填入中文当成物理输入。

完整插件 API/第三方社区插件、Node/Electron 模块、CodeMirror 扩展、全部 Live Preview 细节、插件主题生态、任意窗口/DPI/异常恢复、全部 Canvas/Bases 行为，以及生产网络、E2EE、共享权限和完整发布功能仍有缺口。macOS/Linux/mobile 未做本轮平台验收。完整拆分见 [兼容矩阵](parity.md)；插件边界见 [API 范围](plugin-compatibility.md)。

## E4：0.3.1 物理中文输入补充

[原始记录](../research/windows-ime-physical-verification.json)的输入阶段采集于 `2026-10-23T11:44:46.489Z`，实际页面来自 0.3.1 包的 `resources/app/dist/index.html`。用户在实体键盘输入中文；该阶段没有注入中文文本，也没有调用 CDP composition，记录的 `syntheticImeCallsThisPhase` 为 0。原 `events` / `detailed` 保留输入证据，后续界面动作另记在 `actions`；详细方法见 [Windows IME 验收记录](windows-ime-verification.md)。

观察到 4 个 `isTrusted:true` 的 `compositionstart`、29 个 trusted `compositionupdate`，以及各 39 个 trusted `beforeinput` 和 `input`（其中 input 为 29 个 `insertCompositionText`、10 个 `insertText`）。4 个 `compositionend` 均为 `isTrusted:false`，来源未知；不能把它们描述成原生可信结束事件。没有实际截到系统候选窗，因此这份记录证明实体中文输入、观察到的事件和写盘子集，不证明完整候选操作流程。

提交后通过打包程序的 Playwright/CDP 键盘与控件路径执行两次 Ctrl+Z，之后两次小写 `Control+Shift+z` 实验均继续撤销，未触发预期 redo。后两次实验只保留当时 UI 行，没有独立磁盘快照，不计为 redo 通过。随后四次 Ctrl+Y 逐步恢复完整文档，最终编辑器全文与独立磁盘读取回到提交基线，A 文件 SHA-256 为 `3ea464e13217b0fd0882ceb64ada517a5cf0c422ea186676a567d2dd22f6cee7`。不能把这写成“两次 undo 恰由四次 redo 对称还原”，也不推断每次 IME 提交必为单个撤销项。原生 Windows 助手另拒绝两次过期观察下的快捷键尝试，均未送出输入；`actions` 保留其中一条 `actionSucceeded:false` 快照，不计为通过，也不是应用撤销失败。

恢复后再通过实时预览、阅读、源码三模式，以及切到 `IME-B.md` 再回到 `IME-A.md`，五个检查点的 A/B 磁盘摘要均未改变；B 的 SHA-256 始终为 `37856b4abe0c5bbb77d6c7ab6631bfd5540b3a2dfd2bd34caa1ad09cec460b29`。两次 Ctrl+Z、四次 Ctrl+Y 和这五次模式/切页操作共 11 个成功检查点，每个均有独立磁盘读取。后续归档完成于 `2026-10-23T11:56:48.553Z`；`postInputEventArchive` 含原输入流前缀，不能与冻结的 `events` / `detailed` 相加计数。这些操作发生在中文提交后，不能扩写为“组合进行中切页通过”；后续键盘与控件由自动化驱动，也不能称为全程用户物理操作。

[原版 redo 静态记录](../research/windows-round3-hotkeys-static.json)只读提取冻结原 ASAR：historyKeymap 含 `Mod-y`，编辑器另追加 `Mod-Shift-z → redo`；该次未启动原版或执行实际按键验证。独立编辑器后续 0.3.2 最小新增该 redo 别名，打包回归见下文；物理中文输入证据仍只属于 0.3.1。

## E5：0.3.2 redo 补丁回归

[0.3.2 独立打包报告](../research/windows-ime-patch-packaged.json)记录 `2026-10-23T12:04:19.254Z` 的 **16/16** 键盘检查，控制台 0 错误/0 警告。检查在实际打包程序中通过 Playwright/CDP 发送按键，验证源码和实时预览的 Ctrl+Shift+Z、Ctrl+Y 重做，以及三模式内容保留、B 文件不能撤销 A、回到 A 保留重做结果；最终 A/B 均有独立磁盘读回。输入仅为 ASCII `SOURCE/LIVE`，没有直接调用 undo/redo API，**未在 0.3.2 复验物理中文 IME**。

与冻结的 54 份产品源码相比，补丁只改变 `app/Editor.jsx` 的显式 `Mod-Shift-z → redo` 绑定。0.3.2 主 bundle 为 `index-BObaJjHD.js`，SHA-256 为 `48a2ed36290bc93419e23c78c572eca529e52d843674848248676e0efce316d9`；产物与源码身份保存在独立补丁报告。该源码另以 `VAULTDESK_CLOUD_INTEGRATION=1 node --test --test-concurrency=8 tests/*.test.mjs` 重跑全套，结果 **309/309 通过、零失败/零跳过**，见 [本次 Node 日志](../output/windows-ime-patch-tests.log)。这次补丁回归与第三轮原有 0.3.1 的 309/309 分别保留，不能合并计数，也不替代 U3/L3 等旧产物专项验收。

## Windows 便携包

当前追加补丁目录为 `release/VaultDesk-0.3.2-Windows-x64/`，压缩包为同级 `VaultDesk-0.3.2-Windows-x64.zip`，校验值另存 `.zip.sha256`。0.3.2 的实际验收范围为上文 E5；下述 0.3.1 产物与第三轮专项记录作为历史基线保留。

目标目录为 `release/VaultDesk-0.3.1-Windows-x64/`，完整目录双击 `VaultDesk.exe` 运行，无需本机 Node.js。云服务源码与启动脚本随包附带，使用云功能另需 Python。最终打包程序已从该目录四次启动并正常退出，8 项布局检查全部通过，32 次工作区写入全部成功，退出后磁盘核对通过。原生插件同脚本、HTTP 和视图复制/重载验收也直接使用此包；相关报告记录实际 `resources/app/dist` 页面地址。程序仍为未签名开发预览。

最终主 bundle 为 `index-CWnBlYx-.js`，SHA-256 为 `d47b19986bd14bace1441fce3267eec7c3230d813e6d6de263b482801167277d`。ZIP 位于同级 `release/VaultDesk-0.3.1-Windows-x64.zip`，文件校验值另存 `.zip.sha256`；包内 `integrity.json` 和 `package-manifest.json` 描述全部文件。0.3.0 候选产物与此前版本另行保留。

自定义视图复制实测：当前数值 3 被复制为两个独立视图，新副本改为 4 时原视图仍为 3；保存后重新载入渲染进程并显式启用插件，原 ID/payload 与 3/4 数值恢复。见 [结构化记录](../research/windows-round3-plugin-clone-cold-ui.json)。此项是渲染进程重载；不得扩写为自定义插件的全进程故障恢复。
