# Windows 中文输入与重做快捷键验证

2026-10-23 在打包版 **VaultDesk 0.3.1** 中取得用户实体键盘中文输入、组合事件和文件落盘证据。提交后，自动键盘与界面操作完成 11 个成功检查点，验证撤销重做、模式切换及 A→B→A 文件切换。**0.3.2** 的追加改动仅补充重做快捷键别名；其自动验证与 0.3.1 的物理输入证据分别记录。

## 证据与版本

| 记录 | 版本与方法 | 可确认内容 |
| --- | --- | --- |
| [物理输入及提交后原始记录](../research/windows-ime-physical-verification.json) | 打包版 0.3.1；用户实体输入，随后单独进行 Playwright/CDP 键盘及界面操作 | 中文提交与保存；提交后的撤销重做、模式和文件切换 |
| [提交后原生窗口截图](images/windows-ime.png) | 0.3.1，中文已提交 | 窗口显示最终中文内容；没有候选窗口画面 |
| [重做别名浏览器记录](../research/windows-redo-alias-browser.json) | 0.3.2 对应源码；独立 Windows Chromium 加载实际 `Editor.jsx` | Ctrl+Shift+Z 与 Ctrl+Y、历史保留、文件隔离；22 个检查点 |
| [0.3.2 打包版快捷键记录](../research/windows-ime-patch-packaged.json) | 打包应用的 Playwright/CDP 键盘路线；仅自动输入 ASCII | 16/16 检查点、最终磁盘核对和产物身份；没有物理 IME 输入 |
| [原版快捷键静态记录](../research/windows-round3-hotkeys-static.json) | 原版 1.13.7 冻结 ASAR；只读源码检查 | 编辑器在标准历史快捷键之外追加 `Mod-Shift-z → redo` |

物理输入窗口加载 `release/VaultDesk-0.3.1-Windows-x64/resources/app/dist/index.html`，运行于 Windows、Electron 42.11.9 / Chromium 148.0.7778.280；`contentDOM.editContext` 未启用。输入前记录开始于 **11:31:43.650 UTC**，物理输入记录冻结于 **11:44:46.489 UTC**；提交后验证结束于 **11:56:48.553 UTC**。香港时间分别为同日 19:31、19:44 和 19:56。

原始 JSON 顶层 `events` / `detailed` 冻结物理输入阶段。`postInputEventArchive` 是后续取得的累计快照：333 条 `events` 的前 281 条与顶层冻结记录相同，后续增量为 52 条。物理输入统计只使用顶层冻结记录，不重复累计归档中的相同前缀，也不计入后续自动操作。物理阶段未调用自动 IME 合成或中文插入；日志也包含周期 F15 等事件，因此不声称该阶段完全没有自动按键。

## 0.3.1 物理输入结果

用户报告在该窗口使用实体键盘输入拼音并选择“中文”。冻结记录包含三次最终数据为“中文”的组合提交，另有一次数据为 `z` 的组合结束。预编辑记录可见 `z → zh → … → zhong'wen → 中文`，并包含后续普通字母输入。

| 事件 | 数量 | `isTrusted=true` |
| --- | ---: | ---: |
| `compositionstart` | 4 | 4 |
| `compositionupdate` | 29 | 29 |
| `compositionend` | 4 | 0 |
| `beforeinput` | 39 | 39 |
| `input` | 39 | 39 |

四个 `compositionend` 的 `isTrusted` 均为 **false，来源未确定**；本记录不将其归因于 CodeMirror，也不声称所有组合事件均可信。物理输入结论依据用户实体输入报告、该阶段无自动 IME/中文插入、完整预编辑进程以及编辑器和磁盘结果共同成立，不能只凭单个 `isTrusted` 字段判断。

冻结阶段全部事件指向 `IME-A.md` 的源码模式；详细记录始终属于同一个编辑器元素。源码模式的可见行拼接、应用文件读取及独立磁盘读取内容一致。`detailed.editorText` 为 DOM 文本，不能保留换行；实时预览也会隐藏 Markdown 标记，因此不使用其逐字比较源码。

A 最终内容（JSON 转义明确保留空格与末尾换行）：

```json
"# Physical IME A\n\n中文 \n中文\nzhongwen 中文\n"
```

B 保持基线内容：

```json
"# Physical IME B\n\nUntouched target.\n"
```

| 文件 | 最终 SHA-256 |
| --- | --- |
| `IME-A.md` | `3ea464e13217b0fd0882ceb64ada517a5cf0c422ea186676a567d2dd22f6cee7` |
| `IME-B.md` | `37856b4abe0c5bbb77d6c7ab6631bfd5540b3a2dfd2bd34caa1ad09cec460b29` |

截图 SHA-256 为 `130bc2c790110b29a3801dfe4bfc2361a5500bbb2e2621453ff70e3f1a37661c`。截图展示提交后的文字，没有记录系统候选窗口的视觉状态。

## 0.3.1 提交后的自动验证

以下 11 个成功检查点通过打包应用的 Playwright/CDP 键盘与界面路线执行，与用户物理输入阶段分开。每个成功检查点都保存应用文件读取及独立磁盘快照，B 始终保持基线内容和哈希。

| 检查点 | 数量 | 结果 |
| --- | ---: | --- |
| `renderer-undo-1` | 1 | Ctrl+Z 移除最后一个换行，保留末次“中文” |
| `renderer-undo-2` | 1 | Ctrl+Z 移除末次完整“中文”，末尾成为 `zhongwen `；没有退回拼音中间态 |
| `windows-redo-1` 至 `windows-redo-4` | 4 | Ctrl+Y 依次恢复前序文本组、空格、中文和末尾换行；最终 A 全文及哈希精确回到冻结记录 |
| 实时预览、阅读模式、源码模式 | 3 | 提交后的模式切换保持 A、B 文件内容和哈希 |
| A→B、B→A | 2 | 显示路径正确，两份文件内容和哈希保持不变 |

