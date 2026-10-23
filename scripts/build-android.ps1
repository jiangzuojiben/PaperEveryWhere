param([string]$Toolchain = "$env:LOCALAPPDATA\PaperDeskToolchain", [switch]$Integration, [string]$Device = '127.0.0.1:5555', [switch]$NoPub)
$ErrorActionPreference = 'Stop'
$taskPreviousLocation = Get-Location
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskFlutter = Join-Path $Toolchain 'flutter\bin\flutter.bat'
if (-not (Test-Path -LiteralPath $taskFlutter)) { $taskFlutter = 'flutter' }
if (Test-Path -LiteralPath (Join-Path $Toolchain 'java')) {
    $env:JAVA_HOME = (Get-ChildItem -LiteralPath (Join-Path $Toolchain 'java') -Directory | Select-Object -First 1).FullName
}
if (Test-Path -LiteralPath (Join-Path $Toolchain 'android')) { $env:ANDROID_HOME = Join-Path $Toolchain 'android' }
$env:GRADLE_USER_HOME = Join-Path $taskRoot '.data\gradle-home'
New-Item -ItemType Directory -Path $env:GRADLE_USER_HOME -Force | Out-Null
if ($env:HTTPS_PROXY) {
    $taskProxy = [Uri]$env:HTTPS_PROXY
    if ($taskProxy.Host -and -not $taskProxy.UserInfo) {
        @("systemProp.https.proxyHost=$($taskProxy.Host)", "systemProp.https.proxyPort=$($taskProxy.Port)",
          "systemProp.http.proxyHost=$($taskProxy.Host)", "systemProp.http.proxyPort=$($taskProxy.Port)",
          'systemProp.http.nonProxyHosts=localhost|127.*|10.*') |
            Set-Content -LiteralPath (Join-Path $env:GRADLE_USER_HOME 'gradle.properties') -Encoding ascii
    }
}
$taskWrapper = Join-Path $taskRoot 'client\android\gradle\wrapper\gradle-wrapper.properties'
$taskOriginal = [IO.File]::ReadAllText($taskWrapper)
$taskArchive = Join-Path $Toolchain 'gradle-9.3.1-bin.zip'
try {
    if (Test-Path -LiteralPath $taskArchive) {
        $taskLocalUri = ([Uri]$taskArchive).AbsoluteUri
        [IO.File]::WriteAllText($taskWrapper, ($taskOriginal -replace '(?m)^distributionUrl=.*$', "distributionUrl=$taskLocalUri"))
    }
    Set-Location -LiteralPath (Join-Path $taskRoot 'client')
    $taskPubArgs = @()
    if ($NoPub) { $taskPubArgs = @('--no-pub') }
    if ($Integration) {
        $env:ADB_SERVER_SOCKET = 'tcp:127.0.0.1:5041'
        $env:ANDROID_ADB_SERVER_PORT = '5041'
        & $taskFlutter test integration_test\offline_reader_test.dart -d $Device --reporter expanded @taskPubArgs
    } else {
        & $taskFlutter build apk --debug --target lib/main.dart --target-platform android-arm64,android-x64 @taskPubArgs
    }
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed; see output above.' }
    if (-not $Integration) {
        $taskVersionLine = Get-Content -LiteralPath (Join-Path $taskRoot 'client\pubspec.yaml') | Where-Object { $_ -match '^version:' }
        $taskVersion = (($taskVersionLine -split ':', 2)[1].Trim() -split '\+')[0]
        $taskBuiltApk = Join-Path $taskRoot 'client\build\app\outputs\flutter-apk\app-debug.apk'
        $taskArtifacts = Join-Path $taskRoot 'artifacts'
        New-Item -ItemType Directory -Path $taskArtifacts -Force | Out-Null
        $taskProductApk = Join-Path $taskArtifacts "PaperDesk-$taskVersion-Android-debug.apk"
        Copy-Item -LiteralPath $taskBuiltApk -Destination $taskProductApk -Force
        @{entrypoint='lib/main.dart'; version=$taskVersion; apk=$taskProductApk;
          sha256=(Get-FileHash -LiteralPath $taskProductApk -Algorithm SHA256).Hash.ToLower();
          completed_at=(Get-Date).ToUniversalTime().ToString('o')} |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskArtifacts 'android-build.json') -Encoding utf8
    }
} finally {
    [IO.File]::WriteAllText($taskWrapper, $taskOriginal)
    Set-Location -LiteralPath $taskPreviousLocation.Path
}
