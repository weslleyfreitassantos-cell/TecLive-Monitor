[CmdletBinding()]
param(
    [switch]$Once,
    [switch]$DryRun,
    [switch]$VerboseOutput,
    [string]$ConfigPath,
    [int]$PollSeconds = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'cookie-agent.config.json'
}

$AllowedCookies = @('cookie1', 'cookie2', 'cookie3')

function ConvertTo-ProcessArgumentString {
    param([string[]]$Arguments)
    $quoted = foreach ($arg in $Arguments) {
        if ($null -eq $arg -or $arg -eq '') { '""'; continue }
        if ($arg -notmatch '[\s"]') { $arg; continue }
        '"' + (($arg -replace '\\', '\\') -replace '"', '\"') + '"'
    }
    return ($quoted -join ' ')
}

function Get-Config {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Config ausente: $Path"
    }
    try {
        return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
    } catch {
        throw "Config JSON invalido: $Path"
    }
}

function Resolve-AgentPath {
    param([string]$ProjectPath, [string]$Value)
    if ([System.IO.Path]::IsPathRooted($Value)) {
        $resolved = Resolve-Path -LiteralPath $Value -ErrorAction SilentlyContinue
        if ($resolved) { return $resolved.Path }
        return $Value
    }
    return (Join-Path $ProjectPath $Value)
}

function Assert-BaseUrl {
    param([string]$BaseUrl)
    $uri = $null
    if (-not [System.Uri]::TryCreate($BaseUrl, [System.UriKind]::Absolute, [ref]$uri)) {
        throw 'baseUrl invalida.'
    }
    if ($uri.Scheme -eq 'https') { return }
    $isLocalHttp = $uri.Scheme -eq 'http' -and $uri.Host -in @('localhost', '127.0.0.1', '::1')
    if (-not $isLocalHttp) {
        throw 'baseUrl deve ser HTTPS. HTTP e permitido apenas para localhost em testes.'
    }
}

function Protect-ConfigAcl {
    param([string]$Path)
    if ($env:OS -notmatch 'Windows') { return }
    try {
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls $Path /inheritance:r /grant:r "${user}:R" *> $null
    } catch {
        Write-Verbose "Nao foi possivel ajustar ACL do config: $($_.Exception.Message)"
    }
}

function Initialize-Log {
    param([string]$Path)
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) {
        [void](New-Item -ItemType Directory -Path $dir -Force)
    }
}

function Rotate-Log {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $maxBytes = 5MB
    if ((Get-Item -LiteralPath $Path).Length -lt $maxBytes) { return }
    for ($i = 4; $i -ge 1; $i--) {
        $src = "$Path.$i"
        $dst = "$Path.$($i + 1)"
        if (Test-Path -LiteralPath $src) {
            Move-Item -LiteralPath $src -Destination $dst -Force
        }
    }
    Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
}

function Redact-SensitiveText {
    param([string]$Text)
    $safe = [string]$Text
    $safe = $safe -replace '(Authorization:\s*Bearer\s+)[^\s]+', '$1[redacted]'
    $safe = $safe -replace '(token["":=\s]+)[^",\s]+', '$1[redacted]'
    $safe = $safe -replace '# Netscape HTTP Cookie File[\s\S]*', '[cookie content redacted]'
    return ($safe -replace '\s+', ' ').Trim()
}

function Write-AgentLog {
    param([string]$Path, [string]$Message)
    Rotate-Log -Path $Path
    $line = '{0} {1}' -f (Get-Date -Format o), (Redact-SensitiveText $Message)
    Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
    if ($VerboseOutput) { Write-Host $line }
}

function Save-AgentState {
    param([string]$Path, [hashtable]$State)
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) {
        [void](New-Item -ItemType Directory -Path $dir -Force)
    }
    $tmp = "$Path.tmp"
    $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Get-AgentState {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{}
    }
    try {
        $data = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $state = @{}
        foreach ($property in $data.PSObject.Properties) {
            $state[$property.Name] = $property.Value
        }
        return $state
    } catch {
        return @{}
    }
}

