import 'dart:async';
import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:paperdesk/cloud_store.dart';
import 'package:paperdesk/main.dart';
import 'package:paperdesk/memory_import.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final pdf = utf8.encode('%PDF-memory-only-fixture');
  Map<String, dynamic> paper() => {
    'id': 'rp-paper:1',
    'kind': 'paper',
    'scope': 'personal',
    'revision': 1,
    'deleted': false,
    'data': {
      'title': 'Cloud paper',
      'file_hash': sha256.convert(pdf).toString(),
      'pages': 1,
      'folder_ids': <String>[],
    },
  };
  Map<String, dynamic> note(String content, int revision) => {
    'id': 'rp-summary:1',
    'kind': 'note',
    'scope': 'personal',
    'revision': revision,
    'deleted': false,
    'data': {
      'paper_id': 'rp-paper:1',
      'title': 'ReadPaper 阅读笔记',
      'content': content,
    },
  };
  http.Response response(Object value, [int status = 200]) => http.Response(
    jsonEncode(value),
    status,
    headers: {'content-type': 'application/json'},
  );
  late List<String> calls;
  late int forbiddenPluginCalls;
  setUp(() {
    calls = [];
    forbiddenPluginCalls = 0;
    for (final name in [
      'plugins.flutter.io/path_provider',
      'plugins.it_nomads.com/flutter_secure_storage',
      'plugins.flutter.io/shared_preferences',
      'com.tekartik.sqflite',
    ]) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(MethodChannel(name), (call) async {
            forbiddenPluginCalls++;
            throw StateError('Persistent storage must not be accessed');
          });
    }
  });
  tearDown(() {
    expect(forbiddenPluginCalls, 0);
  });

  CloudWorkspace workspace({
    Future<http.Response> Function(http.Request)? extra,
    List<Map<String, dynamic>> Function()? sessionEntries,
  }) => CloudWorkspace(
    client: MockClient((request) async {
      calls.add('${request.method} ${request.url.path}');
      expect(
        request.headers['X-PaperDesk-Session'] ??
            request.headers['x-paperdesk-session'],
        'ephemeral-v1',
      );
      if (request.url.path.endsWith('/auth/readpaper-local') ||
          request.url.path.endsWith('/auth/pair')) {
        return response({
          'access_token': 'session-one',
          'entries': [paper()],
        });
      }
      if (request.url.path.endsWith('/library')) {
        return response({
          'entries': [paper()],
        });
      }
      if (request.url.path.endsWith('/session') && request.method == 'GET') {
        return response({
          'entries': sessionEntries?.call() ?? [paper(), note('Original', 1)],
          'unsupported': [],
        });
      }
      if (request.url.path.endsWith('/session') && request.method == 'DELETE') {
        return response({'ok': true});
      }
      if (request.url.path.endsWith('/pdf')) {
        return http.Response.bytes(pdf, 200);
      }
      if (extra != null) return extra(request);
      if (request.url.path.endsWith('/auth/logout')) {
        return response({'ok': true});
      }
      throw StateError('Unexpected request: ${request.url.path}');
    }),
  );

  test(
    'initialize, online read, release and logout never touch persistence plugins',
    () async {
      final s = workspace();
      await s.initialize();
      expect(s.preferences, isNull);
      expect(s.databasePath, isNull);
      expect(s.entries, isEmpty);
      await s.connect('http://127.0.0.1:8765');
      await s.openPaper('rp-paper:1');
      final bytes = await s.pdf(s.entry('rp-paper:1')!);
      expect(bytes, orderedEquals(pdf));
      expect(s.list('note').single.data['content'], 'Original');
      await s.indexPage(
        'rp-paper:1',
        sha256.convert(pdf).toString(),
        1,
        'memory needle',
      );
      expect(await s.fullTextSearch('needle'), ['rp-paper:1']);
      await s.releasePaperSession('rp-paper:1');
      expect(s.list('note'), isEmpty);
      expect(await s.fullTextSearch('needle'), isEmpty);
      await s.logout();
      expect(s.entries, isEmpty);
      expect(s.token, isEmpty);
      expect(s.pending, 0);
      await s.close();
    },
  );

  test(
    'reader refresh reloads cloud notes without replacing library or caching PDF',
    () async {
      var revision = 1;
      final s = workspace(
        sessionEntries: () => [paper(), note('Remote $revision', revision)],
      );
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      await s.openPaper('rp-paper:1');
      await s.pdf(s.entry('rp-paper:1')!);
      revision = 2;
      await s.refreshPaperSession('rp-paper:1');
      expect(s.entry('rp-summary:1')!.data['content'], 'Remote 2');
      expect(calls.where((c) => c == 'GET /api/v1/library'), isEmpty);
      expect(calls.where((c) => c.endsWith('/pdf')).length, 1);
      expect(
        calls
            .where(
              (c) =>
                  c == 'GET /api/v1/papers/rp-paper%3A1/session' ||
                  c == 'GET /api/v1/papers/rp-paper:1/session',
            )
            .length,
        2,
      );
      await s.close();
    },
  );

  test(
    'save waits for cloud acknowledgement and does not create an outbox',
    () async {
      final ack = Completer<http.Response>();
      final s = workspace(extra: (r) => ack.future);
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      await s.openPaper('rp-paper:1');
      final old = s.entry('rp-summary:1')!;
      final writing = s.save(
        'note',
        {...old.data, 'content': 'Changed'},
        id: old.id,
        basedOn: old,
      );
      await Future<void>.delayed(Duration.zero);
      expect(s.pending, 1);
      expect(s.entry(old.id)!.data['content'], 'Original');
      ack.complete(response(note('Changed', 2)));
      final saved = await writing;
      expect(saved.data['content'], 'Changed');
      expect(s.pending, 0);
      expect(s.status, '已保存至 ReadPaper');
      await s.close();
    },
  );

  test(
    'failed remote save preserves confirmed snapshot and reports unsaved state',
    () async {
      final s = workspace(
        extra: (r) async => response({'detail': '断网，未确认保存'}, 502),
      );
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      await s.openPaper('rp-paper:1');
      final old = s.entry('rp-summary:1')!;
      await expectLater(
        s.save('note', {...old.data, 'content': 'Draft'}, id: old.id),
        throwsException,
      );
      expect(s.entry(old.id)!.data['content'], 'Original');
      expect(s.pending, 0);
      expect(s.status, contains('未确认'));
      await s.close();
    },
  );

  test(
    'logout immediately clears data and ignores a late successful write',
    () async {
      final ack = Completer<http.Response>();
      final s = workspace(
        extra: (r) async => r.url.path.endsWith('/auth/logout')
            ? response({'ok': true})
            : ack.future,
      );
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      await s.openPaper('rp-paper:1');
      final old = s.entry('rp-summary:1')!;
      final writing = s.save('note', {
        ...old.data,
        'content': 'Late',
      }, id: old.id);
      final rejected = expectLater(writing, throwsStateError);
      await Future<void>.delayed(Duration.zero);
      final quitting = s.logout();
      expect(s.entries, isEmpty);
      expect(s.token, isEmpty);
      expect(s.pending, 0);
      ack.complete(response(note('Late', 2)));
      await rejected;
      await quitting;
      expect(s.entries, isEmpty);
      expect(s.pending, 0);
      await s.close();
    },
  );

  test(
    'new workspace never restores the previous session and rejects legacy writes',
    () async {
      final s = workspace();
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      await s.close();
      final next = workspace();
      await next.initialize();
      expect(next.token, isEmpty);
      expect(next.entries, isEmpty);
      await expectLater(
        next.importPdf(Uint8List.fromList(pdf), 'test.pdf'),
        throwsStateError,
      );
      await expectLater(next.switchScope('g:private'), throwsStateError);
      expect(next.annotationTypes, {'highlight', 'rectangle', 'text'});
      await next.close();
    },
  );

  test(
    'remote HTTP gateway is rejected before any credential request',
    () async {
      final s = workspace();
      await s.initialize();
      await expectLater(s.connect('http://192.0.2.5:8765'), throwsStateError);
      expect(calls, isEmpty);
      await s.close();
    },
  );

  test(
    'raw upload stays in memory and accepts only cloud confirmation',
    () async {
      var posts = 0;
      final s = workspace(
        extra: (r) async {
          if (r.url.path.endsWith('/auth/logout')) {
            return response({'ok': true});
          }
          expect(r.url.path, '/api/v1/uploads');
          expect(r.headers['content-type'], 'application/pdf');
          expect(r.bodyBytes, orderedEquals(pdf));
          expect(
            Uri.decodeComponent(r.headers['x-paperdesk-filename']!),
            '测试.pdf',
          );
          posts++;
          return response({
            'id': 'upload1',
            'state': 'completed',
            'paper_id': 'rp-paper:1',
            'filename': '测试.pdf',
          });
        },
      );
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      final value = await s.importPdf(Uint8List.fromList(pdf), '测试.pdf');
      expect(value.id, 'rp-paper:1');
      expect(posts, 1);
      expect(s.uploads.single['state'], 'completed');
      expect(s.pending, 0);
      await s.logout();
      expect(s.uploads, isEmpty);
      await s.close();
    },
  );

  test(
    'uncertain upload is not retried and leaves the confirmed library intact',
    () async {
      var posts = 0;
      final s = workspace(
        extra: (r) async {
          if (r.url.path.endsWith('/auth/logout')) {
            return response({'ok': true});
          }
          posts++;
          return response({'detail': '上传结果未知'}, 502);
        },
      );
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      await expectLater(
        s.importPdf(Uint8List.fromList(pdf), 'fixture.pdf'),
        throwsStateError,
      );
      expect(posts, 1);
      expect(s.list('paper').single.id, 'rp-paper:1');
      expect(s.pending, 0);
      expect(s.status, contains('未确认'));
      await s.close();
    },
  );

  test('logout discards a late upload completion and its history', () async {
    final ack = Completer<http.Response>();
    final s = workspace(
      extra: (r) async => r.url.path.endsWith('/auth/logout')
          ? response({'ok': true})
          : ack.future,
    );
    await s.initialize();
    await s.connect('http://127.0.0.1:8765');
    final writing = s.importPdf(Uint8List.fromList(pdf), 'fixture.pdf');
    final rejected = expectLater(writing, throwsStateError);
    await Future<void>.delayed(Duration.zero);
    await s.logout();
    ack.complete(
      response({
        'id': 'upload1',
        'state': 'completed',
        'paper_id': 'rp-paper:1',
      }),
    );
    await rejected;
    expect(s.entries, isEmpty);
    expect(s.uploads, isEmpty);
    expect(s.pending, 0);
    await s.close();
  });

  test(
    'version selection requires a closed reader and drops old file state',
    () async {
      var selections = 0;
      final s = workspace(
        extra: (r) async {
          if (r.url.path.endsWith('/auth/logout')) {
            return response({'ok': true});
          }
          if (r.url.path.endsWith('/versions/select')) {
            selections++;
            return response({
              'paper_id': 'rp-paper:2',
              'entries': [
                {...paper(), 'id': 'rp-paper:2'},
              ],
            });
          }
          return response({
            'supported': true,
            'versions': [
              {'pdf_id': '2'},
            ],
          });
        },
      );
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      await s.openPaper('rp-paper:1');
      await expectLater(s.selectVersion('rp-paper:1', '2'), throwsStateError);
      expect(selections, 0);
      await s.releasePaperSession('rp-paper:1');
      final target = await s.selectVersion('rp-paper:1', '2');
      expect(target, 'rp-paper:2');
      expect(selections, 1);
      expect(s.entry('rp-paper:1'), isNull);
      expect(s.list('note'), isEmpty);
      await s.close();
    },
  );

  test('Android import uses only the in-memory native channel', () async {
    const channel = MethodChannel('org.paperdesk/memory_import');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          expect(call.method, 'pickPdf');
          return {'name': 'fixture.pdf', 'bytes': Uint8List.fromList(pdf)};
        });
    final selected = await pickAndroidMemoryPdf();
    expect(selected!.name, 'fixture.pdf');
    expect(selected.bytes, orderedEquals(pdf));
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test(
    'queued upload cannot cross into a newly connected account session',
    () async {
      final ack = Completer<http.Response>();
      var posts = 0;
      final s = workspace(
        extra: (r) async {
          if (r.url.path.endsWith('/auth/logout')) {
            return response({'ok': true});
          }
          posts++;
          return ack.future;
        },
      );
      await s.initialize();
      await s.connect('http://127.0.0.1:8765');
      final first = s.importPdf(Uint8List.fromList(pdf), 'first.pdf');
      final rejectFirst = expectLater(first, throwsStateError);
      await Future<void>.delayed(Duration.zero);
      final queued = s.importPdf(Uint8List.fromList(pdf), 'old-account.pdf');
      final rejectQueued = expectLater(queued, throwsStateError);
      await s.logout();
      await s.connect('http://127.0.0.1:8765', pairingCode: 'new-account');
      ack.complete(
        response({
          'id': 'upload1',
          'state': 'completed',
          'paper_id': 'rp-paper:1',
        }),
      );
      await rejectFirst;
      await rejectQueued;
      expect(posts, 1);
      expect(s.token, isNotEmpty);
      expect(s.entries.single.id, 'rp-paper:1');
      expect(s.uploads, isEmpty);
      await s.close();
    },
  );

  testWidgets('phone cloud library exposes upload and native version limits', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final s = workspace(
      extra: (r) async => r.url.path.endsWith('/auth/logout')
          ? response({'ok': true})
          : response({
              'supported': false,
              'versions': [],
              'can_upload': false,
              'reason': '独立PDF暂无云端版本集合',
            }),
    );
    await s.initialize();
    await s.connect('http://127.0.0.1:8765');
    await tester.pumpWidget(PaperDesk(store: s));
    expect(find.byTooltip('上传PDF'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.byType(PopupMenuButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('云端版本管理'));
    await tester.pumpAndSettle();
    expect(find.text('独立PDF暂无云端版本集合'), findsOneWidget);
    expect(find.text('上传此论文的新版本（由ReadPaper核对匹配）'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
    await s.close();
  });

  test('unmatched upload is not reported as a new paper version', () async {
    final s = workspace(
      extra: (r) async => r.url.path.endsWith('/auth/logout')
          ? response({'ok': true})
          : response({
              'id': 'upload1',
              'state': 'unmatched',
              'filename': 'new.pdf',
              'paper_id': 'rp-paper:other',
              'reason': '未匹配目标论文',
            }),
    );
    await s.initialize();
    await s.connect('http://127.0.0.1:8765');
    await expectLater(
      s.importPdf(
        Uint8List.fromList(pdf),
        'new.pdf',
        paper: s.entry('rp-paper:1'),
      ),
      throwsA(
        isA<StateError>().having((e) => e.message, 'message', contains('未匹配')),
      ),
    );
    expect(s.uploads.single['state'], 'unmatched');
    expect(s.pending, 0);
    expect(s.status, isNot(contains('已上传')));
    await s.close();
  });

  testWidgets(
    'default cloud screen offers ReadPaper connection with no offline import',
    (tester) async {
      final s = workspace();
      await s.initialize();
      await tester.pumpWidget(PaperDesk(store: s));
      expect(find.text('连接 ReadPaper'), findsOneWidget);
      expect(find.text('连接 ReadPaper，在线阅读与批注'), findsOneWidget);
      expect(find.text('注册独立账号'), findsNothing);
      expect(find.text('导入 PDF'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
      await s.close();
    },
  );
}
