import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart';
import 'store.dart';
import 'reader.dart';
import 'relations.dart';
import 'notes.dart';
import 'groups.dart';
import 'metadata.dart';
import 'folders.dart';
import 'bulk.dart';
import 'cloud_store.dart';
import 'cloud_home.dart';

void main(List<String> arguments) async {
  WidgetsFlutterBinding.ensureInitialized();
  String? argument(String name) {
    for (final value in arguments) {
      if (value.startsWith('$name=')) return value.substring(name.length + 1);
    }
    return null;
  }

  final store = CloudWorkspace(gateway: argument('--gateway'));
  try {
    await store.initialize();
    runApp(PaperDesk(store: store));
  } catch (error) {
    runApp(
      MaterialApp(
        home: Scaffold(body: Center(child: SelectableText('工作区初始化失败：$error'))),
      ),
    );
  }
}

class PaperDesk extends StatelessWidget {
  final Workspace store;
  const PaperDesk({super.key, required this.store});
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) {
      ThemeData theme(Brightness brightness) => ThemeData(
        useMaterial3: true,
        brightness: brightness,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xff4562ed),
          primary: const Color(0xff4562ed),
          brightness: brightness,
        ),
        scaffoldBackgroundColor: brightness == Brightness.light
            ? const Color(0xfff6f7fb)
            : const Color(0xff171923),
        fontFamily: 'Microsoft YaHei',
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(),
          isDense: true,
        ),
        dividerTheme: const DividerThemeData(space: 1, thickness: .5),
      );
      return MaterialApp(
        title: 'PaperDesk',
        debugShowCheckedModeBanner: false,
        theme: theme(Brightness.light),
        darkTheme: theme(Brightness.dark),
        themeMode: store.dark ? ThemeMode.dark : ThemeMode.light,
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: store is CloudWorkspace
            ? CloudHome(store: store as CloudWorkspace)
            : Home(store: store),
      );
    },
  );
}

Future<T?> guarded<T>(BuildContext context, Future<T> Function() action) async {
  try {
    return await action();
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error.toString().replaceFirst('Exception: ', '')),
        ),
      );
    }
    return null;
  }
}

Future<String?> textDialog(
  BuildContext context,
  String title, {
  String initial = '',
  String hint = '',
  bool multiline = false,
}) async {
  final controller = TextEditingController(text: initial);
  final result = await showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: SizedBox(
        width: 440,
        child: TextField(
          controller: controller,
          autofocus: true,
          maxLines: multiline ? 8 : 1,
          decoration: InputDecoration(hintText: hint),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, controller.text),
          child: const Text('保存'),
        ),
      ],
    ),
  );
  controller.dispose();
  return result;
}

class Home extends StatefulWidget {
  final Workspace store;
  const Home({super.key, required this.store});
  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> with WidgetsBindingObserver {
  Workspace get s => widget.store;
  int section = 0;
  String? folder, tag;
  String query = '', filter = '全部', sort = '最近添加';
  Set<String> searchIds = {}, selectedPapers = {};
  bool selecting = false;
  String selectionScope = '';
  Timer? timer;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    timer = Timer.periodic(const Duration(seconds: 40), (_) => s.sync());
    unawaited(s.sync());
  }

  @override
  void dispose() {
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(s.sync());
  }

