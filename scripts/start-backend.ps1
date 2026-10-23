param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $taskRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
    & '.\.venv\Scripts\python.exe' -m pip install -r backend\requirements.lock
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
}
& '.\.venv\Scripts\python.exe' -m uvicorn backend.cloud_main:app --host 127.0.0.1 --port $Port --no-access-log
