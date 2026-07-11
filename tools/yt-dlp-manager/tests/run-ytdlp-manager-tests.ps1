[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$checkScript = Join-Path $root 'tools\yt-dlp-manager\check-ytdlp-update.ps1'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ytdlp-manager-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    $ytDlpMock = Join-Path $tempRoot 'yt-dlp.cmd'
    $wingetMock = Join-Path $tempRoot 'winget.cmd'

    Set-Content -LiteralPath $ytDlpMock -Encoding ASCII -Value @'
@echo off
if "%1"=="--version" (
  echo 2026.07.04
  exit /b 0
)
echo mock yt-dlp
exit /b 0
'@

    Set-Content -LiteralPath $wingetMock -Encoding ASCII -Value @'
@echo off
echo Name   Id             Version
echo yt-dlp yt-dlp.yt-dlp  2026.06.09
exit /b 0
'@

    $psExe = (Get-Process -Id $PID).Path
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $psExe
    $psi.Arguments = "-NoProfile -File `"$checkScript`" -Json -AvailableVersionOverride 2026.07.04"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['PATH'] = "$tempRoot;$($psi.EnvironmentVariables['PATH'])"

    $process = [System.Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    Assert-True ($process.ExitCode -eq 0) "check-ytdlp-update deveria retornar 0. stderr=$stderr stdout=$stdout"
    $result = $stdout | ConvertFrom-Json

    Assert-True ($result.path -eq $ytDlpMock) "Deveria usar o yt-dlp resolvido via Get-Command. path=$($result.path)"
    Assert-True ($result.installed -eq '2026.07.04') "Versao instalada deve vir do binario executado, nao do winget."
    Assert-True ($result.versionExecuted -eq '2026.07.04') "versionExecuted incorreto."
    Assert-True ($result.method -eq 'winget') "Metodo winget deveria ser detectado pelo mock."
    Assert-True ($result.availableVersionSource -eq 'override/test') "Origem de versao disponivel incorreta no teste."
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'yt-dlp manager regression tests OK'
