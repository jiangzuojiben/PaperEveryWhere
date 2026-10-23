import 'dart:convert';
import 'package:path_provider/path_provider.dart';
import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:paperdesk/main.dart';
import 'package:paperdesk/store.dart';
import 'package:paperdesk/reader.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('offline PDF import, native reading, ink and durable note', (
    tester,
  ) async {
    final database =
        '${(await getTemporaryDirectory()).path}/completion-${uuid.v4()}.db';
    final store = Workspace(databasePath: database);
    await store.initialize();
    store.token = '';
    await store.importPdf(base64Decode(fixture), 'validation.pdf');
    await tester.pumpWidget(PaperDesk(store: store));
    await tester.pumpAndSettle();
    expect(find.text('validation'), findsOneWidget);
    await tester.tap(find.text('批量管理'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('全选当前结果'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('批量操作（1）'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('标为已读'));
    await tester.pumpAndSettle();
    expect(store.list('paper').single.data['status'], '已读');
    await tester.tap(find.text('结束选择'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('validation'));
    await tester.pumpAndSettle(const Duration(milliseconds: 300));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 3)),
    );
    await tester.pumpAndSettle();
    expect(find.byType(PdfViewer), findsOneWidget);
    expect(find.text('1 / 4'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.byTooltip('手写'));
    await tester.pumpAndSettle();
    final page = tester.getRect(find.byType(AnnotationLayer).first);
    final viewport = tester.getRect(find.byType(PdfViewer));
    final visible = page.intersect(viewport);
    final start = visible.center - const Offset(40, 20);
    final pen = await tester.startGesture(
      start,
      kind: PointerDeviceKind.stylus,
    );
    await pen.moveBy(const Offset(30, 20));
    await pen.moveBy(const Offset(40, -10));
    await pen.up();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 800)),
    );
    await tester.pumpAndSettle();
    final ink = store
        .list('annotation')
        .where((e) => e.data['type'] == 'ink')
        .single;
    expect((ink.data['points'] as List).length, greaterThan(1));
    expect(
      (ink.data['points'] as List).every(
        (p) => p['pressure'] >= 0 && p['pressure'] <= 1,
      ),
      isTrue,
    );
    await tester.ensureVisible(find.byTooltip('撤销批注'));
    await tester.tap(find.byTooltip('撤销批注'));
    await tester.pumpAndSettle();
    expect(store.list('annotation'), isEmpty);
    await tester.tap(find.byTooltip('重做批注'));
    await tester.pumpAndSettle();
    expect(store.list('annotation').single.id, ink.id);
    await tester.tap(find.text('笔记'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('note-content')),
      'Offline research note: reproducible on Android.',
    );
    await tester.pump(const Duration(seconds: 1));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 1)),
    );
    await tester.pumpAndSettle();
    expect(
      store.list('note').single.data['content'],
      contains('reproducible on Android'),
    );
    final firstNote = store.list('note').single;
    await tester.tap(find.byTooltip('笔记操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('新建笔记'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('note-content')),
      '第二条笔记：离线保存与切换。',
    );
    // Dispose before the debounce fires, exercising the immediate-leave path.
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 1)),
    );
    await store.close();
    final reopened = Workspace(databasePath: database);
    await reopened.initialize();
    expect(reopened.list('paper').single.data['status'], '已读');
    expect(reopened.list('note').length, 2);
    expect(
      reopened.entry(firstNote.id)!.data['content'],
      contains('reproducible on Android'),
    );
    expect(
      reopened.list('note').any((n) => n.data['content'] == '第二条笔记：离线保存与切换。'),
      true,
    );
    expect(reopened.list('annotation').single.id, ink.id);
    expect(reopened.list('progress').single.data['page'], 1);
    expect(reopened.list('progress').single.data['device'], reopened.deviceId);
    await reopened.close();
    expect(tester.takeException(), isNull);
  });
}

