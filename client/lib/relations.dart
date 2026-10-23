import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'store.dart';

Future<void> showRelations(BuildContext context, Workspace store, String doi) =>
    showDialog(
      context: context,
      builder: (_) => Dialog(
        child: SizedBox(
          width: 850,
          height: 680,
          child: RelationsPane(store: store, doi: doi),
        ),
      ),
    );

class RelationsPane extends StatefulWidget {
  final Workspace store;
  final String doi;
  const RelationsPane({super.key, required this.store, required this.doi});
  @override
  State<RelationsPane> createState() => _RelationsPaneState();
}

class _RelationsPaneState extends State<RelationsPane> {
  Map<String, dynamic>? result;
  String? error;
  int tab = 0;
  @override
  void initState() {
    super.initState();
    load(widget.doi);
  }

  Future<void> load(String doi) async {
    setState(() {
      result = null;
      error = null;
    });
    try {
      final value = await widget.store.request(
        'GET',
        '/discover/relations?doi=${Uri.encodeQueryComponent(doi)}',
      );
      if (mounted) setState(() => result = Map<String, dynamic>.from(value));
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Widget node(Map work, Color color) => InkWell(
    onTap: () {
      if (work['doi'] != null) load(work['doi']);
    },
    child: Container(
      width: 180,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .1),
        border: Border.all(color: color.withValues(alpha: .4)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        work['title'] ?? '',
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 10, color: color),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(20),
    child: Column(
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                '论文引用关系',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
            ),
            IconButton(
              onPressed: () => Navigator.pop(context),
              icon: const Icon(Icons.close),
            ),
          ],
        ),
        if (error != null)
          Expanded(child: Center(child: SelectableText(error!)))
        else if (result == null)
          const Expanded(child: Center(child: CircularProgressIndicator()))
        else ...[
          Text(
            result!['work']['title'] ?? '',
            maxLines: 2,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          Expanded(
            flex: 2,
            child: LayoutBuilder(
              builder: (context, constraints) {
                if (constraints.maxWidth < 600) {
                  return Center(
                    child: node(result!['work'], const Color(0xff4562ed)),
                  );
                }
                final refs = (result!['references'] as List).take(3).toList(),
                    cites = (result!['cited_by'] as List).take(3).toList();
                return Stack(
                  children: [
                    Positioned.fill(
                      child: CustomPaint(
                        painter: RelationPainter(refs.length, cites.length),
                      ),
                    ),
                    Align(
                      alignment: Alignment.center,
                      child: node(result!['work'], const Color(0xff4562ed)),
                    ),
                    for (int i = 0; i < refs.length; i++)
                      Positioned(
                        left: 0,
                        top:
                            (i + .5) /
                                math.max(1, refs.length) *
                                constraints.maxHeight -
                            25,
                        child: node(refs[i], const Color(0xff27846b)),
                      ),
                    for (int i = 0; i < cites.length; i++)
                      Positioned(
                        right: 0,
                        top:
                            (i + .5) /
                                math.max(1, cites.length) *
                                constraints.maxHeight -
                            25,
                        child: node(cites[i], const Color(0xffa57437)),
                      ),
                  ],
                );
              },
            ),
          ),
          Wrap(
            spacing: 8,
            children: [
              for (int i = 0; i < 3; i++)
                ChoiceChip(
                  label: Text(['参考文献', '引用本文', '相关论文'][i]),
                  selected: tab == i,
                  onSelected: (_) => setState(() => tab = i),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Expanded(
            flex: 3,
            child: ListView(
              children:
                  (result![['references', 'cited_by', 'related'][tab]] as List)
                      .map(
                        (work) => ListTile(
                          title: Text(
                            work['title'] ?? '',
                            style: const TextStyle(fontSize: 12),
                          ),
                          subtitle: Text(
                            '${work['year'] ?? ''} · ${(work['authors'] as List? ?? []).take(3).join(', ')}',
                            style: const TextStyle(fontSize: 10),
                          ),
                          onTap: () {
                            if (work['doi'] != null) load(work['doi']);
                          },
                          trailing: IconButton(
                            tooltip: '加入文献库',
                            icon: const Icon(
                              Icons.bookmark_add_outlined,
                              size: 18,
                            ),
                            onPressed: () async {
                              await widget.store.save('paper', {
                                ...Map<String, dynamic>.from(work),
                                'source': 'openalex',
                                'status': '未读',
                                'tags': <String>[],
                              });
                            },
                          ),
                        ),
                      )
                      .toList(),
            ),
          ),
          const Text(
            '来源 OpenAlex · 每类最多展示 20 篇；点击论文继续探索',
            style: TextStyle(fontSize: 10, color: Colors.grey),
          ),
        ],
      ],
    ),
  );
}

class RelationPainter extends CustomPainter {
  final int references, citations;
  RelationPainter(this.references, this.citations);
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final paint = Paint()
      ..color = Colors.blueGrey.withValues(alpha: .3)
      ..strokeWidth = 1.2;
    for (int i = 0; i < references; i++) {
      canvas.drawLine(
        center,
        Offset(180, (i + .5) / references * size.height),
        paint,
      );
    }
    for (int i = 0; i < citations; i++) {
      canvas.drawLine(
        center,
        Offset(size.width - 180, (i + .5) / citations * size.height),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant RelationPainter oldDelegate) =>
      references != oldDelegate.references ||
      citations != oldDelegate.citations;
}
