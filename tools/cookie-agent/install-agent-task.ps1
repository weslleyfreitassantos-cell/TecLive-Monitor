[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'TecLive Cookie Sync Agent',
    [string]$ConfigPath,
    [switch]$Force,
    [switch]$RunAsAdmin,
    [switch]$WakeToRun,
    [switch]$StartAfterInstall,
    [switch]$ValidateAfterStart,
    [int]$ValidationTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
. (Join-Path $PSScriptRoot 'cookie-agent-common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'cookie-agent.config.json'
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Config ausente: $ConfigPath"
}

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$agentLauncher = Join-Path $PSScriptRoot 'run-cookie-agent-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) {
    $wscriptCommand = Get-Command wscript.exe -ErrorAction SilentlyContinue
    if ($wscriptCommand) { $wscript = $wscriptCommand.Source }
}
if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) {
    throw 'wscript.exe nao encontrado. O launcher sem console exige Windows Script Host.'
}
if (-not (Test-Path -LiteralPath $agentLauncher -PathType Leaf)) {
    throw "Launcher VBS ausente: $agentLauncher"
}
$hiddenLauncher = if ($WhatIfPreference) {
    Get-CookieAgentHiddenLauncherPath
} else {
    Install-CookieAgentHiddenLauncher -ScriptRoot $PSScriptRoot
}

if ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -and -not $Force) {
    throw "Tarefa ja existe. Use -Force para substituir: $TaskName"
}
if ($Force) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'remover tarefa existente')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

function Get-ScheduledTaskRunLevel {
    param([bool]$Elevated)

    $validNames = [System.Enum]::GetNames([Microsoft.PowerShell.Cmdletization.GeneratedTypes.ScheduledTask.RunLevelEnum])
    $desired = if ($Elevated) { 'Highest' } else { 'Limited' }
    if ($validNames -notcontains $desired) {
        throw "RunLevel '$desired' nao e suportado neste ambiente. Valores aceitos: $($validNames -join ', ')"
    }
    if ($validNames -contains 'LeastPrivilege') {
        Write-Verbose "RunLevel LeastPrivilege existe neste ambiente, mas nao sera usado; usando $desired."
    }
    return $desired
}

function Join-TaskActionArguments {
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

$arguments = Join-TaskActionArguments @('//B', '//NoLogo', $agentLauncher, $hiddenLauncher, $ConfigPath, $projectRoot)

$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden `
    -WakeToRun:$WakeToRun.IsPresent
$runLevel = Get-ScheduledTaskRunLevel -Elevated:$RunAsAdmin.IsPresent
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel $runLevel
if ($PSCmdlet.ShouldProcess($TaskName, "criar tarefa agendada com RunLevel $runLevel")) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
    Write-Host "Tarefa criada: $TaskName"
} else {
    Write-Host "Tarefa validada: $TaskName"
}

if ($StartAfterInstall) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'iniciar tarefa apos instalacao')) {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Write-Host "Tarefa iniciada: $TaskName"
    } else {
        Write-Host "StartAfterInstall validado: $TaskName"
    }
}

if ($ValidateAfterStart) {
    if ($WhatIfPreference) {
        Write-Host 'ValidateAfterStart pulado por WhatIf.'
    } else {
        $deadline = (Get-Date).AddSeconds([Math]::Max(1, $ValidationTimeoutSeconds))
        $health = $null
        do {
            Start-Sleep -Seconds 2
            $health = Get-CookieAgentTaskHealth `
                -TaskName $TaskName `
                -ConfigPath $ConfigPath `
                -RuntimeStatePath (Get-CookieAgentRuntimeStatePath -ScriptRoot $PSScriptRoot) `
                -LogPath (Join-Path $projectRoot 'logs\cookie-agent\agent.log') `
                -StaleMinutes 2 `
                -QueuedMinutes 1
            if ($health.healthy) { break }
        } while ((Get-Date) -lt $deadline)

        if (-not $health -or -not $health.healthy) {
            $reason = if ($health) { $health.reason } else { 'health_unavailable' }
            $taskState = if ($health) { $health.taskState } else { 'unknown' }
            $processFound = if ($health) { $health.processFound } else { $false }
            $heartbeatAge = if ($health) { $health.heartbeatAgeSeconds } else { $null }
            throw "Validacao da tarefa falhou: reason=$reason taskState=$taskState processFound=$processFound heartbeatAgeSeconds=$heartbeatAge"
        }
        Write-Host "Validacao OK: tarefa Running, processo encontrado e heartbeat recente."
    }
}

Write-Host "Execute: $wscript"
Write-Host "Launcher: $(Split-Path $agentLauncher -Leaf)"
Write-Host "HiddenProcessLauncher: $(Split-Path $hiddenLauncher -Leaf)"
Write-Host "RunLevel: $runLevel"
Write-Host "MultipleInstances: $($settings.MultipleInstances)"
Write-Host "RestartCount: $($settings.RestartCount)"
Write-Host "RestartInterval: $($settings.RestartInterval)"
Write-Host "ExecutionTimeLimit: $($settings.ExecutionTimeLimit)"
Write-Host "AllowDemandStart: $($settings.AllowDemandStart)"
Write-Host "DisallowStartIfOnBatteries: $($settings.DisallowStartIfOnBatteries)"
Write-Host "StopIfGoingOnBatteries: $($settings.StopIfGoingOnBatteries)"
Write-Host "StartWhenAvailable: $($settings.StartWhenAvailable)"
Write-Host "RunOnlyIfNetworkAvailable: $($settings.RunOnlyIfNetworkAvailable)"
Write-Host "Hidden: $($settings.Hidden)"
Write-Host "WakeToRun: $($settings.WakeToRun)"
Write-Host "A tarefa nao foi iniciada automaticamente por este instalador."
