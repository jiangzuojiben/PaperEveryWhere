# PaperEveryWhere / PaperDesk

PaperEveryWhere 仓库中的应用名为 **PaperDesk**，使用 Flutter 和 FastAPI 独立实现文献阅读与批注客户端。本项目不是 ReadPaper 官方客户端；不分发原应用代码、图像资源或用户资料。

当前开发版 **0.5.0** 默认使用 ReadPaper 云端文献与批注服务，AI、翻译和视觉 OCR 使用自有服务。客户端及新网关只在会话内存中处理业务数据，不初始化本地文献数据库、磁盘 PDF 缓存或持久待同步队列。

## 在线模式开始使用

需要 Python 3.12、Flutter 3.47.7；Windows 构建还需 Visual Studio 的 C++ 桌面开发工具。Android 构建需要 JDK 17 和 Android SDK。先获取源码：

```powershell
git clone https://github.com/jiangzuojiben/PaperEveryWhere.git
cd PaperEveryWhere
```

1. 在本机 ReadPaper 正常登录，然后在源码根目录运行 `./scripts/start-backend.ps1`。首次运行会创建 Python 环境并安装依赖；默认网关为 `backend.cloud_main:app`，仅监听 `127.0.0.1:8765`。
2. 在另一个终端构建客户端：

   ```powershell
   cd client
   flutter pub get
   flutter build windows --release
   ```

   运行 `client/build/windows/x64/runner/Release/paperdesk.exe`，在设置中连接本机 ReadPaper 会话。Windows 中文路径若遇到工具链问题，见下方构建说明。
3. 自有 AI 与翻译基础地址、模型、Key 在设置中配置，仅在本次会话有效。Android 可在 `client` 下运行 `flutter build apk --debug`，输出为 `build/app/outputs/flutter-apk/app-debug.apk`。通过已连接 Windows 网关生成的短期连接码配对；跨设备网关需 HTTPS。

仓库只包含源码、测试、契约和脱敏研究摘要。文档中的 `artifacts/` 安装包及验证日志是本机交付产物，不随 Git 上传；克隆后请按上述步骤构建。原始 REA 输出、会话凭据、文献、批注、数据库和迁移备份也不在仓库中。

文献列表、文件夹、PDF、原批注、笔记与进度从 ReadPaper 读取；高亮、矩形、文本框的新增/修改/删除、阅读笔记与进度保存已在专用测试文献中真实写回，并经独立会话读回验证。PDF上传、去重及独立会话下载哈希核对通过。文献行菜单提供云端版本列表、选择及匹配新版本上传；真实选择和匹配新版本上传已在临时收录的公开测试论文验证，第二会话下载哈希一致；原生服务可能跨版本共享批注，界面提示核对坐标。独立PDF没有云端版本集合时明确提示。

**原生手写新增仍未打通**：已实现已知原手写路径读取、变宽显示和删除，但现有桌面样本不能提供经过验证的原生创建格式。不会以本地缓存或附件侧存冒充完成。附件上传、目录/标签写入及批量操作仍待适配；Android新模式端到端和真实AI调用未验收，不能将本版标记为完整复刻完成。

详见 [在线模式与数据生命周期](docs/online-mode.md)、[云服务研究](docs/readpaper-cloud-bridge-analysis.md)。已有本地迁移数据及备份不自动读取或删除。新网关不使用原本地优先版的数据库、对象存储或任务队列。

本轮真实写回、上传、版本和手写研究的逐项记录见 [0.5验证与剩余限制](docs/readpaper-live-write-20261023.md)。云端保留两份名称以 `PaperDesk-Cloud-Validation-` 开头的合成测试PDF，便于复核；原88篇文献和分类关系未变。源码包为 `artifacts/PaperDesk-0.5.0-source.zip`。

验证命令：`./.venv/Scripts/python.exe -m pytest backend/tests -q`；在 `client` 下运行 `flutter analyze --no-pub` 与 `flutter test --no-pub`。本轮没有操作桌面界面、安装或启动客户端。

原生手写后续研究见 [2026-10-23补充记录](docs/readpaper-native-ink-research-20261023.md)：确认旧记录入口及新批量路由的校验，但可绘制笔迹新增仍未通过；客户端包保持0.5.0，不能把空记录回执当作手写成功。

## 0.3 本地优先版本历史参考

以下记录保留原版本的功能、构建与持久化部署方式，不代表当前在线模式已支持这些能力。原 `compose.yaml` 为历史部署；在线容器配置为 `compose.online.yaml`，登录引导限制见在线模式文档。

## 开始使用

Windows 运行包位于 `artifacts/PaperDesk-0.3.0-Windows-x64.zip`。解压后运行 `paperdesk.exe`，保留同目录 DLL 和 `data/`。离线即可导入 PDF、阅读、批注、记笔记和建立全文索引；初始文献库为空。

