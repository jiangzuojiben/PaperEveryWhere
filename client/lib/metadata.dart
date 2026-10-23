import 'package:flutter/material.dart';
import 'store.dart';

const metadataFields = {
  'title': '标题',
  'authors': '作者',
  'year': '年份',
  'doi': 'DOI',
  'journal': '期刊 / 会议',
  'abstract': '摘要',
  'volume': '卷',
  'issue': '期',
  'pages': '页码',
  'publisher': '出版方',
  'issn': 'ISSN',
  'isbn': 'ISBN',
  'url': '原文链接',
  'publication_type': '文献类型',
  'references': '参考文献',
  'citation_count': '被引次数',
};

Future<Map<String, dynamic>?> metadataPreview(
  BuildContext context,
  Workspace store,
  String doi,
  Map<String, dynamic> current,
) async {
  final result = await store.request(
    'GET',
    '/metadata?doi=${Uri.encodeQueryComponent(doi)}',
  );
  final data = Map<String, dynamic>.from(result['metadata']);
  final candidates = metadataFields.keys.where((key) {
    final value = data[key];
    return value != null &&
        value.toString().isNotEmpty &&
        value.toString() != '[]' &&
        value.toString() != current[key]?.toString();
  }).toList();
  final selected = candidates.toSet();
  if (!context.mounted) return null;
  return showDialog<Map<String, dynamic>>(
    context: context,
    builder: (c) => StatefulBuilder(
      builder: (c, update) => AlertDialog(
        title: const Text('Crossref 元数据预览'),
        content: SizedBox(
          width: 560,
          height: 420,
          child: candidates.isEmpty
              ? const Center(child: Text('没有可补全的字段'))
              : ListView(
                  children: candidates
                      .map(
                        (key) => CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          value: selected.contains(key),
                          title: Text(metadataFields[key]!),
                          subtitle: Text(
                            '${current[key] ?? '未填写'} → ${data[key]}',
                            maxLines: 4,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12),
                          ),
                          onChanged: (v) => update(() {
                            if (v == true) {
                              selected.add(key);
                            } else {
                              selected.remove(key);
                            }
                          }),
                        ),
                      )
                      .toList(),
                ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: selected.isEmpty
                ? null
                : () => Navigator.pop(c, {
                    for (final key in selected) key: data[key],
                    'metadata_source': 'crossref',
                    'metadata_fetched_at': DateTime.now()
                        .toUtc()
                        .toIso8601String(),
                  }),
            child: const Text('应用所选字段'),
          ),
        ],
      ),
    ),
  );
}
