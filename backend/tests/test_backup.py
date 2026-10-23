import sqlite3
import subprocess
import sys
from pathlib import Path


def test_backup_restore_preserves_db_files_and_key(tmp_path):
    root = Path(__file__).resolve().parents[2]
    source = tmp_path / 'source'; source.mkdir()
    with sqlite3.connect(source / 'paperdesk.db') as db:
        db.execute('CREATE TABLE example(value TEXT)')
        db.execute('INSERT INTO example VALUES (?)', ('durable note',))
    (source / 'objects').mkdir(); (source / 'objects' / 'sample').write_bytes(b'pdf bytes')
    (source / 'encryption.key').write_bytes(b'key fixture')
    archive = tmp_path / 'backup.zip'; restored = tmp_path / 'restored'
    script = str(root / 'scripts/backup.py')
    subprocess.run([sys.executable, script, 'backup', '--data', str(source), '--archive', str(archive)], check=True, capture_output=True)
    subprocess.run([sys.executable, script, 'restore', '--data', str(restored), '--archive', str(archive)], check=True, capture_output=True)
    with sqlite3.connect(restored / 'paperdesk.db') as db:
        assert db.execute('SELECT value FROM example').fetchone()[0] == 'durable note'
    assert (restored / 'objects/sample').read_bytes() == b'pdf bytes'
    assert (restored / 'encryption.key').read_bytes() == b'key fixture'
    assert subprocess.run([sys.executable, script, 'restore', '--data', str(restored), '--archive', str(archive)], capture_output=True).returncode != 0
