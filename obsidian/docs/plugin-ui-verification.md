# 插件浏览器界面验收

2026-10-23，使用 Playwright CLI 独立 `plugins` 会话访问本机开发服务器。仅使用应用自带演示知识库与“知识库概览”示例插件，没有读取真实用户知识库、账户或凭据。未连接或操作桌面原生验收会话。

**结果：示例插件的导入禁用、显式启用、命令注册与执行、显式停用与命令移除流程通过。** 这是开发版浏览器界面的有限验收，不代表任意社区插件或桌面打包环境兼容。

| 操作 | 实际结果 | 证据 |
| --- | --- | --- |
| 设置 → 本地插件 → 添加示例插件 | 显示“知识库概览 1.0.0”和“启用可信插件”；未出现插件运行通知 | [导入后禁用](../output/playwright/plugins/01-imported-disabled.png) |
| 启用前打开命令面板，筛选“知识库” | 只有原有“打开本地知识库”命令；示例插件命令尚未注册 | [启用前命令缺席](../output/playwright/plugins/02-before-enable-command-absent.png) |
| 返回设置，点击“启用可信插件” | 按钮变为“停用”，真实 Blob 模块加载成功 | [已启用](../output/playwright/plugins/03-enabled.png) |
| 命令面板筛选“显示知识库” | 出现“显示知识库笔记数量” | [插件命令可见](../output/playwright/plugins/04-command-visible.png) |
| 点击插件命令 | 通知显示“当前知识库有 4 篇 Markdown 笔记”，与演示库 Markdown 文件数一致；Canvas/Bases 不计入 | [命令执行结果](../output/playwright/plugins/05-command-count.png) |
| 点击“停用” | 恢复“启用可信插件”，显示插件已停用通知 | [显式停用](../output/playwright/plugins/06-disabled.png) |
| 停用后重新打开命令面板并筛选同一名称 | 显示“没有匹配结果”，插件命令已移除 | [停用后命令缺席](../output/playwright/plugins/07-after-disable-command-absent.png) |

控制台仅出现 React 开发工具提示，未观察到插件加载或执行错误。开发服务器期间有热更新，使第一次停用尝试前的界面重建；随后重新进入插件设置，在一次连续操作中完成明确启用、点击停用、确认命令消失。热更新本身未作为停用通过的证据。

导入阶段的界面证据证明插件保持禁用且没有注册可执行命令；源码仅在 `enable` 时运行的生命周期保证另见 [宿主回归测试](../tests/extensions.test.mjs) 和 [兼容范围](plugin-compatibility.md)。本轮未上传自定义插件，也未通过插件修改用户文件。

后续仍需桌面打包环境的 CSP/Blob 加载验收、真实文件桥接写入、Modal/设置界面验收以及选定社区插件逐项验证。插件运行于同一渲染器信任域，不能把有限 API 范围称为安全沙箱。

后续主线已在 Windows 便携程序中验证真实 CSP/Blob 加载、命令执行/停用，以及插件PDF页码导航；参见[便携程序实测](verification-2026-10-23.md)。原生环境仍未覆盖任意社区插件或全部宿主接口。
