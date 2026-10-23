"""Build a verified, private ReadPaper migration archive without opening any UI.

Only the explicit export allowlist is included. Original PDFs stay byte-identical;
JSON metadata is scrubbed of credential fields and URL query strings. An optional
SQLite backup is sanitized in isolation, never by modifying the live workspace.
"""
import argparse
from collections import Counter
from contextlib import closing
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import tempfile
from urllib.parse import urlsplit, urlunsplit
import zipfile

from import_local_bundle import validate_bundle


SENSITIVE_KEYS = {
    'authorization', 'cookie', 'cookies', 'setcookie', 'token', 'accesstoken',
    'refreshtoken', 'idtoken', 'password', 'passwd', 'secret', 'clientsecret',
    'apikey', 'credentials', 'credential', 'session', 'sessionid', 'userinfo',
    'signature', 'signedurl', 'headers',
}
URL_PATTERN = re.compile(r'https?://[^\s<>\"\']+', re.IGNORECASE)
DEFAULT_REPORTS = ('final-verification.json', 'enrichment-report.json',
                   'overlay-report.json', 'overlay-verification.json',
                   'annotation-coordinate-research.json', 'coordinate-text-check.json')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def clean_url(match):
    value = match.group(0)
    parts = urlsplit(value)
    # Drop userinfo as well as signed query parameters and fragments.
    host = parts.netloc.rsplit('@', 1)[-1]
    return urlunsplit((parts.scheme, host, parts.path, '', ''))


def sanitize(value):
    """Keep user data while removing credential-bearing structured fields/URLs."""
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()
                if re.sub(r'[^a-z0-9]', '', key.lower()) not in SENSITIVE_KEYS}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        # Some API responses contain JSON documents serialized inside a string.
        if value.lstrip().startswith(('{', '[')):
            try:
                return json.dumps(sanitize(json.loads(value)), ensure_ascii=False,
                                  separators=(',', ':'))
            except (ValueError, TypeError):
                pass
        return URL_PATTERN.sub(clean_url, value)
    return value


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def safe_member(name):
    """Reject Windows and POSIX traversal even on a different host platform."""
    if not isinstance(name, str) or not name or '\\' in name or ':' in name:
        raise ValueError('Unsafe archive member path')
    path = PurePosixPath(name)
    if path.is_absolute() or any(p in ('', '.', '..') for p in name.split('/')):
        raise ValueError('Unsafe archive member path')
    return name


def source_file(root, relative):
    safe_member(relative)
    candidate = (root / relative).resolve(strict=True)
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise ValueError('Source file escapes the migration directory')
    return candidate


