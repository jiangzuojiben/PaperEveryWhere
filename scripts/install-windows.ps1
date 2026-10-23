param([switch]$DesktopShortcut)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'paperdesk.exe'))) {
    throw 'Run Install.ps1 from the extracted PaperDesk Windows package.'
}
$taskPrograms = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'
$taskDestination = [IO.Path]::GetFullPath((Join-Path $taskPrograms 'PaperDesk'))
if ([IO.Path]::GetDirectoryName($taskDestination) -ne [IO.Path]::GetFullPath($taskPrograms).TrimEnd('\')) { throw 'Unexpected install destination.' }
if ((Test-Path -LiteralPath $taskDestination) -and ((Get-Item -LiteralPath $taskDestination).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Install destination is a link. Select a normal application directory.'
}
if ([IO.Path]::GetFullPath($PSScriptRoot) -ne $taskDestination) {
    New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
    Get-ChildItem -LiteralPath $PSScriptRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $taskDestination -Recurse -Force
    }
}
$taskShell = New-Object -ComObject WScript.Shell
$taskStartMenu = [Environment]::GetFolderPath('Programs')
$taskShortcut = $taskShell.CreateShortcut((Join-Path $taskStartMenu 'PaperDesk.lnk'))
$taskShortcut.TargetPath = Join-Path $taskDestination 'paperdesk.exe'
$taskShortcut.WorkingDirectory = $taskDestination
$taskShortcut.Save()
if ($DesktopShortcut) {
    $taskShortcut = $taskShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'PaperDesk.lnk'))
    $taskShortcut.TargetPath = Join-Path $taskDestination 'paperdesk.exe'
    $taskShortcut.WorkingDirectory = $taskDestination
    $taskShortcut.Save()
}
Write-Output "PaperDesk installed for the current user: $taskDestination"
