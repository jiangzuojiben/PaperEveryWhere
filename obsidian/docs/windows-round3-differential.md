# Windows R3 processFrontMatter 独立差分

以原版 R3 的 **12 份冻结输入及同一 callback** 调用当前 `transformFrontmatter`：接受/拒绝一致 **11/12**，输出字节一致 **8/12**；两边均接受的 9 项中，YAML 值与正文一致 **8/9**。另计双方同样拒绝且输入不变的情形，结果语义一致 **10/12**。这些是纯函数结果，不是插件 UI 通过或完整 API 等价。

独立实现正文保留 12/12，原版 11/12；差异来自原版 BOM 样本增加了第二块 Frontmatter。5 项在输出或接受结果上不同，逐项列在下方。正文保留只指剥离开头一块 Frontmatter 后的字符串保持一致，不代表所有 Markdown 格式语义正确。

运行时间：2026-10-23T10:26:09.882Z。被测 [plugin-files.mjs](../app/plugin-files.mjs) SHA-256：`eab1675dfe4f14a990ab17b8e4b24f19e3820e90a79c8ac7e012ab8bdb47024c`；执行前后相同。参考 REA：`ev_67753f60ec5be8252115093b5bc4465f766580061be17b416474f5f1c906d49e`，原观察报告 SHA-256：`496c4de0e89d59328a1e39da00513ecfe548bd61d6af2e926f862cc6eb16dfc3`。输入及原版结果来自 [R3 参考汇总](../research/windows-round3-reference.json)，本次全部结果与 callback 输入见 [差分 JSON](../research/windows-round3-differential.json)。产品文件修改后必须重跑。

## 逐项结果

| 合成场景 | 接受/拒绝 | 输出字节 | 两边接受时 YAML 值与正文 | 当前正文保留 |
| --- | --- | --- | --- | --- |
| existing-comments | 一致 | 不同 | 一致 | 是 |
| crlf-bom | 一致 | 不同 | 不同 | 是 |
| crlf | 一致 | 不同 | 一致 | 是 |
| no-frontmatter | 一致 | 一致 | 一致 | 是 |
| empty-frontmatter | 一致 | 一致 | 一致 | 是 |
| null-frontmatter | 一致 | 一致 | 一致 | 是 |
| array-frontmatter | 不同 | 一致 | 不适用（至少一边拒绝） | 是 |
| invalid-yaml | 一致 | 一致 | 不适用（至少一边拒绝） | 是 |
| callback-throws | 一致 | 一致 | 不适用（至少一边拒绝） | 是 |
| noop-comments | 一致 | 不同 | 一致 | 是 |
| remove-all | 一致 | 一致 | 一致 | 是 |
| callback-return-ignored | 一致 | 一致 | 一致 | 是 |

## 已观察差异

- **existing-comments**：独立实现保留注释及未修改节点；原版重新序列化并丢掉注释。
- **crlf-bom**：独立实现识别并保留开头 BOM，更新现有 YAML；原版在 BOM 与旧内容之前追加另一块 YAML，callback 也因此收到空对象。
- **crlf**：独立实现使新 YAML 保持 CRLF；原版新 YAML 使用 LF，而围栏及正文仍为 CRLF。
- **array-frontmatter**：独立实现拒绝非 mapping YAML，callback 未运行且输入不变；原版 callback 收到数组，新增命名属性未序列化。
- **noop-comments**：独立实现对无改值 callback 保留原字节；原版仍重新序列化并移除注释。

独立实现还把 callback 的 mapping 复制为无原型对象；原版普通 mapping 的 prototype 为 Object。双方实际调用 callback 的 10 项里，JSON 输入值一致 9/10（BOM 场景不同）。全部 12 条观察把未调用记为 null，有 10/12 条输入记录一致；数组场景只有原版调用。这些数量不表示 prototype 等价。注释、CRLF、BOM 的保留及拒绝非 mapping 是当前实现的明确取舍，不能报告为与原版所有字节相同。

`invalid-yaml` 与 `callback-throws` 在双方都拒绝且输入不变；没有比较异常名称或文案。`array-frontmatter` 的输出字节虽然相同，但原版运行 callback，独立实现提前拒绝，因此不能据字节相等判为兼容。

## 验证范围与重现

本轮只运行 helper，不调用 renderer、插件导入、Vault bridge 或实际文件写入，也不证明并发串行、公开异步方法的 undefined 返回值、元数据事件、撤销或故障恢复。12 个原版观察包含上述边界；其余 API 仍由实际客户端中的导入插件和专项测试验证。错误路径保留输入，是差分 runner 的文件边界模型，并非本轮观察到独立客户端写盘。

`transformFrontmatter` 返回更新文本；原版 `processFrontMatter` 返回 Promise<void>，二者并非同一层接口。本轮仅比较由相同输入及 callback 产生的候选文件结果。

```powershell
node research/windows-round3/differential.mjs
```
