import 'dart:async';
import 'dart:convert';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'store.dart';

const noteCategories = {
  'summary': '总结',
  'excerpt': '摘录',
  'question': '问题',
  'idea': '想法',
  'vocabulary': '术语',
};

String noteLabel(Entry note) =>
    note.data['title']?.toString().trim().isNotEmpty == true
    ? note.data['title']
    : noteCategories[note.data['category']] ?? '笔记';

String notesMarkdown(String paperTitle, List<Entry> notes) =>
    '# $paperTitle\n\n${notes.map((n) => '## ${noteLabel(n)}\n\n'
        '${n.data['conflict_of'] != null ? '> 并发修改副本，请核对后合并。\n\n' : ''}'
        '${n.data['content'] ?? ''}\n').join('\n')}';

/// One editor per paper. Switching notes flushes the previous draft first.
class PaperNotes extends StatefulWidget {
  final Workspace store;
  final String paperId;
  final String? initialNoteId;
  final Widget Function(String) renderMarkdown;
  const PaperNotes({
    super.key,
    required this.store,
    required this.paperId,
    required this.renderMarkdown,
    this.initialNoteId,
  });
  @override
  State<PaperNotes> createState() => PaperNotesState();
}

class PaperNotesState extends State<PaperNotes> with WidgetsBindingObserver {
  Workspace get s => widget.store;
  final text = TextEditingController();
  Entry? baseline;
  late String id;
  String title = '', category = 'summary', status = '修改自动保存至本机';
  bool dirty = false, preview = false;
  Timer? timer;
  Future<void> saving = Future.value();
  int inFlight = 0;
  final ownSaves = <String, Entry>{};

  @override
  void initState() {
    super.initState();
    if (s.cloudOnly) status = '修改直接保存至 ReadPaper';
    WidgetsBinding.instance.addObserver(this);
    final notes = s.list('note', paperId: widget.paperId);
    final selected = notes.where((n) => n.id == widget.initialNoteId);
    select(selected.isNotEmpty ? selected.first : notes.firstOrNull);
    s.addListener(remoteChanged);
  }

  void select(Entry? note) {
    ownSaves.clear();
    baseline = note;
    id = note?.id ?? uuid.v4();
    text.text = note?.data['content'] ?? '';
    title = note?.data['title'] ?? '';
    category = note?.data['category'] ?? 'summary';
    dirty = false;
  }

  void remoteChanged() {
    if (!mounted) return;
    if (!dirty && inFlight == 0 && baseline != null) {
      final latest = s.entry(id);
      if (latest != null &&
          !latest.deleted &&
          latest.revision != baseline!.revision) {
        select(latest);
      }
    }
    setState(() {});
  }

  void edited() {
    dirty = true;
    status = '正在保存…';
    timer?.cancel();
    timer = Timer(const Duration(milliseconds: 700), flush);
    setState(() {});
  }

  Future<void> flush() {
    timer?.cancel();
    if (!dirty) return saving;
    dirty = false;
    final selectedId = id;
    final original = baseline;
    final data = {
      ...?original?.data,
      'paper_id': widget.paperId,
      'title': title,
      'category': category,
      'content': text.text,
      'modified': DateTime.now().toUtc().toIso8601String(),
    };
    inFlight++;
    saving = saving.catchError((Object _) {}).then((_) async {
      try {
        final previousSave = ownSaves[selectedId];
        final saved = await s.save(
          'note',
          data,
          id: previousSave?.id ?? selectedId,
          basedOn: previousSave ?? original,
        );
        ownSaves[selectedId] = saved;
        // Do not change the text controller: the user may already be typing.
        if (id == selectedId) {
          id = saved.id;
          baseline = saved;
        }
        if (mounted) {
          setState(
            () => status = saved.data['conflict_of'] != null
                ? '已保留并发修改副本'
                : s.cloudOnly
                ? '已保存至 ReadPaper'
                : '已保存至本机',
          );
        }
      } catch (e) {
        if (mounted) {
          setState(() {
            dirty = true;
            status = '保存失败：$e';
          });
        }
        rethrow;
      } finally {
        inFlight--;
      }
    });
    // Observe errors even when a timer or dispose owns the flush.
    unawaited(saving.catchError((Object _) {}));
    return saving;
  }

  void discardDraft() {
    timer?.cancel();
    dirty = false;
  }

