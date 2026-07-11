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
. (Join-Path $PSScriptRoot 'cookie-agent-common.ps1')

$script:AgentStartedAt = Get-Date
$script:AgentExitCode = 0
$script:AgentExitReason = 'unknown'
$script:AgentExitSummary = 'inicializando'
$script:ShutdownRequested = $false
$script:RuntimeStatePath = Get-CookieAgentRuntimeStatePath -ScriptRoot $PSScriptRoot
$script:LifecycleLogPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'logs\cookie-agent\agent.log'
$script:HasRuntimeOwnership = $false

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
    $safe = $safe -replace '(Bearer\s+)[A-Za-z0-9+/_=.-]{12,}', '$1[redacted]'
    $safe = $safe -replace '(token["":=\s]+)[^",\s]+', '$1[redacted]'
    $safe = $safe -replace '# Netscape HTTP Cookie File[\s\S]*', '[cookie content redacted]'
    $safe = $safe -replace '[A-Za-z]:\\[^\s"'']+', '[path]'
    $safe = $safe -replace '/(?:var|home|root|etc|opt)/[^\s"'']+', '[path]'
    return ($safe -replace '\s+', ' ').Trim()
}

function Write-AgentLog {
    param([string]$Path, [string]$Message)
    Rotate-Log -Path $Path
    $line = '{0} {1}' -f (Get-Date -Format o), (Redact-SensitiveText $Message)
    Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
    if ($VerboseOutput) { Write-Host $line }
}

function Write-LifecycleLog {
    param([string]$Message)
    try {
        Write-AgentLog -Path $script:LifecycleLogPath -Message $Message
    } catch {
        try {
            Write-CookieAgentLog -Path $script:LifecycleLogPath -Message $Message -VerboseOutput:$VerboseOutput
        } catch {}
    }
}

function Update-RuntimeState {
    param([hashtable]$Patch)
    if (-not $script:HasRuntimeOwnership -and -not $Patch.ContainsKey('lastExitAt')) {
        return
    }
    try {
        [void](Update-CookieAgentRuntimeState -Path $script:RuntimeStatePath -Patch $Patch)
    } catch {
        Write-LifecycleLog "Falha ao gravar runtime state: $($_.Exception.Message)"
    }
}

function Register-AgentLifecycleHandlers {
    try {
        $script:CancelHandler = [System.ConsoleCancelEventHandler]{
            param($sender, $eventArgs)
            $script:ShutdownRequested = $true
            $script:AgentExitReason = 'cancelled'
            $script:AgentExitSummary = 'encerramento solicitado'
            Write-LifecycleLog 'Encerramento solicitado por Console.CancelKeyPress/Ctrl+C.'
        }
        [Console]::add_CancelKeyPress($script:CancelHandler)
    } catch {
        Write-LifecycleLog "Nao foi possivel registrar Console.CancelKeyPress: $($_.Exception.Message)"
    }
    try {
        Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
            $script:ShutdownRequested = $true
            Write-LifecycleLog 'Evento PowerShell.Exiting recebido.'
        } | Out-Null
    } catch {
        Write-LifecycleLog "Nao foi possivel registrar PowerShell.Exiting: $($_.Exception.Message)"
    }
}

