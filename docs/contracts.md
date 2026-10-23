# 数据与同步契约 v1

0.5默认入口使用 [在线模式](online-mode.md)：文献、阅读进度、笔记和批注由ReadPaper持久保存，客户端及新网关业务数据仅在会话内存中存在。专用文献的真实写回已验证；原生手写新增及多端验收仍待完成。下文保留0.3本地优先实现及其自部署接口；SQLite、磁盘缓存和持久待同步队列不适用于新默认路径。

## 0.5在线契约

接口定义为 `openapi-online.json`，客户端需 `Authorization: Bearer <RAM session>` 和 `X-PaperDesk-Session: ephemeral-v1`。空闲30分钟到期；不写系统凭据存储。保存前检查内容指纹，保存后读回核对，但上游没有已验证的原子条件写入，不能承诺多个原客户端同时写入时无覆盖。

`POST /api/v1/uploads` 直接接收application/pdf字节流，文件名通过URL编码的 `X-PaperDesk-Filename` 传递；不使用会落临时文件的multipart解析器。可选folder_id、version_of必须属于当前文献库。GET uploads及按ID查询、显式resolve/cancel仅属于当前会话，原云端处理令牌不返回。状态包括processing/completed/duplicate/conflict/cancelled/failed/unknown/unmatched；未知状态不自动重传。

GET papers/{id}/versions返回上游PDF版本；POST versions/select先检查归属，再读回当前标记并按docId关联文献条目。索引PDF不一定同步变化，返回paper_id可能相同或变化。打开时使用getPdfStatusInfo/v2解析所选PDF的访问许可和下载地址，不能沿用笔记接口的旧URL。旧字节、全文和任务清空；批注及笔记重新从云端读取，上游可能复用noteId及批注，界面提示原坐标可能不匹配，不承诺原生版本隔离。独立PDF没有版本集合时supported=false。新版本上传需同时属于目标论文及原生版本集合，否则返回unmatched并提示文件可能已单独收录。

已知原手写路径使用归一化左上原点，points可带width（相对显示页宽）以保存原点宽，pressure只保存来源实际存在的值，不从线宽推算压感。未知原生创建格式返回错误；当前不开放手写创建工具。

## 0.3历史本地优先契约

所有业务接口位于 `/api/v1`，认证为 `Authorization: Bearer <opaque-token>`。令牌仅保存摘要，退出登录后立即失效。默认有效期 30 天；客户端原生凭据存入系统安全存储，服务器 Key 使用 Fernet 加密。

## 实体

记录包含 `id`（UUID）、`scope`、`kind`、`revision`、`data`、`deleted`、`updated`。个人库服务端作用域为 `u:<user_id>`，客户端当前账号映射为 `personal`；小组为 `g:<group_id>`。实体 ID 不可跨库复用。

支持 `paper/version/attachment/folder/annotation/note/progress/comment/session`。文献通过 `active_version_id` 指定版本，PDF 和附件通过 `file_id` 引用文件，并携带 `file_hash`（SHA-256）。文件对象不可变，同账号相同哈希去重。版本的批注以具体哈希隔离。

文件夹 `parent_id`、文献 `folder_id`、子记录 `paper_id` 必须指向同一库中正确类型的记录。服务端不会因为知道 UUID 或文件哈希就授予访问权。

文件夹不允许循环父子关系；删除前必须移出直接子文件夹与文献，批次内先移动再删除可以原子提交。笔记可带 `title/category/content/page/anchors/conflict_of`；客户端编辑会保留未知扩展字段，防止迁移信息和冲突关联被抹除。分类包括 summary/excerpt/question/idea/vocabulary，旧清单的其他分类仍保留。

进度含 `device`（安装实例 UUID）、`file_hash/page/total_pages/date`，每个设备独立保存记录，阅读器选同一文件最新日期恢复。日期来自客户端，存在设备时钟偏差时仍需人工核对；不能用账号 ID 代替安装实例 ID。

## 批注坐标

使用 `normalized-top-left-v1`：页码从 1 开始，坐标在显示页面内归一化为 `[0,1]`，左上角为原点。`rects` 为 `[left,top,right,bottom]` 的列表；`points` 为 `{x,y,pressure}` 列表，压感也在 `[0,1]`。高亮另外保存选中文本及字符范围锚点。PDF 导出将页旋转转入内容坐标后再转换为 PDF 左下原点。

批注类型为 `highlight/ink/rectangle/text/line`。笔迹编辑存于独立数据层，不直接修改原 PDF；导出由服务器生成新的 PDF。跨页高亮拆成每页一条记录。

可选样式字段 `opacity` 控制笔画、文字或高亮透明度（高亮默认 0.35，其余默认 1）；`fill_opacity` 独立控制矩形内部透明度（默认 0）。两者范围为 `[0,1]`。`font_size` 为字号与显示页宽之比，范围 `(0,1]`、默认 `12/600`；`stroke_width` 为线宽与显示页宽之比，范围 `(0,0.1]`。所有样式值必须为有限数字。显式线宽保持固定，不再叠加压感；缺省笔迹仍以 `(1+3*pressure)/600` 缩放，其他线条保留原默认。线段方向使用 `points` 的首末点，不从包围矩形推断。矩形先填充后描边，导出的 PDF 带显式外观流以保留这些样式。

