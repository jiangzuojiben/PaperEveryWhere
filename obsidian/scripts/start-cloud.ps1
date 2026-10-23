[CmdletBinding()]
param(
    [string]$Python,
    [string]$BindAddress = '127.0.0.1',
    [ValidateRange(1, 65535)][int]$Port = 8766,
    [string]$DatabasePath,
    [switch]$Setup,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$requirementsFile = Join-Path $projectDirectory 'cloud\requirements.txt'
$localEnvironment = Join-Path $projectDirectory '.venv'
$localPython = Join-Path $localEnvironment 'Scripts\python.exe'
$parentPython = Join-Path (Split-Path -Parent $projectDirectory) '.venv\Scripts\python.exe'

function Test-CloudRuntime([string]$Executable) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    & $Executable -c "import importlib.util,sys; sys.exit(0 if sys.version_info >= (3,11) and all(importlib.util.find_spec(n) is not None for n in ('fastapi','uvicorn','markdown_it','bleach')) else 2)"
    return $LASTEXITCODE -eq 0
}

$selectedPython = $null
if ($Python) {
    $selectedPython = [System.IO.Path]::GetFullPath($Python)
    if (-not (Test-Path -LiteralPath $selectedPython -PathType Leaf)) { throw "Python not found: $selectedPython" }
} else {
    foreach ($candidate in @($parentPython, $localPython)) {
        if (Test-CloudRuntime $candidate) { $selectedPython = $candidate; break }
    }
}

if (-not $selectedPython) {
    if (-not $Setup) {
        throw 'No prepared Python environment was found. Install Python 3.12, then run .\scripts\start-cloud.ps1 -Setup. A healthy parent .venv is reused first; otherwise setup creates this project''s .venv.'
    }
    if (-not (Test-Path -LiteralPath $localPython -PathType Leaf)) {
        $launcher = Get-Command 'py' -ErrorAction SilentlyContinue
        if ($launcher) {
            & $launcher.Source -3 -m venv $localEnvironment
        } else {
            $systemPython = Get-Command 'python' -ErrorAction SilentlyContinue
            if (-not $systemPython) { throw 'Install Python 3.12 with its Python launcher, or provide -Python with an existing virtual environment interpreter.' }
            & $systemPython.Source -m venv $localEnvironment
        }
        if ($LASTEXITCODE -ne 0) { throw 'Creating the local Python virtual environment failed.' }
    }
    $selectedPython = $localPython
}

if (-not (Test-CloudRuntime $selectedPython)) {
    if (-not $Setup) { throw 'The selected Python environment is missing cloud dependencies. Run with -Setup to install cloud/requirements.txt.' }
    & $selectedPython -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 2)"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or later is required; Python 3.12 is recommended.' }
    & $selectedPython -m pip install -r $requirementsFile
    if ($LASTEXITCODE -ne 0) { throw 'Installing cloud dependencies failed. Review the pip output above and retry.' }
    if (-not (Test-CloudRuntime $selectedPython)) { throw 'Cloud dependency verification failed.' }
}

if ($DatabasePath) { $env:VAULTDESK_DB = [System.IO.Path]::GetFullPath($DatabasePath) }
$effectiveDatabase = if ($env:VAULTDESK_DB) { $env:VAULTDESK_DB } else { Join-Path $projectDirectory 'cloud\data\vaultdesk.sqlite3' }
if ($CheckOnly) {
    [pscustomobject]@{ python = $selectedPython; baseUrl = "http://${BindAddress}:$Port"; database = $effectiveDatabase; project = $projectDirectory } | ConvertTo-Json
    exit 0
}

Write-Host "VaultDesk cloud: http://${BindAddress}:$Port"
Write-Host "Database: $effectiveDatabase"
Write-Host 'Stop this foreground service with Ctrl+C.'
Push-Location -LiteralPath $projectDirectory
try {
    & $selectedPython -m uvicorn cloud.app:app --host $BindAddress --port $Port --no-proxy-headers
    $serviceExitCode = $LASTEXITCODE
} finally { Pop-Location }
exit $serviceExitCode