function Get-AgentMutex {
    param([string]$AgentId, [int]$TimeoutMilliseconds = 2000)
    $safeId = ([string]$AgentId -replace '[^a-zA-Z0-9_.-]', '_')
    foreach ($prefix in @('Global', 'Local')) {
        $name = "$prefix\TecLiveCookieSyncAgent-$safeId"
        try {
            $mutex = [System.Threading.Mutex]::new($false, $name)
            try {
                $acquired = $mutex.WaitOne($TimeoutMilliseconds)
            } catch [System.Threading.AbandonedMutexException] {
                Write-LifecycleLog "Mutex abandonado recuperado: $name"
                $acquired = $true
            }
            return [pscustomobject]@{ Mutex = $mutex; Name = $name; Acquired = [bool]$acquired }
        } catch {
            if ($prefix -eq 'Local') { throw }
            Write-LifecycleLog "Mutex Global indisponivel, tentando Local: $($_.Exception.Message)"
        }
    }
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

    Write-AgentLog -Path $LogPath -Message "Retry de pendingReport para job $jobId ($type)."
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
        [string]$StatePath,
        [string]$RuntimeStatePath
    )
    $heartbeatStatus = if ($DryRun) { 'dry-run' } else { 'idle' }
    [void](Send-Heartbeat -Config $Config -Status $heartbeatStatus)
    Update-RuntimeState @{ lastHeartbeatAt = (Get-Date).ToString('o') }
    Write-AgentLog -Path $LogPath -Message "Heartbeat enviado ($heartbeatStatus)."
    if (-not (Send-PendingReport -Config $Config -StatePath $StatePath -LogPath $LogPath)) {
        return $false
    }

    Update-RuntimeState @{ lastQueueCheckAt = (Get-Date).ToString('o') }
    Write-AgentLog -Path $LogPath -Message 'Consulta de fila iniciada.'
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
    Update-RuntimeState @{ lastJobAt = (Get-Date).ToString('o') }
    Write-AgentLog -Path $LogPath -Message "Job encontrado: $($job.id) para $cookie."

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
    Write-AgentLog -Path $LogPath -Message "Job claimed: $($job.id)."

    $running = Invoke-AgentApi -Config $Config -Method POST -Path "/api/cookie-agent/jobs/$($job.id)/running"
    Assert-AgentApiSuccess -Response $running -Action 'marcar running'
    Write-AgentLog -Path $LogPath -Message "Job running: $($job.id)."
    [void](Send-Heartbeat -Config $Config -Status "running:$cookie")
    Update-RuntimeState @{ lastHeartbeatAt = (Get-Date).ToString('o') }
    Write-AgentLog -Path $LogPath -Message "Heartbeat enviado (running:$cookie)."
    Write-AgentLog -Path $LogPath -Message "Cookie Sync iniciado para $cookie (job $($job.id))."
    Write-AgentLog -Path $LogPath -Message "Executando Cookie Sync para $cookie (job $($job.id))."

    $result = Invoke-CookieSync -ProjectPath $ProjectPath -ScriptPath $CookieSyncScript -Cookie $cookie -TimeoutSeconds ([int]$Config.server.timeoutSeconds)
    Write-AgentLog -Path $LogPath -Message "Cookie Sync concluido para $cookie com exitCode=$($result.ExitCode) durationMs=$($result.DurationMs)."
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
        Write-AgentLog -Path $LogPath -Message "Complete reportado para job $($job.id)."
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
    Write-AgentLog -Path $LogPath -Message "Fail reportado para job $($job.id)."
    Write-AgentLog -Path $LogPath -Message "Job $($job.id) falhou para ${cookie}: $($result.Summary)"
    return $false
}

