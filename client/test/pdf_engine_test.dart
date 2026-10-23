import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'PDFium reads four-page multilingual fixture and renders actual pixels',
    () async {
      final directory = Directory.systemTemp.createTempSync(
        'paperdesk-pdf-test-',
      );
      Pdfrx.cacheDirectoryPath = directory.path;
      await pdfrxFlutterInitialize();
      final document = await PdfDocument.openData(
        await File('test/fixtures/reader.pdf').readAsBytes(),
        sourceName: 'reader-fixture',
      );
      try {
        expect(document.pages.length, 4);
        expect((await document.loadOutline()).length, 4);
        final text = await document.pages.first.loadStructuredText();
        expect(text.fullText, contains('PaperDesk Reader Validation'));
        expect(text.fullText, contains('跨端阅读'));
        final image = await document.pages.first.render(
          fullWidth: 300,
          fullHeight: 400,
        );
        expect(image, isNotNull);
        expect(image!.pixels.length, greaterThan(1000));
        image.dispose();
      } finally {
        await document.dispose();
      }
    },
  );
}
