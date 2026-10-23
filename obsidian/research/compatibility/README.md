# 独立笔记应用兼容用例

参考样本：Obsidian 核心发行包 1.13.7，Windows，同版 Electron 39.8.3 开发宿主。20 组、34 个解析查询、10 个变更场景；来自三次完整独立配置运行。这里没有新应用实现，现有通过结果仅说明参考运行结果满足冻结规格。

- `cases.json`：实际执行的声明式输入。
- `oracle.json`：从重复运行冻结的期望值与不稳定候选集合。
- `adapter.d.ts`：新应用适配器的最小输出类型。
- `conformance.mjs`：无第三方依赖的 Node.js 比较器。
- `run-adapter.mjs`：加载独立应用的本地适配器，运行并比较。
- `negative-controls.mjs`：故意引入根匹配错误、目标漂移、设置错误和缺失用例，验证比较器会拒绝。

运行现有参考结果：

```powershell
node .\compatibility\conformance.mjs .\runtime-evidence\run09\observations.json
node .\compatibility\negative-controls.mjs
```

新应用导出 `async runSuite(corpus)`，然后运行：

```powershell
node .\compatibility\run-adapter.mjs C:\YourApp\compat-adapter.mjs strict-reference C:\YourApp\actual.json
```

适配器执行顺序与归一化约定：

1. 在全新临时库中，将 corpus 所有组的 `files` 合并写入一次，保留输入顺序；初始设置为 `alwaysUpdateLinks=true`、`newLinkFormat=shortest`、`useMarkdownLinks=false`。本轮参考数据的并列选择仍有冷启动差异，不能依赖写入顺序。
2. 解析完成后，按顺序运行 resolution 查询，输入 `linkpath` 已与 `#subpath`、显示文本分离。返回规范化的库内目标路径或 null；可选的全部候选顺序仅作诊断。
3. 对 renames 按声明顺序合并设置，再执行动作。`storage` 对应纯文件移动；`managed` 对应有改链语义的重命名用例。提示的 decision 是抽象决策，无需复刻中文按钮文字。
4. 每组最终快照只包括该组命名空间内的文件，文件集、原文和引用解析结果均参与断言；不返回 `.obsidian` 或新应用自身配置文件。引用按源码位置顺序返回：普通 links，然后 embeds，再 frontmatter；每组分别保持源码顺序。
5. settings 返回三项归一化语义值。`settle.status=stable-observed` 表示已观测到与索引一致的稳定快照，不要求新应用使用 Obsidian 私有事件或内部队列。
6. 归一化 `Reference.original` 的缺省值为 null，frontmatter 的链接路径来自属性值；不比较内部对象、耗时、绝对路径、进程 ID、事件的全序或 UI 文案。

`strict-reference` 包含已观察到的前缀/后缀匹配特例；`portable-core` 排除 L01-prefix 和 L04-suffix，其余断言相同。后者不代表完整 Obsidian 兼容。L06/L07 等长候选只校验属于观测到的有效候选集合，并报告 diagnostic，不要求随机或不稳定排序。

比较器允许两个合法并列结果，但对遗漏查询、错误目标、文件内容、引用元数据、改链设置和提示是否出现仍会报错。它检验当前有限语料，不证明全面兼容。

复现实验使用 `runtime-tests/prepare.mjs` 和 `runtime-tests/run-browser.mjs`，需要本地 Electron 39.8.3 开发运行时、Chrome，以及 REA 6.7.0 缓存。每次使用新 run tag。REA 直接驱动的是实验控制页；控制页触发真实 Obsidian API 探针，浏览器结果保留报告 SHA-256。原应用 UI 并非由 REA 主动场景直接控制，详见《运行时兼容规格》的证据边界。
