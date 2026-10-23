# Synthetic Layout and HTTP Probe

这是独立应用的补充验收插件，需在专用合成知识库中通过本地插件界面导入 `manifest.json` 与 `main.js`，再明确启用。它没有在参考程序执行，不属于 `public-api-probe` 的双端同脚本 29 项断言。

## 自定义视图

`Open synthetic counter` 新建计数为 1 的视图，其公开状态同时包含 `file:"Synthetic payload.md"` 和 `count`。`file` 是自定义数据字段，不表示打开该路径，也不要求该文件存在。

点击 `Increment synthetic counter` 只改变视图内存和 DOM，不请求保存。实际验收顺序为：

1. 增加到 2，通过应用工作区界面保存命名布局。
2. 增加到 3，恢复刚才的命名布局，界面应回到 2。
3. 执行 `Roundtrip synthetic layout`，通过公开 `getLayout/changeLayout` 往返，仍应是自定义类型且保留 `file` 和 `count:2`。

## HTTP

本地服务由 [plugin-http-fixture.mjs](../../../../scripts/plugin-http-fixture.mjs) 提供，只绑定 `127.0.0.1:28773`。`Run loopback HTTP checks` 仅访问该服务，Modal 中记录四项检查：同一 `requestUrl` promise 的响应/text/json/arrayBuffer、`request` 文本别名、`throw:false` 返回 404、默认 404 拒绝。

服务可用 `node scripts/plugin-http-fixture.mjs` 启动；验收完成后停止。此插件不连接互联网、真实账户或云服务，也不读写笔记正文。

[UI 驱动](../../../../scripts/plugin-layout-http-ui-smoke.js) 是接收现有 Playwright `page` 的回调，不是可直接用 Node 启动的完整脚本。它先验证库路径为 `output/desktop-ui-<时间戳>/vault`，再通过真实界面导入、点击与命令面板执行，最后输出 UTF-8 报告。结果见 [补充桌面报告](../../../windows-round3-plugin-layout-http-ui.json) 与 [验收说明](../../../../docs/windows-round3-plugin-ui-verification.md)。
