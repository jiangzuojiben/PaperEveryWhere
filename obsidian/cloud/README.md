# VaultDesk 自部署账号、同步与发布

独立实现的可运行服务，只连接用户配置的服务地址，不连接 Obsidian 官方账号、Sync、Publish 或授权服务。SQLite 保存账号、会话、文件版本和明确选中的公开快照；本地 Markdown Vault 仍然是桌面端的工作目录。

## 本机启动（Windows）

在 `PaperDesk/obsidian` 目录运行：

```powershell
..\.venv\Scripts\python.exe -m pip install -r cloud/requirements.txt
..\.venv\Scripts\python.exe -m uvicorn cloud.app:app --host 127.0.0.1 --port 8766 --no-proxy-headers
```

没有现成虚拟环境时：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r cloud/requirements.txt
.\.venv\Scripts\python.exe -m uvicorn cloud.app:app --host 127.0.0.1 --port 8766 --no-proxy-headers
```

服务健康检查：`http://127.0.0.1:8766/health`。交互式 API 文档：`http://127.0.0.1:8766/docs`。
桌面同步配置为 `{baseUrl: "http://127.0.0.1:8766", token: "登录得到的令牌", vaultId: "远端库ID"}`。
默认数据库是 `cloud/data/vaultdesk.sqlite3`，被 Git 忽略。导入服务模块时会初始化数据库。

## Docker 部署

在 `PaperDesk/obsidian` 目录运行：

```powershell
docker compose up --build -d
docker compose logs cloud
```

默认仅绑定主机 `127.0.0.1:8766`，数据写入命名卷 `vaultdesk-cloud`，容器使用普通用户运行。构建上下文只包括 `cloud` 中明确允许的源文件，不包含本地数据库。Compose 文件为可部署配置；本项目测试覆盖 Python 服务，Docker 镜像需要在安装 Docker 的机器上构建验证。

远端访问时，由自己的 Caddy/Nginx 等反向代理提供 HTTPS，再把桌面的 `baseUrl` 设为该 HTTPS 地址。无需向浏览器开放 CORS 的桌面请求通过宿主进程发送。浏览器演示需要在 `VAULTDESK_CORS_ORIGINS` 中明确列出来源；不要使用通配符。未启用代理头信任，认证限流按连接来源 IP 计算；多用户反向代理部署时应在代理层配置独立限流。

首次创建账号后可设置 `VAULTDESK_ALLOW_REGISTRATION=false` 禁止新增账号，再重启服务。当前不包含邮箱验证、邮件密码找回、管理员控制台或收费功能。

## 配置

通过进程环境变量或 Compose 项目 `.env` 设置（`cloud/.env.example` 仅为示例，Python 不会自动载入）：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `VAULTDESK_DB` | `cloud/data/vaultdesk.sqlite3` | SQLite 文件位置；容器内为 `/data/vaultdesk.sqlite3` |
| `VAULTDESK_ALLOW_REGISTRATION` | `true` | 允许创建账号 |
| `VAULTDESK_MAX_FILE_BYTES` | `16777216` | 单文件 16 MiB，按解码后的字节数限制 |
| `VAULTDESK_USER_QUOTA_BYTES` | `1073741824` | 每个账号当前文件总量 1 GiB；公开快照另享同样额度 |
| `VAULTDESK_HISTORY_QUOTA_BYTES` | `5368709120` | 每个账号全部历史内容最多 5 GiB；到限后拒绝新增内容，不静默删除历史 |
| `VAULTDESK_SESSION_TTL_SECONDS` | `2592000` | 会话有效期 30 天 |
| `VAULTDESK_CORS_ORIGINS` | localhost/127.0.0.1 的 5178 端口 | 逗号分隔的浏览器来源 |

账号最多 100 个 Vault 和 100 个公开站点，每个站点最多明确选择 1000 个文件。认证接口按来源 IP 限制 30 次/分钟。大小和配额配置读取于进程启动时。

## API 约定

除 `/health`、`/auth/register`、`/auth/login` 和 `/p/...` 外，均需 `Authorization: Bearer TOKEN`。写入体为 JSON。未知/无权读取的资源统一返回 404。验证失败返回 422，未认证返回 401，超限返回 413。

### 账号与 Vault

| 方法与路径 | 输入 | 输出 |
| --- | --- | --- |
| `POST /auth/register` | `{email,password}`，密码 10–1024 字符 | 201 `{token,user:{id,email,created_at},expires_in}` |
| `POST /auth/login` | `{email,password}` | 同上，200 |
| `GET /auth/me` | — | `{user}` |
| `POST /auth/logout` | — | 204，仅撤销当前会话 |
| `GET /vaults` | — | `{vaults:[{id,name,revision,created_at}]}` |
| `POST /vaults` | `{name}` | 201 `{id,name,revision:0,created_at}` |
| `GET /vaults/{id}` | — | `{id,name,revision,created_at}` |
| `PATCH /vaults/{id}` | `{name}` | `{id,name}` |
| `DELETE /vaults/{id}` | — | 204，删除该库的内容、历史与相关公开站点 |

密码用独立随机盐的 PBKDF2-HMAC-SHA256（600000 次）保存；数据库只保存会话令牌的 SHA256 摘要。令牌仅创建/登录时返回，不进入 URL。邮箱为账号标识，不代表经过邮箱所有权验证。

### 文件同步、冲突与历史

