import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart' as ffi;
import 'package:sqflite_common_ffi_web/sqflite_ffi_web.dart';
import 'package:synchronized/synchronized.dart';
import 'package:uuid/uuid.dart';

const uuid = Uuid();

class Entry {
  final String id, kind, scope;
  final int revision;
  final Map<String, dynamic> data;
  final bool deleted;
  Entry(
    this.id,
    this.kind,
    this.scope,
    this.revision,
    this.data, {
    this.deleted = false,
  });
  factory Entry.row(Map<String, Object?> r) => Entry(
    r['id'] as String,
    r['kind'] as String,
    r['scope'] as String,
    r['revision'] as int,
    jsonDecode(r['data'] as String),
    deleted: r['deleted'] == 1,
  );
  String get title => data['title']?.toString() ?? '未命名文献';
}

class Workspace extends ChangeNotifier {
  bool get cloudOnly => false;
  Set<String> get annotationTypes => {
    'highlight',
    'ink',
    'rectangle',
    'line',
    'text',
  };
  List<Map<String, dynamic>> get cloudWarnings => const [];
  Future<void> releasePaperSession(String paperId) async {}
  Future<void> refreshPaperSession(String paperId) => sync();
  final Lock _lock = Lock();
  Database? _db;
  final http.Client client;
  final String? databasePath;
  Workspace({http.Client? client, this.databasePath})
    : client = client ?? http.Client();
  SharedPreferences? preferences;
  final secure = const FlutterSecureStorage();
  String endpoint = 'http://127.0.0.1:8765',
      token = '',
      userId = 'offline',
      userName = '本地工作区';
  String scope = 'personal', status = '本地优先 · 离线可用';
  String deviceId = '';
  bool ready = false, syncing = false, dark = false;
  List<Entry> entries = [];
  List<Map<String, dynamic>> groups = [], conflicts = [];
  int pending = 0;
  bool get canEdit {
    if (!scope.startsWith('g:')) return true;
    return groups.any((g) => 'g:${g['id']}' == scope && g['role'] != 'viewer');
  }

  Map<String, String> get headers => {
    'Authorization': 'Bearer $token',
    'Content-Type': 'application/json',
  };

  Future<void> initialize() async {
    preferences = await SharedPreferences.getInstance();
    deviceId = preferences!.getString('device_id') ?? uuid.v4();
    await preferences!.setString('device_id', deviceId);
    endpoint = preferences!.getString('endpoint') ?? endpoint;
    userId = preferences!.getString('user_id') ?? 'offline';
    userName = preferences!.getString('user_name') ?? userName;
    dark = preferences!.getBool('dark') ?? false;
    _restoreMembership();
    try {
      token = await secure.read(key: 'token:$userId') ?? '';
    } catch (_) {
      token = '';
    }
    await _open();
    ready = true;
    await reload();
  }

  String get _membershipKey => 'membership:$endpoint:$userId';
  void _restoreMembership() {
    groups = [];
    scope = 'personal';
    if (userId == 'offline') return;
    try {
      final cached = jsonDecode(preferences!.getString(_membershipKey) ?? '{}');
      groups = List<Map<String, dynamic>>.from(cached['groups'] ?? [])
          .where(
            (g) =>
                g['id'] is String &&
                g['name'] is String &&
                ['owner', 'editor', 'viewer'].contains(g['role']),
          )
          .toList();
      final selected = cached['scope'];
      if (groups.any((g) => 'g:${g['id']}' == selected)) scope = selected;
    } catch (_) {
      groups = [];
    }
  }

  Future<void> _cacheMembership() => preferences!.setString(
    _membershipKey,
    jsonEncode({'groups': groups, 'scope': scope}),
  );

  Future<void> refreshGroups() async {
    final response = await request('GET', '/groups');
    groups = List<Map<String, dynamic>>.from(response['items']);
    if (scope.startsWith('g:') && !groups.any((g) => 'g:${g['id']}' == scope)) {
      scope = 'personal';
      await reload();
    }
    await _cacheMembership();
  }