  Future<void> act(String action) async {
    try {
      await flush();
      if (!mounted) return;
      if (action == 'new') {
        setState(() {
          select(null);
          title = '新笔记';
        });
        edited();
        await flush();
      } else if (action == 'rename') {
        final field = TextEditingController(text: title);
        final value = await showDialog<String>(
          context: context,
          builder: (c) => AlertDialog(
            title: const Text('笔记标题'),
            content: TextField(controller: field, autofocus: true),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, field.text.trim()),
                child: const Text('保存'),
              ),
            ],
          ),
        );
        // The closing dialog can still be animating; its controller is released later.
        Future<void>.delayed(const Duration(milliseconds: 400), field.dispose);
        if (value != null && mounted) {
          setState(() => title = value);
          edited();
        }
      } else if (action == 'delete' && baseline != null) {
        final removed = baseline!;
        await s.save('note', removed.data, id: removed.id, deleted: true);
        if (!mounted) return;
        setState(
          () => select(s.list('note', paperId: widget.paperId).firstOrNull),
        );
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text('笔记已删除'),
            action: SnackBarAction(
              label: '撤销',
              onPressed: () async {
                await flush();
                final restored = await s.save(
                  'note',
                  removed.data,
                  id: removed.id,
                );
                if (mounted) setState(() => select(restored));
              },
            ),
          ),
        );
      } else if (action == 'export') {
        await FilePicker.platform.saveFile(
          dialogTitle: '导出本篇全部笔记',
          fileName: 'paper-notes.md',
          type: FileType.custom,
          allowedExtensions: ['md'],
          bytes: utf8.encode(
            notesMarkdown(
              s.entry(widget.paperId)?.title ?? '文献笔记',
              s.list('note', paperId: widget.paperId),
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    if (!s.cloudOnly) unawaited(flush().catchError((Object _) {}));
    s.removeListener(remoteChanged);
    WidgetsBinding.instance.removeObserver(this);
    text.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      unawaited(flush().catchError((Object _) {}));
    }
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, bounds) {
      final notes = s.list('note', paperId: widget.paperId);
      return Column(
        children: [
          SizedBox(
            height: 40,
            child: Row(
              children: [
                Expanded(
                  child: DropdownButton<String>(
                    key: const ValueKey('note-selector'),
                    isExpanded: true,
                    underline: const SizedBox(),
                    value: notes.any((n) => n.id == id) ? id : null,
                    hint: const Text(
                      '总结 · Markdown / 公式',
                      style: TextStyle(fontSize: 12),
                    ),
                    items: notes
                        .map(
                          (n) => DropdownMenuItem(
                            value: n.id,
                            child: Text(
                              '${n.data['conflict_of'] != null ? '⚠ ' : ''}${noteLabel(n)}',
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                        )
                        .toList(),
                    onChanged: (value) async {
                      try {
                        await flush();
                        if (mounted && value != null) {
                          setState(() => select(s.entry(value)));
                        }
                      } catch (_) {
                        /* Keep the unsaved draft selected. */
                      }
                    },
                  ),
                ),
                IconButton(
                  tooltip: preview ? '编辑' : '预览',
                  visualDensity: VisualDensity.compact,
                  onPressed: () => setState(() => preview = !preview),
                  icon: Icon(
                    preview ? Icons.edit_outlined : Icons.visibility_outlined,
                    size: 18,
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: '笔记操作',
                  onSelected: act,
                  itemBuilder: (_) => [
                    if (s.canEdit && !s.cloudOnly) ...[
                      const PopupMenuItem(value: 'new', child: Text('新建笔记')),
                      const PopupMenuItem(
                        value: 'rename',
                        child: Text('重命名笔记'),
                      ),
                      if (baseline != null)
                        const PopupMenuItem(
                          value: 'delete',
                          child: Text('删除笔记'),
                        ),
                    ],
                    if (!s.cloudOnly)
                      const PopupMenuItem(
                        value: 'export',
                        child: Text('导出 Markdown'),
                      ),
                  ],
                ),
              ],
            ),
          ),
          if (bounds.maxHeight >= 220 && !s.cloudOnly)
            SizedBox(
              height: 34,
              child: Row(
                children: [
                  const Text('分类 ', style: TextStyle(fontSize: 11)),
                  Expanded(
                    child: DropdownButton<String>(
                      key: const ValueKey('note-category'),
                      isExpanded: true,
                      value: noteCategories.containsKey(category)
                          ? category
                          : null,
                      hint: Text(category),
                      underline: const SizedBox(),
                      items: noteCategories.entries
                          .map(
                            (c) => DropdownMenuItem(
                              value: c.key,
                              child: Text(
                                c.value,
                                style: const TextStyle(fontSize: 11),
                              ),
                            ),
                          )
                          .toList(),
                      onChanged: s.canEdit
                          ? (v) {
                              setState(() => category = v!);
                              edited();
                            }
                          : null,
                    ),
                  ),
                  if (baseline?.data['page'] != null)
                    Text('第 ${baseline!.data['page']} 页'),
                ],
              ),
            ),
          Expanded(
            child: preview
                ? SingleChildScrollView(child: widget.renderMarkdown(text.text))
                : TextField(
                    key: const ValueKey('note-content'),
                    controller: text,
                    readOnly: !s.canEdit,
                    expands: true,
                    minLines: null,
                    maxLines: null,
                    textAlignVertical: TextAlignVertical.top,
                    decoration: InputDecoration(
                      hintText: s.canEdit
                          ? '写下问题、方法和洞见…\n支持 Markdown 和双美元符号公式。'
                          : '当前小组为只读',
                    ),
                    onChanged: (_) => edited(),
                  ),
          ),
          if (bounds.maxHeight >= 150)
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                s.canEdit ? status : '只读成员',
                maxLines: 1,
                style: const TextStyle(fontSize: 10, color: Colors.grey),
              ),
            ),
        ],
      );
    },
  );
}