| 方法与路径 | 输入 | 输出 |
| --- | --- | --- |
| `PUT /vaults/{id}/files` | `{path,content,encoding:"utf8"或"base64",base_revision}` | 最新文件事件 |
| `DELETE /vaults/{id}/files` | JSON `{path,base_revision}` | 删除墓碑事件 |
| `GET /vaults/{id}/files?path=...` | URL 编码相对路径 | 当前非删除文件事件 |
| `GET /vaults/{id}/changes?cursor=0&limit=100` | cursor 默认 0，limit 1–100 | `{changes:[事件],cursor,has_more}` |
| `GET /vaults/{id}/history?path=...&limit=100&before=...` | before 可省略 | `{history:[不含content的事件],next_before}`，最新在前 |
| `POST /vaults/{id}/restore` | `{path,revision,base_revision}` | 新写入事件；revision 指定要恢复的非删除版本 |

文件事件字段：`{path,revision,deleted,encoding,size,updated_at,content?}`。时间为 UTC ISO8601；`size` 是解码后的字节数。删除墓碑的 `size=0` 且没有 `content`。二进制采用标准 Base64，UTF-8 文件按原字节保存，服务不改写换行或 Markdown。

每次修改递增整个 Vault 的 `revision`；同一文件的版本号可能跳跃。新文件 `base_revision=0`，更新/删除必须提交该路径最后的版本号，恢复已删除文件必须提交墓碑版本号。并发比较和版本写入处于同一 SQLite 写事务。冲突返回：

```json
{"detail":{"code":"revision_conflict","path":"Notes/hello.md","current_revision":7}}
```

客户端应该保存本地内容，再读取远端变更；不能把 409 当作成功，也不能无提示地强制覆盖。`path_collision` 的 409 表示 Windows 大小写别名或文件/目录路径冲突。

`cursor=0` 返回全量事件历史；从事件顺序重放即可得到当前状态，后续从保存的 `cursor` 增量拉取。单页最多 100 个事件且约 32 MiB 解码内容（始终至少返回一个事件），`has_more=true` 必须继续请求。只有落盘成功后才能推进客户端 cursor。每页在一致的数据库读事务中查询；并发新版本在后续请求可见。超出当前 Vault 的 cursor 返回 400，客户端应重置为 0。历史不会自动压缩，已删除的版本保留到整个 Vault 删除。

路径只接受相对路径及 `/` 分隔符，拒绝 `..`、绝对路径、反斜杠、空段、控制字符、Windows 非法字符/保留设备名、尾随空格和句点；每段最多 255 UTF-8 字节，总计最多 1024 字节。所有文件存储于数据库，路径不会用来操作服务器文件系统。

### 选择发布

| 方法与路径 | 输入 | 输出 |
| --- | --- | --- |
| `GET /sites` | — | `{sites:[{id,vault_id,slug,title,paths,url,created_at,updated_at}]}` |
| `POST /sites` | `{vault_id,slug,title,paths:[相对路径]}` | 201 站点对象 |
| `PATCH /sites/{id}` | `{paths:[相对路径],vault_id?,slug?,title?}` | 更新后的站点对象 |
| `DELETE /sites/{id}` | — | 204，立即移除公开快照 |
| `GET /p/{slug}/` | 无需认证 | 公开文件索引 |
| `GET /p/{slug}/{path}` | 无需认证 | 安全 Markdown 阅读页或选中的附件 |

`slug` 为 1–64 位小写英文、数字、内部连字符；全站唯一。发布/更新时仅复制 `paths` 指定的当前文件快照，不扫描关联文件，不隐式公开目录，不在同步后自动更新公开内容。`paths` 必须明确提供且非空；取消发布用 DELETE。修改源文件、恢复版本或删除单个源文件均不改变已发布快照；需主动更新/撤销站点。删除整个 Vault 会级联撤销对应站点。

阅读页关闭原始 HTML，过滤输出标签、属性与协议，禁止脚本和 iframe，配置 CSP sandbox、nosniff、无来源泄露头。Markdown/Wiki 内部链接只指向已选中的文件，外部图片不加载；PNG/JPEG/GIF/WebP/AVIF 可作为已选中图片展示，其余附件（包括 HTML/SVG）以下载形式返回。内容不包含插件执行、Dataview、MathJax 或 Canvas 的交互式渲染。公开页面不缓存；撤销无法删除访问者已经自行保存的副本。

## 数据保护与运维

当前**没有端到端加密**。服务保存可读内容和历史；本机默认 HTTP 仅供 loopback 使用，跨机器部署需要自己的 HTTPS 代理。数据库磁盘加密、备份、证书和服务访问控制由部署者管理。发布本身是公开服务，不需要登录。

备份时停止服务后复制 SQLite 数据文件（若有 `-wal`/`-shm` 一并复制），或在线使用 SQLite backup API；不要只复制正在写入的主数据库文件。恢复时停止服务、替换数据库，再启动。删除账户/密码重置/版本清理的管理接口尚未实现，不应手工改动运行中的库。

运行集成测试：

```powershell
..\.venv\Scripts\python.exe -m pytest tests/cloud_test.py -q
```

测试使用临时数据库，包括多账号隔离、登录退出、Vault 管理、文本/二进制、并发 CAS 冲突、删除墓碑、增量日志、恢复、发布快照、路径和 HTML 安全。数据库 schema 当前为首版，仅用 `CREATE TABLE IF NOT EXISTS` 初始化，后续结构变化需要显式迁移。

还可运行真实桌面宿主与服务的组合冒烟测试：

```powershell
node scripts/cloud-sync-smoke.mjs
```

脚本使用临时 SQLite、合成账号、两个临时本地 Vault 及动态 loopback 端口，真实调用 `desktop/sync.mjs`，验证双端离线冲突保留、PDF 字节一致性、删除传播、云历史恢复、选择发布、更新和撤销。结束时关闭它自己启动的服务并删除临时数据，保留脱敏汇总 `output/cloud-sync-smoke.json`；不读取用户 Vault 或账号。Python 路径可通过 `VAULTDESK_TEST_PYTHON` 覆盖。