  Future<void> importFiles({Entry? paper}) => guarded(context, () async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['pdf'],
      allowMultiple: paper == null,
      withData: true,
    );
    if (result == null) return;
    for (final file in result.files) {
      if (file.bytes != null) {
        await s.importPdf(
          file.bytes!,
          file.name,
          folderId: folder,
          paper: paper,
        );
      }
    }
    unawaited(s.sync());
  });

  Future<void> metadata(Entry paper) async {
    final title = TextEditingController(text: paper.title),
        authors = TextEditingController(
          text: (paper.data['authors'] as List? ?? []).join('; '),
        ),
        tags = TextEditingController(
          text: (paper.data['tags'] as List? ?? []).join(', '),
        ),
        doi = TextEditingController(text: paper.data['doi'] ?? ''),
        year = TextEditingController(text: '${paper.data['year'] ?? ''}'),
        journal = TextEditingController(text: paper.data['journal'] ?? ''),
        abstractText = TextEditingController(
          text: paper.data['abstract'] ?? '',
        );
    Map<String, dynamic> enriched = {};
    bool fetching = false;
    String state = paper.data['status'] ?? '未读';
    String? folderId = paper.data['folder_id'];
    await showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, set) => AlertDialog(
          title: const Text('文献资料'),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final field in [
                    (title, '标题'),
                    (authors, '作者（分号分隔）'),
                    (year, '年份'),
                    (doi, 'DOI'),
                    (journal, '期刊 / 会议'),
                    (abstractText, '摘要'),
                    (tags, '标签（逗号分隔）'),
                  ])
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: TextField(
                        controller: field.$1,
                        decoration: InputDecoration(labelText: field.$2),
                      ),
                    ),
                  DropdownButtonFormField<String>(
                    initialValue: state,
                    decoration: const InputDecoration(labelText: '阅读状态'),
                    items: ['未读', '阅读中', '已读']
                        .map((v) => DropdownMenuItem(value: v, child: Text(v)))
                        .toList(),
                    onChanged: (v) => set(() => state = v!),
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    initialValue: folderId,
                    decoration: const InputDecoration(labelText: '文件夹'),
                    items: [
                      const DropdownMenuItem<String>(
                        value: null,
                        child: Text('未分类'),
                      ),
                      ...s
                          .list('folder')
                          .map(
                            (e) => DropdownMenuItem(
                              value: e.id,
                              child: Text(s.folderPath(e.id)),
                            ),
                          ),
                    ],
                    onChanged: (v) => set(() => folderId = v),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: fetching || !s.canEdit
                        ? null
                        : () async {
                            set(() => fetching = true);
                            await guarded(context, () async {
                              final values =
                                  await metadataPreview(context, s, doi.text, {
                                    ...paper.data,
                                    ...enriched,
                                    'title': title.text,
                                    'authors': authors.text
                                        .split(';')
                                        .map((v) => v.trim())
                                        .toList(),
                                    'year': int.tryParse(year.text),
                                    'doi': doi.text,
                                    'journal': journal.text,
                                    'abstract': abstractText.text,
                                  });
                              if (values == null || !context.mounted) return;
                              enriched.addAll(values);
                              for (final field
                                  in <String, TextEditingController>{
                                    'title': title,
                                    'doi': doi,
                                    'year': year,
                                    'journal': journal,
                                    'abstract': abstractText,
                                  }.entries) {
                                if (values.containsKey(field.key)) {
                                  field.value.text = '${values[field.key]}';
                                }
                              }
                              if (values['authors'] != null) {
                                authors.text = (values['authors'] as List).join(
                                  '; ',
                                );
                              }
                            });
                            if (context.mounted) set(() => fetching = false);
                          },
                    icon: fetching
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.auto_fix_high_outlined),
                    label: const Text('按 DOI 补全 · 预览后应用'),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () async {
                await guarded(
                  context,
                  () => s.save('paper', {
                    ...paper.data,
                    ...enriched,
                    'title': title.text,
                    'authors': authors.text
                        .split(';')
                        .map((e) => e.trim())
                        .where((e) => e.isNotEmpty)
                        .toList(),
                    'year': int.tryParse(year.text),
                    'doi': doi.text,
                    'journal': journal.text,
                    'abstract': abstractText.text,
                    'tags': tags.text
                        .split(RegExp('[,，]'))
                        .map((e) => e.trim())
                        .where((e) => e.isNotEmpty)
                        .toList(),
                    'status': state,
                    'folder_id': folderId,
                    if (folderId != paper.data['folder_id'])
                      'folder_ids': [?folderId],
                  }, id: paper.id),
                );
                if (context.mounted) Navigator.pop(context);
              },
              child: const Text('保存'),
            ),
          ],
        ),
      ),
    );
    for (final c in [title, authors, tags, doi, year, journal, abstractText]) {
      c.dispose();
    }
  }

  Widget sidebar() {
    final labels = ['我的文献', '发现论文', '笔记整理', '学习统计', '研究小组', '回收站'];
    final icons = [
      Icons.library_books_outlined,
      Icons.explore_outlined,
      Icons.edit_note_outlined,
      Icons.bar_chart_outlined,
      Icons.groups_outlined,
      Icons.delete_outline,
    ];
    final allTags =
        s
            .list('paper')
            .expand((e) => (e.data['tags'] as List? ?? []).cast<String>())
            .toSet()
            .toList()
          ..sort();
    return Container(
      width: 226,
      decoration: BoxDecoration(
        border: Border(
          right: BorderSide(color: Theme.of(context).dividerColor, width: .5),
        ),
      ),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 25, 18, 24),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: const Color(0xff4562ed),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(
                    Icons.auto_stories,
                    color: Colors.white,
                    size: 25,
                  ),
                ),
                const SizedBox(width: 10),
                const Flexible(
                  child: Text(
                    'PaperDesk',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 21, fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                for (int i = 0; i < labels.length; i++)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 5),
                    child: ListTile(
                      dense: true,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                      selected: section == i && folder == null && tag == null,
                      selectedTileColor: Theme.of(
                        context,
                      ).colorScheme.primaryContainer.withValues(alpha: .45),
                      leading: Icon(icons[i], size: 21),
                      title: Text(labels[i]),
                      onTap: () => setState(() {
                        section = i;
                        folder = null;
                        tag = null;
                      }),
                    ),
                  ),
                const SizedBox(height: 22),
                Row(
                  children: [
                    const SizedBox(width: 14),
                    const Expanded(
                      child: Text(
                        '文件夹',
                        style: TextStyle(color: Colors.grey, fontSize: 12),
                      ),
                    ),
                    IconButton(
                      tooltip: '新建文件夹',
                      icon: const Icon(
                        Icons.create_new_folder_outlined,
                        size: 18,
                      ),
                      onPressed: () async {
                        final name = await textDialog(context, '新建文件夹');
                        if (name != null && name.trim().isNotEmpty) {
                          await s.save('folder', {
                            'title': name.trim(),
                            if (folder != null) 'parent_id': folder,
                          });
                        }
                      },
                    ),
                  ],
                ),
                FolderTree(
                  store: s,
                  selected: folder,
                  onSelected: (id) => setState(() {
                    section = 0;
                    folder = id;
                    tag = null;
                  }),
                ),
                const Padding(
                  padding: EdgeInsets.fromLTRB(14, 24, 0, 12),
                  child: Text(
                    '标签',
                    style: TextStyle(color: Colors.grey, fontSize: 12),
                  ),
                ),
                Wrap(
                  spacing: 5,
                  runSpacing: 5,
                  children: allTags
                      .map(
                        (t) => ActionChip(
                          label: Text(t, style: const TextStyle(fontSize: 11)),
                          onPressed: () => setState(() {
                            section = 0;
                            tag = t;
                            folder = null;
                          }),
                        ),
                      )
                      .toList(),
                ),
              ],
            ),
          ),
          const Divider(),
          ListTile(
            leading: CircleAvatar(
              radius: 15,
              child: Text(s.userName.substring(0, 1)),
            ),
            title: Text(s.userName, maxLines: 1),
            subtitle: Text(
              s.token.isEmpty ? '登录以开启跨端同步' : '独立科研工作区',
              style: const TextStyle(fontSize: 10),
            ),
            trailing: const Icon(Icons.settings_outlined, size: 19),
            onTap: () => settings(context, s),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: s,
    builder: (context, _) => LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 900;
        final main = [
          library(),
          DiscoverPane(store: s),
          notes(),
          stats(),
          GroupsPane(store: s),
          trash(),
        ][section];
        return Scaffold(
          drawer: wide ? null : Drawer(child: sidebar()),
          appBar: wide
              ? null
              : AppBar(
                  title: const Text('PaperDesk'),
                  actions: [
                    IconButton(
                      onPressed: () => settings(context, s),
                      icon: const Icon(Icons.settings_outlined),
                    ),
                  ],
                ),
          body: Row(
            children: [
              if (wide) sidebar(),
              Expanded(
                child: Column(
                  children: [
                    Container(
                      height: 66,
                      padding: const EdgeInsets.symmetric(horizontal: 24),
                      color: Theme.of(context).colorScheme.surface,
                      child: Row(
                        children: [
                          Expanded(
                            child: DropdownButtonHideUnderline(
                              child: DropdownButton<String>(
                                value: s.scope,
                                items: [
                                  const DropdownMenuItem(
                                    value: 'personal',
                                    child: Text('个人文献库'),
                                  ),
                                  ...s.groups.map(
                                    (g) => DropdownMenuItem(
                                      value: 'g:${g['id']}',
                                      child: Text(g['name']),
                                    ),
                                  ),
                                ],
                                onChanged: (v) {
                                  if (v != null) s.switchScope(v);
                                },
                              ),
                            ),
                          ),
                          if (wide)
                            Text(
                              '${s.pending} 项待同步',
                              style: const TextStyle(
                                color: Colors.grey,
                                fontSize: 11,
                              ),
                            ),
                          IconButton(
                            tooltip: s.status,
                            onPressed: s.syncing ? null : () => s.sync(),
                            icon: Icon(
                              s.syncing
                                  ? Icons.sync
                                  : Icons.cloud_done_outlined,
                              size: 21,
                            ),
                          ),
                          IconButton(
                            tooltip: '切换主题',
                            onPressed: s.toggleDark,
                            icon: const Icon(Icons.contrast, size: 21),
                          ),
                        ],
                      ),
                    ),
                    if (s.conflicts.isNotEmpty)
                      MaterialBanner(
                        content: Text('${s.conflicts.length} 项同步冲突；笔记副本已保留'),
                        actions: [
                          TextButton(
                            onPressed: showConflicts,
                            child: const Text('查看并合并'),
                          ),
                        ],
                      ),
                    Expanded(child: main),
                    Container(
                      height: 27,
                      padding: const EdgeInsets.symmetric(horizontal: 18),
                      alignment: Alignment.centerLeft,
                      child: Text(
                        s.status,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 10,
                          color: Colors.grey,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    ),
  );

  Widget library() {
    if (selectionScope != s.scope) {
      selectionScope = s.scope;
      selectedPapers.clear();
      selecting = false;
    }
    selectedPapers.removeWhere((id) => s.entry(id)?.deleted != false);

    final papers = s
        .list('paper')
        .where(
          (e) =>
              (folder == null || s.paperInFolder(e, folder!)) &&
              (tag == null || (e.data['tags'] as List? ?? []).contains(tag)) &&
              (filter == '全部' || e.data['status'] == filter) &&
              (query.isEmpty ||
                  e.title.toLowerCase().contains(query.toLowerCase()) ||
                  searchIds.contains(e.id)),
        )
        .toList();
    if (sort == '标题') papers.sort((a, b) => a.title.compareTo(b.title));
    if (sort == '年份') {
      papers.sort(
        (a, b) =>
            '${b.data['year'] ?? ''}'.compareTo('${a.data['year'] ?? ''}'),
      );
    }
    if (sort == '最近添加') papers.sort((a, b) => b.id.compareTo(a.id));
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      folder != null
                          ? (s.entry(folder!)?.title ?? '文件夹')
                          : tag != null
                          ? '# $tag'
                          : '我的文献',
                      style: const TextStyle(
                        fontSize: 25,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 5),
                    Text(
                      '让每一次阅读，都成为新的发现 · ${papers.length} 篇文献',
                      style: const TextStyle(color: Colors.grey, fontSize: 12),
                    ),
                  ],
                ),
              ),
              FilledButton.icon(
                onPressed: () => importFiles(),
                icon: const Icon(Icons.add, size: 18),
                label: const Text('导入文献'),
              ),
            ],
          ),
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              TextButton.icon(
                onPressed: !s.canEdit
                    ? null
                    : () => setState(() {
                        selecting = !selecting;
                        selectedPapers.clear();
                      }),
                icon: Icon(selecting ? Icons.close : Icons.checklist),
                label: Text(selecting ? '结束选择' : '批量管理'),
              ),
              if (selecting) ...[
                TextButton(
                  onPressed: () => setState(
                    () => selectedPapers.addAll(papers.map((e) => e.id)),
                  ),
                  child: const Text('全选当前结果'),
                ),
                TextButton(
                  onPressed: () => setState(selectedPapers.clear),
                  child: const Text('清空选择'),
                ),
                BulkActions(
                  store: s,
                  ids: selectedPapers,
                  onDone: () {
                    if (mounted) setState(selectedPapers.clear);
                  },
                ),
              ],
            ],
          ),
          const SizedBox(height: 24),
          Wrap(
            spacing: 6,
            children: ['全部', '未读', '阅读中', '已读']
                .map(
                  (label) => ChoiceChip(
                    label: Text(label),
                    selected: filter == label,
                    onSelected: (_) => setState(() => filter = label),
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: TextField(
                  decoration: const InputDecoration(
                    prefixIcon: Icon(Icons.search, size: 20),
                    hintText: '搜索标题、作者、标签或已索引全文',
                  ),
                  onChanged: (text) async {
                    final ids = await s.fullTextSearch(text);
                    if (mounted) {
                      setState(() {
                        query = text;
                        searchIds = ids.toSet();
                      });
                    }
                  },
                ),
              ),
              const SizedBox(width: 12),
              DropdownButton<String>(
                value: sort,
                items: ['最近添加', '标题', '年份']
                    .map(
                      (v) => DropdownMenuItem(
                        value: v,
                        child: Text(v, style: const TextStyle(fontSize: 12)),
                      ),
                    )
                    .toList(),
                onChanged: (v) => setState(() => sort = v!),
              ),
            ],
          ),
          const SizedBox(height: 18),
          Expanded(
            child: papers.isEmpty
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.menu_book_outlined,
                          size: 70,
                          color: Theme.of(
                            context,
                          ).colorScheme.primary.withValues(alpha: .4),
                        ),
                        const SizedBox(height: 20),
                        const Text(
                          '从一篇论文开始',
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 10),
                        const Text(
                          '导入 PDF，整理文献，记录你的思考。',
                          style: TextStyle(color: Colors.grey),
                        ),
                        const SizedBox(height: 22),
                        OutlinedButton.icon(
                          onPressed: () => importFiles(),
                          icon: const Icon(Icons.upload_file_outlined),
                          label: const Text('选择本地 PDF'),
                        ),
                      ],
                    ),
                  )
                : ListView.separated(
                    itemCount: papers.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 9),
                    itemBuilder: (context, index) {
                      final e = papers[index];
                      final tags = (e.data['tags'] as List? ?? [])
                          .take(3)
                          .join(' · ');
                      return Card(
                        elevation: 0,
                        margin: EdgeInsets.zero,
                        child: ListTile(
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 18,
                            vertical: 10,
                          ),
                          leading: selecting
                              ? Checkbox(
                                  value: selectedPapers.contains(e.id),
                                  onChanged: (v) => setState(() {
                                    if (v == true) {
                                      selectedPapers.add(e.id);
                                    } else {
                                      selectedPapers.remove(e.id);
                                    }
                                  }),
                                )
                              : Container(
                                  width: 43,
                                  height: 54,
                                  decoration: BoxDecoration(
                                    color: const Color(0xffffeee9),
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: const Icon(
                                    Icons.picture_as_pdf_outlined,
                                    color: Color(0xffd98772),
                                  ),
                                ),
                          title: Text(
                            e.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 14,
                            ),
                          ),
                          subtitle: Padding(
                            padding: const EdgeInsets.only(top: 9),
                            child: Text(
                              '${(e.data['authors'] as List? ?? []).join(', ')}  ${e.data['year'] ?? ''}\n${e.data['status'] ?? '未读'}${tags.isEmpty ? '' : '   ·   $tags'}',
                              style: const TextStyle(fontSize: 11, height: 1.8),
                            ),
                          ),
                          onTap: selecting
                              ? () => setState(() {
                                  if (!selectedPapers.add(e.id)) {
                                    selectedPapers.remove(e.id);
                                  }
                                })
                              : () => Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (_) =>
                                        Reader(store: s, paperId: e.id),
                                  ),
                                ),
                          trailing: PopupMenuButton<String>(
                            onSelected: (action) => guarded(context, () async {
                              if (action == 'edit') await metadata(e);
                              if (action == 'version') {
                                await importFiles(paper: e);
                              }
                              if (action == 'favorite') {
                                await s.save('paper', {
                                  ...e.data,
                                  'important': !(e.data['important'] == true),
                                }, id: e.id);
                              }
                              if (action == 'citation') {
                                await s.sync();
                                final bytes = await s.getBytes(
                                  '/papers/${e.id}/citation',
                                );
                                await Clipboard.setData(
                                  ClipboardData(text: utf8.decode(bytes)),
                                );
                              }
                              if (action == 'delete') {
                                if (!context.mounted) return;
                                final answer = await showDialog<bool>(
                                  context: context,
                                  builder: (c) => AlertDialog(
                                    title: const Text('移至回收站？'),
                                    content: Text(e.title),
                                    actions: [
                                      TextButton(
                                        onPressed: () =>
                                            Navigator.pop(c, false),
                                        child: const Text('取消'),
                                      ),
                                      FilledButton(
                                        onPressed: () => Navigator.pop(c, true),
                                        child: const Text('移入'),
                                      ),
                                    ],
                                  ),
                                );
                                if (answer == true) {
                                  await s.save(
                                    'paper',
                                    e.data,
                                    id: e.id,
                                    deleted: true,
                                  );
                                }
                              }
                            }),
                            itemBuilder: (_) => [
                              const PopupMenuItem(
                                value: 'edit',
                                child: Text('编辑资料'),
                              ),
                              const PopupMenuItem(
                                value: 'version',
                                child: Text('添加 PDF 版本'),
                              ),
                              PopupMenuItem(
                                value: 'favorite',
                                child: Text(
                                  e.data['important'] == true
                                      ? '取消重要标记'
                                      : '标为重要',
                                ),
                              ),
                              const PopupMenuItem(
                                value: 'citation',
                                child: Text('复制 BibTeX 引用'),
                              ),
                              const PopupMenuItem(
                                value: 'delete',
                                child: Text('移至回收站'),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget notes() => ListView(
    padding: const EdgeInsets.all(26),
    children: [
      const Text(
        '笔记整理',
        style: TextStyle(fontSize: 25, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 18),
      ...s
          .list('note')
          .map(
            (e) => Card(
              elevation: 0,
              child: ListTile(
                title: Text(
                  e.data['conflict_of'] != null
                      ? '并发修改副本'
                      : '${noteLabel(e)} · ${s.entry(e.data['paper_id'] ?? '')?.title ?? '文献笔记'}',
                ),
                subtitle: Text(
                  e.data['content'] ?? '',
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: const Icon(Icons.arrow_outward, size: 16),
                onTap: () {
                  if (e.data['paper_id'] != null) {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => Reader(
                          store: s,
                          paperId: e.data['paper_id'],
                          initialTab: 1,
                          initialNoteId: e.id,
                        ),
                      ),
                    );
                  }
                },
              ),
            ),
          ),
      if (s.list('note').isEmpty)
        const Padding(
          padding: EdgeInsets.only(top: 60),
          child: Center(child: Text('阅读时写下第一条笔记，它会出现在这里。')),
        ),
    ],
  );

  Widget stats() {
    final sessions = s.list('session');
    final seconds = sessions.fold<num>(
      0,
      (v, e) => v + (e.data['seconds'] as num? ?? 0),
    );
    return ListView(
      padding: const EdgeInsets.all(26),
      children: [
        const Text(
          '学习统计',
          style: TextStyle(fontSize: 25, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 25),
        Wrap(
          spacing: 16,
          runSpacing: 16,
          children: [
            for (final stat in [
              ('文献总数', '${s.list('paper').length}'),
              ('阅读时长', '${(seconds / 60).floor()} 分钟'),
              ('笔记', '${s.list('note').length}'),
              ('批注', '${s.list('annotation').length}'),
            ])
              SizedBox(
                width: 190,
                height: 115,
                child: Card(
                  elevation: 0,
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          stat.$1,
                          style: const TextStyle(color: Colors.grey),
                        ),
                        const Spacer(),
                        Text(
                          stat.$2,
                          style: const TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 28),
        const Text('阅读记录'),
        ...sessions.reversed
            .take(30)
            .map(
              (e) => ListTile(
                title: Text(s.entry(e.data['paper_id'] ?? '')?.title ?? '文献'),
                subtitle: Text(e.data['date'] ?? ''),
                trailing: Text(
                  '${((e.data['seconds'] as num? ?? 0) / 60).ceil()} 分钟',
                ),
              ),
            ),
      ],
    );
  }

  Widget trash() => ListView(
    padding: const EdgeInsets.all(26),
    children: [
      const Text(
        '回收站',
        style: TextStyle(fontSize: 25, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 16),
      ...s.entries
          .where((e) => e.kind == 'paper' && e.deleted)
          .map(
            (e) => Card(
              elevation: 0,
              child: ListTile(
                title: Text(e.title),
                trailing: TextButton(
                  onPressed: () =>
                      guarded(context, () => s.save('paper', e.data, id: e.id)),
                  child: const Text('恢复文献'),
                ),
              ),
            ),
          ),
    ],
  );

  Future<void> showConflicts() => showDialog(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('同步冲突'),
      content: SizedBox(
        width: 650,
        child: ListView(
          shrinkWrap: true,
          children: s.conflicts
              .map(
                (conflict) => Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '服务器版本：${conflict['current']?['data']?['content'] ?? conflict['current']?['data']?['title'] ?? '记录已变更'}',
                        ),
                        if (conflict['conflict_copy'] != null) ...[
                          const Divider(),
                          Text(
                            '本地保留副本：${conflict['conflict_copy']['data']['content']}',
                          ),
                          TextButton(
                            onPressed: () async {
                              final current = conflict['current'];
                              final copy = conflict['conflict_copy'];
                              final merged = await textDialog(
                                context,
                                '合并笔记',
                                initial:
                                    '${current['data']['content']}\n\n${copy['data']['content']}',
                                multiline: true,
                              );
                              if (merged != null) {
                                await s.save('note', {
                                  ...Map<String, dynamic>.from(current['data']),
                                  'content': merged,
                                }, id: current['id']);
                                await s.save(
                                  'note',
                                  Map<String, dynamic>.from(copy['data']),
                                  id: copy['id'],
                                  deleted: true,
                                );
                                await s.dismissConflict(conflict['op_id']);
                                if (c.mounted) Navigator.pop(c);
                              }
                            },
                            child: const Text('编辑并合并'),
                          ),
                        ],
                        TextButton(
                          onPressed: () async {
                            await s.dismissConflict(conflict['op_id']);
                            if (c.mounted) Navigator.pop(c);
                          },
                          child: const Text('保留现有版本与副本，标记已处理'),
                        ),
                      ],
                    ),
                  ),
                ),
              )
              .toList(),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: const Text('关闭')),
      ],
    ),
  );
}

Future<void> settings(BuildContext context, Workspace s) async {
  final endpoint = TextEditingController(text: s.endpoint),
      email = TextEditingController(),
      password = TextEditingController();
  final aiUrl = TextEditingController(),
      aiModel = TextEditingController(),
      aiKey = TextEditingController();
  final translateUrl = TextEditingController(),
      translateModel = TextEditingController(),
      translateKey = TextEditingController();
  if (s.token.isNotEmpty) {
    await guarded(context, () async {
      final providers = await s.request('GET', '/providers');
      aiUrl.text = providers['ai']?['endpoint'] ?? '';
      aiModel.text = providers['ai']?['model'] ?? '';
      translateUrl.text = providers['translation']?['endpoint'] ?? '';
      translateModel.text = providers['translation']?['model'] ?? '';
    });
  }
  if (!context.mounted) return;
  await showDialog(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('账号与工作区设置'),
      content: SizedBox(
        width: 600,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: endpoint,
                decoration: const InputDecoration(
                  labelText: '自部署服务器地址',
                  helperText: 'Android 模拟器访问本机使用 http://10.0.2.2:8765',
                ),
              ),
              const SizedBox(height: 16),
              if (s.token.isEmpty) ...[
                TextField(
                  controller: email,
                  decoration: const InputDecoration(labelText: '邮箱'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: password,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: '密码（至少 10 位）'),
                ),
                const SizedBox(height: 12),
                const Text(
                  '本地工作区与各账号使用独立数据库。登录后通过导入迁移已有文献。',
                  style: TextStyle(fontSize: 11, color: Colors.grey),
                ),
                Row(
                  children: [
                    for (final register in [false, true])
                      TextButton(
                        onPressed: () => guarded(c, () async {
                          await s.login(
                            endpoint.text,
                            email.text,
                            password.text,
                            register,
                          );
                          if (c.mounted) Navigator.pop(c);
                        }),
                        child: Text(register ? '注册独立账号' : '登录'),
                      ),
                  ],
                ),
              ] else ...[
                Text('当前账号：${s.userName}'),
                TextButton(
                  onPressed: () => guarded(c, () async {
                    await s.logout();
                    if (c.mounted) Navigator.pop(c);
                  }),
                  child: const Text('退出登录'),
                ),
                const Divider(height: 30),
                const Text('AI 服务（兼容 Chat Completions）'),
                const SizedBox(height: 12),
                for (final field in [
                  (aiUrl, '基础地址，例如 https://服务商/v1'),
                  (aiModel, '模型名称'),
                  (aiKey, 'API Key，留空保留原值'),
                ])
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: TextField(
                      controller: field.$1,
                      obscureText: field.$1 == aiKey,
                      decoration: InputDecoration(labelText: field.$2),
                    ),
                  ),
                const Text('翻译服务（独立配置兼容接口）'),
                const SizedBox(height: 12),
                for (final field in [
                  (translateUrl, '翻译基础地址'),
                  (translateModel, '翻译模型'),
                  (translateKey, '翻译 API Key，留空保留原值'),
                ])
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: TextField(
                      controller: field.$1,
                      obscureText: field.$1 == translateKey,
                      decoration: InputDecoration(labelText: field.$2),
                    ),
                  ),
                FilledButton(
                  onPressed: () => guarded(c, () async {
                    if (aiUrl.text.isNotEmpty) {
                      await s.request('PUT', '/providers/ai', {
                        'endpoint': aiUrl.text,
                        'model': aiModel.text,
                        if (aiKey.text.isNotEmpty) 'api_key': aiKey.text,
                      });
                    }
                    if (translateUrl.text.isNotEmpty) {
                      await s.request('PUT', '/providers/translation', {
                        'endpoint': translateUrl.text,
                        'model': translateModel.text,
                        if (translateKey.text.isNotEmpty)
                          'api_key': translateKey.text,
                      });
                    }
                    if (c.mounted) {
                      ScaffoldMessenger.of(
                        c,
                      ).showSnackBar(const SnackBar(content: Text('配置已保存')));
                    }
                  }),
                  child: const Text('保存服务配置'),
                ),
                const Divider(height: 30),
                OutlinedButton.icon(
                  onPressed: () => guarded(c, () async {
                    final file = await FilePicker.platform.pickFiles(
                      type: FileType.custom,
                      allowedExtensions: ['json', 'bib', 'ris'],
                      withData: true,
                    );
                    if (file == null || file.files.single.bytes == null) return;
                    final preview = await s.upload(
                      file.files.single.bytes!,
                      file.files.single.name,
                      path: '/migration/preview',
                    );
                    if (!c.mounted) return;
                    final proceed = await showDialog<bool>(
                      context: c,
                      builder: (p) => AlertDialog(
                        title: const Text('迁移预览'),
                        content: SizedBox(
                          width: 520,
                          child: SingleChildScrollView(
                            child: Text(
                              '文献 ${preview['count']} 篇，缺少文件 ${preview['missing_files']} 篇\n\n${(preview['warnings'] as List).join('\n')}\n\n${(preview['items'] as List).take(20).map((e) => e['title']).join('\n')}',
                            ),
                          ),
                        ),
                        actions: [
                          TextButton(
                            onPressed: () => Navigator.pop(p, false),
                            child: const Text('取消'),
                          ),
                          FilledButton(
                            onPressed: () => Navigator.pop(p, true),
                            child: const Text('确认导入'),
                          ),
                        ],
                      ),
                    );
                    if (proceed == true) {
                      final result = await s.request(
                        'POST',
                        '/migration/commit',
                        preview,
                      );
                      await s.sync();
                      if (c.mounted) {
                        ScaffoldMessenger.of(c).showSnackBar(
                          SnackBar(
                            content: Text(
                              '导入 ${result['imported']}，跳过 ${result['skipped']}，需处理 ${(result['failures'] as List).length}',
                            ),
                          ),
                        );
                      }
                    }
                  }),
                  icon: const Icon(Icons.move_to_inbox_outlined),
                  label: const Text('迁移 JSON / BibTeX / RIS 清单'),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: const Text('关闭')),
      ],
    ),
  );
  for (final controller in [
    endpoint,
    email,
    password,
    aiUrl,
    aiModel,
    aiKey,
    translateUrl,
    translateModel,
    translateKey,
  ]) {
    controller.dispose();
  }
}

