[CmdletBinding()]
param(
    [ValidateSet('cookie1', 'cookie2', 'cookie3')]
    [string]$Cookie,

    [switch]$All,
    [switch]$DryRun,
    [switch]$SkipUpload,
    [switch]$VerboseOutput,
    [switch]$SkipYtDlpUpdateCheck,

    [string]$ConfigPath,
    [string]$YtDlpPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'cookie-sync.config.json'
}

$AllowedCookieKeys = @('cookie1', 'cookie2', 'cookie3')
$AllowedTargetFiles = @('cookie1.txt', 'cookie2.txt', 'cookie3.txt')

function Write-Info {
    param([string]$Message)
    Write-Host "[cookie-sync] $Message"
}

function Write-Detail {
    param([string]$Message)
    if ($VerboseOutput) {
        Write-Host "[cookie-sync] $Message"
    }
}

function Throw-UserError {
    param([string]$Message)
    throw "[cookie-sync] $Message"
}

function Get-NoSuitableUrlMessage {
    return "Nenhuma URL de teste adequada dispon$([char]0x00ED)vel"
}

function ConvertTo-ProcessArgumentString {
    param([string[]]$Arguments)
    $quoted = foreach ($arg in $Arguments) {
        if ($null -eq $arg) { '""'; continue }
        if ($arg -eq '') { '""'; continue }
        if ($arg -notmatch '[\s"]') { $arg; continue }

        $builder = [System.Text.StringBuilder]::new()
        [void]$builder.Append('"')
        $backslashes = 0
        foreach ($char in $arg.ToCharArray()) {
            if ($char -eq '\') {
                $backslashes++
            } elseif ($char -eq '"') {
                [void]$builder.Append('\' * (($backslashes * 2) + 1))
                [void]$builder.Append('"')
                $backslashes = 0
            } else {
                if ($backslashes -gt 0) {
                    [void]$builder.Append('\' * $backslashes)
                    $backslashes = 0
                }
                [void]$builder.Append($char)
            }
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append('\' * ($backslashes * 2))
        }
        [void]$builder.Append('"')
        $builder.ToString()
    }
    return ($quoted -join ' ')
}

function Get-RequiredCommand {
    param(
        [string]$Name,
        [string[]]$PreferredPaths = @()
    )

    foreach ($preferred in $PreferredPaths) {
        if ($preferred -and (Test-Path -LiteralPath $preferred -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $preferred).Path
        }
    }

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        Throw-UserError "Comando obrigatorio ausente: $Name"
    }
    return $command.Source
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
            Throw-UserError "ytDlpPath configurado nao existe: $candidate"
        }
        return (Resolve-Path -LiteralPath $candidate).Path
    }

    $command = Get-Command yt-dlp -ErrorAction Stop
    return $command.Source
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [int]$TimeoutSeconds = 60
    )

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

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $finished = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $finished) {
        try { $process.Kill() } catch {}
        return [pscustomobject]@{
            ExitCode = 124
            Stdout = ''
            Stderr = "Timeout apos $TimeoutSeconds segundos"
        }
    }

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.GetAwaiter().GetResult()
        Stderr = $stderrTask.GetAwaiter().GetResult()
    }
}

function Read-Config {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Throw-UserError "Configuracao ausente: $Path. Copie cookie-sync.config.example.json para cookie-sync.config.json."
    }

    try {
        return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
    } catch {
        Throw-UserError "Configuracao JSON invalida: $Path"
    }
}

function Get-TestUrls {
    param([pscustomobject]$Config)

    $urls = @()
    if ($Config.validation.PSObject.Properties['testUrls']) {
        foreach ($url in @($Config.validation.testUrls)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$url)) {
                $urls += ([string]$url).Trim()
            }
        }
    } elseif ($Config.validation.PSObject.Properties['testUrl'] -and -not [string]::IsNullOrWhiteSpace([string]$Config.validation.testUrl)) {
        $urls += ([string]$Config.validation.testUrl).Trim()
    }

    if ($urls.Count -eq 0) {
        Throw-UserError "Configuracao invalida: validation.testUrls ausente ou vazio."
    }

    foreach ($url in $urls) {
        $uri = $null
        if (-not [System.Uri]::TryCreate($url, [System.UriKind]::Absolute, [ref]$uri) -or ($uri.Scheme -notin @('http', 'https'))) {
            Throw-UserError "Configuracao invalida: URL de teste invalida: $url"
        }
    }

    return $urls
}

