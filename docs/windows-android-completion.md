# Windows / Android 补齐记录（v0.2.0）

以下条目对应功能对照表，可在 Windows 与 Android 共享客户端中操作。代码路径存在、自动回归通过和原版一致性验收是不同状态。本轮没有取得新的 ReadPaper 登录后运行样本，REA 基线及其限制保持在 `research/README.md`。

| ID | 验收行为 | 实现位置 | 自动用例 / 证据 |
|---|---|---|---|
| NOTE-01 | 一篇文献保存多条笔记，按具体 ID 打开并切换；选择分类 | `client/lib/notes.dart`、`main.dart`、`reader.dart` | `completion_test.dart`: select requested note / switching notes |
| NOTE-02 | 重命名、删除并撤销，导出全部笔记为 Markdown | `notes.dart`: act / notesMarkdown | deleting a note can be undone；原生保存对话框导出尚未单独验收 |
| NOTE-03 | 清空笔记后立即离开仍保存空内容；保留原有 conflict_of、锚点和分类 | `notes.dart`: flush / dispose / lifecycle | select requested note / Android 集成用例 |
| NOTE-04 | 编辑去抖期间遇到其他修改保留冲突副本；切换前先保存 | `store.dart`: basedOn；`notes.dart`: flush | stale editor keeps concurrent draft |
| NOTE-05 | PDF 选区转为摘录笔记，携带页码和文本锚点 | `reader.dart`: excerpt | 原生真实跨页选择手势仍待验收 |
| LIB-01 | 文件夹树展开/折叠、移动、子目录筛选，拒绝循环和非空删除 | `folders.dart`、`store.dart`、`backend/entities.py` | folder moves / test_folder_cycles_and_nonempty_deletion_are_atomic |
| META-01 | DOI 查询、逐字段预览与选择；取消不改变文献 | `metadata.dart`、`providers.py`、`main.py` | metadata preview / test_metadata_lookup_*；真实 DOI `10.1038/nphys1170` 返回标题和年份 |
| INK-01 | 撤销/重做添加和删除；不得覆盖之后的其他修改 | `annotation_tools.dart`、`store.dart` | annotation undo and redo；Android 集成用例 |
| INK-02 | 橡皮擦按线段距离命中，矩形内部空白不命中；笔模式拒绝手指 | `annotation_tools.dart`、`reader.dart` | eraser tests segments / pen-only input；真实笔压和掌压未验收 |
| SEARCH-01 | 按页索引，可查找原 70 万字符之后的内容；切换版本隔离索引 | `store.dart`: page_text / indexPage；`reader.dart`: indexLocal | page index searches beyond old limit |
| SEARCH-02 | 从 v1 数据库升级保留文献及待同步操作 | `store.dart`: schema v2 | version 1 workspace upgrades |
| PROGRESS-01 | 从最新其他设备记录恢复，在本设备记录中补存退出前页码 | `reader.dart`: saveProgress；`store.dart`: deviceId | latest other-device progress resumes |
| SYNC-01 | 单次同步持续发送多个 100 条批次，回执丢失仍精确重放 | `store.dart`: sync | one synchronization drains / lost acknowledgement |
| GROUP-01 | 组主添加只读/编辑成员，修改角色，移除成员；其他成员只查看 | `groups.dart`；`main.py`: members | member management changes role；后端已有隔离/撤权用例 |
| GROUP-02 | 只读成员不能把修改排入离线队列 | `store.dart`: canEdit | viewer cannot queue edits while offline |
| TASK-01 | 重新打开历史任务结果，继续查询运行状态/取消/重试 | `reader.dart`: 历史任务；`main.py`: GET /jobs | test_ai_task_tracks_sources_and_redacts_errors 同时核对历史权限 |
| TASK-02 | 排队/重试期间固定 PDF，不随当前版本改变；拒绝陈旧文件哈希 | `main.py`: create_job；`tasks.py` | test_task_pins_file_version_and_rejects_stale_hash |
| FIG-01 | 枚举直接嵌入图像，排除整页扫描，提取邻近图注候选、裁剪、定位和解读 | `backend/figures.py`；`reader.dart`: jobStatus | test_figures_extract_caption_page_crop_and_rotation；候选数量 60、响应图像总量 8MB 上限 |

客户端回归位于 `client/test/completion_test.dart` 与既有测试；后端位于 `backend/tests/test_api.py`。集成流程位于 `client/integration_test/offline_reader_test.dart`。最终运行结果以 `artifacts/checks.json`、构建日志和验证记录为准。

## 未关闭条目

- 原版登录后的逐屏视觉/交互对照、原版批注同步实验和私有迁移格式。当前 REA 证据不能替代运行观察。
- 自动图表仍缺矢量图、Form 嵌套图像、文本表格及可靠语义编号匹配；图搜论文未实现。
- 笔记支持 Markdown 编辑与块级公式；富文本工具栏、实时多人编辑与内联公式尚未完成。
- 原生文件拖放及更完整的共享/权限操作流程仍待补齐。批量管理与离线小组入口在 v0.3.0 补齐，见下表。
- OCR/AI/翻译真实服务质量、Docker/PostgreSQL/S3 恢复、大文献库性能和移动实机手写尚未验收。
- Android 当前为调试 APK；商用签名、硬件验收及 iOS 构建仍未完成。

上述条目未关闭前，版本状态保持开发版，不能标记完整复刻验收完成。


## v0.3.0 补齐

| ID | 验收行为 | 实现 | 验证 |
|---|---|---|---|
| GROUP-03 | 按服务器和账号恢复成员列表、角色及上次选择，离线重启后仍能打开小组缓存 | store.dart: membership 缓存 | library_completion_test.dart: offline restart restores group selection；另一账号不能复用缓存 |
| GROUP-04 | 联网先刷新成员权限，再发送待同步操作；降为只读后只拉取，撤权后切回个人库 | store.dart: refreshGroups / sync | downgrade refresh / membership removal；原有待同步操作保留，不丢弃本机草稿 |
| LIB-02 | 文献多选、全选当前筛选结果、批量阅读状态/标签/重要标记/移动/回收站 | bulk.dart、main.dart、store.dart: bulkPapers | batch edits are atomic；390px 手机界面多选并批量设置已读；Android 集成用例 |
| LIB-03 | 批量修改原子落盘；保留哈希、版本、已有标签及待同步顺序 | store.dart: bulkPapers | 不存在文献触发整批回滚；关闭数据库再打开核对；重复修改折叠 outbox |

成员缓存供已下载数据离线使用；服务端每次仍重新校验权限。离线设备尚未收到角色变化时仍按缓存角色工作，联网后以服务端权限为准。撤权不删除本机尚未上传的修改；当前没有专门的撤权草稿导出界面，重新获得授权后可以继续同步。批量删除为可恢复的回收站操作，不物理清理 PDF。
