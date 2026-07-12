[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'TecLive Cookie Sync Agent',
    [string]$ConfigPath,
    [int]$StaleMinutes = 5,
    [int]$QueuedMinutes = 2,
    [switch]$DryRun,
    [switch]$VerboseOutput,
    [switch]$ForceRecreate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cookie-agent-common.ps1')

try { Import-Module ScheduledTasks -ErrorAction Stop } catch {}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'cookie-agent.config.json'
}

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$logPath = if ($env:COOKIE_AGENT_WATCHDOG_LOG_PATH) {
    $env:COOKIE_AGENT_WATCHDOG_LOG_PATH
} else {
    Join-Path $projectRoot 'logs\cookie-agent\watchdog.log'
}
$agentLogPath = Join-Path $projectRoot 'logs\cookie-agent\agent.log'
$watchdogStatePath = if ($env:COOKIE_AGENT_WATCHDOG_STATE_PATH) {
    $env:COOKIE_AGENT_WATCHDOG_STATE_PATH
} else {
    Join-Path $PSScriptRoot 'watchdog-state.json'
}

function Write-WatchdogLog {
    param([string]$Message)
    Write-CookieAgentLog -Path $logPath -Message $Message -VerboseOutput:$VerboseOutput
}

function Save-WatchdogRecovery {
    param([string]$Reason, [string]$Action, [string]$Result)
    $state = Read-CookieAgentJsonFile -Path $watchdogStatePath
    if ($state.ContainsKey('invalidJson') -and $state.invalidJson) { $state = @{} }
    $history = if ($state.ContainsKey('history')) { @($state.history) } else { @() }
    $entry = @{
        at = (Get-Date).ToString('o')
        reason = $Reason
        action = $Action
        result = $Result
    }
    $history = @($entry) + $history
    $state.lastRecoveryAt = $entry.at
    $state.lastReason = $Reason
    $state.lastAction = $Action
    $state.lastResult = $Result
    $state.history = @($history | Select-Object -First 20)
    Save-CookieAgentJsonAtomic -Path $watchdogStatePath -Data $state
}

function Test-WatchdogCooldown {
    param([int]$CooldownMinutes = 10)
    if ($ForceRecreate) { return $false }
    $state = Read-CookieAgentJsonFile -Path $watchdogStatePath
    if (-not $state.ContainsKey('lastRecoveryAt') -or -not $state.lastRecoveryAt) { return $false }
    $age = Get-CookieAgentAgeSeconds -Value $state.lastRecoveryAt
    return ($null -ne $age -and $age -lt ($CooldownMinutes * 60))
}

function Get-WatchdogInstallArgs {
    param([AllowNull()][object]$Task)
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'install-agent-task.ps1'), '-TaskName', $TaskName, '-ConfigPath', $ConfigPath, '-Force')
    if ($Task -and $Task.Principal -and [string]$Task.Principal.RunLevel -eq 'Highest') {
        $args += '-RunAsAdmin'
    }
    if ($Task -and $Task.Settings -and $Task.Settings.WakeToRun) {
        $args += '-WakeToRun'
    }
    return $args
}

function Join-WatchdogProcessArguments {
    param([string[]]$Arguments)
    return (@($Arguments | ForEach-Object {
        $value = [string]$_
        if ($value -notmatch '[\s"]') {
            $value
        } else {
            '"' + ($value -replace '"', '\"') + '"'
        }
    }) -join ' ')
}

function New-HiddenPowerShellStartInfo {
    param(
        [string[]]$Arguments,
        [string]$PowerShellPath
    )

    if ([string]::IsNullOrWhiteSpace($PowerShellPath)) {
        $PowerShellPath = (Get-Process -Id $PID).Path
    }
    if ([string]::IsNullOrWhiteSpace($PowerShellPath)) {
        $PowerShellPath = Join-Path $PSHOME 'powershell.exe'
    }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $PowerShellPath
    $psi.Arguments = Join-WatchdogProcessArguments -Arguments $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    return $psi
}

