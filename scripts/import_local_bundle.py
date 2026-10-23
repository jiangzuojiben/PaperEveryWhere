"""Import a reviewed PDF bundle into a closed PaperDesk local workspace.

No ReadPaper credentials, network requests, or source-library writes. The input
bundle contains only explicitly recovered PDFs and a reviewed manifest. Existing
entities are never overwritten; identical content is reused within personal scope.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid


def stable_id(value):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'paperdesk-migration:' + value))


def validate_bundle(manifest):
    root = manifest.parent.resolve()
    bundle = json.loads(manifest.read_text(encoding='utf-8-sig'))
    if bundle.get('format') != 'paperdesk-local-pdf-bundle-v1':
        raise ValueError('Unsupported bundle format')
    source_ids = set()
    for item in bundle['papers']:
        source = item['source_id']
        if not isinstance(source, str) or not source or source in source_ids:
            raise ValueError('Missing or duplicate source identity')
        source_ids.add(source)
        if not isinstance(item['title'], str) or not item['title'].strip():
            raise ValueError('A reviewed title is required')
        path = (root / item['file']).resolve(strict=True)
        if not path.is_relative_to(root):
            raise ValueError('PDF path escapes the bundle')
        with path.open('rb') as stream:
            header = stream.read(5)
            stream.seek(0)
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if header != b'%PDF-' or digest != item['sha256']:
            raise ValueError('PDF header or SHA256 mismatch')
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(path) as pdf:
            if not len(pdf) or len(pdf) != item['pages']:
                raise ValueError('PDF page count mismatch')
        item['_path'] = path
    return bundle


def import_bundle(manifest, database, backup):
    bundle = validate_bundle(manifest)
    if not database.is_file() or backup.exists():
        raise ValueError('Existing target database and new backup path required')
    report = {'inserted': [], 'skipped': [], 'reused_content': [], 'backup': str(backup)}
    now = datetime.now(timezone.utc).isoformat()
    with closing(sqlite3.connect(database, timeout=5)) as db:
        if db.execute('PRAGMA user_version').fetchone()[0] not in (1, 2):
            raise ValueError('Expected PaperDesk client schema version 1 or 2')
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Target database integrity check failed')
        # Reserve the writer before backing up through a separate read connection.
        db.execute('BEGIN IMMEDIATE')
        try:
            backup.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(backup)) as dest:
                source.backup(dest)
                if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Backup integrity check failed')
            existing = [(r[0], json.loads(r[1]), r[2]) for r in db.execute(
                "SELECT id,data,deleted FROM entities WHERE kind='paper' AND scope='personal'")]
            sources = {d.get('source_id'): i for i, d, _ in existing if d.get('source_id')}
            hashes = {d.get('file_hash'): i for i, d, deleted in existing if not deleted and d.get('file_hash')}

            def write(kind, identifier, data):
                data = {'created': now, **data}
                db.execute('INSERT INTO entities(id,kind,scope,revision,data,deleted) VALUES (?,?,?,0,?,0)',
                           (identifier, kind, 'personal', json.dumps(data, ensure_ascii=False)))
                op = {'op_id': str(uuid.uuid4()), 'entity_id': identifier, 'kind': kind,
                      'base_revision': 0, 'data': data, 'deleted': False}
                db.execute('INSERT INTO outbox(entity_id,op_id,payload) VALUES (?,?,?)',
                           (identifier, op['op_id'], json.dumps(op, ensure_ascii=False)))
                if kind == 'paper':
                    db.execute('INSERT INTO search(id,title,content) VALUES (?,?,?)',
                               (identifier, data['title'], ' '.join(data.get('authors', []))))

            for item in bundle['papers']:
                source = item['source_id']
                if source in sources:
                    report['skipped'].append({'source_id': source, 'paper_id': sources[source]})
                    continue
                digest = item['sha256']
                if digest in hashes:
                    report['reused_content'].append({'source_id': source, 'paper_id': hashes[digest]})
                    continue
                identifier = stable_id(source)
                version = stable_id(source + ':version:' + digest)
                content = item['_path'].read_bytes()
                if hashlib.sha256(content).hexdigest() != digest:
                    raise ValueError('PDF changed after validation')
                blob = db.execute('SELECT bytes FROM blobs WHERE hash=?', (digest,)).fetchone()
                if blob is not None and blob[0] is not None and hashlib.sha256(blob[0]).hexdigest() != digest:
                    raise ValueError('Existing blob content does not match its hash')
                db.execute('INSERT INTO blobs(hash,bytes) VALUES (?,?) ON CONFLICT(hash) DO UPDATE SET bytes=excluded.bytes',
                           (digest, content))
                paper = {'title': item['title'], 'filename': item['filename'], 'file_hash': digest,
                         'active_version_id': version, 'authors': item.get('authors', []),
                         'tags': [], 'status': '未读', 'source_id': source, 'pages': item['pages'],
                         'migration': {'provider': 'ReadPaper', 'method': 'reviewed-local-pdf-cache',
                                       'imported_at': now, 'source_status': 'unknown',
                                       'missing': ['folders', 'tags', 'annotations', 'notes', 'reading_progress'],
                                       'evidence': item.get('evidence', [])}}
                write('paper', identifier, paper)
                write('version', version, {'paper_id': identifier, 'filename': item['filename'],
                                          'file_hash': digest, 'source_id': source})
                sources[source] = identifier
                hashes[digest] = identifier
                report['inserted'].append({'source_id': source, 'paper_id': identifier,
                                           'title': item['title'], 'sha256': digest, 'pages': item['pages']})
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Post-import integrity check failed')
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists():
        parser.error('Choose a new report filename')
    report = import_bundle(args.manifest, args.database, args.backup)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: len(report[k]) for k in ['inserted', 'skipped', 'reused_content']}))


if __name__ == '__main__':
    main()
