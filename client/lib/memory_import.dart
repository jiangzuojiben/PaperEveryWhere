import 'dart:io';
import 'dart:typed_data' show BytesBuilder;
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

typedef MemoryPdf = ({String name, Uint8List bytes});

Future<MemoryPdf?> pickAndroidMemoryPdf() async {
  final value = await const MethodChannel(
    'org.paperdesk/memory_import',
  ).invokeMapMethod<String, dynamic>('pickPdf');
  if (value == null) return null;
  return (name: value['name'] as String, bytes: value['bytes'] as Uint8List);
}

/// Android SAF streams directly into RAM; file_picker's Android cache is never
/// used. Windows reads the user-selected source file without creating a copy.
Future<MemoryPdf?> pickMemoryPdf() async {
  if (kIsWeb) throw StateError('当前在线上传支持 Windows 和 Android');
  if (Platform.isAndroid) {
    return pickAndroidMemoryPdf();
  }
  if (!Platform.isWindows) throw StateError('此平台的无缓存文件导入尚未适配');
  final selected = await FilePicker.platform.pickFiles(
    type: FileType.custom,
    allowedExtensions: ['pdf'],
    withData: false,
  );
  final file = selected?.files.single;
  if (file == null) return null;
  if (file.size > 256 * 1024 * 1024 || file.path == null) {
    throw StateError('请选择不超过256MB的PDF文件');
  }
  final source = File(file.path!);
  if (await source.length() > 256 * 1024 * 1024) {
    throw StateError('PDF文件不能超过256MB');
  }
  final bytes = BytesBuilder(copy: false);
  var size = 0;
  await for (final chunk in source.openRead()) {
    size += chunk.length;
    if (size > 256 * 1024 * 1024) throw StateError('PDF文件不能超过256MB');
    bytes.add(chunk);
  }
  return (name: file.name, bytes: bytes.takeBytes());
}