function Wait-HiddenPowerShellProcess {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 120
    )

    $stdoutTask = $Process.StandardOutput.ReadToEndAsync()
    $stderrTask = $Process.StandardError.ReadToEndAsync()
    $timeoutMs = [Math]::Max(1, $TimeoutSeconds) * 1000

    if (-not $Process.WaitForExit($timeoutMs)) {
        try { $Process.Kill() } catch {}
        try { [void]$Process.WaitForExit(5000) } catch {}
        return [pscustomobject]@{
            ExitCode = $null
            StdOut = ''
            StdErr = ''
            TimedOut = $true
        }
    }

    $Process.WaitForExit()
    return [pscustomobject]@{
        ExitCode = $Process.ExitCode
        StdOut = $stdoutTask.Result
        StdErr = $stderrTask.Result
        TimedOut = $false
    }
}

function Assert-HiddenPowerShellResult {
    param(
        [pscustomobject]$Result,
        [string]$Operation = 'install-agent-task.ps1'
    )

    if ($Result.TimedOut) {
        throw "$Operation excedeu timeout ao executar em janela oculta"
    }
    if ($Result.ExitCode -ne 0) {
        throw "$Operation retornou $($Result.ExitCode): $(Redact-CookieAgentText ($Result.StdErr + ' ' + $Result.StdOut))"
    }
}

function Invoke-HiddenPowerShell {
    param(
        [string[]]$Arguments,
        [int]$TimeoutSeconds = 120
    )

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = New-HiddenPowerShellStartInfo -Arguments $Arguments
    try {
        [void]$process.Start()
        return Wait-HiddenPowerShellProcess -Process $process -TimeoutSeconds $TimeoutSeconds
    } finally {
        $process.Dispose()
    }
}