两次预期 Ctrl+Z 之后，测试驱动曾两次发送小写拼写 `Control+Shift+z`，实际继续执行了撤销，分别移除分隔空格和前序文本组。原始记录将其列为 `driver-key-experiment`，**不计入重做通过**；这两步仅保存编辑器行观察，没有独立磁盘快照。随后执行四次正确的 Windows Ctrl+Y，恢复上述四步撤销后的完整文档。

Windows 原生快捷键助手还曾因用户活动使观察失效而拒绝两次输入请求，未发送按键。原始记录保留 `native-shortcut-attempt-rejected-no-input`，不将其算作应用撤销失败，也不将后续 CDP 快捷键验证称为实体键盘快捷键验证。

## 0.3.2 重做别名追加验证

原版 1.13.7 的静态记录显示：标准历史键位包含 Windows Ctrl+Y，编辑器另追加 `Mod-Shift-z → redo`。0.3.2 的最小补丁在 `Editor.jsx` 导入现有 `redo` 命令并添加 `{key: 'Mod-Shift-z', run: redo, preventDefault: true}`，保留 Ctrl+Y。组合事件处理、文件绑定和保存逻辑未在此补丁中改动。

独立浏览器验证加载实际编辑器，平台为 `Win32`，通过真实键盘事件路线验证：

- 源码、实时预览均可用正确大写 `Control+Shift+Z` 和 Ctrl+Y 重做。
- 源码→实时预览→阅读→源码保留原有撤销重做历史。
- A→B→A 保留 A 的历史，B 的空历史不能撤销 A 的文字。
- 全程保持同一个 CodeMirror 实例；没有使用 `api.undo()` / `api.redo()` 代替快捷键证明。

浏览器记录包含 **22 个通过的检查点**，其中也包括准备、恢复和小写驱动实验；这不是 22 次独立物理输入测试。另运行 `editor-scroll`、`editor-api`、`editor-helpers` 的既有测试，**22/22 通过**。编辑器源码 SHA-256 为 `2bb775794e14f59ff850af8bca20989de6c074c0a86b1b8b96547e307cf528fe`。

驱动差异独立复现：`Control+Shift+Z` 产生 `key="Z"`、`shiftKey=true`，触发新增重做别名；小写 `Control+Shift+z` 产生 `key="z"`、`shiftKey=true`，当前 CM 的字符匹配先命中 Ctrl+Z，继续撤销。后一实验不能推导实体 Windows Ctrl+Shift+Z 的行为。

### 打包版复测

2026-10-23 **12:04:19.254 UTC（香港时间 20:04）**，在实际 `release/VaultDesk-0.3.2-Windows-x64/resources/app/dist/index.html` 上完成 **16/16 检查点**，控制台错误与警告均为 0。测试通过 Playwright/CDP 发送键盘事件，仅插入 ASCII `SOURCE` / `LIVE`，没有调用直接撤销重做 API。

源码和实时预览都通过正确大写 Ctrl+Shift+Z 与 Ctrl+Y 重做；两模式间保留内容，阅读→源码往返保持内容；切到 B 后，B 的空历史不能撤销 A 的文字，返回 A 仍保留重做结果。打包版这 16 项没有在实时预览中撤销此前源码模式的输入，跨模式旧历史保留由上方 22 项源码浏览器记录单独支持。最终独立磁盘读取确认 A 为 `Undo baseline SOURCE LIVE`，B 为 `B untouched`。这 **16 个自动快捷键及界面检查点不属于原生 IME 测试**。

| 产物 | 身份 |
| --- | --- |
| 实际加载 bundle | `resources/app/dist/assets/index-BObaJjHD.js` |
| bundle SHA-256 | `48a2ed36290bc93419e23c78c572eca529e52d843674848248676e0efce316d9` |
| `Editor.jsx` SHA-256 | `2bb775794e14f59ff850af8bca20989de6c074c0a86b1b8b96547e307cf528fe` |
| 最终 A 磁盘 SHA-256 | `3f41f42bdcca2d293d4c20561b5425e6a3fbfe9e32e7056cd462b73b0dd434de` |
| 最终 B 磁盘 SHA-256 | `7192f0b805f5201e7e51792dc568ca6342af2509e4f6cd24059f9a05c2c18532` |

与 0.3.1 冻结记录的 54 个产品源码文件逐项比对，仅 `app/Editor.jsx` 发生变化。0.3.2 再次启用 `VAULTDESK_CLOUD_INTEGRATION=1` 运行 Node 全套，**309/309 通过、零失败、零跳过**，包括实际自建云服务的同步集成测试；[测试日志](../output/windows-ime-patch-tests.log)及[构建日志](../output/windows-ime-patch-build.log)的哈希均保存于打包记录。自动测试数量与 UI 检查点分别统计，不相加为原生验收总数。

打包记录另保留两次初始驱动等待错误：异步轮询条件使断言早于 650ms 自动保存，最终驱动改为明确等待磁盘读取后完成核对。这些驱动尝试不作为应用失败或通过证据。

**物理中文输入仍只由 0.3.1 记录支持。** 0.3.2 打包记录明确标记 `physicalImeTestedOnThisVersion=false`；旧物理报告及其哈希不因最小补丁、自动测试或打包版快捷键通过而外推至新版本。

## 尚未覆盖

本轮没有观察系统候选窗口的视觉状态，没有验证候选取消、组合仍进行时切换文件或模式，也没有覆盖其他输入法、全部候选操作或长时间连续输入。已完成的模式与文件切换均发生在中文提交之后。
