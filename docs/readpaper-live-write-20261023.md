# 0.5 ReadPaper真实写回、上传及剩余协议缺口

日期：2026-10-23，Asia/Hong_Kong。仅使用当前已登录账号的正常云端请求，不操作桌面界面，不启动或安装客户端。原文献、Cookie和手写内容没有写入新的本地业务缓存；验证报告只保留聚合结果。

## 真实验证结果

创建两份在内存生成的合成PDF，标题为 `PaperDesk-Cloud-Validation-20261023.pdf` 和 `PaperDesk-Cloud-Validation-v2-20261023.pdf`。它们保留在ReadPaper云端供复核，不是同一论文的原生版本链。原有88篇文献和文件夹归属在测试前后相同，原30个目录未变；没有将原文献设为写入目标。

| 功能 | 联机结果 | 证据 |
|---|---|---|
| 高亮、矩形、文本框 | 三类分别新增→读回→修改→读回→删除→确认消失；独立第二会话读到修改内容 | `artifacts/cloud-live-basic-20261023-attempt1.json` |
| 阅读总结 | 保存、读回、第二会话恢复通过，测试结束还原原值 | 同上 |
| 阅读进度 | 保存第2页、读回、第二会话恢复通过，测试结束还原原值 | 同上 |
| PDF上传 | 预检→内存multipart上游上传→状态查询→文献库确认通过 | `artifacts/cloud05-live-upload-20261023.json` |
| 文件去重 | 再传完全相同字节，预检直接返回已有文献，没有再次传输PDF | 同上 |
| 新文件恢复 | 独立会话重新下载，SHA-256与内存生成文件一致 | 同上 |
| 论文版本列表 | 当前账号已收录论文读到真实PDF版本，抽样返回2个版本 | 同上 |
| 独立文件版本 | 合成独立PDF的paperId为哨兵值，上游没有版本集合，明确显示不可用 | 同上 |
| 不同版本选择 | 临时收录原库没有的公开论文；选择、当前标记及第二会话恢复通过，测试后恢复并取消收录 | `artifacts/cloud05-live-versions-20261023-attempt6.json` |
| 匹配新版本上传 | 内存生成公开测试论文的元数据修订版，进入原生版本集合；本会话及第二独立会话下载SHA-256均一致 | 同上 |
| 版本间批注 | 实测两个版本可共享noteId和同一批注；重新读取云端状态，提示位置可能不匹配，不承诺原生版本隔离 | 同上及 `test_native_shared_note_is_reloaded_and_version_warning_shown` |
| 原手写读取/删除 | 按参考渲染器及已知删除协议实现，合成上游契约与像素测试通过；当前账号没有可实测的非空原生笔迹 | 同上及客户端渲染测试 |
| 原生手写新增 | **未通过，不开放创建工具，不报告已保存** | 下节 |

## 手写协议分析及阻塞

固定 `rea-agents@6.7.0`，对原模块的18个声明做有来源范围、原文件与切片哈希的惰性语法提取，再交给REA分析。Evidence：`ev_b215353dd551e49fb0b6c3ad660c4f23e74aec8dab42eebabb4c4e77bcd87ed0`。语义图2160节点、3106关系、200保留未知项；达到未知项容量，不能当作完整行为覆盖。原始样本和Evidence仅在 `.data/readpaper-write-research-20261023/`，分发的是 [脱敏研究摘要](../research/readpaper-write-summary.json) 与复现脚本，不分发原版代码。

已有参考包含：

- `/pdfMark/v3/web/draw/getByNote` 返回 `webDrawV2.webDrawItems`。
- `/pdfMark/v2/web/pencil/batch/delete` 接收笔迹ID数组。
- 显示坐标以页宽950单位缩放，线宽固定或由各点size计算；点宽不能伪装成真实压感。客户端和PDF外观生成均保持变宽，保留已存在的pressure值。
- 含擦除/剪裁的页需要完整合成语义。当前不能安全合成时整页笔迹标为未适配，不显示本应擦除的残留，不改写原数据。
- 当前本机旧手写资源只有空的 `drawModelArray`，不能据此推导非空原生创建格式。

在专用测试文献做了有界协议核对：桌面保存type5被HTTP400参数校验拒绝；根据路径结构提出的旧iOS保存候选返回“未知标注类型5”；两个新iOS路径候选为404。这些候选是明确标注的假设探测，**不属于REA已观察到的写入协议**。公开Swagger返回空paths和definitions，不能提供请求结构。所有核对后读取到的手写记录数仍为0，没有创建或留下测试笔迹。

额外核对附件资源方案时，当前账号的 `attachment/getUploadToken` 返回status2，说明免费账号不能使用附件，需标准版。没有继续上传附件、绕过权限或把笔迹存到其他持久位置。即使附件可用，侧存也不能冒充原生手写互通。

