"""Read-only inventory of explicitly selected PDF/export directories.

Does not read browser cookies, login tokens, encrypted stores or unrelated files.
"""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.directory.resolve(strict=True)
if not root.is_dir(): raise SystemExit('Select a directory.')
papers, failures = [], []
for path in root.rglob('*.pdf'):
    if path.is_symlink() or not path.resolve().is_relative_to(root): continue
    digest = hashlib.sha256()
    try:
        with path.open('rb') as stream:
            if stream.read(5) != b'%PDF-':
                failures.append({'file': str(path.relative_to(root)), 'reason': 'invalid PDF header'}); continue
            stream.seek(0)
            while chunk := stream.read(1024 * 1024): digest.update(chunk)
        papers.append({'source_id': 'sha256:' + digest.hexdigest(), 'title': path.stem,
                       'folder': str(path.parent.relative_to(root)).replace('\\', '/') if path.parent != root else '',
                       'filename': str(path.relative_to(root)), 'file_hash': digest.hexdigest()})
    except OSError as exc: failures.append({'file': str(path.relative_to(root)), 'reason': type(exc).__name__})
if args.output.exists(): raise SystemExit('Output exists; choose another filename.')
args.output.write_text(json.dumps({'format': 'paperdesk-migration-v1', 'papers': papers, 'failures': failures}, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Preview written: {len(papers)} PDFs, {len(failures)} failures. No source files changed.')
