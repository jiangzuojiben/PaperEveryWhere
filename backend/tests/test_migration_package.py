import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import package_readpaper_migration as package


def save(root, name, value):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


@pytest.fixture
def bundle(tmp_path):
    root = tmp_path / 'source'
    root.mkdir()
    content = (ROOT / 'client/test/fixtures/reader.pdf').read_bytes()
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(content) as pdf:
        pages = len(pdf)
    (root / 'all-pdfs').mkdir()
    (root / 'all-pdfs/1.pdf').write_bytes(content)
    digest = hashlib.sha256(content).hexdigest()
    item = {'source_id': 'readpaper:test:1', 'pdfId': '1', 'docId': '2',
            'title': '=Example title', 'filename': 'Example.pdf', 'file': 'all-pdfs/1.pdf',
            'pages': pages, 'bytes': len(content), 'sha256': digest}
    save(root, 'complete-manifest.json', {'format': 'paperdesk-local-pdf-bundle-v1', 'papers': [item]})
    save(root, 'documents.json', [{'pdfId': '1', 'docId': '2'}])
    save(root, 'download-results.json', [item])
    save(root, 'doc-index.json', {'status': 1, 'data': {'totalDocCount': 1, 'folderInfos': [
        {'folderId': 'f1', 'name': '中文文件夹', 'docInfos': [{'pdfId': '1'}]}],
        'unclassifiedDocInfos': []}})
    attachment = {'status': 1, 'data': {'list': [], 'amountLimit': 10}}
    save(root, 'attachments/2.json', attachment)
    save(root, 'attachment-inventory.json', [{'docId': '2', **attachment}])
    reading = {'marks': {'status': 1, 'data': [{'type': 0, 'select': {'rectangle': [
        {'x': 1.5, 'y': 23.25, 'width': 40, 'height': 8, 'pageNumber': 1}],
        'idea': '原始批注', 'picUrl': 'https://example.test/asset.png?signature=secret#fragment'}}]},
        'location': {'status': 1, 'data': {'location': '{"currentPage":1}'}},
        'detail': {'status': 1, 'data': {'access_token': 'secret-token', 'remark': '保留备注'}}}
    save(root, 'reading-data/1.json', reading)
    save(root, 'extra-notes/1.json', {'summary': {'status': 1, 'data': {}},
                                    'word': {'status': 1, 'data': {'words': []}}})
    asset = b'example image content'
    (root / 'note-assets').mkdir()
    (root / 'note-assets/a.png').write_bytes(asset)
    save(root, 'note-assets.json', [{'source_url': 'https://u:secret@example.test/asset.png?signature=secret',
        'file': 'note-assets/a.png', 'sha256': hashlib.sha256(asset).hexdigest(), 'bytes': len(asset)}])
    (root / 'reference-client.js').write_text('proprietary code')
    (root / 'cookies.txt').write_text('unrelated secret')
    output = tmp_path / 'migration.zip'
    return root, output, item, content


def test_archive_preserves_pdf_coordinates_and_excludes_private_material(bundle):
    root, output, item, content = bundle
    report = package.package_migration(root, output)
    assert report['pdf_count'] == 1 and report['folders'] == 1
    assert report['folder_memberships'] == 1
    assert report['attachments']['attachment_count'] == 0
    assert report['archive_members_verified'] == package.verify_archive(output)
    with zipfile.ZipFile(output) as archive:
        assert archive.read('all-pdfs/1.pdf') == content
        assert not {'reference-client.js', 'cookies.txt'} & set(archive.namelist())
        raw = archive.read('reading-data/1.json').decode()
        assert 'secret' not in raw and '原始批注' in raw
        note = json.loads(raw)['marks']['data'][0]['select']
        assert note['rectangle'][0]['y'] == 23.25
        assert note['picUrl'] == 'https://example.test/asset.png'
        assert "'=Example title" in archive.read('文献索引.csv').decode('utf-8-sig')
        assets = json.loads(archive.read('note-assets.json'))
        assert assets[0]['source_url'] == 'https://example.test/asset.png'
        manifest = json.loads(archive.read('complete-manifest.json'))
        assert manifest['papers'][0]['file'] == 'all-pdfs/1.pdf'
        assert '_path' not in manifest['papers'][0]


def test_sanitizer_nested_json_and_structured_credentials():
    value = {'Cookie': 'hidden', 'refresh_token': 'hidden', 'userInfo': {'phone': 'hidden'},
             'payload': '{"authorization":"hidden","page":3}',
             'note': 'Read https://name:hidden@example.test/paper?token=hidden#hidden',
             'rect': {'x': 0.25, 'y': 0.7}}
    result = package.sanitize(value)
    assert result == {'payload': '{"page":3}', 'note': 'Read https://example.test/paper',
                      'rect': {'x': 0.25, 'y': 0.7}}


