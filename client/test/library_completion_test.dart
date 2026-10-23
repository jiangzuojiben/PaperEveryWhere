import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:paperdesk/store.dart';
import 'package:paperdesk/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory dir;
  setUp(() {
    SharedPreferences.setMockInitialValues({'user_id': 'account-a'});
    dir = Directory.systemTemp.createTempSync('paperdesk-library-');
  });
  Future<Workspace> open({MockClient? client}) async {
    final s = Workspace(databasePath: '${dir.path}/library.db', client: client);
    await s.initialize();
    return s;
  }

  http.Response response(Object data) => http.Response(
    jsonEncode(data),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
  final group = {'id': 'lab', 'name': 'Research', 'role': 'editor'};

  test(
    'migration retains multiple folders and moving replaces memberships',
    () async {
      final s = await open();
      final a = await s.save('folder', {'name': 'A'});
      final b = await s.save('folder', {'name': 'B'});
      final paper = await s.save('paper', {
        'title': 'Shared classification',
        'folder_id': a.id,
        'folder_ids': [a.id, b.id],
      });
      expect(s.paperInFolder(paper, a.id), isTrue);
      expect(s.paperInFolder(paper, b.id), isTrue);
      await expectLater(
        s.save('folder', b.data, id: b.id, deleted: true),
        throwsStateError,
      );
      await s.bulkPapers({paper.id}, moveFolder: true, folderId: a.id);
      expect(s.paperInFolder(s.entry(paper.id)!, b.id), isFalse);
      await s.save('folder', b.data, id: b.id, deleted: true);
      await s.close();
      final restored = await open();
      expect(restored.paperInFolder(restored.entry(paper.id)!, a.id), isTrue);
      await restored.close();
    },
  );

  test(
    'offline restart restores group selection and role without leaking to another account',
    () async {
      final s = await open(
        client: MockClient(
          (r) async => response({
            'items': [group],
          }),
        ),
      );
      await s.refreshGroups();
      await s.switchScope('g:lab');
      final paper = await s.save('paper', {'title': 'Offline group paper'});
      await s.close();
      final restored = await open();
      expect(restored.scope, 'g:lab');
      expect(restored.canEdit, true);
      expect(restored.entry(paper.id)!.title, 'Offline group paper');
      expect(restored.pending, 1);
      await restored.close();
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('user_id', 'account-b');
      final other = await open();
      expect(other.scope, 'personal');
      expect(other.groups, isEmpty);
      await expectLater(other.switchScope('g:lab'), throwsStateError);
      await other.close();
    },
  );

  test(
    'downgrade refresh happens before uploads and keeps unsent edits intact',
    () async {
      final calls = <String>[];
      final s = await open(
        client: MockClient((r) async {
          calls.add(r.url.path);
          if (r.url.path.endsWith('/groups')) {
            return response({
              'items': [
                {...group, 'role': 'viewer'},
              ],
            });
          }
          final body = jsonDecode(r.body);
          expect(body['operations'], isEmpty);
          return response({
            'results': [],
            'changes': [],
            'cursor': 0,
            'has_more': false,
          });
        }),
      );
      s.groups = [group];
      await s.switchScope('g:lab');
      await s.save('paper', {'title': 'Unsent local draft'});
      s.token = 'test';
      await s.sync();
      expect(calls.first, '/api/v1/groups');
      expect(calls, isNot(contains('/api/v1/files')));
      expect(s.canEdit, false);
      expect(s.pending, 1);
      expect(s.list('paper').single.title, 'Unsent local draft');
      await s.close();
    },
  );

  test(
    'membership removal falls back to personal and preserves detached outbox',
    () async {
      final s = await open(
        client: MockClient((r) async {
          if (r.url.path.endsWith('/groups')) return response({'items': []});
          final body = jsonDecode(r.body);
          expect(body['scope'], 'personal');
          expect(body['operations'], isEmpty);
          return response({
            'results': [],
            'changes': [],
            'cursor': 0,
            'has_more': false,
          });
        }),
      );
      s.groups = [group];
      await s.switchScope('g:lab');
      await s.save('paper', {'title': 'Preserved'});
      s.token = 'test';
      await s.sync();
      expect(s.scope, 'personal');
      expect(s.list('paper'), isEmpty);
      expect(s.pending, 1);
      await s.close();
    },
  );

  test(
    'batch edits are atomic, preserve versions and collapse pending operations',
    () async {
      final s = await open();
      final folder = await s.save('folder', {'title': 'Methods'});
      final a = await s.save('paper', {
        'title': 'A',
        'file_hash': 'hash-a',
        'tags': ['old'],
      });
      final b = await s.save('paper', {'title': 'B', 'file_hash': 'hash-b'});
      await expectLater(
        s.bulkPapers({a.id, 'missing'}, statusValue: '已读'),
        throwsStateError,
      );
      expect(s.entry(a.id)!.data['status'], isNull);
      await s.bulkPapers(
        {a.id, b.id},
        statusValue: '已读',
        moveFolder: true,
        folderId: folder.id,
        addTags: ['old', 'new', ' new '],
        important: true,
      );
      expect(s.entry(a.id)!.data['file_hash'], 'hash-a');
      expect(s.entry(a.id)!.data['tags'], ['old', 'new']);
      expect(s.entry(b.id)!.data['folder_id'], folder.id);
      expect(s.pending, 3);
      await s.close();
      final reopened = await open();
      expect(reopened.entry(b.id)!.data['status'], '已读');
      await reopened.bulkPapers({a.id, b.id}, trash: true);
      expect(reopened.list('paper'), isEmpty);
      expect(reopened.pending, 3);
      await reopened.close();
    },
  );

  testWidgets(
    'phone library selects filtered papers and applies batch status',
    (tester) async {
      final s = (await tester.runAsync(() async {
        final s = await open();
        await s.save('paper', {'title': 'Paper A'});
        await s.save('paper', {'title': 'Paper B'});
        return s;
      }))!;
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(PaperDesk(store: s));
      await tester.pumpAndSettle();
      await tester.tap(find.text('批量管理'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('全选当前结果'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('批量操作（2）'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('标为已读'));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 300)),
      );
      await tester.pumpAndSettle();
      expect(s.list('paper').every((e) => e.data['status'] == '已读'), true);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(s.close);
    },
  );
}