function Assert-AgentApiSuccess {
    param([pscustomobject]$Response, [string]$Action)
    if ($Response.StatusCode -lt 200 -or $Response.StatusCode -gt 299) {
        throw "$Action falhou: HTTP $($Response.StatusCode)"
    }
    if ($Response.Data -and $Response.Data.PSObject.Properties['success'] -and $Response.Data.success -ne $true) {
        throw "$Action falhou: resposta sem sucesso"
    }
}

function Assert-Prerequisites {
    param([pscustomobject]$Config, [string]$CookieSyncScript)
    foreach ($cmd in @('yt-dlp', 'ssh', 'scp')) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            throw "Comando obrigatorio ausente: $cmd"
        }
    }
    if (-not (Test-Path -LiteralPath $CookieSyncScript -PathType Leaf)) {
        throw "Cookie Sync ausente: $CookieSyncScript"
    }
    if ([string]::IsNullOrWhiteSpace([string]$Config.server.token)) {
        throw 'Token ausente no config local.'
    }
}

function Invoke-AgentApi {
    param(
        [pscustomobject]$Config,
        [string]$Method,
        [string]$Path,
        [object]$Body = $null
    )
    $base = ([string]$Config.server.baseUrl).TrimEnd('/')
    $uri = "$base$Path"
    $headers = @{
        Authorization = "Bearer $($Config.server.token)"
        'X-Agent-Id' = [string]$Config.agent.id
    }
    $jsonBody = $null
    if ($null -ne $Body) {
        $jsonBody = $Body | ConvertTo-Json -Depth 6
    }
    try {
        $params = @{
            Method = $Method
            Uri = $uri
            Headers = $headers
            TimeoutSec = 30
            UseBasicParsing = $true
        }
        if ($null -ne $jsonBody) {
            $params.ContentType = 'application/json'
            $params.Body = $jsonBody
        }
        $response = Invoke-WebRequest @params
        $content = [string]$response.Content
        $data = if ([string]::IsNullOrWhiteSpace($content)) { $null } else { $content | ConvertFrom-Json }
        return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Data = $data }
    } catch {
        $statusCode = 0
        $content = ''
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            try {
                $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
                $content = $reader.ReadToEnd()
            } catch {}
        }
        $data = $null
        if (-not [string]::IsNullOrWhiteSpace($content)) {
            try { $data = $content | ConvertFrom-Json } catch {}
        }
        return [pscustomobject]@{ StatusCode = $statusCode; Data = $data; Error = $_.Exception.Message }
    }
}

function Send-Heartbeat {
    param([pscustomobject]$Config, [string]$Status)
    Invoke-AgentApi -Config $Config -Method POST -Path '/api/cookie-agent/heartbeat' -Body @{
        hostname = $env:COMPUTERNAME
        version = [string]$Config.agent.version
        status = $Status
    }
}

function Send-PendingReport {
    param(
        [pscustomobject]$Config,
        [string]$StatePath,
        [string]$LogPath
    )
    $state = Get-AgentState -Path $StatePath
    if (-not $state.ContainsKey('pendingReport') -or -not $state.pendingReport) {
        return $true
    }

    $report = $state.pendingReport
    $jobId = [string]$report.jobId
    $type = [string]$report.type
    $body = $report.body
    if ([string]::IsNullOrWhiteSpace($jobId) -or $type -notin @('complete', 'fail')) {
        $state.Remove('pendingReport')
        Save-AgentState -Path $StatePath -State $state
        return $true
    }

    $response = Invoke-AgentApi -Config $Config -Method POST -Path "/api/cookie-agent/jobs/$jobId/$type" -Body $body
    try {
        Assert-AgentApiSuccess -Response $response -Action "reenviar $type"
        $state.Remove('pendingReport')
        Save-AgentState -Path $StatePath -State $state
        Write-AgentLog -Path $LogPath -Message "Relatorio pendente reenviado para job $jobId ($type)."
        return $true
    } catch {
        Write-AgentLog -Path $LogPath -Message "Ainda nao foi possivel reenviar relatorio pendente do job ${jobId}: $($_.Exception.Message)"
        return $false
    }
}

