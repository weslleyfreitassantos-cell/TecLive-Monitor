[CmdletBinding()]
param(
    [switch]$Json,
    [switch]$Quiet,
    [string]$YtDlpPath,
    [string]$ConfigPath,
    [string]$AvailableVersionOverride
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
    param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 60)
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
        throw "yt-dlp nao executa: $ResolvedPath"
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

function Get-LatestVersion {
    param([string]$Override)
    if (-not [string]::IsNullOrWhiteSpace($Override)) {
        return [pscustomobject]@{ Version = $Override; Source = 'override/test' }
    }
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' -Method Get -TimeoutSec 30
    return [pscustomobject]@{ Version = [string]$release.tag_name; Source = 'GitHub releases API oficial' }
}

try {
    $config = Read-OptionalConfig -Path $ConfigPath
    $ytDlpPath = Resolve-YtDlpPath -ConfiguredPath $YtDlpPath -Config $config
} catch {
    if ($Json) { @{ ok = $false; error = 'yt-dlp ausente' } | ConvertTo-Json -Compress }
    elseif (-not $Quiet) { Write-Error $_.Exception.Message }
    exit 3
}

try {
    $installed = Get-ExecutedVersion -ResolvedPath $ytDlpPath
} catch {
    if ($Json) { @{ ok = $false; path = $ytDlpPath; error = 'yt-dlp nao executa' } | ConvertTo-Json -Compress }
    elseif (-not $Quiet) { Write-Error $_.Exception.Message }
    exit 4
}

$method = Get-InstallMethod -YtDlpPath $ytDlpPath
$availableInfo = Get-LatestVersion -Override $AvailableVersionOverride
$available = $availableInfo.Version
$updateAvailable = $installed -ne $available

if ($Json) {
    @{
        ok = $true
        path = $ytDlpPath
        installed = $installed
        versionExecuted = $installed
        available = $available
        availableVersionSource = $availableInfo.Source
        method = $method
        updateAvailable = $updateAvailable
    } | ConvertTo-Json -Compress
} elseif (-not $Quiet) {
    Write-Host "caminho=$ytDlpPath"
    Write-Host "versao_instalada=$installed"
    Write-Host "versao_executada=$installed"
    Write-Host "versao_disponivel=$available"
    Write-Host "origem_versao_disponivel=$($availableInfo.Source)"
    Write-Host "metodo=$method"
    Write-Host ("atualizacao_disponivel=" + ($(if ($updateAvailable) { 'sim' } else { 'nao' })))
}

if ($updateAvailable) { exit 10 }
exit 0
