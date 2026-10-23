import 'package:flutter/material.dart';
import 'store.dart';
import 'main.dart' show guarded, textDialog;

class BulkActions extends StatelessWidget {
  final Workspace store;
  final Set<String> ids;
  final VoidCallback onDone;
  const BulkActions({
    super.key,
    required this.store,
    required this.ids,
    required this.onDone,
  });
  @override
  Widget build(BuildContext context) => PopupMenuButton<String>(
    tooltip: '批量操作',
    enabled: ids.isNotEmpty && store.canEdit,
    onSelected: (action) => guarded(context, () async {
      final selected = Set<String>.of(ids);
      if (['未读', '阅读中', '已读'].contains(action)) {
        await store.bulkPapers(selected, statusValue: action);
      } else if (action == 'tags') {
        final tags = await textDialog(context, '批量添加标签', hint: '逗号分隔');
        if (tags == null) return;
        await store.bulkPapers(selected, addTags: tags.split(RegExp('[,，]')));
      } else if (action == 'move') {
        final target = await showDialog<String>(
          context: context,
          builder: (c) => SimpleDialog(
            title: const Text('移动所选文献到'),
            children: [
              SimpleDialogOption(
                onPressed: () => Navigator.pop(c, 'root'),
                child: const Text('未分类'),
              ),
              ...store
                  .list('folder')
                  .map(
                    (f) => SimpleDialogOption(
                      onPressed: () => Navigator.pop(c, f.id),
                      child: Text(store.folderPath(f.id)),
                    ),
                  ),
            ],
          ),
        );
        if (target == null) return;
        await store.bulkPapers(
          selected,
          moveFolder: true,
          folderId: target == 'root' ? null : target,
        );
      } else if (action == 'trash') {
        final yes = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            title: Text('将 ${selected.length} 篇文献移至回收站？'),
            content: const Text('可以从回收站逐篇恢复。'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, true),
                child: const Text('移入'),
              ),
            ],
          ),
        );
        if (yes != true) return;
        await store.bulkPapers(selected, trash: true);
      } else {
        await store.bulkPapers(selected, important: action == 'important');
      }
      onDone();
    }),
    itemBuilder: (_) => [
      for (final status in ['未读', '阅读中', '已读'])
        PopupMenuItem(value: status, child: Text('标为$status')),
      const PopupMenuItem(value: 'tags', child: Text('添加标签')),
      const PopupMenuItem(value: 'move', child: Text('移动到文件夹')),
      const PopupMenuItem(value: 'important', child: Text('标为重要')),
      const PopupMenuItem(value: 'normal', child: Text('取消重要')),
      const PopupMenuItem(value: 'trash', child: Text('移至回收站')),
    ],
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Text('批量操作（${ids.length}）'),
    ),
  );
}
