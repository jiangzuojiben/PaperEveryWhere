param([string]$Flutter = "$env:LOCALAPPDATA\PaperDeskToolchain\flutter\bin\flutter.bat",
      [string]$Compiler = "$env:LOCALAPPDATA\PaperDeskToolchain\InnoSetup\ISCC.exe")
$ErrorActionPreference = 'Stop'
$taskPreviousLocation = Get-Location
$taskRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path -LiteralPath $Flutter)) { $Flutter = 'flutter' }
$taskVersionLine = Get-Content -LiteralPath (Join-Path $taskRoot 'client\pubspec.yaml') | Where-Object { $_ -match '^version:' }
$taskVersion = (($taskVersionLine -split ':', 2)[1].Trim() -split '\+')[0]
try {
Set-Location -LiteralPath (Join-Path $taskRoot 'client')
& $Flutter build windows --release
if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
$taskBundle = Join-Path $taskRoot 'client\build\windows\x64\runner\Release'
$taskRuntime = Get-ChildItem -Path "$env:ProgramFiles\Microsoft Visual Studio\*\*\VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT" -Directory -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Parent.Parent.Name } -Descending | Select-Object -First 1
if ($taskRuntime) { Get-ChildItem -LiteralPath $taskRuntime.FullName -Filter '*.dll' | Copy-Item -Destination $taskBundle -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-windows.ps1') -Destination (Join-Path $taskBundle 'Install.ps1') -Force
if (Test-Path -LiteralPath $Compiler) {
    & $Compiler "/DSourceRoot=$taskRoot" "/DAppVersion=$taskVersion" (Join-Path $PSScriptRoot 'windows-installer.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer compilation failed' }
}
$taskArtifacts = Join-Path $taskRoot 'artifacts'
New-Item -ItemType Directory -Path $taskArtifacts -Force | Out-Null
Compress-Archive -Path (Join-Path $taskRoot 'client\build\windows\x64\runner\Release\*') -DestinationPath (Join-Path $taskArtifacts "PaperDesk-$taskVersion-Windows-cloud.zip") -Force
} finally { Set-Location -LiteralPath $taskPreviousLocation.Path }