官方[更新日志](https://readpaper.com/doc/changelog.html)说明论文版本选择及iPad压感手写能力；产品有此功能不代表桌面消费模型能反推可用的原生写入请求。用户已说明没有iPad非空样本，因此继续现有样本研究所得的缺口保持显式，不以猜测填充。

## 版本解析修正

补充REA：对21个声明固定提取后分析，Evidence `ev_95f2a63f95cb87529f373d357f95488ce11d6ad9baf749cb357be39f6f882c8c`；2160节点、3107关系、200未知项，仍为静态部分覆盖。来源范围、哈希与限制见 [版本解析研究摘要](../research/readpaper-version-resolution-summary.json)。原始材料保留于 `.data/readpaper-write-research-20261023-version-resolution/`。

保留失败报告attempt1至attempt4，没有将失败覆盖为成功。查明两个独立差异：文献索引pdfId不一定随当前版本立即变化；`getOwnerPaperNoteBaseInfo` 中的pdfUrl可能仍指向旧文件。参考阅读器另行调用 `/aiKnowledge/pdf/getPdfStatusInfo/v2`，传入选定pdfId和noteId，检查hasPdfAccessFlag并使用其pdfUrl。0.5按此流程重新实现。attempt5首次核对新版本字节通过，attempt6增加独立第二会话字节核对并通过。

文献列表身份按上游docId重新关联，可能保持原ID，也可能随索引更新变化；不能用“列表必须出现所选pdfId”判断切换成功。切换时清空旧PDF、正文与任务，再读取选定文件及云端批注。ReadPaper可能复用noteId，本次公开版本样本确实复用且返回相同批注；两个原公开版本的下载内容相同，新上传修订版的哈希不同且已核对。界面加入共享与坐标错位提示，未将“重新读取”写成“批注天然按版本隔离”。

## 实现及验收映射

| 项目 | 实现位置 | 验收用例 |
|---|---|---|
| 上传、去重、状态、取消、显式冲突 | `backend/readpaper_files.py`、`backend/cloud_main.py` | `test_raw_upload_confirmed_duplicate_and_no_runtime_files`、`test_upload_timeout_is_unknown_not_retried_or_claimed_saved`、`test_upload_conflict_requires_explicit_resolution` |
| 版本列表、选择及批注隔离 | 同上；`client/lib/cloud_library_actions.dart` | `test_version_selection_uses_new_pdf_identity_and_no_old_annotations`、`test_arbitrary_pdf_cannot_be_selected_or_private_pdf_faked_as_version` |
| 原笔迹解析与已知删除 | `backend/readpaper_ink.py`、`backend/readpaper.py` | `test_native_ink_read_and_delete_known_protocol`、`test_native_eraser_page_not_rendered_as_unerased_ink` |
| 变宽渲染 | `client/lib/reader.dart`、`backend/pdf.py` | `native per-point widths survive scaled rendering without invented pressure`、`test_native_point_widths_are_visible_without_clipped_appearance` |
| 无磁盘上传路径 | `client/lib/memory_import.dart`、Android `MainActivity.kt` | 原始PDF请求、存储插件零调用、Android内存通道、测试目录零业务文件 |
| 会话隔离 | `client/lib/cloud_store.dart` | 迟到上传结果丢弃、排队上传不能跨入新账号、选文件后账号变化拒绝发送 |
| 390px手机布局 | `client/lib/cloud_home.dart` | `phone cloud library exposes upload and native version limits` |

后台137项、客户端52项回归通过。Android的SAF原生代码经过构建，内存通道有测试，尚未实际调用系统选择器；不会将其写为实机或端到端通过。后端不导入历史数据库/对象存储链，上传体与处理令牌仅在RAM，退出或网关会话过期后清除。任何未知上传结果都不会自动重传。

## 复现

当前会话读取及默认网关启动见 [在线模式](online-mode.md)。真实验证脚本仅作用于上述固定测试文献，需显式 `--execute-writes` 和全新报告文件名；不会自动创建同名不明文件、删除原文献或输出凭据：

```powershell
./.venv/Scripts/python.exe -m scripts.verify_readpaper_live --execute-writes --phase basic --report artifacts/new-basic-report.json
./.venv/Scripts/python.exe -m scripts.verify_readpaper_live --execute-writes --phase upload --report artifacts/new-upload-report.json
./.venv/Scripts/python.exe -m scripts.verify_readpaper_live --execute-writes --phase versions --report artifacts/new-version-report.json
```

静态提取脚本 `scripts/research_readpaper_writes.mjs` 接受参考样本目录、全新输出目录和已安装Babel parser路径；对生成的focused-sample运行REA。参数与哈希详见研究摘要。重跑不得覆盖原始Evidence。

尚未关闭：原生手写新增、新模式客户端端到端、移动实机/压感、真实自有AI质量及iOS。0.5仍为开发版，不能标记“完整复刻已验收”。
