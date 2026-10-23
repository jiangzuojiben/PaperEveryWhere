import 'dart:io';
import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:http/http.dart' as http;
import 'package:synchronized/synchronized.dart';
import 'store.dart';

/// Online sessions never call the legacy SQLite/preferences/blob/outbox paths.
class CloudWorkspace extends Workspace {
  CloudWorkspace({super.client, String? gateway}) {
    endpoint =
        gateway ??
        (!kIsWeb && Platform.isAndroid
            ? 'http://10.0.2.2:8765'
            : 'http://127.0.0.1:8765');
  }
  final _sessionLock = Lock();
  final Map<String, String> _pageText = {};
  List<Map<String, dynamic>> _warnings = [];
  String? _activePaper;
  int _generation = 0;
  bool _closed = false;
  List<Map<String, dynamic>> uploads = [];
  @override
  bool get cloudOnly => true;
  @override
  Set<String> get annotationTypes => {'highlight', 'rectangle', 'text'};
  @override
  List<Map<String, dynamic>> get cloudWarnings => _warnings;
  @override
  bool get canEdit => token.isNotEmpty && !_closed;
  @override
  Map<String, String> get headers => {
    ...super.headers,
    'X-PaperDesk-Session': 'ephemeral-v1',
  };

  @override
  Future<void> initialize() async {
    // No preferences, secure storage, directories, local database, or old data.
    userId = 'readpaper';
    userName = 'ReadPaper 云端文献库';
    deviceId = 'readpaper-cloud';
    status = '连接 ReadPaper 后在线阅读';
    entries = [];
    pending = 0;
    groups = [];
    conflicts = [];
    ready = true;
    notifyListeners();
  }

