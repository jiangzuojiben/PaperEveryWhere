"""Apply a reviewed ReadPaper export to already imported PDFs, without network access.

Retains classification memberships, original metadata and readable annotation
notes. Original annotation coordinates remain in source_data; this script does
not guess a native overlay conversion for ReadPaper's mixed coordinate formats.
"""
import argparse
from collections import defaultdict
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid

from import_local_bundle import stable_id


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def iso(milliseconds):
    try:
        return datetime.fromtimestamp(float(milliseconds) / 1000, timezone.utc).isoformat()
    except (ValueError, TypeError, OSError):
        return None


def build_records(root, account):
    prefix = 'readpaper:' + account + ':'
    index = read(root / 'doc-index.json')['data']
    downloads = {x['pdfId']: x for x in read(root / 'download-results.json') if 'error' not in x}
    records, updates, membership = [], {}, defaultdict(list)

    def folders(items):
        for f in items:
            source = prefix + 'folder:' + f['folderId']
            identifier = stable_id(source)
            data = {'title': f['name'], 'source_id': source, 'source_sort': f.get('sort')}
            if f.get('parentId') not in (None, '0'):
                data['parent_id'] = stable_id(prefix + 'folder:' + f['parentId'])
            records.append(('folder', identifier, data))
            for doc in f.get('docInfos') or []:
                membership[doc['pdfId']].append(identifier)
            folders(f.get('childrenFolders') or [])
    folders(index['folderInfos'])
    docs = {x['pdfId']: x for x in read(root / 'documents.json')}
    if len(docs) != index['totalDocCount'] or set(docs) != set(downloads):
        raise ValueError('Document index and successful PDF inventory do not match')
    for pid, doc in docs.items():
        source = prefix + pid
        paper_id = stable_id(source)
        downloaded = downloads[pid]
        source_data = read(root / 'reading-data' / (pid + '.json'))
        if any(v.get('status') != 1 for v in source_data.values()):
            raise ValueError('Reading data export contains failed requests')
        detail = source_data['detail'].get('data') or {}
        extra = read(root / 'extra-notes' / (pid + '.json'))
        fields = {'folder_ids': list(dict.fromkeys(membership[pid])),
                  'folder_id': membership[pid][0] if membership[pid] else None,
                  'readpaper_metadata': detail,
                  'migration': {'provider': 'ReadPaper', 'method': 'authenticated-read-export',
                                'enriched': True, 'native_annotation_overlays': 'pending',
                                'source_status': 'unknown', 'source_doc_id': doc['docId'],
                                'source_pdf_id': pid}}
        authors = (detail.get('displayAuthor') or {}).get('authors')
        if authors:
            fields['authors'] = authors
        venue = (detail.get('displayVenue') or {}).get('venue')
        if venue:
            fields['journal'] = venue
        publish = (detail.get('displayPublishDate') or {}).get('publishDate', '')
        if publish and publish[:4].isdigit():
            fields['year'] = int(publish[:4])
        updates[paper_id] = {'source_id': source, 'sha256': downloaded['sha256'], 'data': fields}
        loc = source_data['location'].get('data') or {}
        location = json.loads(loc.get('location') or '{}')
        page = location.get('currentPage')
        if isinstance(page, int) and 1 <= page <= downloaded['pages']:
            records.append(('progress', stable_id(source + ':progress'), {
                'paper_id': paper_id, 'file_hash': downloaded['sha256'], 'page': page,
                'total_pages': downloaded['pages'], 'device': 'readpaper-migration',
                'date': iso(detail.get('lastReadTime')) or datetime.now(timezone.utc).isoformat(),
                'source_id': source + ':progress', 'source_data': location}))

        def note(suffix, title, content, category='excerpt', raw=None, page=None):
            identity = source + ':' + suffix
            data = {'paper_id': paper_id, 'title': title, 'content': content,
                    'category': category, 'source_id': identity, 'source_data': raw}
            if page:
                data['anchors'] = [{'page': page, 'file_hash': downloaded['sha256']}]
            records.append(('note', stable_id(identity), data))

        for i, mark in enumerate(source_data['marks'].get('data') or []):
            part = mark.get('select') or mark.get('rect') or mark.get('textBox') or {}
            page = mark.get('pageNumber')
            quote = part.get('rectStr', '')
            idea = part.get('idea', '')
            fonts = '\n'.join(x.get('content', '') for x in part.get('fonts', []))
            text = f'ReadPaper 原批注 · 第 {page} 页\n\n'
            if quote:
                text += '\n'.join('> ' + line for line in quote.splitlines()) + '\n\n'
            text += idea or fonts or '图形或手写批注：原始记录及关联资源已保存于迁移备份。'
            identity = str(part.get('uuid') or part.get('id') or i)
            note('mark:' + identity, f'第 {page} 页 · 原批注 {i + 1}', text, raw=mark, page=page)
        for i, shape in enumerate((source_data['shapes'].get('data') or {}).get('list', [])):
            page = shape.get('pageNumber')
            note('shape:' + str(shape.get('shapeId') or i), f'第 {page} 页 · 原图形 {i + 1}',
                 'ReadPaper 图形原始坐标已保存，待校准后恢复页面叠加。', raw=shape, page=page)
        summary = (extra.get('summary') or {}).get('data') or {}
        if summary.get('content'):
            note('summary', 'ReadPaper 阅读笔记', summary['content'], 'summary', summary)
        word_result = extra.get('word') or {}
        if word_result.get('status') != 1:
            raise ValueError('Vocabulary export is incomplete')
        for word in (word_result.get('data') or {}).get('words', []):
            translate = (word.get('translateInfo') or {}).get('targetContent') or []
            note('word:' + str(word['id']), str(word.get('word') or '生词'),
                 str(word.get('word') or '') + '\n\n' + '\n'.join(translate), 'vocabulary', word)
        if detail.get('remark'):
            note('remark', 'ReadPaper 文献备注', str(detail['remark']), 'idea')
    return records, updates


