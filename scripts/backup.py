"""Consistent local SQLite + objects + encryption key backup/restore.

Docker: stop writers first and use the separate deployment instructions.
Restore only into an EMPTY directory; never overwrites an existing library.
"""
import argparse
import json
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['backup', 'restore'])
parser.add_argument('--data', type=Path, default=Path('.data'))
parser.add_argument('--archive', type=Path, required=True)
args = parser.parse_args()
if args.action == 'backup':
    with tempfile.TemporaryDirectory() as temporary:
        target = Path(temporary)
        with closing(sqlite3.connect(args.data / 'paperdesk.db')) as source, closing(sqlite3.connect(target / 'paperdesk.db')) as destination:
            source.backup(destination)
        for name in ('objects', 'encryption.key'):
            path = args.data / name
            if path.is_dir(): shutil.copytree(path, target / name)
            elif path.is_file(): shutil.copy2(path, target / name)
        (target / 'backup.json').write_text(json.dumps({'version': 1, 'created': datetime.now(timezone.utc).isoformat()}))
        args.archive.parent.mkdir(parents=True, exist_ok=True)
        if args.archive.exists(): raise SystemExit('Archive already exists; preserving it.')
        shutil.make_archive(str(args.archive.with_suffix('')), 'zip', target)
else:
    if args.data.exists() and any(args.data.iterdir()):
        raise SystemExit('Restore destination must be empty.')
    import zipfile
    with zipfile.ZipFile(args.archive) as archive:
        root = args.data.resolve()
        for member in archive.infolist():
            resolved = (root / member.filename).resolve()
            if not resolved.is_relative_to(root): raise SystemExit('Unsafe archive path.')
        archive.extractall(root)
    with sqlite3.connect(args.data / 'paperdesk.db') as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise SystemExit('Restored database integrity check failed.')
print(args.action + ' completed')
