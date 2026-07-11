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
            $action = 'recreate-task'
        }

        if ($action -eq 'recreate-task') {
            if ($Health.processFound -and $Health.heartbeatAgeSeconds -ne $null -and $Health.heartbeatAgeSeconds -le ($StaleMinutes * 60)) {
                Write-WatchdogLog 'Recriacao bloqueada porque existe processo real saudavel.'
                return 0
            }
            if ($PSCmdlet.ShouldProcess($TaskName, 'recriar tarefa do agente')) {
                Write-WatchdogLog "Acao: recriar tarefa usando install-agent-task.ps1."
                $psExe = (Get-Process -Id $PID).Path
                $installArgs = Get-WatchdogInstallArgs -Task $task
                & $psExe @installArgs *> $null
                if ($LASTEXITCODE -ne 0) { throw "install-agent-task.ps1 retornou $LASTEXITCODE" }
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

    if ($health.processFound -and $health.heartbeatAgeSeconds -ne $null -and $health.heartbeatAgeSeconds -le ($StaleMinutes * 60) -and -not $ForceRecreate) {
        Write-WatchdogLog "Inconsistencia detectada ($($health.reason)), mas processo e heartbeat estao saudaveis; nao recriar."
        exit 0
    }

    exit (Invoke-WatchdogRecovery -Health $health)
} catch {
    Write-WatchdogLog "Watchdog falhou: $($_.Exception.Message)"
    exit 40
}