  Future<void> _open() async {
    await _db?.close();
    String path;
    if (kIsWeb) {
      databaseFactory = databaseFactoryFfiWeb;
      path = 'paperdesk_$userId.db';
    } else {
      if (Platform.isWindows || Platform.isLinux) {
        ffi.sqfliteFfiInit();
        databaseFactory = ffi.databaseFactoryFfi;
      }
      path =
          databasePath ??
          p.join(
            (await getApplicationSupportDirectory()).path,
            'paperdesk_$userId.db',
          );
    }
    _db = await openDatabase(
      path,
      version: 2,
      onUpgrade: (db, oldVersion, newVersion) => _createPageText(db),
      onCreate: (db, _) async {
        await _createPageText(db);
        await db.execute(
          'CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT,scope TEXT,revision INTEGER,data TEXT,deleted INTEGER DEFAULT 0)',
        );
        await db.execute(
          'CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity_id TEXT UNIQUE,op_id TEXT,payload TEXT)',
        );
        await db.execute(
          'CREATE TABLE blobs(hash TEXT PRIMARY KEY,bytes BLOB,server_id TEXT)',
        );
        await db.execute(
          'CREATE TABLE cursors(scope TEXT PRIMARY KEY,value INTEGER)',
        );
        await db.execute(
          'CREATE TABLE conflicts(id TEXT PRIMARY KEY,payload TEXT)',
        );
        try {
          await db.execute(
            'CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,title,content,tokenize="unicode61")',
          );
        } on DatabaseException catch (error) {
          if (!error.toString().contains('no such module')) {
            rethrow;
          }
          await db.execute(
            'CREATE VIRTUAL TABLE search USING fts4(id,title,content,notindexed=id,tokenize=unicode61)',
          );
        }
      },
    );
  }

  List<Entry> list(String kind, {String? paperId}) => entries
      .where(
        (e) =>
            e.kind == kind &&
            !e.deleted &&
            (paperId == null || e.data['paper_id'] == paperId),
      )
      .toList();

  Future<void> _createPageText(DatabaseExecutor db) => db.execute(
    'CREATE TABLE IF NOT EXISTS page_text(paper_id TEXT,file_hash TEXT,page INTEGER,content TEXT,PRIMARY KEY(paper_id,file_hash,page))',
  );

