[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$ConfirmUpdate,
    [switch]$Force,
    [string]$YtDlpPath,
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-ProcessArgumentString {
    param([string[]]$Arguments)
    $quoted = foreach ($arg in $Arguments) {
        if ($null -eq $arg) { '""'; continue }
        if ($arg -eq '') { '""'; continue }
        if ($arg -notmatch '[\s"]') { $arg; continue }
        '"' + ($arg -replace '\\', '\\' -replace '"', '\"') + '"'
    }
    return ($quoted -join ' ')
}

function Invoke-External {
    param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 90)
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FilePath
    $psi.Arguments = ConvertTo-ProcessArgumentString -Arguments $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch {}
        return [pscustomobject]@{ ExitCode = 124; Stdout = ''; Stderr = 'Timeout' }
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout.GetAwaiter().GetResult(); Stderr = $stderr.GetAwaiter().GetResult() }
}

function Read-OptionalConfig {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        $Path = Join-Path (Split-Path $PSScriptRoot -Parent) 'cookie-sync\cookie-sync.config.json'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Resolve-YtDlpPath {
    param(
        [string]$ConfiguredPath,
        [pscustomobject]$Config
    )
    $candidate = $ConfiguredPath
    if ([string]::IsNullOrWhiteSpace($candidate) -and $Config -and $Config.PSObject.Properties['ytDlpPath']) {
        $candidate = [string]$Config.ytDlpPath
    }
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "ytDlpPath configurado nao existe: $candidate"
        }
        return (Resolve-Path -LiteralPath $candidate).Path
    }
    $command = Get-Command yt-dlp -ErrorAction Stop
    return $command.Source
}

function Get-ExecutedVersion {
    param([string]$ResolvedPath)
    $version = & $ResolvedPath --version
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$version)) {
        throw "yt-dlp --version falhou para $ResolvedPath"
    }
    return ([string]$version).Trim()
}

function Get-InstallMethod {
    param([string]$YtDlpPath)
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        $result = Invoke-External -FilePath $winget.Source -Arguments @('list', '--id', 'yt-dlp.yt-dlp', '--exact') -TimeoutSeconds 30
        if ($result.ExitCode -eq 0 -and $result.Stdout -match 'yt-dlp') { return 'winget' }
    }
    $pipx = Get-Command pipx -ErrorAction SilentlyContinue
    if ($pipx) {
        $result = Invoke-External -FilePath $pipx.Source -Arguments @('list') -TimeoutSeconds 30
        if ($result.ExitCode -eq 0 -and $result.Stdout -match 'yt-dlp') { return 'pipx' }
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        $result = Invoke-External -FilePath $python.Source -Arguments @('-m', 'pip', 'show', 'yt-dlp') -TimeoutSeconds 30
        if ($result.ExitCode -eq 0) { return 'pip' }
    }
    if ($YtDlpPath) { return 'executable' }
    return 'absent'
}

function Test-YtDlp {
    param([string]$YtDlpPath)
    [void](Get-ExecutedVersion -ResolvedPath $YtDlpPath)
}

function Test-CookieSyncCookie1 {
    $projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $cookieSync = Join-Path $projectRoot 'tools\cookie-sync\export-and-upload.ps1'
    if (-not (Test-Path -LiteralPath $cookieSync -PathType Leaf)) {
        throw 'Cookie Sync nao encontrado para teste com cookie1.'
    }
    $psExe = (Get-Process -Id $PID).Path
    $result = Invoke-External -FilePath $psExe -Arguments @('-NoProfile', '-File', $cookieSync, '-Cookie', 'cookie1', '-DryRun', '-SkipYtDlpUpdateCheck', '-YtDlpPath', $script:ResolvedYtDlpPath) -TimeoutSeconds 120
    if ($result.ExitCode -ne 0) {
        throw 'Teste Cookie Sync cookie1 falhou apos atualizacao.'
    }
}

$active = Get-Process yt-dlp -ErrorAction SilentlyContinue
if ($active -and -not $Force) {
    throw 'Ha processo yt-dlp ativo. O script nao encerra processos automaticamente.'
}

$config = Read-OptionalConfig -Path $ConfigPath
$ytDlpPath = Resolve-YtDlpPath -ConfiguredPath $YtDlpPath -Config $config
$script:ResolvedYtDlpPath = $ytDlpPath
$method = Get-InstallMethod -YtDlpPath $ytDlpPath
$version = Get-ExecutedVersion -ResolvedPath $ytDlpPath
Write-Host "yt-dlp=$ytDlpPath"
Write-Host "versao_executada=$version"
Write-Host "metodo=$method"

if ($DryRun) {
    Write-Host 'DryRun: nenhuma atualizacao sera executada.'
    exit 0
}

if (-not $ConfirmUpdate) {
    $answer = Read-Host 'Digite ATUALIZAR para prosseguir'
    if ($answer -ne 'ATUALIZAR') {
        throw 'Atualizacao cancelada pelo usuario.'
    }
}

Test-YtDlp -YtDlpPath $ytDlpPath

$backup = $null
switch ($method) {
    'winget' {
        $winget = (Get-Command winget -ErrorAction Stop).Source
        $result = Invoke-External -FilePath $winget -Arguments @('upgrade', '--id', 'yt-dlp.yt-dlp', '--exact') -TimeoutSeconds 600
        if ($result.ExitCode -ne 0) { throw 'Atualizacao via winget falhou.' }
    }
    'pipx' {
        $pipx = (Get-Command pipx -ErrorAction Stop).Source
        $result = Invoke-External -FilePath $pipx -Arguments @('upgrade', 'yt-dlp') -TimeoutSeconds 600
        if ($result.ExitCode -ne 0) { throw 'Atualizacao via pipx falhou.' }
    }
    'pip' {
        $python = (Get-Command python -ErrorAction Stop).Source
        $result = Invoke-External -FilePath $python -Arguments @('-m', 'pip', 'install', '-U', 'yt-dlp') -TimeoutSeconds 600
        if ($result.ExitCode -ne 0) { throw 'Atualizacao via pip falhou.' }
    }
    'executable' {
        $backup = "$ytDlpPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("yt-dlp-" + [guid]::NewGuid().ToString('N') + ".exe")
        Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $tmp -UseBasicParsing
        if (-not (Test-Path -LiteralPath $tmp -PathType Leaf) -or (Get-Item -LiteralPath $tmp).Length -lt 1000000) {
            throw 'Download do novo yt-dlp.exe incompleto.'
        }
        Test-YtDlp -YtDlpPath $tmp
        Copy-Item -LiteralPath $ytDlpPath -Destination $backup -Force
        Move-Item -LiteralPath $tmp -Destination $ytDlpPath -Force
    }
    default {
        throw "Metodo de instalacao nao suportado para atualizacao automatica: $method"
    }
}

try {
    $newPath = Resolve-YtDlpPath -ConfiguredPath $YtDlpPath -Config $config
    $script:ResolvedYtDlpPath = $newPath
    Test-YtDlp -YtDlpPath $newPath
    Test-CookieSyncCookie1
} catch {
    if ($backup -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
        Copy-Item -LiteralPath $backup -Destination $ytDlpPath -Force
        Write-Warning 'Teste falhou; backup do executavel restaurado.'
    }
    throw
}

Write-Host 'Atualizacao do yt-dlp no Windows concluida com teste local. Nenhum upload foi executado.'
