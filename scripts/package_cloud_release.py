"""Package the online development release without running either client.

Keep this separate from the historical offline packager, which requires UI
launch evidence. This script verifies archives/build provenance, not UI flows.
"""
import hashlib
import argparse
import json
from pathlib import Path
import re
import subprocess
import zipfile
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def archive_check(path, required):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        missing = set(required) - names
        if missing:
            raise SystemExit(f'{path.name}: missing files {sorted(missing)}')
        damaged = archive.testzip()
        if damaged:
            raise SystemExit(f'{path.name}: damaged entry {damaged}')
    return {'name': path.name, 'bytes': path.stat().st_size,
            'sha256': digest(path), 'crc_checked': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--log-prefix', default='cloud05')
    args = parser.parse_args()
    version = re.search(r'^version:\s*([^+\s]+)',
                        (ROOT / 'client/pubspec.yaml').read_text(encoding='utf-8'), re.M)[1]
    windows_build = json.loads((ARTIFACTS / 'windows-build.json').read_text(encoding='utf-8-sig'))
    stage = Path(windows_build['bundle']).parents[4]
    sources = sorted((ROOT / 'client/lib').rglob('*.dart')) + [ROOT / 'client/pubspec.yaml', ROOT / 'client/pubspec.lock']
    for path in sources:
        staged = stage / path.relative_to(ROOT / 'client')
        if not staged.is_file() or digest(staged) != digest(path):
            raise SystemExit(f'Windows stage differs from source: {path.name}')
    android_build = json.loads((ARTIFACTS / 'android-build.json').read_text(encoding='utf-8-sig'))
    apk = ARTIFACTS / f'PaperDesk-{version}-Android-debug.apk'
    if (android_build['entrypoint'] != 'lib/main.dart' or android_build['version'] != version
            or android_build['sha256'] != digest(apk)):
        raise SystemExit('Android metadata does not match the normal-entrypoint APK.')
    if 'file:/' in (ROOT / 'client/android/gradle/wrapper/gradle-wrapper.properties').read_text():
        raise SystemExit('Android build wrapper has not been restored.')
    analyze = (ARTIFACTS / f'{args.log_prefix}-flutter-analyze-20261023.log').read_text(encoding='utf-8-sig')
    tests = (ARTIFACTS / f'{args.log_prefix}-flutter-tests-20261023.log').read_text(encoding='utf-8-sig')
    backend_tests = (ARTIFACTS / f'{args.log_prefix}-backend-full-tests-20261023.log').read_text(encoding='utf-8-sig')
    flutter_count = re.search(r'\+(\d+): All tests passed!', tests)
    backend_count = re.search(r'\b(\d+) passed\b', backend_tests)
    if 'No issues found!' not in analyze or not flutter_count or not backend_count or re.search(r'\b\d+ failed\b',backend_tests):
        raise SystemExit('Latest automatic checks did not pass.')
    raw = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT)
    paths = sorted(set(raw.decode('utf-8').strip('\0').split('\0')))
    allowed = {'backend', 'client', 'docs', 'research', 'scripts', '.github'}
    standalone = {'.gitattributes', '.gitignore', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'compose.yaml', 'compose.online.yaml'}
    for name in paths:
        path = Path(name)
        if path.parts[0] not in allowed and name not in standalone:
            raise SystemExit(f'Unreviewed source package path: {name}')
        if any(part in {'.data', '.venv', '.git', 'build', 'artifacts', '__pycache__', '.dart_tool', '.gradle'} for part in path.parts):
            raise SystemExit(f'Runtime/build data in source selection: {name}')
        if path.name == '.env' or path.suffix.lower() in {'.db', '.sqlite', '.sqlite3', '.apk', '.zip', '.exe'}:
            raise SystemExit(f'Private/runtime archive in source selection: {name}')
    archive_path = ARTIFACTS / f'PaperDesk-{version}-source.zip'
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in paths:
            archive.write(ROOT / name, f'PaperDesk/{name}')
    reports = [
        archive_check(ARTIFACTS / f'PaperDesk-{version}-Windows-cloud.zip',
                      {'paperdesk.exe', 'flutter_windows.dll', 'pdfium.dll', 'pdfrx_pdfium_gate.dll', 'data/app.so', 'START-HERE.txt'}),
        archive_check(apk, {'AndroidManifest.xml', 'lib/arm64-v8a/libflutter.so', 'lib/x86_64/libflutter.so'}),
        archive_check(archive_path, {'PaperDesk/backend/cloud_main.py', 'PaperDesk/backend/readpaper.py',
                                     'PaperDesk/client/lib/cloud_store.dart', 'PaperDesk/docs/openapi-online.json'}),
    ]
    report = {'version': version, 'completed_at': datetime.now(timezone.utc).isoformat(),
              'desktop_ui_used': False, 'apk_installed_or_launched': False,
              'remote_business_writes': 'dedicated synthetic PDFs and temporarily collected public test paper only', 'windows_stage_source_matched': True,
              'android_entrypoint': android_build['entrypoint'], 'source_files': len(paths),
              'source_hashes': {name: digest(ROOT / name) for name in paths},
              'checks': {'backend_full_suite': int(backend_count[1]),
                         'flutter_tests': int(flutter_count[1]), 'flutter_analyze': 'no issues'},
              'readonly_check': json.loads((ARTIFACTS / 'cloud-readonly-verification-20261023.json').read_text(encoding='utf-8')),
              'packages': reports,
              'live_checks': [json.loads((ARTIFACTS / name).read_text(encoding='utf-8')) for name in
                              ('cloud-live-basic-20261023-attempt1.json','cloud05-live-upload-20261023.json',
                               'cloud05-live-versions-20261023-attempt6.json')],
              'version_annotation_semantics': 'upstream may share note and annotation identity; coordinates require review',
              'live_report_scope_clarification': 'versions phase uses a temporarily collected public paper, despite the older report scope label',
              'pending': ['native handwriting creation',
                          'new-mode client end-to-end', 'real AI provider', 'bulk management', 'mobile hardware', 'iOS']}
    if not all(check['passed'] for check in report['live_checks']):
        raise SystemExit('Live checks have unresolved failures; preserve reports before packaging.')
    output = ARTIFACTS / f'cloud-release-verification-{version}-20261023.json'
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'manifest': output.name, 'packages': reports}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
