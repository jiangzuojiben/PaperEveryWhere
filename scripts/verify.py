"""Run checks serially and retain an honest machine-readable result."""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--flutter', default='flutter')
args = parser.parse_args()
root = Path.cwd()
if not (root / 'backend/main.py').exists(): raise SystemExit('Run from PaperDesk root.')
artifacts = root / 'artifacts'; artifacts.mkdir(exist_ok=True)
checks = [('backend', [sys.executable, '-m', 'pytest', 'backend/tests', '-q', '--tb=short'], root),
          ('analyze', [args.flutter, 'analyze', '--no-pub'], root / 'client'),
          ('client', [args.flutter, 'test', '--no-pub', '--reporter', 'expanded'], root / 'client')]
results = []
for name, command, directory in checks:
    print('Verifying ' + name, flush=True)
    start = time.monotonic()
    result = subprocess.run(command, cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (artifacts / (name + '-verification.log')).write_bytes(result.stdout)
    results.append({'name': name, 'exit_code': result.returncode, 'seconds': round(time.monotonic() - start, 2)})
    (artifacts / 'checks.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(f'{name}: {result.returncode}', flush=True)
sys.exit(1 if any(r['exit_code'] for r in results) else 0)
