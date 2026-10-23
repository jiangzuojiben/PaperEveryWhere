# 原生手写新增协议补充研究

日期：2026-10-23，Asia/Hong_Kong。**可绘制原生手写新增仍未打通，创建工具保持关闭。** 本轮确认了旧接口的记录写入，以及一个有必填校验的批量保存路由；两者均不能当作笔迹成功写回。没有操作桌面界面。

## 新增事实

| 项目 | 证据与结果 | 边界 |
|---|---|---|
| 手写类型 | 原样本枚举：IOSDraw=2，DrawV2=5 | 两代格式不同，不能把5直接填进旧保存入口 |
| 桌面保存调用方 | `PersonAnnotationController.onlineSaveAnnotation` 为高亮、矩形、文本框填充请求，调用v2/web/save；没有构造pencil笔迹体 | 静态分支不证明完整运行行为 |
| 旧iOS保存入口 | 假设路径 `/pdfMark/v2/ios/save` 经隔离文献实测；type2识别pencil，缺字段时依次返回缺笔触、缺页码、缺paperId；加入root page、paperId及pencil后返回记录ID | 仅验证旧记录元数据，未验证绘图资源上传 |
| 旧记录读回 | v3/web/getByNote读到type2与空drawAnnotation.nsDataUrl；v3/web/draw/getByNote没有路径。把已知webDrawItems放入旧pencil也没有形成原生路径 | HTTP200/status1不足以证明可绘制笔迹；空URL也不能证明非空URL字段映射 |
| 新批量入口 | 根据已有pencil批量删除路径提出 `/pdfMark/v2/ios/pencil/batch/save` 候选，实测HTTP200/status0，消息为必填字段不能为null | 路径是有界假设验证所得，**不是REA静态发现的创建协议**；必填请求结构仍未知 |
| 候选邻近入口 | v2/ios/pencil/save与v3/ios/pencil/batch/save均404；urlencoded请求被415拒绝 | 不继续无依据扩大路径或字段猜测 |
| Swagger | swagger-resources列出default，但v2/api-docs的default没有paths/definitions，v3/api-docs为404 | 无法从该公开元数据恢复DTO |

旧入口的可接受控制体只包含测试文献的noteId/pdfId/paperId、root page=1、type=2和pencil对象；这里的page与桌面pageNumber不能互换。读回的是空旧记录，不是用户笔迹，不发布为生产手写功能。没有使用附件、笔记正文或本地缓存侧存笔迹，也没有绕过付费功能。

## REA与来源固定

使用rea-agents 6.7.0，对同一份已留存桌面模块做惰性AST提取，固定11个声明/方法及10个pdfMark请求位置，保留原模块SHA-256、UTF-16/字节范围、切片哈希和包装说明。新增调用方分析Evidence：`ev_89459f08b89af1b53804fba7c32357f38c67976b66661b320c7e328d3ad39b5d`。语义图1270节点、1129关系、200未知项；未知项达到容量，属于部分静态覆盖。

原始提取和REA输出仅位于 `.data/readpaper-ink-research-20261023-caller/`；[可分发研究摘要](../research/readpaper-native-ink-summary.json)只含来源范围、哈希及结果，没有原代码、Cookie、签名URL、记录ID或笔迹内容。

补查已安装app.asar，SHA-256为 `dcfcc05e97f1b143a90f3e3508b5183523c990ceba2397a79da8a00b0d2c0d60`。731个JS/JSON/HTML/map/proto/TS文本条目均未出现所核对的pdfMark、pencil/batch/save、nsDataUrl、drawModelArray、handwrite字面量。这只能说明该范围内没有字面量匹配，不能推定远程模块或动态构造协议不存在。

## 真实验证与防误判

新增 `scripts/verify_readpaper_ink_live.py`，真实报告为 `artifacts/native-ink-live-research-20261023-attempt1.json`。研究保护检查通过，**native_creation_verified与independent_native_geometry_verified均为false**。脚本在协议未打通时退出码为2，不用“研究检查通过”冒充“功能通过”。

- 仅允许固定名称的合成测试PDF，重新下载SHA-256必须匹配；已有批注或绘图时拒绝写入，也不清理它们。
- 请求、Cookie、响应ID、点路径和PDF仅在RAM中处理；报告只保留聚合结果。
- 旧记录的成功回执必须单列；原生成功需读到匹配的路径、颜色、线宽及真实pressure，并在第二独立会话确认。
- 不重试写入；控制记录用本次返回ID删除，笔迹清理只限事先确认无记录的测试文献。随后核对云端无残留及原库归属不变。

真实控制记录已删除；第二会话未发现原生路径；原有88篇文献及分类关系未改动。专用测试文献仍为空。本地没有新增业务数据库、PDF缓存或持久同步队列。

回归新增5项，覆盖旧回执误判、文件内容不符拒绝写入、已有记录拒绝写入与清理、读回失败后的清理，以及几何/压感不符拒绝通过。后台全量142项通过。客户端代码与二进制未变，沿用0.5已构建包，本次不声称新增客户端功能。

## 复现

```powershell
./.venv/Scripts/python.exe -m pytest backend/tests/test_ink_research.py -q
./.venv/Scripts/python.exe -m scripts.verify_readpaper_ink_live --execute-writes --legacy-control --report artifacts/new-ink-report.json
```

第二条会修改并清理固定测试文献，要求全新报告路径；当前预期退出码2及native_creation_verified=false。不传legacy-control时只核对批量候选入口。只有发现新的字段或样本依据后才扩展候选，不能靠让接口返回成功代替原生笔迹互通验证。
