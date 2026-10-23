import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:file_picker/file_picker.dart';
import 'package:pdfrx/pdfrx.dart';
import 'store.dart';
import 'relations.dart';
import 'notes.dart';
import 'annotation_tools.dart';
import 'main.dart' show guarded, textDialog;

class Reader extends StatefulWidget {
  final Workspace store;
  final String paperId;
  final int initialTab;
  final String? initialNoteId;
  const Reader({
    super.key,
    required this.store,
    required this.paperId,
    this.initialTab = 0,
    this.initialNoteId,
  });
  @override
  State<Reader> createState() => _ReaderState();
}

class _ReaderState extends State<Reader> with WidgetsBindingObserver {
  Workspace get s => widget.store;
  Entry get paper => s.entry(widget.paperId)!;
  final controller = PdfViewerController();
  PdfTextSearcher? searcher;
  final question = TextEditingController(), search = TextEditingController();
  Uint8List? bytes;
  String? error, jobId;
  String tool = 'select', color = '#edb83c';
  int pageNumber = 1, totalPages = 0, tab = 0;
  bool panel = true, contents = false;
  bool indexing = false;
  bool penOnly = false;
  late final AnnotationEdits annotationEdits;
  double indexProgress = 0;
  List<PdfOutlineNode> outline = [];
  Map<String, dynamic>? job;
  Timer? progressTimer, jobTimer;
  DateTime? started = DateTime.now();
  String? progressId;
  String? selectedNoteId;
  bool progressDirty = false;
  final _cloudNotesKey = GlobalKey<PaperNotesState>();
  bool _allowExit = false, _leaving = false;
  bool _refreshing = false;