function Invoke-CookieSync {
    param(
        [string]$ProjectPath,
        [string]$ScriptPath,
        [string]$Cookie,
        [int]$TimeoutSeconds
    )
    if ($AllowedCookies -notcontains $Cookie) {
        throw "Cookie invalido: $Cookie"
    }
    $psExe = (Get-Process -Id $PID).Path
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath, '-Cookie', $Cookie)
    if ($VerboseOutput) { $arguments += '-VerboseOutput' }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $psExe
    $psi.Arguments = ConvertTo-ProcessArgumentString -Arguments $arguments
    $psi.WorkingDirectory = $ProjectPath
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    $started = Get-Date
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $finished = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $finished) {
        try { $process.Kill() } catch {}
        return [pscustomobject]@{ ExitCode = 124; Summary = 'timeout'; DurationMs = [int]((Get-Date) - $started).TotalMilliseconds }
    }
    $summary = Redact-SensitiveText (($stdoutTask.GetAwaiter().GetResult() + ' ' + $stderrTask.GetAwaiter().GetResult()).Trim())
    if ($summary.Length -gt 500) { $summary = $summary.Substring(0, 500) }
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Summary = $summary
        DurationMs = [int]((Get-Date) - $started).TotalMilliseconds
    }
}

function Invoke-OneCycle {
    param(
        [pscustomobject]$Config,
        [string]$ProjectPath,
        [string]$CookieSyncScript,
        [string]$LogPath,
        [string]$StatePath
    )
    [void](Send-Heartbeat -Config $Config -Status ($(if ($DryRun) { 'dry-run' } else { 'idle' })))
    if (-not (Send-PendingReport -Config $Config -StatePath $StatePath -LogPath $LogPath)) {
        return $false
    }

    $next = Invoke-AgentApi -Config $Config -Method GET -Path '/api/cookie-agent/jobs/next'
    if ($next.StatusCode -eq 204) {
        Write-AgentLog -Path $LogPath -Message 'Nenhuma tarefa pendente.'
        return $true
    }
    if ($next.StatusCode -ne 200 -or -not $next.Data.job) {
        throw "Falha ao consultar fila: HTTP $($next.StatusCode)"
    }

    $job = $next.Data.job
    $cookie = [string]$job.cookie
    if ($AllowedCookies -notcontains $cookie) {
        throw "Servidor retornou cookie invalido: $cookie"
    }

    if ($DryRun) {
        Write-AgentLog -Path $LogPath -Message "DryRun: executaria tarefa $($job.id) para $cookie sem claim/conclusao."
        return $true
    }

    $claim = Invoke-AgentApi -Config $Config -Method POST -Path "/api/cookie-agent/jobs/$($job.id)/claim"
    if ($claim.StatusCode -eq 409) {
        Write-AgentLog -Path $LogPath -Message "Tarefa $($job.id) ja foi reivindicada por outro agente."
        return $true
    }
    if ($claim.StatusCode -ne 200 -or $claim.Data.success -ne $true) {
        throw "Falha ao reivindicar tarefa: HTTP $($claim.StatusCode)"
    }

    $running = Invoke-AgentApi -Config $Config -Method POST -Path "/api/cookie-agent/jobs/$($job.id)/running"
    Assert-AgentApiSuccess -Response $running -Action 'marcar running'
    [void](Send-Heartbeat -Config $Config -Status "running:$cookie")
    Write-AgentLog -Path $LogPath -Message "Executando Cookie Sync para $cookie (job $($job.id))."

    $result = Invoke-CookieSync -ProjectPath $ProjectPath -ScriptPath $CookieSyncScript -Cookie $cookie -TimeoutSeconds ([int]$Config.server.timeoutSeconds)
    $state = @{
        lastJobId = $job.id
        cookie = $cookie
        exitCode = $result.ExitCode
        updatedAt = (Get-Date).ToString('o')
    }

    if ($result.ExitCode -eq 0) {
        $body = @{
            message = $result.Summary
            exitCode = $result.ExitCode
            durationMs = $result.DurationMs
        }
        $state.pendingReport = @{ jobId = $job.id; type = 'complete'; body = $body; updatedAt = (Get-Date).ToString('o') }
        Save-AgentState -Path $StatePath -State $state
        $complete = Invoke-AgentApi -Config $Config -Method POST -Path "/api/cookie-agent/jobs/$($job.id)/complete" -Body $body
        Assert-AgentApiSuccess -Response $complete -Action 'marcar complete'
        $state.Remove('pendingReport')
        Save-AgentState -Path $StatePath -State $state
        Write-AgentLog -Path $LogPath -Message "Job $($job.id) concluido para $cookie."
        return $true
    }

    $body = @{
        error = $result.Summary
        exitCode = $result.ExitCode
        durationMs = $result.DurationMs
    }
    $state.pendingReport = @{ jobId = $job.id; type = 'fail'; body = $body; updatedAt = (Get-Date).ToString('o') }
    Save-AgentState -Path $StatePath -State $state
    $fail = Invoke-AgentApi -Config $Config -Method POST -Path "/api/cookie-agent/jobs/$($job.id)/fail" -Body $body
    Assert-AgentApiSuccess -Response $fail -Action 'marcar fail'
    $state.Remove('pendingReport')
    Save-AgentState -Path $StatePath -State $state
    Write-AgentLog -Path $LogPath -Message "Job $($job.id) falhou para ${cookie}: $($result.Summary)"
    return $false
}

