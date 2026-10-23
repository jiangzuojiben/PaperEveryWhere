import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('local_bundle', ROOT / 'scripts/import_local_bundle.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.path.insert(0, str(ROOT / 'scripts'))
from enrich_readpaper_migration import apply_records


@pytest.fixture
def bundle(tmp_path):
    pdf = ROOT / 'client/test/fixtures/reader.pdf'
    content = pdf.read_bytes()
    (tmp_path / 'paper.pdf').write_bytes(content)
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(content) as doc:
        pages = len(doc)
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({'format': 'paperdesk-local-pdf-bundle-v1', 'papers': [{
        'source_id': 'readpaper:test:1', 'title': 'Recovered paper', 'file': 'paper.pdf',
        'filename': 'paper.pdf', 'pages': pages, 'sha256': hashlib.sha256(content).hexdigest()}]}))
    database = tmp_path / 'client.db'
    with sqlite3.connect(database) as db:
        db.executescript('''PRAGMA user_version=2;
            CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT,scope TEXT,revision INTEGER,data TEXT,deleted INTEGER);
            CREATE TABLE blobs(hash TEXT PRIMARY KEY,bytes BLOB,server_id TEXT);
            CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity_id TEXT UNIQUE,op_id TEXT,payload TEXT);
            CREATE VIRTUAL TABLE search USING fts5(id,title,content);''')
    return tmp_path, manifest, database


def test_import_backup_and_idempotence_preserve_edits(bundle):
    root, manifest, database = bundle
    result = module.import_bundle(manifest, database, root / 'before.db')
    assert len(result['inserted']) == 1
    with sqlite3.connect(root / 'before.db') as db:
        assert db.execute('SELECT count(*) FROM entities').fetchone()[0] == 0
    with sqlite3.connect(database) as db:
        identifier, raw = db.execute("SELECT id,data FROM entities WHERE kind='paper'").fetchone()
        paper = json.loads(raw)
        paper['title'] = 'User edit'
        db.execute('UPDATE entities SET data=? WHERE id=?', (json.dumps(paper), identifier))
        assert db.execute('SELECT count(*) FROM outbox').fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM search WHERE search MATCH 'Recovered'").fetchone()[0] == 1
    result = module.import_bundle(manifest, database, root / 'before-retry.db')
    assert len(result['skipped']) == 1
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT count(*) FROM entities').fetchone()[0] == 2
        assert json.loads(db.execute("SELECT data FROM entities WHERE kind='paper'").fetchone()[0])['title'] == 'User edit'


def test_corrupt_file_rejected_before_database_write(bundle):
    root, manifest, database = bundle
    (root / 'paper.pdf').write_bytes(b'%PDF-corrupt')
    with pytest.raises(ValueError, match='SHA256'):
        module.import_bundle(manifest, database, root / 'before.db')
    assert not (root / 'before.db').exists()
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT count(*) FROM entities').fetchone()[0] == 0


def test_transaction_rolls_back_on_identifier_collision(bundle):
    root, manifest, database = bundle
    value = json.loads(manifest.read_text())
    value['papers'].append({**value['papers'][0], 'source_id': 'readpaper:test:2'})
    # Collision in version entity happens after the paper/blob insert.
    item = value['papers'][0]
    version = module.stable_id(item['source_id'] + ':version:' + item['sha256'])
    with sqlite3.connect(database) as db:
        db.execute('INSERT INTO entities VALUES (?, ?, ?, 0, ?, 0)', (version, 'note', 'personal', '{}'))
    with pytest.raises(sqlite3.IntegrityError):
        module.import_bundle(manifest, database, root / 'before.db')
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT count(*) FROM entities').fetchone()[0] == 1
        assert db.execute('SELECT count(*) FROM blobs').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM outbox').fetchone()[0] == 0


def test_hash_dedup_reports_alternate_source(bundle):
    root, manifest, database = bundle
    value = json.loads(manifest.read_text())
    value['papers'].append({**value['papers'][0], 'source_id': 'readpaper:test:2'})
    manifest.write_text(json.dumps(value))
    result = module.import_bundle(manifest, database, root / 'before.db')
    assert len(result['inserted']) == 1 and len(result['reused_content']) == 1


def test_original_v1_workspace_import_stays_compatible(bundle):
    root, manifest, database = bundle
    with sqlite3.connect(database) as db:
        db.execute('PRAGMA user_version=1')
    result = module.import_bundle(manifest, database, root / 'before.db')
    assert len(result['inserted']) == 1
    with sqlite3.connect(database) as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 1


def test_enrichment_keeps_titles_orders_folders_before_papers_and_is_repeatable(bundle):
    root, manifest, database = bundle
    result = module.import_bundle(manifest, database, root / 'before.db')
    paper = result['inserted'][0]
    folder = module.stable_id('folder-a')
    records = [('folder', folder, {'title': 'A', 'source_id': 'folder-a'})]
    updates = {paper['paper_id']: {'source_id': paper['source_id'], 'sha256': paper['sha256'],
                                  'data': {'folder_id': folder, 'folder_ids': [folder], 'migration': {'enriched': True}}}}
    assert apply_records(database, root / 'enrich-before.db', records, updates) == {'folder': 1, 'paper': 1}
    with sqlite3.connect(database) as db:
        first = json.loads(db.execute('SELECT payload FROM outbox ORDER BY seq LIMIT 1').fetchone()[0])
        assert first['kind'] == 'folder'
        data = json.loads(db.execute('SELECT data FROM entities WHERE id=?', (paper['paper_id'],)).fetchone()[0])
        assert data['title'] == 'Recovered paper' and data['folder_ids'] == [folder]
    assert apply_records(database, root / 'enrich-retry.db', records, updates) == {}


def test_enrichment_rolls_back_on_changed_pdf_identity(bundle):
    root, manifest, database = bundle
    result = module.import_bundle(manifest, database, root / 'before.db')
    paper = result['inserted'][0]
    records = [('folder', module.stable_id('bad-folder'), {'title': 'A', 'source_id': 'bad-folder'})]
    with pytest.raises(ValueError, match='identity changed'):
        apply_records(database, root / 'bad-before.db', records,
                      {paper['paper_id']: {'source_id': paper['source_id'], 'sha256': '0'*64, 'data': {}}})
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT count(*) FROM entities WHERE kind='folder'").fetchone()[0] == 0
