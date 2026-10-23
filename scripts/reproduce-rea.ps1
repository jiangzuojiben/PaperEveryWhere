param([string]$Sample = 'C:\Program Files (x86)\ReadPaper\resources\app.asar',
      [string]$Output = (Join-Path (Split-Path $PSScriptRoot -Parent) ('research\run-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))))
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Output) { throw 'Choose a new output directory to preserve previous Evidence.' }
if (-not (Test-Path -LiteralPath $Sample -PathType Leaf)) { throw 'ReadPaper sample not found.' }
New-Item -ItemType Directory -Path $Output | Out-Null
Get-FileHash -Algorithm SHA256 -LiteralPath $Sample | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Output 'sample.json') -Encoding utf8
& npx --yes rea-agents@6.7.0 analyze-javascript-application $Sample --source-path package.json --source-path dist/renderer/index.html --source-path dist/renderer/assets/Error.1bb43cd1.js --max-semantic-nodes 600 --max-semantic-nodes-per-file 300 --max-semantic-unknowns-per-file 50 --analysis-timeout-ms 45000 --format json 1> (Join-Path $Output 'evidence.json') 2> (Join-Path $Output 'progress.jsonl')
if ($LASTEXITCODE -ne 0) { throw 'REA returned a failure or partial result; inspect preserved evidence and progress.' }