  Future<void> refreshCloudState() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    try {
      if (s.cloudOnly) {
        await _cloudNotesKey.currentState?.flush();
        await saveProgress();
      }
      await s.refreshPaperSession(widget.paperId);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  Future<void> leaveCloudReader() async {
    if (_leaving) return;
    _leaving = true;
    try {
      await _cloudNotesKey.currentState?.flush();
      await saveProgress();
    } catch (_) {
      if (!mounted) return;
      final discard = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('云端尚未确认保存'),
          content: const Text('当前草稿只存在本次会话中。退出将放弃未保存修改。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('继续编辑'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text('放弃修改并退出'),
            ),
          ],
        ),
      );
      if (discard != true) {
        _leaving = false;
        return;
      }
      _cloudNotesKey.currentState?.discardDraft();
    }
    if (!mounted) return;
    setState(() => _allowExit = true);
    // Let PopScope register the new permission before popping.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.pop(context);
    });
  }

  @override
  void initState() {
    super.initState();
    tab = widget.initialTab;
    selectedNoteId = widget.initialNoteId;
    annotationEdits = AnnotationEdits(s);
    WidgetsBinding.instance.addObserver(this);
    s.addListener(changed);
    final progress =
        s
            .list('progress', paperId: widget.paperId)
            .where(
              (p) =>
                  p.data['file_hash'] == null ||
                  p.data['file_hash'] == paper.data['file_hash'],
            )
            .toList()
          ..sort(
            (a, b) =>
                '${b.data['date'] ?? ''}'.compareTo('${a.data['date'] ?? ''}'),
          );
    if (progress.isNotEmpty) {
      pageNumber = progress.first.data['page'] ?? 1;
    }
    progressId =
        progress.where((p) => p.data['device'] == s.deviceId).firstOrNull?.id ??
        uuid.v4();
    load();
  }

  void changed() {
    if (mounted) setState(() {});
  }

  Future<void> load() async {
    try {
      final content = await s.pdf(paper);
      if (mounted) {
        setState(() {
          bytes = content;
          if (content == null) error = '这条文献尚未关联 PDF，请返回文献库添加文件版本。';
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      started = DateTime.now();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      recordSession();
    }
  }

  void recordSession() {
    if (started == null) return;
    final seconds = DateTime.now().difference(started!).inSeconds;
    started = null;
    if (seconds > 0 && s.canEdit && !s.cloudOnly) {
      unawaited(
        s
            .save('session', {
              'paper_id': widget.paperId,
              'seconds': seconds,
              'date': DateTime.now().toUtc().toIso8601String(),
            })
            .catchError((Object e) => Entry('', '', '', 0, {})),
      );
    }
  }

  @override
  void dispose() {
    progressTimer?.cancel();
    if (!s.cloudOnly) unawaited(saveProgress().catchError((Object _) {}));
    jobTimer?.cancel();
    recordSession();
    s.removeListener(changed);
    WidgetsBinding.instance.removeObserver(this);
    searcher?.dispose();
    question.dispose();
    search.dispose();
    if (s.cloudOnly) {
      bytes = null;
      job = null;
      outline = [];
    }
    super.dispose();
  }

  Future<void> saveProgress() async {
    if (!progressDirty || !s.canEdit) return;
    await s.save('progress', {
      'paper_id': widget.paperId,
      'file_hash': paper.data['file_hash'],
      'page': pageNumber,
      'total_pages': totalPages,
      'device': s.deviceId,
      'date': DateTime.now().toUtc().toIso8601String(),
    }, id: progressId);
    progressDirty = false;
  }

  Future<void> addAnnotation(Map<String, dynamic> data) async {
    await annotationEdits.write({
      'paper_id': widget.paperId,
      'file_hash': paper.data['file_hash'],
      'color': color,
      ...data,
    });
    if (mounted) setState(() {});
  }

  Future<void> eraseAnnotation(String id) => guarded(context, () async {
    final annotation = s.entry(id);
    if (annotation == null || annotation.deleted) return;
    await annotationEdits.write(annotation.data, id: id, deleted: true);
    if (mounted) setState(() {});
  });

  Future<void> indexLocal() => guarded(context, () async {
    if (!controller.isReady || indexing) return;
    setState(() {
      indexing = true;
      indexProgress = 0;
    });
    try {
      final fileHash = paper.data['file_hash'] as String;
      final document = controller.document;
      for (int index = 0; index < document.pages.length; index++) {
        if (!mounted) return;
        final text = await document.pages[index].loadStructuredText();
        await s.indexPage(widget.paperId, fileHash, index + 1, text.fullText);
        if (!mounted) return;
        setState(() => indexProgress = (index + 1) / document.pages.length);
      }
    } finally {
      if (mounted) setState(() => indexing = false);
    }
  });

  Future<void> highlight() => guarded(context, () async {
    if (!controller.isReady ||
        !controller.textSelectionDelegate.isCopyAllowed) {
      return;
    }
    final ranges = await controller.textSelectionDelegate
        .getSelectedTextRanges();
    if (ranges.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('先用选择工具选中文本，再添加高亮。')));
      }
      return;
    }
    for (final range in ranges) {
      final page = controller.document.pages[range.pageNumber - 1];
      final rects = range.enumerateFragmentBoundingRects().map((fragment) {
        final r = fragment.bounds.toRectInDocument(
          page: page,
          pageRect: Rect.fromLTWH(0, 0, 1, 1),
        );
        return [
          r.left.clamp(0.0, 1.0),
          r.top.clamp(0.0, 1.0),
          r.right.clamp(0.0, 1.0),
          r.bottom.clamp(0.0, 1.0),
        ];
      }).toList();
      await addAnnotation({
        'type': 'highlight',
        'page': range.pageNumber,
        'text': range.text,
        'rects': rects,
        'anchor': {'start': range.start, 'end': range.end, 'quote': range.text},
      });
    }
    await controller.textSelectionDelegate.clearTextSelection();
  });

  Future<void> excerpt() => guarded(context, () async {
    if (!s.canEdit || !controller.isReady) return;
    final ranges = await controller.textSelectionDelegate
        .getSelectedTextRanges();
    if (ranges.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('先选择需要摘录的原文。')));
      }
      return;
    }
    if (s.cloudOnly) await _cloudNotesKey.currentState?.flush();
    final existing = s.cloudOnly
        ? s.list('note', paperId: paper.id).firstOrNull
        : null;
    final note = await s.save(
      'note',
      {
        ...?existing?.data,
        'paper_id': paper.id,
        'file_hash': paper.data['file_hash'],
        'category': 'excerpt',
        'title': '摘录 · 第${ranges.first.pageNumber}页',
        'page': ranges.first.pageNumber,
        'content':
            '${s.cloudOnly && existing != null ? '${existing.data['content']}\n\n' : ''}${ranges.map((r) => '> ${r.text.replaceAll('\n', '\n> ')}').join('\n\n')}',
        'anchors': [
          for (final r in ranges)
            {
              'page': r.pageNumber,
              'start': r.start,
              'end': r.end,
              'quote': r.text,
            },
        ],
      },
      id: existing?.id,
      basedOn: existing,
    );
    if (mounted) {
      setState(() {
        selectedNoteId = note.id;
        tab = 1;
        panel = true;
      });
    }
    await controller.textSelectionDelegate.clearTextSelection();
  });

  Future<void> startJob(String kind, {String image = '', int? sourcePage}) =>
      guarded(context, () async {
        if (s.token.isEmpty) throw Exception('请先登录并配置服务');
        await s.sync();
        final created = await s.request('POST', '/jobs', {
          'kind': kind,
          'paper_id': widget.paperId,
          'file_hash': paper.data['file_hash'],
          'question': question.text,
          'image_base64': image,
          'pages': kind == 'figure' || (s.cloudOnly && kind == 'ocr')
              ? [sourcePage ?? pageNumber]
              : <int>[],
        });
        await watchJob(kind, created['id']);
      });

  Future<void> watchJob(String kind, String identifier) async {
    jobId = identifier;
    jobTimer?.cancel();
    if (mounted) {
      setState(() => job = {'state': 'queued', 'progress': 0, 'kind': kind});
    }
    bool polling = false;
    Future<void> poll() async {
      if (polling || jobId != identifier || !mounted) return;
      polling = true;
      try {
        final result = await s.request('GET', '/jobs/$identifier');
        if (!mounted || jobId != identifier) return;
        setState(() => job = Map<String, dynamic>.from(result));
        if (['completed', 'failed', 'cancelled'].contains(result['state'])) {
          jobTimer?.cancel();
          if (result['state'] == 'completed' &&
              ['extract', 'ocr'].contains(kind) &&
              s.canEdit &&
              !s.cloudOnly &&
              result['result']['file_hash'] == paper.data['file_hash']) {
            final text = (result['result']['pages'] as List)
                .map((p) => p['text'])
                .join('\n');
            await s.save('paper', {
              ...paper.data,
              'full_text': text.length > 700000
                  ? text.substring(0, 700000)
                  : text,
            }, id: paper.id);
          }
        }
      } catch (error) {
        if (mounted && jobId == identifier) {
          jobTimer?.cancel();
          setState(
            () => job = {
              'state': 'failed',
              'kind': kind,
              'error': error.toString(),
            },
          );
        }
      } finally {
        polling = false;
      }
    }

    jobTimer = Timer.periodic(const Duration(seconds: 2), (_) => poll());
    await poll();
  }

  Future<void> export() => guarded(context, () async {
    await s.sync();
    final result = await s.getBytes('/papers/${widget.paperId}/export.pdf');
    await FilePicker.platform.saveFile(
      dialogTitle: '导出带批注 PDF',
      fileName: '${paper.title}-批注.pdf',
      bytes: result,
      type: FileType.custom,
      allowedExtensions: ['pdf'],
    );
  });

  Widget tools() => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      children: [
        IconButton(
          tooltip: '目录 / 缩略图',
          onPressed: () => guarded(context, () async {
            if (s.cloudOnly) await _cloudNotesKey.currentState?.flush();
            if (mounted) setState(() => contents = !contents);
          }),
          icon: const Icon(Icons.view_sidebar_outlined, size: 20),
        ),
        for (final choice
            in [
              ('select', Icons.near_me_outlined, '选择文本'),
              ('ink', Icons.draw_outlined, '手写'),
              ('rectangle', Icons.crop_square, '矩形'),
              ('line', Icons.horizontal_rule, '直线'),
              ('text', Icons.text_fields, '文本框'),
              ('erase', Icons.auto_fix_normal_outlined, '橡皮擦'),
            ].where(
              (c) =>
                  ['select', 'erase'].contains(c.$1) ||
                  s.annotationTypes.contains(c.$1),
            ))
          IconButton(
            tooltip: choice.$3,
            isSelected: tool == choice.$1,
            selectedIcon: Icon(
              choice.$2,
              color: Theme.of(context).colorScheme.primary,
              size: 20,
            ),
            onPressed: !s.canEdit && choice.$1 != 'select'
                ? null
                : () => setState(() => tool = choice.$1),
            icon: Icon(choice.$2, size: 20),
          ),
        IconButton(
          tooltip: '高亮选区',
          onPressed: s.canEdit ? highlight : null,
          icon: const Icon(Icons.border_color_outlined, size: 20),
        ),
        IconButton(
          tooltip: '摘录选区到笔记',
          onPressed: s.canEdit ? excerpt : null,
          icon: const Icon(Icons.playlist_add_outlined, size: 20),
        ),
        IconButton(
          tooltip: '撤销批注',
          icon: const Icon(Icons.undo, size: 20),
          onPressed: s.canEdit && !s.cloudOnly && annotationEdits.canUndo
              ? () => guarded(context, () async {
                  await annotationEdits.undo();
                  if (mounted) setState(() {});
                })
              : null,
        ),
        IconButton(
          tooltip: '重做批注',
          icon: const Icon(Icons.redo, size: 20),
          onPressed: s.canEdit && !s.cloudOnly && annotationEdits.canRedo
              ? () => guarded(context, () async {
                  await annotationEdits.redo();
                  if (mounted) setState(() {});
                })
              : null,
        ),
        IconButton(
          tooltip: penOnly ? '仅手写笔或鼠标（已开启）' : '仅手写笔或鼠标',
          isSelected: penOnly,
          icon: const Icon(Icons.edit_outlined, size: 20),
          onPressed: () => setState(() => penOnly = !penOnly),
        ),
        for (final value in ['#edb83c', '#75b797', '#849be6', '#df86a1'])
          InkWell(
            onTap: () => setState(() => color = value),
            child: Container(
              width: 17,
              height: 17,
              margin: const EdgeInsets.symmetric(horizontal: 4),
              decoration: BoxDecoration(
                color: parseColor(value),
                shape: BoxShape.circle,
                border: color == value
                    ? Border.all(color: Colors.black54, width: 2)
                    : null,
              ),
            ),
          ),
        const SizedBox(width: 14),
        IconButton(
          tooltip: '缩小',
          onPressed: () {
            if (controller.isReady) controller.zoomDown();
          },
          icon: const Icon(Icons.remove, size: 18),
        ),
        Text('$pageNumber / $totalPages', style: const TextStyle(fontSize: 11)),
        IconButton(
          tooltip: '放大',
          onPressed: () {
            if (controller.isReady) controller.zoomUp();
          },
          icon: const Icon(Icons.add, size: 18),
        ),
        IconButton(
          tooltip: '导出带批注 PDF',
          onPressed: s.cloudOnly ? null : export,
          icon: const Icon(Icons.file_download_outlined, size: 20),
        ),
        IconButton(
          tooltip: '资料与笔记',
          onPressed: () => guarded(context, () async {
            if (s.cloudOnly) await _cloudNotesKey.currentState?.flush();
            if (mounted) setState(() => panel = !panel);
          }),
          icon: const Icon(Icons.notes_outlined, size: 20),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !s.cloudOnly || _allowExit,
    onPopInvokedWithResult: (didPop, result) {
      if (!didPop && s.cloudOnly) unawaited(leaveCloudReader());
    },
    child: Scaffold(
      appBar: AppBar(
        title: Text(paper.title, style: const TextStyle(fontSize: 15)),
        actions: [
          IconButton(
            tooltip: s.cloudOnly ? '保存草稿并刷新云端批注' : '同步',
            onPressed: _refreshing
                ? null
                : () => guarded(context, refreshCloudState),
            icon: const Icon(Icons.cloud_sync_outlined),
          ),
        ],
      ),
      body: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth > 1000;
          return Column(
            children: [
              Material(
                color: Theme.of(context).colorScheme.surface,
                child: tools(),
              ),
              const Divider(),
              Expanded(
                child: Row(
                  children: [
                    if (contents && wide)
                      SizedBox(width: 210, child: contentsPanel()),
                    Expanded(
                      child: error != null
                          ? Center(
                              child: Padding(
                                padding: const EdgeInsets.all(24),
                                child: Text(error!),
                              ),
                            )
                          : bytes == null
                          ? const Center(child: CircularProgressIndicator())
                          : PdfViewer.data(
                              bytes!,
                              sourceName: paper.id,
                              controller: controller,
                              initialPageNumber: pageNumber,
                              params: PdfViewerParams(
                                backgroundColor: s.dark
                                    ? const Color(0xff242733)
                                    : const Color(0xffe8eaf0),
                                margin: 22,
                                panEnabled: tool == 'select',
                                scaleEnabled: tool == 'select',
                                textSelectionParams: PdfTextSelectionParams(
                                  enabled: tool == 'select',
                                ),
                                pagePaintCallbacks: [
                                  if (searcher != null)
                                    searcher!.pageTextMatchPaintCallback,
                                ],
                                onViewerReady: (document, viewerController) {
                                  searcher?.dispose();
                                  if (mounted) {
                                    setState(
                                      () => searcher = PdfTextSearcher(
                                        viewerController,
                                      ),
                                    );
                                  }
                                },
                                onDocumentChanged: (doc) async {
                                  if (doc == null) return;
                                  final items = await doc.loadOutline();
                                  if (mounted) {
                                    setState(() {
                                      totalPages = doc.pages.length;
                                      progressDirty = true;
                                      outline = items;
                                    });
                                  }
                                },
                                onPageChanged: (number) {
                                  if (number == null) return;
                                  pageNumber = number;
                                  progressDirty = true;
                                  progressTimer?.cancel();
                                  progressTimer = Timer(
                                    const Duration(milliseconds: 700),
                                    () => unawaited(
                                      saveProgress().catchError((Object _) {}),
                                    ),
                                  );
                                  if (mounted) setState(() {});
                                },
                                pageOverlaysBuilder: (context, pageRect, page) => [
                                  Positioned.fill(
                                    child: AnnotationLayer(
                                      key: ValueKey(
                                        '${paper.data['file_hash']}:${page.pageNumber}',
                                      ),
                                      mode: s.canEdit ? tool : 'select',
                                      color: color,
                                      penOnly: penOnly,
                                      onErase: eraseAnnotation,
                                      annotations: s
                                          .list(
                                            'annotation',
                                            paperId: widget.paperId,
                                          )
                                          .where(
                                            (e) =>
                                                e.data['page'] ==
                                                    page.pageNumber &&
                                                e.data['file_hash'] ==
                                                    paper.data['file_hash'],
                                          )
                                          .map((e) => {...e.data, '_id': e.id})
                                          .toList(),
                                      onCreate: (data) async {
                                        await guarded(
                                          context,
                                          () => addAnnotation({
                                            ...data,
                                            'page': page.pageNumber,
                                          }),
                                        );
                                      },
                                    ),
                                  ),
                                ],
                              ),
                            ),
                    ),
                    if (panel && wide) SizedBox(width: 355, child: sidePanel()),
                  ],
                ),
              ),
              if (!wide && (panel || contents))
                SizedBox(
                  height: constraints.maxHeight * .40,
                  child: contents ? contentsPanel() : sidePanel(),
                ),
            ],
          );
        },
      ),
    ),
  );

  Widget contentsPanel() {
    Iterable<Widget> nodes(List<PdfOutlineNode> values, int depth) sync* {
      for (final node in values) {
        yield ListTile(
          dense: true,
          contentPadding: EdgeInsets.only(left: 12 + depth * 10, right: 10),
          title: Text(node.title, style: const TextStyle(fontSize: 11)),
          onTap: () {
            final page = node.dest?.pageNumber;
            if (page != null && controller.isReady) {
              controller.goToPage(pageNumber: page);
            }
          },
        );
        yield* nodes(node.children, depth + 1);
      }
    }

    return Material(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              controller: search,
              onChanged: (value) => searcher?.startTextSearch(value),
              decoration: InputDecoration(
                hintText: '文内查找',
                prefixIcon: const Icon(Icons.search, size: 17),
                suffixIcon: IconButton(
                  onPressed: () => searcher?.goToNextMatch(),
                  icon: const Icon(Icons.arrow_downward, size: 17),
                ),
              ),
            ),
          ),
          Expanded(
            child: ListView(
              children: [
                ...nodes(outline, 0),
                const Padding(
                  padding: EdgeInsets.all(14),
                  child: Text('页面', style: TextStyle(color: Colors.grey)),
                ),
                for (int i = 1; i <= totalPages; i++)
                  ListTile(
                    dense: true,
                    leading: controller.isReady
                        ? SizedBox(
                            width: 35,
                            height: 48,
                            child: PdfPageView(
                              document: controller.document,
                              pageNumber: i,
                              maximumDpi: 45,
                            ),
                          )
                        : const Icon(Icons.description_outlined, size: 20),
                    title: Text('第 $i 页'),
                    selected: pageNumber == i,
                    onTap: () {
                      if (controller.isReady) {
                        controller.goToPage(pageNumber: i);
                      }
                    },
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget sidePanel() => Material(
    child: Column(
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (int i = 0; i < (s.cloudOnly ? 4 : 5); i++)
                TextButton(
                  onPressed: () => setState(() => tab = i),
                  style: TextButton.styleFrom(
                    foregroundColor: tab == i
                        ? Theme.of(context).colorScheme.primary
                        : Colors.grey,
                  ),
                  child: Text(
                    ['资料', '笔记', 'AI辅读', '翻译', '讨论'][i],
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
            ],
          ),
        ),
        const Divider(),
        Expanded(
          child: IndexedStack(
            index: tab,
            children: [
              infoPanel(),
              notesPanel(),
              aiPanel(false),
              aiPanel(true),
              discussion(),
            ],
          ),
        ),
      ],
    ),
  );

  Widget infoPanel() => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      Text(
        paper.title,
        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
      ),
      if (s.cloudOnly) ...[
        const Text(
          '文献与批注保存于 ReadPaper；本机仅保留当前会话。',
          style: TextStyle(fontSize: 11),
        ),
        for (final warning in s.cloudWarnings)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              '${warning['page'] == null ? '' : '第${warning['page']}页：'}${warning['message']}\n${warning['text'] ?? ''}',
              style: const TextStyle(fontSize: 11),
            ),
          ),
      ],
      const SizedBox(height: 16),
      SelectableText(
        '${(paper.data['authors'] as List? ?? []).join(', ')}\n${paper.data['year'] ?? ''}\n${paper.data['journal'] ?? ''}\n${paper.data['doi'] ?? ''}',
        style: const TextStyle(height: 1.8, fontSize: 12),
      ),
      const SizedBox(height: 20),
      if (paper.data['doi'] != null && paper.data['doi'] != '')
        OutlinedButton.icon(
          onPressed: () => showRelations(context, s, paper.data['doi']),
          icon: const Icon(Icons.hub_outlined, size: 18),
          label: const Text('引用图谱与相关论文'),
        ),
      if (!s.cloudOnly) ...[
        const Text('附件'),
        ...s
            .list('attachment', paperId: widget.paperId)
            .map(
              (attachment) => ListTile(
                dense: true,
                leading: const Icon(Icons.attach_file, size: 18),
                title: Text(
                  attachment.data['filename'] ?? '',
                  style: const TextStyle(fontSize: 11),
                ),
                onTap: () => guarded(context, () async {
                  final data = await s.pdf(attachment);
                  if (data != null) {
                    await FilePicker.platform.saveFile(
                      fileName: attachment.data['filename'],
                      bytes: data,
                    );
                  }
                }),
              ),
            ),
        TextButton.icon(
          onPressed: () => guarded(context, () async {
            final selection = await FilePicker.platform.pickFiles(
              withData: true,
            );
            if (selection?.files.single.bytes != null) {
              await s.importAttachment(
                selection!.files.single.bytes!,
                selection.files.single.name,
                paper,
              );
            }
          }),
          icon: const Icon(Icons.add, size: 16),
          label: const Text('添加附件'),
        ),
        const SizedBox(height: 16),
        const Text('PDF 版本'),
        ...s
            .list('version', paperId: widget.paperId)
            .map(
              (version) => ListTile(
                dense: true,
                leading: const Icon(Icons.picture_as_pdf_outlined, size: 18),
                title: Text(
                  version.data['filename'] ?? '',
                  style: const TextStyle(fontSize: 11),
                ),
                selected: paper.data['active_version_id'] == version.id,
                onTap: () => guarded(context, () async {
                  await s.save('paper', {
                    ...paper.data,
                    'file_hash': version.data['file_hash'],
                    'file_id': version.data['file_id'],
                    'active_version_id': version.id,
                  }, id: paper.id);
                  if (mounted) {
                    Navigator.pushReplacement(
                      context,
                      MaterialPageRoute(
                        builder: (_) => Reader(store: s, paperId: paper.id),
                      ),
                    );
                  }
                }),
              ),
            ),
      ],
      const SizedBox(height: 16),
      OutlinedButton.icon(
        onPressed: indexing ? null : indexLocal,
        icon: const Icon(Icons.manage_search_outlined, size: 18),
        label: Text(s.cloudOnly ? '本次会话内全文索引' : '本地全文索引（离线可用）'),
      ),
      if (indexing) LinearProgressIndicator(value: indexProgress),
      OutlinedButton.icon(
        onPressed: () => startJob('ocr'),
        icon: const Icon(Icons.document_scanner_outlined, size: 18),
        label: const Text('扫描件 OCR'),
      ),
      if (job != null) jobStatus(),
    ],
  );

  Widget notesPanel() => LayoutBuilder(
    builder: (context, constraints) => Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Expanded(
            child: PaperNotes(
              key: s.cloudOnly ? _cloudNotesKey : ValueKey(selectedNoteId),
              store: s,
              paperId: widget.paperId,
              initialNoteId: selectedNoteId,
              renderMarkdown: (text) => MathMarkdown(text),
            ),
          ),
          SizedBox(
            height: math.min(150.0, math.max(0.0, constraints.maxHeight - 310)),
            child: ListView(
              children: s
                  .list('annotation', paperId: widget.paperId)
                  .map(
                    (e) => ListTile(
                      dense: true,
                      title: Text(
                        e.data['text']?.toString().isNotEmpty == true
                            ? e.data['text']
                            : '${e.data['type']} · 第${e.data['page']}页',
                        maxLines: 2,
                        style: const TextStyle(fontSize: 11),
                      ),
                      leading: Icon(
                        Icons.bookmark,
                        color: parseColor(e.data['color'] ?? '#edb83c'),
                        size: 16,
                      ),
                      onTap: () {
                        if (controller.isReady) {
                          controller.goToPage(pageNumber: e.data['page']);
                        }
                      },
                      trailing: IconButton(
                        tooltip: '删除此批注',
                        onPressed: !s.canEdit
                            ? null
                            : () => eraseAnnotation(e.id),
                        icon: const Icon(Icons.close, size: 15),
                      ),
                    ),
                  )
                  .toList(),
            ),
          ),
        ],
      ),
    ),
  );

  Widget aiPanel(bool translate) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      Text(
        translate ? '全文对照翻译' : '与论文对话',
        style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 10),
      OutlinedButton.icon(
        icon: const Icon(Icons.history, size: 18),
        label: const Text('历史任务与结果'),
        onPressed: () => guarded(context, () async {
          final response = await s.request(
            'GET',
            '/jobs?paper_id=${widget.paperId}',
          );
          if (!mounted) return;
          final selected = await showDialog<Map<String, dynamic>>(
            context: context,
            builder: (c) => SimpleDialog(
              title: const Text('本篇任务记录'),
              children: [
                if ((response['items'] as List).isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Text('还没有任务'),
                  ),
                for (final item in response['items'])
                  SimpleDialogOption(
                    onPressed: () =>
                        Navigator.pop(c, Map<String, dynamic>.from(item)),
                    child: Text(
                      '${item['kind']} · ${item['state']}\n${DateTime.fromMillisecondsSinceEpoch(((item['created'] as num? ?? 0) * 1000).round()).toLocal()}',
                    ),
                  ),
              ],
            ),
          );
          if (selected != null && mounted) {
            await watchJob(selected['kind'], selected['id']);
          }
        }),
      ),
      const Text(
        '结果由你配置的服务生成，引用可回到原文核对。',
        style: TextStyle(fontSize: 11, color: Colors.grey),
      ),
      const SizedBox(height: 20),
      if (!translate) ...[
        TextField(
          controller: question,
          minLines: 3,
          maxLines: 6,
          decoration: const InputDecoration(hintText: '这篇论文解决了什么问题？'),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 5,
          children: [
            FilledButton(
              onPressed: () => startJob('ask'),
              child: const Text('提问'),
            ),
            OutlinedButton(
              onPressed: () => startJob('summarize'),
              child: Text(s.cloudOnly ? '总结所选内容（默认前20页）' : '总结全文'),
            ),
            TextButton(
              onPressed: () => guarded(context, () async {
                if (controller.isReady &&
                    controller.textSelectionDelegate.isCopyAllowed) {
                  final text = await controller.textSelectionDelegate
                      .getSelectedText();
                  question.text = '解释并翻译以下原文：\n$text';
                }
              }),
              child: const Text('使用选区'),
            ),
            TextButton(
              onPressed: () => guarded(context, () async {
                if (s.cloudOnly) {
                  await startJob('figure', sourcePage: pageNumber);
                  return;
                }
                final image = await FilePicker.platform.pickFiles(
                  type: FileType.image,
                  withData: true,
                );
                if (image?.files.single.bytes != null) {
                  await startJob(
                    'figure',
                    image: base64Encode(image!.files.single.bytes!),
                  );
                }
              }),
              child: const Text('图表提问'),
            ),
            TextButton(
              onPressed: () => startJob('figures'),
              child: const Text('浏览论文图表'),
            ),
          ],
        ),
      ] else
        FilledButton.icon(
          onPressed: () => startJob('translate'),
          icon: const Icon(Icons.translate, size: 18),
          label: Text(s.cloudOnly ? '翻译所选内容（默认前20页）' : '开始全文翻译'),
        ),
      const SizedBox(height: 20),
      if (job != null) jobStatus(),
    ],
  );

  Widget jobStatus() {
    final result = job!['result'] as Map? ?? {};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (s.cloudOnly && result['context_truncated'] == true)
          const Text('本次仅处理所选内容或前20页，结果未覆盖全文。', style: TextStyle(fontSize: 11)),
        Text(
          '任务：${job!['state']}',
          style: const TextStyle(fontSize: 11, color: Colors.grey),
        ),
        const SizedBox(height: 8),
        if (['queued', 'running'].contains(job!['state'])) ...[
          LinearProgressIndicator(
            value: (job!['progress'] as num? ?? 0).toDouble(),
          ),
          TextButton(
            onPressed: () => guarded(
              context,
              () => s.request('POST', '/jobs/$jobId/cancel'),
            ),
            child: const Text('取消任务'),
          ),
        ],
        if (job!['error'] != null && job!['error'] != '')
          SelectableText(
            job!['error'],
            style: const TextStyle(color: Colors.red),
          ),
        if (job!['state'] == 'failed' || job!['state'] == 'cancelled')
          TextButton(
            onPressed: () => guarded(context, () async {
              if (s.cloudOnly) {
                await startJob(job?['kind'] ?? 'ask');
              } else {
                final retry = await s.request('POST', '/jobs/$jobId/retry');
                await watchJob(job?['kind'] ?? 'ask', retry['id']);
              }
            }),
            child: const Text('重试任务'),
          ),
        if (result['answer'] != null) MathMarkdown(result['answer']),
        if (result['figures'] != null) ...[
          Text(
            result['limitations'] ?? '',
            style: const TextStyle(fontSize: 11, color: Colors.grey),
          ),
          if ((result['figures'] as List).isEmpty)
            const Text('没有检测到嵌入图像，可使用图表提问手动选图。'),
          if (result['truncated'] == true) const Text('结果达到数量或大小限制，当前显示部分图表。'),
          for (final figure in result['figures'])
            Card(
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Image.memory(
                      base64Decode(figure['image_base64']),
                      fit: BoxFit.contain,
                    ),
                    Text(
                      '${figure['label'] == '' ? '图像候选' : figure['label']} · 第${figure['page']}页',
                    ),
                    if (figure['caption'] != '')
                      Text(
                        figure['caption'],
                        style: const TextStyle(fontSize: 11),
                      ),
                    Wrap(
                      children: [
                        TextButton(
                          onPressed: () {
                            if (controller.isReady) {
                              controller.goToPage(pageNumber: figure['page']);
                            }
                          },
                          child: const Text('定位原文'),
                        ),
                        TextButton(
                          onPressed: () {
                            if (result['file_hash'] !=
                                paper.data['file_hash']) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text('此结果来自旧 PDF 版本，请重新解析当前版本。'),
                                ),
                              );
                              return;
                            }
                            question.text = '解释此图表：${figure['caption']}';
                            startJob(
                              'figure',
                              image: figure['image_base64'],
                              sourcePage: figure['page'],
                            );
                          },
                          child: const Text('解读此图'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
        ],
        if (result['sources'] != null)
          Wrap(
            children: (result['sources'] as List)
                .map(
                  (p) => TextButton(
                    onPressed: () {
                      if (controller.isReady) {
                        controller.goToPage(pageNumber: p['page']);
                      }
                    },
                    child: Text('第${p['page']}页'),
                  ),
                )
                .toList(),
          ),
        if (result['pages'] != null) ...[
          (result['pages'] as List).isNotEmpty
              ? Text(
                  '已处理 ${(result['pages'] as List).length} 页',
                  style: const TextStyle(fontSize: 11),
                )
              : const SizedBox.shrink(),
          ...(result['pages'] as List)
              .where((p) => p['translation'] != null)
              .map(
                (p) => Card(
                  elevation: 0,
                  child: Padding(
                    padding: const EdgeInsets.all(10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        TextButton(
                          onPressed: () {
                            if (controller.isReady) {
                              controller.goToPage(pageNumber: p['page']);
                            }
                          },
                          child: Text('第${p['page']}页'),
                        ),
                        SelectableText(
                          p['original'],
                          style: const TextStyle(
                            color: Colors.grey,
                            fontSize: 11,
                          ),
                        ),
                        const Divider(height: 24),
                        SelectableText(
                          p['translation'],
                          style: const TextStyle(fontSize: 13, height: 1.7),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
        ],
      ],
    );
  }

  Widget discussion() => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      Text(
        s.scope == 'personal' ? '个人阅读记录' : '小组讨论',
        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 12),
      FilledButton.tonalIcon(
        onPressed: () => guarded(context, () async {
          final text = await textDialog(context, '记录讨论', multiline: true);
          if (text != null && text.trim().isNotEmpty) {
            await s.save('comment', {
              'paper_id': paper.id,
              'content': text,
              'author': s.userName,
              'date': DateTime.now().toUtc().toIso8601String(),
            });
          }
        }),
        icon: const Icon(Icons.add_comment_outlined, size: 18),
        label: const Text('写下想法'),
      ),
      ...s
          .list('comment', paperId: paper.id)
          .map(
            (e) => Card(
              elevation: 0,
              child: ListTile(
                title: Text(
                  e.data['author'] ?? '',
                  style: const TextStyle(fontSize: 11),
                ),
                subtitle: Text(e.data['content'] ?? ''),
              ),
            ),
          ),
    ],
  );
}

Color parseColor(String value) =>
    Color(0xff000000 | int.parse(value.replaceFirst('#', ''), radix: 16));

class MathMarkdown extends StatelessWidget {
  final String text;
  const MathMarkdown(this.text, {super.key});
  @override
  Widget build(BuildContext context) {
    final parts = text.split(r'$$');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (int i = 0; i < parts.length; i++)
          if (i.isEven)
            MarkdownBody(data: parts[i], selectable: true)
          else
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Math.tex(
                  parts[i],
                  onErrorFallback: (error) => Text(parts[i]),
                ),
              ),
            ),
      ],
    );
  }
}