## 同步

`POST /sync` 请求为 `{scope,cursor,operations}`。每条操作包含 `op_id/entity_id/kind/base_revision/data/deleted`，最多 200 条。客户端发送前持久化准确负载，重试保持同一标识和内容。

服务器按库锁定读写，个人及小组权限在每次请求重新验证。SQLite 开发模式使用 `BEGIN IMMEDIATE`，PostgreSQL 锁作用域所有者。操作与变更日志、回执在同一事务提交。

响应包含每条操作的 `applied/conflict`、最多 500 条有序 `changes`、下一 `cursor` 和 `has_more`。游标按库保存。相同用户、相同 `op_id` 与负载返回原结果；标识被不同负载复用返回 409。

版本不匹配时返回当前版本；未删除笔记另存冲突副本，包含 `conflict_of`。其他类型的本地待处理负载保留在客户端冲突记录内，不自动覆盖服务端；现有界面支持笔记合并。删除用持久删除标记传播；恢复必须基于最新版本。客户端忽略比本机已确认版本更旧的历史变更。

本地编辑和网络同步使用互斥队列避免确认丢失；慢网络可能延迟新编辑的落盘。已输入但尚未触发保存的文本由笔记编辑器保留，700ms 去抖写入。尚未实现复杂协作编辑 CRDT 或操作级富文本合并。

客户端一次同步持续排空多个 100 条批次，并在每批后拉完分页变更。笔记去抖期间收到更新时，本地基线检查会保留 `conflict_of` 副本；批注撤销/重做也检查原快照，拒绝覆盖随后发生的其他编辑。

本地 SQLite schema v2 新增 `page_text`，按文献/文件哈希/页码缓存文字，FTS 查询映射回文献 ID。缓存不写 outbox，支持只读成员建立本机索引；元数据修改、版本切换及删除会更新可搜索页。v1 原有表及待同步操作保留。本地全文不再固定截断 700000 字符；缓存未同步到其他设备，其他设备可下载 PDF 后重建。

## 任务与外部服务

`POST /jobs` 返回任务 ID；`GET /jobs/{id}` 返回状态、进度、结果和脱敏错误。任务状态为 `queued/running/completed/failed/cancelled`。取消在步骤间检查，不保证中断正在进行的单次外部 HTTP 调用。重试创建新任务，防止旧 worker 将结果发布到新尝试。

`GET /jobs?paper_id=...&limit=30` 返回当前用户在可访问文献下的最近任务摘要，不包含其他成员任务、原始提示或图像。点击记录后再查询详情。发起时可传 `file_hash`，不匹配返回 409；服务端保存内部 `_file_id` 固定请求文件，后续版本切换不改变正在排队的分析。结果均含文件哈希，OCR 复用也限定同一哈希。

`figures` 任务不依赖 AI Key，通过 PDFium 枚举直接嵌入图像并裁剪缩略图，附归一化矩形、邻近图注/编号候选和未验证标记。最多 60 图、Base64 总量 8MB，达到上限返回 truncated；此实现不等于完整语义图表检测。

`/providers/ai` 与 `/providers/translation` 使用 `endpoint/model/api_key`。基础地址末尾应包含服务商所需的 `/v1`；系统附加 `/chat/completions`。问答包含页码上下文及来源页清单，回答是否正确仍由阅读者对照原文判断。当前上下文上限 100000 字符，结果含截断标记；服务器提取/OCR 向文献 full_text 回填仍截断 700000 字符，独立本地逐页索引没有此上限。

`GET /metadata?doi=...` 从 Crossref 返回标准化元数据，不修改文献。客户端逐字段预览、选择后进入资料表单，最终保存时连同手工内容一起写 outbox。未收录返回 404，外部服务不可用返回 502。

在线模式使用 Redis/Celery；无 Redis 的开发模式使用 FastAPI 后台任务，进程退出会中断正在运行的任务，不提供生产级故障恢复。


## v0.3.0 离线小组与批量事务

成员列表、角色和当前小组缓存在 SharedPreferences 的服务器/账号命名空间中；离线重启可以继续访问已下载数据。每次联网同步先 GET /groups 刷新权限，再处理 outbox。只读成员不发送本机排队修改，撤权时切回个人库；队列不会被清空，状态栏显示仍保留本机的修改数。离线权限缓存不是服务端授权凭据。

批量操作仅影响当前库内未删除的 paper。单个 SQLite 事务同时更新实体、FTS 和 outbox，任意记录校验失败则整批回滚。批量状态、标签、重要标记和文件夹修改保留已有文件哈希、版本及扩展字段；重复编辑折叠为每实体一条待同步操作。回收站使用 tombstone，不物理删除文件。客户端本地写入禁止复用其他库或其他类型的实体 ID。
