"""Build in a fresh checkout-local artifact directory without touching a running app."""
import argparse
import json
import shutil
import subprocess
import zipfile
import os
import re
from datetime import datetime
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--flutter', required=True)
parser.add_argument('--stage', type=Path)
parser.add_argument('--package-only', action='store_true')
parser.add_argument('--no-pub', action='store_true', help='Reuse an already resolved stage dependency configuration.')
parser.add_argument('--archive', type=Path, help='Optional archive filename for a task-specific build.')
args = parser.parse_args()
root = Path.cwd()
if not (root / 'client/pubspec.yaml').is_file(): raise SystemExit('Run from the PaperDesk project root.')
stage = args.stage or root / '.data' / ('windows-stage-' + datetime.now().strftime('%Y%m%d%H%M%S'))
if not stage.resolve().is_relative_to((root / '.data').resolve()): raise SystemExit('Stage path outside workspace.')
if not args.package_only:
    shutil.copytree(root / 'client', stage, dirs_exist_ok=bool(args.stage), ignore=shutil.ignore_patterns('build', '.dart_tool', '.gradle', 'ephemeral', '.symlinks', 'Pods', 'android', 'ios', 'web'))
    result = subprocess.run([args.flutter, 'build', 'windows', '--release'] + (['--no-pub'] if args.no_pub else []), cwd=stage)
    if result.returncode: raise SystemExit(result.returncode)
bundle = stage / 'build/windows/x64/runner/Release'
if not (bundle / 'paperdesk.exe').is_file(): raise SystemExit('No compiled Windows bundle at the selected stage.')
# Ship the compiler's existing app-local runtime; no third-party installer is
# downloaded or executed by this build helper.
redist = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Microsoft Visual Studio/18/Community/VC/Redist/MSVC'
runtime_dirs = sorted(redist.glob('*/x64/Microsoft.VC*.CRT'), key=lambda p: tuple(int(v) for v in p.parents[1].name.split('.')))
if runtime_dirs:
    for dll in runtime_dirs[-1].glob('*.dll'):
        shutil.copy2(dll, bundle / dll.name)
version = re.search(r'^version:\s*([^+\s]+)', (root / 'client/pubspec.yaml').read_text(encoding='utf-8'), re.M)[1]
archive = args.archive or root / f'artifacts/PaperDesk-{version}-Windows-x64.zip'
archive.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
    for path in bundle.rglob('*'):
        if path.is_file(): output.write(path, path.relative_to(bundle))
    output.write(root / 'scripts/install-windows.ps1', 'Install.ps1')
    output.writestr('START-HERE.txt', f'PaperDesk {version}\n\nRun paperdesk.exe. Keep the DLLs and data directory together.\nInstall.ps1 optionally installs for the current user.\nThe default client uses the ReadPaper online gateway (backend.cloud_main:app).\nBusiness data and AI settings exist only for the current session; internet access is required.\nStart the gateway using scripts/start-backend.ps1 in the source package.\nSee docs/online-mode.md for connection, pairing, and validation limits.\n')
(root / 'artifacts/windows-build.json').write_text(json.dumps({'bundle': str(bundle), 'archive': str(archive), 'exit_code': 0}, indent=2), encoding='utf-8')
print('Windows portable archive updated; running application untouched.')
