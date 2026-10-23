"""Offline migration contracts using synthetic PDFs and temporary databases only."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

import pytest
from pypdf import PdfWriter
from pypdf.generic import RectangleObject

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from convert_readpaper_annotations import apply_overlays, build_overlays, stable_id


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


@pytest.fixture
def export(tmp_path):
    # Nonzero crop origin distinguishes PDF absolute coordinates from the
    # crop-relative coordinates exported by ReadPaper.
    writer = PdfWriter()
    for rotation in (0, 90, 180, 270):
        page = writer.add_blank_page(width=300, height=500)
        page.cropbox = RectangleObject([50, 60, 250, 460])
        page.rotate(rotation)
    pdf = tmp_path / 'paper.pdf'
    writer.write(pdf)
    digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
    write_json(tmp_path / 'complete-manifest.json', {
        'format': 'paperdesk-local-pdf-bundle-v1', 'papers': [{
            'source_id': 'readpaper:test:paper', 'title': 'Fixture',
            'file': 'paper.pdf', 'filename': 'paper.pdf', 'pages': 4,
            'sha256': digest,
        }],
    })
    (tmp_path / 'reading-data').mkdir()
    write_json(tmp_path / 'note-assets.json', [])
    data = {
        'detail': {'status': 1, 'data': {}},
        'location': {'status': 1, 'data': None},
        'marks': {'status': 1, 'data': []},
        'shapes': {'status': 1, 'data': {'list': []}},
        'handwriting': {'status': 1, 'data': []},
    }

    def build(marks=(), shapes=(), account='test'):
        data['marks']['data'] = list(marks)
        data['shapes']['data']['list'] = list(shapes)
        write_json(tmp_path / 'reading-data/paper.json', data)
        return build_overlays(tmp_path, account)

    return tmp_path, build


def selection(identifier='a', pages=(1,), **overrides):
    return {'type': 0, 'pageNumber': pages[0], 'select': {
        'uuid': identifier, 'styleId': 3, 'rectStr': 'Source excerpt',
        'idea': 'Original comment',
        'rectangle': [dict(x=20, y=40, width=60, height=80,
                           pageNumber=page, rotation=270) for page in pages],
        **overrides,
    }}


def seed_database(root, papers, report):
    database = root / 'target.db'
    with sqlite3.connect(database) as db:
        db.executescript('''PRAGMA user_version=2;
            CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT,scope TEXT,revision INTEGER,data TEXT,deleted INTEGER);
            CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity_id TEXT UNIQUE,op_id TEXT,payload TEXT);''')
        for identifier, paper in papers.items():
            data = {'source_id': paper['source_id'], 'file_hash': paper['file_hash'],
                    'title': 'User title', 'migration': {'enriched': True}}
            db.execute('INSERT INTO entities VALUES (?, ?, ?, 7, ?, 0)',
                       (identifier, 'paper', 'personal', json.dumps(data)))
        for item in report['records']:
            data = {'source_id': item['source_id'], 'content': 'User note edit',
                    'source_data': {'untouched': True}}
            db.execute('INSERT INTO entities VALUES (?, ?, ?, 3, ?, 0)',
                       (stable_id(item['source_id']), 'note', 'personal', json.dumps(data)))
    return database


def state(database):
    with sqlite3.connect(database) as db:
        return (db.execute('SELECT * FROM entities ORDER BY id').fetchall(),
                db.execute('SELECT * FROM outbox ORDER BY seq').fetchall())


def test_crop_relative_rectangles_rotate_and_split_pages(export):
    _, build = export
    records, papers, report = build([selection(pages=(1, 2, 3, 4))])
    expected = [(.1, .1, .4, .3), (.7, .1, .9, .4),
                (.6, .7, .9, .9), (.1, .6, .3, .9)]
    assert [r[2]['page'] for r in records] == [1, 2, 3, 4]
    for record, rect in zip(records, expected):
        assert record[2]['rects'][0] == pytest.approx(rect)
        assert record[2]['type'] == 'highlight'
        assert record[2]['color'] == '#FFFF00'
        assert record[2]['opacity'] == .3
    assert len({r[1] for r in records}) == 4
    assert len({r[2]['source_note_id'] for r in records}) == 1
    assert report['status_counts'] == {'converted': 1}
    assert report['annotated_pages'] == 4
    assert next(iter(papers.values()))['overlay_records'] == 4
    # Conversion IDs remain stable, independently of timestamps in the audit.
    assert build([selection(pages=(1, 2, 3, 4))])[0] == records


def test_shapes_use_displayed_coordinates_without_double_rotation(export):
    _, build = export
    shapes = [dict(type=0, shapeId='rectangle', pageNumber=2, strokeColor=3,
                   x=20, y=40, width=60, height=80),
              dict(type=2, shapeId='arrow', pageNumber=2, strokeColor=1,
                   x=100, y=100, endX=140, endY=120)]
    records, _, report = build(shapes=shapes)
    rectangle, arrow = (r[2] for r in records)
    assert rectangle['rects'][0] == pytest.approx([.05, .2, .2, .6])
    assert rectangle['color'] == '#E66045'
    assert rectangle['stroke_width'] == pytest.approx(1.5 / 400)
    assert arrow['type'] == 'ink'
    assert arrow['points'][0] == {'x': .25, 'y': .5, 'pressure': .5}
    assert arrow['points'][1] == {'x': .35, 'y': .6, 'pressure': .5}
    assert 'approximation' in report['records'][1]


def test_excerpt_and_text_style_are_preserved(export):
    _, build = export
    marks = [dict(type=1, pageNumber=1, rect=dict(uuid='box', styleId=4,
                 rectangle=dict(x=20, y=40, width=60, height=80, pageNumber=1))),
             dict(type=4, pageNumber=1, textBox=dict(id='text', x=10, y=20,
                  width=114, height=57,
                  fonts=[dict(content='中文 note', fontSize=12, color='#1F71E0')]))]
    records, _, report = build(marks)
    rectangle, text = (r[2] for r in records)
    assert rectangle['color'] == '#FF8C19'
    assert rectangle['fill_opacity'] == .1
    assert rectangle['stroke_width'] == pytest.approx(1 / 200)
    # Source width 114 * (200/950) / 1.2 = 20 PDF points.
    assert text['rects'][0] == pytest.approx([.05, .05, .15, .075])
    assert text['font_size'] == pytest.approx(12 / 950)
    assert text['text'] == '中文 note'
    assert 'reference-default-hws-1.2' in report['records'][1]['dimension_basis']


def test_geometry_free_notes_and_empty_drawing_are_preserved(export):
    root, build = export
    drawing = root / 'drawing.json'
    write_json(drawing, {'drawModelArray': []})
    write_json(root / 'note-assets.json', [{
        'source_url': 'https://example.invalid/drawing', 'file': drawing.name,
        'sha256': hashlib.sha256(drawing.read_bytes()).hexdigest(),
    }])
    marks = [selection(rectangle=None), dict(type=2, pageNumber=1,
             drawAnnotation={'nsDataUrl': 'https://example.invalid/drawing'})]
    shapes = [dict(type=0, shapeId='zero', pageNumber=1, strokeColor=1,
                   x=10, y=20, width=0, height=0)]
    records, _, report = build(marks, shapes)
    assert records == []
    assert report['status_counts'] == {'preserved_without_overlay': 3}
    assert {item['reason'] for item in report['records']} == {
        'no_geometry', 'empty_drawing', 'empty_shape'}
    assert all(item['overlay_ids'] == [] for item in report['records'])


@pytest.mark.parametrize('fault', ['hash', 'nonempty', 'escape'])
def test_unverified_drawing_data_never_becomes_overlay(export, tmp_path, fault):
    root, build = export
    drawing = root / 'drawing.json'
    write_json(drawing, {'drawModelArray': [{'points': []}] if fault == 'nonempty' else []})
    if fault == 'escape':
        drawing = root.parent / (root.name + '-outside.json')
        write_json(drawing, {'drawModelArray': []})
    write_json(root / 'note-assets.json', [{
        'source_url': 'https://example.invalid/drawing', 'file': str(drawing),
        'sha256': '0' * 64 if fault == 'hash' else hashlib.sha256(drawing.read_bytes()).hexdigest(),
    }])
    records, _, report = build([dict(type=2, pageNumber=1,
        drawAnnotation={'nsDataUrl': 'https://example.invalid/drawing'})])
    assert records == []
    assert report['status_counts'] == {'unresolved': 1}


def test_failed_multi_page_source_discards_all_its_partial_overlays(export):
    _, build = export
    bad = selection(pages=(1, 2))
    bad['select']['rectangle'][1]['x'] = 9999
    records, _, report = build([bad, selection('valid')])
    assert len(records) == 1
    assert records[0][2]['source_record_id'].endswith('mark:valid')
    assert report['records'][0]['overlay_ids'] == []
    assert report['records'][0]['status'] == 'unresolved'


def test_duplicate_identity_and_changed_pdf_are_rejected(export):
    root, build = export
    with pytest.raises(ValueError, match='Duplicate source annotation identity'):
        build([selection(), selection()])
    with pytest.raises(ValueError, match='Account/source identity'):
        build([selection()], account='other')
    with (root / 'paper.pdf').open('ab') as pdf:
        pdf.write(b'changed')
    with pytest.raises(ValueError, match='SHA256'):
        build([selection()])


def test_nonempty_v3_handwriting_fails_closed_instead_of_silent_omission(export):
    root, build = export
    build([selection()])
    path = root / 'reading-data/paper.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    data['handwriting']['data'] = [{
        'webDrawV2': {'pageNumber': 1, 'webDrawItems': [{
            'id': 'stroke', 'tooltype': 1, 'lineHexColor': '#1F71E0',
            'points': [{'x': 10, 'y': 20}, {'x': 30, 'y': 40}],
        }]},
    }]
    write_json(path, data)
    with pytest.raises(ValueError, match='Nonempty v3 handwriting needs a verified path converter'):
        build_overlays(root, 'test')


def test_apply_is_backed_up_and_retry_preserves_user_edits_and_tombstones(export):
    root, build = export
    records, papers, report = build([selection(pages=(1, 2))])
    database = seed_database(root, papers, report)
    before = state(database)
    result = apply_overlays(database, root / 'before.db', records, papers, report)
    assert result == {'papers_updated': 1, 'inserted': 2, 'notes_linked': 1}
    assert state(root / 'before.db') == before
    with sqlite3.connect(database) as db:
        note = json.loads(db.execute("SELECT data FROM entities WHERE kind='note'").fetchone()[0])
        assert note['content'] == 'User note edit'
        assert note['source_data'] == {'untouched': True}
        assert note['overlay_ids'] == [r[1] for r in records]
        assert all(json.loads(row[0])['base_revision'] in (0, 3, 7)
                   for row in db.execute('SELECT payload FROM outbox'))
        identifier = records[0][1]
        data = json.loads(db.execute('SELECT data FROM entities WHERE id=?', (identifier,)).fetchone()[0])
        data['text'] = 'User annotation edit'
        db.execute('UPDATE entities SET data=? WHERE id=?', (json.dumps(data), identifier))
        identifier = records[1][1]
        db.execute('UPDATE entities SET deleted=1 WHERE id=?', (identifier,))
        # Represent the pending user deletion; rerunning must not replace it.
        deletion = {'entity_id': identifier, 'deleted': True, 'data': {}}
        db.execute('UPDATE outbox SET payload=? WHERE entity_id=?', (json.dumps(deletion), identifier))
    edited = state(database)
    assert apply_overlays(database, root / 'retry.db', records, papers, report) == {'preserved_existing': 2}
    assert state(database) == edited


@pytest.mark.parametrize('fault', ['missing', 'deleted', 'wrong_identity'])
def test_missing_original_note_rolls_back_every_write(export, fault):
    root, build = export
    records, papers, report = build([selection()])
    database = seed_database(root, papers, report)
    with sqlite3.connect(database) as db:
        if fault == 'missing':
            db.execute("DELETE FROM entities WHERE kind='note'")
        elif fault == 'deleted':
            db.execute("UPDATE entities SET deleted=1 WHERE kind='note'")
        else:
            db.execute("UPDATE entities SET data=? WHERE kind='note'", (json.dumps({'source_id': 'wrong'}),))
    before = state(database)
    with pytest.raises(ValueError, match='Original annotation note is missing'):
        apply_overlays(database, root / 'before.db', records, papers, report)
    assert state(database) == before
    assert state(root / 'before.db') == before


def test_late_identity_collision_rolls_back_earlier_annotation_insertion(export):
    root, build = export
    records, papers, report = build([selection(pages=(1, 2))])
    database = seed_database(root, papers, report)
    with sqlite3.connect(database) as db:
        db.execute('INSERT INTO entities VALUES (?, ?, ?, 0, ?, 0)',
                   (records[1][1], 'annotation', 'personal', json.dumps({'source_id': 'unrelated'})))
    before = state(database)
    with pytest.raises(ValueError, match='Annotation identity collision'):
        apply_overlays(database, root / 'before.db', records, papers, report)
    assert state(database) == before


def test_changed_pdf_and_unresolved_report_cannot_be_applied(export):
    root, build = export
    records, papers, report = build([selection()])
    database = seed_database(root, papers, report)
    with sqlite3.connect(database) as db:
        row = db.execute("SELECT id,data FROM entities WHERE kind='paper'").fetchone()
        data = json.loads(row[1])
        data['file_hash'] = '0' * 64
        db.execute('UPDATE entities SET data=? WHERE id=?', (json.dumps(data), row[0]))
    before = state(database)
    with pytest.raises(ValueError, match='Paper source identity or PDF changed'):
        apply_overlays(database, root / 'changed-before.db', records, papers, report)
    assert state(database) == before
    bad_report = copy.deepcopy(report)
    bad_report['status_counts']['unresolved'] = 1
    with pytest.raises(ValueError, match='Resolve conversion errors'):
        apply_overlays(database, root / 'unresolved-before.db', records, papers, bad_report)
    assert not (root / 'unresolved-before.db').exists()