function Assert-Config {
    param([pscustomobject]$Config)

    foreach ($name in @('server', 'validation', 'cookies')) {
        if (-not $Config.PSObject.Properties[$name]) {
            Throw-UserError "Configuracao invalida: campo '$name' ausente."
        }
    }

    foreach ($name in @('host', 'port', 'user', 'projectPath', 'pm2Process')) {
        if (-not $Config.server.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$Config.server.$name)) {
            Throw-UserError "Configuracao invalida: server.$name ausente."
        }
    }

    if ([int]$Config.server.port -le 0) {
        Throw-UserError "Configuracao invalida: server.port deve ser positivo."
    }

    foreach ($name in @('minimumCookieSizeBytes', 'timeoutSeconds')) {
        if (-not $Config.validation.PSObject.Properties[$name]) {
            Throw-UserError "Configuracao invalida: validation.$name ausente."
        }
    }
    [void](Get-TestUrls -Config $Config)

    foreach ($key in $AllowedCookieKeys) {
        if (-not $Config.cookies.PSObject.Properties[$key]) {
            Throw-UserError "Configuracao invalida: cookies.$key ausente."
        }
        $entry = $Config.cookies.$key
        if ($entry.browser -ne 'firefox') {
            Throw-UserError "Configuracao invalida: cookies.$key.browser deve ser firefox."
        }
        if ($AllowedTargetFiles -notcontains $entry.targetFile) {
            Throw-UserError "Configuracao invalida: cookies.$key.targetFile inesperado."
        }
        if ([string]::IsNullOrWhiteSpace([string]$entry.profilePath)) {
            Throw-UserError "Configuracao invalida: cookies.$key.profilePath ausente."
        }
    }
}

function Get-YtDlpErrorClassification {
    param([pscustomobject]$Result)

    $text = (($Result.Stdout + "`n" + $Result.Stderr) -replace '\s+', ' ').Trim().ToLowerInvariant()
    if ($Result.ExitCode -eq 124 -or $text -match '\b(timeout|timed out)\b') {
        return 'timeout'
    }
    if ($text -match 'private video|this video is private|video is private') {
        return 'video_privado'
    }
    if ($text -match 'has been removed|removed by the uploader|copyright claim|copyright grounds|copyright infringement') {
        return 'video_removido'
    }
    if ($text -match 'live event has ended|this live event has ended|not currently live|premiere will begin|premieres in|post_live|was_live') {
        return 'url_encerrada'
    }
    if ($text -match 'video unavailable|this video is unavailable|unavailable video|not available in your country|not available|no video formats found|requested format is not available') {
        return 'video_indisponivel'
    }
    if ($text -match 'econnreset|etimedout|enotfound|eai_again|socket hang up|network is unreachable|connection reset|connection refused|temporary failure|tls connection|http error (500|502|503|504)') {
        return 'rede'
    }
    if ($text -match 'cookies are no longer valid|cookie file is invalid|invalid cookies?|use --cookies|pass cookies|login required|authentication required|requires authentication|sign in to confirm|sign in to verify|not a bot|protect our community|confirm you.?re not a bot') {
        return 'autenticacao_cookie'
    }
    return 'desconhecido'
}

function Get-YtDlpErrorSummary {
    param([pscustomobject]$Result)

    $summary = (($Result.Stderr + ' ' + $Result.Stdout) -replace '\s+', ' ').Trim()
    if ([string]::IsNullOrWhiteSpace($summary)) {
        $summary = "yt-dlp retornou codigo $($Result.ExitCode)"
    }
    if ($summary.Length -gt 240) {
        $summary = $summary.Substring(0, 240)
    }
    return $summary
}

function Test-UnsuitableUrlClassification {
    param([string]$Classification)
    return $Classification -in @('url_encerrada', 'video_privado', 'video_removido', 'video_indisponivel')
}