  Future<void> connect(String gateway, {String? pairingCode}) async {
    if (token.isNotEmpty) await logout();
    endpoint = gateway.replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.tryParse(endpoint);
    if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        (uri.scheme == 'http' &&
            ![
              'localhost',
              '127.0.0.1',
              '::1',
              '10.0.2.2',
            ].contains(uri.host))) {
      throw StateError('远程网关需使用 HTTPS；本机可使用回环地址');
    }
    final generation = _generation;
    final result = await request(
      'POST',
      pairingCode == null ? '/auth/readpaper-local' : '/auth/pair',
      pairingCode == null ? null : {'code': pairingCode},
    );
    if (_closed || generation != _generation) return;
    token = result['access_token'];
    entries = _decode(result['entries']);
    status = 'ReadPaper 云端 · 仅本次会话';
    notifyListeners();
  }

  List<Entry> _decode(dynamic values) => (values as List)
      .map(
        (dynamic raw) => Entry(
          raw['id'],
          raw['kind'],
          'personal',
          raw['revision'],
          Map<String, dynamic>.from(raw['data']),
          deleted: raw['deleted'] == true,
        ),
      )
      .toList();

  void _sameSession(int generation) {
    if (_closed || generation != _generation || token.isEmpty) {
      throw StateError('在线会话已结束，此响应已丢弃');
    }
  }

  Future<T> _sessionTask<T>(Future<T> Function(int generation) action) {
    final generation = _generation;
    return _sessionLock.synchronized(() {
      _sameSession(generation);
      return action(generation);
    });
  }

  Future<void> openPaper(String id) => _sessionTask((generation) async {
    if (_activePaper != null && _activePaper != id) {
      await _release(_activePaper!);
    }
    _sameSession(generation);
    final result = await request(
      'GET',
      '/papers/${Uri.encodeComponent(id)}/session',
    );
    _sameSession(generation);
    final refreshed = _decode(result['entries']);
    entries.removeWhere((e) => e.id == id || e.data['paper_id'] == id);
    entries.addAll(refreshed);
    _activePaper = id;
    _warnings = List<Map<String, dynamic>>.from(result['unsupported'] ?? []);
    status = 'ReadPaper 云端 · 仅本次会话';
    notifyListeners();
  });

  @override
  Future<Uint8List?> pdf(Entry paper) async {
    if (_activePaper != paper.id) await openPaper(paper.id);
    final generation = _generation;
    final bytes = await getBytes(
      '/papers/${Uri.encodeComponent(paper.id)}/pdf',
    );
    _sameSession(generation);
    if (sha256.convert(bytes).toString() !=
        entry(paper.id)?.data['file_hash']) {
      throw StateError('云端PDF内容与当前版本不一致，请重新打开');
    }
    return bytes; // Caller owns these bytes only while reader is open.
  }

  @override
  Future<Entry> save(
    String kind,
    Map<String, dynamic> data, {
    String? id,
    bool deleted = false,
    Entry? basedOn,
  }) => _sessionTask((generation) async {
    if (!canEdit) throw StateError('请先连接 ReadPaper');
    if (!{'annotation', 'note', 'progress'}.contains(kind)) {
      throw StateError('此操作的 ReadPaper 云端保存尚未适配');
    }
    final previous = basedOn ?? (id == null ? null : entry(id));
    pending++;
    status = '正在保存到 ReadPaper…';
    notifyListeners();
    try {
      final raw = await request('POST', '/entities', {
        'kind': kind,
        'data': data,
        'id': id,
        'base_revision': previous?.revision,
        'deleted': deleted,
      });
      _sameSession(generation);
      final value = _decode([raw]).single;
      entries.removeWhere(
        (e) => e.id == value.id || (id != null && e.id == id),
      );
      entries.add(value);
      status = '已保存至 ReadPaper';
      return value;
    } catch (_) {
      if (generation == _generation && !_closed) {
        status = '未确认云端保存，请保留当前草稿并刷新核对';
      }
      rethrow;
    } finally {
      if (generation == _generation && !_closed) {
        pending--;
        notifyListeners();
      }
    }
  });

  @override
  Future<void> sync() {
    final requestedGeneration = _generation;
    return _sessionLock.synchronized(() async {
      if (requestedGeneration != _generation) return;
      if (token.isEmpty || syncing || _closed || _activePaper != null) return;
      final generation = _generation;
      syncing = true;
      try {
        final result = await request('GET', '/library');
        _sameSession(generation);
        entries = _decode(result['entries']);
        status = 'ReadPaper 云端 · 仅本次会话';
      } catch (_) {
        if (generation == _generation) status = '云端读取失败，请重新连接或重试';
      } finally {
        syncing = false;
        if (!_closed) notifyListeners();
      }
    });
  }

  @override
  Future<void> reload() async {
    if (!_closed) notifyListeners();
  }

  @override
  Future<void> refreshGroups() async {
    groups = [];
  }

  @override
  Future<void> switchScope(String target) async {
    if (target != 'personal') throw StateError('当前 ReadPaper 适配仅支持个人库');
  }

  @override
  Future<void> toggleDark() async {
    dark = !dark;
    notifyListeners();
  }

  @override
  Future<void> indexPage(
    String paperId,
    String fileHash,
    int page,
    String text,
  ) async {
    if (paperId != _activePaper ||
        entry(paperId)?.data['file_hash'] != fileHash) {
      throw StateError('阅读会话或文件版本已变化');
    }
    _pageText['$paperId/$page'] = text;
  }

  @override
  Future<List<String>> fullTextSearch(String query) async {
    final term = query.toLowerCase();
    return list('paper')
        .where(
          (e) =>
              e.title.toLowerCase().contains(term) ||
              _pageText.entries.any(
                (p) =>
                    p.key.startsWith('${e.id}/') &&
                    p.value.toLowerCase().contains(term),
              ),
        )
        .map((e) => e.id)
        .toList();
  }

  Future<void> _release(String paperId) async {
    final generation = _generation;
    try {
      if (token.isNotEmpty) {
        await request(
          'DELETE',
          '/papers/${Uri.encodeComponent(paperId)}/session',
        );
      }
    } finally {
      if (generation == _generation) {
        entries.removeWhere((e) => e.data['paper_id'] == paperId);
        _pageText.removeWhere((key, _) => key.startsWith('$paperId/'));
        _warnings = [];
        if (_activePaper == paperId) _activePaper = null;
        PaintingBinding.instance.imageCache.clear();
        PaintingBinding.instance.imageCache.clearLiveImages();
      }
    }
  }

  @override
  Future<void> releasePaperSession(String paperId) {
    final generation = _generation;
    return _sessionLock.synchronized(() async {
      if (generation != _generation || _closed) return;
      await _release(paperId);
    });
  }

  @override
  Future<void> refreshPaperSession(String paperId) => openPaper(paperId);

  void _clear() {
    _generation++;
    token = '';
    entries = [];
    groups = [];
    conflicts = [];
    pending = 0;
    _warnings = [];
    _pageText.clear();
    _activePaper = null;
    uploads = [];
    status = '在线会话已结束';
    PaintingBinding.instance.imageCache.clear();
    PaintingBinding.instance.imageCache.clearLiveImages();
  }

  @override
  Future<void> logout() async {
    // Clear credentials/content even when the network is unavailable. The
    // gateway also has an idle expiry to release an abandoned remote session.
    final request = token.isEmpty
        ? null
        : (http.Request('POST', Uri.parse('$endpoint/api/v1/auth/logout'))
            ..headers.addAll(headers));
    _clear();
    if (!_closed) notifyListeners();
    if (request != null) {
      try {
        final response = await client
            .send(request)
            .timeout(const Duration(seconds: 3));
        await response.stream.drain<void>().timeout(const Duration(seconds: 3));
      } catch (_) {
        /* Gateway sessions expire independently. */
      }
    }
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    try {
      await logout();
    } finally {
      client.close();
    }
  }

  @override
  Future<void> login(
    String url,
    String email,
    String password,
    bool register,
  ) async => throw StateError('请使用 ReadPaper 连接或本次会话连接码');
  @override
  Future<Entry> importPdf(
    Uint8List bytes,
    String filename, {
    String? folderId,
    Entry? paper,
  }) => _sessionTask((generation) async {
    if (!canEdit) throw StateError('请先连接 ReadPaper');
    if (_activePaper != null) throw StateError('请先关闭阅读页，再上传或管理版本');
    if (bytes.isEmpty || bytes.length > 256 * 1024 * 1024) {
      throw StateError('PDF不能为空且不能超过256MB');
    }
    final uri = Uri.parse('$endpoint/api/v1/uploads').replace(
      queryParameters: {
        'folder_id': ?folderId,
        if (paper != null) 'version_of': paper.id,
      },
    );
    final upload = http.Request('POST', uri)
      ..headers.addAll(headers)
      ..headers['Content-Type'] = 'application/pdf'
      ..headers['X-PaperDesk-Filename'] = Uri.encodeComponent(filename)
      ..bodyBytes = bytes;
    pending++;
    status = '正在上传到 ReadPaper…';
    notifyListeners();
    try {
      final streamed = await client
          .send(upload)
          .timeout(const Duration(seconds: 120));
      final response = await http.Response.fromStream(
        streamed,
      ).timeout(const Duration(seconds: 120));
      _sameSession(generation);
      final raw = jsonDecode(utf8.decode(response.bodyBytes));
      if (response.statusCode >= 400) {
        throw StateError(raw['detail']?.toString() ?? '云端上传未确认');
      }
      var operation = Map<String, dynamic>.from(raw);
      void remember() {
        uploads.removeWhere((v) => v['id'] == operation['id']);
        uploads.add(operation);
        notifyListeners();
      }

      remember();
      for (var attempt = 0; attempt < 60; attempt++) {
        final state = operation['state'];
        if (state == 'completed' || state == 'duplicate') {
          final library = await request('GET', '/library');
          _sameSession(generation);
          entries = _decode(library['entries']);
          final saved = entry(operation['paper_id']);
          if (saved == null) throw StateError('云端文献尚未返回，请刷新核对');
          status = state == 'duplicate'
              ? 'ReadPaper 已去重，使用已有文献'
              : '已上传至 ReadPaper';
          return saved;
        }
        if (state == 'conflict') {
          throw StateError('ReadPaper发现文献冲突，请在上传列表选择保留原件或替换');
        }
        if (state == 'unmatched') {
          throw StateError('文件已被云端收录，但未匹配目标论文；请刷新核对，未建立所选论文的新版本');
        }
        if (state == 'failed' || state == 'cancelled' || state == 'unknown') {
          throw StateError('上传状态：$state；请刷新文献库核对，不会自动重传');
        }
        await Future<void>.delayed(const Duration(seconds: 1));
        _sameSession(generation);
        operation = Map<String, dynamic>.from(
          await request('GET', '/uploads/${operation['id']}'),
        );
        _sameSession(generation);
        remember();
      }
      throw StateError('云端仍在处理，请在上传列表核对；不要重复上传');
    } catch (_) {
      if (generation == _generation && !_closed) status = '上传尚未确认，请查看上传列表或刷新核对';
      rethrow;
    } finally {
      if (generation == _generation && !_closed) {
        pending--;
        notifyListeners();
      }
    }
  });

  Future<void> refreshUploads() async {
    final generation = _generation;
    final result = await request('GET', '/uploads');
    _sameSession(generation);
    uploads = List<Map<String, dynamic>>.from(result['items']);
    notifyListeners();
  }

  Future<void> updateUpload(
    String id, {
    bool? keepExisting,
    bool cancel = false,
  }) async {
    final generation = _generation;
    final operation = await request(
      keepExisting != null || cancel ? 'POST' : 'GET',
      '/uploads/$id${keepExisting != null
          ? '/resolve'
          : cancel
          ? '/cancel'
          : ''}',
      keepExisting == null ? null : {'keep_existing': keepExisting},
    );
    _sameSession(generation);
    uploads.removeWhere((v) => v['id'] == id);
    uploads.add(Map<String, dynamic>.from(operation));
    notifyListeners();
    await sync();
  }

  Future<Map<String, dynamic>> paperVersions(String paperId) async {
    final generation = _generation;
    final value = await request(
      'GET',
      '/papers/${Uri.encodeComponent(paperId)}/versions',
    );
    _sameSession(generation);
    return Map<String, dynamic>.from(value);
  }

  Future<String> selectVersion(String paperId, String pdfId) =>
      _sessionTask((generation) async {
        if (_activePaper != null) throw StateError('请先关闭阅读页，再切换版本');
        final value = await request(
          'POST',
          '/papers/${Uri.encodeComponent(paperId)}/versions/select',
          {'pdf_id': pdfId},
        );
        _sameSession(generation);
        entries = _decode(value['entries']);
        _pageText.clear();
        _warnings = [];
        status = 'ReadPaper云端版本已切换';
        notifyListeners();
        return value['paper_id'] as String;
      });
  @override
  Future<Entry> importAttachment(
    Uint8List bytes,
    String filename,
    Entry paper,
  ) async => throw StateError('附件上传桥接尚未验证');
  @override
  Future<void> bulkPapers(
    Set<String> ids, {
    String? statusValue,
    String? folderId,
    bool moveFolder = false,
    List<String> addTags = const [],
    bool? important,
    bool trash = false,
  }) async => throw StateError('ReadPaper批量操作尚未适配');
  @override
  Future<void> dismissConflict(String opId) async =>
      throw StateError('当前模式不生成本地冲突队列');
}