def digest_file(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def digest_stream(stream):
    digest = hashlib.sha256()
    while block := stream.read(1024 * 1024):
        digest.update(block)
    return digest.hexdigest()


def attachment_audit(inventory, expected_doc_ids):
    seen, total, nonempty = set(), 0, []
    for record in inventory:
        doc_id = str(record['docId'])
        if doc_id in seen or record.get('status') != 1:
            raise ValueError('Duplicate or failed attachment response')
        seen.add(doc_id)
        data = record.get('data')
        if not isinstance(data, dict) or not isinstance(data.get('list'), list):
            raise ValueError('Unrecognized attachment response shape')
        count = len(data['list'])
        total += count
        if count:
            nonempty.append({'doc_id': doc_id, 'count': count})
    if seen != expected_doc_ids:
        raise ValueError('Attachment responses do not cover every document')
    return {'queried_documents': len(seen), 'attachment_count': total,
            'documents_with_attachments': nonempty,
            'coverage': 'complete' if total == 0 else 'metadata-only'}


def inspect_index(index, papers):
    data = index['data']
    expected = {str(item['pdfId']) for item in papers}
    membership = {pid: [] for pid in expected}
    membership_ids = {pid: set() for pid in expected}
    seen, folders = set(), set()

    def walk(items, parents):
        for folder in items:
            identifier = str(folder['folderId'])
            if identifier in folders:
                raise ValueError('Duplicate folder identity')
            folders.add(identifier)
            path = parents + [folder['name']]
            for doc in folder.get('docInfos') or []:
                pid = str(doc['pdfId'])
                if pid not in membership:
                    raise ValueError('Folder references a PDF absent from the manifest')
                seen.add(pid)
                label = '/'.join(path)
                if identifier not in membership_ids[pid]:
                    membership[pid].append(label)
                    membership_ids[pid].add(identifier)
            walk(folder.get('childrenFolders') or [], path)
    walk(data.get('folderInfos') or [], [])
    seen.update(str(doc['pdfId']) for doc in data.get('unclassifiedDocInfos') or [])
    if seen != expected or data['totalDocCount'] != len(expected):
        raise ValueError('Document index does not match the PDF manifest')
    return membership, {'folders': len(folders),
                        'folder_memberships': sum(map(len, membership.values()))}


def snapshot_database(database, destination, papers):
    """SQLite backup gives one consistent snapshot even if a WAL is present."""
    if not database.is_file():
        raise ValueError('Workspace database does not exist')
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(destination)) as target:
            source.backup(target)
    with closing(sqlite3.connect(destination)) as db:
        if db.execute('PRAGMA user_version').fetchone()[0] not in (1, 2):
            raise ValueError('Unsupported workspace schema')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        permitted = {'entities', 'outbox', 'blobs', 'cursors', 'conflicts', 'page_text',
                     'search', 'sqlite_sequence', 'search_data', 'search_idx',
                     'search_content', 'search_docsize', 'search_config',
                     'search_segments', 'search_segdir', 'search_stat'}
        if tables - permitted or not {'entities', 'outbox', 'blobs'} <= tables:
            raise ValueError('Unexpected workspace tables; refuse to package unknown credentials')
        for table, column in [('entities', 'data'), ('outbox', 'payload'), ('conflicts', 'payload')]:
            if table not in tables:
                continue
            rows = db.execute(f'SELECT rowid,{column} FROM {table}').fetchall()
            for rowid, raw in rows:
                clean = json.dumps(sanitize(json.loads(raw)), ensure_ascii=False)
                db.execute(f'UPDATE {table} SET {column}=? WHERE rowid=?', (clean, rowid))
        migrated = {json.loads(raw).get('source_id'): json.loads(raw) for (raw,) in db.execute(
            "SELECT data FROM entities WHERE kind='paper' AND deleted=0 AND scope='personal'")}
        for item in papers:
            paper = migrated.get(item['source_id'])
            if paper is None or paper.get('file_hash') != item['sha256']:
                raise ValueError('Workspace is missing a migrated paper or its matching PDF')
            row = db.execute('SELECT rowid FROM blobs WHERE hash=?', (item['sha256'],)).fetchone()
            if row is None:
                raise ValueError('Workspace PDF blob missing')
            with db.blobopen('blobs', 'bytes', row[0], readonly=True) as stream:
                if digest_stream(stream) != item['sha256']:
                    raise ValueError('Workspace PDF blob hash mismatch')
        counts = dict(db.execute('SELECT kind,count(*) FROM entities WHERE deleted=0 GROUP BY kind'))
        db.commit()
        # Removes old pages containing pre-sanitization JSON from this copy.
        db.execute('VACUUM')
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Workspace snapshot integrity check failed')
    return {'entities': counts, 'integrity_check': 'ok', 'pdf_blob_hashes_verified': len(papers),
            'credentials_included': False, 'authentication_preferences_included': False}


def csv_cell(value):
    value = str(value)
    return "'" + value if value.startswith(('=', '+', '-', '@', '\t', '\r')) else value


def overlay_summary(report):
    """Derive coverage from individual records, checking the report totals."""
    records = report['records']
    if not isinstance(records, list):
        raise ValueError('Overlay report records must be a list')
    statuses = dict(Counter(record['status'] for record in records))
    if report.get('source_records', len(records)) != len(records):
        raise ValueError('Overlay source record count is inconsistent')
    declared = {key: value for key, value in report.get('status_counts', statuses).items() if value}
    if declared != statuses:
        raise ValueError('Overlay status counts are inconsistent')
    reasons = Counter(record.get('reason', 'unspecified') for record in records
                      if record['status'] != 'converted')
    overlay_ids = {identifier for record in records for identifier in record.get('overlay_ids', [])}
    if report.get('native_overlays', len(overlay_ids)) != len(overlay_ids):
        raise ValueError('Native overlay count is inconsistent')
    return {'source_records': len(records), 'status_counts': statuses,
            'native_overlays': len(overlay_ids), 'preservation_reasons': dict(reasons),
            'papers_with_overlays': report.get('papers_with_overlays'),
            'annotated_pages': report.get('annotated_pages'),
            'verification_boundary': report.get('verification_boundary'),
            'text_box_basis': report.get('text_box_basis')}