function Invoke-YtDlpWithTestUrls {
    param(
        [string]$YtDlpPath,
        [string[]]$BaseArguments,
        [string[]]$TestUrls,
        [int]$TimeoutSeconds,
        [string]$Purpose
    )

    $rejections = @()
    foreach ($testUrl in $TestUrls) {
        $result = Invoke-External -FilePath $YtDlpPath -Arguments (@($BaseArguments) + @($testUrl)) -TimeoutSeconds $TimeoutSeconds
        if ($result.ExitCode -eq 0) {
            return [pscustomobject]@{
                Success = $true
                UsedUrl = $testUrl
                Rejections = $rejections
            }
        }

        $classification = Get-YtDlpErrorClassification -Result $result
        $summary = Get-YtDlpErrorSummary -Result $result
        Write-Info "URL rejeitada ($classification): $testUrl"
        Write-Detail "Resumo da rejeicao: $summary"
        $rejections += [pscustomobject]@{
            Url = $testUrl
            Classification = $classification
            ExitCode = $result.ExitCode
            Summary = $summary
        }
    }

    if ($rejections.Count -gt 0 -and @($rejections | Where-Object { -not (Test-UnsuitableUrlClassification -Classification $_.Classification) }).Count -eq 0) {
        Throw-UserError (Get-NoSuitableUrlMessage)
    }

    $auth = @($rejections | Where-Object { $_.Classification -eq 'autenticacao_cookie' } | Select-Object -First 1)
    if ($auth.Count -gt 0) {
        Throw-UserError "Falha de autenticacao/cookie em $Purpose. URL: $($auth[0].Url). Erro resumido: $($auth[0].Summary)"
    }

    $network = @($rejections | Where-Object { $_.Classification -in @('rede', 'timeout') } | Select-Object -First 1)
    if ($network.Count -gt 0) {
        Throw-UserError "Falha nao relacionada a cookie em $Purpose ($($network[0].Classification)). URL: $($network[0].Url). Erro resumido: $($network[0].Summary)"
    }

    $unknown = @($rejections | Select-Object -First 1)
    Throw-UserError "Falha desconhecida em $Purpose. URL: $($unknown[0].Url). Erro resumido: $($unknown[0].Summary)"
}

function Assert-FirefoxClosed {
    $firefox = Get-Process firefox -ErrorAction SilentlyContinue
    if ($firefox) {
        Throw-UserError "Firefox esta aberto. Feche todos os perfis Firefox antes de exportar cookies. O script nao encerra o Firefox automaticamente."
    }
}

function Assert-YtDlpCookieSyntax {
    param([string]$YtDlpPath)
    $result = Invoke-External -FilePath $YtDlpPath -Arguments @('--help') -TimeoutSeconds 30
    if ($result.ExitCode -ne 0) {
        Throw-UserError "Nao foi possivel consultar a ajuda do yt-dlp."
    }
    if ($result.Stdout -notmatch '--cookies-from-browser' -or $result.Stdout -notmatch '--cookies') {
        Throw-UserError "A versao instalada do yt-dlp nao informa suporte a --cookies-from-browser e --cookies."
    }
}

function Assert-CookieFileSafe {
    param(
        [string]$CookieFile,
        [int]$MinimumSizeBytes
    )

    if (-not (Test-Path -LiteralPath $CookieFile -PathType Leaf)) {
        Throw-UserError "Arquivo de cookie nao foi criado."
    }

    $item = Get-Item -LiteralPath $CookieFile
    if (($item.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
        Throw-UserError "Arquivo de cookie invalido: nao e arquivo regular."
    }
    if ($item.Length -lt $MinimumSizeBytes) {
        Throw-UserError "Arquivo de cookie pequeno demais ($($item.Length) bytes)."
    }

    $firstLine = Get-Content -LiteralPath $CookieFile -TotalCount 1
    if ($firstLine -notmatch 'Netscape') {
        Throw-UserError "Arquivo de cookie sem cabecalho Netscape."
    }

    $hasExpectedDomain = Select-String -LiteralPath $CookieFile -Pattern 'youtube\.com|google\.com' -Quiet
    if (-not $hasExpectedDomain) {
        Throw-UserError "Arquivo de cookie sem dominio youtube.com ou google.com."
    }
}

function Test-CookieWithYtDlp {
    param(
        [string]$YtDlpPath,
        [string]$CookieFile,
        [string[]]$TestUrls,
        [int]$TimeoutSeconds
    )

    $args = @(
        '--cookies', $CookieFile,
        '--simulate',
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', '1'
    )

    return Invoke-YtDlpWithTestUrls -YtDlpPath $YtDlpPath -BaseArguments $args -TestUrls $TestUrls -TimeoutSeconds $TimeoutSeconds -Purpose 'validacao local'
}

function Export-FirefoxCookie {
    param(
        [string]$YtDlpPath,
        [string]$ProfilePath,
        [string]$OutputFile,
        [string[]]$TestUrls,
        [int]$TimeoutSeconds
    )

    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
        Throw-UserError "Perfil Firefox inexistente: $ProfilePath"
    }

    $browserSpec = "firefox:$ProfilePath"
    $args = @(
        '--cookies-from-browser', $browserSpec,
        '--cookies', $OutputFile,
        '--simulate',
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', '1'
    )

    return Invoke-YtDlpWithTestUrls -YtDlpPath $YtDlpPath -BaseArguments $args -TestUrls $TestUrls -TimeoutSeconds $TimeoutSeconds -Purpose 'exportacao do Firefox'
}