class AnnotationLayer extends StatefulWidget {
  final String mode, color;
  final List<Map<String, dynamic>> annotations;
  final Future<void> Function(Map<String, dynamic>) onCreate;
  final Future<void> Function(String)? onErase;
  final bool penOnly;
  const AnnotationLayer({
    super.key,
    required this.mode,
    required this.color,
    required this.annotations,
    required this.onCreate,
    this.onErase,
    this.penOnly = false,
  });
  @override
  State<AnnotationLayer> createState() => _AnnotationLayerState();
}

class _AnnotationLayerState extends State<AnnotationLayer> {
  List<Map<String, double>> points = [];
  int? pointer;
  final erasing = <String>{};
  void erase(PointerEvent event, Size size) {
    final hits = widget.annotations.reversed.where(
      (a) =>
          a['_id'] != null &&
          !erasing.contains(a['_id']) &&
          annotationHit(a, event.localPosition, size),
    );
    if (hits.isEmpty) return;
    final id = hits.first['_id'] as String;
    erasing.add(id);
    unawaited(
      (widget.onErase?.call(id) ?? Future<void>.value()).whenComplete(
        () => erasing.remove(id),
      ),
    );
  }

  Map<String, double> normalize(PointerEvent event, Size size) => {
    'x': (event.localPosition.dx / size.width).clamp(0.0, 1.0),
    'y': (event.localPosition.dy / size.height).clamp(0.0, 1.0),
    'pressure': event.pressureMax > event.pressureMin
        ? ((event.pressure - event.pressureMin) /
                  (event.pressureMax - event.pressureMin))
              .clamp(0.0, 1.0)
        : .5,
  };
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final size = constraints.biggest;
      final active = widget.mode != 'select';
      final current = <String, dynamic>{
        'type': widget.mode,
        'color': widget.color,
        'points': points,
      };
      return IgnorePointer(
        ignoring: !active,
        child: Listener(
          behavior: active
              ? HitTestBehavior.opaque
              : HitTestBehavior.deferToChild,
          onPointerDown: (event) {
            if (pointer != null || !active) return;
            if (widget.penOnly && event.kind == PointerDeviceKind.touch) return;
            // In ink mode accept stylus and mouse, allow a single finger as a
            // fallback on devices without a pen. Ignore additional palm pointers.
            pointer = event.pointer;
            if (widget.mode == 'erase') {
              erase(event, size);
              return;
            }
            setState(() => points = [normalize(event, size)]);
          },
          onPointerMove: (event) {
            if (pointer == event.pointer) {
              if (widget.mode == 'erase') {
                erase(event, size);
                return;
              }
              setState(() => points = [...points, normalize(event, size)]);
            }
          },
          onPointerCancel: (event) {
            if (event.pointer == pointer) {
              pointer = null;
              setState(() => points = []);
            }
          },
          onPointerUp: (event) async {
            if (event.pointer != pointer) return;
            pointer = null;
            if (widget.mode == 'erase') return;
            final stroke = List<Map<String, double>>.from(points);
            setState(() => points = []);
            if (stroke.isEmpty) return;
            final first = stroke.first, last = normalize(event, size);
            final rect = [
              math.min(first['x']!, last['x']!),
              math.min(first['y']!, last['y']!),
              math.max(first['x']!, last['x']!),
              math.max(first['y']!, last['y']!),
            ];
            String text = '';
            if (widget.mode == 'text') {
              text = await textDialog(context, '文本批注', multiline: true) ?? '';
              if (text.isEmpty) return;
            }
            if (widget.mode == 'text' && rect[2] - rect[0] < .03) {
              rect[2] = math.min(1, rect[0] + .3);
              rect[3] = math.min(1, rect[1] + .08);
            }
            await widget.onCreate({
              'type': widget.mode,
              'color': widget.color,
              'points': widget.mode == 'ink'
                  ? [...stroke, last]
                  : [first, last],
              'rects': widget.mode == 'ink' ? [] : [rect],
              'text': text,
            });
          },
          child: CustomPaint(
            size: size,
            painter: AnnotationPainter([
              ...widget.annotations,
              if (points.isNotEmpty) current,
            ]),
          ),
        ),
      );
    },
  );
}

