import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'cloud_store.dart';
import 'reader.dart';
import 'main.dart' show guarded;
import 'cloud_library_actions.dart';

class CloudHome extends StatefulWidget {
  final CloudWorkspace store;
  const CloudHome({super.key, required this.store});
  @override
  State<CloudHome> createState() => _CloudHomeState();
}

class _CloudHomeState extends State<CloudHome> with WidgetsBindingObserver {
  CloudWorkspace get s => widget.store;
  final query = TextEditingController();
  String? folder;
  bool busy = false;
  Timer? refresh;
  void sessionChanged() {
    if (s.token.isEmpty) {
      query.clear();
      folder = null;
    }
    if (mounted) setState(() {});
  }

  @override
  void initState() {
    super.initState();
    s.addListener(sessionChanged);
    WidgetsBinding.instance.addObserver(this);
    refresh = Timer.periodic(
      const Duration(minutes: 2),
      (_) => unawaited(s.sync()),
    );
  }

  @override
  void dispose() {
    s.removeListener(sessionChanged);
    refresh?.cancel();
    query.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.detached) unawaited(s.close());
  }

  Future<void> open(String id) => guarded(context, () async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await s.openPaper(id);
      if (!mounted) return;
      await Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => Reader(store: s, paperId: id),
        ),
      );
      await s.releasePaperSession(id);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  });

  @override
  Widget build(BuildContext context) {
    final papers = s
        .list('paper')
        .where(
          (p) =>
              (folder == null || s.paperInFolder(p, folder!)) &&
              p.title.toLowerCase().contains(query.text.toLowerCase()),
        )
        .toList();
    return Scaffold(
      appBar: AppBar(
        title: const Text('PaperDesk'),
        actions: [
          if (s.token.isNotEmpty) ...[
            IconButton(
              tooltip: '上传PDF',
              onPressed: busy
                  ? null
                  : () => guarded(context, () async {
                      setState(() => busy = true);
                      try {
                        await uploadCloudPdf(context, s, folderId: folder);
                      } finally {
                        if (mounted) setState(() => busy = false);
                      }
                    }),
              icon: const Icon(Icons.upload_file_outlined),
            ),
            IconButton(
              tooltip: '本次上传',
              onPressed: () =>
                  guarded(context, () => cloudUploadsDialog(context, s)),
              icon: const Icon(Icons.cloud_upload_outlined),
            ),
          ],
          IconButton(
            tooltip: '刷新 ReadPaper',
            onPressed: s.token.isEmpty ? null : () => s.sync(),
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            tooltip: '主题',
            onPressed: s.toggleDark,
            icon: const Icon(Icons.brightness_6_outlined),
          ),
          IconButton(
            tooltip: '云端连接与自有AI',
            onPressed: () => cloudSettings(context, s),
            icon: const Icon(Icons.settings_outlined),
          ),
        ],
      ),
      body: Column(
        children: [
          Material(
            color: Theme.of(context).colorScheme.surfaceContainerLow,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  const Icon(Icons.cloud_outlined, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${s.status} · 本地不保留文献和批注',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                  if (busy)
                    const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                ],
              ),
            ),
          ),
          if (s.token.isEmpty)
            Expanded(
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.cloud_queue, size: 64),
                    const SizedBox(height: 20),
                    const Text('连接 ReadPaper，在线阅读与批注'),
                    const SizedBox(height: 8),
                    const Text('AI 使用自有服务，内容仅在本次会话中使用。'),
                    const SizedBox(height: 20),
                    FilledButton(
                      onPressed: () => cloudSettings(context, s),
                      child: const Text('连接 ReadPaper'),
                    ),
                  ],
                ),
              ),
            )
          else ...[
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: query,
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(
                        prefixIcon: Icon(Icons.search),
                        hintText: '搜索当前云端文献列表',
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text('${papers.length} 篇'),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: DropdownButtonFormField<String>(
                initialValue: folder ?? '',
                isExpanded: true,
                items: [
                  const DropdownMenuItem(value: '', child: Text('全部文献')),
                  ...s
                      .list('folder')
                      .map(
                        (f) => DropdownMenuItem(
                          value: f.id,
                          child: Text(s.folderPath(f.id)),
                        ),
                      ),
                ],
                onChanged: (v) => setState(() => folder = v == '' ? null : v),
              ),
            ),
            Expanded(
              child: ListView.separated(
                itemCount: papers.length,
                separatorBuilder: (_, i) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final p = papers[i];
                  return ListTile(
                    leading: const Icon(Icons.picture_as_pdf_outlined),
                    title: Text(p.title),
                    subtitle: Text(
                      s.paperFolderIds(p).map(s.folderPath).join(' · '),
                    ),
                    trailing: PopupMenuButton<String>(
                      enabled: !busy,
                      onSelected: (action) => guarded(context, () async {
                        final target = await cloudVersionsDialog(context, s, p);
                        if (target != null && mounted) await open(target);
                      }),
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'versions', child: Text('云端版本管理')),
                      ],
                    ),
                    onTap: busy ? null : () => open(p.id),
                  );
                },
              ),
            ),
          ],
        ],
      ),
    );
  }
}