function Quote-RemoteSingle {
    param([string]$Value)
    return "'" + ($Value -replace "'", "'\''") + "'"
}

function Invoke-YtDlpUpdateCheck {
    param([string]$YtDlpPath)

    if ($SkipYtDlpUpdateCheck) {
        Write-Detail "Checagem de atualizacao do yt-dlp ignorada por parametro."
        return
    }

    $checkScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'yt-dlp-manager\check-ytdlp-update.ps1'
    if (-not (Test-Path -LiteralPath $checkScript -PathType Leaf)) {
        Write-Detail "Script de checagem de yt-dlp nao encontrado; seguindo sem bloquear."
        return
    }

    $psExe = (Get-Process -Id $PID).Path
    $result = Invoke-External -FilePath $psExe -Arguments @('-NoProfile', '-File', $checkScript, '-Quiet', '-YtDlpPath', $YtDlpPath) -TimeoutSeconds 90
    $exitCode = $result.ExitCode
    if ($exitCode -eq 10) {
        Write-Warning "Existe atualizacao do yt-dlp disponivel. A sincronizacao nao sera bloqueada; revise depois com tools\\yt-dlp-manager."
    } elseif ($exitCode -ne 0) {
        Write-Warning "Nao foi possivel checar atualizacao do yt-dlp. A sincronizacao seguira e a validacao local dira se a versao atual funciona."
    }
}

function Send-And-PromoteCookie {
    param(
        [pscustomobject]$Config,
        [string]$ScpPath,
        [string]$SshPath,
        [string]$LocalCookieFile,
        [string]$TargetFile,
        [string]$RemoteName,
        [int]$TimeoutSeconds
    )

    $server = $Config.server
    $remoteBase = "$($server.user)@$($server.host)"
    $incomingDir = "$($server.projectPath.TrimEnd('/'))/cookies/incoming"
    $remoteIncomingPath = "$incomingDir/$RemoteName"
    $remoteTarget = "${remoteBase}:$remoteIncomingPath"

    Write-Info "Enviando $TargetFile por SCP para incoming remoto."
    $scpArgs = @(
        '-P', [string]$server.port,
        $LocalCookieFile,
        $remoteTarget
    )
    $scpResult = Invoke-External -FilePath $ScpPath -Arguments $scpArgs -TimeoutSeconds $TimeoutSeconds
    if ($scpResult.ExitCode -ne 0) {
        $summary = ($scpResult.Stderr -replace '\s+', ' ').Trim()
        Throw-UserError "SCP falhou para $TargetFile. Erro resumido: $summary"
    }

    $scriptPath = "$($server.projectPath.TrimEnd('/'))/scripts/cookie-sync/validate-and-promote-cookie.sh"
    $commandParts = @()
    if (($server.PSObject.Properties['useSudo']) -and $server.useSudo -and $server.user -ne 'root') {
        $commandParts += 'sudo'
    }
    $commandParts += Quote-RemoteSingle $scriptPath
    $commandParts += Quote-RemoteSingle $TargetFile
    $commandParts += Quote-RemoteSingle $remoteIncomingPath
    $remoteCommand = $commandParts -join ' '

    Write-Info "Validando e promovendo $TargetFile no servidor."
    $sshArgs = @(
        '-p', [string]$server.port,
        $remoteBase,
        $remoteCommand
    )
    $sshResult = Invoke-External -FilePath $SshPath -Arguments $sshArgs -TimeoutSeconds ($TimeoutSeconds + 90)
    if ($sshResult.ExitCode -ne 0) {
        $summary = ($sshResult.Stderr + ' ' + $sshResult.Stdout -replace '\s+', ' ').Trim()
        if ($summary.Length -gt 400) { $summary = $summary.Substring(0, 400) }
        Throw-UserError "Promocao remota falhou para $TargetFile. Erro resumido: $summary"
    }

    if ($VerboseOutput -and -not [string]::IsNullOrWhiteSpace($sshResult.Stdout)) {
        Write-Host $sshResult.Stdout
    }
}

