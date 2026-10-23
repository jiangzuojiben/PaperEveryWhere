import 'package:flutter/material.dart';
import 'cloud_store.dart';
import 'store.dart';
import 'memory_import.dart';
import 'main.dart' show guarded;

Future<void> uploadCloudPdf(
  BuildContext context,
  CloudWorkspace store, {
  String? folderId,
  Entry? versionOf,
}) async {
  final sessionToken = store.token;
  final selected = await pickMemoryPdf();
  if (selected == null) return;
  if (sessionToken.isEmpty || store.token != sessionToken) {
    throw StateError('选择文件期间账号会话已变化，请在当前账号重新选择');
  }
  await store.importPdf(
    selected.bytes,
    selected.name,
    folderId: folderId,
    paper: versionOf,
  );
}

Future<String?> cloudVersionsDialog(
  BuildContext context,
  CloudWorkspace store,
  Entry paper,
) async {
  final data = await store.paperVersions(paper.id);
  if (!context.mounted) return null;
  var busy = false;
  return showDialog<String>(
    context: context,
    builder: (dialog) => StatefulBuilder(
      builder: (dialog, update) => AlertDialog(
        title: const Text('ReadPaper 云端版本'),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(paper.title),
                const SizedBox(height: 12),
                const Text('切换后重新读取PDF及云端笔记。ReadPaper可能在版本间共享批注，请核对原批注位置。'),
                if (data['supported'] != true)
                  Text(data['reason'] ?? '此文献暂无云端版本集合'),
                for (final version in data['versions'] as List)
                  ListTile(
                    leading: Icon(
                      version['current'] == true
                          ? Icons.check_circle_outline
                          : Icons.picture_as_pdf_outlined,
                    ),
                    title: Text(version['title']),
                    subtitle: Text(
                      '${version['group'] == 'private' ? '私有' : '公开'} · ${version['date']}',
                    ),
                    trailing: version['current'] == true
                        ? const Text('当前')
                        : null,
                    enabled: !busy && version['current'] != true,
                    onTap: () => guarded(dialog, () async {
                      update(() => busy = true);
                      try {
                        final target = await store.selectVersion(
                          paper.id,
                          version['pdf_id'],
                        );
                        if (dialog.mounted) Navigator.pop(dialog, target);
                      } finally {
                        if (dialog.mounted) update(() => busy = false);
                      }
                    }),
                  ),
                if (busy) const LinearProgressIndicator(),
                if (data['can_upload'] == true)
                  TextButton.icon(
                    onPressed: busy
                        ? null
                        : () => guarded(dialog, () async {
                            update(() => busy = true);
                            try {
                              await uploadCloudPdf(
                                dialog,
                                store,
                                versionOf: paper,
                              );
                              if (dialog.mounted) Navigator.pop(dialog);
                            } finally {
                              if (dialog.mounted) update(() => busy = false);
                            }
                          }),
                    icon: const Icon(Icons.upload_file),
                    label: const Text('上传此论文的新版本（由ReadPaper核对匹配）'),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: busy ? null : () => Navigator.pop(dialog),
            child: const Text('关闭'),
          ),
        ],
      ),
    ),
  );
}

Future<void> cloudUploadsDialog(
  BuildContext context,
  CloudWorkspace store,
) async {
  await store.refreshUploads();
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (dialog) => ListenableBuilder(
      listenable: store,
      builder: (dialog, _) => AlertDialog(
        title: const Text('本次会话上传'),
        content: SizedBox(
          width: 560,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('状态未知时先核对文献库，不自动重传。此列表退出后清空。'),
                if (store.uploads.isEmpty) const Text('本次会话暂无上传'),
                for (final upload in store.uploads)
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ListTile(
                        title: Text(upload['filename']),
                        subtitle: Text(
                          '${upload['state']}${upload['reason'] == null ? '' : '\n${upload['reason']}'}',
                        ),
                      ),
                      Wrap(
                        children: [
                          TextButton(
                            onPressed: () => guarded(
                              dialog,
                              () => store.updateUpload(upload['id']),
                            ),
                            child: const Text('核对状态'),
                          ),
                          if (upload['state'] == 'conflict') ...[
                            TextButton(
                              onPressed: () => guarded(
                                dialog,
                                () => store.updateUpload(
                                  upload['id'],
                                  keepExisting: true,
                                ),
                              ),
                              child: const Text('保留云端原件'),
                            ),
                            TextButton(
                              onPressed: () => guarded(dialog, () async {
                                final replace = await showDialog<bool>(
                                  context: dialog,
                                  builder: (confirmation) => AlertDialog(
                                    title: const Text('替换云端冲突文献？'),
                                    content: Text(
                                      'ReadPaper报告“${upload['filename']}”存在冲突。替换可能改变原件关联的PDF；原批注仍绑定原PDF，不保证迁入新版本。',
                                    ),
                                    actions: [
                                      TextButton(
                                        onPressed: () =>
                                            Navigator.pop(confirmation, false),
                                        child: const Text('取消'),
                                      ),
                                      FilledButton(
                                        onPressed: () =>
                                            Navigator.pop(confirmation, true),
                                        child: const Text('替换云端文献'),
                                      ),
                                    ],
                                  ),
                                );
                                if (replace == true) {
                                  await store.updateUpload(
                                    upload['id'],
                                    keepExisting: false,
                                  );
                                }
                              }),
                              child: const Text('查看替换选项'),
                            ),
                          ],
                          if ([
                            'processing',
                            'pending',
                          ].contains(upload['state']))
                            TextButton(
                              onPressed: () => guarded(
                                dialog,
                                () => store.updateUpload(
                                  upload['id'],
                                  cancel: true,
                                ),
                              ),
                              child: const Text('取消处理'),
                            ),
                        ],
                      ),
                    ],
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog),
            child: const Text('关闭'),
          ),
        ],
      ),
    ),
  );
}
