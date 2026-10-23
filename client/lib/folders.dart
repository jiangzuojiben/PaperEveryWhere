import 'package:flutter/material.dart';
import 'main.dart' show textDialog, guarded;
import 'store.dart';

class FolderTree extends StatefulWidget {
  final Workspace store;
  final String? selected;
  final ValueChanged<String?> onSelected;
  const FolderTree({
    super.key,
    required this.store,
    this.selected,
    required this.onSelected,
  });
  @override
  State<FolderTree> createState() => _FolderTreeState();
}

class _FolderTreeState extends State<FolderTree> {
  final collapsed = <String>{};
  Workspace get s => widget.store;

  Future<void> action(Entry folder, String action) => guarded(
    context,
    () async {
      if (action == 'rename') {
        final name = await textDialog(context, '重命名文件夹', initial: folder.title);
        if (name != null && name.trim().isNotEmpty) {
          await s.save('folder', {
            ...folder.data,
            'title': name.trim(),
          }, id: folder.id);
        }
      } else if (action == 'move') {
        final excluded = s.folderIds(folder.id);
        final target = await showDialog<String>(
          context: context,
          builder: (c) => SimpleDialog(
            title: const Text('移动文件夹到'),
            children: [
              SimpleDialogOption(
                onPressed: () => Navigator.pop(c, 'root'),
                child: const Text('根目录'),
              ),
              ...s
                  .list('folder')
                  .where((f) => !excluded.contains(f.id))
                  .map(
                    (f) => SimpleDialogOption(
                      onPressed: () => Navigator.pop(c, f.id),
                      child: Text(s.folderPath(f.id)),
                    ),
                  ),
            ],
          ),
        );
        if (target != null) {
          await s.save('folder', {
            ...folder.data,
            'parent_id': target == 'root' ? null : target,
          }, id: folder.id);
        }
      } else if (action == 'delete') {
        await s.save('folder', folder.data, id: folder.id, deleted: true);
        if (widget.selected == folder.id) widget.onSelected(null);
      }
    },
  );

  @override
  Widget build(BuildContext context) {
    final folders = s.list('folder');
    final visited = <String>{};
    final rows = <Widget>[];
    void append(Entry f, int depth) {
      if (!visited.add(f.id)) return;
      final children = folders
          .where((c) => c.data['parent_id'] == f.id)
          .toList();
      final empty = !s.entries.any(
        (e) =>
            !e.deleted &&
            (e.data['parent_id'] == f.id || s.paperFolderIds(e).contains(f.id)),
      );
      rows.add(
        Padding(
          padding: EdgeInsets.only(left: depth.clamp(0, 5) * 12.0),
          child: ListTile(
            dense: true,
            contentPadding: const EdgeInsets.only(left: 4),
            selected: widget.selected == f.id,
            leading: SizedBox(
              width: 34,
              child: children.isEmpty
                  ? const Icon(Icons.folder_outlined, size: 18)
                  : IconButton(
                      tooltip: collapsed.contains(f.id)
                          ? '展开 ${f.title}'
                          : '折叠 ${f.title}',
                      padding: EdgeInsets.zero,
                      icon: Icon(
                        collapsed.contains(f.id)
                            ? Icons.chevron_right
                            : Icons.expand_more,
                        size: 18,
                      ),
                      onPressed: () => setState(() {
                        if (!collapsed.add(f.id)) collapsed.remove(f.id);
                      }),
                    ),
            ),
            title: Text(
              f.title,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12),
            ),
            onTap: () => widget.onSelected(f.id),
            trailing: s.canEdit
                ? PopupMenuButton<String>(
                    tooltip: '${f.title} 文件夹操作',
                    onSelected: (v) => action(f, v),
                    itemBuilder: (_) => [
                      const PopupMenuItem(value: 'rename', child: Text('重命名')),
                      const PopupMenuItem(value: 'move', child: Text('移动文件夹')),
                      PopupMenuItem(
                        value: 'delete',
                        enabled: empty,
                        child: const Text('删除空文件夹'),
                      ),
                    ],
                  )
                : null,
          ),
        ),
      );
      if (!collapsed.contains(f.id)) {
        for (final c in children) {
          append(c, depth + 1);
        }
      } else {
        for (final id in s.folderIds(f.id)) {
          visited.add(id);
        }
      }
    }

    for (final f in folders.where(
      (f) => !folders.any((p) => p.id == f.data['parent_id']),
    )) {
      append(f, 0);
    }
    // Malformed legacy cycles are still reachable for repair.
    for (final f in folders.where((f) => !visited.contains(f.id))) {
      append(f, 0);
    }
    return Column(children: rows);
  }
}