const fixture =
    'JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSIC9GMiAzIDAgUiAvRjMgNCAwIFIgL0Y0IDUgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0Jhc2VGb250IC9IZWx2ZXRpY2EtQm9sZCAvRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjIgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250Cj4+CmVuZG9iago0IDAgb2JqCjw8Ci9CYXNlRm9udCAvU1RTb25nLUxpZ2h0IC9EZXNjZW5kYW50Rm9udHMgWyA8PAovQmFzZUZvbnQgL1NUU29uZy1MaWdodCAvQ0lEU3lzdGVtSW5mbyA8PAovT3JkZXJpbmcgKEdCMSkgL1JlZ2lzdHJ5IChBZG9iZSkgL1N1cHBsZW1lbnQgMAo+PiAvRFcgMTAwMCAvRm9udERlc2NyaXB0b3IgPDwKL0FzY2VudCA3NTIgL0NhcEhlaWdodCA3MzcgL0Rlc2NlbnQgLTI3MSAvRmxhZ3MgNiAvRm9udEJCb3ggWyAtMjUgLTI1NCAxMDAwIDg4MCBdIC9Gb250TmFtZSAvU1RTb25nU3RkLUxpZ2h0IAogIC9JdGFsaWNBbmdsZSAwIC9MZWFkaW5nIDE0OCAvTWF4V2lkdGggMTAwMCAvTWlzc2luZ1dpZHRoIDUwMCAvU3RlbUggOTEgL1N0ZW1WIDU4IAogIC9UeXBlIC9Gb250RGVzY3JpcHRvciAvWEhlaWdodCA1NTMKPj4gL1N1YnR5cGUgL0NJREZvbnRUeXBlMCAvVHlwZSAvRm9udCAKICAvVyBbIDEgWyAyMDcgMjcwIDM0MiA0NjcgNDYyIDc5NyA3MTAgMjM5IDM3NCBdIDEwIFsgMzc0IDQyMyA2MDUgMjM4IDM3NSAyMzggMzM0IDQ2MiBdIDE4IDI2IDQ2MiAyNyAyOCAyMzggCiAgMjkgMzEgNjA1IDMyIFsgMzQ0IDc0OCA2ODQgNTYwIDY5NSA3MzkgNTYzIDUxMSA3MjkgNzkzIAogIDMxOCAzMTIgNjY2IDUyNiA4OTYgNzU4IDc3MiA1NDQgNzcyIDYyOCAKICA0NjUgNjA3IDc1MyA3MTEgOTcyIDY0NyA2MjAgNjA3IDM3NCAzMzMgCiAgMzc0IDYwNiA1MDAgMjM5IDQxNyA1MDMgNDI3IDUyOSA0MTUgMjY0IAogIDQ0NCA1MTggMjQxIDIzMCA0OTUgMjI4IDc5MyA1MjcgNTI0IF0gODEgWyA1MjQgNTA0IDMzOCAzMzYgMjc3IDUxNyA0NTAgNjUyIDQ2NiA0NTIgCiAgNDA3IDM3MCAyNTggMzcwIDYwNSBdIF0KPj4gXSAvRW5jb2RpbmcgL1VuaUdCLVVDUzItSCAvTmFtZSAvRjMgL1N1YnR5cGUgL1R5cGUwIC9UeXBlIC9Gb250Cj4+CmVuZG9iago1IDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhLU9ibGlxdWUgL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcgL05hbWUgL0Y0IC9TdWJ0eXBlIC9UeXBlMSAvVHlwZSAvRm9udAo+PgplbmRvYmoKNiAwIG9iago8PAovQ29udGVudHMgMTggMCBSIC9NZWRpYUJveCBbIDAgMCA2MDAgODAwIF0gL1BhcmVudCAxNyAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNyAwIG9iago8PAovQ29udGVudHMgMTkgMCBSIC9NZWRpYUJveCBbIDAgMCA2MDAgODAwIF0gL1BhcmVudCAxNyAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKOCAwIG9iago8PAovQ29udGVudHMgMjAgMCBSIC9NZWRpYUJveCBbIDAgMCA2MDAgODAwIF0gL1BhcmVudCAxNyAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKOSAwIG9iago8PAovQ29udGVudHMgMjEgMCBSIC9NZWRpYUJveCBbIDAgMCA2MDAgODAwIF0gL1BhcmVudCAxNyAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKMTAgMCBvYmoKPDwKL091dGxpbmVzIDEyIDAgUiAvUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDE3IDAgUiAvVHlwZSAvQ2F0YWxvZwo+PgplbmRvYmoKMTEgMCBvYmoKPDwKL0F1dGhvciAoYW5vbnltb3VzKSAvQ3JlYXRpb25EYXRlIChEOjIwMjYxMDIyMDA0NjQ4KzA4JzAwJykgL0NyZWF0b3IgKGFub255bW91cykgL0tleXdvcmRzICgpIC9Nb2REYXRlIChEOjIwMjYxMDIyMDA0NjQ4KzA4JzAwJykgL1Byb2R1Y2VyIChSZXBvcnRMYWIgUERGIExpYnJhcnkgLSBcKG9wZW5zb3VyY2VcKSkgCiAgL1N1YmplY3QgKHVuc3BlY2lmaWVkKSAvVGl0bGUgKHVudGl0bGVkKSAvVHJhcHBlZCAvRmFsc2UKPj4KZW5kb2JqCjEyIDAgb2JqCjw8Ci9Db3VudCA0IC9GaXJzdCAxMyAwIFIgL0xhc3QgMTYgMCBSIC9UeXBlIC9PdXRsaW5lcwo+PgplbmRvYmoKMTMgMCBvYmoKPDwKL0Rlc3QgWyA2IDAgUiAvRml0IF0gL05leHQgMTQgMCBSIC9QYXJlbnQgMTIgMCBSIC9UaXRsZSAoVmFsaWRhdGlvbiBzZWN0aW9uIDEpCj4+CmVuZG9iagoxNCAwIG9iago8PAovRGVzdCBbIDcgMCBSIC9GaXQgXSAvTmV4dCAxNSAwIFIgL1BhcmVudCAxMiAwIFIgL1ByZXYgMTMgMCBSIC9UaXRsZSAoVmFsaWRhdGlvbiBzZWN0aW9uIDIpCj4+CmVuZG9iagoxNSAwIG9iago8PAovRGVzdCBbIDggMCBSIC9GaXQgXSAvTmV4dCAxNiAwIFIgL1BhcmVudCAxMiAwIFIgL1ByZXYgMTQgMCBSIC9UaXRsZSAoVmFsaWRhdGlvbiBzZWN0aW9uIDMpCj4+CmVuZG9iagoxNiAwIG9iago8PAovRGVzdCBbIDkgMCBSIC9GaXQgXSAvUGFyZW50IDEyIDAgUiAvUHJldiAxNSAwIFIgL1RpdGxlIChWYWxpZGF0aW9uIHNlY3Rpb24gNCkKPj4KZW5kb2JqCjE3IDAgb2JqCjw8Ci9Db3VudCA0IC9LaWRzIFsgNiAwIFIgNyAwIFIgOCAwIFIgOSAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjE4IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDczNwo+PgpzdHJlYW0KR2FzSlM5bEpLRyY7S1pMJ2x0b1NFY3Unbk9XTSJUUk0vI2RaQjEvcV5pPCUmMyhgNS1MRU9OUkIwRCk+ZzNWWkBMWGZUKlhRKFwzaz5kbVNwZ3VaST5HQ2o8L1FQT3I8LjYyaVBFYTRORkI/YSMvZ3E8LThPZ1Y4OU5NTixPL2pPIWpLXjgqa0tBVG83UmQpKFtyaDVQSVZhY01tR1NsO1wrUVU9a1knYFVTLDFlKUdBakdYOGBlXDddMytsSjl0YlM9Lz5yNVFoPUw8XlJuPlpASS0sbTU2VyZeJFEjZyhma3BwK2MoXU5DZFc/MnEoV1o6MyI4ZGJTVyovXFwjWU1obE9rcDxFK2NcMT5aPHUsW0xKLFw+TyZFTktDZGwzajdtVy49dS9iLEAiSUstXDFOSVVXVy90Pk0paHRBcHE1dUleSSttQiRMT0ErXEZGcGxEI09QIUE+ODhQNCksVzwiNCxXOWBgLVc9aTsqQyxTcUpKPXM1JlZDcHM9OyQ2K1Y6WkU1K0YtPGY4PFBuZ0pMR2UyJz9IPXExa0A/KzZQRSJTP3FnXk4sWnA3XDFsM3JONWFoZ2smcytIVlJLVEZDJThAcz5DaFNeJkJtYGkoO2RZS19ZTlc/JjB1Z3IlZHUpLDNxaGUtISgxWmlwQk9wW2wxJjJSJ1JaUUxMbGthMSoudUg0J1NsXEBjVlYoSyRVNjR0IWYoYD10TF9JcDBVXUE9XyEraUY3QkVLWkA8Q0pFR0EwVyo7PFgxJGdcM2NtSFsiKTcxVFdJKVpgQEI6PEBlSU9YNz5hQDMsI0ImZU1EZyRrYGdmQitNS0ZETz8oYGBsJ2VQJyNOTzQ3PUQ0bXVobD1JKzZYN1onVFZcXWcmYzxLL1E0NSlTWmlUbmc3XDhNbXA0WiNDY1srY1xXX2pwI0pMNSxEQWZQZEBNRFZiIUFuTUwyMkFKbFElbzs6LTM+JW1VP0RWblFSfj5lbmRzdHJlYW0KZW5kb2JqCjE5IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDczNwo+PgpzdHJlYW0KR2FzSlM5bCZLSyY7S1pRJ20hJyxPYHRGMWk+ZC5tTkRIQzgrOjg4bS5hKVMsPGptWUkqKmMqY0hXT11FU09FP00mZHA4YU9oP2BeYnRGRi9wZ2xUSD5HQ2o8L1FQT3I8LjYyaVBFYTRORkI/YSMvZ3E8LThPZ1Y4OU5NTixPL2pPIWpLXjgqa0s9JVhOL0kqU1tyaDVQSVZhY01tR1NsO1wrUVU9a1knYFVTLDFlKUdBakdYOGBlXDddMytsSjpWQ2hALz5vXG5ISGslbERec19JbnNUQHElUmhcLD0zYkM5VXAjMSk/JE85UTthMm8wPCZyNiJQbmE0OTMjKDkkP2MuYClkUyFdNVNkRUc9VC5GZVNzOEhxIiNdYjdfbCZGa1tdNTdEPS0oLl08biI3JE1pXTZcZlhzSGk3RHU2IUkrPVZqNU9TIic2OD5eQV5dN2pjIjg4S1taLFc4VSUmZlkhVSZmXEVBUDo4RS4lXFE6STVgL0orTGQ/dHQvO1paUTtKXzFVT00lN24sZnEhbzVhOHBUJCJWLXNSUiE3UVRhQE1kWVUwQmInIStZaVJgKFJiK0FJR0YjdFU3ZjlgaWJdTCppIS8yRGlEJDFrKUVkV0B1OUA9Ki5XTihoNnEjQnVPUSpJNzolS01fWHVzMWMibUdSL0RoTjl1cTlhcDU6WyYndWNWTmNgPGRCO3NcY01kRSkpIUNdI1x1YCFQTlM7PzEvQEo/bWcsWmlRRTFXaEw0XlpCNVYuV3JuU0Q+Yk90Xz4hVC8pOnRCVD5ATVMsLlokS2c9LCIzVlQmTGBRQzdAUVBGQG5yXyY3Q2thYy9sMz1xTU8pKiI3YlUsLzJHaHREb2VLVSw8VmxRIVZcXWcmY0JsMj1HSTI0P19VImtFRThNX2pIPiVjT0J0JD04TEgzbnMlMVZeYllocVEjaDdEcGFqKFxAQmF0Yykoa0RSTDUkQ15ucWEiTFEwfj5lbmRzdHJlYW0KZW5kb2JqCjIwIDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDczNwo+PgpzdHJlYW0KR2FzSlM5bCZLSyY7S1pRJ20hJyxPYHRGMWk+ZC5tTkRIQzgrOjg4bS5hKVMsPGptWUkqKmMqY0hXT11FU09FP00mZHA4YU9oP2BeYnRGRi9wZ2xUSD5HQ2o8L1FQT3I8LjYyaVBFYTRORkI/YSMvZ3E8LThPZ1Y4OU5NTixPL2pPIWpLXjgqa0s9JVhOL0kqU1tyaDVQSVZhY01tR1NsO1wrUVU9a1knYFVTLDFlKUdBakdYOGBlXDddMytsSjpWQ2hALz5vXG5ISGslbERec19JbnNUQHElUmhcLD0zYkM5VXAjMSk/JE85UTthMm8wPCZyNiJQbmE0OTMjKDkkP2MuYClkUyFdNVNkRUc9VC5GZVNzOEhxIiNdYjdfbCZGa1tdNTdEPSxzUzs+aGBrdCVgLGs0VT50XlxNaHRBcHE1dUleSSttQiRMT0ErXEZGcGxEI09QIUE+ODhQNCksVzwiNCxXOWBgLVc9aTsqQyxTcUpKPXM1JlZDcHM9OyQ2K1Y6WkU1K0YtPGY4PFBuZ0pMR2UyJz9IPXExa0A/KzZQRSJTP3FnXk4sWnA3XDFsM3JONWFoZ2smcytIVlJLVEZDJThAcz5DaFNeJkMmQ2pSO2RZS19ZTlc/JjB1Z3IlZHUpLDNxaGUtISgxWmlwQk9wW2wxJjJSJ1JaUUxMbGthMSoudUg0J1NsXEBjVlYoSyRVNjR0IWYoYD10TF9JcDBVXUE9XyEraUY3QkVLWkA8Q0pFR0EwVyo7PFgxJGdcM2NtSFsiKTcxVFdJKVpgQEI6PEBlSU9YNz5hQDMsI0ImZU1EZyRrYGdmQitNS0ZETz8oYGBsJ2VQJyNOTzQ3PUQ0bXVobD1JKzZYN1opIjorbU8qU00sN1ltcUNHXUtxQ1RpaVAlSV5wIUVXKGRyJ1lPJXMrYXApXUlHTkBEQCkmXG9sVkthNCdZY1EiPjQwYzU2LlQucW5WZSstJ0lxfj5lbmRzdHJlYW0KZW5kb2JqCjIxIDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDczNwo+PgpzdHJlYW0KR2FzSlM5bCZLSyY7S1pRJ20hJyxPYHREPVE/MjhkMWQ3MSZKZ189VFclPiFLPig2XC4zT2s9UXA5KURpM2YzUiQsU2pNSyxDKEJHUls1Xz1wcmR1IltSQlJXUk9zcTBXO0tDMVo5W01BXGdvLUcoUjBjUy8+ckpVVThycyNMSzBMTUVgai4nb0F0UUlWXXJqdC9fdGZXKzU/Y15IaF4mKEQ3c2g2cUdNN0NGYWBXTV0vTl5nViIzbyxTTG85JlZxdV1qL11QITlISGslbERec19ZbyIiVzwlbi5kIllGTmVyOFJNOzFdRC4rXlZwMkkoO3JyN1FXaGYtNmouWjdWcUFOL0pRIVdKOEUkY1EzSUJwQEdyVk9BJi4qMVl0YSM/MThnaCNMVi9WUFcycXAhVDU3bSpWQltxZ2ksa00qXXRGJT9XXDRYPDA1KTNRLjtrLXBHciFKcTkxIUpxNyNKQWQwWEpBZDFbZHEkN0tmRSdKLSZQLGQ3TllvXF8/cUNjSSdYL2tmNjFUYVdPPGVhWCFgQU5DLUJLTmxCRURXNUwqaSEvXzN0TSY4WydOQkJiRm8mSk1bXGEsVG9nNTIkbGVlKWsnJFxmWyxqVGUqczFcVlMzbUc/ZFdsNEBaNV8oYHRhTGVwRCJdTS9CNlRpZCk9dV1BK0QuLTInS2tvZmU6QTM8dG9GQjRnMGBQOXJbO3U1U04wYlhSV0txJkxXZ0A2aWkqRCE2U2JMYVRiUVdYJUhGLl5hOyotWDpBKFhFLnBXREJFPkFBNVp0dT5NSC1BVWA5TW8pOSwpcVo3QSkyVFEjJE01TkIpXTVRMDg6U1xqMEViLlRsclhScU1vL2ctQWZZZV1WNEJRSnFNTzorbU8qU00sN1ltcUNHXWBMZkI0aVAlSV5GbDMrYWRWYVBOJW9dS1BDWzBacElfVT5IXGxINihOaTJDWC5aPSlbU00obmE8bV1uTEdNWklPfj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCAyMgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwNjEgMDAwMDAgbiAKMDAwMDAwMDEyMiAwMDAwMCBuIAowMDAwMDAwMjI5IDAwMDAwIG4gCjAwMDAwMDAzNDEgMDAwMDAgbiAKMDAwMDAwMTI3NCAwMDAwMCBuIAowMDAwMDAxMzg5IDAwMDAwIG4gCjAwMDAwMDE1ODQgMDAwMDAgbiAKMDAwMDAwMTc3OSAwMDAwMCBuIAowMDAwMDAxOTc0IDAwMDAwIG4gCjAwMDAwMDIxNjkgMDAwMDAgbiAKMDAwMDAwMjI1NiAwMDAwMCBuIAowMDAwMDAyNTE4IDAwMDAwIG4gCjAwMDAwMDI1OTIgMDAwMDAgbiAKMDAwMDAwMjY5MyAwMDAwMCBuIAowMDAwMDAyODA3IDAwMDAwIG4gCjAwMDAwMDI5MjEgMDAwMDAgbiAKMDAwMDAwMzAyMiAwMDAwMCBuIAowMDAwMDAzMTAwIDAwMDAwIG4gCjAwMDAwMDM5MjggMDAwMDAgbiAKMDAwMDAwNDc1NiAwMDAwMCBuIAowMDAwMDA1NTg0IDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPDBkYjI5ZDgxOTE3ZmRlOTEyMmVlY2VmZDZkNzg2NGJiPjwwZGIyOWQ4MTkxN2ZkZTkxMjJlZWNlZmQ2ZDc4NjRiYj5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gMTEgMCBSCi9Sb290IDEwIDAgUgovU2l6ZSAyMgo+PgpzdGFydHhyZWYKNjQxMgolJUVPRgo=';