def recovery_notes(summary):
    snapshot = summary.get('database') is not None
    coverage = ''
    if summary.get('overlays') is not None:
        overlays = summary['overlays']
        statuses = overlays['status_counts']
        labels = {'no_geometry': '无选区坐标的页面笔记', 'empty_drawing': '空绘图记录',
                  'empty_shape': '零尺寸图形'}
        reasons = '、'.join(f'{labels.get(reason, reason)} {count} 条'
                           for reason, count in overlays['preservation_reasons'].items())
        coverage = (f"\n批注源记录共 {overlays['source_records']} 条，已转换 {statuses.get('converted', 0)} 条，"
                    f"生成 {overlays['native_overlays']} 个页面叠加；"
                    f"保留但未生成叠加 {statuses.get('preserved_without_overlay', 0)} 条。\n")
        if reasons:
            coverage += f'保留原因：{reasons}。原记录及可读笔记仍保存在包中。\n'
    previews = (f"\n独立批注页预览共 {summary['preview_pdf_count']} 份 PDF、"
                f"{summary['preview_pages']} 页。\n")
    database_counts = ''
    if snapshot:
        entities = summary['database']['entities']
        database_counts = (f"\n数据库快照实际包含：文献 {entities.get('paper', 0)} 篇、"
                           f"笔记 {entities.get('note', 0)} 条、进度 {entities.get('progress', 0)} 条、"
                           f"页面叠加 {entities.get('annotation', 0)} 个。\n")
    return f'''# ReadPaper 完整迁移包

生成时间：{summary['created_at']}

包含 {summary['pdf_count']} 份原始 PDF、{summary['pages']} 页、{summary['folders']} 个文件夹、
{summary['folder_memberships']} 条分类关联、{summary['asset_count']} 个批注资源。
附件接口已核对 {summary['attachments']['queried_documents']} 篇，实际附件列表共
{summary['attachments']['attachment_count']} 项。原始文献与页面叠加数据分别保存。
{coverage}{previews}{database_counts}

## 内容与完整性

- `complete-manifest.json`：可重新导入的 PDF 清单；`文献索引.csv` 可按标题和分类查找。
- `all-pdfs/`：原始字节，未把批注写入原 PDF。
- `reading-data/`、`extra-notes/`、`doc-index.json`：原批注、笔记、进度和文件夹结构。
- `note-assets/` 和 `note-assets.json`：离线批注资源及源地址映射。
- `native-overlays.json`：已转换的本地叠加格式（如已生成）；`annotation-previews/` 与
  `previews-index.json`：独立批注页 PDF 预览及原页码映射（如已生成）。原 PDF 不受影响。
- `reports/`：原始验证结果及页面叠加转换报告（以实际文件为准）。
- `checksums.json`：除自身外每个归档文件的 SHA256、字节数；打包时已重新读取 ZIP 验证。
- `package-summary.json`：本次实际统计及限制。仅有报告不代表桌面或移动端界面验收完成。

JSON 删除登录凭据字段及 URL 查询参数；原始 PDF 保持不变。未包含 ReadPaper 程序代码、
登录 Cookie、认证设置或历史备份。请将此包视为包含个人文献和笔记的私密资料。

## 恢复 PaperDesk 本地工作区

{'本包包含 `workspace/paperdesk_offline.db` 一致性快照，含迁移时的文献、批注和笔记。' if snapshot else '本包未包含工作区快照；使用下方清单导入方式。'}

1. 解压到新目录，核对 `checksums.json`；保留 ZIP 作为只读备份。
2. 退出 PaperDesk，确保进程已结束。先把现有应用数据目录整体复制到新备份目录，
   包括数据库以及可能存在的 `-wal`、`-shm` 文件；不要在运行中的工作区直接替换数据库。
3. Windows 默认工作区位于 `%APPDATA%\\org.paperdesk\\paperdesk\\paperdesk_offline.db`。
   {'将快照复制为该文件。原数据库及同名 -wal/-shm 必须先移到备份目录，避免旧 WAL 污染恢复结果。' if snapshot else '先安装并启动一次 PaperDesk 建立空工作区，再退出，然后按清单导入。'}
4. 打开 PaperDesk 的“本地工作区”核对数量与批注。本包不包含登录状态；登录后的账号库与
   本地库独立，不能通过直接更名数据库来绕过账号归属或合并同步数据。
5. 新设备应让 PaperDesk 自行生成新的 device_id；不要复制原设备的偏好设置或凭据。
   恢复快照保留待同步操作标识，不能据此宣称已完成跨端同步。需要登录云端后另行迁移验证。

## 按清单重新导入（保留目标工作区现有资料）

`tools/import_local_bundle.py` 只导入 PDF 与基本元数据，提供预校验、自动备份和重复导入去重。
需要 Python 3.12 和 `pypdfium2`。在 PaperDesk 已退出时执行（路径均换成实际路径）：

```powershell
python tools/import_local_bundle.py complete-manifest.json --database C:\\目标\\paperdesk_offline.db --backup C:\\备份\\before.db --report C:\\备份\\import-report.json
python tools/enrich_readpaper_migration.py . --account {summary['source_account']} --database C:\\目标\\paperdesk_offline.db --backup C:\\备份\\before-enrichment.db
python tools/convert_readpaper_annotations.py . --account {summary['source_account']}
python tools/convert_readpaper_annotations.py . --account {summary['source_account']} --apply --database C:\\目标\\paperdesk_offline.db --backup C:\\备份\\before-overlays.db
```

分类、原批注等完整恢复优先使用工作区快照。以上顺序为先导入 PDF、再恢复分类/笔记/进度、
再审查转换报告、最后应用页面叠加；需要确认 `tools/` 中存在对应工具。每个备份路径都必须
是新文件，重复执行保留目标已有内容。不要把只完成 PDF 清单导入误认为笔记与叠加已全部恢复。
包内未包含 Python 运行时。使用 `python tools/package_readpaper_migration.py --verify 原迁移包.zip`
可离线复核 ZIP 所有成员的路径、字节数及 SHA256。
'''