$mutexHandle = $null
$config = $null
try {
    $config = Get-Config -Path $ConfigPath
    Assert-BaseUrl -BaseUrl ([string]$config.server.baseUrl)
    Protect-ConfigAcl -Path $ConfigPath

    $projectPath = Resolve-AgentPath -ProjectPath (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) -Value ([string]$config.paths.projectPath)
    $cookieSyncScript = Resolve-AgentPath -ProjectPath $projectPath -Value ([string]$config.paths.cookieSyncScript)
    $logPath = Resolve-AgentPath -ProjectPath $projectPath -Value ([string]$config.paths.logPath)
    $statePath = Resolve-AgentPath -ProjectPath $projectPath -Value ([string]$config.paths.statePath)
    $script:LifecycleLogPath = $logPath
    Initialize-Log -Path $logPath
    Register-AgentLifecycleHandlers
    Assert-Prerequisites -Config $config -CookieSyncScript $cookieSyncScript

    $poll = if ($PollSeconds -gt 0) { $PollSeconds } else { [int]$config.server.pollSeconds }
    if ($poll -le 0) { $poll = 30 }
    $mode = if ($Once) { 'Once' } else { 'loop' }
    if ($DryRun) { $mode = "$mode/DryRun" }

    $mutexHandle = Get-AgentMutex -AgentId ([string]$config.agent.id)
    if (-not $mutexHandle.Acquired) {
        $runtime = Read-CookieAgentJsonFile -Path $script:RuntimeStatePath
        $runtimePid = if ($runtime.ContainsKey('pid')) { $runtime.pid } else { $null }
        if (Test-CookieAgentPidActive -Pid $runtimePid -ConfigPath $ConfigPath) {
            Write-AgentLog -Path $logPath -Message "instancia ja em execucao; pid=$runtimePid."
            $script:AgentExitCode = 0
            $script:AgentExitReason = 'normal'
            $script:AgentExitSummary = 'instancia ja em execucao'
            return
        }
        Write-AgentLog -Path $logPath -Message 'State/lock orfao detectado, mas mutex ainda ocupado; saindo sem aguardar indefinidamente.'
        $script:AgentExitCode = 0
        $script:AgentExitReason = 'normal'
        $script:AgentExitSummary = 'mutex ocupado sem instancia valida'
        return
    }

    $script:HasRuntimeOwnership = $true
    $previousRuntime = Read-CookieAgentJsonFile -Path $script:RuntimeStatePath
    if ($previousRuntime.ContainsKey('invalidJson') -and $previousRuntime.invalidJson) {
        Write-AgentLog -Path $logPath -Message 'Runtime state invalido recuperado automaticamente.'
    } elseif ($previousRuntime.ContainsKey('pid') -and $previousRuntime.pid -and -not (Test-CookieAgentPidActive -Pid $previousRuntime.pid -ConfigPath $ConfigPath)) {
        Write-AgentLog -Path $logPath -Message "Lock/state orfao recuperado; pid anterior morto ou nao era agente: $($previousRuntime.pid)."
    }

    Update-RuntimeState @{
        pid = $PID
        startedAt = $script:AgentStartedAt.ToString('o')
        lastHeartbeatAt = $null
        lastQueueCheckAt = $null
        lastJobAt = $null
        lastExitAt = $null
        lastExitCode = $null
        lastExitReason = 'unknown'
        version = [string]$config.agent.version
    }

    Write-AgentLog -Path $logPath -Message ("Inicializacao do agente: timestamp={0}; version={1}; pid={2}; user={3}; hostname={4}; configPath={5}; mode={6}; pollSeconds={7}" -f (Get-Date -Format o), [string]$config.agent.version, $PID, [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, $env:COMPUTERNAME, $ConfigPath, $mode, $poll)

    $backoff = 30
    do {
        try {
            $ok = Invoke-OneCycle -Config $config -ProjectPath $projectPath -CookieSyncScript $cookieSyncScript -LogPath $logPath -StatePath $statePath -RuntimeStatePath $script:RuntimeStatePath
            $backoff = if ($ok) { 30 } else { [Math]::Min([Math]::Max($backoff * 2, 60), 600) }
        } catch {
            Write-AgentLog -Path $logPath -Message "Erro do agente: $($_.Exception.Message)"
            $backoff = [Math]::Min([Math]::Max($backoff * 2, 60), 600)
            if ($Once) {
                $script:AgentExitCode = 1
                $script:AgentExitReason = 'error'
                $script:AgentExitSummary = $_.Exception.Message
            }
        }
        if ($Once -or $script:ShutdownRequested) { break }
        Start-Sleep -Seconds ([Math]::Max($poll, $backoff))
    } while ($true)

    if ($script:AgentExitReason -eq 'unknown') {
        $script:AgentExitReason = if ($script:ShutdownRequested) { 'cancelled' } else { 'normal' }
        $script:AgentExitSummary = if ($script:ShutdownRequested) { 'encerramento solicitado' } else { 'encerramento normal' }
    }
} catch {
    $script:AgentExitCode = 1
    $script:AgentExitReason = if ($script:ShutdownRequested) { 'cancelled' } else { 'error' }
    $script:AgentExitSummary = $_.Exception.Message
    Write-LifecycleLog "Encerramento por excecao: $($_.Exception.Message)"
} finally {
    $elapsedMs = [int]((Get-Date) - $script:AgentStartedAt).TotalMilliseconds
    if ($script:HasRuntimeOwnership) {
        Update-RuntimeState @{
            lastExitAt = (Get-Date).ToString('o')
            lastExitCode = $script:AgentExitCode
            lastExitReason = $script:AgentExitReason
            version = if ($config) { [string]$config.agent.version } else { 'unknown' }
        }
    }
    Write-LifecycleLog ("Encerramento do agente: reason={0}; exitCode={1}; pid={2}; elapsedMs={3}; summary={4}" -f $script:AgentExitReason, $script:AgentExitCode, $PID, $elapsedMs, $script:AgentExitSummary)
    if ($mutexHandle -and $mutexHandle.Acquired -and $mutexHandle.Mutex) {
        try { $mutexHandle.Mutex.ReleaseMutex() } catch {}
        try { $mutexHandle.Mutex.Dispose() } catch {}
    }
}

exit $script:AgentExitCode
