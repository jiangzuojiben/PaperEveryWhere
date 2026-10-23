# VaultDesk — Windows 桌面开发预览

VaultDesk 是围绕本地 Markdown 知识库的独立实现，目标参考 Obsidian 核心 **1.13.7** 的客户端行为，并将账号、同步和发布替换成可本机运行、可自行部署的服务。它不连接 Obsidian 官方云服务，也不附带原应用的代码、界面素材或插件。

**当前是开发预览，尚未完整还原 Obsidian。** 已实现的编辑、链接、图谱、Canvas、属性表及自部署服务可以运行；完整插件生态、所有窗口交互、全部 Bases 查询能力、加密同步、移动端等仍有差距。可验收范围、参考证据与待验证项以 [兼容矩阵](docs/parity.md) 为准。某一组测试通过不代表整款应用兼容。

Windows 桌面优先；React 编辑界面、纯 JavaScript 文档核心、Electron 宿主及 Python 服务分层，保留跨平台架构。当前 Windows x64 便携目录是交付目标，macOS/Linux 包和平台行为尚未验收。

## 从源码运行桌面版

需要 Node.js 22.13 或更高版本、npm，以及可下载依赖的网络。服务端单独需要 Python，纯本地笔记不需要启动服务。

在本目录执行：

```powershell
npm ci
npm run build
npm start
```

桌面版直接加载 `dist`，不依赖开发服务器。首次启动会在 `%APPDATA%\VaultDesk\Welcome Vault` 创建独立欢迎库；使用应用中的打开知识库入口选择自己的目录。应用记住已选择的库，不扫描其它目录。尝试现有资料时可先使用副本。

开发时可分别运行以下两个终端：

```powershell
# 终端一
npm run dev

# 终端二
$env:VAULTDESK_DEV_URL = 'http://127.0.0.1:5178'
npm start
```

`VAULTDESK_DEV_URL` 只接受本机地址。直接在浏览器打开开发地址得到的是独立演示存储，不具备桌面宿主的真实文件系统和双向同步能力。

## Windows 便携目录

源码构建命令为 `npm run package:win`，输出 `release\VaultDesk-<版本>-Windows-x64\`。该脚本使用已经安装的开源 Electron Windows x64 运行时，要求 `npm ci` 成功完成。已有同版本输出会被保留，脚本拒绝覆盖；重复构建需先保留旧产物并采用新的输出版本。

拿到构建产物后，把**整个目录**解压到可读位置，双击 `VaultDesk.exe`。该目录包含运行时和应用文件，仅复制 `.exe` 无法运行。桌面程序不要求本机预装 Node.js 或 Python；只有使用随附自部署服务源码时才需要 Python。

这是免安装目录，并非“所有数据留在程序目录”的模式：程序设置与欢迎库仍放在 `%APPDATA%\VaultDesk`，个人笔记保留在自己选择的知识库目录。构建产物目前没有代码签名、自动更新器、安装器或系统 URI 注册。Windows 可能显示未知发布者；可先核验 `package-manifest.json` 和 `integrity.json` 所列的构建信息与文件哈希。

便携目录附带云服务源码、启动脚本、兼容范围及第三方声明。移走或删除程序目录不会自动删除 `%APPDATA%\VaultDesk`、自行选择的知识库或另行部署的云数据库。

## 基本使用

- `Ctrl+N` 新建笔记，`Ctrl+O` 快速切换，`Ctrl+P` 命令面板，`Ctrl+,` 打开设置；设置中可调整快捷键。
- Markdown 支持源码、实时预览和阅读模式；`Ctrl+E` 切换阅读，`Ctrl+F` 查找，`Ctrl+Z` 撤销。
- `[[笔记]]`、Markdown 链接、嵌入、回链和出链共用文档核心；托管重命名按偏好维护引用。出现外部修改冲突时应先检查两个版本。
- 侧栏提供文件、搜索、图谱和日记入口；支持 Canvas、Bases 子集、属性、书签、模板及工作区等视图。具体边界见兼容矩阵。
- 附件保留本地二进制文件；录音会请求麦克风权限；附件导出使用系统另存为对话框。
- 文件历史和回收站位于库内 `.vaultdesk`，可以恢复应用保存前的版本及已移入回收站的内容。它们不是完整的离线备份策略。
- 本地插件属于显式启用的受信任扩展代码，会获得应用渲染进程所具备的能力；默认禁用，每次启动需重新启用。目前不是通用 Obsidian 社区插件兼容宿主。

## 启动自己的云服务

默认只在本机 `127.0.0.1:8766` 监听。PowerShell 启动脚本优先复用已经具备依赖的父项目 `.venv`，其次使用本目录 `.venv`：

```powershell
# 环境已准备好：直接启动，Ctrl+C 停止
.\scripts\start-cloud.ps1

# 首次准备：需要已安装 Python 3.12；缺少环境时创建本目录 .venv
.\scripts\start-cloud.ps1 -Setup