function Invoke-CookieSync {
    param(
        [string]$Key,
        [pscustomobject]$Config,
        [string]$YtDlpPath,
        [string]$SshPath,
        [string]$ScpPath,
        [string]$TempRoot
    )

    $entry = $Config.cookies.$Key
    $targetFile = [string]$entry.targetFile
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $random = [guid]::NewGuid().ToString('N').Substring(0, 12)
    $localCookieFile = Join-Path $TempRoot "$Key-$timestamp-$random.cookies.txt"
    $remoteName = "$timestamp-$Key-$random-$targetFile"

    Write-Info "Processando $Key -> $targetFile"
    $testUrls = Get-TestUrls -Config $Config
    $exportResult = Export-FirefoxCookie -YtDlpPath $YtDlpPath -ProfilePath ([string]$entry.profilePath) -OutputFile $localCookieFile -TestUrls $testUrls -TimeoutSeconds ([int]$Config.validation.timeoutSeconds)
    Write-Info "URL efetivamente usada na exportacao: $($exportResult.UsedUrl)"
    Assert-CookieFileSafe -CookieFile $localCookieFile -MinimumSizeBytes ([int]$Config.validation.minimumCookieSizeBytes)
    $validationResult = Test-CookieWithYtDlp -YtDlpPath $YtDlpPath -CookieFile $localCookieFile -TestUrls $testUrls -TimeoutSeconds ([int]$Config.validation.timeoutSeconds)
    Write-Info "URL efetivamente usada na validacao local: $($validationResult.UsedUrl)"

    $size = (Get-Item -LiteralPath $localCookieFile).Length
    Write-Info "$Key validado localmente ($size bytes)."

    if ($DryRun -or $SkipUpload) {
        Write-Info "${Key}: modo local ativo; nenhum upload ou SSH sera executado."
        return [pscustomobject]@{ Cookie = $Key; Target = $targetFile; Success = $true; Uploaded = $false }
    }

    Send-And-PromoteCookie -Config $Config -ScpPath $ScpPath -SshPath $SshPath -LocalCookieFile $localCookieFile -TargetFile $targetFile -RemoteName $remoteName -TimeoutSeconds ([int]$Config.validation.timeoutSeconds)
    return [pscustomobject]@{ Cookie = $Key; Target = $targetFile; Success = $true; Uploaded = $true }
}

if ($All -and $Cookie) {
    Throw-UserError "Use -All ou -Cookie, nao ambos."
}
if (-not $All -and -not $Cookie) {
    Throw-UserError "Informe -Cookie cookie1|cookie2|cookie3 ou -All."
}

$config = Read-Config -Path $ConfigPath
Assert-Config -Config $config

$ytDlpPath = Resolve-YtDlpPath -ConfiguredPath $YtDlpPath -Config $config
$sshPath = Get-RequiredCommand -Name 'ssh'
$scpPath = Get-RequiredCommand -Name 'scp'

Write-Detail "yt-dlp detectado: $ytDlpPath"
Write-Detail "ssh detectado."
Write-Detail "scp detectado."

Assert-FirefoxClosed
Assert-YtDlpCookieSyntax -YtDlpPath $ytDlpPath
Invoke-YtDlpUpdateCheck -YtDlpPath $ytDlpPath

$keysToProcess = if ($All) { $AllowedCookieKeys } else { @($Cookie) }
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cookie-sync-" + [guid]::NewGuid().ToString('N'))
$results = @()
$hadFailure = $false

try {
    [void](New-Item -ItemType Directory -Path $tempRoot -Force)
    foreach ($key in $keysToProcess) {
        try {
            $results += Invoke-CookieSync -Key $key -Config $config -YtDlpPath $ytDlpPath -SshPath $sshPath -ScpPath $scpPath -TempRoot $tempRoot
        } catch {
            $hadFailure = $true
            Write-Warning $_.Exception.Message
            $results += [pscustomobject]@{ Cookie = $key; Target = $config.cookies.$key.targetFile; Success = $false; Uploaded = $false }
            if (-not $All) { break }
        }
    }
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Info "Resumo:"
foreach ($result in $results) {
    $status = if ($result.Success) { 'OK' } else { 'FALHOU' }
    $upload = if ($result.Uploaded) { 'upload+promocao' } else { 'local' }
    Write-Host ("  {0} -> {1}: {2} ({3})" -f $result.Cookie, $result.Target, $status, $upload)
}

if ($hadFailure) {
    exit 1
}
exit 0
