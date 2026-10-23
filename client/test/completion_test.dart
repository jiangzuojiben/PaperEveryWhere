import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:paperdesk/store.dart';
import 'package:paperdesk/notes.dart';
import 'package:paperdesk/groups.dart';
import 'package:paperdesk/metadata.dart';
import 'package:paperdesk/annotation_tools.dart';
import 'package:paperdesk/reader.dart';
import 'package:sqflite/sqflite.dart';
import 'package:pdfrx/pdfrx.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory dir;
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    dir = Directory.systemTemp.createTempSync('paperdesk-completion-');
  });
  Future<Workspace> local({MockClient? client}) async {
    final s = Workspace(databasePath: '${dir.path}/test.db', client: client);
    await s.initialize();
    return s;
  }

  Future<void> drain(WidgetTester tester) async {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 250)),
    );
    await tester.pump();
  }

  test(
    'stale editor keeps concurrent draft and conflict metadata on reopen',
    () async {
      final s = await local();
      final paper = await s.save('paper', {'title': 'Research'});
      final base = await s.save('note', {
        'paper_id': paper.id,
        'content': 'base',
        'category': 'question',
        'title': 'Why?',
      });
      await s.save('note', {...base.data, 'content': 'remote'}, id: base.id);
      final copy = await s.save(
        'note',
        {...base.data, 'content': 'my draft'},
        id: base.id,
        basedOn: base,
      );
      expect(copy.id, isNot(base.id));
      expect(copy.data['conflict_of'], base.id);
      final reopened = await local();
      expect(reopened.entry(base.id)!.data['content'], 'remote');
      expect(reopened.entry(copy.id)!.data['content'], 'my draft');
      expect(reopened.entry(copy.id)!.data['category'], 'question');
    },
  );

  test('viewer cannot queue edits while offline', () async {
    final s = await local();
    s.groups = [
      {'id': 'private', 'role': 'viewer'},
    ];
    s.scope = 'g:private';
    await expectLater(
      s.save('paper', {'title': 'Forbidden'}),
      throwsStateError,
    );
    expect(s.pending, 0);
    s.groups.first['role'] = 'editor';
    await s.save('paper', {'title': 'Allowed'});
    expect(s.pending, 1);
  });

  test(
    'version 1 workspace upgrades without losing papers or pending edits',
    () async {
      final s = await local();
      final paper = await s.save('paper', {
        'title': 'Existing library',
        'file_hash': 'hash-a',
      });
      await s.close();
      final legacy = await openDatabase('${dir.path}/test.db');
      await legacy.execute('DROP TABLE page_text');
      await legacy.execute('PRAGMA user_version=1');
      await legacy.close();
      final upgraded = await local();
      expect(upgraded.entry(paper.id)!.title, 'Existing library');
      expect(upgraded.pending, 1);
      await upgraded.indexPage(paper.id, 'hash-a', 1, 'migrationmarker');
      expect(await upgraded.fullTextSearch('migrationmarker'), [paper.id]);
    },
  );

  testWidgets(
    'latest other-device progress resumes without overwriting its record',
    (tester) async {
      final s = (await tester.runAsync(() async {
        Pdfrx.cacheDirectoryPath = dir.path;
        await pdfrxFlutterInitialize();
        final s = await local();
        s.deviceId = 'current-device';
        final p = await s.importPdf(
          await File('test/fixtures/reader.pdf').readAsBytes(),
          'progress.pdf',
        );
        await s.save('progress', {
          'paper_id': p.id,
          'file_hash': p.data['file_hash'],
          'page': 2,
          'device': 'current-device',
          'date': '2025-01-01T00:00:00Z',
        });
        await s.save('progress', {
          'paper_id': p.id,
          'file_hash': p.data['file_hash'],
          'page': 4,
          'device': 'other-device',
          'date': '2025-01-02T00:00:00Z',
        });
        return s;
      }))!;
      final own = s.list('progress').first, other = s.list('progress').last;
      await tester.pumpWidget(
        MaterialApp(
          home: Reader(store: s, paperId: s.list('paper').single.id),
        ),
      );
      for (
        int attempt = 0;
        attempt < 50 && find.text('4 / 4').evaluate().isEmpty;
        attempt++
      ) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 100)),
        );
        await tester.pump();
      }
      expect(find.text('4 / 4'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 200));
      await drain(tester);
      expect(s.list('progress').length, 2);
      expect(s.entry(own.id)!.data['page'], 4);
      expect(s.entry(other.id)!.data['date'], '2025-01-02T00:00:00Z');
      expect(tester.takeException(), isNull);
    },
  );

  test(
    'page index searches beyond old limit and retains only active version after edits',
    () async {
      final s = await local();
      final p = await s.save('paper', {
        'title': 'Large book',
        'file_hash': 'hash-a',
      });
      await s.indexPage(p.id, 'hash-a', 1, 'prefix ' * 110000);
      await s.indexPage(p.id, 'hash-a', 2, '末尾中文检索 tailmarker');
      expect(await s.fullTextSearch('tailmarker'), [p.id]);
      expect(await s.fullTextSearch('中文检索'), [p.id]);
      await s.save('paper', {...p.data, 'title': 'Renamed'}, id: p.id);
      expect(await s.fullTextSearch('tailmarker'), [p.id]);
      await s.save('paper', {...p.data, 'file_hash': 'hash-b'}, id: p.id);
      expect(await s.fullTextSearch('tailmarker'), isEmpty);
      await s.save('paper', p.data, id: p.id);
      expect((await local()).fullTextSearch('tailmarker'), completion([p.id]));
      await s.save('paper', p.data, id: p.id, deleted: true);
      expect(await s.fullTextSearch('tailmarker'), isEmpty);
    },
  );

  test('one synchronization drains more than one upload batch', () async {
    int calls = 0;
    final s = await local(
      client: MockClient((r) async {
        if (r.url.path.endsWith('/groups')) {
          return http.Response('{"items":[]}', 200);
        }
        calls++;
        final ops = jsonDecode(r.body)['operations'] as List;
        final results = [
          for (final op in ops)
            {
              'op_id': op['op_id'],
              'status': 'applied',
              'record': {
                'id': op['entity_id'],
                'kind': op['kind'],
                'scope': 'u:offline',
                'revision': 1,
                'data': op['data'],
                'deleted': false,
              },
            },
        ];
        return http.Response(
          jsonEncode({
            'results': results,
            'changes': [],
            'cursor': 0,
            'has_more': false,
          }),
          200,
        );
      }),
    );
    for (int n = 0; n < 105; n++) {
      await s.save('paper', {'title': 'Paper $n'});
    }
    s.token = 'test';
    await s.sync();
    expect(s.pending, 0, reason: s.status);
    expect(calls, 2);
    expect(s.list('paper').every((p) => p.revision == 1), true);
  });

  test(
    'annotation undo and redo survive database reopen and protect newer edits',
    () async {
      final s = await local();
      final edits = AnnotationEdits(s);
      final ink = await edits.write({
        'type': 'ink',
        'page': 1,
        'points': [
          {'x': .1, 'y': .2, 'pressure': .5},
          {'x': .3, 'y': .4, 'pressure': .8},
        ],
      });
      await edits.undo();
      expect(s.list('annotation'), isEmpty);
      await edits.redo();
      await edits.write(ink.data, id: ink.id, deleted: true);
      await edits.undo();
      expect((await local()).list('annotation').single.id, ink.id);
      await s.save('annotation', {...ink.data, 'color': '#123456'}, id: ink.id);
      await expectLater(edits.redo(), throwsStateError);
      expect(s.entry(ink.id)!.deleted, false);
      expect(s.entry(ink.id)!.data['color'], '#123456');
    },
  );

  test(
    'eraser tests segments rather than bounding boxes at different page scales',
    () {
      final diagonal = {
        'type': 'ink',
        'points': [
          {'x': .1, 'y': .1},
          {'x': .9, 'y': .9},
        ],
      };
      expect(
        annotationHit(diagonal, const Offset(500, 500), const Size(1000, 1000)),
        true,
      );
      expect(
        annotationHit(diagonal, const Offset(100, 900), const Size(1000, 1000)),
        false,
      );
      expect(
        annotationHit(diagonal, const Offset(50, 104), const Size(100, 200)),
        true,
      );
      final rectangle = {
        'type': 'rectangle',
        'rects': [
          [.1, .1, .9, .9],
        ],
      };
      expect(
        annotationHit(
          rectangle,
          const Offset(500, 500),
          const Size(1000, 1000),
        ),
        false,
      );
      expect(
        annotationHit(
          rectangle,
          const Offset(105, 500),
          const Size(1000, 1000),
        ),
        true,
      );
    },
  );

  testWidgets('pen-only input rejects a finger and accepts stylus pressure', (
    tester,
  ) async {
    final strokes = <Map<String, dynamic>>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 400,
            height: 400,
            child: AnnotationLayer(
              mode: 'ink',
              color: '#123456',
              penOnly: true,
              annotations: const [],
              onCreate: (data) async {
                strokes.add(data);
              },
            ),
          ),
        ),
      ),
    );
    await tester.drag(find.byType(AnnotationLayer), const Offset(30, 50));
    expect(strokes, isEmpty);
    final pen = await tester.startGesture(
      const Offset(100, 100),
      kind: PointerDeviceKind.stylus,
    );
    await pen.moveBy(const Offset(30, 20));
    await pen.up();
    await tester.pump();
    expect(strokes.single['type'], 'ink');
    expect((strokes.single['points'] as List).length, greaterThan(1));
    expect(tester.takeException(), isNull);
  });

  test(
    'folder moves preserve descendants and reject cycles and nonempty deletion',
    () async {
      final s = await local();
      final parent = await s.save('folder', {'title': 'Research'});
      final child = await s.save('folder', {
        'title': 'Rendering',
        'parent_id': parent.id,
      });
      final paper = await s.save('paper', {
        'title': 'Paper',
        'folder_id': child.id,
      });
      expect(s.folderPath(child.id), 'Research / Rendering');
      expect(s.folderIds(parent.id), {parent.id, child.id});
      await expectLater(
        s.save('folder', {
          ...parent.data,
          'parent_id': child.id,
        }, id: parent.id),
        throwsStateError,
      );
      await expectLater(
        s.save('folder', child.data, id: child.id, deleted: true),
        throwsStateError,
      );
      await s.save('paper', {
        ...paper.data,
        'folder_id': parent.id,
      }, id: paper.id);
      await s.save('folder', child.data, id: child.id, deleted: true);
      expect(s.folderIds(parent.id), {parent.id});
    },
  );

  testWidgets(
    'select requested note, clear and immediately leave persists empty content',
    (tester) async {
      final s = (await tester.runAsync(() async {
        final s = await local();
        final paper = await s.save('paper', {'title': 'Notes'});
        await s.save('note', {
          'paper_id': paper.id,
          'content': 'first',
          'category': 'summary',
        });
        await s.save('note', {
          'paper_id': paper.id,
          'content': 'second',
          'category': 'question',
          'conflict_of': 'original',
        });
        return s;
      }))!;
      final selected = s.list('note').last;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PaperNotes(
              store: s,
              paperId: s.list('paper').single.id,
              initialNoteId: selected.id,
              renderMarkdown: Text.new,
            ),
          ),
        ),
      );
      expect(find.text('second'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('note-content')), '');
      await tester.pumpWidget(const SizedBox());
      await drain(tester);
      expect(s.entry(selected.id)!.data['content'], '');
      expect(s.entry(selected.id)!.data['conflict_of'], 'original');
      expect(s.list('note').first.data['content'], 'first');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'switching notes flushes pending draft and supports new category',
    (tester) async {
      final s = (await tester.runAsync(() async {
        final s = await local();
        final p = await s.save('paper', {'title': 'Notes'});
        await s.save('note', {
          'paper_id': p.id,
          'title': 'One',
          'content': 'first',
        });
        await s.save('note', {
          'paper_id': p.id,
          'title': 'Two',
          'content': 'second',
        });
        return s;
      }))!;
      final first = s.list('note').first;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PaperNotes(
              store: s,
              paperId: s.list('paper').single.id,
              renderMarkdown: Text.new,
            ),
          ),
        ),
      );
      await tester.enterText(
        find.byKey(const ValueKey('note-content')),
        'changed before debounce',
      );
      await tester.tap(find.byKey(const ValueKey('note-selector')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Two').last);
      await drain(tester);
      await tester.pumpAndSettle();
      expect(s.entry(first.id)!.data['content'], 'changed before debounce');
      expect(find.text('second'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('note-category')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('想法').last);
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await drain(tester);
      expect(s.list('note').last.data['category'], 'idea');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('member management changes role and removes only non-owner', (
    tester,
  ) async {
    final calls = <String>[];
    final members = <Map<String, dynamic>>[
      {
        'id': 'owner',
        'email': 'owner@example.com',
        'name': 'Owner',
        'role': 'owner',
      },
      {
        'id': 'reader',
        'email': 'reader@example.com',
        'name': 'Reader',
        'role': 'viewer',
      },
    ];
    final s = (await tester.runAsync(
      () => local(
        client: MockClient((r) async {
          calls.add('${r.method} ${r.url.path}');
          if (r.method == 'PUT') {
            members.last['role'] = jsonDecode(r.body)['role'];
          }
          if (r.method == 'DELETE') members.removeLast();
          return http.Response(
            jsonEncode({'items': members}),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      ),
    ))!;
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(
      MaterialApp(
        home: GroupMembers(
          store: s,
          group: const {'id': 'g', 'name': 'Lab', 'role': 'owner'},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(DropdownButton<String>), findsOneWidget);
    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('可编辑').last);
    await tester.pumpAndSettle();
    expect(members.last['role'], 'editor');
    await tester.tap(find.byTooltip('移除 reader@example.com'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '移除'));
    await tester.pumpAndSettle();
    expect(members.length, 1);
    expect(calls, contains('DELETE /api/v1/groups/g/members/reader'));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('metadata preview only applies checked fields', (tester) async {
    final s = (await tester.runAsync(
      () => local(
        client: MockClient((r) async {
          expect(r.url.queryParameters['doi'], '10.1000/test');
          return http.Response(
            jsonEncode({
              'metadata': {'title': 'Provider title', 'year': 2025},
            }),
            200,
          );
        }),
      ),
    ))!;
    Map<String, dynamic>? accepted;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) => Scaffold(
            body: TextButton(
              child: const Text('lookup'),
              onPressed: () async {
                accepted = await metadataPreview(c, s, '10.1000/test', {
                  'title': 'My title',
                });
              },
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('lookup'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(CheckboxListTile, '标题'));
    await tester.tap(find.text('应用所选字段'));
    await tester.pumpAndSettle();
    expect(accepted!['year'], 2025);
    expect(accepted, isNot(contains('title')));
    expect(accepted!['metadata_source'], 'crossref');
  });

  testWidgets(
    'deleting a note can be undone with title category and anchor intact',
    (tester) async {
      final s = (await tester.runAsync(() async {
        final s = await local();
        final p = await s.save('paper', {'title': 'Paper'});
        await s.save('note', {
          'paper_id': p.id,
          'title': 'Important question',
          'category': 'question',
          'content': 'Why this method?',
          'page': 3,
        });
        return s;
      }))!;
      final original = s.list('note').single;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PaperNotes(
              store: s,
              paperId: s.list('paper').single.id,
              renderMarkdown: Text.new,
            ),
          ),
        ),
      );
      await tester.tap(find.byTooltip('笔记操作'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('删除笔记'));
      await drain(tester);
      await tester.pumpAndSettle();
      expect(s.list('note'), isEmpty);
      await tester.tap(find.text('撤销'));
      await drain(tester);
      await tester.pumpAndSettle();
      expect(s.list('note').single.id, original.id);
      expect(s.list('note').single.data['category'], 'question');
      expect(s.list('note').single.data['page'], 3);
      expect(find.text('Why this method?'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