def verify_archive(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate ZIP member')
        for name in names:
            safe_member(name)
        inventory = json.loads(archive.read('checksums.json'))
        if set(inventory) != set(names) - {'checksums.json'}:
            raise ValueError('ZIP checksum inventory mismatch')
        for name, expected in inventory.items():
            if archive.getinfo(name).file_size != expected['bytes']:
                raise ValueError('ZIP member size mismatch')
            with archive.open(name) as stream:
                if digest_stream(stream) != expected['sha256']:
                    raise ValueError('ZIP member SHA256 mismatch')
    return len(names)


def package_migration(root, output, database=None, reports=(), include_previews=True):
    root = root.resolve(strict=True)
    output = output.resolve()
    if output.exists():
        raise ValueError('Output already exists; choose a new archive name')
    bundle = validate_bundle(root / 'complete-manifest.json')
    papers = bundle['papers']
    if not papers:
        raise ValueError('Empty migration bundle')
    for item in papers:
        for key in ('pdfId', 'docId'):
            if not re.fullmatch(r'[A-Za-z0-9_-]+', str(item[key])):
                raise ValueError('Unsafe document identity')
    if len({item['pdfId'] for item in papers}) != len(papers):
        raise ValueError('Duplicate PDF identity')
    index = read_json(source_file(root, 'doc-index.json'))
    membership, counts = inspect_index(index, papers)
    attachment_inventory = read_json(source_file(root, 'attachment-inventory.json'))
    audit = attachment_audit(attachment_inventory, {str(p['docId']) for p in papers})
    if audit['attachment_count']:
        raise ValueError('Attachments exist but no verified attachment payload exporter is available')
    assets = read_json(source_file(root, 'note-assets.json'))
    memory, files, expected_hashes = {}, {}, {}

    def add_json(name, data):
        memory[safe_member(name)] = json_bytes(sanitize(data))

    add_json('doc-index.json', index)
    add_json('attachment-inventory.json', attachment_inventory)
    documents = read_json(source_file(root, 'documents.json'))
    downloads = read_json(source_file(root, 'download-results.json'))
    if {str(d['pdfId']) for d in documents} != {str(p['pdfId']) for p in papers}:
        raise ValueError('Document inventory differs from the PDF manifest')
    if len(downloads) != len(papers) or any('error' in d for d in downloads):
        raise ValueError('PDF download inventory is incomplete')
    downloaded = {str(d['pdfId']): d for d in downloads}
    if len(downloaded) != len(papers) or any(
            str(p['pdfId']) not in downloaded or downloaded[str(p['pdfId'])]['sha256'] != p['sha256']
            for p in papers):
        raise ValueError('PDF download identities or hashes differ from the manifest')
    add_json('documents.json', documents)
    add_json('download-results.json', downloads)
    for item in papers:
        pid, doc_id = str(item['pdfId']), str(item['docId'])
        for relative in (f'reading-data/{pid}.json', f'extra-notes/{pid}.json',
                         f'attachments/{doc_id}.json'):
            data = read_json(source_file(root, relative))
            responses = data.values() if relative.startswith(('reading-data/', 'extra-notes/')) else [data]
            if any(not isinstance(r, dict) or r.get('status') != 1 for r in responses):
                raise ValueError('User data export includes an unsuccessful response')
            add_json(relative, data)
        metadata = f'document-metadata/{pid}.json'
        if (root / metadata).is_file():
            add_json(metadata, read_json(source_file(root, metadata)))
        target = f'all-pdfs/{pid}.pdf'
        files[target] = item.pop('_path')
        expected_hashes[target] = item['sha256']
        item['file'] = target
        item['bytes'] = files[target].stat().st_size
    cleaned_assets = []
    for asset in assets:
        if 'error' in asset:
            raise ValueError('Annotation asset export contains a failed download')
        path = source_file(root, asset['file'])
        if digest_file(path) != asset['sha256'] or path.stat().st_size != asset['bytes']:
            raise ValueError('Annotation asset hash or size mismatch')
        member = safe_member(asset['file'])
        if not member.startswith('note-assets/') or member in files or member in memory:
            raise ValueError('Unsafe or duplicate annotation asset member')
        record = dict(asset)
        if path.suffix.lower() == '.json':
            payload = json_bytes(sanitize(read_json(path)))
            memory[member] = payload
            record.update(source_sha256=asset['sha256'], sha256=hashlib.sha256(payload).hexdigest(), bytes=len(payload))
        else:
            files[member] = path
            expected_hashes[member] = asset['sha256']
        cleaned_assets.append(record)
    add_json('note-assets.json', cleaned_assets)
    add_json('complete-manifest.json', bundle)
    if (root / 'native-overlays.json').is_file():
        add_json('native-overlays.json', read_json(source_file(root, 'native-overlays.json')))
    preview_count, preview_pages = 0, 0
    if include_previews and ((root / 'previews-index.json').exists() or (root / 'annotation-previews').exists()):
        preview_index = read_json(source_file(root, 'previews-index.json'))
        listed = set()
        for preview in preview_index['previews']:
            member = safe_member(preview['file'])
            if not member.startswith('annotation-previews/') or not member.endswith('.pdf') or member in listed:
                raise ValueError('Invalid or duplicate annotation preview path')
            listed.add(member)
            path = source_file(root, member)
            with path.open('rb') as stream:
                if stream.read(5) != b'%PDF-':
                    raise ValueError('Annotation preview is not a PDF')
            if digest_file(path) != preview['sha256']:
                raise ValueError('Annotation preview SHA256 mismatch')
            import pypdfium2 as pdfium
            with pdfium.PdfDocument(path) as doc:
                if len(doc) != preview['pages'] or len(doc) < 1:
                    raise ValueError('Annotation preview page count mismatch')
            files[member] = path
            expected_hashes[member] = preview['sha256']
            preview_pages += preview['pages']
        actual = {p.relative_to(root).as_posix() for p in (root / 'annotation-previews').rglob('*') if p.is_file()}
        if actual != listed:
            raise ValueError('Annotation preview inventory does not match its directory')
        add_json('previews-index.json', preview_index)
        preview_count = len(listed)
    if (root / 'all-88.bib').is_file():
        memory['references.bib'] = sanitize((root / 'all-88.bib').read_text(encoding='utf-8-sig')).encode('utf-8')
    overlays = None
    for name in dict.fromkeys((*DEFAULT_REPORTS, *reports)):
        safe_member(name)
        if '/' in name or not name.endswith('.json'):
            raise ValueError('Reports must be top-level JSON filenames')
        if (root / name).is_file():
            report = read_json(source_file(root, name))
            add_json('reports/' + name, report)
            if name == 'overlay-report.json':
                overlays = overlay_summary(report)
        elif name in reports:
            raise ValueError('Requested report is missing')
    scripts = Path(__file__).resolve().parent
    for name in ('import_local_bundle.py', 'enrich_readpaper_migration.py',
                 'convert_readpaper_annotations.py', 'package_readpaper_migration.py'):
        if (scripts / name).is_file():
            files['tools/' + name] = scripts / name
    csv_stream = io.StringIO(newline='')
    writer = csv.writer(csv_stream)
    writer.writerow(['标题', '文件', '页数', '字节数', 'SHA256', '分类', '来源标识', 'ReadPaper文献ID', 'ReadPaperPDFID'])
    for item in papers:
        writer.writerow([csv_cell(v) for v in (item['title'], item['file'], item['pages'], item['bytes'],
                         item['sha256'], ' | '.join(membership[str(item['pdfId'])]), item['source_id'], item['docId'], item['pdfId'])])
    memory['文献索引.csv'] = csv_stream.getvalue().encode('utf-8-sig')
    output.parent.mkdir(parents=True, exist_ok=True)
    needed = sum(p.stat().st_size for p in files.values()) + sum(map(len, memory.values())) + 32 * 1024 * 1024
    if database is not None:
        needed += database.stat().st_size * 3
    if shutil.disk_usage(output.parent).free < needed:
        raise ValueError('Insufficient disk space for temporary snapshot and archive')
    summary = {'format': 'paperdesk-readpaper-complete-migration-v1',
               'created_at': datetime.now(timezone.utc).isoformat(), 'pdf_count': len(papers),
               'pdf_bytes': sum(p['bytes'] for p in papers), 'pages': sum(p['pages'] for p in papers),
               **counts, 'asset_count': len(assets), 'attachments': audit, 'database': None,
               'preview_pdf_count': preview_count,
               'preview_pages': preview_pages, 'overlays': overlays,
               'source_account': papers[0]['source_id'].split(':')[1],
               'limitations': ['No desktop or mobile UI verification is implied by this archive.',
                               'Read overlay reports for conversion coverage and unresolved source records.',
                               'Authentication and device preferences are excluded.']}
    with tempfile.TemporaryDirectory(prefix='paperdesk-package-', dir=output.parent) as temporary:
        temporary = Path(temporary)
        if database is not None:
            snapshot = temporary / 'paperdesk_offline.db'
            summary['database'] = snapshot_database(database, snapshot, papers)
            files['workspace/paperdesk_offline.db'] = snapshot
        add_json('package-summary.json', summary)
        memory['恢复说明.md'] = recovery_notes(summary).encode('utf-8')
        inventory = {}
        staged = temporary / 'verified.zip'
        with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for name, payload in sorted(memory.items()):
                safe_member(name)
                archive.writestr(name, payload)
                inventory[name] = {'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload)}
            for name, path in sorted(files.items()):
                safe_member(name)
                if name in inventory:
                    raise ValueError('Duplicate output member')
                expected = digest_file(path)
                if name in expected_hashes and expected != expected_hashes[name]:
                    raise ValueError('Source content changed after validation')
                archive.write(path, name)
                inventory[name] = {'sha256': expected, 'bytes': path.stat().st_size}
            archive.writestr('checksums.json', json_bytes(inventory))
        summary['archive_members_verified'] = verify_archive(staged)
        summary['archive_sha256'] = digest_file(staged)
        summary['archive_bytes'] = staged.stat().st_size
        # Avoid silently replacing a file created by another process during export.
        if output.exists():
            raise ValueError('Output appeared during packaging')
        staged.rename(output)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, nargs='?')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--database', type=Path)
    parser.add_argument('--include-report', action='append', default=[])
    parser.add_argument('--no-previews', action='store_true')
    parser.add_argument('--verify', type=Path, help='Verify an existing archive without extracting or modifying it')
    args = parser.parse_args()
    if args.verify:
        if args.source or args.output or args.database or args.include_report or args.no_previews:
            parser.error('--verify cannot be combined with packaging options')
        print(json.dumps({'members_verified': verify_archive(args.verify), 'sha256': digest_file(args.verify)}))
        return
    if not args.source:
        parser.error('source is required unless --verify is used')
    output = args.output or Path(__file__).resolve().parents[1] / 'artifacts' / (
        'ReadPaper-完整迁移-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.zip')
    report = package_migration(args.source, output, args.database, args.include_report, not args.no_previews)
    print(json.dumps({'output': str(output), **report}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