class AnnotationPainter extends CustomPainter {
  final List<Map<String, dynamic>> annotations;
  AnnotationPainter(this.annotations);
  @override
  void paint(Canvas canvas, Size size) {
    for (final annotation in annotations) {
      final type = annotation['type'];
      final color = parseColor(annotation['color'] ?? '#edb83c');
      final opacity =
          (annotation['opacity'] as num?)?.toDouble() ??
          (type == 'highlight' ? .35 : 1.0);
      final strokeWidth = (annotation['stroke_width'] as num?)?.toDouble();
      final paint = Paint()
        ..color = color.withValues(alpha: opacity)
        ..strokeCap = StrokeCap.round;
      final points = annotation['points'] as List? ?? [];
      Offset point(Map p) => Offset(
        (p['x'] as num).toDouble() * size.width,
        (p['y'] as num).toDouble() * size.height,
      );
      if (type == 'ink') {
        for (int i = 1; i < points.length; i++) {
          paint.strokeWidth = strokeWidth != null
              ? strokeWidth * size.width
              : points[i]['width'] is num && points[i - 1]['width'] is num
              ? ((points[i]['width'] as num) +
                        (points[i - 1]['width'] as num)) /
                    2 *
                    size.width
              : (1.0 + (points[i]['pressure'] as num? ?? .5) * 3) *
                    (size.width / 600);
          canvas.drawLine(point(points[i - 1]), point(points[i]), paint);
        }
      } else {
        final rects = annotation['rects'] as List? ?? [];
        if (rects.isEmpty && points.length >= 2) {
          paint
            ..style = PaintingStyle.stroke
            ..strokeWidth = strokeWidth != null
                ? strokeWidth * size.width
                : 1.5;
          if (type == 'line') {
            canvas.drawLine(point(points.first), point(points.last), paint);
          } else {
            if (type == 'rectangle') {
              final fillOpacity =
                  (annotation['fill_opacity'] as num?)?.toDouble() ?? 0;
              canvas.drawRect(
                Rect.fromPoints(point(points.first), point(points.last)),
                Paint()..color = color.withValues(alpha: fillOpacity),
              );
            }
            canvas.drawRect(
              Rect.fromPoints(point(points.first), point(points.last)),
              paint,
            );
          }
        }
        for (final rect in rects) {
          final r = Rect.fromLTRB(
            rect[0] * size.width,
            rect[1] * size.height,
            rect[2] * size.width,
            rect[3] * size.height,
          );
          paint
            ..style = type == 'highlight'
                ? PaintingStyle.fill
                : PaintingStyle.stroke
            ..strokeWidth = strokeWidth != null
                ? strokeWidth * size.width
                : 1.5;
          if (type == 'text') {
            final text = TextPainter(
              text: TextSpan(
                text: annotation['text'] ?? '',
                style: TextStyle(
                  color: color.withValues(alpha: opacity),
                  fontSize:
                      ((annotation['font_size'] as num?)?.toDouble() ??
                          12 / 600) *
                      size.width,
                ),
              ),
              textDirection: TextDirection.ltr,
            )..layout(maxWidth: math.max(1, r.width));
            text.paint(canvas, r.topLeft);
          } else if (type == 'line' && points.length >= 2) {
            canvas.drawLine(point(points.first), point(points.last), paint);
          } else {
            if (type == 'rectangle') {
              final fillOpacity =
                  (annotation['fill_opacity'] as num?)?.toDouble() ?? 0;
              canvas.drawRect(
                r,
                Paint()..color = color.withValues(alpha: fillOpacity),
              );
            }
            canvas.drawRect(r, paint);
          }
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant AnnotationPainter oldDelegate) => true;
}