# 只检查解释器、依赖和地址，不启动服务
.\scripts\start-cloud.ps1 -CheckOnly
```

如需指定环境或数据位置：

```powershell
.\scripts\start-cloud.ps1 -Python 'C:\MyEnv\Scripts\python.exe' -Port 8766 -DatabasePath 'D:\VaultDeskData\cloud.sqlite3'
```

没有准备好的父环境时，脚本的 `-Setup` 创建并安装本目录的环境，不自动修改父项目环境。明确传入 `-Python` 并使用 `-Setup` 时，会在指定环境安装依赖。Python 最低 3.11，推荐 3.12。脚本不更改系统执行策略、不配置防火墙、不创建后台服务。

在桌面应用“设置 → 同步与发布”填写 `http://127.0.0.1:8766`，注册自己的账号（密码至少 10 个字符），创建或选择远程库，再执行双向同步。第二台设备连接同一个自行部署的地址、账号及远程库。账号令牌只在本次应用会话中保留。

同步为显式操作，支持文本和二进制、增量版本、删除与冲突副本。服务端能读取上传内容，**当前没有端到端加密**。通过远程网络使用时应在自有 HTTPS 反向代理后部署。不同设备应选择自己的本地副本，避免把同一个磁盘目录当成两台设备来测试。

发布只公开明确选择且已同步的文件，站点无需登录即可访问。修改笔记后需要再次发布更新公开快照；取消发布会撤下对应站点。不要把同步本身误认为公开发布。

Docker 方式在有 Docker 的机器上执行：

```powershell
docker compose up --build -d
docker compose logs cloud
```

Compose 默认仅暴露到本机，数据位于 `vaultdesk-cloud` 命名卷。服务配置、API、配额、备份和恢复细节见 [云服务文档](cloud/README.md)。默认 SQLite 数据库为 `cloud/data/vaultdesk.sqlite3`；停止服务后备份数据库及相关文件，或使用 SQLite 的在线备份方式。

## 数据位置与隐私

| 位置 | 内容 |
| --- | --- |
| 用户选择的知识库 | Markdown、Canvas、Bases、附件等原始文件 |
| 知识库内 `.vaultdesk` | 应用设置、工作区、文件历史、回收站、同步游标与哈希 |
| 已有 `.obsidian/app.json` | 仅作为可选偏好读取，不覆盖原应用配置，不自动加载其中插件 |
| `%APPDATA%\VaultDesk` | 独立桌面用户数据、最近选择的库路径及欢迎库 |
| `cloud/data` 或 `VAULTDESK_DB` | 自部署账号、令牌摘要、文件版本与公开快照数据库 |
| `output`、`research` | 隔离实验、测试报告和 REA 衍生证据；不是个人知识库 |

默认不自动连接云服务；登录、同步及发布只访问用户填写的服务地址。应用拒绝通过 Vault API 遍历目录、跟随符号链接/目录联接或改写受保护元数据。普通本地文件、历史和回收站均不加密。自有插件及用户主动打开的外部链接有各自行为，应按可信代码和外部站点对待。

## CLI、URI 与隔离验证

CLI 必须明确指定绝对 `--vault`，不会使用桌面记住的库或环境变量默认库，成功结果以 JSON 输出：

以下命令在源码目录运行。便携目录的 CLI 位于 `resources/app/desktop/cli.mjs`，使用它需要另行安装 Node.js；正常运行桌面应用无需 Node.js。

```powershell
node desktop/cli.mjs --vault 'C:\Notes\MyVault' list
node desktop/cli.mjs --vault 'C:\Notes\MyVault' read 'Note.md'
node desktop/cli.mjs --vault 'C:\Notes\MyVault' create 'New.md' --content 'Hello'
node desktop/cli.mjs --vault 'C:\Notes\MyVault' append 'New.md' --content ' more text'
node desktop/cli.mjs --vault 'C:\Notes\MyVault' rename 'New.md' 'Moved.md'
node desktop/cli.mjs --vault 'C:\Notes\MyVault' search 'tag:project'
```

独立 URI 格式支持 `vaultdesk://open?file=Note.md` 和 `vaultdesk://new?name=New&content=Hello`。URI 只作用于当前已选库；指定其它库时会拒绝并提示先手动打开。代码接入了启动参数及应用事件，但目前没有向操作系统注册 URI 协议。

常规验证：

```powershell
npm test
npm run build
..\.venv\Scripts\python.exe -m pytest tests/cloud_test.py -q

# 可选：真实本机 FastAPI + 两个临时 Vault 的互通测试
$env:VAULTDESK_CLOUD_INTEGRATION = '1'
node --test tests/desktop-cloud.test.mjs
```

真实云集成测试创建临时数据库和合成 Vault，结束后清理；普通 `npm test` 默认跳过这一项，避免强制要求 Python。指定其它 Python 时使用 `VAULTDESK_CLOUD_PYTHON`。桌面 UI 测试可设置 `VAULTDESK_TEST_MODE=1` 和指向合成库的 `VAULTDESK_VAULT`，使用独立临时用户数据。详细宿主接口和测试入口见 [桌面文档](desktop/README.md)。

目录分工：`app/` 为界面与编辑器，`core/` 为文档语义，`desktop/` 为安全宿主与同步客户端，`cloud/` 为自部署服务，`tests/` 为测试，`research/` 为 REA 衍生研究资料，`docs/parity.md` 为兼容验收边界。项目许可沿用父仓库 MIT 许可；依赖及打包声明见 [第三方说明](THIRD_PARTY_NOTICES.md)。