包内 `Install.ps1` 可由你执行，将应用复制到当前用户的 `LocalAppData/Programs/PaperDesk` 并建立开始菜单快捷方式；无需第三方打包器。也可以直接使用便携程序。安装脚本本轮未执行。

启动本机后端：

```powershell
./.venv/Scripts/python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8765
```

打开客户端左下角设置，服务器填写 `http://127.0.0.1:8765`，注册独立账号。Android 模拟器访问本机填写 `http://10.0.2.2:8765`。各账号与离线工作区使用独立 SQLite 数据库；登录不会自动合并离线工作区，已有 PDF 可重新导入，旧账号数据通过迁移清单导入。

接口文档：运行后访问 [Swagger UI](http://127.0.0.1:8765/docs)。AI 和翻译分别配置兼容 Chat Completions 的基础地址、模型及 Key；密钥在服务器加密保存。OCR 需要 Tesseract 与 `eng`/`chi_sim` 语言包，Docker 镜像已包含。

## 已实现的路径

- PDF 导入与哈希去重、版本和附件；层级文件夹与移动、批量状态/标签/重要标记/回收站、阅读状态、重要标记、资料编辑、回收站恢复。
- PDF 阅读、目录与缩略图、文内查找、跨页文本高亮、手写压感数据、矩形/直线/文本框、橡皮擦、撤销/重做、仅笔输入和服务器导出。
- 多条分类 Markdown 笔记、选区摘录、删除撤销、Markdown 导出和块级公式预览、阅读页码、前台阅读时长统计；按页本地全文索引与搜索（不再截断本地索引）。
- 独立账号、令牌退出失效、分页增量同步、幂等重试、笔记冲突副本及合并界面。
- Crossref/OpenAlex 搜索、DOI 元数据逐字段预览补全、引用导出、引用关系及相关论文浏览；外部缺失字段不虚构。
- 服务商配置、论文问答/总结、图表提问/内嵌图像候选浏览、全文逐页对照翻译、异步 OCR，任务进度/取消/重试及历史结果恢复。
- 私密小组、编辑/只读成员管理、离线小组重启恢复及联网权限刷新、共享文献与讨论；标准清单迁移预览、去重、目录及已验证坐标转换。

本轮变更与逐项用例见 [Windows / Android 补齐记录](docs/windows-android-completion.md)。具体限制和验收状态见 [功能对照表](docs/feature-matrix.md) 与 [验证记录](docs/verification.md)。尤其是移动实机、原版私有批注迁移、图表自动识别和高保真逐屏对照，不能仅凭共享代码或静态分析认定通过。

## 自部署

```powershell
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r backend/requirements.lock
./.venv/Scripts/python.exe scripts/setup.py
docker compose up --build -d
```

服务包括 PostgreSQL、Redis、MinIO、API 和 Celery worker。默认只绑定本机 `127.0.0.1:8765`；供手机或小组远程使用时，在前面配置 HTTPS 反向代理。凭据初始化脚本不会覆盖已有 `.env`，请与备份一起保存。详细说明见 [部署及恢复](docs/deployment.md)。本机无 Docker，容器组合尚未实际启动验证。

## 构建与测试

```powershell
./.venv/Scripts/python.exe -m pytest backend/tests -q
cd client
flutter pub get
flutter analyze
flutter test
flutter build windows --release
flutter build apk --debug
```

Flutter 基线为 `3.47.7`，依赖由 `pubspec.lock` 固定。Windows 中文路径下分析器可能出错，可在空闲盘符上执行 `subst P: <项目绝对目录>`，之后从 `P:/client` 构建；Kotlin 增量编译已关闭，避免工程和 pub 缓存盘符不同导致的错误。

本机辅助脚本：`scripts/build-windows.ps1`、`scripts/build-android.ps1`。安装器定义为 `scripts/windows-installer.iss`，若已有 Inno Setup 编译器，Windows 脚本会额外输出 Setup.exe。未安装该编译器时仍输出便携 ZIP。

iOS 工程在 `client/ios`，需要 Mac/Xcode。在 Mac 上运行 `flutter build ios --release --no-codesign` 可验证未签名工程；设置自己的开发团队和 Bundle ID 后再签名分发。仓库包含三端 CI 配置，实际构建状态以 GitHub Actions 为准；未签名构建不能代替实机验收。

## 研究证据

本机样本为 ReadPaper `1.29.0`，ASAR SHA-256 为 `dcfcc05e97f1b143a90f3e3508b5183523c990ceba2397a79da8a00b0d2c0d60`。固定使用 `rea-agents@6.7.0`，成功入口分析与大 bundle 超时分别保留，详见 [研究记录](research/README.md)。首轮仅观察登录页；后续迁移、只读云端核对及专用测试文献写回的范围与限制，分别记录在链接的专题报告中。

项目代码许可证见 [LICENSE](LICENSE)，第三方组件与来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
