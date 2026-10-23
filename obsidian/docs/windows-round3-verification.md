# Windows 第三轮实际验收

日期：2026-10-23。分支：`feature/obsidian-selfhosted`。交付版本：VaultDesk 0.3.1 开发预览。独立客户端运行时为 Electron 42.11.9；参考核心为 Obsidian 1.13.7、Electron 39.8.3。所有检查使用合成知识库、隔离 profile 和本机服务，不使用个人笔记或原版云账号。

**本轮补齐了插件、编辑器状态和递归布局的有限兼容范围，完整 Obsidian 兼容目标仍未达成。Windows 实体键盘 IME 候选验收仍待完成。**

[脱敏汇总、产物身份与源码哈希](../research/windows-round3-verification.json)记录本轮结果及证据来源。

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

安装了中文拼音并由用户确认切换输入模式后，自动化按键仍只产生普通 `insertText`，没有取得系统级 composition/candidate 序列。已请求实体键盘输入；截至本记录尚未收到完成回复，隔离测试笔记中未观测到中文组合事件。不能把 CDP `imeSetComposition`、DOM 合成事件或直接填入中文算作原生 IME 通过。

完整插件 API/第三方社区插件、Node/Electron 模块、CodeMirror 扩展、全部 Live Preview 细节、插件主题生态、任意窗口/DPI/异常恢复、全部 Canvas/Bases 行为，以及生产网络、E2EE、共享权限和完整发布功能仍有缺口。macOS/Linux/mobile 未做本轮平台验收。完整拆分见 [兼容矩阵](parity.md)；插件边界见 [API 范围](plugin-compatibility.md)。

## Windows 便携包

目标目录为 `release/VaultDesk-0.3.1-Windows-x64/`，完整目录双击 `VaultDesk.exe` 运行，无需本机 Node.js。云服务源码与启动脚本随包附带，使用云功能另需 Python。最终打包程序已从该目录四次启动并正常退出，8 项布局检查全部通过，32 次工作区写入全部成功，退出后磁盘核对通过。原生插件同脚本、HTTP 和视图复制/重载验收也直接使用此包；相关报告记录实际 `resources/app/dist` 页面地址。程序仍为未签名开发预览。

最终主 bundle 为 `index-CWnBlYx-.js`，SHA-256 为 `d47b19986bd14bace1441fce3267eec7c3230d813e6d6de263b482801167277d`。ZIP 位于同级 `release/VaultDesk-0.3.1-Windows-x64.zip`，文件校验值另存 `.zip.sha256`；包内 `integrity.json` 和 `package-manifest.json` 描述全部文件。0.3.0 候选产物与此前版本另行保留。

自定义视图复制实测：当前数值 3 被复制为两个独立视图，新副本改为 4 时原视图仍为 3；保存后重新载入渲染进程并显式启用插件，原 ID/payload 与 3/4 数值恢复。见 [结构化记录](../research/windows-round3-plugin-clone-cold-ui.json)。此项是渲染进程重载；不得扩写为自定义插件的全进程故障恢复。
