import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:paperdesk/main.dart';
import 'package:paperdesk/store.dart';
import 'package:paperdesk/reader.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory directory;
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    directory = Directory.systemTemp.createTempSync('paperdesk-client-test-');
  });

  Future<Workspace> local({
    MockClient? client,
    String name = 'workspace',
  }) async {
    final store = Workspace(
      databasePath: '${directory.path}/$name.db',
      client: client,
    );
    await store.initialize();
    return store;
  }

  test(
    'offline edits survive reopening and collapse pending mutations',
    () async {
      final store = await local();
      final paper = await store.save('paper', {
        'title': 'Offline rendering research',
        'tags': ['graphics'],
      });
      await store.save('paper', {
        ...paper.data,
        'title': 'Revised title',
      }, id: paper.id);
      await store.save('note', {
        'paper_id': paper.id,
        'content': 'A durable local note',
      });
      expect(store.pending, 2);
      final reopened = await local();
      expect(reopened.entry(paper.id)!.title, 'Revised title');
      expect(
        reopened.list('note').single.data['content'],
        'A durable local note',
      );
      expect(reopened.pending, 2);
    },
  );

  test(
    'full text index updates and tombstones disappear from results',
    () async {
      final store = await local();
      final paper = await store.save('paper', {
        'title': 'Research',
        'full_text': 'volumetric underwater rendering',
      });
      expect(await store.fullTextSearch('underwater'), contains(paper.id));
      await store.save('paper', paper.data, id: paper.id, deleted: true);
      expect(store.list('paper'), isEmpty);
      expect(await store.fullTextSearch('underwater'), isEmpty);
    },
  );

  test('sync consumes acknowledgements and advances durable cursor', () async {
    int sequence = 0;
    final client = MockClient((request) async {
      if (request.url.path.endsWith('/groups')) {
        return http.Response('{"items":[]}', 200);
      }
      final body = jsonDecode(request.body);
      final results = [], changes = [];
      for (final op in body['operations']) {
        final record = {
          'id': op['entity_id'],
          'kind': op['kind'],
          'scope': 'u:offline',
          'revision': 1,
          'data': op['data'],
          'deleted': op['deleted'],
          'updated': 1.0,
        };
        results.add({
          'op_id': op['op_id'],
          'status': 'applied',
          'record': record,
        });
        changes.add({'seq': ++sequence, ...record});
      }
      return http.Response(
        jsonEncode({
          'results': results,
          'changes': changes,
          'cursor': sequence,
          'has_more': false,
        }),
        200,
      );
    });
    final store = await local(client: client);
    store.token = 'test';
    final paper = await store.save('paper', {'title': 'Synced paper'});
    await store.sync();
    expect(store.pending, 0);
    expect(store.entry(paper.id)!.revision, 1);
    await store.sync();
    expect(store.entry(paper.id)!.title, 'Synced paper');
  });

  test('failed network preserves pending edits', () async {
    final store = await local(
      client: MockClient((_) async => throw const SocketException('offline')),
    );
    store.token = 'test';
    await store.save('paper', {'title': 'Kept offline'});
    await store.sync();
    expect(store.pending, 1);
    expect(store.list('paper').single.title, 'Kept offline');
  });

  test(
    'lost acknowledgement replays exact upload-enriched operation',
    () async {
      String? sent;
      int attempts = 0;
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/files')) {
          return http.Response(
            jsonEncode({
              'id': 'uploaded-file',
              'metadata': {'Title': 'Metadata title', 'Author': 'Ada'},
            }),
            201,
          );
        }
        if (request.url.path.endsWith('/groups')) {
          return http.Response('{"items":[]}', 200);
        }
        final body = jsonDecode(request.body);
        final operations = jsonEncode(body['operations']);
        if (attempts++ == 0) {
          sent = operations;
          throw const SocketException('ack lost after commit');
        }
        expect(operations, sent);
        final changes = [], results = [];
        int seq = 0;
        for (final op in body['operations']) {
          final record = {
            'id': op['entity_id'],
            'scope': 'u:offline',
            'kind': op['kind'],
            'revision': 1,
            'data': op['data'],
            'deleted': false,
          };
          changes.add({'seq': ++seq, ...record});
          results.add({
            'op_id': op['op_id'],
            'status': 'applied',
            'record': record,
          });
        }
        return http.Response(
          jsonEncode({
            'results': results,
            'changes': changes,
            'cursor': seq,
            'has_more': false,
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      });
      final store = await local(client: client);
      await store.importPdf(
        await File('test/fixtures/reader.pdf').readAsBytes(),
        'reader.pdf',
      );
      store.token = 'test';
      await store.sync();
      expect(store.pending, 2);
      await store.sync();
      expect(store.pending, 0, reason: store.status);
      expect(store.list('paper').single.title, 'Metadata title');
    },
  );

  testWidgets('desktop library opens with genuine empty state', (tester) async {
    tester.view.physicalSize = const Size(1440, 950);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    final store = (await tester.runAsync(() => local()))!;
    await tester.pumpWidget(PaperDesk(store: store));
    await tester.pumpAndSettle();
    expect(find.text('从一篇论文开始'), findsOneWidget);
    expect(find.text('导入文献'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('phone layout keeps library and import usable', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    final store = (await tester.runAsync(() => local()))!;
    await tester.pumpWidget(PaperDesk(store: store));
    await tester.pumpAndSettle();
    expect(find.byType(Drawer), findsNothing);
    expect(find.text('导入文献'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('phone reader note panel fits with and without keyboard', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    final store = (await tester.runAsync(() async {
      final workspace = await local();
      await workspace.importPdf(
        await File('test/fixtures/reader.pdf').readAsBytes(),
        'reader.pdf',
      );
      return workspace;
    }))!;
    final previousErrorHandler = FlutterError.onError;
    FlutterError.onError = (details) {
      debugPrint(details.toString());
      previousErrorHandler?.call(details);
    };
    addTearDown(() => FlutterError.onError = previousErrorHandler);
    await tester.pumpWidget(
      MaterialApp(
        home: Reader(
          store: store,
          paperId: store.list('paper').single.id,
          initialTab: 1,
        ),
      ),
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 2)),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await tester.pump();
    expect(tester.takeException(), isNull);
    tester.view.resetViewInsets();
    await tester.pumpWidget(const SizedBox());
  });
}
