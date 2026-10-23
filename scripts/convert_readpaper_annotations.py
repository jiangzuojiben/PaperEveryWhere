"""Convert a reviewed ReadPaper export into local, version-bound page overlays.

Offline only. Coordinates are derived from the saved viewer's behavior, never
from guessed text positions. Source notes and original PDF bytes are retained.
Run without --apply first to produce a complete conversion inventory.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import uuid

import pypdfium2 as pdfium

from import_local_bundle import stable_id, validate_bundle

FORMAT = 'readpaper-page-overlays-v1'
COLORS = {1: '#338AFF', 2: '#80E639', 3: '#FFFF00', 4: '#FF8C19', 5: '#F24030'}
SHAPE_COLORS = {1: '#1F71E0', 2: '#FFC53D', 3: '#E66045', 4: '#73D13D', 5: '#262625'}


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Non-finite or missing coordinate')
    return float(value)


def normalized_rect(rect, width, height, rotation=0):
    """Source unrotated crop-relative top-left points -> displayed [0, 1]."""
    x, y, w, h = [number(rect[k]) for k in ('x', 'y', 'width', 'height')]
    if w <= 0 or h <= 0:
        raise ValueError('Empty or reversed rectangle')
    if rotation == 90:
        x, y, w, h = height - y - h, x, h, w
        width, height = height, width
    elif rotation == 180:
        x, y = width - x - w, height - y - h
    elif rotation == 270:
        x, y, w, h = y, width - x - w, h, w
        width, height = height, width
    elif rotation != 0:
        raise ValueError('Unsupported page rotation')
    result = [x / width, y / height, (x + w) / width, (y + h) / height]
    if any(v < -1e-7 or v > 1 + 1e-7 for v in result):
        raise ValueError('Rectangle extends beyond the displayed page')
    return [min(1.0, max(0.0, v)) for v in result]


def arrow_points(shape, width, height):
    # One continuous path traces the shaft and two wings. The repeated tip is
    # deliberate: it avoids introducing a spurious line between wing ends.
    x, y, ex, ey = [number(shape[k]) for k in ('x', 'y', 'endX', 'endY')]
    length = math.hypot(ex - x, ey - y)
    if not length:
        raise ValueError('Empty arrow')
    ux, uy = (ex - x) / length, (ey - y) / length
    wing = min(8.0, length / 3)
    points = [(x, y), (ex, ey), (ex - wing * ux + wing * .5 * uy, ey - wing * uy - wing * .5 * ux),
              (ex, ey), (ex - wing * ux - wing * .5 * uy, ey - wing * uy + wing * .5 * ux)]
    if any(not (0 <= px <= width and 0 <= py <= height) for px, py in points):
        raise ValueError('Arrow extends beyond the displayed page')
    return [{'x': px / width, 'y': py / height, 'pressure': .5} for px, py in points]


def build_overlays(root, account):
    manifest = validate_bundle(root / 'complete-manifest.json')
    assets = {a['source_url']: a for a in read(root / 'note-assets.json')}
    records, paper_status, audit = [], {}, []
    source_kinds = Counter()
    for paper in manifest['papers']:
        source = paper['source_id']
        if not source.startswith('readpaper:' + account + ':'):
            raise ValueError('Account/source identity does not match manifest')
        pid = source.rsplit(':', 1)[1]
        paper_id = stable_id(source)
        exported = read(root / 'reading-data' / (pid + '.json'))
        if any(v.get('status') != 1 for v in exported.values()):
            raise ValueError('Incomplete reading-data export')
        if (exported.get('handwriting') or {}).get('data'):
            raise ValueError('Nonempty v3 handwriting needs a verified path converter')
        statuses = []
        with pdfium.PdfDocument(paper['_path']) as document:
            def geometry(page_number):
                if type(page_number) is not int or not 1 <= page_number <= len(document):
                    raise ValueError('Annotation page outside PDF')
                with closing(document[page_number - 1]) as page:
                    width, height = page.get_size()
                    rotation = page.get_rotation()
                original_size = (height, width) if rotation in (90, 270) else (width, height)
                return width, height, rotation, original_size

            def convert(raw, suffix, kind):
                identity = source + ':' + suffix
                item = {'source_id': identity, 'pdf_id': pid, 'page': raw.get('pageNumber'),
                        'source_kind': kind, 'overlay_ids': []}
                audit.append(item)
                statuses.append(item)
                source_kinds[kind] += 1

                def emit(page, data):
                    sid = identity + ':overlay:v1:page:' + str(page)
                    data = {'paper_id': paper_id, 'file_hash': paper['sha256'], 'page': page,
                            'source_id': sid, 'source_note_id': stable_id(identity),
                            'source_record_id': identity, 'conversion': FORMAT,
                            'rects': [], 'points': [], **data}
                    identifier = stable_id(sid)
                    records.append(('annotation', identifier, data))
                    item['overlay_ids'].append(identifier)

                try:
                    if kind in ('selection', 'excerpt'):
                        part = raw['select'] if kind == 'selection' else raw['rect']
                        rects = part.get('rectangle') or []
                        rects = rects if isinstance(rects, list) else [rects]
                        if not rects:
                            item.update(status='preserved_without_overlay', reason='no_geometry',
                                        detail='Source page note has no selection coordinates; original note retained.')
                            return
                        pages = defaultdict(list)
                        for rect in rects:
                            page = rect.get('pageNumber', raw.get('pageNumber'))
                            w, h, rotation, original = geometry(page)
                            # The reference rotates the SVG using the page viewport;
                            # rectangle.rotation is not an extra rotation operation.
                            pages[page].append(normalized_rect(rect, *original, rotation))
                        for page, normalized in pages.items():
                            width = geometry(page)[0]
                            data = {'type': 'highlight' if kind == 'selection' else 'rectangle',
                                    'color': COLORS[part['styleId']], 'rects': normalized,
                                    'text': part.get('idea') or part.get('rectStr') or '',
                                    'text_anchor': part.get('rectStr', '')}
                            if kind == 'selection':
                                data['opacity'] = .3
                            else:
                                data.update(fill_opacity=.1, stroke_width=1 / width)
                            emit(page, data)
                    elif kind == 'text':
                        box = raw['textBox']
                        w, h, _, _ = geometry(raw['pageNumber'])
                        fonts = box.get('fonts') or []
                        if not fonts or any((f['fontSize'], f['color']) != (fonts[0]['fontSize'], fonts[0]['color']) for f in fonts):
                            raise ValueError('Mixed text styles require a rich-text converter')
                        rect = {**box, 'width': number(box['width']) * w / 950 / 1.2,
                                'height': number(box['height']) * w / 950 / 1.2}
                        emit(raw['pageNumber'], {'type': 'text', 'color': fonts[0]['color'],
                             'font_size': number(fonts[0]['fontSize']) / 950,
                             'rects': [normalized_rect(rect, w, h)],
                             'text': ''.join(f['content'] for f in fonts)})
                        item['dimension_basis'] = 'reference-default-hws-1.2; iPad-width-950'
                    elif kind == 'drawing':
                        url = raw['drawAnnotation']['nsDataUrl']
                        asset = assets[url]
                        path = (root / asset['file']).resolve(strict=True)
                        if not path.is_relative_to(root.resolve()):
                            raise ValueError('Drawing asset outside export')
                        if hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
                            raise ValueError('Drawing asset hash mismatch')
                        drawing = read(path)
                        if drawing.get('drawModelArray') != []:
                            raise ValueError('Nonempty legacy drawing needs a verified path converter')
                        item.update(status='preserved_without_overlay', reason='empty_drawing',
                                    detail='Downloaded original drawModelArray is empty.')
                        return
                    elif kind == 'shape':
                        page = raw['pageNumber']
                        w, h, _, _ = geometry(page)
                        data = {'color': SHAPE_COLORS[raw['strokeColor']], 'stroke_width': 1.5 / w, 'text': ''}
                        if raw['type'] == 0:
                            if raw['width'] == 0 or raw['height'] == 0:
                                item.update(status='preserved_without_overlay', reason='empty_shape',
                                            detail='Source rectangle has zero area.')
                                return
                            data.update(type='rectangle', rects=[normalized_rect(raw, w, h)])
                        elif raw['type'] == 2:
                            data.update(type='ink', points=arrow_points(raw, w, h))
                            item['approximation'] = 'Arrow wings reconstructed as a vector polyline; source endpoints retained.'
                        else:
                            raise ValueError('Unsupported shape type')
                        emit(page, data)
                    else:
                        raise ValueError('Unknown annotation type')
                    item['status'] = 'converted'
                except (ValueError, KeyError, TypeError) as error:
                    # Discard partial multi-page output on a failed source record.
                    records[:] = [r for r in records if r[1] not in item['overlay_ids']]
                    item.update(status='unresolved', reason=str(error), overlay_ids=[])

            for index, mark in enumerate(exported['marks'].get('data') or []):
                part = mark.get('select') or mark.get('rect') or mark.get('textBox') or {}
                suffix = 'mark:' + str(part.get('uuid') or part.get('id') or index)
                kind = {0: 'selection', 1: 'excerpt', 2: 'drawing', 4: 'text'}.get(mark['type'], 'unknown')
                convert(mark, suffix, kind)
            for index, shape in enumerate((exported['shapes'].get('data') or {}).get('list', [])):
                convert(shape, 'shape:' + str(shape.get('shapeId') or index), 'shape')
        counts = Counter(x['status'] for x in statuses)
        paper_status[paper_id] = {'source_id': source, 'file_hash': paper['sha256'],
                                 'native_annotation_overlays': 'partial' if counts['unresolved'] else 'converted',
                                 'overlay_conversion': FORMAT, 'overlay_records': sum(len(x['overlay_ids']) for x in statuses),
                                 'source_annotation_records': len(statuses), 'overlay_source_counts': dict(counts)}
    if len({r[1] for r in records}) != len(records):
        raise ValueError('Duplicate source annotation identity')
    report = {'format': FORMAT, 'created_at': datetime.now(timezone.utc).isoformat(),
              'source_counts': dict(source_kinds), 'source_records': len(audit),
              'status_counts': dict(Counter(x['status'] for x in audit)),
              'native_overlays': len(records), 'papers_with_overlays': len({r[2]['paper_id'] for r in records}),
              'annotated_pages': len({(r[2]['paper_id'], r[2]['page']) for r in records}),
              'verification_boundary': 'Offline source analysis, PDF geometry and rendered previews; no desktop UI comparison.',
              'text_box_basis': '950-unit source font scale; default dimension factor 1.2 from saved reference; custom original hws setting not exported.',
              'records': audit}
    return records, paper_status, report


def apply_overlays(database, backup, records, papers, report):
    if not database.is_file() or backup.exists():
        raise ValueError('Existing database and unused backup path required')
    if report['status_counts'].get('unresolved', 0):
        raise ValueError('Resolve conversion errors before applying')
    counts = Counter()
    with closing(sqlite3.connect(database, timeout=5)) as db:
        if db.execute('PRAGMA user_version').fetchone()[0] not in (1, 2):
            raise ValueError('Unsupported local database schema')
        db.execute('BEGIN IMMEDIATE')
        try:
            backup.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(backup)) as dest:
                source.backup(dest)
                if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Backup integrity failure')
            now = datetime.now(timezone.utc).isoformat()

            def put(kind, identifier, data, revision, insert=False):
                encoded = json.dumps(data, ensure_ascii=False)
                if insert:
                    db.execute('INSERT INTO entities VALUES (?,?,?,?,?,0)', (identifier, kind, 'personal', revision, encoded))
                else:
                    db.execute('UPDATE entities SET data=? WHERE id=?', (encoded, identifier))
                op = {'op_id': str(uuid.uuid4()), 'entity_id': identifier, 'kind': kind,
                      'base_revision': revision, 'data': data, 'deleted': False}
                db.execute('INSERT INTO outbox(entity_id,op_id,payload) VALUES (?,?,?) ON CONFLICT(entity_id) '
                           'DO UPDATE SET op_id=excluded.op_id,payload=excluded.payload',
                           (identifier, op['op_id'], json.dumps(op, ensure_ascii=False)))

            for identifier, status in papers.items():
                row = db.execute("SELECT data,revision FROM entities WHERE id=? AND kind='paper' AND scope='personal' AND deleted=0", (identifier,)).fetchone()
                if not row:
                    raise ValueError('Target paper missing or deleted')
                data = json.loads(row[0])
                if data.get('source_id') != status['source_id'] or data.get('file_hash') != status['file_hash']:
                    raise ValueError('Paper source identity or PDF changed')
                update = {k: v for k, v in status.items() if k not in ('source_id', 'file_hash')}
                migration = {**data.get('migration', {}), **update}
                if migration != data.get('migration'):
                    put('paper', identifier, {**data, 'migration': migration}, row[1])
                    counts['papers_updated'] += 1
            for kind, identifier, data in records:
                row = db.execute('SELECT kind,scope,data FROM entities WHERE id=?', (identifier,)).fetchone()
                if row:
                    if row[:2] != (kind, 'personal') or json.loads(row[2]).get('source_id') != data['source_id']:
                        raise ValueError('Annotation identity collision')
                    counts['preserved_existing'] += 1
                    continue
                put(kind, identifier, {'created': now, **data}, 0, insert=True)
                counts['inserted'] += 1
            for item in report['records']:
                identifier = stable_id(item['source_id'])
                row = db.execute("SELECT data,revision FROM entities WHERE id=? AND kind='note' AND scope='personal' AND deleted=0", (identifier,)).fetchone()
                if not row or json.loads(row[0]).get('source_id') != item['source_id']:
                    raise ValueError('Original annotation note is missing; run enrichment first')
                data = json.loads(row[0])
                updated = {**data, 'overlay_ids': item['overlay_ids'], 'overlay_status': item['status']}
                if item['source_kind'] == 'shape' and data.get('content') == 'ReadPaper 图形原始坐标已保存，待校准后恢复页面叠加。':
                    updated['content'] = ('ReadPaper 原图形已恢复为页面叠加；原始坐标保存在来源记录中。'
                                          if item['overlay_ids'] else 'ReadPaper 原图形为零尺寸；原始记录已保留。')
                if updated != data:
                    put('note', identifier, updated, row[1])
                    counts['notes_linked'] += 1
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Database integrity failure')
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return dict(counts)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', type=Path)
    parser.add_argument('--account', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--database', type=Path)
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    records, papers, report = build_overlays(args.export, args.account)
    if args.apply:
        if not args.database or not args.backup:
            parser.error('--apply requires --database and --backup')
        report['database_apply'] = apply_overlays(args.database, args.backup, records, papers, report)
    (args.export / 'native-overlays.json').write_text(json.dumps({'format': FORMAT, 'annotations': [dict(id=i, **d) for _, i, d in records]}, ensure_ascii=False, indent=2), encoding='utf-8')
    (args.export / 'overlay-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'records'}, ensure_ascii=False, indent=2))
