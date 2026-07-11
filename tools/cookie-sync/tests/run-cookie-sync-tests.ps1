[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$script = Join-Path $root 'tools\cookie-sync\export-and-upload.ps1'
$example = Join-Path $root 'tools\cookie-sync\cookie-sync.config.example.json'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-ScriptProcess {
    param([string[]]$Arguments)
    $psExe = (Get-Process -Id $PID).Path
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $psExe -NoProfile -File $script @Arguments *> $null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
}

Assert-True (Test-Path -LiteralPath $script -PathType Leaf) 'export-and-upload.ps1 ausente'
Assert-True (Test-Path -LiteralPath $example -PathType Leaf) 'config example ausente'

$content = Get-Content -LiteralPath $script -Raw
Assert-True ($content -notmatch 'Invoke-Expression') 'Invoke-Expression nao deve ser usado'
Assert-True ($content -match 'DryRun') 'Parametro DryRun ausente'
Assert-True ($content -match 'SkipUpload') 'Parametro SkipUpload ausente'
Assert-True ($content -match 'SkipYtDlpUpdateCheck') 'Parametro SkipYtDlpUpdateCheck ausente'
Assert-True ($content -match 'Resolve-YtDlpPath') 'Resolucao de yt-dlp ausente'
Assert-True ($content -match 'Remove-Item\s+-LiteralPath\s+\$tempRoot') 'Limpeza de temporarios nao encontrada'
Assert-True ($content -match 'Get-TestUrls') 'Suporte a testUrls ausente'
Assert-True ($content -match 'Invoke-YtDlpWithTestUrls') 'Fallback ordenado de URLs ausente'
foreach ($classification in @('autenticacao_cookie', 'url_encerrada', 'video_privado', 'video_removido', 'video_indisponivel', 'rede', 'timeout', 'desconhecido')) {
    Assert-True ($content -match $classification) "Classificacao ausente: $classification"
}
Assert-True ($content -match 'Get-NoSuitableUrlMessage') 'Erro claro para URLs inadequadas ausente'
Assert-True ($content -match '0x00ED') 'Mensagem de URL inadequada deve preservar acento no PowerShell 5.1'

$config = Get-Content -LiteralPath $example -Raw | ConvertFrom-Json
Assert-True ($config.server.host -eq '177.153.62.32') 'host de exemplo inesperado'
Assert-True ($config.PSObject.Properties['ytDlpPath'] -ne $null) 'ytDlpPath deve existir no exemplo'
Assert-True ($config.validation.PSObject.Properties['testUrls'] -ne $null) 'testUrls deve existir no exemplo'
Assert-True (@($config.validation.testUrls).Count -ge 2) 'testUrls deve conter lista ordenada com fallback'
Assert-True (($config.validation.testUrls | Select-Object -First 1) -match 'youtube\.com') 'URL de teste ausente'
Assert-True ($config.cookies.cookie1.targetFile -eq 'cookie1.txt') 'cookie1 target invalido'

$missingConfig = Join-Path ([System.IO.Path]::GetTempPath()) ("missing-" + [guid]::NewGuid().ToString('N') + ".json")
$missingExit = Invoke-ScriptProcess -Arguments @('-Cookie', 'cookie1', '-DryRun', '-ConfigPath', $missingConfig, '-SkipYtDlpUpdateCheck')
Assert-True ($missingExit -ne 0) 'Configuracao ausente deveria falhar'

$invalidConfig = Join-Path ([System.IO.Path]::GetTempPath()) ("invalid-" + [guid]::NewGuid().ToString('N') + ".json")
Set-Content -LiteralPath $invalidConfig -Value '{ invalid json' -Encoding UTF8
try {
    $invalidExit = Invoke-ScriptProcess -Arguments @('-Cookie', 'cookie1', '-DryRun', '-ConfigPath', $invalidConfig, '-SkipYtDlpUpdateCheck')
    Assert-True ($invalidExit -ne 0) 'JSON invalido deveria falhar'
} finally {
    Remove-Item -LiteralPath $invalidConfig -Force -ErrorAction SilentlyContinue
}

Write-Host 'Cookie Sync PowerShell tests OK'