$config = Get-Config -Path $ConfigPath
Assert-BaseUrl -BaseUrl ([string]$config.server.baseUrl)
Protect-ConfigAcl -Path $ConfigPath

$projectPath = Resolve-AgentPath -ProjectPath (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) -Value ([string]$config.paths.projectPath)
$cookieSyncScript = Resolve-AgentPath -ProjectPath $projectPath -Value ([string]$config.paths.cookieSyncScript)
$logPath = Resolve-AgentPath -ProjectPath $projectPath -Value ([string]$config.paths.logPath)
$statePath = Resolve-AgentPath -ProjectPath $projectPath -Value ([string]$config.paths.statePath)
Initialize-Log -Path $logPath
Assert-Prerequisites -Config $config -CookieSyncScript $cookieSyncScript

$poll = if ($PollSeconds -gt 0) { $PollSeconds } else { [int]$config.server.pollSeconds }
if ($poll -le 0) { $poll = 30 }

$mutexName = 'Global\TecLiveCookieSyncAgent-' + ([string]$config.agent.id -replace '[^a-zA-Z0-9_.-]', '_')
$created = $false
$mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$created)
if (-not $created) {
    throw 'Outra instancia local do agente ja esta em execucao.'
}

try {
    $backoff = 30
    do {
        try {
            $ok = Invoke-OneCycle -Config $config -ProjectPath $projectPath -CookieSyncScript $cookieSyncScript -LogPath $logPath -StatePath $statePath
            $backoff = if ($ok) { 30 } else { [Math]::Min([Math]::Max($backoff * 2, 60), 600) }
        } catch {
            Write-AgentLog -Path $logPath -Message "Erro do agente: $($_.Exception.Message)"
            $backoff = [Math]::Min([Math]::Max($backoff * 2, 60), 600)
        }
        if ($Once) { break }
        Start-Sleep -Seconds ([Math]::Max($poll, $backoff))
    } while ($true)
} finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