  Future<void> indexPage(
    String paperId,
    String fileHash,
    int page,
    String text,
  ) => _lock.synchronized(() async {
    final paper = entry(paperId);
    if (paper == null || paper.deleted || paper.data['file_hash'] != fileHash) {
      throw StateError('PDF 版本已变化，请重新建立全文索引');
    }
    final searchId = '$paperId/page/$fileHash/$page';
    await _db!.transaction((db) async {
      await db.insert('page_text', {
        'paper_id': paperId,
        'file_hash': fileHash,
        'page': page,
        'content': text,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
      await db.delete('search', where: 'id=?', whereArgs: [searchId]);
      await db.insert('search', {'id': searchId, 'title': '', 'content': text});
    });
  });
  Entry? entry(String id) {
    for (final e in entries) {
      if (e.id == id) return e;
    }
    return null;
  }

  Set<String> folderIds(String root) {
    final ids = <String>{root};
    bool changed;
    do {
      changed = false;
      for (final folder in list('folder')) {
        if (ids.contains(folder.data['parent_id']) && ids.add(folder.id)) {
          changed = true;
        }
      }
    } while (changed);
    return ids;
  }

  Set<String> paperFolderIds(Entry paper) => {
    if (paper.data['folder_id'] is String) paper.data['folder_id'] as String,
    ...((paper.data['folder_ids'] as List?) ?? []).whereType<String>(),
  };

  bool paperInFolder(Entry paper, String folder) =>
      paperFolderIds(paper).intersection(folderIds(folder)).isNotEmpty;

  String folderPath(String id) {
    final names = <String>[];
    final seen = <String>{};
    Entry? current = entry(id);
    while (current != null && seen.add(current.id)) {
      names.insert(0, current.title);
      current = entry(current.data['parent_id'] ?? '');
    }
    return names.join(' / ');
  }

  Future<void> reload() async {
    entries = (await _db!.query(
      'entities',
      where: 'scope=?',
      whereArgs: [scope],
    )).map(Entry.row).toList();
    pending =
        Sqflite.firstIntValue(
          await _db!.rawQuery('SELECT COUNT(*) FROM outbox'),
        ) ??
        0;
    conflicts = (await _db!.query('conflicts'))
        .map((r) => jsonDecode(r['payload'] as String) as Map<String, dynamic>)
        .toList();
    notifyListeners();
  }

  Future<void> _write(DatabaseExecutor db, Entry e) async {
    await db.insert('entities', {
      'id': e.id,
      'kind': e.kind,
      'scope': e.scope,
      'revision': e.revision,
      'data': jsonEncode(e.data),
      'deleted': e.deleted ? 1 : 0,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    await db.delete('search', where: 'id=?', whereArgs: [e.id]);
    if (e.kind == 'paper') {
      await db.delete(
        'search',
        where: 'id LIKE ?',
        whereArgs: ['${e.id}/page/%'],
      );
    }
    if (!e.deleted && e.kind == 'paper') {
      await db.insert('search', {
        'id': e.id,
        'title': e.title,
        'content':
            '${(e.data['authors'] as List? ?? []).join(' ')} ${e.data['full_text'] ?? ''} ${(e.data['tags'] as List? ?? []).join(' ')}',
      });
      final pages = await db.query(
        'page_text',
        where: 'paper_id=? AND file_hash=?',
        whereArgs: [e.id, e.data['file_hash'] ?? ''],
      );
      for (final page in pages) {
        await db.insert('search', {
          'id': '${e.id}/page/${page['file_hash']}/${page['page']}',
          'title': '',
          'content': page['content'],
        });
      }
    }
  }

  Future<Entry> save(
    String kind,
    Map<String, dynamic> data, {
    String? id,
    bool deleted = false,
    Entry? basedOn,
  }) => _lock.synchronized(() async {
    if (!canEdit) throw StateError('当前小组为只读，无法修改文献或笔记');
    var identifier = id ?? uuid.v4();
    if (kind == 'folder') {
      if (data['parent_id'] != null &&
          folderIds(identifier).contains(data['parent_id'])) {
        throw StateError('不能把文件夹移动到自身或子文件夹中');
      }
      if (deleted &&
          entries.any(
            (e) =>
                !e.deleted &&
                (e.data['parent_id'] == identifier ||
                    paperFolderIds(e).contains(identifier)),
          )) {
        throw StateError('请先移出文件夹中的文献和子文件夹');
      }
    }
    final rows = await _db!.query(
      'entities',
      where: 'id=?',
      whereArgs: [identifier],
    );
    var previous = rows.isEmpty ? null : Entry.row(rows.first);
    if (previous != null &&
        (previous.scope != scope || previous.kind != kind)) {
      throw StateError('记录不属于当前文献库或类型不匹配');
    }
    if (kind == 'annotation' &&
        basedOn != null &&
        (previous == null ||
            previous.deleted != basedOn.deleted ||
            jsonEncode(previous.data) != jsonEncode(basedOn.data))) {
      throw StateError('此批注已被其他编辑修改，请重新查看后操作');
    }
    // A remote edit can arrive during the debounce interval. Preserve both
    // drafts rather than silently using the new revision to overwrite it.
    if (kind == 'note' &&
        !deleted &&
        basedOn != null &&
        previous != null &&
        (previous.deleted ||
            previous.revision != basedOn.revision ||
            previous.data['content'] != basedOn.data['content'] ||
            previous.data['title'] != basedOn.data['title'] ||
            previous.data['category'] != basedOn.data['category'])) {
      data = {...data, 'conflict_of': identifier};
      identifier = uuid.v4();
      previous = null;
    }
    final e = Entry(identifier, kind, scope, previous?.revision ?? 0, {
      'created': DateTime.now().toUtc().toIso8601String(),
      ...data,
    }, deleted: deleted);
    final operation = {
      'op_id': uuid.v4(),
      'entity_id': identifier,
      'kind': kind,
      'base_revision': e.revision,
      'data': e.data,
      'deleted': deleted,
    };
    await _db!.transaction((db) async {
      await _write(db, e);
      final previousOps = await db.query(
        'outbox',
        where: 'entity_id=?',
        whereArgs: [identifier],
      );
      final row = {
        'entity_id': identifier,
        'op_id': operation['op_id'],
        'payload': jsonEncode(operation),
      };
      if (previousOps.isEmpty) {
        await db.insert('outbox', row);
      } else {
        await db.update(
          'outbox',
          row,
          where: 'entity_id=?',
          whereArgs: [identifier],
        );
      }
    });
    await reload();
    return e;
  });

  Future<void> bulkPapers(
    Set<String> ids, {
    String? statusValue,
    String? folderId,
    bool moveFolder = false,
    List<String> addTags = const [],
    bool? important,
    bool trash = false,
  }) => _lock.synchronized(() async {
    if (!canEdit) throw StateError('当前小组为只读');
    if (ids.isEmpty) return;
    if (statusValue != null && !['未读', '阅读中', '已读'].contains(statusValue)) {
      throw StateError('无效阅读状态');
    }
    if (moveFolder &&
        folderId != null &&
        !list('folder').any((e) => e.id == folderId)) {
      throw StateError('目标文件夹不存在');
    }
    await _db!.transaction((db) async {
      for (final id in ids) {
        final rows = await db.query(
          'entities',
          where: 'id=? AND scope=? AND kind=? AND deleted=0',
          whereArgs: [id, scope, 'paper'],
        );
        if (rows.isEmpty) throw StateError('所选文献已删除或不属于当前文献库');
        final old = Entry.row(rows.single);
        final data = {
          ...old.data,
          'status': ?statusValue,
          if (moveFolder) 'folder_id': folderId,
          if (moveFolder) 'folder_ids': [?folderId],
          'important': ?important,
          if (addTags.isNotEmpty)
            'tags': {
              ...(old.data['tags'] as List? ?? []),
              ...addTags.map((t) => t.trim()).where((t) => t.isNotEmpty),
            }.toList(),
        };
        final updated = Entry(
          id,
          'paper',
          scope,
          old.revision,
          data,
          deleted: trash,
        );
        await _write(db, updated);
        final opId = uuid.v4();
        final op = {
          'op_id': opId,
          'entity_id': id,
          'kind': 'paper',
          'base_revision': old.revision,
          'data': data,
          'deleted': trash,
        };
        final pending = await db.query(
          'outbox',
          where: 'entity_id=?',
          whereArgs: [id],
        );
        final row = {'entity_id': id, 'op_id': opId, 'payload': jsonEncode(op)};
        if (pending.isEmpty) {
          await db.insert('outbox', row);
        } else {
          await db.update('outbox', row, where: 'entity_id=?', whereArgs: [id]);
        }
      }
    });
    await reload();
  });

  Future<Entry> importPdf(
    Uint8List bytes,
    String filename, {
    String? folderId,
    Entry? paper,
  }) async {
    if (bytes.length < 5 ||
        utf8.decode(bytes.sublist(0, 5), allowMalformed: true) != '%PDF-') {
      throw Exception('请选择有效 PDF');
    }
    final hash = sha256.convert(bytes).toString();
    if (paper == null) {
      final same = list('paper').where((e) => e.data['file_hash'] == hash);
      if (same.isNotEmpty) return same.first;
    }
    await _db!.insert('blobs', {
      'hash': hash,
      'bytes': bytes,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
    final target =
        paper ??
        await save('paper', {
          'title': p.basenameWithoutExtension(filename),
          'filename': filename,
          'file_hash': hash,
          'authors': <String>[],
          'tags': <String>[],
          'status': '未读',
          'folder_id': ?folderId,
        });
    final version = await save('version', {
      'paper_id': target.id,
      'file_hash': hash,
      'filename': filename,
      'created': DateTime.now().toUtc().toIso8601String(),
    });
    return save('paper', {
      ...target.data,
      'file_hash': hash,
      'active_version_id': version.id,
    }, id: target.id);
  }

  Future<Entry> importAttachment(
    Uint8List bytes,
    String filename,
    Entry paper,
  ) async {
    final hash = sha256.convert(bytes).toString();
    await _db!.insert('blobs', {
      'hash': hash,
      'bytes': bytes,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
    return save('attachment', {
      'paper_id': paper.id,
      'file_hash': hash,
      'filename': filename,
    });
  }

  Future<Uint8List?> pdf(Entry paper) async {
    final hash = paper.data['file_hash'];
    final rows = await _db!.query('blobs', where: 'hash=?', whereArgs: [hash]);
    if (rows.isNotEmpty && rows.first['bytes'] != null) {
      return rows.first['bytes'] as Uint8List;
    }
    if (token.isEmpty || paper.data['file_id'] == null) return null;
    final bytes = await getBytes('/files/${paper.data['file_id']}');
    if (sha256.convert(bytes).toString() != hash) throw Exception('文件校验失败');
    await _db!.insert('blobs', {
      'hash': hash,
      'bytes': bytes,
      'server_id': paper.data['file_id'],
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    return bytes;
  }

  Future<dynamic> request(String method, String path, [Object? body]) async {
    final r = http.Request(method, Uri.parse('$endpoint/api/v1$path'))
      ..headers.addAll(headers);
    if (body != null) r.body = jsonEncode(body);
    final response = await http.Response.fromStream(
      await client.send(r).timeout(const Duration(seconds: 30)),
    );
    if (response.statusCode >= 400) {
      String message = '服务返回 ${response.statusCode}';
      try {
        final detail = jsonDecode(utf8.decode(response.bodyBytes))['detail'];
        message = detail is String ? detail : message;
      } catch (_) {}
      throw Exception(message);
    }
    return response.bodyBytes.isEmpty
        ? null
        : jsonDecode(utf8.decode(response.bodyBytes));
  }

  Future<Uint8List> getBytes(String path) async {
    final response = await client
        .get(Uri.parse('$endpoint/api/v1$path'), headers: headers)
        .timeout(const Duration(seconds: 30));
    if (response.statusCode != 200) {
      throw Exception('下载失败 ${response.statusCode}');
    }
    return response.bodyBytes;
  }

  Future<Map<String, dynamic>> upload(
    Uint8List bytes,
    String name, {
    String path = '/files',
  }) async {
    final r = http.MultipartRequest('POST', Uri.parse('$endpoint/api/v1$path'))
      ..headers['Authorization'] = 'Bearer $token';
    r.files.add(http.MultipartFile.fromBytes('file', bytes, filename: name));
    final response = await http.Response.fromStream(
      await client.send(r).timeout(const Duration(seconds: 90)),
    );
    if (response.statusCode >= 400) {
      throw Exception(utf8.decode(response.bodyBytes));
    }
    return jsonDecode(utf8.decode(response.bodyBytes));
  }

  Future<void> login(
    String url,
    String email,
    String password,
    bool register,
  ) async {
    endpoint = url.replaceAll(RegExp(r'/+$'), '');
    final result = await request(
      'POST',
      register ? '/auth/register' : '/auth/login',
      {'email': email, 'password': password},
    );
    token = result['access_token'];
    userId = result['user']['id'];
    userName = result['user']['name'];
    await secure.write(key: 'token:$userId', value: token);
    await preferences!.setString('endpoint', endpoint);
    await preferences!.setString('user_id', userId);
    await preferences!.setString('user_name', userName);
    scope = 'personal';
    groups = [];
    await _open();
    await reload();
    await sync();
  }

  Future<void> logout() async {
    if (token.isNotEmpty) {
      await request('POST', '/auth/logout');
      await secure.delete(key: 'token:$userId');
    }
    token = '';
    userId = 'offline';
    userName = '本地工作区';
    scope = 'personal';
    groups = [];
    await preferences!.remove('user_id');
    await preferences!.remove('user_name');
    await _open();
    await reload();
  }

  Future<void> switchScope(String target) async {
    while (syncing) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    if (target != 'personal' && !groups.any((g) => 'g:${g['id']}' == target)) {
      throw StateError('此小组不在当前账号的成员列表中');
    }
    scope = target;
    await _cacheMembership();
    await reload();
    if (token.isNotEmpty) await sync();
  }

  Future<void> sync() async {
    if (syncing || token.isEmpty) return;
    syncing = true;
    status = '正在同步…';
    notifyListeners();
    try {
      // Refresh authorization before publishing any queued group edits/files.
      await refreshGroups();
      await _lock.synchronized(() async {
        while (true) {
          final queued = !canEdit
              ? <Map<String, Object?>>[]
              : await _db!.rawQuery(
                  'SELECT o.* FROM outbox o JOIN entities e ON e.id=o.entity_id WHERE e.scope=? ORDER BY o.seq',
                  [scope],
                );
          final operations = <Map<String, dynamic>>[];
          for (final row in queued.take(100)) {
            final op =
                jsonDecode(row['payload'] as String) as Map<String, dynamic>;
            final data = Map<String, dynamic>.from(op['data']);
            if (data['file_hash'] != null &&
                data['file_id'] == null &&
                op['deleted'] != true &&
                ['paper', 'version', 'attachment'].contains(op['kind'])) {
              final blobs = await _db!.query(
                'blobs',
                where: 'hash=?',
                whereArgs: [data['file_hash']],
              );
              if (blobs.isNotEmpty) {
                var serverId = blobs.first['server_id'];
                if (serverId == null) {
                  final result = await upload(
                    blobs.first['bytes'] as Uint8List,
                    data['filename'] ?? 'document.pdf',
                    path: op['kind'] == 'attachment'
                        ? '/files?attachment=true'
                        : '/files',
                  );
                  final metadata = result['metadata'] as Map?;
                  if (op['kind'] == 'paper' && metadata != null) {
                    data['pdf_metadata'] = metadata;
                    if (data['title'] ==
                            p.basenameWithoutExtension(
                              data['filename'] ?? '',
                            ) &&
                        metadata['Title']?.toString().trim().isNotEmpty ==
                            true) {
                      data['title'] = metadata['Title'];
                    }
                    if ((data['authors'] as List? ?? []).isEmpty &&
                        metadata['Author']?.toString().trim().isNotEmpty ==
                            true) {
                      data['authors'] = [metadata['Author']];
                    }
                  }
                  serverId = result['id'];
                  await _db!.update(
                    'blobs',
                    {'server_id': serverId},
                    where: 'hash=?',
                    whereArgs: [data['file_hash']],
                  );
                }
                data['file_id'] = serverId;
              }
            }
            op['data'] = data;
            // Persist the exact outbound operation BEFORE sending. A response
            // lost after upload/metadata extraction must replay identical bytes.
            await _db!.update(
              'outbox',
              {'payload': jsonEncode(op)},
              where: 'op_id=?',
              whereArgs: [op['op_id']],
            );
            await _write(
              _db!,
              Entry(
                op['entity_id'],
                op['kind'],
                scope,
                op['base_revision'],
                data,
                deleted: op['deleted'],
              ),
            );
            operations.add(op);
          }
          final cursors = await _db!.query(
            'cursors',
            where: 'scope=?',
            whereArgs: [scope],
          );
          var cursor = cursors.isEmpty ? 0 : cursors.first['value'] as int;
          bool more;
          var outgoing = operations;
          do {
            final response = await request('POST', '/sync', {
              'scope': scope,
              'cursor': cursor,
              'operations': outgoing,
            });
            await _db!.transaction((db) async {
              for (final result in response['results']) {
                if (result['status'] == 'conflict') {
                  await db.insert('conflicts', {
                    'id': result['op_id'],
                    'payload': jsonEncode(result),
                  }, conflictAlgorithm: ConflictAlgorithm.replace);
                }
                await db.delete(
                  'outbox',
                  where: 'op_id=?',
                  whereArgs: [result['op_id']],
                );
                for (final key in ['record', 'current', 'conflict_copy']) {
                  if (result[key] != null) await _remote(db, result[key]);
                }
              }
              for (final change in response['changes']) {
                final unsent = await db.query(
                  'outbox',
                  where: 'entity_id=?',
                  whereArgs: [change['id']],
                );
                if (unsent.isEmpty) await _remote(db, change);
              }
              await db.insert('cursors', {
                'scope': scope,
                'value': response['cursor'],
              }, conflictAlgorithm: ConflictAlgorithm.replace);
            });
            cursor = response['cursor'];
            more = response['has_more'];
            outgoing = [];
          } while (more);
          if (operations.length < 100) break;
        }
      });
      status =
          '已同步 · ${DateTime.now().hour.toString().padLeft(2, '0')}:${DateTime.now().minute.toString().padLeft(2, '0')}';
    } catch (e) {
      status = '离线保存 · ${e.toString().replaceFirst('Exception: ', '')}';
    } finally {
      syncing = false;
      await reload();
      if (pending > 0 && status.startsWith('已同步')) {
        status += ' · $pending 项修改仍保留本机待处理';
        notifyListeners();
      }
    }
  }

  Future<void> _remote(DatabaseExecutor db, Map<String, dynamic> r) async {
    final current = await db.query(
      'entities',
      columns: ['revision'],
      where: 'id=?',
      whereArgs: [r['id']],
    );
    if (current.isNotEmpty &&
        (current.first['revision'] as int) > (r['revision'] as int)) {
      return;
    }
    await _write(
      db,
      Entry(
        r['id'],
        r['kind'],
        r['scope'] == 'u:$userId' ? 'personal' : r['scope'],
        r['revision'],
        Map<String, dynamic>.from(r['data']),
        deleted: r['deleted'],
      ),
    );
  }

  Future<void> dismissConflict(String opId) async {
    await _db!.delete('conflicts', where: 'id=?', whereArgs: [opId]);
    await reload();
  }

  Future<void> close() => _lock.synchronized(() async {
    await _db?.close();
    _db = null;
    client.close();
    super.dispose();
  });

  Future<void> toggleDark() async {
    dark = !dark;
    await preferences!.setBool('dark', dark);
    notifyListeners();
  }

  Future<List<String>> fullTextSearch(String query) async {
    if (query.trim().isEmpty) return [];
    if (RegExp(r'[\u3400-\u9fff]').hasMatch(query)) {
      final escaped = query
          .replaceAll('\\', '\\\\')
          .replaceAll('%', r'\%')
          .replaceAll('_', r'\_');
      final results = await _db!.rawQuery(
        "SELECT id FROM search WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'",
        ['%$escaped%', '%$escaped%'],
      );
      return results
          .map((r) => (r['id'] as String).split('/page/').first)
          .toSet()
          .toList();
    }
    final words = query.replaceAll('"', '""');
    final results = await _db!.rawQuery(
      'SELECT id FROM search WHERE search MATCH ?',
      ['"$words"*'],
    );
    return results
        .map((r) => (r['id'] as String).split('/page/').first)
        .toSet()
        .toList();
  }
}