class DiscoverPane extends StatefulWidget {
  final Workspace store;
  const DiscoverPane({super.key, required this.store});
  @override
  State<DiscoverPane> createState() => _DiscoverPaneState();
}

class _DiscoverPaneState extends State<DiscoverPane> {
  final query = TextEditingController();
  String source = 'crossref';
  bool busy = false;
  List results = [];
  int total = 0, page = 1;
  @override
  void dispose() {
    query.dispose();
    super.dispose();
  }

  Future<void> search({int target = 1}) async {
    if (query.text.trim().isEmpty) return;
    setState(() => busy = true);
    await guarded(context, () async {
      final response = await widget.store.request(
        'GET',
        '/discover?q=${Uri.encodeQueryComponent(query.text)}&source=$source&page=$target',
      );
      if (mounted) {
        setState(() {
          results = response['items'];
          total = response['total'];
          page = target;
        });
      }
    });
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(26),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '发现论文',
          style: TextStyle(fontSize: 25, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 8),
        const Text(
          '从公开学术数据源寻找下一篇值得阅读的论文',
          style: TextStyle(color: Colors.grey, fontSize: 12),
        ),
        const SizedBox(height: 24),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: query,
                onSubmitted: (_) => search(),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: '论文标题、关键词或 DOI',
                ),
              ),
            ),
            const SizedBox(width: 10),
            DropdownButton<String>(
              value: source,
              items: [
                'crossref',
                'openalex',
              ].map((v) => DropdownMenuItem(value: v, child: Text(v))).toList(),
              onChanged: (v) => setState(() => source = v!),
            ),
            const SizedBox(width: 10),
            FilledButton(
              onPressed: busy ? null : () => search(),
              child: const Text('搜索'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        if (busy) const LinearProgressIndicator(),
        Text(
          '结果 $total · 第 $page 页',
          style: const TextStyle(color: Colors.grey, fontSize: 11),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: results.length,
            itemBuilder: (context, i) {
              final paper = results[i];
              return Card(
                elevation: 0,
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        paper['title'] ?? '',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        '${(paper['authors'] as List? ?? []).take(5).join(', ')} · ${paper['year'] ?? '年份未知'}',
                        style: const TextStyle(
                          color: Colors.grey,
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(height: 8),
                      SelectableText(
                        '${paper['doi'] ?? paper['source_id'] ?? ''}',
                        style: const TextStyle(fontSize: 11),
                      ),
                      Row(
                        children: [
                          TextButton.icon(
                            onPressed: () => guarded(
                              context,
                              () => widget.store.save('paper', {
                                ...Map<String, dynamic>.from(paper),
                                'status': '未读',
                                'tags': <String>[],
                              }),
                            ),
                            icon: const Icon(
                              Icons.bookmark_add_outlined,
                              size: 18,
                            ),
                            label: const Text('加入文献库'),
                          ),
                          TextButton(
                            onPressed: () => paper['doi'] != null
                                ? showRelations(
                                    context,
                                    widget.store,
                                    paper['doi'],
                                  )
                                : showDialog(
                                    context: context,
                                    builder: (c) => AlertDialog(
                                      title: const Text('参考文献与引用关系'),
                                      content: SizedBox(
                                        width: 600,
                                        child: SingleChildScrollView(
                                          child: SelectableText(
                                            const JsonEncoder.withIndent(
                                              '  ',
                                            ).convert(
                                              paper['references'] ?? [],
                                            ),
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
                            child: Text(
                              '参考文献 ${(paper['references'] as List? ?? []).length}',
                            ),
                          ),
                          if (paper['citation_count'] != null)
                            Text(
                              '被引 ${paper['citation_count']}',
                              style: const TextStyle(
                                fontSize: 11,
                                color: Colors.grey,
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton(
              onPressed: page > 1 && !busy
                  ? () => search(target: page - 1)
                  : null,
              child: const Text('上一页'),
            ),
            TextButton(
              onPressed: results.length == 20 && !busy
                  ? () => search(target: page + 1)
                  : null,
              child: const Text('下一页'),
            ),
          ],
        ),
      ],
    ),
  );
}