def test_snapshot_is_consistent_sanitized_and_does_not_change_source(bundle):
    root, output, item, content = bundle
    database = root.parent / 'workspace.db'
    with sqlite3.connect(database) as db:
        db.executescript('''PRAGMA user_version=2;
            CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT,scope TEXT,revision INTEGER,data TEXT,deleted INTEGER);
            CREATE TABLE blobs(hash TEXT PRIMARY KEY,bytes BLOB,server_id TEXT);
            CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity_id TEXT,op_id TEXT,payload TEXT);''')
        paper = {'source_id': item['source_id'], 'file_hash': item['sha256'],
                 'source_data': {'url': 'https://example.test/paper?signature=SECRET_UNIQUE_VALUE'}}
        db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?)', ('p', 'paper', 'personal', 0, json.dumps(paper), 0))
        db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?)', ('n', 'note', 'personal', 0,
                   json.dumps({'paper_id': 'p', 'content': 'Recovered note'}), 0))
        db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?)', ('r', 'progress', 'personal', 0,
                   json.dumps({'paper_id': 'p', 'page': 1}), 0))
        db.execute('INSERT INTO blobs VALUES (?,?,NULL)', (item['sha256'], content))
        db.execute('INSERT INTO outbox(entity_id,op_id,payload) VALUES (?,?,?)', ('p', 'op1', json.dumps({'data': paper})))
    before = package.digest_file(database)
    result = package.package_migration(root, output, database)
    assert before == package.digest_file(database)
    assert result['database']['pdf_blob_hashes_verified'] == 1
    assert result['database']['entities']['note'] == 1
    assert result['database']['entities']['progress'] == 1
    with zipfile.ZipFile(output) as archive:
        snapshot = archive.read('workspace/paperdesk_offline.db')
        instructions = archive.read('恢复说明.md').decode('utf-8')
        assert '笔记 1 条、进度 1 条' in instructions
        packaged_summary = json.loads(archive.read('package-summary.json'))
        assert packaged_summary['database']['entities']['note'] == 1
        assert b'SECRET_UNIQUE_VALUE' not in snapshot
        destination = root.parent / 'restored.db'
        destination.write_bytes(snapshot)
    with sqlite3.connect(destination) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert db.execute('SELECT bytes FROM blobs').fetchone()[0] == content
        assert json.loads(db.execute('SELECT data FROM entities').fetchone()[0])['source_data']['url'] == 'https://example.test/paper'


@pytest.mark.parametrize('target', ['all-pdfs/1.pdf', 'note-assets/a.png'])
def test_corrupt_source_never_publishes_archive(bundle, target):
    root, output, _, _ = bundle
    with (root / target).open('ab') as stream:
        stream.write(b'corrupt')
    with pytest.raises(ValueError, match='SHA256|hash'):
        package.package_migration(root, output)
    assert not output.exists()


def test_actual_attachment_count_blocks_false_complete_export(bundle):
    root, output, _, _ = bundle
    save(root, 'attachment-inventory.json', [{'docId': '2', 'status': 1, 'data': {'list': [{'id': 1}]}}])
    with pytest.raises(ValueError, match='Attachments exist'):
        package.package_migration(root, output)
    assert not output.exists()


def test_missing_reading_export_never_publishes_archive(bundle):
    root, output, _, _ = bundle
    (root / 'reading-data/1.json').unlink()
    with pytest.raises(FileNotFoundError):
        package.package_migration(root, output)
    assert not output.exists()


@pytest.mark.parametrize('name', ['../escape', '/absolute', 'C:/outside', 'a\\b', 'a/../b', 'a//b', './file'])
def test_zip_member_paths_are_cross_platform_safe(name):
    with pytest.raises(ValueError, match='Unsafe archive'):
        package.safe_member(name)


def test_asset_traversal_is_rejected(bundle):
    root, output, _, _ = bundle
    save(root, 'note-assets.json', [{'file': '../outside', 'sha256': 'x', 'bytes': 1}])
    with pytest.raises(ValueError, match='Unsafe archive'):
        package.package_migration(root, output)


def test_archive_verifier_rejects_extra_unindexed_payload(bundle):
    root, output, _, _ = bundle
    package.package_migration(root, output)
    with zipfile.ZipFile(output, 'a') as archive:
        archive.writestr('extra.txt', b'not inventoried')
    with pytest.raises(ValueError, match='inventory mismatch'):
        package.verify_archive(output)


