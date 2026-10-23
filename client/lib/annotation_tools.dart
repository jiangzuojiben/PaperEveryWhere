import 'dart:math' as math;
import 'package:flutter/painting.dart';
import 'store.dart';

/// Screen-space tolerance keeps the eraser usable at any zoom or page aspect.
bool annotationHit(
  Map<String, dynamic> annotation,
  Offset cursor,
  Size size, {
  double radius = 9,
}) {
  Offset point(Map p) => Offset(
    (p['x'] as num).toDouble() * size.width,
    (p['y'] as num).toDouble() * size.height,
  );
  double distance(Offset a, Offset b) {
    final delta = b - a;
    final denominator = delta.dx * delta.dx + delta.dy * delta.dy;
    final t = denominator == 0
        ? 0.0
        : (((cursor - a).dx * delta.dx + (cursor - a).dy * delta.dy) /
                  denominator)
              .clamp(0.0, 1.0);
    return (cursor - (a + delta * t)).distance;
  }

  if (['ink', 'line'].contains(annotation['type'])) {
    final points = (annotation['points'] as List? ?? [])
        .map((p) => point(p))
        .toList();
    if (points.length == 1) return (points.single - cursor).distance <= radius;
    for (var i = 1; i < points.length; i++) {
      if (distance(points[i - 1], points[i]) <= radius) return true;
    }
    return false;
  }
  for (final r in annotation['rects'] as List? ?? []) {
    final rect = Rect.fromLTRB(
      r[0] * size.width,
      r[1] * size.height,
      r[2] * size.width,
      r[3] * size.height,
    );
    if (!rect.inflate(radius).contains(cursor)) continue;
    if (annotation['type'] != 'rectangle') return true;
    final inset = math.min(radius, math.min(rect.width, rect.height) / 2);
    if (!rect.deflate(inset).contains(cursor)) return true;
  }
  return false;
}

/// Session undo records only this reader's edits. The store checks the expected
/// snapshot inside its write lock before touching a newer concurrent edit.
class AnnotationEdits {
  final Workspace store;
  AnnotationEdits(this.store);
  final _undo = <({Entry? before, Entry after})>[];
  final _redo = <({Entry? before, Entry after})>[];
  bool busy = false;
  int pending = 0;
  bool get canUndo => _undo.isNotEmpty && !busy && pending == 0;
  bool get canRedo => _redo.isNotEmpty && !busy && pending == 0;

  Future<Entry> write(
    Map<String, dynamic> data, {
    String? id,
    bool deleted = false,
  }) async {
    pending++;
    try {
      final before = id == null ? null : store.entry(id);
      final after = await store.save(
        'annotation',
        data,
        id: id,
        deleted: deleted,
        basedOn: before,
      );
      _undo.add((before: before, after: after));
      _redo.clear();
      return after;
    } finally {
      pending--;
    }
  }

  Future<void> undo() async {
    if (!canUndo) return;
    busy = true;
    try {
      final command = _undo.last;
      final restored = await store.save(
        'annotation',
        command.before?.data ?? command.after.data,
        id: command.after.id,
        deleted: command.before?.deleted ?? true,
        basedOn: command.after,
      );
      _undo.removeLast();
      _redo.add((before: restored, after: command.after));
    } finally {
      busy = false;
    }
  }

  Future<void> redo() async {
    if (!canRedo) return;
    busy = true;
    try {
      final command = _redo.last;
      final restored = await store.save(
        'annotation',
        command.after.data,
        id: command.after.id,
        deleted: command.after.deleted,
        basedOn: command.before,
      );
      _redo.removeLast();
      _undo.add((before: command.before, after: restored));
    } finally {
      busy = false;
    }
  }
}
