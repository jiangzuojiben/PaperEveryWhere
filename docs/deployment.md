# 部署、备份与迁移

## 运行模式

- 本地模式：Python 3.12，SQLite、不可变本地文件、进程内后台任务；可独立使用，便于验证。
- 容器模式：PostgreSQL 17、Redis 7、MinIO 和 Celery。API 与 worker 共用数据库和对象存储，bucket 初始化后才启动 API。

首先安装 Docker，然后运行 README 中的初始化命令。`setup.py` 生成 `.env`；其中 `PAPERDESK_ENCRYPTION_KEY` 一旦用于存储服务商 Key 就必须保留。可设置 `PAPERDESK_OPENALEX_KEY` 和 `PAPERDESK_CROSSREF_EMAIL`。

远程访问配置 HTTPS 反向代理至 `127.0.0.1:8765`，不要直接公开 PostgreSQL、Redis 或 MinIO 管理端。客户端配置自己的服务地址；iOS 的默认配置仅允许局域网例外，公网使用 HTTPS。Android 测试构建允许 HTTP 访问自部署局域网服务。

容器健康检查覆盖数据库与 API；任务异常在客户端显示。升级前备份；当前 v0.1 仅提供初始建表，不可将 `create_all` 当作未来任意结构迁移工具。

## 本地备份与恢复

先退出写入客户端并停止本地 API，再执行：

```powershell
./.venv/Scripts/python.exe scripts/backup.py backup --data .data --archive artifacts/backup.zip
./.venv/Scripts/python.exe scripts/backup.py restore --data restored-data --archive artifacts/backup.zip
```

归档包含 SQLite 一致性快照、不可变文件和本地加密 Key；恢复只允许空目标，并执行数据库完整性检查。使用环境变量提供加密 Key 时，另外备份 `.env`。客户端本地缓存不在服务器归档中，账号同步后可重建；尚未同步的本地工作区需单独保留系统应用数据目录。

## 容器备份与恢复

此流程尚未在本机 Docker 中执行验证：

1. 停止 `api`、`worker`，保留 PostgreSQL 和对象存储运行。
2. 使用 `pg_dump -U paperdesk -d paperdesk -Fc` 导出数据库；通过 MinIO 客户端 `mc mirror` 备份 `paperdesk` bucket，同时保存 `.env`。
3. 恢复到全新部署：还原 bucket、用 `pg_restore` 还原数据库、恢复原加密 Key，再启动 API 和 worker。
4. 核对文献数量、文件哈希、笔记及服务商解密配置。数据库和 bucket 必须来自同一停止写入窗口。

## 旧数据迁移

优先使用已有 PDF 与官方标准导出。扫描工具只读用户明确选中的目录，不读取 Cookies、令牌、浏览器历史或加密数据库：

```powershell
./.venv/Scripts/python.exe scripts/migration_scan.py '<PDF目录>' --output artifacts/migration-preview.json
```

在客户端导入原 PDF，再从设置选择迁移 JSON/BibTeX/RIS，先查看清单后确认导入。文件哈希用于关联已上传 PDF；源文件缺失的记录仍可保留资料，之后通过“添加 PDF 版本”关联。

JSON 结构为 `{papers:[{source_id,title,authors,tags,folder,file_hash,notes,progress,annotations}]}`。`folder` 使用斜杠路径。`source_id` 应稳定且在同一数据来源内唯一；重复导入不会覆盖现有记录。

原版私有批注格式尚未验证。只有明确声明 `coordinate_system: normalized-top-left-v1` 并绑定 PDF 哈希的批注会转换；其他批注列入失败报告，原始导出文件保持不变。不读取不到的云端原件，不根据阅读百分比猜测页码。

## 构建与分发

Windows：便携 ZIP 已包含 Flutter 运行目录，直接解压运行；`windows-installer.iss` 可用已有 Inno Setup 编译器生成当前用户安装器。

Android：调试 APK 面向测试，正式分发前配置自己的签名并构建 release。当前工程包含 ARM64/x64 构建脚本；SDK/NDK/JDK 在本机用户缓存中，不提交仓库。

iOS：使用 Mac/Xcode，设置开发团队与自己的 Bundle ID，确认 iPhone/iPad 文件选择、手写和网络权限后再做签名分发。GitHub 工作流只提供配置，本轮未运行远程 Mac 构建。