def test_existing_output_is_never_overwritten(bundle):
    root, output, _, _ = bundle
    output.write_bytes(b'existing backup')
    with pytest.raises(ValueError, match='already exists'):
        package.package_migration(root, output)
    assert output.read_bytes() == b'existing backup'


def test_previews_and_native_overlay_records_are_included_and_verified(bundle):
    root, output, item, content = bundle
    (root / 'annotation-previews').mkdir()
    (root / 'annotation-previews/1.pdf').write_bytes(content)
    save(root, 'previews-index.json', {'previews': [{'file': 'annotation-previews/1.pdf',
        'pages': item['pages'], 'sha256': item['sha256'], 'source_pages': [1]}]})
    save(root, 'native-overlays.json', {'annotations': [{'page': 1, 'rects': [[0.1, 0.2, 0.3, 0.4]]}]})
    save(root, 'annotation-coordinate-research.json', {'evidence': 'https://example.test/source?token=secret'})
    result = package.package_migration(root, output)
    assert result['preview_pdf_count'] == 1
    assert result['preview_pages'] == item['pages']
    with zipfile.ZipFile(output) as archive:
        assert archive.read('annotation-previews/1.pdf') == content
        assert 'native-overlays.json' in archive.namelist()
        assert 'reports/annotation-coordinate-research.json' in archive.namelist()
        assert b'secret' not in archive.read('reports/annotation-coordinate-research.json')
        assert 'tools/package_readpaper_migration.py' in archive.namelist()


def test_unindexed_preview_prevents_incomplete_archive(bundle):
    root, output, item, content = bundle
    (root / 'annotation-previews').mkdir()
    (root / 'annotation-previews/1.pdf').write_bytes(content)
    save(root, 'previews-index.json', {'previews': []})
    with pytest.raises(ValueError, match='preview inventory'):
        package.package_migration(root, output)
    assert not output.exists()


def test_credential_tables_in_workspace_are_rejected(tmp_path):
    database = tmp_path / 'input.db'
    with sqlite3.connect(database) as db:
        db.executescript('PRAGMA user_version=2; CREATE TABLE credentials(secret TEXT);')
    with pytest.raises(ValueError, match='Unexpected workspace tables'):
        package.snapshot_database(database, tmp_path / 'snapshot.db', [])


def test_overlay_summary_and_restore_explanation_use_report_counts(bundle):
    root, output, _, _ = bundle
    records = [{'source_id': 'converted', 'status': 'converted', 'overlay_ids': ['a', 'b']},
               {'source_id': 'page-note', 'status': 'preserved_without_overlay', 'overlay_ids': [], 'reason': 'no_geometry'},
               {'source_id': 'drawing', 'status': 'preserved_without_overlay', 'overlay_ids': [], 'reason': 'empty_drawing'},
               {'source_id': 'shape', 'status': 'preserved_without_overlay', 'overlay_ids': [], 'reason': 'empty_shape'}]
    save(root, 'overlay-report.json', {'source_records': 4,
        'status_counts': {'converted': 1, 'preserved_without_overlay': 3},
        'native_overlays': 2, 'papers_with_overlays': 1, 'annotated_pages': 1, 'records': records})
    (root / '迁移报告.md').write_text('Stale first-three report', encoding='utf-8')
    result = package.package_migration(root, output)
    assert result['overlays']['source_records'] == 4
    assert result['overlays']['native_overlays'] == 2
    assert result['overlays']['preservation_reasons'] == {'no_geometry': 1, 'empty_drawing': 1, 'empty_shape': 1}
    with zipfile.ZipFile(output) as archive:
        assert '迁移报告.md' not in archive.namelist()
        summary = json.loads(archive.read('package-summary.json'))
        assert summary['overlays']['status_counts']['converted'] == 1
        instructions = archive.read('恢复说明.md').decode('utf-8')
        assert '批注源记录共 4 条，已转换 1 条，生成 2 个页面叠加' in instructions
        assert '保留但未生成叠加 3 条' in instructions
        assert '无选区坐标的页面笔记 1 条' in instructions
        assert '空绘图记录 1 条' in instructions
        assert '零尺寸图形 1 条' in instructions


def test_inconsistent_overlay_totals_are_rejected():
    with pytest.raises(ValueError, match='source record count'):
        package.overlay_summary({'source_records': 1, 'records': []})
    with pytest.raises(ValueError, match='status counts'):
        package.overlay_summary({'status_counts': {'converted': 1}, 'records': []})