Future<void> cloudSettings(BuildContext context, CloudWorkspace s) async {
  final gateway = TextEditingController(text: s.endpoint),
      code = TextEditingController();
  final ai = TextEditingController(),
      model = TextEditingController(),
      key = TextEditingController();
  final translation = TextEditingController(),
      translationModel = TextEditingController(),
      translationKey = TextEditingController();
  if (s.token.isNotEmpty) {
    await guarded(context, () async {
      final p = await s.request('GET', '/providers');
      ai.text = p['ai']?['endpoint'] ?? '';
      model.text = p['ai']?['model'] ?? '';
      translation.text = p['translation']?['endpoint'] ?? '';
      translationModel.text = p['translation']?['model'] ?? '';
    });
  }
  if (!context.mounted) return;
  await showDialog(
    context: context,
    builder: (c) => StatefulBuilder(
      builder: (c, update) => AlertDialog(
        title: const Text('云端连接与自有 AI'),
        content: SizedBox(
          width: 560,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('登录和服务配置仅用于本次会话，退出后清除。'),
                const SizedBox(height: 12),
                TextField(
                  controller: gateway,
                  decoration: const InputDecoration(
                    labelText: 'PaperDesk 在线网关地址',
                  ),
                ),
                if (s.token.isEmpty) ...[
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: () => guarded(c, () async {
                      await s.connect(gateway.text);
                      if (c.mounted) Navigator.pop(c);
                    }),
                    child: const Text('使用本机已登录的 ReadPaper'),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: code,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: '跨设备连接码（两分钟内有效）',
                    ),
                  ),
                  TextButton(
                    onPressed: () => guarded(c, () async {
                      await s.connect(
                        gateway.text,
                        pairingCode: code.text.trim(),
                      );
                      if (c.mounted) Navigator.pop(c);
                    }),
                    child: const Text('使用连接码登录'),
                  ),
                ] else ...[
                  Row(
                    children: [
                      TextButton(
                        onPressed: () => guarded(c, () async {
                          final value = await s.request(
                            'POST',
                            '/auth/pairing',
                          );
                          if (c.mounted) {
                            await showDialog(
                              context: c,
                              builder: (d) => AlertDialog(
                                title: const Text('本次会话连接码'),
                                content: SelectableText(value['code']),
                                actions: [
                                  TextButton(
                                    onPressed: () => Clipboard.setData(
                                      ClipboardData(text: value['code']),
                                    ),
                                    child: const Text('复制连接码'),
                                  ),
                                  TextButton(
                                    onPressed: () => Navigator.pop(d),
                                    child: const Text('关闭'),
                                  ),
                                ],
                              ),
                            );
                          }
                        }),
                        child: const Text('创建跨设备连接码'),
                      ),
                      TextButton(
                        onPressed: () => guarded(c, () async {
                          await s.logout();
                          if (c.mounted) Navigator.pop(c);
                        }),
                        child: const Text('退出并清理会话'),
                      ),
                    ],
                  ),
                  const Divider(),
                  const Text('自有 AI 服务'),
                  const SizedBox(height: 8),
                  for (final f in [
                    (ai, 'AI基础地址（含 /v1）'),
                    (model, '模型'),
                    (key, 'API Key，留空保留本次配置'),
                    (translation, '翻译基础地址（可独立配置）'),
                    (translationModel, '翻译模型'),
                    (translationKey, '翻译 API Key'),
                  ])
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: TextField(
                        controller: f.$1,
                        obscureText: f.$1 == key || f.$1 == translationKey,
                        decoration: InputDecoration(labelText: f.$2),
                      ),
                    ),
                  FilledButton(
                    onPressed: () => guarded(c, () async {
                      for (final provider in [
                        ('ai', ai, model, key),
                        (
                          'translation',
                          translation,
                          translationModel,
                          translationKey,
                        ),
                      ]) {
                        if (provider.$2.text.trim().isNotEmpty) {
                          await s.request('PUT', '/providers/${provider.$1}', {
                            'endpoint': provider.$2.text.trim(),
                            'model': provider.$3.text.trim(),
                            if (provider.$4.text.isNotEmpty)
                              'api_key': provider.$4.text,
                          });
                        }
                      }
                      if (c.mounted) Navigator.pop(c);
                    }),
                    child: const Text('应用于本次会话'),
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c),
            child: const Text('关闭'),
          ),
        ],
      ),
    ),
  );
  // Release controllers after the closing animation no longer uses their fields.
  await Future<void>.delayed(const Duration(milliseconds: 300));
  for (final controller in [
    gateway,
    code,
    ai,
    model,
    key,
    translation,
    translationModel,
    translationKey,
  ]) {
    controller.clear();
    controller.dispose();
  }
}
