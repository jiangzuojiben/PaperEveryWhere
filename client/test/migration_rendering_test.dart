import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:paperdesk/reader.dart';

Future<ui.Image> render(
  Map<String, dynamic> annotation, {
  int width = 600,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawColor(Colors.white, BlendMode.src);
  AnnotationPainter([
    {'color': '#ff0000', ...annotation},
  ]).paint(canvas, Size(width.toDouble(), width.toDouble()));
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, width);
  picture.dispose();
  return image;
}

Future<List<int>> pixel(ui.Image image, int x, int y) async {
  final bytes = (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!;
  final offset = (y * image.width + x) * 4;
  return [for (var i = 0; i < 4; i++) bytes.getUint8(offset + i)];
}

Future<Rect> inkBounds(ui.Image image) async {
  final bytes = (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!;
  var left = image.width, top = image.height, right = 0, bottom = 0;
  for (var y = 0; y < image.height; y++) {
    for (var x = 0; x < image.width; x++) {
      if (bytes.getUint8((y * image.width + x) * 4 + 1) < 240) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return Rect.fromLTRB(
    left.toDouble(),
    top.toDouble(),
    right.toDouble(),
    bottom.toDouble(),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'native per-point widths survive scaled rendering without invented pressure',
    () async {
      for (final width in [600, 1200]) {
        final image = await render({
          'type': 'ink',
          'points': [
            {'x': .2, 'y': .5, 'width': .02, 'pressure': .5},
            {'x': .8, 'y': .5, 'width': .04, 'pressure': .5},
          ],
        }, width: width);
        final bounds = await inkBounds(image);
        expect(bounds.height / width, closeTo(.03, .003));
        image.dispose();
      }
    },
  );

  test('rectangle fill and normalized border survive page scaling', () async {
    for (final width in [600, 1200]) {
      final image = await render({
        'type': 'rectangle',
        'rects': [
          [.2, .2, .8, .8],
        ],
        'fill_opacity': .25,
        'stroke_width': .02,
      }, width: width);
      final center = await pixel(image, width ~/ 2, width ~/ 2);
      expect(center[0], 255);
      expect(center[1], inInclusiveRange(190, 192));
      expect(await pixel(image, (width * .205).round(), width ~/ 2), [
        255,
        0,
        0,
        255,
      ]);
      expect(await pixel(image, (width * .18).round(), width ~/ 2), [
        255,
        255,
        255,
        255,
      ]);
      image.dispose();
    }
  });

  test('line uses its endpoints even when a bounding box is present', () async {
    final image = await render({
      'type': 'line',
      'rects': [
        [.2, .2, .8, .8],
      ],
      'stroke_width': .01,
      'points': [
        {'x': .2, 'y': .8},
        {'x': .8, 'y': .2},
      ],
    });
    expect(await pixel(image, 150, 450), [255, 0, 0, 255]);
    expect(await pixel(image, 150, 150), [255, 255, 255, 255]);
    image.dispose();
  });

  test('highlight honors opacity and keeps default .35', () async {
    for (final opacity in [null, 0.0, 1.0]) {
      final image = await render({
        'type': 'highlight',
        'rects': [
          [.2, .2, .8, .8],
        ],
        'opacity': ?opacity,
      });
      final color = await pixel(image, 300, 300);
      expect(
        color[1],
        opacity == null ? inInclusiveRange(165, 167) : (opacity == 0 ? 255 : 0),
      );
      image.dispose();
    }
  });

  test('explicit ink width is preserved independently of pressure', () async {
    final image = await render({
      'type': 'ink',
      'stroke_width': .02,
      'points': [
        {'x': .2, 'y': .5, 'pressure': 0},
        {'x': .8, 'y': .5, 'pressure': 1},
      ],
    });
    expect(await pixel(image, 300, 304), [255, 0, 0, 255]);
    expect(await pixel(image, 300, 308), [255, 255, 255, 255]);
    image.dispose();
  });

  test('imported text font size changes rendered glyph dimensions', () async {
    final small = await render({
      'type': 'text',
      'text': 'Note',
      'rects': [
        [.1, .1, .9, .8],
      ],
    });
    final large = await render({
      'type': 'text',
      'text': 'Note',
      'rects': [
        [.1, .1, .9, .8],
      ],
      'font_size': .06,
    });
    final smallBounds = await inkBounds(small);
    final largeBounds = await inkBounds(large);
    expect(largeBounds.width, greaterThan(smallBounds.width * 2));
    expect(largeBounds.height, greaterThan(smallBounds.height * 2));
    expect(largeBounds.left, smallBounds.left);
    small.dispose();
    large.dispose();
  });
}
