# ReadPaper × REA 研究记录

日期：2026-10-22，Asia/Hong_Kong。目标样本：Windows ReadPaper 1.29.0，安装目录 `C:/Program Files (x86)/ReadPaper`。

本目录用于研究证据，不是原程序源码的再分发。PaperDesk 的图标和业务代码独立编写，没有复制原版 bundle 或图像资源到产品。

后续记录：当前账号资料迁移与原批注核对见 [迁移验收](../docs/readpaper-migration-20261022.md)；REA 云服务协议研究、有效权限及只读联机验证见 [云服务桥接分析](../docs/readpaper-cloud-bridge-analysis.md) 与 [机器摘要](readpaper-cloud-summary.json)。下文保留首轮观察的历史边界，不能代替后续状态。

## 固定基线

- 分析工具：npm `rea-agents@6.7.0`，现有缓存运行；没有修改用户 MCP 配置。
- 目标：`resources/app.asar`，SHA-256 `dcfcc05e97f1b143a90f3e3508b5183523c990ceba2397a79da8a00b0d2c0d60`。
- 包描述版本：1.29.0；入口 `dist/main/index.cjs`；含主进程、preload、renderer、引用插件及本机模块。
- 工具版本并不具备本地源码文档中所有新命令。`inspect-desktop-application` 返回 COMMAND_NOT_FOUND，改用已实际存在的 JavaScript 应用分析命令。

## 成功证据

`rea-entrypoints.json` 保存完整 Evidence，摘要为 `entrypoints-summary.json`。ID：

`ev_4783a30d573e54bfc749f1b5b4d6b10b6948a518f232a1f4c0c35de9fd440753`

只选择 `package.json`、`dist/renderer/index.html`、`dist/renderer/assets/Error.1bb43cd1.js`。参数上限：全局语义节点 600、每文件 300、每文件未知项 50、单源 45000ms。仍有 757 个 inventoried 文件未进入源分析，不能把完整清单身份当作完整行为覆盖。

## 失败证据

`rea-windows.json` 保存主 bundle 扩大分析的原始失败；`summary.json` 为摘要，stderr 单独保留。主进程 bundle 分析超时，返回部分 Evidence：

`ev_12f7d00370d8515882a074e11475e2be546bf7545ad65647e7aab51e781f025f`

此结果不证明 bundle 已分析完毕。对包目录、版本与静态文本的额外读取属于补充观察，不冒充 REA 运行时证据。

## 运行时边界

通过 computer-use 只读检查原版窗口，确认处于登录界面。没有操作登录、上传、删除、修改文献库，也没有读取或导出 Cookies/令牌。第一次窗口捕获显示了遮挡窗口；激活并重新核对目标后才确认 ReadPaper 登录页，错误捕获不作为原版 UI 依据。

因此：原版导入去重、批注坐标、重启恢复、离线同步及私有数据迁移尚未完成差分行为实验。PaperDesk 的这些实现目前由自己的契约和测试验证，不声称已证明与原版完全等价。

Android APK、iOS IPA 和移动设备样本均未提供。移动布局依据共享功能结构和可获取的官方说明设计，原版移动端 UI/运行行为待补齐证据。

## 官方参考

- [ReadPaper 功能说明](https://readpaper.com/doc/)
- [功能概览](https://readpaper.com/doc/en/feature.html)
- [Flutter 支持平台](https://docs.flutter.dev/reference/supported-platforms)
- [pdfrx 文档](https://pub.dev/packages/pdfrx)
- [OpenAlex API 关系查询](https://help.openalex.org/how-to/api-recipes/)

同目录的大型原始 JSON 留在本地，以 `.gitignore` 排除出源码提交；摘要、参数和复现脚本进入源码。
