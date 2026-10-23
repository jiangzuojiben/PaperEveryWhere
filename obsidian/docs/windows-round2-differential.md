# Windows R2 Frontmatter 独立差分

以 R2 原版的 36 份冻结输入逐一调用 `convertMarkdownFormat(input, { frontmatter: true })`：**字节一致 36/36，语义一致 36/36，差异 0 项，异常 0 项**。正文保留 36/36。

运行时间：2026-10-23T08:50:14.229Z。被测 [windows-extras.mjs](../core/windows-extras.mjs) SHA-256：`7d4615f2eee8702e1f58634affd2c04f0ea816c76e77dafc7ad3453ab1d260d0`；执行前后哈希相同。后续代码更改需要重跑，不能沿用该结果。

参考 REA：`ev_888afa10f50ab43a05f865476cb3e8aedd25ec9a191a04dedec7c34f14aa31e4`；原观察报告 SHA-256：`93c9eb995e8b80493bba743fb348605c61eaf3383cc5daafa403d0d2b332bf52`。原版输入及输出来自 [R2 汇总](../research/windows-round2-reference.json)，完整本次结果见 [差分 JSON](../research/windows-round2-differential.json)。

## 逐项结果

| ID | 合成场景 | 字节 | YAML 值与正文 |
| --- | --- | --- | --- |
| 01 | tags-comma-string | 一致 | 一致 |
| 02 | tags-space-string | 一致 | 一致 |
| 03 | tags-yaml-quoted-delimiters | 一致 | 一致 |
| 04 | tags-embedded-quotes | 一致 | 一致 |
| 05 | tags-existing-array | 一致 | 一致 |
| 06 | tags-duplicate-array | 一致 | 一致 |
| 07 | tags-null | 一致 | 一致 |
| 08 | tags-number | 一致 | 一致 |
| 09 | tags-boolean | 一致 | 一致 |
| 10 | aliases-comma-string | 一致 | 一致 |
| 11 | aliases-space-string | 一致 | 一致 |
| 12 | aliases-yaml-quoted-delimiters | 一致 | 一致 |
| 13 | aliases-embedded-quotes | 一致 | 一致 |
| 14 | aliases-existing-array | 一致 | 一致 |
| 15 | aliases-duplicate-array | 一致 | 一致 |
| 16 | aliases-null | 一致 | 一致 |
| 17 | aliases-number | 一致 | 一致 |
| 18 | aliases-boolean | 一致 | 一致 |
| 19 | cssclasses-comma-string | 一致 | 一致 |
| 20 | cssclasses-space-string | 一致 | 一致 |
| 21 | cssclasses-yaml-quoted-delimiters | 一致 | 一致 |
| 22 | cssclasses-embedded-quotes | 一致 | 一致 |
| 23 | cssclasses-existing-array | 一致 | 一致 |
| 24 | cssclasses-duplicate-array | 一致 | 一致 |
| 25 | cssclasses-null | 一致 | 一致 |
| 26 | cssclasses-number | 一致 | 一致 |
| 27 | cssclasses-boolean | 一致 | 一致 |
| 28 | tag-only | 一致 | 一致 |
| 29 | tag-plural-conflict | 一致 | 一致 |
| 30 | tag-null-plural | 一致 | 一致 |
| 31 | alias-only | 一致 | 一致 |
| 32 | alias-plural-conflict | 一致 | 一致 |
| 33 | alias-null-plural | 一致 | 一致 |
| 34 | cssclass-only | 一致 | 一致 |
| 35 | cssclass-plural-conflict | 一致 | 一致 |
| 36 | cssclass-null-plural | 一致 | 一致 |

## 差异原文

本次 36 项无差异。

## 验证范围

这是纯函数差分，不是完整转换器 UI 通过。没有运行 renderer、文件写入、设置界面、停止/撤销或并发失败恢复。语义比较解析 YAML 后比较属性值和正文；字节比较另包含序列化格式。

重现：

```powershell
node research/windows-round2/differential.mjs
```
