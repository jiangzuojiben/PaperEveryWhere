"""Package current sources and verified native builds without private local data."""
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path

root = Path.cwd()
version = re.search(r'^version:\s*([^+\s]+)', (root / 'client/pubspec.yaml').read_text(encoding='utf-8'), re.M)[1]
artifacts = root / 'artifacts'
android = json.loads((artifacts / 'android-build.json').read_text(encoding='utf-8-sig'))
apk = Path(android['apk'])
if android['entrypoint'] != 'lib/main.dart' or android['version'] != version:
    raise SystemExit('Android build metadata does not match the production entrypoint/version.')
if hashlib.sha256(apk.read_bytes()).hexdigest() != android['sha256']:
    raise SystemExit('APK changed after the normal build; rebuild before packaging.')
proof = artifacts / f'android-launch-{version}.xml'
if not proof.exists() or '从一篇论文开始' not in proof.read_text(encoding='utf-8'):
    raise SystemExit('Missing normal-entrypoint cold-launch evidence for this version.')
windows = artifacts / f'PaperDesk-{version}-Windows-x64.zip'
with zipfile.ZipFile(windows) as archive:
    names = set(archive.namelist())
    if not {'paperdesk.exe', 'Install.ps1'} <= names or archive.testzip():
        raise SystemExit('Incomplete or corrupted Windows bundle.')
with zipfile.ZipFile(apk) as archive:
    architectures = sorted({name.split('/')[1] for name in archive.namelist() if name.startswith('lib/') and name.endswith('/libflutter.so')})
    if not {'arm64-v8a', 'x86_64'} <= set(architectures) or archive.testzip():
        raise SystemExit('Incomplete or corrupted Android bundle.')
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode('utf-8').split('\0')
source = artifacts / f'PaperDesk-{version}-source.zip'
files = sorted(set(p for p in paths if p))
wrapper = (root / 'client/android/gradle/wrapper/gradle-wrapper.properties').read_text(encoding='utf-8')
if 'distributionUrl=file:' in wrapper:
    raise SystemExit('An Android build is still modifying the wrapper; wait until it finishes.')
with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        path = root / name
        if not path.is_file():
            continue
        if not path.resolve().is_relative_to(root.resolve()) or name.startswith(('.data/', '.venv/', 'artifacts/', '.env')):
            raise SystemExit('Unexpected private or external source path: ' + name)
        archive.write(path, name)
manifest = {'version': version, 'android_architectures': architectures, 'source_file_count': len(files), 'files': []}
for path in [windows, apk, source]:
    manifest['files'].append({'name': path.name, 'bytes': path.stat().st_size,
                              'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
(artifacts / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'version': version, 'source_files': len(files), 'packages': [p['name'] for p in manifest['files']]}, ensure_ascii=False))