function Invoke-WatchdogRecovery {
    param([pscustomobject]$Health)

    $action = if ($ForceRecreate -or $Health.recommendedAction -eq 'recreate-task') { 'recreate-task' } else { $Health.recommendedAction }
    if ($action -in @('none', 'observe')) {
        Write-WatchdogLog "Nenhuma recuperacao aplicada; action=$action reason=$($Health.reason)."
        return 0
    }

    if ($DryRun -or $WhatIfPreference) {
        Write-WatchdogLog "DryRun/WhatIf: recuperacao necessaria; action=$action reason=$($Health.reason)."
        return 20
    }

    if (Test-WatchdogCooldown) {
        Write-WatchdogLog "Cooldown ativo; recuperacao adiada para evitar loop. reason=$($Health.reason) action=$action."
        return 30
    }

    $task = $null
    try { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}

    try {
        if (-not $ForceRecreate -and $Health.activityRecent) {
            Write-WatchdogLog "Recuperacao bloqueada porque ha atividade recente; reason=$($Health.reason) action=$action."
            return 0
        }

        if ($action -in @('stop-start', 'start-task', 'cleanup-state')) {
            if ($task -and $action -eq 'stop-start' -and $PSCmdlet.ShouldProcess($TaskName, 'parar tarefa para recuperacao')) {
                Write-WatchdogLog "Acao: Stop-ScheduledTask $TaskName."
                Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
            if ($task -and $PSCmdlet.ShouldProcess($TaskName, 'iniciar tarefa para recuperacao')) {
                Write-WatchdogLog "Acao: Start-ScheduledTask $TaskName."
                Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
                Start-Sleep -Seconds 5
            }
            $afterStart = Get-CookieAgentTaskHealth -TaskName $TaskName -ConfigPath $ConfigPath -RuntimeStatePath (Get-CookieAgentRuntimeStatePath -ScriptRoot $PSScriptRoot) -LogPath $agentLogPath -StaleMinutes $StaleMinutes -QueuedMinutes $QueuedMinutes
            if ($afterStart.healthy) {
                Save-WatchdogRecovery -Reason $Health.reason -Action $action -Result 'success'
                Write-WatchdogLog "Recuperacao por $action concluida com sucesso."
                return 10
            }
            Write-WatchdogLog "Stop/Start nao recuperou; health=$($afterStart.reason)."
            Save-WatchdogRecovery -Reason $Health.reason -Action $action -Result "failed:$($afterStart.reason)"
            return 30
        }

        if ($action -eq 'recreate-task') {
            if (-not $ForceRecreate -and ($Health.processFound -or $Health.activityRecent)) {
                Write-WatchdogLog 'Recriacao bloqueada porque existe processo real ou atividade recente.'
                return 0
            }
            if ($PSCmdlet.ShouldProcess($TaskName, 'recriar tarefa do agente')) {
                Write-WatchdogLog "Acao: recriar tarefa usando install-agent-task.ps1."
                $installArgs = Get-WatchdogInstallArgs -Task $task
                $installResult = Invoke-HiddenPowerShell -Arguments $installArgs
                Assert-HiddenPowerShellResult -Result $installResult
            }
            if ($PSCmdlet.ShouldProcess($TaskName, 'iniciar tarefa recriada')) {
                Write-WatchdogLog "Acao: Start-ScheduledTask apos recriacao."
                Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
                Start-Sleep -Seconds 5
            }
            $afterRecreate = Get-CookieAgentTaskHealth -TaskName $TaskName -ConfigPath $ConfigPath -RuntimeStatePath (Get-CookieAgentRuntimeStatePath -ScriptRoot $PSScriptRoot) -LogPath $agentLogPath -StaleMinutes $StaleMinutes -QueuedMinutes $QueuedMinutes
            if ($afterRecreate.healthy) {
                Save-WatchdogRecovery -Reason $Health.reason -Action $action -Result 'success'
                Write-WatchdogLog 'Recriacao concluida com sucesso.'
                return 10
            }
            Save-WatchdogRecovery -Reason $Health.reason -Action $action -Result "failed:$($afterRecreate.reason)"
            Write-WatchdogLog "Recriacao falhou; health=$($afterRecreate.reason)."
            return 30
        }

        Write-WatchdogLog "Acao de recuperacao desconhecida: $action."
        return 30
    } catch {
        Save-WatchdogRecovery -Reason $Health.reason -Action $action -Result "error:$($_.Exception.Message)"
        Write-WatchdogLog "Recuperacao falhou: $($_.Exception.Message)"
        return 30
    }
}

try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        Write-WatchdogLog "Config ausente: $ConfigPath"
        exit 40
    }

    $health = Get-CookieAgentTaskHealth -TaskName $TaskName -ConfigPath $ConfigPath -RuntimeStatePath (Get-CookieAgentRuntimeStatePath -ScriptRoot $PSScriptRoot) -LogPath $agentLogPath -StaleMinutes $StaleMinutes -QueuedMinutes $QueuedMinutes
    Write-WatchdogLog ("Estado observado: task={0}; processFound={1}; pid={2}; heartbeatAge={3}; queueAge={4}; lastResult={5}; reason={6}; action={7}" -f $health.taskState, $health.processFound, $health.processId, $health.heartbeatAgeSeconds, $health.queueCheckAgeSeconds, $health.lastTaskResultHex, $health.reason, $health.recommendedAction)

    if ($health.healthy) {
        Write-WatchdogLog 'Agente saudavel; nenhuma acao.'
        exit 0
    }

    if ($health.classification -eq 'degraded' -and -not $ForceRecreate) {
        Write-WatchdogLog "Estado degradado observado ($($health.reason)); atividade recente impede recuperacao nesta execucao."
        exit 0
    }

    exit (Invoke-WatchdogRecovery -Health $health)
} catch {
    Write-WatchdogLog "Watchdog falhou: $($_.Exception.Message)"
    exit 40
}
