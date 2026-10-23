# PaperDesk 客户端

0.5默认入口为 `lib/main.dart`，使用 `CloudWorkspace` 和 ReadPaper 在线网关。业务数据与自有AI配置只在会话内存中；旧本地优先工作区保留在源码中供历史测试使用，默认入口不初始化它。

连接、构建和验收边界见项目根目录 `README.md` 与 `docs/online-mode.md`。测试包不等于端到端验收完成。

首次克隆后先在本目录执行 `flutter pub get`，之后可运行 `flutter analyze --no-pub` 和 `flutter test --no-pub`。Windows中文目录构建需参考根目录说明使用 ASCII 盘符映射。Android普通包必须使用 `lib/main.dart`，不可分发集成测试入口构建的APK。
