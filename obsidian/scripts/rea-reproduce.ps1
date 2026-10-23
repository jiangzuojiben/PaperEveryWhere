param(
    [string]$CoreAsar = "$env:APPDATA\obsidian\obsidian-1.13.7.asar",
    [string]$ReaPackageDirectory,
    [string]$OutputDirectory,
    [string]$SummaryOutput
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot ('research\raw\rea-scope-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a new output directory to preserve evidence.' }
if (-not (Test-Path -LiteralPath $CoreAsar -PathType Leaf)) { throw 'Pinned Obsidian core ASAR is unavailable.' }
if (-not $ReaPackageDirectory) {
    $cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
    foreach ($cache in Get-ChildItem -LiteralPath $cacheRoot -Directory) {
        $candidate = Join-Path $cache.FullName 'node_modules\rea-agents'
        $manifest = Join-Path $candidate 'package.json'
        if ((Test-Path -LiteralPath $manifest) -and ((Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version -eq '6.7.0')) { $ReaPackageDirectory = $candidate; break }
    }
}
if (-not $ReaPackageDirectory) { throw 'REA 6.7.0 must be cached or supplied with -ReaPackageDirectory. No setup or MCP registration is performed.' }
$reaManifest = Get-Content -Raw -LiteralPath (Join-Path $ReaPackageDirectory 'package.json') | ConvertFrom-Json
if ($reaManifest.version -ne '6.7.0') { throw 'This workflow requires REA 6.7.0.' }
$reaCli = Join-Path $ReaPackageDirectory 'scripts\rea.mjs'
$parserPath = Join-Path (Split-Path $ReaPackageDirectory -Parent) '@babel\parser\lib\index.js'
if (-not (Test-Path -LiteralPath $parserPath)) { throw 'The parser bundled beside REA is unavailable.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$initialHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CoreAsar).Hash.ToLowerInvariant()
if ($initialHash -ne 'a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d') { throw 'Core hash differs from the fixed research sample.' }
@{ sha256 = $initialHash; reaVersion = '6.7.0'; nodeVersion = (& node --version); sourceModified = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'identity.json') -Encoding utf8
& node $reaCli analyze-javascript-application $CoreAsar --source-path package.json --source-path main.js --max-semantic-nodes 1500 --max-semantic-nodes-per-file 1500 --max-semantic-unknowns 300 --max-semantic-unknowns-per-file 300 --analysis-timeout-ms 90000 --json > (Join-Path $OutputDirectory 'rea-host.json') 2> (Join-Path $OutputDirectory 'rea-host.stderr.txt')
if ($LASTEXITCODE -ne 0) { throw 'REA host analysis failed; retained stderr describes the failure.' }
$targetDirectory = Join-Path $OutputDirectory 'targeted'
& node (Join-Path $PSScriptRoot 'rea-extract-scope.mjs') $CoreAsar $targetDirectory $parserPath > (Join-Path $OutputDirectory 'extract.stdout.json') 2> (Join-Path $OutputDirectory 'extract.stderr.txt')
if ($LASTEXITCODE -ne 0) { throw 'Pinned scope extraction failed.' }
& node $reaCli analyze-javascript-application (Join-Path $targetDirectory 'derived-scope') --max-semantic-nodes 8000 --max-semantic-nodes-per-file 350 --max-semantic-unknowns 1500 --max-semantic-unknowns-per-file 80 --analysis-timeout-ms 30000 --json > (Join-Path $OutputDirectory 'rea-targeted.json') 2> (Join-Path $OutputDirectory 'rea-targeted.stderr.txt')
if ($LASTEXITCODE -ne 0) { throw 'REA targeted analysis failed; raw evidence is retained.' }
$finalHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CoreAsar).Hash.ToLowerInvariant()
@{ before = $initialHash; after = $finalHash; unchanged = ($initialHash -eq $finalHash) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'source-integrity.json') -Encoding utf8
if ($initialHash -ne $finalHash) { throw 'Source identity changed during analysis.' }
if ($SummaryOutput) {
    & node (Join-Path $PSScriptRoot 'rea-summarize.mjs') $OutputDirectory $SummaryOutput
    if ($LASTEXITCODE -ne 0) { throw 'Summary projection failed.' }
}
Write-Output "REA scope evidence saved to $OutputDirectory"