def apply_records(database, backup, records, updates):
    if backup.exists():
        raise ValueError('Backup already exists')
    counts = defaultdict(int)
    with closing(sqlite3.connect(database, timeout=5)) as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(backup)) as dest:
                source.backup(dest)
            now = datetime.now(timezone.utc).isoformat()

            def put(kind, identifier, data, revision=0, update=False):
                data = {'created': now, **data}
                if update:
                    db.execute('UPDATE entities SET data=? WHERE id=?', (json.dumps(data, ensure_ascii=False), identifier))
                else:
                    db.execute('INSERT INTO entities VALUES (?,?,?,?,?,0)', (identifier, kind, 'personal', revision, json.dumps(data, ensure_ascii=False)))
                op = {'op_id': str(uuid.uuid4()), 'entity_id': identifier, 'kind': kind,
                      'base_revision': revision, 'data': data, 'deleted': False}
                db.execute('INSERT INTO outbox(entity_id,op_id,payload) VALUES (?,?,?) ON CONFLICT(entity_id) DO UPDATE SET op_id=excluded.op_id,payload=excluded.payload',
                           (identifier, op['op_id'], json.dumps(op, ensure_ascii=False)))
                if kind == 'paper':
                    db.execute('DELETE FROM search WHERE id=?', (identifier,))
                    db.execute('INSERT INTO search(id,title,content) VALUES (?,?,?)',
                               (identifier, data['title'], ' '.join(data.get('authors', []))))
                counts[kind] += 1

            for kind, identifier, data in records:
                existing = db.execute('SELECT kind,scope,data FROM entities WHERE id=?', (identifier,)).fetchone()
                if existing:
                    if existing[0] != kind or existing[1] != 'personal' or json.loads(existing[2]).get('source_id') != data['source_id']:
                        raise ValueError('Existing entity identity collision')
                    continue
                put(kind, identifier, data)
            for identifier, change in updates.items():
                row = db.execute("SELECT data,revision FROM entities WHERE id=? AND kind='paper' AND scope='personal' AND deleted=0", (identifier,)).fetchone()
                if not row:
                    raise ValueError('Imported paper missing')
                data, revision = json.loads(row[0]), row[1]
                if data.get('source_id') != change['source_id'] or data.get('file_hash') != change['sha256']:
                    raise ValueError('Source or PDF identity changed')
                if (data.get('migration') or {}).get('enriched'):
                    continue
                put('paper', identifier, {**data, **change['data']}, revision, update=True)
            # Pending papers now reference these folders. Deliver folders first,
            # keeping the order of all remaining operations (including versions).
            pending = db.execute('SELECT seq,entity_id FROM outbox ORDER BY seq').fetchall()
            by_id = {identifier: seq for seq, identifier in pending}
            folder_ops = [by_id[identifier] for kind, identifier, _ in records
                          if kind == 'folder' and identifier in by_id]
            order = folder_ops + [seq for seq, _ in pending if seq not in set(folder_ops)]
            db.execute('UPDATE outbox SET seq=-seq')
            for sequence, old_sequence in enumerate(order, 1):
                db.execute('UPDATE outbox SET seq=? WHERE seq=?', (sequence, -old_sequence))
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Database integrity check failed')
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return dict(counts)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('export', type=Path)
    p.add_argument('--account', required=True)
    p.add_argument('--database', type=Path, required=True)
    p.add_argument('--backup', type=Path, required=True)
    args = p.parse_args()
    records, updates = build_records(args.export, args.account)
    result = apply_records(args.database, args.backup, records, updates)
    (args.export / 'enrichment-report.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))
